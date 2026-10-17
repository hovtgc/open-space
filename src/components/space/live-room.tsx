import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff, SlidersHorizontal, X } from "lucide-react";
import { UserButton } from "@/lib/auth/gates";
import { joinSpace, leaveSpace, moderateMember, requestSpeak, setRoomMuted, syncSpace } from "@/lib/space/room";
import { MAX_LISTENERS, MAX_SPEAKERS, SPACE_STATUS, SPACE_TITLE } from "@/lib/space/constants";
import type { LinkState, RoomHealth, VoiceMember } from "@/lib/space/voice-room";
import { VoiceRoom, primeAudio } from "@/lib/space/voice-room";
import type { AnonymousListener, Member, SpaceOk, SpaceResult } from "@/lib/space/types";
import { AnonymousSeat, Face, LevelBars, LiveMark, OpeningLine, RoomFrame, SeatCount, SourceLink } from "./chrome";
import { ChatComposer, ChatProvider, ChatTranscript } from "./room-chat";

type Phase = "joining" | "in" | "full" | "kicked" | "left" | "error";

function unauthorized(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { message?: string; status?: number };
  return record.message === "Unauthorized" || record.status === 401;
}

function roleLabel(member: Member): string | null {
  if (member.isHost) return "Host";
  if (member.speaker) return "Speaker";
  if (member.speakRequested) return "Requested";
  return null;
}

function roomKey(result: SpaceOk): string {
  const members = result.members
    .map((member) =>
      [
        member.userId,
        member.peerId,
        member.displayName,
        member.handle,
        member.image ?? "",
        member.isHost ? 1 : 0,
        member.speaker ? 1 : 0,
        member.micOn ? 1 : 0,
        member.forcedMute ? 1 : 0,
        member.speakRequested ? 1 : 0,
        member.admittedUntil ?? "",
      ].join("~"),
    )
    .join("|");
  const ears = result.anonymous.map((ear) => ear.peerId).join(",");
  return `${result.roomMuted ? 1 : 0}:${result.spotsUsed}:${result.listenerCount}:${members}:${ears}`;
}

const IDLE_HEALTH: RoomHealth = { mic: "off", stalled: [], weak: [], failed: [] };

function portraitHealth(
  peerId: string,
  selfId: string | null,
  health: RoomHealth,
): "ok" | "weak" | "silent" | "failed" {
  if (peerId === selfId && (health.mic === "silent" || health.mic === "ended")) return "silent";
  if (health.failed.includes(peerId)) return "failed";
  if (health.stalled.includes(peerId)) return "silent";
  if (health.weak.includes(peerId)) return "weak";
  return "ok";
}

function hoursLeft(until: string): string {
  const hours = Math.ceil((new Date(until).getTime() - Date.now()) / 3_600_000);
  if (!Number.isFinite(hours) || hours <= 1) return "under 1h left";
  return `${Math.min(24, hours)}h left`;
}

function Portrait({
  member,
  speaking,
  level,
  health,
  large,
}: {
  member: Member;
  speaking: boolean;
  level: number;
  health: "ok" | "weak" | "silent" | "failed";
  large: boolean;
}) {
  const showMute = member.forcedMute;
  const lvl = speaking ? Math.max(level, 0.28) : level;
  const healthLabel =
    health === "silent" ? "No audio" : health === "weak" ? "Weak connection" : health === "failed" ? "Reconnecting" : "";
  return (
    <div
      className={`level-ring relative rounded-full ${speaking ? "speak-ring" : ""}`}
      style={{ ["--lvl" as string]: lvl.toFixed(2) }}
      title={healthLabel || undefined}
    >
      <Face name={member.displayName} handle={member.handle} image={member.image} large={large} />
      {showMute ? (
        <span className="absolute -right-0.5 -bottom-0.5 grid size-6 place-items-center rounded-full bg-bg text-fg ring-1 ring-line">
          <MicOff className="size-3.5" aria-hidden />
        </span>
      ) : health !== "ok" ? (
        <span
          className={`absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-bg ${health === "weak" ? "bg-speak" : "bg-live"}`}
          aria-hidden
        />
      ) : null}
    </div>
  );
}

