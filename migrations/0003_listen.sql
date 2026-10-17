create table if not exists space_state (
  id text primary key,
  room_muted boolean not null default false
);

insert into space_state (id, room_muted)
values ('open', false)
on conflict (id) do nothing;

create table if not exists space_listeners (
  peer_id text primary key,
  last_seen timestamptz not null default now()
);

create index if not exists space_listeners_seen_idx
  on space_listeners (last_seen);
