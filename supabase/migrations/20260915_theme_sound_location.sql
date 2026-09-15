-- Appearance, notification sounds and location previews.
--
-- Four of the five things this migration adds exist because the client was
-- already writing to columns that were never created. Supabase returns an error
-- for an unknown column, saveSettings() swallowed it, and the UI had already
-- painted the new value optimistically — so the setting appeared to work and
-- was gone on the next reload. That is the whole story behind "I change it and
-- nothing happens".
--
-- Run this once in the SQL editor (Supabase → SQL Editor → New query). It is
-- idempotent: every statement is `if not exists` or a plain update, so running
-- it twice changes nothing the second time.

-- ── 1. account settings ───────────────────────────────────────────────────
alter table public.user_settings
  -- js/settings.js has offered a Call sound picker since day one and
  -- js/notify.js reads S.settings.call_sound in playCallTone(). The column was
  -- never in schema.sql, so every write failed with 42703 and every ringtone
  -- silently fell back to the built-in 'ring'.
  add column if not exists call_sound      text    not null default 'ring',

  -- App-wide theme pack: the neutral ramp for every surface in the app, light
  -- and dark. Values are the ids in js/theme.js THEME_PACKS; the palettes
  -- themselves live in theme-packs.css. Text, not an enum, so adding a pack is
  -- a stylesheet change and not a migration.
  add column if not exists theme_pack      text    not null default 'cream',

  -- Whether received bubbles take the chat accent as well as sent ones. The
  -- account-wide default; chat_members.accent_incoming overrides it per chat.
  add column if not exists accent_incoming boolean not null default false,

  -- Playback volume for notification tones, 0..1. Matters most for uploaded
  -- files, which arrive at whatever level they were mastered at.
  add column if not exists notif_volume    numeric not null default 0.8;

alter table public.user_settings
  drop constraint if exists user_settings_notif_volume_range;
alter table public.user_settings
  add constraint user_settings_notif_volume_range check (notif_volume >= 0 and notif_volume <= 1);

comment on column public.user_settings.call_sound is
  'Ringtone: a key from CALL_TONES in js/notify.js, ''none'', or a path in the sounds bucket for an uploaded file.';
comment on column public.user_settings.theme_pack is
  'App-wide theme pack id (see THEME_PACKS in js/theme.js). Independent of theme_mode: a pack defines both its light and its dark ramp.';
comment on column public.user_settings.accent_incoming is
  'Default for whether received bubbles are tinted with the accent. Per-chat override lives in chat_members.accent_incoming.';
comment on column public.user_settings.notif_volume is
  'Notification volume, 0..1. Applied to synthesized tones and uploaded files alike.';

-- ── 2. per-chat appearance ────────────────────────────────────────────────
-- Both nullable: null means "inherit the account setting", which is what lets
-- the client resolve appearance as chat → contact (DMs) → account without a
-- separate "is overridden" flag. Same pattern as accent and wallpaper_dim in
-- 20260910_chat_members_appearance.sql.
alter table public.chat_members
  add column if not exists font_family     text,
  add column if not exists accent_incoming boolean;

comment on column public.chat_members.font_family is
  'Per-chat typeface override: a key from FONTS in js/theme.js. Null inherits user_settings.font_family. Only the conversation column reads it, so one chat can differ from the rest of the app.';
comment on column public.chat_members.accent_incoming is
  'Per-chat override for tinting received bubbles with the chat accent. Null inherits user_settings.accent_incoming.';

-- No policy changes: RLS on chat_members is per row and a member could already
-- update their own row, which is how wallpaper_url has always worked.

-- ── 3. the sounds bucket ──────────────────────────────────────────────────
-- The real reason custom notification sounds "disappeared". The bucket was
-- capped at 2 MB while the picker allowed 5 MB, so any ordinary song-length
-- file was accepted by the client, uploaded, and rejected by storage. 8 MB
-- comfortably covers a trimmed tone or a full track at a sane bitrate, and the
-- client constant (SOUND_MAX_BYTES in js/settings.js) now matches exactly.
--
-- allowed_mime_types is set for the first time: without it a mistyped image
-- could be stored as a "sound" and then fail to play, with nothing anywhere
-- explaining why.
update storage.buckets
   set file_size_limit = 8388608,
       public = true,
       allowed_mime_types = array[
         'audio/mpeg','audio/mp3','audio/mp4','audio/m4a','audio/x-m4a','audio/aac',
         'audio/wav','audio/x-wav','audio/wave','audio/ogg','audio/opus','audio/webm','audio/flac'
       ]
 where id = 'sounds';

-- ── 4. live location realtime ─────────────────────────────────────────────
-- live_locations was written to and never read back: the location bubble was a
-- line of coordinates, so a moving pin had nowhere to move. js/mapview.js now
-- subscribes to UPDATEs on this table per message, which requires the table to
-- be in the realtime publication. Wrapped because adding a table that is
-- already published raises, and because the publication itself may not exist on
-- a project where replication was never switched on.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.live_locations;
    exception
      when duplicate_object then null;
      when others then raise notice 'live_locations already published, or could not be added: %', sqlerrm;
    end;
  else
    raise notice 'supabase_realtime publication is missing — enable Database → Replication first, then re-run this section.';
  end if;
end $$;

-- A live pin is read by message_id on every render of a thread that contains
-- one. Primary key already covers the lookup; this covers the purge job's scan
-- for expired shares, which had no index at all.
create index if not exists live_locations_expires_idx
  on public.live_locations (expires_at)
  where live = true;