function Seat({
  member,
  speaking,
  level,
  health,
  large,
  row = false,
  onManage,
}: {
  member: Member;
  speaking: boolean;
  level: number;
  health: "ok" | "weak" | "silent" | "failed";
  large: boolean;
  row?: boolean;
  onManage: ((member: Member) => void) | null;
}) {
  const role = roleLabel(member);
  const body = row ? (
    <>
      <Portrait member={member} speaking={speaking} level={level} health={health} large />
      <span className="min-w-0 text-left">
        <span className="block truncate text-base font-medium">{member.displayName}</span>
        <span className="block truncate text-sm text-muted">@{member.handle}</span>
        {role ? <span className="block text-xs text-muted">{role}</span> : null}
      </span>
    </>
  ) : (
    <>
      <Portrait member={member} speaking={speaking} level={level} health={health} large={large} />
      <span className={`mt-2 block w-full px-1 text-center font-medium leading-snug ${large ? "text-base" : "line-clamp-2 text-xs"}`}>
        {member.displayName}
      </span>
      <span className={`block w-full text-center text-muted ${large ? "text-sm" : "truncate text-xs"}`}>@{member.handle}</span>
      {role ? <span className="block text-xs text-muted">{role}</span> : null}
    </>
  );
  const className = row
    ? "flex w-full min-w-0 items-center gap-3 text-left"
    : "flex w-full min-w-0 flex-col items-center text-center";
  if (!onManage) return <div className={className}>{body}</div>;
  return (
    <button type="button" className={`press ${className}`} onClick={() => onManage(member)} aria-label={`Manage @${member.handle}`}>
      {body}
    </button>
  );
}

