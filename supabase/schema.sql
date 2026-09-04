-- ============================================================================
-- WISP — complete schema. Safe to run top-to-bottom, once, in the Supabase
-- SQL editor. Re-running is safe (idempotent) except that it will not destroy
-- existing rows.
-- ============================================================================

create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

-- ============================================================================
-- 1. ENUMS
-- ============================================================================
do $$ begin
  create type visibility as enum ('everyone','contacts','nobody');
exception when duplicate_object then null; end $$;

do $$ begin
  create type chat_type as enum ('dm','group','broadcast');
exception when duplicate_object then null; end $$;

do $$ begin
  create type member_role as enum ('owner','admin','member');
exception when duplicate_object then null; end $$;

do $$ begin
  create type msg_kind as enum
    ('text','image','video','audio','voice','document','sticker','location','contact','poll','system','call');
exception when duplicate_object then null; end $$;

do $$ begin
  create type perm_scope as enum ('everyone','admins');
exception when duplicate_object then null; end $$;

do $$ begin
  create type call_kind as enum ('audio','video');
exception when duplicate_object then null; end $$;

do $$ begin
  create type call_state as enum ('ringing','accepted','declined','missed','ended','failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type notif_preview as enum ('full','sender_only','hidden');
exception when duplicate_object then null; end $$;

-- ============================================================================
-- 2. TABLES
-- ============================================================================

create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text not null default 'New user',
  photo_url    text,
  about        text default 'Hey there, I am using Wisp.',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists profiles_name_idx on profiles using gin (to_tsvector('simple', display_name));
create index if not exists profiles_email_idx on profiles (lower(email));

create table if not exists user_settings (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  -- appearance
  theme_mode          text not null default 'system',       -- light | dark | system
  accent              text not null default 'clay',
  custom_accent       text,                                 -- oklch/hex string from the picker
  font_family         text not null default 'sans',
  density             text not null default 'comfortable',   -- compact|comfortable|spacious
  text_scale          numeric not null default 1.0,
  bubble_radius       int not null default 16,
  wallpaper_url       text,
  wallpaper_opacity   numeric not null default 1.0,
  wallpaper_blur      int not null default 0,
  -- accessibility
  reduce_motion       boolean not null default false,
  high_contrast       boolean not null default false,
  animation_speed     numeric not null default 1.0,
  -- privacy
  read_receipts       boolean not null default true,
  last_seen_vis       visibility not null default 'everyone',
  online_vis          visibility not null default 'everyone',
  photo_vis           visibility not null default 'everyone',
  about_vis           visibility not null default 'everyone',
  -- behaviour
  focus_mode          boolean not null default false,
  quiet_from          time,
  quiet_to            time,
  default_disappear   int not null default 0,                -- seconds, 0 = off
  notif_preview       notif_preview not null default 'full',
  notif_sound         text not null default 'chime',
  media_limit_mb      int not null default 64,
  two_step_pin        text,                                 -- bcrypt hash
  updated_at          timestamptz not null default now()
);

create table if not exists presence (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  is_online boolean not null default false,
  last_seen timestamptz not null default now()
);

create table if not exists devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  token       text not null,
  platform    text not null default 'web',
  label       text,
  last_active timestamptz not null default now(),
  unique (user_id, token)
);

create table if not exists contacts (
  user_id     uuid not null references auth.users(id) on delete cascade,
  contact_id  uuid not null references auth.users(id) on delete cascade,
  nickname    text,
  accent      text,
  favorite    boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (user_id, contact_id)
);

create table if not exists blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

create table if not exists reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  message_id  uuid,
  reason      text not null,
  created_at  timestamptz not null default now()
);

create table if not exists folders (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references auth.users(id) on delete cascade,
  name     text not null,
  position int not null default 0,
  rule     text                                   -- null = manual, or 'unread'
);

create table if not exists chats (
  id                 uuid primary key default gen_random_uuid(),
  type               chat_type not null default 'dm',
  name               text,
  icon_url           text,
  description        text,
  created_by         uuid references auth.users(id) on delete set null,
  invite_code        text unique default encode(gen_random_bytes(9),'base64'),
  e2ee               boolean not null default false,
  disappear_seconds  int not null default 0,
  perm_edit_info     perm_scope not null default 'admins',
  perm_send          perm_scope not null default 'everyone',
  perm_add_members   perm_scope not null default 'admins',
  created_at         timestamptz not null default now(),
  last_message_at    timestamptz not null default now()
);

