import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MicOff } from "lucide-react";
import { AnonymousSeat, JoinConversationButton, LevelBars, LiveMark, OpeningLine, RoomFrame, SourceLink, UnmuteRoomBar } from "@/components/space/chrome";
import { MAX_LISTENERS, MAX_SPEAKERS, SPACE_STATUS, SPACE_TITLE } from "@/lib/space/constants";
import { primeAudio } from "@/lib/space/voice-room";
import type { LinkState, RoomHealth, VoiceMember } from "@/lib/space/voice-room";
import { VoiceRoom } from "@/lib/space/voice-room";
import type { AnonymousListener, ListenSnapshot, Person } from "@/lib/space/types";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((part) => part[0] ?? "").join("");
  return letters.toUpperCase() || "?";
}

function listenKey(body: ListenSnapshot): string {
  const members = body.members
    .map((member) =>
      [
        member.peerId,
        member.displayName,
        member.handle,
        member.image ?? "",
        member.isHost ? 1 : 0,
        member.speaker ? 1 : 0,
        member.micOn ? 1 : 0,
        member.forcedMute ? 1 : 0,
      ].join("~"),
    )
    .join("|");
  const ears = body.anonymous.map((ear) => ear.peerId).join(",");
  return `${body.status}:${body.peerId ?? ""}:${body.roomMuted ? 1 : 0}:${body.spotsUsed}:${body.listenerCount}:${members}:${ears}`;
}

function toVoice(people: Person[]): VoiceMember[] {
  return people.map((person) => ({
    peerId: person.peerId,
    isHost: person.isHost,
    speaker: person.speaker,
    micOn: person.micOn,
    forcedMute: person.forcedMute,
  }));
}

const IDLE_HEALTH: RoomHealth = { mic: "off", stalled: [], weak: [], failed: [] };

