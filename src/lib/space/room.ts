import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { cleanName, isRoomHost, publicHandle, safeImage } from "./identity";
import { MAX_LISTENERS, MAX_SEATS, MAX_SPEAKERS, PRESENCE_SECONDS } from "./constants";
import type { SpaceResult } from "./types";

type Profile = {
  displayName: string;
  handle: string;
  image: string | null;
  isHost: boolean;
};

async function sqlClient() {
  const { getSql } = await import("@/lib/db");
  return getSql();
}

async function loadProfile(userId: string): Promise<Profile | null> {
  const sql = await sqlClient();
  const rows = await sql.query<{ name: string; email: string; image: string | null }>(
    `select "name", "email", "image" from "user" where "id" = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  const displayName = cleanName(row.name);
  const host = isRoomHost({ name: row.name, email: row.email });
  return {
    displayName,
    handle: host ? "hovinthenorth" : publicHandle(displayName),
    image: safeImage(row.image),
    isHost: host,
  };
}

async function present(selfId: string): Promise<SpaceResult> {
  const { readRoom } = await import("./snapshot.server");
  const room = await readRoom();
  const self = room.members.find((member) => member.userId === selfId);
  if (!self) return { status: "left" };
  return {
    status: "ok",
    self,
    members: room.members,
    anonymous: room.anonymous,
    roomMuted: room.roomMuted,
    spotsUsed: room.spotsUsed,
    listenerCount: room.listenerCount,
  };
}

async function kickState(userId: string): Promise<SpaceResult | null> {
  const sql = await sqlClient();
  const rows = await sql.query<{ until: string | null }>(
    `select to_char(kicked_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as until
     from space_members
     where user_id = $1 and kicked_until is not null and kicked_until > now()`,
    [userId],
  );
  const until = rows[0]?.until;
  if (!until) return null;
  return { status: "kicked", until };
}

export const joinSpace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<SpaceResult> => {
    const kicked = await kickState(context.userId);
    if (kicked) return kicked;
    const profile = await loadProfile(context.userId);
    if (!profile) return { status: "left" };
    const { prepareRoom } = await import("./snapshot.server");
    const sql = await prepareRoom();
    const inserted = await sql.query<{ user_id: string }>(
      `insert into space_members (
         user_id, display_name, handle, image, is_host, speaker, mic_on, forced_mute, in_room, last_seen, joined_at
       )
       select $1, $2, $3, $4, $5, $5, false, false, true, now(), now()
       from (
         select
           (select count(*)::int
            from space_members
            where in_room = true
              and user_id <> $1
              and last_seen > now() - make_interval(secs => $6)
              and (kicked_until is null or kicked_until < now())) as seats,
           (select count(*)::int from space_listeners
            where last_seen > now() - make_interval(secs => $6))
           + (select count(*)::int from space_members
            where in_room = true
              and user_id <> $1
              and is_host = false
              and (admitted_until is null or admitted_until <= now())
              and last_seen > now() - make_interval(secs => $6)
              and (kicked_until is null or kicked_until < now())) as listeners
       ) active
       where (active.seats < $7 or exists (
            select 1 from space_members s
            where s.user_id = $1
              and s.in_room = true
              and s.last_seen > now() - make_interval(secs => $6)
              and (s.kicked_until is null or s.kicked_until < now())
          ))
         and (
           $5
           or exists (
             select 1 from space_members s
             where s.user_id = $1
               and s.in_room = true
               and s.last_seen > now() - make_interval(secs => $6)
               and (s.kicked_until is null or s.kicked_until < now())
           )
           or exists (
             select 1 from space_members s
             where s.user_id = $1 and s.admitted_until > now()
           )
           or active.listeners < $8
         )
       on conflict (user_id) do update set
         display_name = excluded.display_name,
         handle = excluded.handle,
         image = excluded.image,
         is_host = excluded.is_host,
         in_room = true,
         last_seen = now(),
         joined_at = case when space_members.in_room then space_members.joined_at else now() end,
         mic_on = case
           when space_members.in_room then space_members.mic_on
           else false
         end,
         speaker = excluded.is_host
           or (space_members.admitted_until is not null and space_members.admitted_until > now())
       where excluded.is_host
          or exists (
            select 1 from space_members s
            where s.user_id = excluded.user_id
              and s.in_room = true
              and s.last_seen > now() - make_interval(secs => $6)
              and (s.kicked_until is null or s.kicked_until < now())
          )
          or exists (
            select 1 from space_members s
            where s.user_id = excluded.user_id and s.admitted_until > now()
          )
          or (
            select count(*)::int from space_listeners
            where last_seen > now() - make_interval(secs => $6)
          ) + (
            select count(*)::int from space_members m
            where m.in_room = true
              and m.user_id <> excluded.user_id
              and m.is_host = false
              and (m.admitted_until is null or m.admitted_until <= now())
              and m.last_seen > now() - make_interval(secs => $6)
              and (m.kicked_until is null or m.kicked_until < now())
          ) < $8
       returning user_id`,
      [
        context.userId,
        profile.displayName,
        profile.handle,
        profile.image,
        profile.isHost,
        PRESENCE_SECONDS,
        MAX_SEATS,
        MAX_LISTENERS,
      ],
    );
    if (!inserted[0]) return { status: "full" };
    await sql.query(
      `update space_members set
         admitted_until = null,
         speaker = false,
         mic_on = false,
         speak_requested = true
       where user_id = $1
         and is_host = false
         and admitted_until > now()
         and (
           select count(*)::int from space_members
           where in_room = true
             and is_host = false
             and admitted_until > now()
             and user_id <> $1
             and last_seen > now() - make_interval(secs => $2)
             and (kicked_until is null or kicked_until < now())
         ) >= $3`,
      [context.userId, PRESENCE_SECONDS, MAX_SPEAKERS],
    );
    return present(context.userId);
  });

export const syncSpace = createServerFn({ method: "POST" })
  .validator((micOn: unknown) => {
    if (typeof micOn !== "boolean") throw new Error("Bad mic");
    return micOn;
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data: micOn }): Promise<SpaceResult> => {
    const kicked = await kickState(context.userId);
    if (kicked) return kicked;
    const { prepareRoom } = await import("./snapshot.server");
    const sql = await prepareRoom();
    const updated = await sql.query<{ user_id: string }>(
      `update space_members as s set
         last_seen = now(),
         mic_on = case
           when s.forced_mute then false
           when not $2 then false
           when s.is_host then true
           when s.admitted_until > now() then true
           else false
         end,
         speaker = s.is_host or (s.admitted_until is not null and s.admitted_until > now())
       where s.user_id = $1
         and s.in_room = true
         and (s.kicked_until is null or s.kicked_until < now())
       returning s.user_id`,
      [context.userId, micOn],
    );
    if (!updated[0]) return { status: "left" };
    return present(context.userId);
  });

export const leaveSpace = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<{ ok: true }> => {
    const sql = await sqlClient();
    await sql.query(
      `update space_members
       set in_room = false, mic_on = false, speaker = is_host
       where user_id = $1`,
      [context.userId],
    );
    const { dropPeer } = await import("@/lib/multiplayer/signaling.server");
    await dropPeer(context.userId);
    return { ok: true };
  });

export const requestSpeak = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<SpaceResult> => {
    const { prepareRoom } = await import("./snapshot.server");
    const sql = await prepareRoom({ fresh: true });
    await sql.query(
      `update space_members set speak_requested = true
       where user_id = $1
         and in_room = true
         and is_host = false
         and (admitted_until is null or admitted_until <= now())`,
      [context.userId],
    );
    return present(context.userId);
  });

export const setRoomMuted = createServerFn({ method: "POST" })
  .validator((muted: unknown) => {
    if (typeof muted !== "boolean") throw new Error("Bad mute");
    return muted;
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data: muted }): Promise<SpaceResult> => {
    const profile = await loadProfile(context.userId);
    if (!profile?.isHost) return { status: "forbidden" };
    const sql = await sqlClient();
    await sql.query(
      `insert into space_state (id, room_muted) values ('open', $1)
       on conflict (id) do update set room_muted = excluded.room_muted`,
      [muted],
    );
    return present(context.userId);
  });

export const moderateMember = createServerFn({ method: "POST" })
  .validator((input: { userId: string; action: "mute" | "unmute" | "remove" | "admit" | "drop" }) => {
    const userId = input?.userId?.trim() ?? "";
    if (!userId || userId.length > 200) throw new Error("Bad member");
    if (
      input.action !== "mute" &&
      input.action !== "unmute" &&
      input.action !== "remove" &&
      input.action !== "admit" &&
      input.action !== "drop"
    ) {
      throw new Error("Bad action");
    }
    return { userId, action: input.action };
  })
  .middleware([authMiddleware])
  .handler(async ({ context, data }): Promise<SpaceResult> => {
    const profile = await loadProfile(context.userId);
    if (!profile?.isHost) return { status: "forbidden" };
    if (data.userId === context.userId) return { status: "forbidden" };
    const sql = await sqlClient();
    if (data.action === "remove") {
      const target = await sql.query<{ is_host: boolean }>(
        `select is_host from space_members where user_id = $1`,
        [data.userId],
      );
      if (target[0]?.is_host) return { status: "forbidden" };
      await sql.query(
        `update space_members set
           in_room = false,
           mic_on = false,
           speaker = false,
           forced_mute = false,
           speak_requested = false,
           admitted_until = null,
           kicked_until = now() + interval '2 minutes'
         where user_id = $1`,
        [data.userId],
      );
      const { dropPeer } = await import("@/lib/multiplayer/signaling.server");
      await dropPeer(data.userId);
    } else if (data.action === "mute") {
      await sql.query(
        `update space_members set forced_mute = true, mic_on = false
         where user_id = $1 and in_room = true and is_host = false`,
        [data.userId],
      );
    } else if (data.action === "drop") {
      await sql.query(
        `update space_members set
           admitted_until = null,
           speaker = false,
           mic_on = false,
           forced_mute = false,
           speak_requested = false
         where user_id = $1 and in_room = true and is_host = false`,
        [data.userId],
      );
    } else if (data.action === "admit") {
      await sql.query(
        `update space_members as s set
           admitted_until = now() + interval '24 hours',
           speak_requested = false,
           speaker = true,
           forced_mute = false
         where s.user_id = $1
           and s.in_room = true
           and s.is_host = false
           and (
             (s.admitted_until is not null and s.admitted_until > now())
             or (
               select count(*)::int from space_members
               where in_room = true
                 and is_host = false
                 and admitted_until > now()
                 and user_id <> $1
                 and last_seen > now() - make_interval(secs => $2)
                 and (kicked_until is null or kicked_until < now())
             ) < $3
           )`,
        [data.userId, PRESENCE_SECONDS, MAX_SPEAKERS],
      );
    } else {
      await sql.query(
        `update space_members set forced_mute = false
         where user_id = $1 and in_room = true and is_host = false`,
        [data.userId],
      );
    }
    return present(context.userId);
  });
