-- ============================================================================
-- WISP — migration: chat lock that actually holds, and real group calls.
--
-- Paste this whole file into the Supabase SQL editor and Run. It is safe to
-- run more than once (every statement is idempotent; policies and functions
-- are dropped before being recreated). It does not delete any rows.
--
-- Run it BEFORE deploying the branch: the client calls the RPCs below, and a
-- missing RPC is a 404 at runtime.
--
-- No enum values are added anywhere, on purpose: "alter type ... add value"
-- cannot be used in the same transaction that uses it, and the SQL editor
-- runs a script as one transaction. A live call is state = 'accepted'.
--
-- What it changes
--   1. chat_members gains the lock's own state: attempt counter, cooldown,
--      relock policy, preview/list privacy.
--   2. set_chat_lock requires the current PIN before changing or removing a
--      lock, and validates PIN shape server-side. Old 2-arg version dropped.
--   3. verify_chat_lock returns jsonb and rate-limits brute force with an
--      escalating cooldown. Old boolean version dropped.
--   4. chat_overview redacts the last message of a locked chat.
--   5. search_messages skips locked chats unless the caller passes the chat
--      ids it has unlocked in this session.
--   6. call_participants + start_call / join_call / leave_call / decline_call /
--      end_call_for_all / call_heartbeat / call_roster / live_calls /
--      sweep_stale_calls: a call is a room you can join late, not a 1:1 ring.
--   7. The "Voice call · ended · 1:23" bubble is now written once, by the
--      server, when the last participant leaves - not once per client.
-- ============================================================================

-- ============================================================================
-- 1. CHAT LOCK - columns
-- ============================================================================
alter table chat_members add column if not exists lock_fails        int not null default 0;
alter table chat_members add column if not exists lock_until        timestamptz;
alter table chat_members add column if not exists lock_relock       text not null default 'session';
alter table chat_members add column if not exists lock_hide_preview boolean not null default true;
alter table chat_members add column if not exists lock_hide_in_list boolean not null default false;
alter table chat_members add column if not exists lock_set_at       timestamptz;

alter table chat_members drop constraint if exists chat_members_lock_relock_chk;
alter table chat_members add  constraint chat_members_lock_relock_chk
  check (lock_relock in ('immediate','1m','15m','session'));

-- a row that says locked but has no hash is not a lock; clean that up once
update chat_members set locked = false where locked = true and lock_pin is null;
update chat_members set lock_set_at = coalesce(lock_set_at, now()) where lock_pin is not null;

-- ============================================================================
-- 2. CHAT LOCK - helpers
-- ============================================================================

-- Escalating cooldown after wrong PINs. Mirrored in js/lockcore.js
-- cooldownFor(); tests/lockcore.test.js pins every pair.
create or replace function chat_lock_cooldown(p_fails int)
returns int language sql immutable set search_path = public as $fn$
  select case
    when coalesce(p_fails,0) < 5 then 0
    when p_fails = 5  then 30
    when p_fails = 6  then 60
    when p_fails = 7  then 300
    else 900
  end;
$fn$;

-- 4-8 digits, and not one of the shapes that is the same as having no PIN.
create or replace function chat_lock_pin_ok(p_pin text)
returns boolean language plpgsql immutable set search_path = public as $fn$
declare asc_run boolean := true; desc_run boolean := true;
begin
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' then return false; end if;
  if p_pin ~ ('^' || substr(p_pin,1,1) || '+$') then return false; end if;   -- 0000, 1111
  for i in 2..length(p_pin) loop
    if ascii(substr(p_pin,i,1)) <> ascii(substr(p_pin,i-1,1)) + 1 then asc_run := false; end if;
    if ascii(substr(p_pin,i,1)) <> ascii(substr(p_pin,i-1,1)) - 1 then desc_run := false; end if;
  end loop;
  if asc_run or desc_run then return false; end if;                          -- 1234, 4321
  return true;
end $fn$;

