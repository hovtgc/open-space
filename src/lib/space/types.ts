export type Person = {
  peerId: string;
  displayName: string;
  handle: string;
  image: string | null;
  isHost: boolean;
  speaker: boolean;
  micOn: boolean;
  forcedMute: boolean;
  speakRequested: boolean;
  admittedUntil: string | null;
};

export type Member = Person & { userId: string };

export type AnonymousListener = { peerId: string };

export type SpaceOk = {
  status: "ok";
  self: Member;
  members: Member[];
  anonymous: AnonymousListener[];
  roomMuted: boolean;
  spotsUsed: number;
  listenerCount: number;
};
export type SpaceKicked = { status: "kicked"; until: string };
export type SpaceFull = { status: "full" };
export type SpaceLeft = { status: "left" };
export type SpaceForbidden = { status: "forbidden" };
export type SpaceResult = SpaceOk | SpaceKicked | SpaceFull | SpaceLeft | SpaceForbidden;

export type ListenSnapshot = {
  status: "ok" | "full";
  peerId: string | null;
  roomMuted: boolean;
  spotsUsed: number;
  listenerCount: number;
  members: Person[];
  anonymous: AnonymousListener[];
};
