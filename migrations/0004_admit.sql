alter table space_members add column if not exists admitted_until timestamptz;
alter table space_members add column if not exists speak_requested boolean not null default false;