-- Read-only check of the account's own password: the "forgot the PIN" escape
-- hatch, so a lock can be removed by the account owner and by nobody else.
-- Compares against the bcrypt hash GoTrue stores and returns only a boolean.
create or replace function verify_account_password(p_password text)
returns boolean language plpgsql security definer stable set search_path = public, auth as $fn$
declare h text;
begin
  if p_password is null or p_password = '' then return false; end if;
  select encrypted_password into h from auth.users where id = auth.uid();
  if h is null or h = '' then return false; end if;   -- OAuth-only account
  return h = crypt(p_password, h);
end $fn$;

-- ============================================================================
-- 3. CHAT LOCK - set / verify / reset
-- ============================================================================
drop function if exists set_chat_lock(uuid, text);
drop function if exists verify_chat_lock(uuid, text);

-- Setting, changing and removing all need the current PIN once one exists.
-- Before this, anyone holding an unlocked phone could switch the lock off and
-- read the chat.
create or replace function set_chat_lock(p_chat uuid, p_pin text, p_old_pin text default null)
returns void language plpgsql security definer set search_path = public as $fn$
declare m chat_members;
begin
  select * into m from chat_members where chat_id = p_chat and user_id = auth.uid();
  if m.user_id is null then raise exception 'not a member'; end if;

  if m.lock_pin is not null then
    if m.lock_until is not null and m.lock_until > now() then
      raise exception 'locked_out: try again in % seconds', ceil(extract(epoch from (m.lock_until - now())));
    end if;
    if p_old_pin is null or m.lock_pin <> crypt(p_old_pin, m.lock_pin) then
      update chat_members
         set lock_fails = lock_fails + 1,
             lock_until = case when chat_lock_cooldown(lock_fails + 1) > 0
                               then now() + make_interval(secs => chat_lock_cooldown(lock_fails + 1)) end
       where chat_id = p_chat and user_id = auth.uid();
      raise exception 'wrong_pin';
    end if;
  end if;

  if p_pin is null or p_pin = '' then
    update chat_members set locked = false, lock_pin = null, lock_fails = 0,
                            lock_until = null, lock_set_at = null
     where chat_id = p_chat and user_id = auth.uid();
    return;
  end if;

  if not chat_lock_pin_ok(p_pin) then
    raise exception 'weak_pin: use 4 to 8 digits, not all the same and not a sequence';
  end if;

  update chat_members
     set locked = true, lock_pin = crypt(p_pin, gen_salt('bf')),
         lock_fails = 0, lock_until = null, lock_set_at = now()
   where chat_id = p_chat and user_id = auth.uid();
end $fn$;

