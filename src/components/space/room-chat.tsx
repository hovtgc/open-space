import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Music2, Plus } from "lucide-react";
import { addTrack, loadChat, removeTrack, sendChat, type ChatSnapshot } from "@/lib/space/chat";
import { parseSuno, sunoEmbed } from "@/lib/space/suno";

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
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  unread: number;
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
  const [chatOpen, setChatOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const seen = useRef<number | null>(null);

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

  useEffect(() => {
    const count = data.messages.length;
    if (seen.current === null) {
      seen.current = count;
      return;
    }
    if (chatOpen) {
      seen.current = count;
      setUnread(0);
      return;
    }
    setUnread(Math.max(0, count - seen.current));
  }, [data.messages, chatOpen]);

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
      value={{ data, host, active, sending, song, setSong, text, setText, error, chatOpen, setChatOpen, unread, saveTrack, dropTrack, submit }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function MusicDock() {
  const { data, host, song, setSong, sending, saveTrack, dropTrack } = useChat();
  const [adding, setAdding] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [index, setIndex] = useState(0);
  const track = data.playlist[index] ?? data.playlist[0] ?? null;

  useEffect(() => {
    if (index >= data.playlist.length) setIndex(0);
  }, [data.playlist.length, index]);

  if (!host && !track) return null;

  return (
    <div className="border-b border-line bg-bg">
      <div className="flex h-12 items-center gap-2 px-4">
        <Music2 className="size-4 shrink-0 text-muted" aria-hidden />
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm"
          disabled={!track}
          onClick={() => {
            if (data.playlist.length < 2) return;
            setIndex((current) => (current + 1) % data.playlist.length);
            setPlaying(true);
          }}
        >
          {track ? track.title : "Background music"}
        </button>
        {track?.songId ? (
          <button
            type="button"
            className="press h-8 shrink-0 rounded-full border border-line px-3 text-xs font-medium"
            aria-pressed={playing}
            onClick={() => setPlaying((on) => !on)}
          >
            {playing ? "Stop" : "Play"}
          </button>
        ) : track ? (
          <a href={track.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-muted underline">
            Open
          </a>
        ) : null}
        {host ? (
          <button
            type="button"
            className="press grid size-8 shrink-0 place-items-center rounded-full border border-line"
            aria-label={adding ? "Close music" : "Add music"}
            aria-pressed={adding}
            onClick={() => setAdding((open) => !open)}
          >
            <Plus className="size-4" />
          </button>
        ) : null}
      </div>
      {playing && track?.songId ? (
        <iframe
          className="h-24 w-full border-0"
          src={sunoEmbed(track.songId)}
          title={track.title}
          allow="autoplay; encrypted-media"
        />
      ) : null}
      {adding ? (
        <div className="px-4 pb-3">
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
              placeholder="Suno link"
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
          {data.playlist.length > 0 ? (
            <ul className="mt-2">
              {data.playlist.map((item, itemIndex) => (
                <li key={item.id} className="flex items-center gap-3 py-1.5">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm"
                    onClick={() => {
                      setIndex(itemIndex);
                      setPlaying(true);
                    }}
                  >
                    <span className="mr-2 tabular-nums text-muted">{itemIndex + 1}</span>
                    {item.title}
                  </button>
                  <button type="button" className="shrink-0 text-xs text-muted" aria-label={`Remove ${item.title}`} onClick={() => void dropTrack(item.id)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function MessagePanel() {
  const { data, host, chatOpen, text, setText, sending, active, error, submit, saveTrack } = useChat();
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = logRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [data.messages.length, chatOpen]);

  if (!chatOpen) return null;

  return (
    <div className="border-b border-line bg-bg">
      <div ref={logRef} className="max-h-36 overflow-y-auto px-4 py-3">
        {data.links.length > 0 ? (
          <ul className="mb-3 flex gap-2 overflow-x-auto">
            {data.links.map((link) => (
              <li key={link.id} className="flex shrink-0 items-center gap-1">
                <a href={link.url} target="_blank" rel="noreferrer" className="block max-w-52 truncate rounded-full border border-line px-3 py-1.5 text-xs">
                  {link.host}
                </a>
                {host && parseSuno(link.url) ? (
                  <button type="button" className="rounded-full border border-line px-2.5 py-1.5 text-xs" onClick={() => void saveTrack(link.url)}>
                    Add
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
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
      <form className="flex items-center gap-2 px-4 pb-3" onSubmit={(event) => void submit(event)}>
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
      {error ? <p className="px-4 pb-2 text-center text-xs text-live">{error}</p> : null}
    </div>
  );
}

export function ChatToggle() {
  const { chatOpen, setChatOpen, unread } = useChat();
  return (
    <button
      type="button"
      className={`press h-8 shrink-0 rounded-full border px-3 text-xs font-medium ${chatOpen ? "border-fg text-fg" : "border-line text-muted"}`}
      aria-pressed={chatOpen}
      onClick={() => setChatOpen(!chatOpen)}
    >
      {chatOpen ? "Close chat" : unread > 0 ? `Chat ${unread}` : "Chat"}
    </button>
  );
}


