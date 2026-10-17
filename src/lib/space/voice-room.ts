import { defaultIceServers, type SignalKind } from "@/lib/multiplayer";
import { getBearerToken } from "@/lib/auth/client";
import { ROOM_ID } from "./constants";

export type VoiceMember = {
  peerId: string;
  isHost: boolean;
  speaker: boolean;
  micOn: boolean;
  forcedMute: boolean;
};

export type LinkState = {
  peerId: string;
  connectionState: RTCPeerConnectionState;
};

export type MicHealth = "off" | "live" | "quiet" | "silent" | "ended";

export type RoomHealth = {
  mic: MicHealth;
  stalled: string[];
  weak: string[];
  failed: string[];
};

export type VoiceHooks = {
  onLevel?: (peerId: string, level: number) => void;
  onHealth?: (health: RoomHealth) => void;
};

type RemoteAudio = {
  el: HTMLAudioElement;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
};

type PeerSlot = {
  pc: RTCPeerConnection;
  transceiver?: RTCRtpTransceiver;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  initiator: boolean;
  connectionState: RTCPeerConnectionState;
  trackMuted: boolean;
  trackEnded: boolean;
  since: number;
};

type PollBody = {
  peers: { id: string; name: string }[];
  signals: { id: number; from: string; kind: SignalKind; payload: unknown }[];
};

const FAST_POLL_MS = 700;
const IDLE_POLL_MS = 2000;
const METER_MS = 140;
const ICE_RESTART_MS = 8000;
const HEALTH_MS = 2000;
const STALL_TICKS = 3;
const SPEAK_ON = 0.16;

let sharedCtx: AudioContext | null = null;

function audioCtor(): typeof AudioContext | null {
  if (typeof AudioContext !== "undefined") return AudioContext;
  const webkit = (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return webkit ?? null;
}

/** Create or resume the room context inside a tap, before autoplay can block it. */
export function primeAudio(): AudioContext | null {
  const Ctor = audioCtor();
  if (!Ctor) return null;
  if (!sharedCtx || sharedCtx.state === "closed") sharedCtx = new Ctor();
  if (sharedCtx.state === "suspended") void sharedCtx.resume();
  return sharedCtx;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = getBearerToken();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function decodePayload(payload: unknown): unknown {
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload) as unknown;
    } catch {
      return payload;
    }
  }
  return payload;
}

/**
 * Audio mesh for one room. Listener-to-listener links are skipped once the
 * room is larger than a small circle, so a full house of 25 doesn't mean
 * 25 uploads from every phone.
 */
export class VoiceRoom {
  private readonly peers = new Map<string, PeerSlot>();
  private readonly remotes = new Map<string, RemoteAudio>();
  private readonly signalQueues = new Map<string, Promise<void>>();
  private readonly sticky = new Map<string, number>();
  private members: VoiceMember[] = [];
  private localTrack: MediaStreamTrack | null = null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private localSource: MediaStreamAudioSourceNode | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private bins = new Uint8Array(0);
  private speaking = new Map<string, boolean>();
  private smooth = new Map<string, number>();
  private shownLevel = new Map<string, number>();
  private levelAt = new Map<string, number>();
  private quietUntil = new Map<string, number>();
  private prevIn = new Map<string, { bytes: number; packets: number; lost: number }>();
  private stallTicks = new Map<string, number>();
  private cursor = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private meterTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private healthRunning = false;
  private closed = false;
  private volume = 0.8;
  private roomMuted = false;
  private rosterIds = new Set<string>();
  private lastLinkFp = "";
  private lastHealthFp = "";
  private memberFp = "";
  private desiredFp = "";
  private readonly pushed = new Map<string, MediaStreamTrack | null>();
  private readonly iceRestartAt = new Map<string, number>();
  private prevOutBytes = -1;
  private loudAt = 0;

  constructor(
    private readonly selfId: string,
    private readonly onSpeaking: (peerId: string, speaking: boolean) => void,
    private readonly onLinks: (links: LinkState[]) => void,
    private readonly onAudio: (state: AudioContextState) => void,
    private readonly publish = true,
    private readonly hooks: VoiceHooks = {},
  ) {}