export function ListenRoom({ sessionPending = false }: { sessionPending?: boolean }) {
  const [snapshot, setSnapshot] = useState<ListenSnapshot | null>(null);
  const [peerId, setPeerId] = useState<string | null>(null);
  const [needGesture, setNeedGesture] = useState(true);
  const [volume, setVolume] = useState(80);
  const [volumeReady, setVolumeReady] = useState(false);
  const [speaking, setSpeaking] = useState<Record<string, boolean>>({});
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [health, setHealth] = useState<RoomHealth>(IDLE_HEALTH);
  const [error, setError] = useState<string | null>(null);
  const roomRef = useRef<VoiceRoom | null>(null);
  const peerRef = useRef<string | null>(null);
  const snapRef = useRef("");
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  const onSpeaking = useCallback((id: string, on: boolean) => {
    setSpeaking((prev) => (prev[id] === on ? prev : { ...prev, [id]: on }));
  }, []);
  const onLevel = useCallback((id: string, level: number) => {
    setLevels((prev) => (prev[id] === level ? prev : { ...prev, [id]: level }));
  }, []);
  const onHealth = useCallback((next: RoomHealth) => setHealth(next), []);
  const onLinks = useCallback((_links: LinkState[]) => {}, []);
  const onAudio = useCallback((state: AudioContextState) => {
    setNeedGesture(state === "suspended");
  }, []);

  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem("open-room-volume"));
      if (Number.isFinite(stored) && stored >= 0 && stored <= 100) setVolume(stored);
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
    let cancelled = false;
    let timer = 0;
    let opened = false;
    async function pull(claim: boolean) {
      const res = await fetch("/api/listen", {
        method: claim ? "POST" : "GET",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error("listen failed");
      const body = (await res.json()) as ListenSnapshot;
      if (cancelled) return;
      opened = true;
      setError((current) => (current ? null : current));
      const key = listenKey(body);
      if (key !== snapRef.current) {
        snapRef.current = key;
        setSnapshot(body);
      }
      if (body.peerId) {
        if (peerRef.current !== body.peerId) {
          peerRef.current = body.peerId;
          setPeerId(body.peerId);
        }
      } else if (body.status === "full") {
        peerRef.current = null;
        setPeerId(null);
      }
    }
    async function tick() {
      if (cancelled) return;
      try {
        await pull(!peerRef.current);
      } catch {
        if (!cancelled && !opened) setError("The room didn't open. Try again.");
      }
      if (cancelled) return;
      timer = window.setTimeout(() => void tick(), peerRef.current ? 2000 : 1000);
    }
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!peerId) return;
    const room = new VoiceRoom(peerId, onSpeaking, onLinks, onAudio, false, { onLevel, onHealth });
    room.setVolume(volumeRef.current / 100);
    room.setRoomMuted(Boolean(snapshot?.roomMuted));
    room.setMembers(toVoice(snapshot?.members ?? []));
    roomRef.current = room;
    void room.join();
    return () => {
      room.close({ notify: false });
      if (roomRef.current === room) roomRef.current = null;
    };
    // The seat is claimed once; roster updates go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerId, onSpeaking, onLinks, onAudio, onLevel, onHealth]);

  useEffect(() => {
    if (!snapshot) return;
    roomRef.current?.setRoomMuted(snapshot.roomMuted);
    roomRef.current?.setMembers(toVoice(snapshot.members));
  }, [snapshot]);

  const members = snapshot?.members ?? [];
  const anonymous = useMemo(() => {
    const ears = snapshot?.anonymous ?? [];
    return [...ears].sort((a, b) => {
      if (a.peerId === peerId) return -1;
      if (b.peerId === peerId) return 1;
      return 0;
    });
  }, [snapshot, peerId]);
  const stage = useMemo(() => members.filter((member) => member.isHost || member.speaker), [members]);
  const namedListeners = useMemo(
    () => members.filter((member) => !member.isHost && !member.speaker),
    [members],
  );
  const spotsOpen = Math.max(0, MAX_LISTENERS - (snapshot?.listenerCount ?? 0));
  const roomMuted = Boolean(snapshot?.roomMuted);
  const listeningCount = namedListeners.length + anonymous.length;
  const stalledMember = members.find((member) => health.stalled.includes(member.peerId));
  const healthNote =
    health.failed.length > 0
      ? "Reconnecting audio…"
      : stalledMember
        ? `No audio from ${stalledMember.displayName.split(/\s+/)[0]}`
        : health.weak.length > 0
          ? "Weak connection"
          : null;
  const roomLevel = members.reduce((max, member) => Math.max(max, levels[member.peerId] ?? 0), 0);

  function hear() {
    const ctx = primeAudio();
    void roomRef.current?.unlock();
    if (!ctx) return;
    const sync = () => setNeedGesture(ctx.state === "suspended");
    void ctx.resume().then(sync).catch(sync);
  }

  return (
    <RoomFrame>
      <div
        className="flex min-h-0 flex-1 flex-col"
        onPointerDown={() => hear()}
      >
        <header className="safe-top flex items-center justify-between px-5">
          <LiveMark />
          <SourceLink />
          <span className="text-sm text-muted">
            {snapshot?.status === "full" ? "Listeners full" : `${spotsOpen} open`}
          </span>
        </header>
        {needGesture ? (
          <UnmuteRoomBar onClick={hear} detail="Your browser muted this room" />
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-6">
          <h1 className="text-2xl font-semibold tracking-tight">{SPACE_TITLE}</h1>
          <p className="mt-1 text-sm text-muted">
            {SPACE_STATUS}
            {roomMuted ? " · Room muted" : ` · ${MAX_SPEAKERS} speaker spots, admitted by the host`}
          </p>
          {healthNote ? <p className="mt-1 text-sm text-live">{healthNote}</p> : null}
          {error ? <p className="mt-6 text-sm text-live">{error}</p> : null}
          {snapshot?.status === "full" ? (
            <p className="mt-6 text-sm text-muted">
              50 people are listening. You'll connect when someone leaves.
            </p>
          ) : null}
          {!snapshot && !error ? (
            <OpeningLine label="Opening the room…" />
          ) : stage.length > 0 ? (
            <ul
              className={
                stage.length === 1
                  ? "mt-8 grid grid-cols-1 justify-items-center"
                  : "mt-8 grid grid-cols-3 gap-x-3 gap-y-6"
              }
            >
              {stage.map((member) => {
                const audible = member.micOn && !member.forcedMute && !roomMuted;
                const level = levels[member.peerId] ?? 0;
                const speakingNow = audible && Boolean(speaking[member.peerId]);
                const lvl = speakingNow ? Math.max(level, 0.28) : level;
                const bad = health.failed.includes(member.peerId)
                  ? "failed"
                  : health.stalled.includes(member.peerId)
                    ? "silent"
                    : health.weak.includes(member.peerId)
                      ? "weak"
                      : "ok";
                return (
                  <li key={member.peerId} className="flex min-w-0 flex-col items-center text-center">
                    <div
                      className={`level-ring relative rounded-full ${speakingNow ? "speak-ring" : ""}`}
                      style={{ ["--lvl" as string]: lvl.toFixed(2) }}
                    >
                      <Portrait person={member} large={stage.length < 4} />
                      {!audible ? (
                        <span className="absolute -right-0.5 -bottom-0.5 grid size-6 place-items-center rounded-full bg-bg text-fg ring-1 ring-line">
                          <MicOff className="size-3.5" aria-hidden />
                        </span>
                      ) : bad !== "ok" ? (
                        <span
                          className={`absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-bg ${bad === "weak" ? "bg-speak" : "bg-live"}`}
                          aria-hidden
                        />
                      ) : null}
                    </div>
                    <span className="mt-2 block w-full truncate text-sm font-medium">{member.displayName}</span>
                    <span className="block w-full truncate text-xs text-muted">@{member.handle}</span>
                    {member.isHost ? <span className="block text-xs text-muted">Host</span> : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-8 text-sm text-muted">No one is speaking yet.</p>
          )}
          {listeningCount > 0 ? (
            <ListenerGrid
              named={namedListeners}
              anonymous={anonymous}
              peerId={peerId}
              count={listeningCount}
            />
          ) : null}
        </div>
        <div className="safe-bottom mt-auto mb-16 px-5">
          <JoinConversationButton sessionPending={sessionPending} />
          {roomLevel > 0 ? (
            <div className="mt-4">
              <LevelBars level={roomLevel} />
            </div>
          ) : null}
          <label className="mt-4 mb-1 block text-sm text-muted" htmlFor="listen-volume">
            Volume
          </label>
          <input
            id="listen-volume"
            className="channel-slider"
            type="range"
            min={0}
            max={100}
            value={volume}
            onChange={(event) => setVolume(Number(event.target.value))}
          />
        </div>
      </div>
    </RoomFrame>
  );
}

const ListenerGrid = memo(function ListenerGrid({
  named,
  anonymous,
  peerId,
  count,
}: {
  named: Person[];
  anonymous: AnonymousListener[];
  peerId: string | null;
  count: number;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-sm font-medium text-muted">Listening · {count}</h2>
      <ul className="mt-4 grid grid-cols-4 gap-x-2 gap-y-5">
        {anonymous
          .filter((ear) => ear.peerId === peerId)
          .map((ear) => (
            <li key={ear.peerId} className="min-w-0">
              <AnonymousSeat you />
            </li>
          ))}
        {named.map((member) => (
          <li key={member.peerId} className="min-w-0">
            <div className="flex w-full min-w-0 flex-col items-center text-center">
              <Portrait person={member} large={false} />
              <span className="mt-2 block w-full truncate text-xs font-medium">{member.displayName}</span>
              <span className="block w-full truncate text-xs text-muted">@{member.handle}</span>
            </div>
          </li>
        ))}
        {anonymous
          .filter((ear) => ear.peerId !== peerId)
          .map((ear) => (
            <li key={ear.peerId} className="min-w-0">
              <AnonymousSeat />
            </li>
          ))}
      </ul>
    </section>
  );
});

function Portrait({ person, large }: { person: Person; large: boolean }) {
  const [broken, setBroken] = useState(false);
  return (
    <div
      className={
        large
          ? "size-24 overflow-hidden rounded-full bg-elevated"
          : "size-14 overflow-hidden rounded-full bg-elevated"
      }
    >
      {person.image && !broken ? (
        <img src={person.image} alt="" className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <span className="grid size-full place-items-center font-medium text-muted">{initials(person.displayName)}</span>
      )}
    </div>
  );
}