export function LiveRoom() {
  const [phase, setPhase] = useState<Phase>("joining");
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [self, setSelf] = useState<Member | null>(null);
  const [peerId, setPeerId] = useState<string | null>(null);
  const [joinId, setJoinId] = useState(0);
  const [micOn, setMicOn] = useState(false);
  const [micBusy, setMicBusy] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState<Record<string, boolean>>({});
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [health, setHealth] = useState<RoomHealth>(IDLE_HEALTH);
  const [links, setLinks] = useState<LinkState[]>([]);
  const [needGesture, setNeedGesture] = useState(true);
  const [channelOpen, setChannelOpen] = useState(false);
  const [managing, setManaging] = useState<Member | null>(null);
  const [roomMuted, setRoomMutedFlag] = useState(false);
  const [spotsUsed, setSpotsUsed] = useState(0);
  const [listenerCount, setListenerCount] = useState(0);
  const [anonymous, setAnonymous] = useState<AnonymousListener[]>([]);
  const [spotsFull, setSpotsFull] = useState(false);
  const [volume, setVolume] = useState(80);
  const [volumeReady, setVolumeReady] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [talkMode, setTalkMode] = useState<"tap" | "ptt">("tap");
  const [holding, setHolding] = useState(false);

  const roomRef = useRef<VoiceRoom | null>(null);
  const snapRef = useRef("");
  const streamRef = useRef<MediaStream | null>(null);
  const micRef = useRef(false);
  const wantMicRef = useRef(false);
  const aligningRef = useRef(false);
  const forcedRef = useRef(false);
  const canSpeakRef = useRef(false);
  const deviceIdRef = useRef("");
  const micBusyRef = useRef(false);
  const volumeRef = useRef(volume);
  const holdingRef = useRef(false);
  volumeRef.current = volume;
  deviceIdRef.current = deviceId;

  const onSpeaking = useCallback((id: string, on: boolean) => {
    setSpeaking((prev) => (prev[id] === on ? prev : { ...prev, [id]: on }));
  }, []);
  const onLevel = useCallback((id: string, level: number) => {
    setLevels((prev) => (prev[id] === level ? prev : { ...prev, [id]: level }));
  }, []);
  const onHealth = useCallback((next: RoomHealth) => {
    setHealth(next);
  }, []);
  const onLinks = useCallback((next: LinkState[]) => setLinks(next), []);
  const onAudio = useCallback((state: AudioContextState) => {
    setNeedGesture(state === "suspended");
  }, []);

  function apply(result: SpaceResult) {
    if (result.status !== "ok") {
      snapRef.current = "";
      if (result.status === "full") setPhase("full");
      else if (result.status === "kicked") setPhase("kicked");
      else if (result.status === "left") setPhase("left");
      else setMicError("Only the host can do that.");
      return;
    }
    const key = roomKey(result);
    if (key !== snapRef.current) {
      snapRef.current = key;
      setSelf(result.self);
      setMembers(result.members);
      setAnonymous(result.anonymous);
      setPeerId(result.self.peerId);
      setPhase("in");
      setRoomMutedFlag(result.roomMuted);
      setSpotsUsed(result.spotsUsed);
      setListenerCount(result.listenerCount);
    }
    const wasForced = forcedRef.current;
    forcedRef.current = result.self.forcedMute;
    const canSpeak =
      result.self.isHost ||
      (result.self.admittedUntil != null && new Date(result.self.admittedUntil).getTime() > Date.now());
    canSpeakRef.current = canSpeak;
    roomRef.current?.setRoomMuted(result.roomMuted);
    if (!canSpeak) {
      wantMicRef.current = false;
      if (micRef.current || streamRef.current) haltMic();
      setSpotsFull(false);
      return;
    }
    if (result.self.forcedMute) {
      if (micRef.current) {
        wantMicRef.current = true;
        silenceMic();
      }
      setSpotsFull(false);
      return;
    }
    if (wasForced && wantMicRef.current && resumeHeldMic()) {
      void syncSpace({ data: true })
        .then((next) => apply(next))
        .catch(() => {});
      return;
    }
    if (result.self.micOn) setSpotsFull(false);
    if (!aligningRef.current && result.self.micOn !== micRef.current && !micBusyRef.current) {
      aligningRef.current = true;
      void syncSpace({ data: micRef.current })
        .then((next) => apply(next))
        .catch(() => {})
        .finally(() => {
          aligningRef.current = false;
        });
    }
  }

  function silenceMic() {
    const track = streamRef.current?.getAudioTracks()[0];
    if (track) track.enabled = false;
    micRef.current = false;
    setMicOn(false);
    roomRef.current?.setLocalTrack(null);
  }

  function resumeHeldMic(): boolean {
    const track = streamRef.current?.getAudioTracks()[0];
    if (!track || track.readyState !== "live") return false;
    track.enabled = true;
    micRef.current = true;
    setMicOn(true);
    roomRef.current?.setLocalTrack(track);
    return true;
  }

  function haltMic() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    micRef.current = false;
    setMicOn(false);
    roomRef.current?.setLocalTrack(null);
  }

  useEffect(() => {
    let cancelled = false;
    snapRef.current = "";
    setPhase("joining");
    void (async () => {
      await fetch("/api/listen", { method: "DELETE" }).catch(() => {});
      if (cancelled) return;
      try {
        const result = await joinSpace();
        if (!cancelled) apply(result);
      } catch (cause: unknown) {
        if (cancelled) return;
        setPhase("error");
        setError(unauthorized(cause) ? "Sign in with X to join." : "The room didn't open. Try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // joinId re-runs a deliberate rejoin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinId]);

  useEffect(() => {
    if (phase !== "joining") return;
    const id = window.setTimeout(() => {
      setPhase((current) => (current === "joining" ? "error" : current));
      setError((current) => current ?? "The room is taking too long. Try again.");
    }, 12000);
    return () => window.clearTimeout(id);
  }, [phase, joinId]);

  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem("open-room-volume"));
      if (Number.isFinite(stored) && stored >= 0 && stored <= 100) setVolume(stored);
      const talk = localStorage.getItem("open-room-talk");
      if (talk === "ptt" || talk === "tap") setTalkMode(talk);
    } catch {
      /* storage unavailable */
    }
    setVolumeReady(true);
  }, []);

  useEffect(() => {
    roomRef.current?.setVolume(volume / 100);
    if (!volumeReady) return;
    try {
      localStorage.setItem("open-room-volume", String(volume));
    } catch {
      /* ignore */
    }
  }, [volume, volumeReady]);

  useEffect(() => {
    if (phase !== "in" || !peerId) return;
    const room = new VoiceRoom(peerId, onSpeaking, onLinks, onAudio, true, { onLevel, onHealth });
    room.setVolume(volumeRef.current / 100);
    room.setMembers(toVoice(members));
    room.setRoomMuted(false);
    roomRef.current = room;
    void room.join();
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      room.close({ notify: false });
      if (roomRef.current === room) roomRef.current = null;
    };
    // members is pushed in the effect below; the room is created once per seat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, peerId, onSpeaking, onLinks, onAudio, onLevel, onHealth]);

  useEffect(() => {
    roomRef.current?.setMembers(toVoice(members));
    roomRef.current?.setRoomMuted(roomMuted);
  }, [members, roomMuted]);

  useEffect(() => {
    if (phase !== "in") return;
    const id = window.setInterval(() => {
      void syncSpace({ data: micRef.current })
        .then((result) => apply(result))
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function enableMic(nextDeviceId: string) {
    if (!canSpeakRef.current || forcedRef.current || micBusyRef.current) return;
    setMicError(null);
    micBusyRef.current = true;
    setMicBusy(true);
    void roomRef.current?.unlock();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          deviceId: nextDeviceId ? { exact: nextDeviceId } : undefined,
        },
        video: false,
      });
      streamRef.current = stream;
      micRef.current = true;
      wantMicRef.current = true;
      setMicOn(true);
      const track = stream.getAudioTracks()[0];
      roomRef.current?.setLocalTrack(track ?? null);
      const listed = await navigator.mediaDevices.enumerateDevices();
      setInputs(listed.filter((device) => device.kind === "audioinput"));
      const active = track?.getSettings().deviceId;
      if (active) setDeviceId(active);
      apply(await syncSpace({ data: true }));
    } catch (cause: unknown) {
      wantMicRef.current = false;
      haltMic();
      const blocked = cause instanceof DOMException && cause.name === "NotAllowedError";
      setMicError(blocked ? "Microphone blocked in the browser." : "Couldn't open the microphone.");
    } finally {
      micBusyRef.current = false;
      setMicBusy(false);
    }
  }

  async function toggleMic() {
    if (!canSpeakRef.current || forcedRef.current || micBusyRef.current) return;
    void roomRef.current?.unlock();
    if (micRef.current) {
      wantMicRef.current = false;
      silenceMic();
      try {
        apply(await syncSpace({ data: false }));
      } catch {
        /* next heartbeat retries */
      }
      return;
    }
    wantMicRef.current = true;
    if (resumeHeldMic()) {
      try {
        apply(await syncSpace({ data: true }));
      } catch {
        /* next heartbeat retries */
      }
      return;
    }
    await enableMic(deviceId);
  }

  async function beginTalk() {
    if (!canSpeakRef.current || forcedRef.current) return;
    holdingRef.current = true;
    setHolding(true);
    void roomRef.current?.unlock();
    if (micRef.current) return;
    wantMicRef.current = true;
    if (resumeHeldMic()) {
      try {
        apply(await syncSpace({ data: true }));
      } catch {
        /* next heartbeat retries */
      }
      return;
    }
    await enableMic(deviceIdRef.current);
    if (!holdingRef.current && micRef.current) {
      wantMicRef.current = false;
      silenceMic();
      try {
        apply(await syncSpace({ data: false }));
      } catch {
        /* next heartbeat retries */
      }
    }
  }

  function endTalk() {
    holdingRef.current = false;
    setHolding(false);
    if (!micRef.current) return;
    wantMicRef.current = false;
    silenceMic();
    void syncSpace({ data: false })
      .then((result) => apply(result))
      .catch(() => {});
  }

  function chooseTalk(next: "tap" | "ptt") {
    if (holdingRef.current) endTalk();
    else if (next === "ptt" && micRef.current) {
      wantMicRef.current = false;
      silenceMic();
      void syncSpace({ data: false })
        .then((result) => apply(result))
        .catch(() => {});
    }
    setTalkMode(next);
    try {
      localStorage.setItem("open-room-talk", next);
    } catch {
      /* ignore */
    }
  }

  function releaseRoom() {
    const ctx = primeAudio();
    void roomRef.current?.unlock();
    if (ctx) {
      const sync = () => setNeedGesture(ctx.state === "suspended");
      void ctx.resume().then(sync).catch(sync);
    }
    if (self?.isHost && roomMuted) void toggleRoom();
  }

  async function leave() {
    roomRef.current?.close({ notify: true });
    haltMic();
    try {
      await leaveSpace();
    } catch {
      /* signaling leave already dropped the seat */
    }
    setPhase("left");
    setChannelOpen(false);
    setManaging(null);
  }

  async function askToSpeak() {
    try {
      const result = await requestSpeak();
      if (result.status === "ok") apply(result);
    } catch {
      setMicError("That didn't go through.");
    }
  }

  async function moderate(userId: string, action: "mute" | "unmute" | "remove" | "admit" | "drop") {
    try {
      const result = await moderateMember({ data: { userId, action } });
      if (result.status === "ok") {
        apply(result);
        if (action === "admit") {
          const person = result.members.find((member) => member.userId === userId);
          if (person && !person.admittedUntil) setMicError("All 8 speaker spots are filled.");
        }
      } else setMicError("Only the host can do that.");
    } catch {
      setMicError("That didn't go through.");
    }
  }

  async function act(action: "mute" | "unmute" | "remove" | "admit" | "drop") {
    if (!managing) return;
    const userId = managing.userId;
    setManaging(null);
    await moderate(userId, action);
  }

  async function toggleRoom() {
    try {
      const result = await setRoomMuted({ data: !roomMuted });
      if (result.status === "ok") apply(result);
      else setMicError("Only the host can do that.");
    } catch {
      setMicError("That didn't go through.");
    }
  }

  const onManage = useCallback((member: Member) => {
    setChannelOpen(false);
    setManaging(member);
  }, []);
  const stage = members.filter((member) => member.isHost || member.speaker);
  const stageShown = stage.length > 0 ? stage : members.length === 1 ? members : [];
  const requests = members.filter((member) => member.speakRequested);
  const manage = self?.isHost
    ? (member: Member) => {
        if (member.userId === self.userId) return;
        onManage(member);
      }
    : null;
  const canSpeakNow = Boolean(
    self?.isHost || (self?.admittedUntil && new Date(self.admittedUntil).getTime() > Date.now()),
  );

  const pendingLinks = links.filter(
    (link) => link.connectionState !== "connected" && link.connectionState !== "failed",
  ).length;
  const failedLinks = links.filter((link) => link.connectionState === "failed").length;
  const stalledMember = members.find((member) => health.stalled.includes(member.peerId));
  const healthLine =
    health.mic === "ended"
      ? "Microphone stopped. Tap the mic."
      : health.mic === "silent"
        ? "Your mic isn't reaching the room"
        : health.failed.length > 0
          ? "Reconnecting audio…"
          : stalledMember
            ? `No audio from ${stalledMember.displayName.split(/\s+/)[0]}`
            : health.weak.length > 0
              ? "Weak connection"
              : null;
  let status = "";
  if (needGesture) status = "Unmute to hear the room";
  else if (micError) status = micError;
  else if (roomMuted) status = "Room muted";
  else if (self?.forcedMute) status = "Muted by host";
  else if (!canSpeakNow) status = self?.speakRequested ? "Request sent" : "Request a mic";
  else if (healthLine) status = healthLine;
  else if (self?.admittedUntil && !self.isHost) {
    status = micOn
      ? pendingLinks > 0
        ? "Connecting audio…"
        : `Admitted · ${hoursLeft(self.admittedUntil)}`
      : talkMode === "ptt"
        ? "Hold to talk"
        : "Tap the mic";
  } else if (spotsFull) status = "All 8 spots are taken";
  else if (micOn && pendingLinks > 0) status = "Connecting audio…";
  else if (micOn && talkMode === "ptt") status = "Release to stop";
  else if (!micOn) status = talkMode === "ptt" ? "Hold to talk" : "Tap the mic";
  const showUnmute = needGesture || Boolean(self?.isHost && roomMuted);
  const localLevel = peerId ? (levels[peerId] ?? 0) : 0;
  const roomLevel = members.reduce((max, member) => {
    if (member.peerId === peerId) return max;
    return Math.max(max, levels[member.peerId] ?? 0);
  }, 0);
  const meterLevel = micOn ? localLevel : roomLevel;
  const micLine =
    health.mic === "live"
      ? "Your mic is sending."
      : health.mic === "quiet"
        ? "Your mic is on and quiet."
        : health.mic === "silent"
          ? "Your mic isn't reaching the room."
          : health.mic === "ended"
            ? "Microphone stopped."
            : "";

  return (
    <RoomFrame>
      <header className="safe-top flex items-center justify-between px-5">
        <LiveMark />
        <SeatCount count={phase === "in" ? members.length + anonymous.length : null} />
      </header>

      {phase === "joining" ? (
        <div className="px-5 pt-8">
          <h1 className="text-2xl font-semibold tracking-tight">{SPACE_TITLE}</h1>
          <OpeningLine label="Taking a seat…" />
        </div>
      ) : null}

      {phase === "full" ? (
        <Notice
          title="This room is full"
          body="50 people are already listening. Someone has to leave before another seat opens."
          action="Try again"
          onAction={() => setJoinId((n) => n + 1)}
        />
      ) : null}

      {phase === "kicked" ? (
        <Notice
          title="The host removed you"
          body="You can rejoin in a couple of minutes. The room stays open."
          action="Rejoin"
          onAction={() => setJoinId((n) => n + 1)}
        />
      ) : null}

      {phase === "left" ? (
        <Notice
          title="You left"
          body="The room is still open."
          action="Rejoin"
          onAction={() => setJoinId((n) => n + 1)}
        />
      ) : null}

      {phase === "error" ? (
        <Notice
          title="Couldn't join"
          body={error ?? "Try again."}
          action="Try again"
          onAction={() => setJoinId((n) => n + 1)}
        />
      ) : null}

      {phase === "in" ? (
        <ChatProvider signedIn active host={Boolean(self?.isHost)}>
          <div className="relative z-0 min-h-0 flex-1 overflow-y-auto">
            <div className="px-5 pt-3">
            <h1 className="text-2xl font-semibold tracking-tight">{SPACE_TITLE}</h1>
            <p className="mt-1 text-sm text-muted">
              {SPACE_STATUS}
              {roomMuted ? " · Room muted" : ` · ${spotsUsed}/${MAX_SPEAKERS} speakers`}
            </p>
            <p className="mt-1">
              <SourceLink />
            </p>
            {self && !self.isHost && !self.admittedUntil ? (
              <p className="mt-1 text-sm text-muted">The host admits speakers for 24 hours.</p>
            ) : null}

            {stageShown.length > 0 ? (
              <ul
                className={
                  stageShown.length === 1
                    ? "mt-4 grid w-full grid-cols-1"
                    : stageShown.length === 2
                      ? "mx-auto grid w-full max-w-xs grid-cols-2 gap-x-6"
                      : "grid grid-cols-3 gap-x-3 gap-y-6"
                }
              >
                {stageShown.map((member) => (
                  <li key={member.userId} className="min-w-0 w-full">
                    <Seat
                      member={member}
                      large={stageShown.length < 4}
                      row={stageShown.length === 1}
                      speaking={Boolean(speaking[member.peerId]) && member.micOn && !member.forcedMute && !roomMuted}
                      level={levels[member.peerId] ?? 0}
                      health={portraitHealth(member.peerId, peerId, health)}
                      onManage={manage}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No one is speaking.</p>
            )}

            {self?.isHost && requests.length > 0 ? (
              <section className="mt-6">
                <h2 className="text-sm font-medium text-muted">Requests · {requests.length}</h2>
                {spotsUsed >= MAX_SPEAKERS ? (
                  <p className="mt-2 text-sm text-muted">All 8 speaker spots are filled.</p>
                ) : null}
                <ul className="mt-3 flex flex-col gap-2">
                  {requests.map((member) => (
                    <li key={member.userId} className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-sm">
                        {member.displayName}
                        <span className="text-muted"> @{member.handle}</span>
                      </span>
                      <button
                        type="button"
                        className="press h-11 shrink-0 rounded-full bg-fg px-4 text-sm font-semibold text-bg disabled:opacity-50"
                        disabled={spotsUsed >= MAX_SPEAKERS}
                        onClick={() => void moderate(member.userId, "admit")}
                      >
                        Admit
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

              <ListeningSection
                members={members}
                anonymous={anonymous}
                listenerCount={listenerCount}
                host={Boolean(self?.isHost)}
                selfId={self?.userId ?? null}
                onManage={onManage}
              />
            </div>
            <ChatTranscript />
          </div>

          {channelOpen ? (
            <div className="sheet mx-5 mb-3 max-h-72 overflow-y-auto rounded-3xl border border-line bg-elevated p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">Channel</h2>
                <button
                  type="button"
                  className="press grid size-11 place-items-center rounded-full"
                  aria-label="Close channel"
                  onClick={() => setChannelOpen(false)}
                >
                  <X className="size-5" />
                </button>
              </div>
              <label className="mt-3 block text-sm text-muted" htmlFor="room-volume">
                Room volume
              </label>
              <input
                id="room-volume"
                className="channel-slider"
                type="range"
                min={0}
                max={100}
                value={volume}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
              <label className="mt-3 block text-sm text-muted" htmlFor="mic-input">
                Microphone
              </label>
              <select
                id="mic-input"
                className="mt-1 h-11 w-full rounded-xl border border-line bg-bg px-3 text-sm"
                value={deviceId}
                disabled={inputs.length === 0}
                onChange={(event) => {
                  const next = event.target.value;
                  setDeviceId(next);
                  if (!micRef.current) return;
                  haltMic();
                  void enableMic(next);
                }}
              >
                {inputs.length === 0 ? <option value="">Connect the mic to choose an input</option> : null}
                {inputs.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || "Microphone"}
                  </option>
                ))}
              </select>
              <p className="mt-3 text-sm text-muted">
                {micLine ? `${micLine} ` : ""}
                {links.length === 0
                  ? "Audio connects when someone is speaking."
                  : `Hearing ${links.filter((link) => link.connectionState === "connected").length} of ${links.length}.`}
                {health.stalled.length > 0 ? ` No audio from ${health.stalled.length}.` : ""}
                {health.weak.length > 0 ? ` Weak from ${health.weak.length}.` : ""}
                {failedLinks > 0 ? ` Can't reach ${failedLinks}.` : ""}
              </p>
              <p className="mt-2 text-xs text-muted">
                Audio goes directly between people here. A strict network can block a seat.
              </p>
              <div className="mt-4 border-t border-line pt-4">
                <UserButton />
              </div>
            </div>
          ) : null}

          {managing ? (
            <div className="sheet mx-5 mb-3 max-h-72 overflow-y-auto rounded-3xl border border-line bg-elevated p-4" role="dialog" aria-label={`Manage @${managing.handle}`}>
              <p className="font-semibold">{managing.displayName}</p>
              <p className="text-sm text-muted">
                @{managing.handle}
                {managing.speakRequested ? " · requested a mic" : ""}
                {managing.admittedUntil ? ` · ${hoursLeft(managing.admittedUntil)}` : ""}
              </p>
              <div className="mt-4 flex flex-col gap-2">
                {!managing.admittedUntil ? (
                  <button
                    type="button"
                    className="press h-11 rounded-full bg-fg text-sm font-semibold text-bg disabled:opacity-50"
                    disabled={spotsUsed >= MAX_SPEAKERS}
                    onClick={() => void act("admit")}
                  >
                    Admit for 24 hours
                  </button>
                ) : (
                  <button
                    type="button"
                    className="press h-11 rounded-full border border-line text-sm font-medium"
                    onClick={() => void act("drop")}
                  >
                    Drop to listener
                  </button>
                )}
                <button
                  type="button"
                  className="press h-11 rounded-full border border-line text-sm font-medium"
                  onClick={() => void act(managing.forcedMute ? "unmute" : "mute")}
                >
                  {managing.forcedMute ? "Unmute" : "Mute"}
                </button>
                <button
                  type="button"
                  className="press h-11 rounded-full text-sm font-medium text-live"
                  onClick={() => void act("remove")}
                >
                  Remove from room
                </button>
                <button
                  type="button"
                  className="press h-11 rounded-full text-sm text-muted"
                  onClick={() => setManaging(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          <div className="relative z-10 shrink-0 border-t border-line bg-bg safe-bottom mb-16">
            <ChatComposer />
            <div className="talk-guard flex flex-col items-center gap-4 px-5 pt-4 pb-2">
              <div className="flex items-center justify-center gap-3">
                {showUnmute ? (
                  <button type="button" className="truncate text-sm text-muted" onClick={() => releaseRoom()}>
                    {status}
                  </button>
                ) : (
                  <p
                    className={`truncate text-center text-sm text-muted ${status.startsWith("Connecting") || status.startsWith("Reconnecting") ? "seat-wait-text" : ""}`}
                    aria-live="polite"
                  >
                    {status}
                  </p>
                )}
                {self?.isHost && !roomMuted ? (
                  <button
                    type="button"
                    className="press h-8 shrink-0 rounded-full border border-line px-3 text-xs font-medium"
                    onClick={() => void toggleRoom()}
                  >
                    Mute room
                  </button>
                ) : null}
              </div>
              {micOn || meterLevel > 0 ? <LevelBars level={meterLevel} /> : null}
              <div className="flex items-center justify-center gap-8">
                <button
                  type="button"
                  className="press grid size-12 place-items-center rounded-full bg-elevated"
                  aria-label="Leave room"
                  onClick={() => void leave()}
                >
                  <PhoneOff className="size-5 text-live" />
                </button>
                {(() => {
                  const hot = micOn;
                  const ptt = talkMode === "ptt" && canSpeakNow && !showUnmute;
                  return (
                    <button
                      type="button"
                      className={`talk-btn grid touch-none place-items-center ${hot ? "is-hot" : ""} ${ptt ? "is-ptt" : ""} ${ptt && (holding || micOn) ? "is-down" : ""}`}
                      style={micOn ? { ["--lvl" as string]: localLevel.toFixed(2) } : undefined}
                      aria-label={
                        showUnmute ? "Unmute room" : micOn ? "Turn microphone off" : canSpeakNow ? "Turn microphone on" : "Request to speak"
                      }
                      aria-pressed={micOn}
                      onContextMenu={(event) => event.preventDefault()}
                      disabled={(!showUnmute && Boolean(self?.forcedMute)) || micBusy || (!showUnmute && !canSpeakNow && Boolean(self?.speakRequested))}
                      onPointerDown={(event) => {
                        if (showUnmute || talkMode !== "ptt" || !canSpeakNow) return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        void beginTalk();
                      }}
                      onPointerUp={() => {
                        if (talkMode === "ptt") endTalk();
                      }}
                      onPointerCancel={() => {
                        if (talkMode === "ptt") endTalk();
                      }}
                      onClick={() => {
                        if (showUnmute) {
                          releaseRoom();
                          return;
                        }
                        if (!canSpeakNow) {
                          void askToSpeak();
                          return;
                        }
                        if (talkMode === "tap") void toggleMic();
                      }}
                    >
                      {canSpeakNow && micOn ? <Mic className="pointer-events-none size-8" /> : <MicOff className="pointer-events-none size-8" />}
                    </button>
                  );
                })()}
                <button
                  type="button"
                  className="press grid size-12 place-items-center rounded-full bg-elevated"
                  aria-label="Channel controls"
                  aria-pressed={channelOpen}
                  onClick={() => {
                    void roomRef.current?.unlock();
                    setManaging(null);
                    setChannelOpen((open) => !open);
                  }}
                >
                  <SlidersHorizontal className="size-5" />
                </button>
              </div>
              {canSpeakNow && !needGesture ? (
                <div className="grid w-full max-w-xs grid-cols-2 gap-2">
                  <button
                    type="button"
                    className={`press h-11 rounded-full text-sm font-semibold ${talkMode === "tap" ? "bg-fg text-bg" : "border border-line text-muted"}`}
                    aria-pressed={talkMode === "tap"}
                    onClick={() => chooseTalk("tap")}
                  >
                    Tap
                  </button>
                  <button
                    type="button"
                    className={`press h-11 rounded-full text-sm font-semibold ${talkMode === "ptt" ? "bg-fg text-bg" : "border border-line text-muted"}`}
                    aria-pressed={talkMode === "ptt"}
                    onClick={() => chooseTalk("ptt")}
                  >
                    Push to talk
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </ChatProvider>
      ) : null}
    </RoomFrame>
  );
}

function toVoice(members: Member[]): VoiceMember[] {
  return members.map((member) => ({
    peerId: member.peerId,
    isHost: member.isHost,
    speaker: member.speaker,
    micOn: member.micOn,
    forcedMute: member.forcedMute,
  }));
}

const ListeningSection = memo(function ListeningSection({
  members,
  anonymous,
  listenerCount,
  host,
  selfId,
  onManage,
}: {
  members: Member[];
  anonymous: AnonymousListener[];
  listenerCount: number;
  host: boolean;
  selfId: string | null;
  onManage: (member: Member) => void;
}) {
  const listeners = members.filter((member) => !member.isHost && !member.speaker);
  const stageCount = members.length - listeners.length;
  const shown = stageCount > 0 ? listeners : members.length === 1 ? [] : listeners;
  if (shown.length === 0 && anonymous.length === 0) return null;
  const manage = host
    ? (member: Member) => {
        if (member.userId === selfId) return;
        onManage(member);
      }
    : null;
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium text-muted">
        Listening · {shown.length + anonymous.length}
        {listenerCount > 0 ? ` of ${MAX_LISTENERS}` : ""}
      </h2>
      <ul className="mt-4 grid grid-cols-4 gap-x-2 gap-y-5">
        {shown.map((member) => (
          <li key={member.userId} className="min-w-0">
            <Seat member={member} large={false} speaking={false} level={0} health="ok" onManage={manage} />
          </li>
        ))}
        {anonymous.map((ear) => (
          <li key={ear.peerId} className="min-w-0">
            <AnonymousSeat />
          </li>
        ))}
      </ul>
    </section>
  );
});

function Notice({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col px-5 pt-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted">{body}</p>
      <button
        type="button"
        className="press mt-8 h-12 rounded-full bg-fg font-semibold text-bg"
        onClick={onAction}
      >
        {action}
      </button>
    </div>
  );
}
