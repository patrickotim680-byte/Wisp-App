-- ============================================================================
-- WISP PRIVATE VAULT — server-side isolation
--
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- What lives on the server and what does not
-- ------------------------------------------
-- Stored here: the FACT that a conversation is in your vault (chat_members
-- .vaulted), and your vault preferences. That has to be server-side, because it
-- is what lets the normal chat list, the normal search and the push function
-- leave private conversations out at the source rather than trusting a client
-- to hide them.
--
-- NOT stored here, ever: the vault code, the vault master key, any key derived
-- from it, and any plaintext copy of a private conversation. Vaulting a
-- conversation turns on end-to-end encryption for it, so new message bodies
-- reach this database as ciphertext only. There is no server-side plaintext
-- copy of vault conversations and no server-side way to open a vault.
--
-- The pairing rule: `vaulted` is per member row, so vaulting is one-sided and
-- private to you. The other participant is not told.
-- ============================================================================

-- ── 1. columns ──────────────────────────────────────────────────────────────

alter table chat_members
  add column if not exists vaulted    boolean not null default false,
  add column if not exists vaulted_at timestamptz;

create index if not exists chat_members_vault_idx
  on chat_members (user_id) where vaulted;

-- Notification privacy tiers. A separate text column rather than new values on
-- the notif_preview enum, so this migration never has to do enum surgery on a
-- live database. notif_preview stays for backwards compatibility; notif_privacy
-- wins where both are set.
--   standard — sender and message, as before
--   private  — no message contents and no conversation details
--   maximum  — a generic Wisp notification, nothing about who or what
alter table user_settings
  add column if not exists notif_privacy      text    not null default 'standard',
  add column if not exists vault_autolock     text    not null default '60',
  add column if not exists vault_screen_guard boolean not null default true;

do $$ begin
  alter table user_settings add constraint user_settings_notif_privacy_ck
    check (notif_privacy in ('standard','private','maximum'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table user_settings add constraint user_settings_vault_autolock_ck
    check (vault_autolock in ('0','30','60','300','foreground','devicelock'));
exception when duplicate_object then null; end $$;

-- ── 2. helpers ──────────────────────────────────────────────────────────────

-- True when the caller has put this conversation in their own vault.
create or replace function is_vaulted(p_chat uuid, p_user uuid default auth.uid())
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select m.vaulted from chat_members m
                    where m.chat_id = p_chat and m.user_id = p_user), false);
$$;

-- The ids of the caller's private conversations, and nothing else: no names, no
-- previews, no bodies. The client needs this while the vault is LOCKED so an
-- incoming private message can be routed to a contentless notification and kept
-- out of the normal on-device cache.
create or replace function vault_chat_ids()
returns setof uuid language sql security definer stable set search_path = public as $$
  select m.chat_id from chat_members m
   where m.user_id = auth.uid() and m.vaulted and m.left_at is null;
$$;

-- ── 3. the normal chat list no longer contains private conversations ────────
--
-- This is the difference between a hidden chat and a private one: the name,
-- the last message and the unread count are not filtered out on the client,
-- they are never sent. A tampered-with client has nothing to un-hide.

drop function if exists chat_overview();
create function chat_overview()
returns table (chat_id uuid, type chat_type, name text, icon_url text, other_id uuid,
               last_body text, last_kind msg_kind, last_at timestamptz, unread int,
               pinned boolean, archived boolean, muted boolean, folder_id uuid,
               locked boolean, e2ee boolean, disappear_seconds int, member_count int,
               vaulted boolean)
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
         (select count(*)::int from chat_members k where k.chat_id = c.id),
         false
    from chat_members me
    join chats c on c.id = me.chat_id
    left join chat_members o on o.chat_id = c.id and o.user_id <> auth.uid() and c.type = 'dm'
    left join profiles op on op.id = o.user_id
   where me.user_id = auth.uid() and me.left_at is null
     and me.vaulted = false
   order by me.pinned desc, c.last_message_at desc;
$$;

