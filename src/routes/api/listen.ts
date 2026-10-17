import { randomBytes } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { MAX_LISTENERS, PRESENCE_SECONDS } from "@/lib/space/constants";
import { claimEar, prepareRoom, readRoom } from "@/lib/space/snapshot.server";
import type { ListenSnapshot, Person } from "@/lib/space/types";

const EAR_COOKIE = "space_ear";
const EAR_ID = /^ear_[a-f0-9]{32}$/;

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function snapshot(
  status: ListenSnapshot["status"],
  peerId: string | null,
  room: Awaited<ReturnType<typeof readRoom>>,
): ListenSnapshot {
  const members: Person[] = room.members.map((member) => ({
    peerId: member.peerId,
    displayName: member.displayName,
    handle: member.handle,
    image: member.image,
    isHost: member.isHost,
    speaker: member.speaker,
    micOn: member.micOn,
    forcedMute: member.forcedMute,
    speakRequested: member.speakRequested,
    admittedUntil: member.admittedUntil,
  }));
  return {
    status,
    peerId,
    roomMuted: room.roomMuted,
    spotsUsed: room.spotsUsed,
    listenerCount: room.listenerCount,
    members,
    anonymous: room.anonymous,
  };
}

async function listen(request: Request, claim: boolean): Promise<Response> {
  const sql = await prepareRoom();
  const existing = cookieValue(request.headers.get("cookie"), EAR_COOKIE);
  const known = existing && EAR_ID.test(existing) ? existing : null;
  let peerId: string | null = null;
  let fresh = false;
  let locked = false;

  if (known) {
    const rows = await sql.query<{ peer_id: string }>(
      `update space_listeners set last_seen = now()
       where peer_id = $1
         and last_seen > now() - make_interval(secs => $2)
       returning peer_id`,
      [known, PRESENCE_SECONDS],
    );
    if (rows[0]) peerId = known;
  }

  if (claim && !peerId) {
    const next = `ear_${randomBytes(16).toString("hex")}`;
    const result = await claimEar(sql, next);
    if (result === "full") locked = true;
    else {
      peerId = next;
      fresh = true;
    }
  }

  const room = await readRoom();
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (fresh && peerId) {
    headers.set(
      "set-cookie",
      `${EAR_COOKIE}=${peerId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
    );
  }
  const status = locked || (!peerId && claim && room.listenerCount >= MAX_LISTENERS) ? "full" : "ok";
  return new Response(JSON.stringify(snapshot(status, peerId, room)), { headers });
}

async function release(request: Request): Promise<Response> {
  const sql = await prepareRoom();
  const existing = cookieValue(request.headers.get("cookie"), EAR_COOKIE);
  if (existing && EAR_ID.test(existing)) {
    await sql.query(`delete from space_listeners where peer_id = $1`, [existing]);
    try {
      await sql.query(`delete from webrtc_peers where peer_id = $1`, [existing]);
    } catch {
      /* signaling table is created on the first audio poll */
    }
  }
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  headers.set("set-cookie", `${EAR_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return new Response(JSON.stringify({ ok: true }), { headers });
}

export const Route = createFileRoute("/api/listen")({
  server: {
    handlers: {
      GET: async ({ request }) => listen(request, false),
      POST: async ({ request }) => listen(request, true),
      DELETE: async ({ request }) => release(request),
    },
  },
});
