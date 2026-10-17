import { getSql, type Sql } from "@/lib/db";
import { PRESENCE_SECONDS } from "./constants";
import { parseSuno } from "./suno";

const globalRef = globalThis as typeof globalThis & {
  __spaceChatSchema__?: Promise<void>;
  __spacePlaylistSchema__?: Promise<void>;
};

export async function ensureChat(sql: Sql): Promise<void> {
  globalRef.__spaceChatSchema__ ??= (async () => {
    await sql.query(
      `create table if not exists space_chat (
         id bigserial primary key,
         author_key text not null,
         display_name text not null,
         handle text not null,
         body text not null,
         created_at timestamptz not null default now()
       )`,
    );
    await sql.query(`create index if not exists space_chat_id_idx on space_chat (id desc)`);
    await sql.query(
      `create table if not exists space_links (
         id bigserial primary key,
         author_key text not null,
         url text not null,
         display_name text not null,
         handle text not null,
         created_at timestamptz not null default now(),
         unique (author_key, url)
       )`,
    );
  })().catch((err) => {
    globalRef.__spaceChatSchema__ = undefined;
    throw err;
  });
  return globalRef.__spaceChatSchema__;
}

async function ensurePlaylist(sql: Sql): Promise<void> {
  globalRef.__spacePlaylistSchema__ ??= (async () => {
    await sql.query(
      `create table if not exists space_playlist (
         id bigserial primary key,
         url text not null unique,
         song_id text,
         title text not null,
         position integer not null,
         created_at timestamptz not null default now()
       )`,
    );
  })().catch((err) => {
    globalRef.__spacePlaylistSchema__ = undefined;
    throw err;
  });
  return globalRef.__spacePlaylistSchema__;
}

export type ChatMessage = {
  id: number;
  name: string;
  handle: string;
  body: string;
  mine: boolean;
};

export type SharedLink = {
  id: number;
  url: string;
  host: string;
  name: string;
  handle: string;
};

export type PlaylistTrack = {
  id: number;
  url: string;
  songId: string | null;
  title: string;
};