-- jsonb, not boolean: the client has to tell "wrong" from "wrong and now you
-- are in a cooldown", and show the countdown.
--   { ok, locked, wait_seconds, fails, attempts_left }
create or replace function verify_chat_lock(p_chat uuid, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare m chat_members; wait int; nf int;
begin
  select * into m from chat_members where chat_id = p_chat and user_id = auth.uid();
  if m.user_id is null then raise exception 'not a member'; end if;
  if m.lock_pin is null then
    return jsonb_build_object('ok', true, 'locked', false, 'wait_seconds', 0, 'fails', 0, 'attempts_left', 5);
  end if;

  if m.lock_until is not null and m.lock_until > now() then
    wait := ceil(extract(epoch from (m.lock_until - now())));
    return jsonb_build_object('ok', false, 'locked', true, 'wait_seconds', wait,
                              'fails', m.lock_fails, 'attempts_left', 0);
  end if;

  if p_pin is not null and p_pin <> '' and m.lock_pin = crypt(p_pin, m.lock_pin) then
    update chat_members set lock_fails = 0, lock_until = null
     where chat_id = p_chat and user_id = auth.uid();
    return jsonb_build_object('ok', true, 'locked', true, 'wait_seconds', 0, 'fails', 0, 'attempts_left', 5);
  end if;

  nf := m.lock_fails + 1;
  wait := chat_lock_cooldown(nf);
  update chat_members
     set lock_fails = nf,
         lock_until = case when wait > 0 then now() + make_interval(secs => wait) end
   where chat_id = p_chat and user_id = auth.uid();
  return jsonb_build_object('ok', false, 'locked', true, 'wait_seconds', wait,
                            'fails', nf, 'attempts_left', greatest(0, 5 - nf));
end $fn$;

-- Forgot the PIN: prove the account password instead.
create or replace function reset_chat_lock(p_chat uuid, p_password text)
returns boolean language plpgsql security definer set search_path = public as $fn$
begin
  if not is_member(p_chat) then raise exception 'not a member'; end if;
  if not verify_account_password(p_password) then return false; end if;
  update chat_members set locked = false, lock_pin = null, lock_fails = 0,
                          lock_until = null, lock_set_at = null
   where chat_id = p_chat and user_id = auth.uid();
  return true;
end $fn$;

create or replace function set_chat_lock_prefs(p_chat uuid, p_relock text default null,
                                               p_hide_preview boolean default null,
                                               p_hide_in_list boolean default null)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if not is_member(p_chat) then raise exception 'not a member'; end if;
  if p_relock is not null and p_relock not in ('immediate','1m','15m','session') then
    raise exception 'bad_relock';
  end if;
  update chat_members
     set lock_relock       = coalesce(p_relock, lock_relock),
         lock_hide_preview = coalesce(p_hide_preview, lock_hide_preview),
         lock_hide_in_list = coalesce(p_hide_in_list, lock_hide_in_list)
   where chat_id = p_chat and user_id = auth.uid();
end $fn$;

-- ============================================================================
-- 4. CHAT LOCK - stop the leaks (list preview, search)
-- ============================================================================
drop function if exists chat_overview();
create or replace function chat_overview()
returns table (chat_id uuid, type chat_type, name text, icon_url text, other_id uuid,
               last_body text, last_kind msg_kind, last_at timestamptz, unread int,
               pinned boolean, archived boolean, muted boolean, folder_id uuid,
               locked boolean, e2ee boolean, disappear_seconds int, member_count int,
               lock_relock text, lock_hide_preview boolean, lock_hide_in_list boolean)
language sql security definer stable set search_path = public as $fn$
  select c.id, c.type,
         coalesce(c.name, op.display_name),
         coalesce(c.icon_url, op.photo_url),
         o.user_id,
         -- a locked chat's last message never leaves Postgres
         case when me.locked and me.lock_hide_preview then null else
           (select case when m.deleted_all then null when m.cipher is not null then null else m.body end
              from messages m where m.chat_id = c.id and m.created_at >= me.cleared_at
              order by m.created_at desc limit 1) end,
         case when me.locked and me.lock_hide_preview then null else
           (select m.kind from messages m where m.chat_id = c.id and m.created_at >= me.cleared_at
              order by m.created_at desc limit 1) end,
         c.last_message_at,
         (select count(*)::int from messages m where m.chat_id = c.id
            and m.created_at > me.last_read_at and m.sender_id <> auth.uid()
            and (m.expires_at is null or m.expires_at > now())),
         me.pinned, me.archived,
         (me.mute_forever or coalesce(me.muted_until > now(), false)),
         me.folder_id, me.locked, c.e2ee, c.disappear_seconds,
         (select count(*)::int from chat_members k where k.chat_id = c.id),
         me.lock_relock, me.lock_hide_preview, me.lock_hide_in_list
    from chat_members me
    join chats c on c.id = me.chat_id
    left join chat_members o on o.chat_id = c.id and o.user_id <> auth.uid() and c.type = 'dm'
    left join profiles op on op.id = o.user_id
   where me.user_id = auth.uid() and me.left_at is null
   order by me.pinned desc, c.last_message_at desc;
$fn$;

drop function if exists search_messages(text, uuid, int);
create or replace function search_messages(p_query text, p_chat uuid default null, p_limit int default 60,
                                           p_unlocked uuid[] default '{}')
returns table (message_id uuid, chat_id uuid, sender_id uuid, body text, created_at timestamptz,
               chat_name text, rank real)
language sql security definer stable set search_path = public as $fn$
  select m.id, m.chat_id, m.sender_id, m.body, m.created_at,
         coalesce(c.name, (select p.display_name from chat_members cm
                            join profiles p on p.id = cm.user_id
                           where cm.chat_id = c.id and cm.user_id <> auth.uid() limit 1)),
         ts_rank(m.search_tsv, websearch_to_tsquery('english', p_query))
    from messages m join chats c on c.id = m.chat_id
   where is_member(m.chat_id)
     and (p_chat is null or m.chat_id = p_chat)
     -- locked chats stay out of results unless this session has unlocked them
     and not exists (select 1 from chat_members lk
                      where lk.chat_id = m.chat_id and lk.user_id = auth.uid() and lk.locked
                        and not (m.chat_id = any(coalesce(p_unlocked, '{}'::uuid[]))))
     and m.deleted_all = false
     and (m.expires_at is null or m.expires_at > now())
     and not exists (select 1 from message_hides h where h.message_id = m.id and h.user_id = auth.uid())
     and (m.search_tsv @@ websearch_to_tsquery('english', p_query) or m.body ilike '%' || p_query || '%')
   order by 7 desc, m.created_at desc
   limit p_limit;
$fn$;

-- ============================================================================
-- 5. GROUP CALLS - schema
-- ============================================================================
alter table calls add column if not exists host_id          uuid references auth.users(id) on delete set null;
alter table calls add column if not exists join_open        boolean not null default true;
alter table calls add column if not exists ended_reason     text;
alter table calls add column if not exists last_activity_at timestamptz not null default now();
update calls set host_id = caller_id where host_id is null;

create index if not exists calls_live_idx on calls (chat_id) where ended_at is null;

create table if not exists call_participants (
  call_id      uuid not null references calls(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  joined_at    timestamptz not null default now(),
  left_at      timestamptz,
  muted        boolean not null default false,
  cam_on       boolean not null default false,
  sharing      boolean not null default false,
  heartbeat_at timestamptz not null default now(),
  primary key (call_id, user_id)
);
create index if not exists call_participants_live_idx on call_participants (call_id) where left_at is null;
create index if not exists call_participants_user_idx on call_participants (user_id, joined_at desc);

alter table call_participants enable row level security;

drop policy if exists cp_read on call_participants;
create policy cp_read on call_participants for select to authenticated
  using (exists (select 1 from calls c where c.id = call_id and is_member(c.chat_id)));
drop policy if exists cp_write on call_participants;
create policy cp_write on call_participants for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists cp_insert on call_participants;
create policy cp_insert on call_participants for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from calls c where c.id = call_id and is_member(c.chat_id)));

