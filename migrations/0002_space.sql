create table if not exists space_members (
  user_id text primary key,
  display_name text not null,
  handle text not null,
  image text,
  is_host boolean not null default false,
  speaker boolean not null default false,
  mic_on boolean not null default false,
  forced_mute boolean not null default false,
  in_room boolean not null default false,
  kicked_until timestamptz,
  last_seen timestamptz not null default now(),
  joined_at timestamptz not null default now()
);

create index if not exists space_members_live_idx
  on space_members (in_room, last_seen);