create table if not exists chat_members (
  chat_id       uuid not null references chats(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          member_role not null default 'member',
  joined_at     timestamptz not null default now(),
  pinned        boolean not null default false,
  archived      boolean not null default false,
  muted_until   timestamptz,
  mute_forever  boolean not null default false,
  notify_level  text not null default 'all',      -- all | mentions | none
  wallpaper_url text,
  folder_id     uuid references folders(id) on delete set null,
  last_read_at  timestamptz not null default 'epoch',
  cleared_at    timestamptz not null default 'epoch',
  locked        boolean not null default false,
  lock_pin      text,
  left_at       timestamptz,
  primary key (chat_id, user_id)
);
create index if not exists chat_members_user_idx on chat_members (user_id);

create table if not exists messages (
  id            uuid primary key default gen_random_uuid(),
  chat_id       uuid not null references chats(id) on delete cascade,
  sender_id     uuid references auth.users(id) on delete set null,
  kind          msg_kind not null default 'text',
  body          text,                             -- plaintext (null when e2ee)
  cipher        text,                             -- base64 AES-GCM payload
  iv            text,
  attachment    jsonb,                            -- {path,name,mime,size,w,h,duration,waveform,thumb}
  meta          jsonb,                            -- kind-specific extras
  reply_to      uuid references messages(id) on delete set null,
  forwarded_from uuid,
  client_id     text,
  view_once     boolean not null default false,
  edited_at     timestamptz,
  deleted_all   boolean not null default false,
  pinned_at     timestamptz,
  pinned_by     uuid references auth.users(id) on delete set null,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  search_tsv    tsvector generated always as (to_tsvector('english', coalesce(body,''))) stored
);
create index if not exists messages_chat_created_idx on messages (chat_id, created_at desc);
create index if not exists messages_search_idx on messages using gin (search_tsv);
create index if not exists messages_expiry_idx on messages (expires_at) where expires_at is not null;
create unique index if not exists messages_client_idx on messages (sender_id, client_id) where client_id is not null;

create table if not exists message_hides (            -- delete-for-me
  message_id uuid not null references messages(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  primary key (message_id, user_id)
);

create table if not exists message_status (
  message_id   uuid not null references messages(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  delivered_at timestamptz,
  read_at      timestamptz,
  primary key (message_id, user_id)
);
create index if not exists message_status_user_idx on message_status (user_id) where read_at is null;

create table if not exists reactions (
  message_id uuid not null references messages(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create table if not exists stars (
  message_id uuid not null references messages(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  primary key (message_id, user_id)
);

create table if not exists bookmarks (
  message_id uuid not null references messages(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create table if not exists mentions (
  message_id uuid not null references messages(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  primary key (message_id, user_id)
);

create table if not exists typing (
  chat_id    uuid not null references chats(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (chat_id, user_id)
);

create table if not exists scheduled_messages (
  id         uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references chats(id) on delete cascade,
  sender_id  uuid not null references auth.users(id) on delete cascade,
  kind       msg_kind not null default 'text',
  body       text,
  attachment jsonb,
  send_at    timestamptz not null,
  recurrence text,                                  -- null | daily | weekly | weekdays
  status     text not null default 'pending',       -- pending | sent | cancelled
  created_at timestamptz not null default now()
);
create index if not exists scheduled_due_idx on scheduled_messages (send_at) where status = 'pending';

create table if not exists polls (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) on delete cascade,
  question   text not null,
  multi      boolean not null default false,
  closed     boolean not null default false
);
create table if not exists poll_options (
  id      uuid primary key default gen_random_uuid(),
  poll_id uuid not null references polls(id) on delete cascade,
  label   text not null,
  position int not null default 0
);
create table if not exists poll_votes (
  option_id uuid not null references poll_options(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  poll_id   uuid not null references polls(id) on delete cascade,
  primary key (option_id, user_id)
);

create table if not exists live_locations (
  message_id uuid primary key references messages(id) on delete cascade,
  lat        double precision not null,
  lng        double precision not null,
  live       boolean not null default false,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists link_previews (
  url         text primary key,
  title       text,
  description text,
  image       text,
  site        text,
  fetched_at  timestamptz not null default now()
);

create table if not exists calls (
  id         uuid primary key default gen_random_uuid(),
  chat_id    uuid not null references chats(id) on delete cascade,
  caller_id  uuid not null references auth.users(id) on delete cascade,
  kind       call_kind not null default 'audio',
  state      call_state not null default 'ringing',
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at   timestamptz,
  duration   int not null default 0
);
create index if not exists calls_chat_idx on calls (chat_id, started_at desc);

create table if not exists call_signals (
  id         bigserial primary key,
  call_id    uuid not null references calls(id) on delete cascade,
  sender_id  uuid not null references auth.users(id) on delete cascade,
  target_id  uuid references auth.users(id) on delete cascade,
  payload    jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists call_signals_call_idx on call_signals (call_id, id);

-- End-to-end encryption key material.
-- public_jwk is public. private_jwk is wrapped client-side with a key derived
-- from the account password (PBKDF2) and is opaque to the server.
create table if not exists user_keys (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  public_jwk  jsonb not null,
  private_wrapped text not null,
  kdf_salt    text not null,
  kdf_iv      text not null,
  created_at  timestamptz not null default now()
);

create table if not exists chat_keys (
  chat_id     uuid not null references chats(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  wrapped_key text not null,                       -- chat AES key, RSA-OAEP wrapped
  primary key (chat_id, user_id)
);

create table if not exists rate_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  at      timestamptz not null default now()
);
create index if not exists rate_events_idx on rate_events (user_id, at desc);

-- ============================================================================
-- 3. HELPERS (security definer, bypass RLS deliberately)
-- ============================================================================

create or replace function is_member(p_chat uuid, p_user uuid default auth.uid())
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from chat_members m
                 where m.chat_id = p_chat and m.user_id = p_user and m.left_at is null);
$$;

create or replace function is_admin(p_chat uuid, p_user uuid default auth.uid())
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from chat_members m
                 where m.chat_id = p_chat and m.user_id = p_user
                   and m.role in ('owner','admin') and m.left_at is null);
$$;

create or replace function blocked_between(a uuid, b uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from blocks
                 where (blocker_id = a and blocked_id = b)
                    or (blocker_id = b and blocked_id = a));
$$;

-- true when the chat is a DM and either side has blocked the other
create or replace function dm_blocked(p_chat uuid, p_sender uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from chats c
    join chat_members m on m.chat_id = c.id and m.user_id <> p_sender
    where c.id = p_chat and c.type = 'dm' and blocked_between(p_sender, m.user_id)
  );
$$;

create or replace function can_send(p_chat uuid, p_user uuid default auth.uid())
returns boolean language sql security definer stable set search_path = public as $$
  select is_member(p_chat, p_user)
     and not dm_blocked(p_chat, p_user)
     and (select case when c.perm_send = 'everyone' then true else is_admin(p_chat, p_user) end
          from chats c where c.id = p_chat);
$$;

create or replace function shares_chat(a uuid, b uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from chat_members x join chat_members y on x.chat_id = y.chat_id
                 where x.user_id = a and y.user_id = b);
$$;

-- privacy resolution used by presence / profile field visibility
create or replace function field_visible(p_owner uuid, p_viewer uuid, p_vis visibility)
returns boolean language sql security definer stable set search_path = public as $$
  select case
    when p_owner = p_viewer then true
    when blocked_between(p_owner, p_viewer) then false
    when p_vis = 'everyone' then true
    when p_vis = 'nobody' then false
    else exists (select 1 from contacts where user_id = p_owner and contact_id = p_viewer)
  end;
$$;

-- ============================================================================
-- 4. TRIGGERS
-- ============================================================================

-- new auth user -> profile + settings + presence
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1)))
  on conflict (id) do nothing;
  insert into user_settings (user_id) values (new.id) on conflict do nothing;
  insert into presence (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function handle_new_user();

-- server-side rate limit: 25 messages / 10s, 300 / hour
create or replace function enforce_rate_limit()
returns trigger language plpgsql security definer set search_path = public as $$
declare burst int; hourly int;
begin
  if new.sender_id is null then return new; end if;
  delete from rate_events where user_id = new.sender_id and at < now() - interval '1 hour';
  select count(*) into burst  from rate_events where user_id = new.sender_id and at > now() - interval '10 seconds';
  select count(*) into hourly from rate_events where user_id = new.sender_id and at > now() - interval '1 hour';
  if burst >= 25 then raise exception 'rate_limit: slow down (25 messages / 10s)'; end if;
  if hourly >= 300 then raise exception 'rate_limit: hourly cap reached'; end if;
  insert into rate_events (user_id) values (new.sender_id);
  return new;
end $$;

drop trigger if exists messages_rate_limit on messages;
create trigger messages_rate_limit before insert on messages
for each row execute function enforce_rate_limit();

-- disappearing messages + chat ordering + delivery rows + mention rows
create or replace function after_message_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare secs int; uid uuid; handle text;
begin
  select disappear_seconds into secs from chats where id = new.chat_id;
  if coalesce(secs,0) > 0 and new.expires_at is null then
    update messages set expires_at = new.created_at + make_interval(secs => secs) where id = new.id;
  end if;

  update chats set last_message_at = new.created_at where id = new.chat_id;

  insert into message_status (message_id, user_id)
  select new.id, m.user_id from chat_members m
  where m.chat_id = new.chat_id and m.user_id <> coalesce(new.sender_id, m.user_id) and m.left_at is null
  on conflict do nothing;

  -- unarchive + surface the chat for everyone when a new message lands
  update chat_members set archived = false where chat_id = new.chat_id and archived = true;

  if new.body is not null and new.body like '%@%' then
    for handle in select distinct substring(w from 2) from regexp_split_to_table(new.body, '\s+') w where w like '@%' loop
      for uid in select p.id from profiles p join chat_members m on m.user_id = p.id
                 where m.chat_id = new.chat_id and lower(replace(p.display_name,' ','')) = lower(handle) loop
        insert into mentions (message_id, user_id) values (new.id, uid) on conflict do nothing;
      end loop;
    end loop;
  end if;
  return null;
end $$;

drop trigger if exists messages_after_insert on messages;
create trigger messages_after_insert after insert on messages
for each row execute function after_message_insert();

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists profiles_touch on profiles;
create trigger profiles_touch before update on profiles
for each row execute function touch_updated_at();
drop trigger if exists settings_touch on user_settings;
create trigger settings_touch before update on user_settings
for each row execute function touch_updated_at();

-- ============================================================================
-- 5. RLS
-- ============================================================================
alter table profiles          enable row level security;
alter table user_settings     enable row level security;
alter table presence          enable row level security;
alter table devices           enable row level security;
alter table contacts          enable row level security;
alter table blocks            enable row level security;
alter table reports           enable row level security;
alter table folders           enable row level security;
alter table chats             enable row level security;
alter table chat_members      enable row level security;
alter table messages          enable row level security;
alter table message_hides     enable row level security;
alter table message_status    enable row level security;
alter table reactions         enable row level security;
alter table stars             enable row level security;
alter table bookmarks         enable row level security;
alter table mentions          enable row level security;
alter table typing            enable row level security;
alter table scheduled_messages enable row level security;
alter table polls             enable row level security;
alter table poll_options      enable row level security;
alter table poll_votes        enable row level security;
alter table live_locations    enable row level security;
alter table link_previews     enable row level security;
alter table calls             enable row level security;
alter table call_signals      enable row level security;
alter table user_keys         enable row level security;
alter table chat_keys         enable row level security;
alter table rate_events       enable row level security;

-- profiles: readable by anyone signed in (needed for people search); the
-- privacy-gated fields (photo/about/presence) are filtered by RPCs below.
drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select to authenticated
  using (not blocked_between(id, auth.uid()));
drop policy if exists profiles_write on profiles;
create policy profiles_write on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists settings_all on user_settings;
create policy settings_all on user_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists presence_self on presence;
create policy presence_self on presence for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists presence_read on presence;
create policy presence_read on presence for select to authenticated
  using (user_id = auth.uid() or shares_chat(user_id, auth.uid()));

drop policy if exists devices_all on devices;
create policy devices_all on devices for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists contacts_all on contacts;
create policy contacts_all on contacts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists blocks_all on blocks;
create policy blocks_all on blocks for all to authenticated
  using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());

drop policy if exists reports_insert on reports;
create policy reports_insert on reports for insert to authenticated
  with check (reporter_id = auth.uid());
drop policy if exists reports_read on reports;
create policy reports_read on reports for select to authenticated
  using (reporter_id = auth.uid());

drop policy if exists folders_all on folders;
create policy folders_all on folders for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists chats_read on chats;
create policy chats_read on chats for select to authenticated
  using (is_member(id));
drop policy if exists chats_insert on chats;
create policy chats_insert on chats for insert to authenticated
  with check (created_by = auth.uid());
drop policy if exists chats_update on chats;
create policy chats_update on chats for update to authenticated
  using (case when perm_edit_info = 'everyone' then is_member(id) else is_admin(id) end)
  with check (is_member(id));

drop policy if exists members_read on chat_members;
create policy members_read on chat_members for select to authenticated
  using (user_id = auth.uid() or is_member(chat_id));
drop policy if exists members_insert on chat_members;
create policy members_insert on chat_members for insert to authenticated
  with check (
    user_id = auth.uid()                                        -- joining yourself
    or (case when (select perm_add_members from chats c where c.id = chat_id) = 'everyone'
             then is_member(chat_id) else is_admin(chat_id) end)
  );
drop policy if exists members_update on chat_members;
create policy members_update on chat_members for update to authenticated
  using (user_id = auth.uid() or is_admin(chat_id));
drop policy if exists members_delete on chat_members;
create policy members_delete on chat_members for delete to authenticated
  using (user_id = auth.uid() or is_admin(chat_id));

-- messages: members only, hidden once expired, hidden when delete-for-me,
-- and hidden before cleared_at
drop policy if exists messages_read on messages;
create policy messages_read on messages for select to authenticated
  using (
    is_member(chat_id)
    and (expires_at is null or expires_at > now())
    and not exists (select 1 from message_hides h where h.message_id = id and h.user_id = auth.uid())
    and created_at >= coalesce((select cleared_at from chat_members m
                                where m.chat_id = messages.chat_id and m.user_id = auth.uid()), 'epoch')
  );
drop policy if exists messages_insert on messages;
create policy messages_insert on messages for insert to authenticated
  with check (sender_id = auth.uid() and can_send(chat_id));
-- own messages only (edit window and delete-for-everyone are enforced in the
-- RPCs below); pinning and view-once receipts run through security-definer
-- functions so a member cannot rewrite someone else's body
drop policy if exists messages_update on messages;
create policy messages_update on messages for update to authenticated
  using (sender_id = auth.uid() or is_admin(chat_id))
  with check (sender_id = auth.uid() or is_admin(chat_id));

drop policy if exists hides_all on message_hides;
create policy hides_all on message_hides for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists status_read on message_status;
create policy status_read on message_status for select to authenticated
  using (user_id = auth.uid()
         or exists (select 1 from messages m where m.id = message_id and m.sender_id = auth.uid()));
drop policy if exists status_write on message_status;
create policy status_write on message_status for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists reactions_read on reactions;
create policy reactions_read on reactions for select to authenticated
  using (exists (select 1 from messages m where m.id = message_id and is_member(m.chat_id)));
drop policy if exists reactions_write on reactions;
create policy reactions_write on reactions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists stars_all on stars;
create policy stars_all on stars for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists bookmarks_all on bookmarks;
create policy bookmarks_all on bookmarks for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists mentions_read on mentions;
create policy mentions_read on mentions for select to authenticated
  using (user_id = auth.uid());

drop policy if exists typing_read on typing;
create policy typing_read on typing for select to authenticated using (is_member(chat_id));
drop policy if exists typing_write on typing;
create policy typing_write on typing for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and is_member(chat_id));

-- scheduled messages are visible ONLY to their author, and never to the
-- recipient, until the dispatcher turns them into real messages
drop policy if exists sched_all on scheduled_messages;
create policy sched_all on scheduled_messages for all to authenticated
  using (sender_id = auth.uid()) with check (sender_id = auth.uid() and can_send(chat_id));

drop policy if exists polls_read on polls;
create policy polls_read on polls for select to authenticated
  using (exists (select 1 from messages m where m.id = message_id and is_member(m.chat_id)));
drop policy if exists polls_write on polls;
create policy polls_write on polls for all to authenticated
  using (exists (select 1 from messages m where m.id = message_id and m.sender_id = auth.uid()))
  with check (exists (select 1 from messages m where m.id = message_id and m.sender_id = auth.uid()));
drop policy if exists poll_options_read on poll_options;
create policy poll_options_read on poll_options for select to authenticated
  using (exists (select 1 from polls p join messages m on m.id = p.message_id
                 where p.id = poll_id and is_member(m.chat_id)));
drop policy if exists poll_options_write on poll_options;
create policy poll_options_write on poll_options for all to authenticated
  using (exists (select 1 from polls p join messages m on m.id = p.message_id
                 where p.id = poll_id and m.sender_id = auth.uid()))
  with check (exists (select 1 from polls p join messages m on m.id = p.message_id
                 where p.id = poll_id and m.sender_id = auth.uid()));
drop policy if exists poll_votes_read on poll_votes;
create policy poll_votes_read on poll_votes for select to authenticated
  using (exists (select 1 from polls p join messages m on m.id = p.message_id
                 where p.id = poll_id and is_member(m.chat_id)));
drop policy if exists poll_votes_write on poll_votes;
create policy poll_votes_write on poll_votes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists loc_read on live_locations;
create policy loc_read on live_locations for select to authenticated
  using (exists (select 1 from messages m where m.id = message_id and is_member(m.chat_id)));
drop policy if exists loc_write on live_locations;
create policy loc_write on live_locations for all to authenticated
  using (exists (select 1 from messages m where m.id = message_id and m.sender_id = auth.uid()))
  with check (exists (select 1 from messages m where m.id = message_id and m.sender_id = auth.uid()));

drop policy if exists previews_read on link_previews;
create policy previews_read on link_previews for select to authenticated using (true);

drop policy if exists calls_read on calls;
create policy calls_read on calls for select to authenticated using (is_member(chat_id));
drop policy if exists calls_insert on calls;
create policy calls_insert on calls for insert to authenticated
  with check (caller_id = auth.uid() and can_send(chat_id));
drop policy if exists calls_update on calls;
create policy calls_update on calls for update to authenticated using (is_member(chat_id));

drop policy if exists signals_read on call_signals;
create policy signals_read on call_signals for select to authenticated
  using (exists (select 1 from calls c where c.id = call_id and is_member(c.chat_id))
         and (target_id is null or target_id = auth.uid() or sender_id = auth.uid()));
drop policy if exists signals_insert on call_signals;
create policy signals_insert on call_signals for insert to authenticated
  with check (sender_id = auth.uid()
              and exists (select 1 from calls c where c.id = call_id and is_member(c.chat_id)));

drop policy if exists keys_read on user_keys;
create policy keys_read on user_keys for select to authenticated using (true);
drop policy if exists keys_write on user_keys;
create policy keys_write on user_keys for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists chat_keys_read on chat_keys;
create policy chat_keys_read on chat_keys for select to authenticated
  using (user_id = auth.uid());
drop policy if exists chat_keys_write on chat_keys;
create policy chat_keys_write on chat_keys for insert to authenticated
  with check (is_member(chat_id));

drop policy if exists rate_none on rate_events;
create policy rate_none on rate_events for select to authenticated using (user_id = auth.uid());

-- ============================================================================
-- 6. RPCs
-- ============================================================================

-- one canonical DM per pair
create or replace function get_or_create_dm(p_other uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid; me uuid := auth.uid(); secs int;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if me = p_other then raise exception 'cannot DM yourself'; end if;
  if blocked_between(me, p_other) then raise exception 'blocked'; end if;

  select c.id into cid from chats c
    join chat_members a on a.chat_id = c.id and a.user_id = me
    join chat_members b on b.chat_id = c.id and b.user_id = p_other
   where c.type = 'dm' limit 1;
  if cid is not null then
    update chat_members set left_at = null where chat_id = cid and user_id in (me, p_other);
    return cid;
  end if;

  select default_disappear into secs from user_settings where user_id = me;
  insert into chats (type, created_by, disappear_seconds) values ('dm', me, coalesce(secs,0)) returning id into cid;
  insert into chat_members (chat_id, user_id, role) values (cid, me, 'owner'), (cid, p_other, 'member');
  return cid;
end $$;

create or replace function create_group(p_name text, p_members uuid[], p_type chat_type default 'group',
                                        p_icon text default null, p_desc text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid; me uuid := auth.uid(); u uuid;
begin
  if me is null then raise exception 'not authenticated'; end if;
  insert into chats (type, name, icon_url, description, created_by)
  values (p_type, p_name, p_icon, p_desc, me) returning id into cid;
  insert into chat_members (chat_id, user_id, role) values (cid, me, 'owner');
  foreach u in array coalesce(p_members, '{}'::uuid[]) loop
    if u <> me and not blocked_between(me, u) then
      insert into chat_members (chat_id, user_id) values (cid, u) on conflict do nothing;
    end if;
  end loop;
  insert into messages (chat_id, sender_id, kind, body)
  values (cid, me, 'system', (select display_name from profiles where id = me) || ' created this group');
  return cid;
end $$;

create or replace function join_via_invite(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid; me uuid := auth.uid();
begin
  select id into cid from chats where invite_code = p_code and type = 'group';
  if cid is null then raise exception 'invalid invite'; end if;
  insert into chat_members (chat_id, user_id) values (cid, me)
    on conflict (chat_id, user_id) do update set left_at = null;
  insert into messages (chat_id, sender_id, kind, body)
  values (cid, me, 'system', (select display_name from profiles where id = me) || ' joined via invite link');
  return cid;
end $$;

create or replace function reset_invite(p_chat uuid)
returns text language plpgsql security definer set search_path = public as $$
declare code text;
begin
  if not is_admin(p_chat) then raise exception 'admins only'; end if;
  code := encode(gen_random_bytes(9),'base64');
  update chats set invite_code = code where id = p_chat;
  return code;
end $$;

create or replace function leave_chat(p_chat uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  insert into messages (chat_id, sender_id, kind, body)
  values (p_chat, me, 'system', (select display_name from profiles where id = me) || ' left');
  delete from chat_members where chat_id = p_chat and user_id = me;
end $$;

create or replace function remove_member(p_chat uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(p_chat) then raise exception 'admins only'; end if;
  delete from chat_members where chat_id = p_chat and user_id = p_user;
  insert into messages (chat_id, sender_id, kind, body)
  values (p_chat, auth.uid(), 'system',
          (select display_name from profiles where id = p_user) || ' was removed');
end $$;

create or replace function set_member_role(p_chat uuid, p_user uuid, p_role member_role)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin(p_chat) then raise exception 'admins only'; end if;
  update chat_members set role = p_role where chat_id = p_chat and user_id = p_user;
end $$;

-- delivery + read receipts, honouring the sender-side read-receipt toggle
create or replace function mark_delivered(p_chat uuid)
returns void language sql security definer set search_path = public as $$
  update message_status s set delivered_at = now()
  from messages m
  where s.message_id = m.id and m.chat_id = p_chat
    and s.user_id = auth.uid() and s.delivered_at is null;
$$;

create or replace function mark_read(p_chat uuid)
returns void language plpgsql security definer set search_path = public as $$
declare send_receipts boolean;
begin
  select read_receipts into send_receipts from user_settings where user_id = auth.uid();
  update chat_members set last_read_at = now() where chat_id = p_chat and user_id = auth.uid();
  update message_status s set delivered_at = coalesce(s.delivered_at, now()),
                             read_at = case when coalesce(send_receipts,true) then now() else s.read_at end
  from messages m
  where s.message_id = m.id and m.chat_id = p_chat and s.user_id = auth.uid() and s.read_at is null;
end $$;

create or replace function edit_message(p_message uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare m messages;
begin
  select * into m from messages where id = p_message;
  if m.sender_id <> auth.uid() then raise exception 'not your message'; end if;
  if m.created_at < now() - interval '15 minutes' then raise exception 'edit window (15 min) has passed'; end if;
  update messages set body = p_body, edited_at = now() where id = p_message;
end $$;

create or replace function delete_for_everyone(p_message uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m messages;
begin
  select * into m from messages where id = p_message;
  if m.sender_id <> auth.uid() and not is_admin(m.chat_id) then raise exception 'not allowed'; end if;
  if m.sender_id = auth.uid() and m.created_at < now() - interval '1 hour' and not is_admin(m.chat_id) then
    raise exception 'delete-for-everyone window (1 hour) has passed';
  end if;
  update messages set deleted_all = true, body = null, cipher = null, iv = null,
                      attachment = null, kind = 'text' where id = p_message;
end $$;

create or replace function toggle_pin(p_message uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare m messages; now_pinned boolean;
begin
  select * into m from messages where id = p_message;
  if m.id is null or not is_member(m.chat_id) then raise exception 'not allowed'; end if;
  now_pinned := m.pinned_at is null;
  update messages set pinned_at = case when now_pinned then now() end,
                      pinned_by = case when now_pinned then auth.uid() end
   where id = p_message;
  return now_pinned;
end $$;

create or replace function mark_view_once_seen(p_message uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m messages;
begin
  select * into m from messages where id = p_message;
  if m.id is null or not is_member(m.chat_id) then raise exception 'not allowed'; end if;
  update messages
     set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
           'viewed_by', coalesce(meta->'viewed_by', '[]'::jsonb) || to_jsonb(auth.uid()::text))
   where id = p_message;
end $$;

create or replace function clear_history(p_chat uuid)
returns void language sql security definer set search_path = public as $$
  update chat_members set cleared_at = now() where chat_id = p_chat and user_id = auth.uid();
$$;

create or replace function forward_messages(p_messages uuid[], p_chats uuid[])
returns int language plpgsql security definer set search_path = public as $$
declare mid uuid; cid uuid; n int := 0; src messages;
begin
  foreach cid in array p_chats loop
    if not can_send(cid) then continue; end if;
    foreach mid in array p_messages loop
      select * into src from messages where id = mid and is_member(chat_id);
      if src.id is null or src.cipher is not null then continue; end if;
      insert into messages (chat_id, sender_id, kind, body, attachment, meta, forwarded_from)
      values (cid, auth.uid(), src.kind, src.body, src.attachment, src.meta, src.id);
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

-- full-text search across every chat the caller belongs to (plaintext only)
create or replace function search_messages(p_query text, p_chat uuid default null, p_limit int default 60)
returns table (message_id uuid, chat_id uuid, sender_id uuid, body text, created_at timestamptz,
               chat_name text, rank real)
language sql security definer stable set search_path = public as $$
  select m.id, m.chat_id, m.sender_id, m.body, m.created_at,
         coalesce(c.name, (select p.display_name from chat_members cm
                            join profiles p on p.id = cm.user_id
                           where cm.chat_id = c.id and cm.user_id <> auth.uid() limit 1)),
         ts_rank(m.search_tsv, websearch_to_tsquery('english', p_query))
    from messages m join chats c on c.id = m.chat_id
   where is_member(m.chat_id)
     and (p_chat is null or m.chat_id = p_chat)
     and m.deleted_all = false
     and (m.expires_at is null or m.expires_at > now())
     and not exists (select 1 from message_hides h where h.message_id = m.id and h.user_id = auth.uid())
     and (m.search_tsv @@ websearch_to_tsquery('english', p_query) or m.body ilike '%' || p_query || '%')
   order by 7 desc, m.created_at desc
   limit p_limit;
$$;

-- "catch me up": computed entirely in SQL
create or replace function chat_digest(p_chat uuid, p_hours int default 12)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare since timestamptz := now() - make_interval(hours => p_hours); out jsonb;
begin
  if not is_member(p_chat) then raise exception 'not a member'; end if;
  select jsonb_build_object(
    'window_hours', p_hours,
    'total', (select count(*) from messages where chat_id = p_chat and created_at > since and deleted_all = false),
    'participants', (select count(distinct sender_id) from messages where chat_id = p_chat and created_at > since),
    'most_active', (select jsonb_build_object('name', p.display_name, 'count', x.n) from
                     (select sender_id, count(*) n from messages
                       where chat_id = p_chat and created_at > since and kind <> 'system'
                       group by 1 order by 2 desc limit 1) x
                     join profiles p on p.id = x.sender_id),
    'by_hour', (select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'count', n) order by h), '[]'::jsonb) from
                 (select date_trunc('hour', created_at) h, count(*) n from messages
                   where chat_id = p_chat and created_at > since group by 1) t),
    'unanswered', (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', q.id, 'body', q.body, 'from', p.display_name, 'at', q.created_at)), '[]'::jsonb)
                    from messages q join profiles p on p.id = q.sender_id
                   where q.chat_id = p_chat and q.created_at > since and q.body like '%?%'
                     and q.sender_id <> auth.uid()
                     and not exists (select 1 from messages r where r.chat_id = p_chat
                                      and r.created_at > q.created_at and r.sender_id <> q.sender_id)),
    'links', (select coalesce(jsonb_agg(distinct w), '[]'::jsonb) from messages m,
                regexp_split_to_table(m.body, '\s+') w
               where m.chat_id = p_chat and m.created_at > since and w ~* '^https?://'),
    'files', (select coalesce(jsonb_agg(jsonb_build_object(
                    'name', attachment->>'name', 'kind', kind, 'at', created_at)), '[]'::jsonb)
               from messages where chat_id = p_chat and created_at > since and attachment is not null),
    'mentions_you', (select count(*) from mentions n join messages m on m.id = n.message_id
                      where n.user_id = auth.uid() and m.chat_id = p_chat and m.created_at > since)
  ) into out;
  return out;
end $$;

-- chat list payload in one round trip
create or replace function chat_overview()
returns table (chat_id uuid, type chat_type, name text, icon_url text, other_id uuid,
               last_body text, last_kind msg_kind, last_at timestamptz, unread int,
               pinned boolean, archived boolean, muted boolean, folder_id uuid,
               locked boolean, e2ee boolean, disappear_seconds int, member_count int)
language sql security definer stable set search_path = public as $$
  select c.id, c.type,
         coalesce(c.name, op.display_name),
         coalesce(c.icon_url, op.photo_url),
         o.user_id,
         (select case when m.deleted_all then null when m.cipher is not null then null else m.body end
            from messages m where m.chat_id = c.id and m.created_at >= me.cleared_at
            order by m.created_at desc limit 1),
         (select m.kind from messages m where m.chat_id = c.id and m.created_at >= me.cleared_at
            order by m.created_at desc limit 1),
         c.last_message_at,
         (select count(*)::int from messages m where m.chat_id = c.id
            and m.created_at > me.last_read_at and m.sender_id <> auth.uid()
            and (m.expires_at is null or m.expires_at > now())),
         me.pinned, me.archived,
         (me.mute_forever or coalesce(me.muted_until > now(), false)),
         me.folder_id, me.locked, c.e2ee, c.disappear_seconds,
         (select count(*)::int from chat_members k where k.chat_id = c.id)
    from chat_members me
    join chats c on c.id = me.chat_id
    left join chat_members o on o.chat_id = c.id and o.user_id <> auth.uid() and c.type = 'dm'
    left join profiles op on op.id = o.user_id
   where me.user_id = auth.uid() and me.left_at is null
   order by me.pinned desc, c.last_message_at desc;
$$;

-- presence + privacy-gated profile fields for a set of users
create or replace function people_info(p_ids uuid[])
returns table (id uuid, display_name text, photo_url text, about text,
               is_online boolean, last_seen timestamptz, blocked boolean, favorite boolean, nickname text, accent text)
language sql security definer stable set search_path = public as $$
  select p.id,
         coalesce(ct.nickname, p.display_name),
         case when field_visible(p.id, auth.uid(), s.photo_vis) then p.photo_url end,
         case when field_visible(p.id, auth.uid(), s.about_vis) then p.about end,
         case when field_visible(p.id, auth.uid(), s.online_vis) then pr.is_online else null end,
         case when field_visible(p.id, auth.uid(), s.last_seen_vis) then pr.last_seen else null end,
         exists (select 1 from blocks b where b.blocker_id = auth.uid() and b.blocked_id = p.id),
         coalesce(ct.favorite, false), ct.nickname, ct.accent
    from profiles p
    left join user_settings s on s.user_id = p.id
    left join presence pr on pr.user_id = p.id
    left join contacts ct on ct.user_id = auth.uid() and ct.contact_id = p.id
   where p.id = any(p_ids);
$$;

create or replace function search_people(p_query text, p_limit int default 25)
returns table (id uuid, display_name text, photo_url text, about text, blocked boolean)
language sql security definer stable set search_path = public as $$
  select p.id, p.display_name,
         case when field_visible(p.id, auth.uid(), s.photo_vis) then p.photo_url end,
         case when field_visible(p.id, auth.uid(), s.about_vis) then p.about end,
         exists (select 1 from blocks b where b.blocker_id = auth.uid() and b.blocked_id = p.id)
    from profiles p left join user_settings s on s.user_id = p.id
   where p.id <> auth.uid()
     and not blocked_between(p.id, auth.uid())
     and (p.display_name ilike '%'||p_query||'%' or lower(p.email) = lower(p_query))
   order by p.display_name limit p_limit;
$$;

create or replace function heartbeat()
returns void language sql security definer set search_path = public as $$
  insert into presence (user_id, is_online, last_seen) values (auth.uid(), true, now())
  on conflict (user_id) do update set is_online = true, last_seen = now();
$$;

create or replace function go_offline()
returns void language sql security definer set search_path = public as $$
  update presence set is_online = false, last_seen = now() where user_id = auth.uid();
$$;

create or replace function set_typing(p_chat uuid)
returns void language sql security definer set search_path = public as $$
  insert into typing (chat_id, user_id, updated_at) values (p_chat, auth.uid(), now())
  on conflict (chat_id, user_id) do update set updated_at = now();
$$;

create or replace function block_user(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into blocks (blocker_id, blocked_id) values (auth.uid(), p_user) on conflict do nothing;
end $$;

create or replace function set_two_step_pin(p_pin text)
returns void language sql security definer set search_path = public as $$
  update user_settings set two_step_pin = case when p_pin is null or p_pin = '' then null
                                               else crypt(p_pin, gen_salt('bf')) end
   where user_id = auth.uid();
$$;

create or replace function verify_two_step_pin(p_pin text)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce(two_step_pin = crypt(p_pin, two_step_pin), true)
    from user_settings where user_id = auth.uid();
$$;

create or replace function set_chat_lock(p_chat uuid, p_pin text)
returns void language sql security definer set search_path = public as $$
  update chat_members
     set locked = (p_pin is not null and p_pin <> ''),
         lock_pin = case when p_pin is null or p_pin = '' then null else crypt(p_pin, gen_salt('bf')) end
   where chat_id = p_chat and user_id = auth.uid();
$$;

create or replace function verify_chat_lock(p_chat uuid, p_pin text)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce(lock_pin = crypt(p_pin, lock_pin), false)
    from chat_members where chat_id = p_chat and user_id = auth.uid();
$$;

create or replace function set_disappearing(p_chat uuid, p_seconds int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_member(p_chat) then raise exception 'not a member'; end if;
  update chats set disappear_seconds = p_seconds where id = p_chat;
  insert into messages (chat_id, sender_id, kind, body)
  values (p_chat, auth.uid(), 'system',
    case when p_seconds = 0 then 'Disappearing messages turned off'
         else 'Disappearing messages set to ' || (p_seconds/3600) || 'h' end);
end $$;

-- purge: run from pg_cron every minute
create or replace function purge_expired_messages()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with gone as (delete from messages where expires_at is not null and expires_at < now() returning 1)
  select count(*) into n from gone;
  delete from typing where updated_at < now() - interval '30 seconds';
  delete from call_signals where created_at < now() - interval '1 hour';
  delete from live_locations where live and expires_at < now();
  return n;
end $$;

-- scheduled send dispatcher: run from pg_cron every minute
create or replace function dispatch_scheduled_messages()
returns int language plpgsql security definer set search_path = public as $$
declare r scheduled_messages; n int := 0;
begin
  for r in select * from scheduled_messages where status = 'pending' and send_at <= now() loop
    begin
      insert into messages (chat_id, sender_id, kind, body, attachment)
      values (r.chat_id, r.sender_id, r.kind, r.body, r.attachment);
      if r.recurrence is null then
        update scheduled_messages set status = 'sent' where id = r.id;
      else
        update scheduled_messages set send_at = case r.recurrence
            when 'daily'    then r.send_at + interval '1 day'
            when 'weekly'   then r.send_at + interval '7 days'
            when 'weekdays' then r.send_at + case when extract(dow from r.send_at) = 5 then interval '3 days'
                                                  when extract(dow from r.send_at) = 6 then interval '2 days'
                                                  else interval '1 day' end
            else r.send_at + interval '1 day' end
         where id = r.id;
      end if;
      n := n + 1;
    exception when others then
      update scheduled_messages set status = 'failed' where id = r.id;
    end;
  end loop;
  return n;
end $$;

-- account data export (JSON) and hard delete
create or replace function export_my_data()
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from profiles p where p.id = auth.uid()),
    'settings', (select to_jsonb(s) from user_settings s where s.user_id = auth.uid()),
    'contacts', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) from contacts c where c.user_id = auth.uid()),
    'blocks', (select coalesce(jsonb_agg(b.blocked_id), '[]'::jsonb) from blocks b where b.blocker_id = auth.uid()),
    'chats', (select coalesce(jsonb_agg(jsonb_build_object(
                 'chat', to_jsonb(c),
                 'messages', (select coalesce(jsonb_agg(jsonb_build_object(
                        'at', m.created_at, 'from', m.sender_id, 'kind', m.kind,
                        'body', m.body, 'attachment', m.attachment) order by m.created_at), '[]'::jsonb)
                    from messages m where m.chat_id = c.id))), '[]'::jsonb)
               from chats c where is_member(c.id)),
    'scheduled', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from scheduled_messages x where x.sender_id = auth.uid()),
    'calls', (select coalesce(jsonb_agg(to_jsonb(k)), '[]'::jsonb) from calls k where is_member(k.chat_id))
  );
$$;

create or replace function delete_my_account()
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not authenticated'; end if;
  update messages set body = null, cipher = null, attachment = null, deleted_all = true
   where sender_id = me;
  delete from chat_members where user_id = me;
  delete from auth.users where id = me;   -- cascades everything else
end $$;

-- export one conversation as plain text (used by the client for .txt / print-to-PDF)
create or replace function export_chat_text(p_chat uuid)
returns text language sql security definer stable set search_path = public as $$
  select string_agg(
      to_char(m.created_at, 'YYYY-MM-DD HH24:MI') || '  ' ||
      coalesce(p.display_name,'unknown') || ': ' ||
      case when m.deleted_all then '[deleted]'
           when m.cipher is not null then '[encrypted]'
           when m.attachment is not null then coalesce(m.body,'') || ' [' || m.kind || ': ' || coalesce(m.attachment->>'name','file') || ']'
           else coalesce(m.body,'') end,
      E'\n' order by m.created_at)
    from messages m left join profiles p on p.id = m.sender_id
   where m.chat_id = p_chat and is_member(p_chat);
$$;

create or replace function shared_media(p_chat uuid, p_limit int default 200)
returns setof messages language sql security definer stable set search_path = public as $$
  select * from messages
   where chat_id = p_chat and is_member(p_chat) and attachment is not null and deleted_all = false
     and (expires_at is null or expires_at > now())
   order by created_at desc limit p_limit;
$$;

create or replace function unread_total()
returns int language sql security definer stable set search_path = public as $$
  select coalesce(sum(o.unread), 0)::int from chat_overview() o where not o.muted and not o.archived;
$$;

-- rotate an e2ee chat key for every current member
create or replace function set_chat_e2ee(p_chat uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_member(p_chat) then raise exception 'not a member'; end if;
  update chats set e2ee = p_on where id = p_chat;
  insert into messages (chat_id, sender_id, kind, body)
  values (p_chat, auth.uid(), 'system',
          case when p_on then 'Encryption enabled for new messages' else 'Encryption disabled' end);
end $$;

-- ============================================================================
-- 7. REALTIME
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array['messages','message_status','reactions','typing','presence','chats',
                           'chat_members','calls','call_signals','poll_votes','live_locations','mentions']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
             when undefined_object then
               raise notice 'publication supabase_realtime missing; enable Realtime in the dashboard';
    end;
  end loop;
end $$;

alter table messages replica identity full;
alter table message_status replica identity full;
alter table chat_members replica identity full;
alter table calls replica identity full;

-- ============================================================================
-- 8. STORAGE BUCKETS + POLICIES
-- Path convention:
--   media/<chat_id>/<uuid>.<ext>      (private, chat members only)
--   voice/<chat_id>/<uuid>.webm       (private, chat members only)
--   avatars/<user_id>/<file>          (public read)
--   wallpapers/<user_id>/<file>       (public read)
--   sounds/<user_id>/<file>           (public read)
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('media','media', false, 104857600),
       ('voice','voice', false, 26214400),
       ('avatars','avatars', true, 5242880),
       ('wallpapers','wallpapers', true, 10485760),
       ('sounds','sounds', true, 2097152)
on conflict (id) do nothing;

drop policy if exists media_read on storage.objects;
create policy media_read on storage.objects for select to authenticated
  using (bucket_id in ('media','voice') and is_member(((storage.foldername(name))[1])::uuid));

drop policy if exists media_write on storage.objects;
create policy media_write on storage.objects for insert to authenticated
  with check (bucket_id in ('media','voice') and can_send(((storage.foldername(name))[1])::uuid));

drop policy if exists public_read on storage.objects;
create policy public_read on storage.objects for select to public
  using (bucket_id in ('avatars','wallpapers','sounds'));

drop policy if exists own_public_write on storage.objects;
create policy own_public_write on storage.objects for insert to authenticated
  with check (bucket_id in ('avatars','wallpapers','sounds')
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists own_public_update on storage.objects;
create policy own_public_update on storage.objects for update to authenticated
  using (bucket_id in ('avatars','wallpapers','sounds')
         and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists own_delete on storage.objects;
create policy own_delete on storage.objects for delete to authenticated
  using (owner = auth.uid());

-- ============================================================================
-- 9. CRON (requires the pg_cron extension, enabled from the dashboard)
-- ============================================================================
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('wisp_purge')     where exists (select 1 from cron.job where jobname = 'wisp_purge');
    perform cron.unschedule('wisp_scheduled') where exists (select 1 from cron.job where jobname = 'wisp_scheduled');
    perform cron.schedule('wisp_purge', '* * * * *', 'select purge_expired_messages()');
    perform cron.schedule('wisp_scheduled', '* * * * *', 'select dispatch_scheduled_messages()');
  else
    raise notice 'pg_cron not enabled: enable it in Database > Extensions, then re-run section 9';
  end if;
end $$;

grant execute on all functions in schema public to authenticated;