-- ============================================================================
-- 6. GROUP CALLS - RPCs
-- ============================================================================

-- Mesh, not an SFU: everyone sends their own media to everyone else, so the
-- ceiling is a bandwidth fact, not a preference. Mirrored in
-- js/callcore.js capacityFor().
create or replace function call_capacity(p_kind call_kind)
returns int language sql immutable set search_path = public as $fn$
  select case when p_kind = 'video' then 4 else 6 end;
$fn$;

create or replace function live_participant_count(p_call uuid)
returns int language sql security definer stable set search_path = public as $fn$
  select count(*)::int from call_participants where call_id = p_call and left_at is null;
$fn$;

create or replace function call_roster(p_call uuid)
returns table (user_id uuid, display_name text, photo_url text, muted boolean,
               cam_on boolean, sharing boolean, joined_at timestamptz, left_at timestamptz)
language sql security definer stable set search_path = public as $fn$
  select cp.user_id, p.display_name, p.photo_url, cp.muted, cp.cam_on, cp.sharing,
         cp.joined_at, cp.left_at
    from call_participants cp
    join calls c on c.id = cp.call_id
    left join profiles p on p.id = cp.user_id
   where cp.call_id = p_call and is_member(c.chat_id)
   order by cp.joined_at;
$fn$;

