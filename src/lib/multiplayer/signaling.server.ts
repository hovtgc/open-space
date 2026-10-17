/**
 * WebRTC signaling for the single open room. Roster + SDP/ICE only —
 * audio goes peer to peer. Peer ids are the signed-in user, never a
 * client-chosen name.
 */
import { z } from "zod";
import { getSql, type Sql } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/verify.server";
import { PRESENCE_SECONDS, ROOM_ID, toPeerId } from "@/lib/space/constants";
import { prepareRoom } from "@/lib/space/snapshot.server";
import type { SignalKind } from "./p2p";

const ID = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const signalSchema = z.object({
  op: z.literal("signal"),
  room: ID,
  from: ID,
  to: ID,
  kind: z.enum(["offer", "answer", "ice"]),
  payload: z.unknown().refine((v) => v !== undefined && JSON.stringify(v).length <= 32_768, {
    message: "payload too large",
  }),
});
const leaveSchema = z.object({ op: z.literal("leave"), room: ID, peer: ID });
const postSchema = z.discriminatedUnion("op", [signalSchema, leaveSchema]);

const SIGNAL_TTL_SECONDS = 60;
const EAR_COOKIE = "space_ear";
const EAR_ID = /^ear_[a-f0-9]{32}$/;

const globalRef = globalThis as typeof globalThis & {
  __rtcSchemaPromise__?: Promise<void>;
};

