-- Per-chat appearance overrides.
--
-- chat_members already carried wallpaper_url, so a chat could have its own
-- backdrop, but a per-chat *colour* could only be expressed through
-- contacts.accent — which exists per contact, so it worked for DMs and was
-- impossible for groups. And the dim applied to a wallpaper was a single
-- account-wide number, so one dark photo forced every other chat dark too.
--
-- Both are nullable on purpose: null means "inherit", which is what lets the
-- client resolve appearance as chat → contact (DMs only) → account without
-- needing a separate "is overridden" flag.
--
-- No policy changes: RLS here is per row, and a member could already update
-- their own chat_members row, which is how wallpaper_url has always worked.

alter table public.chat_members
  add column if not exists accent text,
  add column if not exists wallpaper_dim numeric;

comment on column public.chat_members.accent is
  'Per-chat accent override, stored as an oklch(l c h) string. Null means fall back to the contact accent (DMs) and then the account accent.';
comment on column public.chat_members.wallpaper_dim is
  'Per-chat wallpaper dim, 0..1. Null means fall back to the account wallpaper opacity.';