-- Writes the one and only "call" bubble, and only for whoever actually closes
-- the call out. "where ended_at is null" is the race guard: two clients
-- leaving in the same instant means one update matches and one does not.
create or replace function finalize_call(p_call uuid, p_reason text default 'ended')
returns boolean language plpgsql security definer set search_path = public as $fn$
declare c calls; secs int; joined int; label text; final_state call_state;
begin
  select * into c from calls where id = p_call;
  if c.id is null then return false; end if;

  select count(distinct user_id)::int into joined from call_participants where call_id = p_call;

  secs := case when c.answered_at is null then 0
               else greatest(0, floor(extract(epoch from (now() - c.answered_at)))::int) end;
  final_state := case
    when p_reason = 'declined' then 'declined'
    when p_reason = 'failed' then 'failed'
    when p_reason = 'missed' or (c.answered_at is null and joined <= 1) then 'missed'
    else 'ended' end;

  update calls
     set state = final_state, ended_at = now(), duration = secs,
         ended_reason = p_reason, join_open = false, last_activity_at = now()
   where id = p_call and ended_at is null;
  if not found then return false; end if;    -- somebody else finalised it

  update call_participants set left_at = coalesce(left_at, now()) where call_id = p_call;

  label := (case when c.kind = 'video' then 'Video' else 'Voice' end)
        || (case when joined > 2 then ' group' else '' end) || ' call · ' || final_state
        || (case when secs > 0
                 then ' · ' || floor(secs / 60)::text || ':' || lpad((secs % 60)::text, 2, '0')
                 else '' end);

  insert into messages (chat_id, sender_id, kind, body, meta)
  values (c.chat_id, c.host_id, 'call', label,
          jsonb_build_object('call_id', c.id, 'state', final_state, 'duration', secs,
                             'kind', c.kind, 'participants', joined));
  return true;
end $fn$;

-- Tapping call in a chat that already has a live call joins it instead of
-- starting a second one, so two people pressing at the same moment end up in
-- the same room.
create or replace function start_call(p_chat uuid, p_kind call_kind default 'audio')
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare live calls; cid uuid; me uuid := auth.uid();
begin
  if me is null then raise exception 'not authenticated'; end if;
  if not can_send(p_chat) then raise exception 'not allowed to call in this chat'; end if;
  if (select type from chats where id = p_chat) = 'broadcast' then
    raise exception 'broadcast lists cannot be called';
  end if;
  if (select count(*) from chat_members where chat_id = p_chat and left_at is null) < 2 then
    raise exception 'nobody to call';
  end if;

  select * into live from calls
   where chat_id = p_chat and ended_at is null and state in ('ringing','accepted')
     and last_activity_at > now() - interval '2 minutes'
   order by started_at desc limit 1;

  if live.id is not null then
    return join_call(live.id) || jsonb_build_object('reused', true);
  end if;

  insert into calls (chat_id, caller_id, host_id, kind, state)
  values (p_chat, me, me, p_kind, 'ringing') returning id into cid;
  insert into call_participants (call_id, user_id, cam_on)
  values (cid, me, p_kind = 'video')
  on conflict (call_id, user_id) do update set left_at = null, heartbeat_at = now();

  return jsonb_build_object('call_id', cid, 'chat_id', p_chat, 'kind', p_kind,
                            'state', 'ringing', 'host_id', me, 'reused', false,
                            'capacity', call_capacity(p_kind),
                            'participants', jsonb_build_array(jsonb_build_object('user_id', me)));
end $fn$;

