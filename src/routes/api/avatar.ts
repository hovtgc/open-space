import { createFileRoute } from "@tanstack/react-router";

const HANDLE = /^[a-z0-9_]{2,20}$/;

export const Route = createFileRoute("/api/avatar")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const handle = new URL(request.url).searchParams.get("h")?.trim().toLowerCase() ?? "";
        if (!HANDLE.test(handle)) return new Response(null, { status: 400 });
        let upstream: Response;
        try {
          upstream = await fetch(`https://unavatar.io/x/${handle}?fallback=false`, {
            redirect: "follow",
            headers: { "user-agent": "open-space" },
          });
        } catch {
          return new Response(null, { status: 404 });
        }
        if (!upstream.ok) return new Response(null, { status: 404 });
        const type = (upstream.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
        if (!type.startsWith("image/")) return new Response(null, { status: 404 });
        const bytes = await upstream.arrayBuffer();
        if (bytes.byteLength < 32 || bytes.byteLength > 1_500_000) return new Response(null, { status: 404 });
        return new Response(bytes, {
          headers: {
            "content-type": type,
            "cache-control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
