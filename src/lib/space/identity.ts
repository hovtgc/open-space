/** Host is @hovinthenorth — handle, verified display name, or that X login. */
export function isRoomHost(input: { name: string | null; email: string | null }): boolean {
  const name = (input.name ?? "").trim().toLowerCase().replace(/^@/, "");
  const compact = name.replace(/\s+/g, " ");
  const squish = compact.replace(/\s+/g, "");
  if (squish === "hovinthenorth" || compact === "hovinthenorth") return true;
  if (compact === "hovhannes mkhitaryan") return true;
  const email = (input.email ?? "").toLowerCase();
  const local = email.split("@")[0]?.replace(/[^a-z0-9_]/g, "") ?? "";
  return local === "hovinthenorth" || email.includes("hovinthenorth");
}

export function cleanName(name: string | null): string {
  const cleaned = (name ?? "").replace(/[\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 64) || "Listener";
}

export function publicHandle(name: string): string {
  if (/^[A-Za-z0-9_]{2,20}$/.test(name)) return name.toLowerCase();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16);
  return slug.length >= 2 ? slug : "guest";
}

export function safeImage(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return sharperImage(parsed.toString());
  } catch {
    return null;
  }
}

const HANDLE = /^[A-Za-z0-9_]{2,20}$/;

/** X serves a tiny `_normal` crop. Ask for the larger one when the URL allows it. */
export function sharperImage(url: string): string {
  return url.replace(/_(normal|bigger|mini|reasonably_small)(?=\.[a-z]+(?:$|\?))/, "_400x400");
}

/** Login photo when we have one, otherwise the public X avatar for that handle. */
export function portraitSrc(image: string | null, handle: string): string | null {
  if (image) {
    try {
      const parsed = new URL(image);
      if (parsed.protocol === "https:") return sharperImage(parsed.toString());
    } catch {
      /* not a url */
    }
  }
  const name = handle.trim().replace(/^@/, "");
  if (!HANDLE.test(name)) return null;
  return `/api/avatar?h=${encodeURIComponent(name.toLowerCase())}`;
}