create or replace function join_call(p_call uuid)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare c calls; me uuid := auth.uid(); n int; already boolean;
begin
  if me is null then raise exception 'not authenticated'; end if;
  select * into c from calls where id = p_call;
  if c.id is null then raise exception 'no_such_call'; end if;
  if not is_member(c.chat_id) then raise exception 'not a member'; end if;
  if c.ended_at is not null or c.state in ('ended','missed','failed','declined') then
    raise exception 'call_ended';
  end if;
  if not c.join_open then raise exception 'call_closed'; end if;

  select exists (select 1 from call_participants
                  where call_id = p_call and user_id = me and left_at is null) into already;
  n := live_participant_count(p_call);
  if not already and n >= call_capacity(c.kind) then
    raise exception 'call_full: this % call is limited to % people (mesh, no SFU)',
      c.kind, call_capacity(c.kind);
  end if;

  insert into call_participants (call_id, user_id, cam_on, heartbeat_at)
  values (p_call, me, c.kind = 'video', now())
  on conflict (call_id, user_id)
    do update set left_at = null,
                  joined_at = case when call_participants.left_at is not null
                                   then now() else call_participants.joined_at end,
                  heartbeat_at = now();

  update calls set state = 'accepted', answered_at = coalesce(answered_at, now()),
                   last_activity_at = now()
   where id = p_call and ended_at is null
     and (select count(*) from call_participants where call_id = p_call and left_at is null) > 1;

  return jsonb_build_object(
    'call_id', p_call, 'chat_id', c.chat_id, 'kind', c.kind, 'host_id', c.host_id,
    'state', (select state from calls where id = p_call), 'reused', true,
    'capacity', call_capacity(c.kind),
    'participants', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', r.user_id, 'display_name', r.display_name, 'muted', r.muted,
        'cam_on', r.cam_on, 'sharing', r.sharing, 'joined_at', r.joined_at) order by r.joined_at)
      from call_roster(p_call) r where r.left_at is null), '[]'::jsonb));
end $fn$;

create or replace function leave_call(p_call uuid)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare c calls; me uuid := auth.uid(); n int; closed boolean := false;
begin
  select * into c from calls where id = p_call;
  if c.id is null then raise exception 'no_such_call'; end if;
  if not is_member(c.chat_id) then raise exception 'not a member'; end if;

  update call_participants set left_at = now()
   where call_id = p_call and user_id = me and left_at is null;
  update calls set last_activity_at = now() where id = p_call;

  n := live_participant_count(p_call);
  -- one person alone in a room is not a call: close it, so the next tap starts
  -- a fresh one instead of joining a ghost.
  if n <= 1 then
    closed := finalize_call(p_call, case when c.answered_at is null then 'missed' else 'ended' end);
  end if;
  return jsonb_build_object('call_id', p_call, 'live', n, 'closed', closed);
end $fn$;

-- Declining a DM ring ends the call (the caller sees "declined"). Declining a
-- group ring only silences it for you: the room keeps going and you can still
-- join it later from the chat or the Calls tab.
create or replace function decline_call(p_call uuid)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare c calls; members int; closed boolean := false;
begin
  select * into c from calls where id = p_call;
  if c.id is null then raise exception 'no_such_call'; end if;
  if not is_member(c.chat_id) then raise exception 'not a member'; end if;

  select count(*) into members from chat_members where chat_id = c.chat_id and left_at is null;
  if members <= 2 and c.answered_at is null then
    closed := finalize_call(p_call, 'declined');
  end if;
  return jsonb_build_object('call_id', p_call, 'closed', closed);
end $fn$;

create or replace function end_call_for_all(p_call uuid)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare c calls;
begin
  select * into c from calls where id = p_call;
  if c.id is null then raise exception 'no_such_call'; end if;
  if c.host_id <> auth.uid() and not is_admin(c.chat_id) then raise exception 'host or admin only'; end if;
  return jsonb_build_object('closed', finalize_call(p_call, 'ended'));
end $fn$;

