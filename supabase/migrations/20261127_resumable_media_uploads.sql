-- Raises the `media` bucket's real file-size ceiling to match what the
-- client now actually supports.
--
-- Before this, the Settings screen let someone set their media cap as high
-- as 200MB, but the `media` bucket itself was created with
-- file_size_limit = 104857600 (100MB) — so a cap above 100MB was a setting
-- that silently lied: the client would accept the file, then Storage would
-- reject the upload. The client used a single plain PUT for every upload
-- too, which Supabase's non-resumable Storage endpoint caps well below even
-- that 100MB in practice.
--
-- js/upload.js switches uploads to Storage's resumable (TUS) endpoint —
-- chunked and parallel — which is both faster on a real connection and the
-- thing that makes a meaningfully higher ceiling actually safe to raise. This
-- migration raises the bucket limit to 500MB to match the new Settings
-- slider max (js/settings.js). Pick a different number here first if your
-- Supabase project's own plan has a lower per-file or total-storage ceiling
-- than that — this migration can't see your plan's limits, only the
-- bucket's own setting.
--
-- Run this once in the SQL editor (Supabase → SQL Editor → New query). It is
-- idempotent: re-running it just sets the same limit again.

update storage.buckets
set file_size_limit = 524288000 -- 500MB
where id = 'media';
