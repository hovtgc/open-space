import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { MAX_SEATS, PRESENCE_SECONDS } from "@/lib/space/constants";

export const Route = createFileRoute("/api/room-count")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const sql = await getSql();
          const rows = await sql.query<{ n: number }>(
            `select count(*)::int as n from space_members
             where in_room = true
               and last_seen > now() - make_interval(secs => $1)
               and (kicked_until is null or kicked_until < now())`,
            [PRESENCE_SECONDS],
          );
          const count = Math.min(MAX_SEATS, rows[0]?.n ?? 0);
          return Response.json({ count });
        } catch (error) {
          console.error("[room-count]", error);
          return Response.json({ count: 0 });
        }
      },
    },
  },
});
