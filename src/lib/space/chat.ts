import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

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

export const loadChat = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<ChatSnapshot> => {
    const { chatForViewer } = await import("./chat.server");
    return chatForViewer(`u:${context.userId}`);
  });

export const sendChat = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((body: unknown) => {
    if (typeof body !== "string") throw new Error("Bad message");
    return body.slice(0, 240);
  })
  .handler(async ({ context, data }): Promise<ChatSnapshot> => {
    const { addChat, chatForViewer } = await import("./chat.server");
    const { cleanName, isRoomHost, publicHandle } = await import("./identity");
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    const rows = await sql.query<{ name: string; email: string }>(
      `select "name", "email" from "user" where "id" = $1`,
      [context.userId],
    );
    const row = rows[0];
    const name = cleanName(row?.name ?? "Listener");
    const host = row ? isRoomHost({ name: row.name, email: row.email }) : false;
    const handle = host ? "hovinthenorth" : publicHandle(name);
    const result = await addChat(`u:${context.userId}`, name, handle, data);
    if (result === "slow") throw new Error("Wait a second.");
    if (result === "closed") throw new Error("Join the room to chat.");
    return chatForViewer(`u:${context.userId}`);
  });

async function requireHost(userId: string): Promise<void> {
  const { isRoomHost } = await import("./identity");
  const { getSql } = await import("@/lib/db");
  const sql = await getSql();
  const rows = await sql.query<{ name: string; email: string }>(
    `select "name", "email" from "user" where "id" = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row || !isRoomHost({ name: row.name, email: row.email })) {
    throw new Error("Only the host can edit the playlist.");
  }
}

export const addTrack = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((url: unknown) => {
    if (typeof url !== "string" || url.length > 500) throw new Error("Bad link");
    return url;
  })
  .handler(async ({ context, data }): Promise<ChatSnapshot> => {
    await requireHost(context.userId);
    const { addPlaylistTrack, chatForViewer } = await import("./chat.server");
    const result = await addPlaylistTrack(data);
    if (result === "bad") throw new Error("Paste a Suno song link.");
    if (result === "full") throw new Error("The playlist is full.");
    return chatForViewer(`u:${context.userId}`);
  });

export const removeTrack = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((id: unknown) => {
    const n = typeof id === "number" ? id : Number(id);
    if (!Number.isInteger(n) || n < 1) throw new Error("Bad track");
    return n;
  })
  .handler(async ({ context, data }): Promise<ChatSnapshot> => {
    await requireHost(context.userId);
    const { removePlaylistTrack, chatForViewer } = await import("./chat.server");
    await removePlaylistTrack(data);
    return chatForViewer(`u:${context.userId}`);
  });
