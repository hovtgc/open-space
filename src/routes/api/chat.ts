import { createFileRoute } from "@tanstack/react-router";
import { addChat, chatForViewer } from "@/lib/space/chat.server";

const EAR_COOKIE = "space_ear";
const EAR_ID = /^ear_[a-f0-9]{32}$/;

function ear(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === EAR_COOKIE) {
      const value = decodeURIComponent(rest.join("="));
      return EAR_ID.test(value) ? value : null;
    }
  }
  return null;
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const peer = ear(request);
        const snapshot = await chatForViewer(peer ? `e:${peer}` : null);
        return new Response(JSON.stringify(snapshot), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
      POST: async ({ request }) => {
        const peer = ear(request);
        if (!peer) {
          return new Response(JSON.stringify({ error: "Join the room to chat." }), {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }
        let body = "";
        try {
          const payload = (await request.json()) as { body?: unknown };
          body = typeof payload.body === "string" ? payload.body : "";
        } catch {
          body = "";
        }
        const result = await addChat(`e:${peer}`, "Anonymous", "", body);
        if (result === "slow") {
          return new Response(JSON.stringify({ error: "Wait a second." }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        if (result !== "ok") {
          return new Response(JSON.stringify({ error: "Join the room to chat." }), {
            status: 403,
            headers: { "content-type": "application/json" },
          });
        }
        const snapshot = await chatForViewer(`e:${peer}`);
        return new Response(JSON.stringify(snapshot), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