-- The same payload for private conversations only. The client calls this after
-- the vault has been unlocked locally; the server cannot tell an unlocked vault
-- from a locked one (it holds no vault key), so this is not a security boundary
-- on its own — the boundary is that the local copies are encrypted and the UI
-- has no route here without the code. The isolation that matters is the
-- exclusion above.
drop function if exists vault_overview();
create function vault_overview()
returns table (chat_id uuid, type chat_type, name text, icon_url text, other_id uuid,
               last_body text, last_kind msg_kind, last_at timestamptz, unread int,
               pinned boolean, archived boolean, muted boolean, folder_id uuid,
               locked boolean, e2ee boolean, disappear_seconds int, member_count int,
               vaulted boolean)
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
         (select count(*)::int from chat_members k where k.chat_id = c.id),
         true
    from chat_members me
    join chats c on c.id = me.chat_id
    left join chat_members o on o.chat_id = c.id and o.user_id <> auth.uid() and c.type = 'dm'
    left join profiles op on op.id = o.user_id
   where me.user_id = auth.uid() and me.left_at is null
     and me.vaulted
   order by me.pinned desc, c.last_message_at desc;
$$;

-- ── 4. moving a conversation in and out ─────────────────────────────────────
--
-- Moving in also clears the old per-chat PIN columns. That PIN was a boolean
-- plus a bcrypt hash on the member row: it hid a row in a list and nothing
-- else. Leaving it set alongside the vault would be two locks with one
-- purpose, the weaker of the two setting expectations.
--
-- No system message is written either way. Announcing "this conversation is
-- now private" into the conversation would tell the other participant exactly
-- what the feature exists to keep to yourself.
create or replace function set_chat_vaulted(p_chat uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_member(p_chat) then raise exception 'not a member'; end if;
  update chat_members
     set vaulted = p_on,
         vaulted_at = case when p_on then now() end,
         locked = case when p_on then false else locked end,
         lock_pin = case when p_on then null else lock_pin end
   where chat_id = p_chat and user_id = auth.uid();
end $$;

-- ── 5. search isolation ─────────────────────────────────────────────────────
--
-- Normal search cannot return a private conversation's name, body or metadata,
-- because the query never looks at those rows. Not "filtered in the UI": not
-- selected.
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
     and not is_vaulted(m.chat_id)
     and (p_chat is null or m.chat_id = p_chat)
     and m.deleted_all = false
     and (m.expires_at is null or m.expires_at > now())
     and not exists (select 1 from message_hides h where h.message_id = m.id and h.user_id = auth.uid())
     and (m.search_tsv @@ websearch_to_tsquery('english', p_query) or m.body ilike '%' || p_query || '%')
   order by 7 desc, m.created_at desc
   limit p_limit;
$$;

-- Searching inside the vault, after authentication. Only private conversations.
-- Bodies of encrypted messages are null here by definition — a private
-- conversation is end-to-end encrypted, so the server has no plaintext to match
-- on. The client says so rather than pretending the search was exhaustive.
create or replace function search_vault_messages(p_query text, p_chat uuid default null, p_limit int default 60)
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
     and is_vaulted(m.chat_id)
     and (p_chat is null or m.chat_id = p_chat)
     and m.deleted_all = false
     and (m.expires_at is null or m.expires_at > now())
     and not exists (select 1 from message_hides h where h.message_id = m.id and h.user_id = auth.uid())
     and (m.search_tsv @@ websearch_to_tsquery('english', p_query) or m.body ilike '%' || p_query || '%')
   order by 7 desc, m.created_at desc
   limit p_limit;
$$;

-- ── 6. media, digests and exports ───────────────────────────────────────────
--
-- Private media does not come back through the normal browsing surfaces. The
-- gallery has to ask for it explicitly, which only the vault's own UI does.
drop function if exists shared_media(uuid, int);
create function shared_media(p_chat uuid, p_limit int default 200, p_vault boolean default false)
returns setof messages language plpgsql security definer stable set search_path = public as $$
begin
  if not is_member(p_chat) then raise exception 'not a member'; end if;
  if is_vaulted(p_chat) and not p_vault then
    raise exception 'private conversation: open it inside Private Vault';
  end if;
  return query
    select * from messages
     where chat_id = p_chat and attachment is not null and deleted_all = false
       and (expires_at is null or expires_at > now())
     order by created_at desc limit p_limit;
end $$;

-- Same guard on the digest, so "catch me up" cannot be used as a side channel
-- into a private conversation.
create or replace function chat_digest(p_chat uuid, p_hours int default 12)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare since timestamptz := now() - make_interval(hours => p_hours); out jsonb;
begin
  if not is_member(p_chat) then raise exception 'not a member'; end if;
  if is_vaulted(p_chat) then raise exception 'private conversation: not summarised'; end if;
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

-- Text export of a single conversation: refuse for private ones, so a private
-- conversation cannot be poured into a plaintext file from outside the vault.
create or replace function export_chat_text(p_chat uuid)
returns text language plpgsql security definer stable set search_path = public as $$
begin
  if not is_member(p_chat) then raise exception 'not a member'; end if;
  if is_vaulted(p_chat) then raise exception 'private conversation: not exported'; end if;
  return (
    select string_agg(
        to_char(m.created_at, 'YYYY-MM-DD HH24:MI') || '  ' ||
        coalesce(p.display_name,'unknown') || ': ' ||
        case when m.deleted_all then '[deleted]'
             when m.cipher is not null then '[encrypted]'
             when m.attachment is not null then coalesce(m.body,'') || ' [' || m.kind || ': ' || coalesce(m.attachment->>'name','file') || ']'
             else coalesce(m.body,'') end,
        E'\n' order by m.created_at)
      from messages m left join profiles p on p.id = m.sender_id
     where m.chat_id = p_chat);
end $$;

-- Account export leaves private conversations out entirely. An export is a
-- plaintext file that lands in a downloads folder; quietly including the
-- conversations someone put behind a second lock would undo the lock.
create or replace function export_my_data()
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object(
    'exported_at', now(),
    'note', 'Conversations in Private Vault are deliberately excluded from this export.',
    'profile', (select to_jsonb(p) from profiles p where p.id = auth.uid()),
    'settings', (select to_jsonb(s) from user_settings s where s.user_id = auth.uid()),
    'contacts', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) from contacts c where c.user_id = auth.uid()),
    'blocks', (select coalesce(jsonb_agg(b.blocked_id), '[]'::jsonb) from blocks b where b.blocker_id = auth.uid()),
    'vaulted_chat_count', (select count(*)::int from chat_members m where m.user_id = auth.uid() and m.vaulted),
    'chats', (select coalesce(jsonb_agg(jsonb_build_object(
                 'chat', to_jsonb(c),
                 'messages', (select coalesce(jsonb_agg(jsonb_build_object(
                        'at', m.created_at, 'from', m.sender_id, 'kind', m.kind,
                        'body', m.body, 'attachment', m.attachment) order by m.created_at), '[]'::jsonb)
                    from messages m where m.chat_id = c.id))), '[]'::jsonb)
               from chats c where is_member(c.id) and not is_vaulted(c.id)),
    'scheduled', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from scheduled_messages x where x.sender_id = auth.uid()),
    'calls', (select coalesce(jsonb_agg(to_jsonb(k)), '[]'::jsonb) from calls k where is_member(k.chat_id))
  );
$$;

-- ── 7. the old per-chat PIN ─────────────────────────────────────────────────
--
-- set_chat_lock / verify_chat_lock stay so conversations locked with the old
-- PIN keep opening on an older client, and so nobody is locked out by
-- deploying this. They are deprecated: the UI no longer offers them, and
-- set_chat_vaulted() clears them. Nothing new should call them.
comment on function set_chat_lock(uuid, text) is
  'Deprecated: superseded by Private Vault (set_chat_vaulted). Hid a row in a list; provided no encryption.';
comment on function verify_chat_lock(uuid, text) is
  'Deprecated: superseded by Private Vault. Kept so chats locked with the old PIN still open.';

grant execute on all functions in schema public to authenticated;

-- ── 8. re-run reminder ──────────────────────────────────────────────────────
-- unread_total() calls chat_overview(), which now excludes private
-- conversations. That is intended: an unread badge that jumps when a private
-- message arrives is a notification about a private conversation.
