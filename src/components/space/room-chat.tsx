import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { addTrack, loadChat, removeTrack, sendChat, type ChatSnapshot } from "@/lib/space/chat";
import { parseSuno } from "@/lib/space/suno";

const EMPTY: ChatSnapshot = { messages: [], links: [], playlist: [] };

type ChatContextValue = {
  data: ChatSnapshot;
  host: boolean;
  active: boolean;
  sending: boolean;
  song: string;
  setSong: (value: string) => void;
  text: string;
  setText: (value: string) => void;
  error: string | null;
  saveTrack: (url: string) => Promise<void>;
  dropTrack: (id: number) => Promise<void>;
  submit: (event: FormEvent) => Promise<void>;
};

const ChatContext = createContext<ChatContextValue | null>(null);

function useChat() {
  const value = useContext(ChatContext);
  if (!value) throw new Error("Chat is outside its provider");
  return value;
}

function TextWithLinks({ body }: { body: string }) {
  const parts = body.split(/(https?:\/\/[^\s<>"']+)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (!/^https?:\/\//.test(part)) return <span key={index}>{part}</span>;
        const href = part.replace(/[),.;!?]+$/g, "");
        const trail = part.slice(href.length);
        let ok = false;
        try {
          const url = new URL(href);
          ok = url.protocol === "http:" || url.protocol === "https:";
        } catch {
          ok = false;
        }
        if (!ok) return <span key={index}>{part}</span>;
        return (
          <span key={index}>
            <a href={href} target="_blank" rel="noreferrer" className="underline">
              {href}
            </a>
            {trail}
          </span>
        );
      })}
    </>
  );
}

export function ChatProvider({
  signedIn,
  active,
  host = false,
  children,
}: {
  signedIn: boolean;
  active: boolean;
  host?: boolean;
  children: ReactNode;
}) {
  const [data, setData] = useState<ChatSnapshot>(EMPTY);
  const [text, setText] = useState("");
  const [song, setSong] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    async function pull() {
      try {
        const next = signedIn
          ? await loadChat()
          : ((await (await fetch("/api/chat")).json()) as ChatSnapshot);
        if (!cancelled) setData({ ...EMPTY, ...next, playlist: next.playlist ?? [], links: next.links ?? [], messages: next.messages ?? [] });
      } catch {
        /* next poll retries */
      }
    }
    void pull();
    const id = window.setInterval(() => void pull(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active, signedIn]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body || sending || !active) return;
    setSending(true);
    setError(null);
    try {
      const next = signedIn
        ? await sendChat({ data: body })
        : await (async () => {
            const response = await fetch("/api/chat", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ body }),
            });
            const payload = (await response.json()) as ChatSnapshot & { error?: string };
            if (!response.ok) throw new Error(payload.error ?? "That didn't send.");
            return payload;
          })();
      setData(next);
      setText("");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "That didn't send.");
    } finally {
      setSending(false);
    }
  }

  async function saveTrack(url: string) {
    if (!host || sending) return;
    setSending(true);
    setError(null);
    try {
      setData(await addTrack({ data: url }));
      setSong("");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "That didn't save.");
    } finally {
      setSending(false);
    }
  }

  async function dropTrack(id: number) {
    if (!host) return;
    setError(null);
    try {
      setData(await removeTrack({ data: id }));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "That didn't remove.");
    }
  }

  return (
    <ChatContext.Provider
      value={{ data, host, active, sending, song, setSong, text, setText, error, saveTrack, dropTrack, submit }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function ChatTranscript() {
  const { data, host, saveTrack, dropTrack } = useChat();
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = logRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [data.messages.length]);

  return (
    <div className="px-5 pt-5 pb-6">
      {data.playlist.length > 0 ? (
        <div>
          <p className="text-xs font-medium tracking-wide text-muted">Playlist</p>
          <ul className="mt-1">
            {data.playlist.map((track, index) => (
              <li key={track.id} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
                <a href={track.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm">
                  <span className="mr-2 tabular-nums text-muted">{index + 1}</span>
                  {track.title}
                </a>
                {host ? (
                  <button type="button" className="shrink-0 text-xs text-muted" aria-label={`Remove ${track.title}`} onClick={() => void dropTrack(track.id)}>
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {data.links.length > 0 ? (
        <div className="pt-4">
          <p className="text-xs font-medium tracking-wide text-muted">Links</p>
          <ul className="mt-2 flex gap-2 overflow-x-auto pb-1">
            {data.links.map((link) => (
              <li key={link.id} className="flex shrink-0 items-center gap-1">
                <a href={link.url} target="_blank" rel="noreferrer" className="block max-w-52 truncate rounded-full border border-line px-3 py-1.5 text-xs">
                  {link.host}
                  <span className="text-muted"> · {link.handle ? `@${link.handle}` : link.name}</span>
                </a>
                {host && parseSuno(link.url) ? (
                  <button type="button" className="rounded-full border border-line px-2.5 py-1.5 text-xs" onClick={() => void saveTrack(link.url)}>
                    Add
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div ref={logRef} className="mt-4">
        {data.messages.length === 0 ? (
          <p className="text-sm text-muted">No messages yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {data.messages.map((message) => (
              <li key={message.id} className={message.mine ? "ml-8 text-right" : "mr-8"}>
                <p className="text-xs text-muted">{message.handle ? `@${message.handle}` : message.name}</p>
                <p className={`mt-1 inline-block max-w-full rounded-2xl px-3 py-2 text-left text-sm leading-snug break-words ${message.mine ? "bg-fg text-bg" : "bg-elevated"}`}>
                  <TextWithLinks body={message.body} />
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ChatComposer() {
  const { host, song, setSong, sending, saveTrack, text, setText, active, error, submit } = useChat();
  return (
    <div className="flex flex-col gap-3 bg-bg px-5 pt-3">
      {host ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void saveTrack(song);
          }}
        >
          <input
            className="field min-w-0 flex-1 rounded-full border border-line bg-elevated px-4 text-base"
            value={song}
            placeholder="Paste a Suno link"
            aria-label="Suno link"
            onChange={(event) => setSong(event.target.value)}
          />
          <button
            type="submit"
            className="press h-11 shrink-0 rounded-full bg-fg px-4 text-sm font-semibold text-bg disabled:opacity-50"
            disabled={sending || song.trim().length === 0}
          >
            Add
          </button>
        </form>
      ) : null}
      <form className="flex items-center gap-2" onSubmit={(event) => void submit(event)}>
        <input
          className="field min-w-0 flex-1 rounded-full border border-line bg-elevated px-4 text-base"
          value={text}
          maxLength={240}
          placeholder="Message"
          aria-label="Message"
          disabled={!active || sending}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="submit"
          className="press h-11 shrink-0 rounded-full bg-fg px-4 text-sm font-semibold text-bg disabled:opacity-50"
          disabled={!active || sending || text.trim().length === 0}
        >
          Send
        </button>
      </form>
      {error ? <p className="text-center text-xs text-live">{error}</p> : null}
    </div>
  );
}
