import { useEffect, useRef, useState, type ReactNode } from "react";
import { User, Users, Volume2 } from "lucide-react";
import { signIn } from "@/lib/auth/client";
import { SPACE_STATUS, SPACE_TITLE, SOURCE_URL } from "@/lib/space/constants";

export function RoomFrame({ children }: { children: ReactNode }) {
  useEffect(() => {
    const kick = () => {
      const root = document.documentElement;
      root.classList.add("anim-reset");
      requestAnimationFrame(() => root.classList.remove("anim-reset"));
    };
    const onVis = () => {
      if (!document.hidden) kick();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", kick);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", kick);
    };
  }, []);
  return (
    <div className="flex h-dvh justify-center overflow-hidden bg-bg text-fg">
      <div className="flex h-dvh w-full max-w-lg flex-col md:border-x md:border-line">{children}</div>
    </div>
  );
}

export function LiveMark() {
  return (
    <span className="inline-flex items-center gap-2 text-xs font-semibold tracking-wide">
      <span className="live-dot size-2 rounded-full bg-live" aria-hidden />
      LIVE
    </span>
  );
}

export function SourceLink() {
  return (
    <a
      href={SOURCE_URL}
      target="_blank"
      rel="noreferrer"
      className="text-sm text-muted underline decoration-line underline-offset-4"
    >
      Open source
    </a>
  );
}

export function SeatCount({ count }: { count: number | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm tabular-nums text-muted">
      <Users className="size-4" aria-hidden />
      <span className="inline-block min-w-4 text-right tabular-nums">{count ?? ""}</span>
    </span>
  );
}

export function UnmuteRoomBar({ onClick, detail }: { onClick: () => void; detail: string }) {
  return (
    <div className="px-5 pt-3">
      <button
        type="button"
        className="press flex h-14 w-full items-center justify-center gap-3 rounded-full bg-fg text-base font-semibold text-bg"
        onClick={onClick}
      >
        <Volume2 className="size-5" aria-hidden />
        Unmute room
      </button>
      <p className="mt-2 text-center text-xs text-muted">{detail}</p>
    </div>
  );
}

export function LevelBars({ level }: { level: number }) {
  const steps = [0.18, 0.38, 0.58, 0.78];
  const heights = ["h-1", "h-2", "h-3", "h-4"];
  return (
    <div className="flex h-4 items-end justify-center gap-1" aria-hidden>
      {steps.map((step, index) => (
        <span
          key={step}
          className={`w-1.5 rounded-full ${level >= step ? "bg-speak" : "bg-line"} ${heights[index] ?? "h-1"}`}
        />
      ))}
    </div>
  );
}

export function OpeningLine({ label }: { label: string }) {
  return (
    <p className="mt-4 flex items-center gap-3 text-sm text-muted">
      <span className="seat-wait inline-block size-2.5 rounded-full bg-speak" aria-hidden />
      {label}
    </p>
  );
}

export function AnonymousSeat({ you = false }: { you?: boolean }) {
  return (
    <div className="flex w-full min-w-0 flex-col items-center text-center">
      <div className="grid size-14 place-items-center rounded-full bg-elevated text-muted">
        <User className="size-5" aria-hidden />
      </div>
      <span className="mt-2 block w-full truncate text-xs font-medium">Anonymous</span>
      {you ? <span className="block text-xs text-muted">You</span> : null}
    </div>
  );
}

function XLogo() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
    </svg>
  );
}

export function BootScreen() {
  return (
    <RoomFrame>
      <header className="safe-top flex items-center justify-between px-5">
        <LiveMark />
        <SeatCount count={null} />
      </header>
      <div className="px-5 pt-8">
        <h1 className="text-2xl font-semibold tracking-tight">{SPACE_TITLE}</h1>
        <p className="mt-1 text-sm text-muted">{SPACE_STATUS}</p>
        <div className="mt-10 grid grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col items-center gap-3">
              <div className="size-20 animate-pulse rounded-full bg-elevated" />
              <div className="h-3 w-14 animate-pulse rounded-full bg-elevated" />
            </div>
          ))}
        </div>
      </div>
    </RoomFrame>
  );
}

export function JoinConversationButton({ sessionPending = false }: { sessionPending?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const arm = useRef(false);

  useEffect(() => {
    if (!arm.current || sessionPending) return;
    arm.current = false;
    let cancelled = false;
    void signIn("grok-x", { callbackURL: "/" })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Sign-in failed");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionPending]);

  return (
    <div>
      <button
        type="button"
        className="press inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-fg px-5 font-semibold text-bg disabled:opacity-60"
        disabled={busy}
        onClick={() => {
          if (busy) return;
          setError(null);
          setBusy(true);
          if (sessionPending) {
            arm.current = true;
            return;
          }
          void signIn("grok-x", { callbackURL: "/" })
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : "Sign-in failed");
            })
            .finally(() => setBusy(false));
        }}
      >
        <XLogo />
        {busy ? "Opening X…" : "Join the conversation"}
      </button>
      <p className="mt-2 text-center text-sm text-muted">Log in with X to request a mic</p>
      {error ? <p className="mt-2 text-center text-sm text-live">{error}</p> : null}
    </div>
  );
}