function ensureSchema(sql: Sql): Promise<void> {
  globalRef.__rtcSchemaPromise__ ??= (async () => {
    await sql.query(
      `CREATE TABLE IF NOT EXISTS webrtc_peers (
         room TEXT NOT NULL,
         peer_id TEXT NOT NULL,
         name TEXT NOT NULL DEFAULT '',
         last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (room, peer_id)
       )`,
    );
    await sql.query(
      `CREATE TABLE IF NOT EXISTS webrtc_signals (
         id BIGSERIAL PRIMARY KEY,
         room TEXT NOT NULL,
         to_peer TEXT NOT NULL,
         from_peer TEXT NOT NULL,
         kind TEXT NOT NULL,
         payload JSONB NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    await sql.query(
      `CREATE INDEX IF NOT EXISTS webrtc_signals_inbox
         ON webrtc_signals (room, to_peer, id)`,
    );
  })().catch((err) => {
    globalRef.__rtcSchemaPromise__ = undefined;
    throw err;
  });
  return globalRef.__rtcSchemaPromise__;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

async function caller(request: Request): Promise<{ id: string; peerId: string } | null> {
  const header = request.headers.get("authorization");
  const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  const user = await getSessionUser(bearer);
  if (!user) return null;
  return { id: user.id, peerId: toPeerId(user.id) };
}

async function liveEar(sql: Sql, request: Request): Promise<string | null> {
  const peerId = cookieValue(request, EAR_COOKIE);
  if (!peerId || !EAR_ID.test(peerId)) return null;
  const rows = await sql.query<{ peer_id: string }>(
    `update space_listeners set last_seen = now()
     where peer_id = $1 and last_seen > now() - make_interval(secs => $2)
     returning peer_id`,
    [peerId, PRESENCE_SECONDS],
  );
  return rows[0]?.peer_id ?? null;
}

async function prune(sql: Sql) {
  await Promise.all([
    sql.query(`DELETE FROM webrtc_signals WHERE created_at < now() - make_interval(secs => $1)`, [
      SIGNAL_TTL_SECONDS,
    ]),
    sql.query(`DELETE FROM webrtc_peers WHERE last_seen < now() - make_interval(secs => $1)`, [
      PRESENCE_SECONDS,
    ]),
  ]);
}

/** Drop a member's handshake rows so the mesh closes on kick. */
export async function dropPeer(userId: string): Promise<void> {
  const sql = await getSql();
  await ensureSchema(sql);
  const peer = toPeerId(userId);
  await sql.query(`DELETE FROM webrtc_peers WHERE room = $1 AND peer_id = $2`, [ROOM_ID, peer]);
  await sql.query(
    `DELETE FROM webrtc_signals WHERE room = $1 AND (from_peer = $2 OR to_peer = $2)`,
    [ROOM_ID, peer],
  );
}

async function handleGet(url: URL, userId: string, peerId: string): Promise<Response> {
  const parsed = z
    .object({
      room: ID,
      peer: ID,
      since: z.coerce.number().int().min(0).default(0),
    })
    .safeParse({
      room: url.searchParams.get("room"),
      peer: url.searchParams.get("peer"),
      since: url.searchParams.get("since") ?? 0,
    });
  if (!parsed.success) return json({ error: "invalid query" }, 400);
  const { room, peer, since } = parsed.data;
  if (room !== ROOM_ID || peer !== peerId) return json({ error: "forbidden" }, 403);

  const sql = await getSql();
  await ensureSchema(sql);
  const touched = await sql.query<{ display_name: string }>(
    `UPDATE space_members SET last_seen = now()
     WHERE user_id = $1 AND in_room = true
       AND (kicked_until IS NULL OR kicked_until < now())
     RETURNING display_name`,
    [userId],
  );
  if (!touched[0]) return json({ error: "not in room" }, 403);
  return pollInbox(sql, peerId, since, touched[0].display_name.slice(0, 64));
}

async function pollInbox(sql: Sql, peerId: string, since: number, name: string): Promise<Response> {
  if (since === 0 || Math.random() < 0.02) await prune(sql);
  await sql.query(
    `INSERT INTO webrtc_peers (room, peer_id, name, last_seen)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (room, peer_id)
     DO UPDATE SET last_seen = now(), name = EXCLUDED.name`,
    [ROOM_ID, peerId, name],
  );
  const signals = await sql.query<{
    id: number;
    from_peer: string;
    kind: SignalKind;
    payload: unknown;
  }>(
    `SELECT id, from_peer, kind, payload FROM webrtc_signals
     WHERE room = $1 AND to_peer = $2 AND id > $3
     ORDER BY id LIMIT 400`,
    [ROOM_ID, peerId, since],
  );
  const peers = await sql.query<{ peer_id: string; name: string }>(
    `SELECT peer_id, name FROM webrtc_peers
     WHERE room = $1 AND last_seen > now() - make_interval(secs => $2)
     ORDER BY peer_id LIMIT 120`,
    [ROOM_ID, PRESENCE_SECONDS],
  );
  return json({
    peers: peers.map((p) => ({ id: p.peer_id, name: p.name })),
    signals: signals.map((r) => ({
      id: r.id,
      from: r.from_peer,
      kind: r.kind,
      payload: r.payload,
    })),
  });
}

async function speakerPeers(sql: Sql): Promise<Set<string>> {
  const rows = await sql.query<{ user_id: string }>(
    `select user_id from space_members
     where in_room = true
       and (
         is_host = true
         or (admitted_until is not null and admitted_until > now())
       )
       and last_seen > now() - make_interval(secs => $1)
       and (kicked_until is null or kicked_until < now())`,
    [PRESENCE_SECONDS],
  );
  return new Set(rows.map((row) => toPeerId(row.user_id)));
}

async function handlePost(
  request: Request,
  peerId: string,
  actor: { kind: "member"; userId: string } | { kind: "ear" },
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid request" }, 400);
  const msg = parsed.data;
  if (msg.room !== ROOM_ID) return json({ error: "forbidden" }, 403);

  const sql = await prepareRoom();
  await ensureSchema(sql);

  if (msg.op === "signal") {
    if (msg.from !== peerId) return json({ error: "forbidden" }, 403);
    const speakers = await speakerPeers(sql);
    if (!speakers.has(peerId) && !speakers.has(msg.to)) return json({ error: "forbidden" }, 403);
    await sql.query(
      `INSERT INTO webrtc_signals (room, to_peer, from_peer, kind, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [ROOM_ID, msg.to, peerId, msg.kind, JSON.stringify(msg.payload)],
    );
    return json({ ok: true });
  }

  if (msg.peer !== peerId) return json({ error: "forbidden" }, 403);
  await sql.query(`DELETE FROM webrtc_peers WHERE room = $1 AND peer_id = $2`, [ROOM_ID, peerId]);
  if (actor.kind === "ear") {
    await sql.query(`DELETE FROM space_listeners WHERE peer_id = $1`, [peerId]);
    return json({ ok: true });
  }
  await sql.query(
    `UPDATE space_members
     SET in_room = false, mic_on = false, speaker = is_host
     WHERE user_id = $1`,
    [actor.userId],
  );
  return json({ ok: true });
}

function parsePoll(url: URL) {
  return z
    .object({
      room: ID,
      peer: ID,
      since: z.coerce.number().int().min(0).default(0),
    })
    .safeParse({
      room: url.searchParams.get("room"),
      peer: url.searchParams.get("peer"),
      since: url.searchParams.get("since") ?? 0,
    });
}

export async function handleSignaling(request: Request): Promise<Response> {
  try {
    const sql = await getSql();
    await ensureSchema(sql);
    const user = await caller(request);
    if (user) {
      if (request.method === "GET") return await handleGet(new URL(request.url), user.id, user.peerId);
      if (request.method === "POST") {
        return await handlePost(request, user.peerId, { kind: "member", userId: user.id });
      }
      return json({ error: "method not allowed" }, 405);
    }
    const ear = await liveEar(sql, request);
    if (!ear) return json({ error: "unauthorized" }, 401);
    if (request.method === "GET") {
      const parsed = parsePoll(new URL(request.url));
      if (!parsed.success) return json({ error: "invalid query" }, 400);
      if (parsed.data.room !== ROOM_ID || parsed.data.peer !== ear) return json({ error: "forbidden" }, 403);
      return pollInbox(sql, ear, parsed.data.since, "Listener");
    }
    if (request.method === "POST") return await handlePost(request, ear, { kind: "ear" });
    return json({ error: "method not allowed" }, 405);
  } catch (error) {
    console.error("[rtc] signaling error:", error);
    return json({ error: "signaling failed" }, 500);
  }
}