export type ChatSnapshot = {
  messages: ChatMessage[];
  links: SharedLink[];
  playlist: PlaylistTrack[];
};

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const BARE_SUNO = /(?:^|[\s(])((?:www\.)?suno\.(?:com|ai|jp)\/(?:song|embed|s)\/[^\s<>"']+)/gi;

export function pullLinks(body: string): string[] {
  const padded = body.replace(BARE_SUNO, (match, link: string) =>
    match.replace(link, link.startsWith("http") ? link : `https://${link.replace(/^www\./, "")}`),
  );
  const found = padded.match(URL_RE) ?? [];
  const urls: string[] = [];
  for (const raw of found) {
    const trimmed = raw.replace(/[),.;!?]+$/g, "");
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    if (parsed.href.length > 500) continue;
    urls.push(parsed.href);
  }
  return [...new Set(urls)].slice(0, 4);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export async function sweepLinks(sql: Sql): Promise<void> {
  await sql.query(
    `delete from space_links
     where (
       author_key like 'u:%'
       and not exists (
         select 1 from space_members m
         where ('u:' || m.user_id) = space_links.author_key
           and m.in_room = true
           and m.last_seen > now() - make_interval(secs => $1)
           and (m.kicked_until is null or m.kicked_until < now())
       )
     ) or (
       author_key like 'e:%'
       and not exists (
         select 1 from space_listeners e
         where ('e:' || e.peer_id) = space_links.author_key
           and e.last_seen > now() - make_interval(secs => $1)
       )
     )`,
    [PRESENCE_SECONDS],
  );
}

export async function readChat(sql: Sql, viewerKey: string | null): Promise<ChatSnapshot> {
  await ensureChat(sql);
  await ensurePlaylist(sql);
  await sweepLinks(sql);
  const messages = await sql.query<{
    id: number;
    display_name: string;
    handle: string;
    body: string;
    author_key: string;
  }>(
    `select id, display_name, handle, body, author_key
     from space_chat
     order by id desc
     limit 80`,
  );
  const links = await sql.query<{
    id: number;
    url: string;
    display_name: string;
    handle: string;
  }>(
    `select id, url, display_name, handle
     from space_links
     order by created_at desc
     limit 40`,
  );
  const playlist = await sql.query<{
    id: number;
    url: string;
    song_id: string | null;
    title: string;
  }>(
    `select id, url, song_id, title from space_playlist order by position asc, id asc limit 12`,
  );
  return {
    messages: messages.reverse().map((row) => ({
      id: Number(row.id),
      name: row.display_name,
      handle: row.handle,
      body: row.body,
      mine: viewerKey !== null && row.author_key === viewerKey,
    })),
    links: links.map((row) => ({
      id: Number(row.id),
      url: row.url,
      host: hostOf(row.url),
      name: row.display_name,
      handle: row.handle,
    })),
    playlist: playlist.map((row) => ({
      id: Number(row.id),
      url: row.url,
      songId: row.song_id,
      title: row.title,
    })),
  };
}

async function present(sql: Sql, authorKey: string): Promise<boolean> {
  if (authorKey.startsWith("u:")) {
    const userId = authorKey.slice(2);
    const rows = await sql.query<{ ok: number }>(
      `select 1 as ok from space_members
       where user_id = $1
         and in_room = true
         and last_seen > now() - make_interval(secs => $2)
         and (kicked_until is null or kicked_until < now())`,
      [userId, PRESENCE_SECONDS],
    );
    return Boolean(rows[0]);
  }
  if (authorKey.startsWith("e:")) {
    const peerId = authorKey.slice(2);
    const rows = await sql.query<{ ok: number }>(
      `select 1 as ok from space_listeners
       where peer_id = $1
         and last_seen > now() - make_interval(secs => $2)`,
      [peerId, PRESENCE_SECONDS],
    );
    return Boolean(rows[0]);
  }
  return false;
}

export async function addChat(
  authorKey: string,
  name: string,
  handle: string,
  raw: string,
): Promise<"ok" | "empty" | "slow" | "closed"> {
  const sql = await getSql();
  await ensureChat(sql);
  const body = raw.replace(/\s+/g, " ").trim().slice(0, 240);
  if (!body) return "empty";
  if (!(await present(sql, authorKey))) return "closed";
  const recent = await sql.query<{ ok: number }>(
    `select 1 as ok from space_chat
     where author_key = $1 and created_at > now() - interval '1 second'`,
    [authorKey],
  );
  if (recent[0]) return "slow";
  await sql.query(
    `insert into space_chat (author_key, display_name, handle, body) values ($1, $2, $3, $4)`,
    [authorKey, name.slice(0, 80), handle.slice(0, 40), body],
  );
  for (const url of pullLinks(body)) {
    await sql.query(
      `insert into space_links (author_key, url, display_name, handle)
       values ($1, $2, $3, $4)
       on conflict (author_key, url) do update
         set created_at = now(), display_name = excluded.display_name, handle = excluded.handle`,
      [authorKey, url, name.slice(0, 80), handle.slice(0, 40)],
    );
  }
  await sql.query(
    `delete from space_chat where id < (select coalesce(max(id), 0) - 120 from space_chat)`,
  );
  await sweepLinks(sql);
  return "ok";
}

export async function chatForViewer(viewerKey: string | null): Promise<ChatSnapshot> {
  const sql = await getSql();
  return readChat(sql, viewerKey);
}

const SUNO_HOSTS = new Set(["suno.com", "suno.ai", "suno.jp", "app.suno.ai"]);

async function songTitle(pageUrl: string, songId: string | null): Promise<{ title: string; songId: string | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const response = await fetch(pageUrl, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { accept: "text/html" },
    });
    const final = new URL(response.url);
    const host = final.hostname.toLowerCase().replace(/^www\./, "");
    if (!SUNO_HOSTS.has(host)) return { title: "Suno", songId };
    const resolved = parseSuno(final.href);
    const nextId = resolved?.songId ?? songId;
    const html = (await response.text()).slice(0, 80_000);
    const match =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ??
      html.match(/<title>([^<]+)<\/title>/i);
    const raw = match?.[1]
      ?.replaceAll("&" + "amp;", "&")
      .replaceAll("&#" + "39;", "'")
      .replace(/\s+/g, " ")
      .trim();
    const title = raw?.replace(/\s*[|–-]\s*Suno.*$/i, "").slice(0, 80);
    return { title: title || "Suno", songId: nextId };
  } catch {
    return { title: "Suno", songId };
  } finally {
    clearTimeout(timer);
  }
}

export async function addPlaylistTrack(raw: string): Promise<"ok" | "bad" | "full"> {
  const track = parseSuno(raw);
  if (!track) return "bad";
  const sql = await getSql();
  await ensurePlaylist(sql);
  const count = await sql.query<{ n: number }>(`select count(*)::int as n from space_playlist`);
  const existing = await sql.query<{ id: number }>(`select id from space_playlist where url = $1`, [track.url]);
  if (!existing[0] && (count[0]?.n ?? 0) >= 12) return "full";
  const named = await songTitle(track.url, track.songId);
  const songId = named.songId;
  const canonical = songId ? `https://suno.com/song/${songId}` : track.url;
  if (existing[0]) {
    await sql.query(`update space_playlist set title = $2, song_id = $3, url = $4 where id = $1`, [
      existing[0].id,
      named.title,
      songId,
      canonical,
    ]);
    return "ok";
  }
  const pos = await sql.query<{ n: number }>(`select coalesce(max(position), 0)::int as n from space_playlist`);
  await sql.query(
    `insert into space_playlist (url, song_id, title, position) values ($1, $2, $3, $4)
     on conflict (url) do update set title = excluded.title, song_id = excluded.song_id`,
    [canonical, songId, named.title, (pos[0]?.n ?? 0) + 1],
  );
  return "ok";
}

export async function removePlaylistTrack(id: number): Promise<void> {
  const sql = await getSql();
  await ensurePlaylist(sql);
  await sql.query(`delete from space_playlist where id = $1`, [id]);
}
