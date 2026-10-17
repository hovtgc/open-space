const HOSTS = new Set(["suno.com", "suno.ai", "suno.jp", "app.suno.ai"]);
const SONG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SunoTrack = {
  url: string;
  songId: string | null;
};

/** A public Suno song, embed, or short share link. */
export function parseSuno(input: string): SunoTrack | null {
  const raw = input.trim();
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/\//, "")}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!HOSTS.has(host)) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  const kind = parts[0];
  const id = parts[1];
  if (!id || (kind !== "song" && kind !== "embed" && kind !== "s")) return null;
  if (kind === "s") {
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return null;
    return { url: `https://suno.com/s/${id}`, songId: null };
  }
  if (!SONG.test(id)) return null;
  return { url: `https://suno.com/song/${id.toLowerCase()}`, songId: id.toLowerCase() };
}

export function sunoEmbed(songId: string): string {
  return `https://suno.com/embed/${songId}`;
}
