export const ROOM_ID = "open";
export const MAX_SEATS = 59;
export const MAX_SPEAKERS = 8;
export const MAX_LISTENERS = 50;
export const ADMIT_HOURS = 24;
export const PRESENCE_SECONDS = 35;
export const SPACE_TITLE = "Join @hovinthenorth’s Space";
export const SPACE_STATUS = "Not recorded";
export const SOURCE_URL = "https://github.com/hovtgc/open-space";

const PEER = /^[a-zA-Z0-9_-]{1,64}$/;

/** Signaling ids are a safe subset. Verified user ids pass through unchanged. */
export function toPeerId(userId: string): string {
  if (PEER.test(userId)) return userId;
  let hash = 2166136261;
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const suffix = (hash >>> 0).toString(36);
  const clean = userId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  const base = clean || "p";
  return `${base.slice(0, 63 - suffix.length)}_${suffix}`;
}
