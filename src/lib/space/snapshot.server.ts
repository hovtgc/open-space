import { getSql, type Sql } from "@/lib/db";
import { MAX_LISTENERS, MAX_SEATS, MAX_SPEAKERS, PRESENCE_SECONDS, toPeerId } from "./constants";
import type { AnonymousListener, Member } from "./types";

const globalRef = globalThis as typeof globalThis & {
  __spaceListenSchema__?: Promise<void>;
  __spaceAdmitSchema__?: Promise<void>;
  __spaceExpireAt__?: number;
};

function ensureListenTables(sql: Sql): Promise<void> {
  globalRef.__spaceListenSchema__ ??= (async () => {
    await sql.query(
      `create table if not exists space_state (
         id text primary key,
         room_muted boolean not null default false
       )`,
    );
    await sql.query(
      `insert into space_state (id, room_muted) values ('open', false)
       on conflict (id) do nothing`,
    );
    await sql.query(
      `create table if not exists space_listeners (
         peer_id text primary key,
         last_seen timestamptz not null default now()
       )`,
    );
    await sql.query(
      `create index if not exists space_listeners_seen_idx on space_listeners (last_seen)`,
    );
  })().catch((err) => {
    globalRef.__spaceListenSchema__ = undefined;
    throw err;
  });
  return globalRef.__spaceListenSchema__;
}

function ensureAdmitColumns(sql: Sql): Promise<void> {
  globalRef.__spaceAdmitSchema__ ??= (async () => {
    await sql.query(`alter table space_members add column if not exists admitted_until timestamptz`);
    await sql.query(
      `alter table space_members add column if not exists speak_requested boolean not null default false`,
    );
  })().catch((err) => {
    globalRef.__spaceAdmitSchema__ = undefined;
    throw err;
  });
  return globalRef.__spaceAdmitSchema__;
}

async function expireAdmissions(sql: Sql, force: boolean): Promise<void> {
  const now = Date.now();
  if (!force && (globalRef.__spaceExpireAt__ ?? 0) > now) return;
  globalRef.__spaceExpireAt__ = now + 8000;
  await sql.query(
    `update space_members set
       speaker = false,
       mic_on = false,
       speak_requested = false,
       admitted_until = null
     where is_host = false
       and admitted_until is not null
       and admitted_until <= now()`,
  );
}

export async function prepareRoom(opts?: { fresh?: boolean }): Promise<Sql> {
  const sql = await getSql();
  await ensureListenTables(sql);
  await ensureAdmitColumns(sql);
  await expireAdmissions(sql, opts?.fresh === true);
  return sql;
}

const LISTENER_LOAD = `
  (select count(*)::int from space_listeners
    where last_seen > now() - make_interval(secs => $1))
  + (select count(*)::int from space_members
    where in_room = true
      and is_host = false
      and (admitted_until is null or admitted_until <= now())
      and last_seen > now() - make_interval(secs => $1)
      and (kicked_until is null or kicked_until < now()))
`;

export async function listenerLoad(sql: Sql): Promise<number> {
  const rows = await sql.query<{ n: number }>(`select (${LISTENER_LOAD})::int as n`, [PRESENCE_SECONDS]);
  return rows[0]?.n ?? 0;
}

/** Keep a new ear only when the room is still under the listener cap. */
export async function claimEar(sql: Sql, peerId: string): Promise<"ok" | "full"> {
  await sql.query(
    `insert into space_listeners (peer_id, last_seen) values ($1, now())
     on conflict (peer_id) do update set last_seen = now()`,
    [peerId],
  );
  const dropped = await sql.query<{ peer_id: string }>(
    `delete from space_listeners where peer_id = $2 and (${LISTENER_LOAD}) > $3 returning peer_id`,
    [PRESENCE_SECONDS, peerId, MAX_LISTENERS],
  );
  return dropped[0] ? "full" : "ok";
}

type MemberRow = {
  user_id: string;
  display_name: string;
  handle: string;
  image: string | null;
  is_host: boolean;
  speaker: boolean;
  mic_on: boolean;
  forced_mute: boolean;
  speak_requested: boolean;
  admitted: boolean;
  admitted_until: string | null;
};

function asBool(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

function toMember(row: MemberRow): Member {
  const admitted = asBool(row.admitted);
  const host = asBool(row.is_host);
  const forced = asBool(row.forced_mute);
  const mic = asBool(row.mic_on);
  return {
    userId: row.user_id,
    peerId: toPeerId(row.user_id),
    displayName: row.display_name,
    handle: row.handle,
    image: row.image,
    isHost: host,
    speaker: host || admitted,
    micOn: mic && !forced && (host || admitted),
    forcedMute: forced,
    speakRequested: asBool(row.speak_requested) && !host && !admitted,
    admittedUntil: admitted ? row.admitted_until : null,
  };
}

export type RoomView = {
  roomMuted: boolean;
  spotsUsed: number;
  listenerCount: number;
  members: Member[];
  anonymous: AnonymousListener[];
};

export async function readRoom(): Promise<RoomView> {
  const sql = await prepareRoom();
  const [memberRows, stateRows, spotRows, load, earRows] = await Promise.all([
    sql.query<MemberRow>(
      `select user_id, display_name, handle, image, is_host, speaker, mic_on, forced_mute,
              speak_requested,
              (admitted_until is not null and admitted_until > now()) as admitted,
              to_char(admitted_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as admitted_until
       from space_members
       where in_room = true
         and last_seen > now() - make_interval(secs => $1)
         and (kicked_until is null or kicked_until < now())
       order by is_host desc, admitted_until desc nulls last, joined_at asc
       limit $2`,
      [PRESENCE_SECONDS, MAX_SEATS],
    ),
    sql.query<{ room_muted: boolean }>(`select room_muted from space_state where id = 'open'`),
    sql.query<{ n: number }>(
      `select count(*)::int as n from space_members
       where in_room = true
         and is_host = false
         and admitted_until is not null
         and admitted_until > now()
         and last_seen > now() - make_interval(secs => $1)
         and (kicked_until is null or kicked_until < now())`,
      [PRESENCE_SECONDS],
    ),
    listenerLoad(sql),
    sql.query<{ peer_id: string }>(
      `select peer_id from space_listeners
       where last_seen > now() - make_interval(secs => $1)
       order by last_seen asc
       limit $2`,
      [PRESENCE_SECONDS, MAX_LISTENERS],
    ),
  ]);
  return {
    roomMuted: asBool(stateRows[0]?.room_muted),
    spotsUsed: Math.min(MAX_SPEAKERS, spotRows[0]?.n ?? 0),
    listenerCount: Math.min(MAX_LISTENERS, load),
    members: memberRows.map(toMember),
    anonymous: earRows.map((row) => ({ peerId: row.peer_id })),
  };
}