create or replace function call_heartbeat(p_call uuid, p_muted boolean default null,
                                          p_cam_on boolean default null, p_sharing boolean default null)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  update call_participants
     set heartbeat_at = now(),
         muted   = coalesce(p_muted, muted),
         cam_on  = coalesce(p_cam_on, cam_on),
         sharing = coalesce(p_sharing, sharing)
   where call_id = p_call and user_id = auth.uid() and left_at is null;
  update calls set last_activity_at = now() where id = p_call and ended_at is null;
end $fn$;

-- Everything the client needs to draw "there is a call happening, tap to join"
-- in the chat list, in the thread and in the Calls tab.
create or replace function live_calls()
returns table (call_id uuid, chat_id uuid, chat_name text, kind call_kind, state call_state,
               started_at timestamptz, host_id uuid, participants int, capacity int,
               names text[], i_am_in boolean)
language sql security definer stable set search_path = public as $fn$
  select c.id, c.chat_id,
         coalesce(ch.name, (select p.display_name from chat_members cm join profiles p on p.id = cm.user_id
                             where cm.chat_id = ch.id and cm.user_id <> auth.uid() limit 1)),
         c.kind, c.state, c.started_at, c.host_id,
         live_participant_count(c.id), call_capacity(c.kind),
         coalesce((select array_agg(r.display_name order by r.joined_at)
                     from call_roster(c.id) r where r.left_at is null), '{}'::text[]),
         exists (select 1 from call_participants cp where cp.call_id = c.id
                  and cp.user_id = auth.uid() and cp.left_at is null)
    from calls c join chats ch on ch.id = c.chat_id
   where c.ended_at is null and c.state in ('ringing','accepted') and is_member(c.chat_id)
     and c.last_activity_at > now() - interval '2 minutes'
   order by c.started_at desc;
$fn$;

-- Ring timeouts and zombie rooms. Runs from pg_cron every minute: a tab that
-- was closed mid-call stops sending heartbeats, and 75 seconds later the room
-- lets go of it instead of advertising a call that nobody is in.
create or replace function sweep_stale_calls()
returns int language plpgsql security definer set search_path = public as $fn$
declare r record; n int := 0;
begin
  update call_participants set left_at = now()
   where left_at is null and heartbeat_at < now() - interval '75 seconds';

  for r in select c.id, c.answered_at, c.started_at from calls c where c.ended_at is null loop
    if live_participant_count(r.id) <= 1
       and (r.answered_at is not null or r.started_at < now() - interval '45 seconds')
    then
      if finalize_call(r.id, case when r.answered_at is null then 'missed' else 'ended' end) then
        n := n + 1;
      end if;
    end if;
  end loop;
  return n;
end $fn$;

-- ============================================================================
-- 7. REALTIME + CRON
-- ============================================================================
do $do$
begin
  begin
    execute 'alter publication supabase_realtime add table public.call_participants';
  exception when duplicate_object then null;
           when undefined_object then
             raise notice 'publication supabase_realtime missing; enable Realtime in the dashboard';
  end;
end $do$;

alter table call_participants replica identity full;

do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('wisp_calls') where exists (select 1 from cron.job where jobname = 'wisp_calls');
    perform cron.schedule('wisp_calls', '* * * * *', 'select sweep_stale_calls()');
  else
    raise notice 'pg_cron not enabled: group calls still work, but a browser that dies mid-call leaves a room open until someone joins and leaves it again';
  end if;
end $do$;

grant execute on all functions in schema public to authenticated;
revoke all on function verify_account_password(text) from anon;

-- Optional self-check, safe to run:
--   select chat_lock_cooldown(4), chat_lock_cooldown(5), chat_lock_cooldown(8);  -- 0, 30, 900
--   select chat_lock_pin_ok('1234'), chat_lock_pin_ok('0000'), chat_lock_pin_ok('4820');
--   select call_capacity('audio'), call_capacity('video');                       -- 6, 4
--   select * from live_calls();