  async join(): Promise<void> {
    if (this.closed || typeof RTCPeerConnection === "undefined") return;
    this.ensureContext();
    try {
      await this.pollOnce();
    } catch {
      /* the loop retries */
    }
    if (this.closed) return;
    this.schedule(this.needsFastPoll() ? FAST_POLL_MS : IDLE_POLL_MS);
    this.armMeter();
    this.kickHealth();
  }

  close(opts?: { notify?: boolean }): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.meterTimer) clearTimeout(this.meterTimer);
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.meterTimer = null;
    this.healthTimer = null;
    this.setLocalTrack(null);
    for (const id of [...this.peers.keys()]) this.drop(id);
    if (this.ctx) {
      const closing = this.ctx;
      this.ctx = null;
      void closing.close();
      if (sharedCtx === closing) sharedCtx = null;
    }
    if (opts?.notify === false) return;
    void fetch("/api/rtc", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ op: "leave", room: ROOM_ID, peer: this.selfId }),
      keepalive: true,
    }).catch(() => {});
  }

  async unlock(): Promise<void> {
    this.ensureContext();
    if (this.ctx) {
      try {
        await this.ctx.resume();
      } catch {
        /* autoplay still blocked */
      }
      this.onAudio(this.ctx.state);
    }
    for (const node of this.remotes.values()) {
      if (!node.el.muted) void node.el.play().catch(() => {});
    }
  }

  setVolume(value: number): void {
    this.volume = Math.min(1, Math.max(0, value));
    if (this.master) this.master.gain.value = this.volume;
    for (const node of this.remotes.values()) {
      node.el.volume = this.volume;
      if (!node.el.muted) void node.el.play().catch(() => {});
    }
  }

  setMembers(members: VoiceMember[]): void {
    const fp = members
      .map(
        (member) =>
          `${member.peerId}:${member.isHost ? 1 : 0}:${member.speaker ? 1 : 0}:${member.micOn ? 1 : 0}:${member.forcedMute ? 1 : 0}`,
      )
      .sort()
      .join("|");
    if (fp === this.memberFp) return;
    this.memberFp = fp;
    this.members = members;
    this.reconcile();
    this.applyGains();
    this.pushLocalTrack();
    this.armMeter();
  }

  setRoomMuted(muted: boolean): void {
    if (this.roomMuted === muted) return;
    this.roomMuted = muted;
    this.applyGains();
    this.armMeter();
  }

  setLocalTrack(track: MediaStreamTrack | null): void {
    this.localTrack = track;
    this.localSource?.disconnect();
    this.localAnalyser = null;
    this.localSource = null;
    if (track && this.ctx) {
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 256;
      const source = this.ctx.createMediaStreamSource(new MediaStream([track]));
      source.connect(analyser);
      this.localSource = source;
      this.localAnalyser = analyser;
      track.onended = () => {
        if (this.localTrack === track) this.kickHealth();
      };
      track.onmute = () => {
        if (this.localTrack === track) this.kickHealth();
      };
      track.onunmute = () => {
        if (this.localTrack === track) this.kickHealth();
      };
    } else {
      this.loudAt = 0;
      this.smooth.delete(this.selfId);
      this.setSpeaking(this.selfId, false, true);
      this.publishLevel(this.selfId, 0);
    }
    this.pushLocalTrack();
    this.armMeter();
  }

  private sending(): boolean {
    if (!this.publish) return false;
    const mine = this.members.find((member) => member.peerId === this.selfId);
    return !!mine && (mine.isHost || mine.speaker);
  }

  private pushLocalTrack(): void {
    const sending = this.sending();
    const track = sending ? this.localTrack : null;
    for (const [id, slot] of this.peers) {
      const transceiver = slot.transceiver;
      if (!transceiver) continue;
      const direction = sending ? "sendrecv" : "recvonly";
      const directionChanged = transceiver.direction !== direction;
      if (directionChanged) transceiver.direction = direction;
      if (!directionChanged && this.pushed.get(id) === track) continue;
      this.pushed.set(id, track);
      void transceiver.sender.replaceTrack(track).then(() => {
        if (!this.closed && slot.pc.signalingState === "stable") void this.negotiate(id);
      });
    }
  }

  private ensureContext(): void {
    if (this.ctx) return;
    const ctx = primeAudio();
    if (!ctx) return;
    const master = ctx.createGain();
    master.gain.value = this.volume;
    master.connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;
    this.onAudio(ctx.state);
    ctx.onstatechange = () => {
      if (this.ctx === ctx) this.onAudio(ctx.state);
    };
  }

  private shouldMeter(): boolean {
    if (this.localAnalyser) return true;
    for (const id of this.remotes.keys()) {
      if (this.audible(id)) return true;
    }
    return false;
  }

  private armMeter(): void {
    if (this.closed || this.meterTimer || !this.shouldMeter()) return;
    const tick = () => {
      if (this.closed) return;
      this.measure();
      if (!this.shouldMeter()) {
        this.meterTimer = null;
        return;
      }
      this.meterTimer = setTimeout(tick, METER_MS);
    };
    this.meterTimer = setTimeout(tick, METER_MS);
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  private needsFastPoll(): boolean {
    for (const slot of this.peers.values()) {
      const state = slot.connectionState;
      if (state === "new" || state === "connecting") return true;
    }
    return false;
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    try {
      await this.pollOnce();
    } catch {
      /* transient */
    }
    this.schedule(this.needsFastPoll() ? FAST_POLL_MS : IDLE_POLL_MS);
  }

  private async pollOnce(): Promise<void> {
    const params = new URLSearchParams({
      room: ROOM_ID,
      peer: this.selfId,
      since: String(this.cursor),
    });
    const res = await fetch(`/api/rtc?${params}`, { headers: authHeaders() });
    if (this.closed) return;
    if (!res.ok) return;
    const body = (await res.json()) as PollBody;
    this.rosterIds = new Set((body.peers ?? []).map((peer) => peer.id));
    const roster = this.rosterIds;
    for (const sig of body.signals ?? []) {
      this.cursor = Math.max(this.cursor, sig.id);
      await this.onSignal(sig.from, sig.kind, decodePayload(sig.payload), roster);
      if (this.closed) return;
    }
    this.reconcile();
    this.healStuck();
  }

  private healStuck(): void {
    const now = Date.now();
    for (const [id, slot] of this.peers) {
      const state = slot.pc.connectionState;
      if (state === "connected" || state === "closed") continue;
      if (now - slot.since < 5000) continue;
      slot.since = now;
      try {
        slot.pc.restartIce();
      } catch {
        /* already closed */
      }
      void this.negotiate(id);
    }
  }

  private async negotiate(peerId: string): Promise<void> {
    const slot = this.peers.get(peerId);
    if (!slot || this.closed || slot.makingOffer || slot.pc.signalingState !== "stable") return;
    slot.makingOffer = true;
    try {
      const offer = await slot.pc.createOffer();
      if (this.closed || slot.pc.signalingState !== "stable") return;
      await slot.pc.setLocalDescription(offer);
      await this.sendSignal(peerId, "offer", slot.pc.localDescription?.toJSON());
    } catch {
      /* the watchdog offers again */
    } finally {
      const current = this.peers.get(peerId);
      if (current) current.makingOffer = false;
    }
  }

  private computeDesired(): Set<string> {
    const ids = new Set<string>();
    const mine = this.members.find((member) => member.peerId === this.selfId);
    const speakers = this.members.filter(
      (member) => member.peerId !== this.selfId && (member.isHost || member.speaker),
    );
    for (const member of speakers) ids.add(member.peerId);
    const iSpeak = !!mine && (mine.isHost || mine.speaker);
    if (iSpeak) {
      for (const member of this.members) {
        if (member.peerId !== this.selfId) ids.add(member.peerId);
      }
      for (const id of this.rosterIds) {
        if (!this.members.some((member) => member.peerId === id)) ids.add(id);
      }
    }
    return ids;
  }

  private desired(): Set<string> {
    const ids = this.computeDesired();
    const now = Date.now();
    for (const [id, exp] of this.sticky) {
      if (exp < now) this.sticky.delete(id);
      else ids.add(id);
    }
    ids.delete(this.selfId);
    return ids;
  }

  private reconcile(): void {
    if (this.closed) return;
    const want = this.desired();
    const fp = [...want].sort().join(",");
    if (fp === this.desiredFp) return;
    this.desiredFp = fp;
    for (const id of want) {
      if (!this.peers.has(id)) this.connectTo(id, this.selfId > id);
    }
    for (const id of [...this.peers.keys()]) {
      if (!want.has(id)) this.drop(id);
    }
    this.desiredFp = fp;
  }

  private drop(peerId: string): void {
    const slot = this.peers.get(peerId);
    slot?.pc.close();
    this.peers.delete(peerId);
    const remote = this.remotes.get(peerId);
    remote?.source?.disconnect();
    if (remote) {
      remote.el.pause();
      remote.el.srcObject = null;
    }
    this.remotes.delete(peerId);
    this.pushed.delete(peerId);
    this.iceRestartAt.delete(peerId);
    this.prevIn.delete(peerId);
    this.stallTicks.delete(peerId);
    this.smooth.delete(peerId);
    this.desiredFp = "";
    this.setSpeaking(peerId, false, true);
    this.publishLevel(peerId, 0);
    this.emitLinks();
  }

  private connectTo(peerId: string, initiator: boolean): void {
    if (this.closed) return;
    const pc = new RTCPeerConnection({ iceServers: defaultIceServers() });
    const slot: PeerSlot = {
      pc,
      makingOffer: false,
      ignoreOffer: false,
      pendingCandidates: [],
      initiator,
      connectionState: pc.connectionState,
      trackMuted: false,
      trackEnded: false,
      since: Date.now(),
    };
    this.peers.set(peerId, slot);

    pc.onicecandidate = (e) => {
      if (e.candidate) void this.sendSignal(peerId, "ice", e.candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      slot.connectionState = pc.connectionState;
      this.emitLinks();
      if (pc.connectionState === "failed") {
        const now = Date.now();
        const last = this.iceRestartAt.get(peerId) ?? 0;
        if (now - last >= ICE_RESTART_MS) {
          this.iceRestartAt.set(peerId, now);
          try {
            pc.restartIce();
          } catch {
            /* already closed */
          }
          this.schedule(FAST_POLL_MS);
        }
      } else if (pc.connectionState === "connecting" || pc.connectionState === "disconnected") {
        this.schedule(FAST_POLL_MS);
      }
    };
    pc.ontrack = (e) => {
      if (e.track.kind !== "audio") return;
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.attachRemote(peerId, stream);
    };
    pc.onnegotiationneeded = () => {
      void this.negotiate(peerId);
    };

    if (initiator) {
      const sending = this.sending();
      slot.transceiver = pc.addTransceiver("audio", {
        direction: sending ? "sendrecv" : "recvonly",
      });
      if (sending && this.localTrack) {
        this.pushed.set(peerId, this.localTrack);
        void slot.transceiver.sender.replaceTrack(this.localTrack);
      }
      queueMicrotask(() => {
        const current = this.peers.get(peerId);
        if (!current || current.makingOffer || current.pc.localDescription) return;
        void this.negotiate(peerId);
      });
    }
    this.emitLinks();
  }

  private async onSignal(
    from: string,
    kind: SignalKind,
    payload: unknown,
    roster: Set<string>,
  ): Promise<void> {
    if (this.closed || from === this.selfId) return;
    if (!roster.has(from) && !this.members.some((m) => m.peerId === from)) return;
    this.sticky.set(from, Date.now() + 10_000);
    let slot = this.peers.get(from);
    if (!slot) {
      this.connectTo(from, false);
      slot = this.peers.get(from);
      if (!slot) return;
    }
    const polite = this.selfId < from;
    try {
      if (kind === "offer" || kind === "answer") {
        const description = payload as RTCSessionDescriptionInit;
        const collision =
          kind === "offer" && (slot.makingOffer || slot.pc.signalingState !== "stable");
        slot.ignoreOffer = !polite && collision;
        if (slot.ignoreOffer) return;
        if (collision) {
          try {
            await slot.pc.setLocalDescription({ type: "rollback" });
          } catch {
            this.drop(from);
            this.connectTo(from, false);
            slot = this.peers.get(from);
            if (!slot) return;
          }
        }
        await slot.pc.setRemoteDescription(description);
        if (this.closed) return;
        await this.flushPending(slot);
        slot.transceiver =
          slot.pc.getTransceivers().find((t) => t.receiver.track.kind === "audio") ??
          slot.transceiver;
        if (slot.transceiver) {
          if (this.sending() && this.localTrack) {
            if (slot.transceiver.direction !== "sendrecv") slot.transceiver.direction = "sendrecv";
            await slot.transceiver.sender.replaceTrack(this.localTrack);
            this.pushed.set(from, this.localTrack);
          } else if (slot.transceiver.direction !== "recvonly") {
            slot.transceiver.direction = "recvonly";
            await slot.transceiver.sender.replaceTrack(null);
            this.pushed.set(from, null);
          }
        }
        if (kind === "offer") {
          await slot.pc.setLocalDescription();
          if (this.closed) return;
          await this.sendSignal(from, "answer", slot.pc.localDescription?.toJSON());
        }
      } else if (kind === "ice") {
        const candidate = payload as RTCIceCandidateInit;
        if (!slot.pc.remoteDescription) {
          slot.pendingCandidates.push(candidate);
          return;
        }
        try {
          await slot.pc.addIceCandidate(candidate);
        } catch {
          /* a late candidate after rollback is harmless */
        }
      }
    } catch {
      /* the next offer cycle converges */
    }
    this.reconcile();
  }

  private async flushPending(slot: PeerSlot): Promise<void> {
    while (slot.pendingCandidates.length > 0) {
      const candidate = slot.pendingCandidates.shift();
      if (!candidate) return;
      try {
        await slot.pc.addIceCandidate(candidate);
      } catch {
        if (!slot.ignoreOffer) return;
      }
    }
  }

  private sendSignal(to: string, kind: SignalKind, payload: unknown): Promise<void> {
    const prev = this.signalQueues.get(to) ?? Promise.resolve();
    const next = prev.then(() => this.postSignal(to, kind, payload));
    this.signalQueues.set(
      to,
      next.catch(() => {}),
    );
    return next;
  }

  private async postSignal(to: string, kind: SignalKind, payload: unknown): Promise<void> {
    if (payload == null || this.closed) return;
    const res = await fetch("/api/rtc", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ op: "signal", room: ROOM_ID, from: this.selfId, to, kind, payload }),
    });
    if (!res.ok) throw new Error(`signal ${res.status}`);
  }

  private attachRemote(peerId: string, stream: MediaStream): void {
    this.ensureContext();
    const prev = this.remotes.get(peerId);
    prev?.source?.disconnect();
    if (prev) {
      prev.el.pause();
      prev.el.srcObject = null;
    }
    const el = new Audio();
    el.autoplay = true;
    el.setAttribute("playsinline", "");
    el.srcObject = stream;
    el.volume = this.volume;
    const on = this.audible(peerId);
    el.muted = !on;
    void el.play().catch(() => {});
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    if (this.ctx) {
      analyser = this.ctx.createAnalyser();
      analyser.fftSize = 256;
      source = this.ctx.createMediaStreamSource(stream);
      source.connect(analyser);
    }
    this.remotes.set(peerId, { el, source, analyser });
    const track = stream.getAudioTracks()[0];
    const slot = this.peers.get(peerId);
    if (slot) {
      slot.trackMuted = Boolean(track?.muted);
      slot.trackEnded = track?.readyState === "ended";
    }
    if (track) {
      track.onmute = () => {
        const current = this.peers.get(peerId);
        if (!current) return;
        current.trackMuted = true;
        this.kickHealth();
      };
      track.onunmute = () => {
        const current = this.peers.get(peerId);
        if (!current) return;
        current.trackMuted = false;
        this.kickHealth();
      };
      track.onended = () => {
        const current = this.peers.get(peerId);
        if (!current) return;
        current.trackEnded = true;
        this.kickHealth();
      };
    }
    this.armMeter();
  }

  private audible(peerId: string): boolean {
    if (this.roomMuted) return false;
    const member = this.members.find((m) => m.peerId === peerId);
    return !!member && member.micOn && !member.forcedMute;
  }

  /** Mute cuts the speaker element. Unmute plays it on the same gesture path. */
  private applyGains(): void {
    for (const [id, node] of this.remotes) {
      const on = this.audible(id);
      node.el.muted = !on;
      node.el.volume = this.volume;
      if (on) void node.el.play().catch(() => {});
      if (!on) {
        this.smooth.delete(id);
        this.setSpeaking(id, false, true);
        this.publishLevel(id, 0);
      }
    }
  }

  private levelOf(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    const n = analyser.fftSize;
    if (this.bins.length !== n) this.bins = new Uint8Array(n);
    analyser.getByteTimeDomainData(this.bins);
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      const v = ((this.bins[i] ?? 128) - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / n);
    return Math.min(1, Math.max(0, (rms - 0.015) / 0.14));
  }

  private smoothLevel(id: string, raw: number): number {
    const prev = this.smooth.get(id) ?? 0;
    const next = raw > prev ? prev * 0.3 + raw * 0.7 : prev * 0.5 + raw * 0.5;
    this.smooth.set(id, next);
    return next;
  }

  private publishLevel(id: string, level: number): void {
    const bucket = Math.round(Math.min(1, Math.max(0, level)) * 8) / 8;
    if (this.shownLevel.get(id) === bucket) return;
    const now = Date.now();
    if (bucket > 0 && now - (this.levelAt.get(id) ?? 0) < 160) return;
    this.shownLevel.set(id, bucket);
    this.levelAt.set(id, now);
    this.hooks.onLevel?.(id, bucket);
  }

  private measure(): void {
    const tracking = Boolean(this.localAnalyser && this.localTrack?.enabled);
    const local = tracking ? this.smoothLevel(this.selfId, this.levelOf(this.localAnalyser)) : 0;
    if (!tracking) this.smooth.delete(this.selfId);
    if (local > 0.35) this.loudAt = Date.now();
    this.publishLevel(this.selfId, local);
    this.setSpeaking(this.selfId, local > SPEAK_ON);
    for (const [id, node] of this.remotes) {
      if (!this.audible(id)) {
        this.smooth.delete(id);
        this.publishLevel(id, 0);
        continue;
      }
      const level = this.smoothLevel(id, this.levelOf(node.analyser));
      this.publishLevel(id, level);
      this.setSpeaking(id, level > SPEAK_ON);
    }
  }

  private kickHealth(): void {
    if (this.closed) return;
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = setTimeout(() => void this.healthTick(), 200);
  }

  private async healthTick(): Promise<void> {
    if (this.closed) return;
    if (!this.healthRunning) {
      this.healthRunning = true;
      try {
        await this.checkHealth();
      } catch {
        /* stats throw once the connection is closed */
      } finally {
        this.healthRunning = false;
      }
    }
    if (this.closed) return;
    this.healthTimer = setTimeout(() => void this.healthTick(), HEALTH_MS);
  }

  private async readAudioStats(pc: RTCPeerConnection): Promise<{
    inBytes: number;
    packets: number;
    lost: number;
    outBytes: number;
    sawIn: boolean;
    sawOut: boolean;
  }> {
    const stats = await pc.getStats();
    let inBytes = 0;
    let packets = 0;
    let lost = 0;
    let outBytes = 0;
    let sawIn = false;
    let sawOut = false;
    stats.forEach((report) => {
      const row = report as {
        type?: string;
        kind?: string;
        bytesReceived?: number;
        bytesSent?: number;
        packetsReceived?: number;
        packetsLost?: number;
      };
      if (row.kind !== "audio") return;
      if (row.type === "inbound-rtp") {
        sawIn = true;
        inBytes += row.bytesReceived ?? 0;
        packets += row.packetsReceived ?? 0;
        lost += row.packetsLost ?? 0;
      } else if (row.type === "outbound-rtp") {
        sawOut = true;
        outBytes += row.bytesSent ?? 0;
      }
    });
    return { inBytes, packets, lost, outBytes, sawIn, sawOut };
  }

  private heal(peerId: string): void {
    const now = Date.now();
    if (now - (this.iceRestartAt.get(peerId) ?? 0) < ICE_RESTART_MS) return;
    const pc = this.peers.get(peerId)?.pc;
    if (!pc || pc.connectionState === "closed") return;
    this.iceRestartAt.set(peerId, now);
    try {
      pc.restartIce();
    } catch {
      /* already closed */
    }
    this.schedule(FAST_POLL_MS);
  }

  private async checkHealth(): Promise<void> {
    const stalled: string[] = [];
    const weak: string[] = [];
    const failed: string[] = [];
    const watch: string[] = [];
    let probe: string | null = null;

    for (const [id, slot] of this.peers) {
      if (slot.connectionState === "failed" && this.audible(id)) failed.push(id);
      if (this.audible(id) && slot.connectionState === "connected") watch.push(id);
      if (
        !probe &&
        this.sending() &&
        this.localTrack?.enabled &&
        slot.connectionState === "connected"
      ) {
        probe = id;
      }
    }
    if (probe && !watch.includes(probe)) watch.push(probe);

    let outbound = -1;
    await Promise.all(
      watch.map(async (id) => {
        const slot = this.peers.get(id);
        if (!slot) return;
        const sample = await this.readAudioStats(slot.pc);
        if (id === probe && sample.sawOut) outbound = sample.outBytes;
        const expect = this.audible(id) && !slot.trackMuted && !slot.trackEnded && sample.sawIn;
        if (!expect) {
          this.stallTicks.delete(id);
          if (sample.sawIn) {
            this.prevIn.set(id, { bytes: sample.inBytes, packets: sample.packets, lost: sample.lost });
          }
          return;
        }
        const prev = this.prevIn.get(id);
        this.prevIn.set(id, { bytes: sample.inBytes, packets: sample.packets, lost: sample.lost });
        if (!prev) return;
        const dBytes = sample.inBytes - prev.bytes;
        const dPackets = sample.packets - prev.packets;
        const dLost = sample.lost - prev.lost;
        if (dBytes <= 0 && dPackets <= 0) {
          const ticks = (this.stallTicks.get(id) ?? 0) + 1;
          this.stallTicks.set(id, ticks);
          if (ticks >= STALL_TICKS) {
            stalled.push(id);
            this.heal(id);
          }
        } else {
          this.stallTicks.set(id, 0);
          const total = dPackets + Math.max(0, dLost);
          if (total > 20 && dLost / total > 0.12) weak.push(id);
        }
      }),
    );

    const track = this.localTrack;
    let mic: MicHealth = "off";
    const sendingOut = this.sending() && Boolean(track?.enabled) && this.peers.size > 0;
    const uploadStuck =
      sendingOut &&
      this.loudAt > 0 &&
      Date.now() - this.loudAt < 4000 &&
      outbound >= 0 &&
      this.prevOutBytes >= 0 &&
      outbound === this.prevOutBytes;
    if (!track || !track.enabled) mic = "off";
    else if (track.readyState === "ended" || track.muted) mic = "ended";
    else if (uploadStuck) mic = "silent";
    else if (Date.now() - this.loudAt < 1500) mic = "live";
    else mic = "quiet";
    if (outbound >= 0) this.prevOutBytes = outbound;

    stalled.sort();
    weak.sort();
    failed.sort();
    const fp = `${mic}|s:${stalled.join()}|w:${weak.join()}|f:${failed.join()}`;
    if (fp === this.lastHealthFp) return;
    this.lastHealthFp = fp;
    this.hooks.onHealth?.({ mic, stalled, weak, failed });
  }

  private setSpeaking(peerId: string, speaking: boolean, force = false): void {
    if (!speaking && !force && this.speaking.get(peerId)) {
      const until = this.quietUntil.get(peerId) ?? Date.now() + 280;
      if (!this.quietUntil.has(peerId)) this.quietUntil.set(peerId, until);
      if (Date.now() < until) return;
    }
    this.quietUntil.delete(peerId);
    if (this.speaking.get(peerId) === speaking) return;
    this.speaking.set(peerId, speaking);
    this.onSpeaking(peerId, speaking);
  }

  private emitLinks(): void {
    const links = [...this.peers.entries()].map(([peerId, slot]) => ({
      peerId,
      connectionState: slot.connectionState,
    }));
    const fp = links.map((l) => `${l.peerId}:${l.connectionState}`).join("|");
    if (fp === this.lastLinkFp) return;
    this.lastLinkFp = fp;
    this.onLinks(links);
  }
}
