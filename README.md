# Wisp

A messaging app on Supabase: Postgres + RLS + Realtime + Storage + Auth + Edge
Functions, with a dependency-free ES-module frontend that deploys to Vercel as
a static site plus one serverless function. No build step, no bundler, no
`node_modules`. Every file is editable from GitHub's web UI.

The name is Wisp throughout: UI, manifest, README.

```
index.html            app shell
styles.css            design system (OKLCH tokens, all themeable at runtime)
sw.js                 service worker: shows pushes, handles notification clicks
manifest.webmanifest  PWA manifest
api/config.js         Vercel function: hands the client SUPABASE_URL + anon key + ICE servers
js/env.js             config resolution (+ local fallback)
js/db.js              Supabase client, query/RPC/storage/realtime helpers
js/state.js           app state + tiny pub/sub
js/auth.js            sign up/in, reset, two-step PIN, sessions, presence
js/crypto.js          optional per-chat E2EE (WebCrypto)
js/theme.js           settings -> CSS custom properties
js/chats.js           chat list, folders/tabs, realtime, per-chat controls
js/thread.js          message rendering, ticks, reactions, pins, forwarding
js/composer.js        sending, media staging, voice notes, polls, scheduling
js/media.js           client-side compression, poster frames, uploads
js/calls.js           WebRTC 1:1 + small mesh, signaling over Postgres
js/panels.js          chat details, digest, saved, scheduled, people, search
js/settings.js        every customization surface, incl. the OKLCH picker
js/notify.js          local notifications, sounds, device registration
js/app.js             boot + routing
supabase/schema.sql   everything: tables, indexes, RLS, RPCs, triggers, buckets, cron
supabase/functions/push-notify     FCM HTTP v1 sender (fires on message insert)
supabase/functions/link-preview    OpenGraph fetch + cache
```

## Setup order

### 1. Supabase
1. Create a project.
2. SQL Editor -> paste `supabase/schema.sql` -> Run. It is safe to run once,
   top to bottom, and safe to re-run (policies are dropped and recreated,
   tables use `if not exists`).
3. Authentication -> Providers -> keep **Email** on. For quick two-account
   testing you can turn **Confirm email** off; leave it on for real use.
4. Authentication -> URL Configuration -> Site URL = your Vercel URL (and
   `http://localhost:*` if you serve locally). Add
   `https://your-app.vercel.app` to Redirect URLs so password reset returns to
   the app.
5. Copy Project URL and the **anon** key from Settings -> API.

### 2. GitHub
```bash
git init && git add . && git commit -m "Wisp v1"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```
Phone-only: use **Add file -> Upload files** in the GitHub web UI. Keep the
directory structure.

### 3. Vercel
1. Import the repo.
2. Framework preset: **Other**. Build command: leave empty. Output directory:
   leave empty (root is served as-is; `api/config.js` is picked up
   automatically as a serverless function).
3. Environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, plus the
   optional TURN/STUN keys from `env.example`.
4. Deploy. Every later `git push` to `main` redeploys.

If `/api/config` is unavailable (e.g. serving the folder from any static
host), the app shows a setup screen where you can paste the URL and anon key;
they are stored in that browser only.

### 4. Edge Functions
```bash
supabase link --project-ref <ref>
supabase secrets set SERVICE_ROLE_KEY=<service role key>
supabase functions deploy link-preview
supabase functions deploy push-notify --no-verify-jwt
```
For pushes, also:
```bash
supabase secrets set FCM_PROJECT_ID=... FCM_CLIENT_EMAIL=... FCM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

### 5. TURN for calls
STUN alone connects on most home networks. Behind symmetric NAT or CGNAT you
need a relay. Either run coturn:
```
# /etc/turnserver.conf
listening-port=3478
fingerprint
lt-cred-mech
user=wisp:<strong-password>
realm=your.domain
external-ip=<public-ip>
```
or use a hosted TURN service. Put the URL and credentials in the Vercel env
vars; `/api/config` passes them to the browser as ICE servers.

## Manual dashboard steps (nothing here is doable from SQL alone)

1. **Realtime**: Database -> Replication -> make sure the `supabase_realtime`
   publication exists. Section 7 of the schema adds the tables to it and prints
   a notice if the publication is missing.
2. **Extensions**: Database -> Extensions -> enable **pg_cron** (required for
   disappearing-message purges and scheduled sends), then re-run section 9 of
   the schema. `pg_net` is only needed if you prefer calling the push function
   from SQL instead of a webhook.
3. **Storage**: the schema inserts the five buckets. Confirm `media` and
   `voice` are **private** and `avatars`, `wallpapers`, `sounds` are **public**
   in Storage -> Buckets.
4. **Database webhook for push**: Database -> Webhooks -> Create -> table
   `public.messages`, event `INSERT`, type `Supabase Edge Functions`, function
   `push-notify`. Without this, pushes only happen while a tab is open.
5. **Auth URL configuration**: Site URL + Redirect URLs (step 1.4 above).
6. **FCM credentials**: Firebase console -> Project settings -> Service
   accounts -> generate a private key, then set the three `FCM_*` secrets.
7. **TURN credentials**: created wherever you host the relay, set in Vercel.
8. **Email templates** (optional): Authentication -> Emails, if you want the
   verification and reset mails to say Wisp.

## What is real, and where the line is

Everything in the feature list below is wired end to end: table -> RLS ->
client call -> realtime -> UI. The honest exceptions:

- **iOS lock-screen ringing.** Needs native CallKit + PushKit in a real iOS
  app. Impossible from a web codebase. Android high-priority FCM is wired and
  will wake a closed app; iOS gets a normal notification, not a ring.
- **Group calls above 4 participants.** Mesh is implemented (one peer
  connection per participant, capped at 4). Past that you need an SFU
  (LiveKit, mediasoup). Not built, and the UI refuses instead of degrading.
- **Web push tokens.** The device table, service worker, push payloads and the
  FCM sender are all real. Minting a *browser* FCM token requires the Firebase
  JS SDK and a VAPID key pair, which is a keys-and-dashboard step, not code:
  until you add it, `devices.token` holds a local id and the function logs
  what it would have sent rather than faking a delivery.
- **E2EE is deliberately modest.** Per-chat AES-256-GCM key, wrapped per
  member with RSA-OAEP-2048; the private key is wrapped with a PBKDF2 key from
  your password, so the server never sees it. There is **no forward secrecy,
  no post-compromise security, no ratchet, and no safety-number
  verification**. It is not the Signal protocol and does not pretend to be.
  Consequences: server-side full-text search and the SQL digest cannot read
  encrypted chats, and a password reset makes old encrypted messages
  unreadable. Both are surfaced in the UI.
- **Two-step verification** is a bcrypt-checked PIN gating the app on load. It
  is a second gate, not a second factor on the Supabase session.
- **Chat lock** is a PIN. Real biometrics need WebAuthn plus a platform
  authenticator; not shipped.
- **Voice-note transcription and smart replies** are not shipped. Both need a
  speech/LLM service, and a fake would be worse than nothing. Inline
  translation uses the browser's built-in on-device `Translator` API where it
  exists and says so plainly where it does not.
- **Video compression** is not done client-side (browsers cannot transcode
  reliably). Images are re-encoded to WebP within 1600px, videos keep their
  bytes and get a poster frame, and the per-account size cap is enforced.

## Feature map

**Accounts** email/password, verification, reset, profile name/photo/about,
device list, log out of all devices, data export (JSON), account deletion.
**People** search by name or email, presence with per-field visibility,
block/unblock enforced in RLS, report, favourites, per-contact nicknames.
**1:1** realtime, optimistic send, typing, sending/sent/delivered/read/failed
ticks, read-receipt toggle, pin/mute (8h/1w/always)/archive/clear/delete,
wallpapers per chat and global, stars, multi-select forward and delete,
reply-and-jump, edit inside 15 min, delete-for-me vs delete-for-everyone
inside 1h, in-chat and cross-chat search, reactions, link unfurling, mentions.
**Groups** roles, add/remove, leave, system messages, invite links with reset,
three permission switches, broadcast lists (fan-out to DMs so replies stay
private), polls.
**Media** photos/videos with captions, multi-send, camera capture, any-type
documents with a size cap, in-app voice notes with waveform and 1/1.5/2x
playback, per-chat gallery, client-side image compression, view-once, sticker
pack, static and live location with expiry, contact cards, inline PDF preview.
**Calls** 1:1 and mesh audio/video, mute, camera toggle, screen share, timer,
history with durations and missed indicators, adaptive bitrate that steps down
instead of freezing.
**Notifications** device table, Edge Function on insert, per-chat levels,
preview privacy, unread badge (incl. `setAppBadge`).
**Privacy** optional E2EE, four visibility controls, two-step PIN,
disappearing messages (off/1h/24h/7d/90d + default for new chats, enforced by
RLS and a purge job), Postgres-trigger rate limiting (25/10s, 300/h).
**Customization** eight accents plus a from-scratch OKLCH picker,
light/dark/system, four typefaces, three densities, text scale with live
preview, bubble radius, wallpapers with opacity and blur, per-contact accent
and nickname, notification sounds incl. custom upload, reduce motion, high
contrast, animation speed, user-defined chat tabs. All of it in
`user_settings`, so it follows the account across devices.
**Beyond WhatsApp** scheduled and recurring sends invisible to the recipient
until dispatch, SQL "catch me up" digest, app-wide focus mode with quiet
hours, cross-chat full-text search, per-chat PIN lock, pinned-messages list
separate from stars, bookmarks with notes, conversation export to text or PDF,
screen sharing.

## Manual test checklist

Two browser profiles, two accounts (A and B). One line per feature.

1. **Sign up** Create A in profile 1. If "Confirm email" is on, click the link, then sign in.
2. **Verification/reset** Click "Forgot password" for A, open the mail, set a new password, sign in with it.
3. **Profile** Set A's display name, about and photo. Reload: all three persist.
4. **People search** From B, search A by exact email and by partial name. Both hit.
5. **Start a DM** Open A from B's results. A chat appears in both lists.
6. **Realtime send** Send from A. It appears in B within ~1s without a reload.
7. **Ticks** Watch A's message go ✓ then ✓✓ then blue ✓✓ when B's tab is focused.
8. **Read receipts off** Turn them off for B, send from A: it stops at grey ✓✓.
9. **Typing** Type in B without sending. A's header shows "…is typing" and clears after ~6s.
10. **Optimistic send** Throttle A's network to slow 3G, send: the bubble shows ◌ immediately, then ✓.
11. **Reply** Reply to a message, click the quote, the view jumps to the original and flashes.
12. **Edit** Edit your own message inside 15 min: "edited" appears for both. Try a message older than 15 min: rejected.
13. **Delete for me** Delete-for-me one of B's messages from A: gone for A, still there for B.
14. **Delete for everyone** Delete your own recent message: both sides show "This message was deleted".
15. **Reactions** React 👍 from B: the pill appears on both. Tap again to remove.
16. **Star** Star a message, open Saved in the rail, click the entry, it jumps to the message.
17. **Bookmark** Bookmark with a note, check it under Saved -> Read later.
18. **Pin message** Pin one: the strip appears above the thread for both, click it for the pinned list.
19. **Multi-select** Long-press/select 3 messages, forward them to another chat, then bulk-delete.
20. **Forward** Forward a single message to two chats at once, confirm both received it.
21. **Search in chat** Magnifier in the header, search a word, click a hit, it jumps.
22. **Global search** Search the same word from the list pane: matches across every chat, with people above.
23. **Mentions** In a group, type `@Name`, pick from the popup, send. The `mentions` row exists and the mention count shows in the digest.
24. **Link preview** Send `https://supabase.com`, a title/description card renders and `link_previews` gains a row.
25. **Photo** Send a photo with a caption. Check the uploaded object is WebP and smaller than the original.
26. **Video** Send a short video: poster frame shows, tapping play streams it.
27. **Document** Send a PDF: inline preview opens in the modal. Send a .zip: it downloads.
28. **Size cap** Set the cap to 4 MB, try a bigger file: refused with a message, nothing uploads.
29. **Voice note** Hold the mic, talk 3s, Send. Waveform renders, playback works, 1x/1.5x/2x cycles.
30. **View once** Send a photo with view-once on, open it as B, reload: shows "Opened", the image is gone.
31. **Gallery** Chat details -> Shared media: every image and file from the chat is listed.
32. **Camera** Attach -> Camera on a phone: the capture opens and the shot sends.
33. **Sticker** Attach -> Sticker: it sends as a large glyph, not a text bubble.
34. **Location** Attach -> Location -> current pin: the link opens the right coordinates.
35. **Live location** Share live for 15 min: `live_locations.updated_at` advances as you move; after expiry the purge job removes it.
36. **Contact card** Share a contact, tap Message on B's side, it opens a DM with that person.
37. **Poll** Create a poll with 3 options, vote from both accounts, bars and counts update live.
38. **Group** Create a group with A and B, confirm the "created this group" system message in both.
39. **Roles** Promote B to admin from A, then demote. The role label updates.
40. **Remove/leave** Remove B: system message appears, the group vanishes from B's list. Re-add and have B leave.
41. **Invite link** Copy the link, open it in a third profile, it joins and posts a system message.
42. **Revoke invite** Reset the link, then try the old one: rejected.
43. **Permissions** Set "who can message" to admins only: B's send fails with a policy error, A's works.
44. **Broadcast** Create a broadcast list with two members, send: each gets it in their own DM, and a reply lands only in that DM.
45. **Pin chat** Pin a chat: it sorts to the top and stays pinned after reload.
46. **Mute** Mute for 8h: no sound or popup on a new message, unread count still increments.
47. **Archive** Archive a chat: it moves to the Archived tab and returns to the top on the next message.
48. **Clear history** Clear from A: A's thread is empty, B's is untouched.
49. **Delete chat** Delete a DM from A: it disappears for A only.
50. **Tabs** Create a "Work" tab, move a chat into it, reload: the chat is still in that tab.
51. **Unread tab** Open the Unread tab with unread chats present: only those show.
52. **Badge** Leave the tab, receive 3 messages: title shows `(3)` and the rail badge shows 3.
53. **Wallpaper (global)** Upload one in Settings: it appears behind every thread, with opacity and blur applied.
54. **Wallpaper (per chat)** Set a different one in chat details: it overrides only there.
55. **Accent preset** Pick Moss: bubbles, buttons and rail selection all recolor immediately.
56. **Custom color** Drag the OKLCH picker, reload the page: the exact color persists (it is in the DB, not localStorage).
57. **Cross-device persistence** Sign in as A in a *third* browser: theme, font, density, text size all match without touching anything.
58. **Density and text size** Switch to Compact and 130%: rows shrink, text grows, and the preview bubble tracks it live.
59. **Typeface** Switch to Newsreader: the whole app changes typeface.
60. **Bubble radius** Drag it to 2px and 26px: bubbles change shape.
61. **Per-contact accent** Set a chat accent for B: the accent changes only while that chat is open.
62. **Nickname** Set a nickname for B: it shows everywhere for A, and B never sees it.
63. **Accessibility** Toggle reduce-motion (animations stop), high-contrast (borders darken), animation speed 2x.
64. **Notification sound** Pick Knock, hit Test, hear it. Upload a custom tone and confirm it is stored per account.
65. **Preview privacy** Set "Just New message", receive one with the tab hidden: the popup shows no sender or text.
66. **Per-chat notify level** Set a group to Mentions only: a plain message is silent, `@you` notifies.
67. **Focus mode** Turn it on: no sounds or popups anywhere, unread counts still climb. Set quiet hours around now for the same effect.
68. **Presence** With B's tab open, A sees "online"; close it and A sees "last seen …".
69. **Presence privacy** Set B's last-seen to Nobody: A sees no last-seen at all (checked in SQL, not hidden in the UI).
70. **Photo/about privacy** Set both to Nobody: A's copy of B's card loses the photo and about text.
71. **Block** Block A from B: A's send fails at the policy level; the message never lands in the table.
72. **Unblock** Unblock from the blocked list, sending works again.
73. **Report** Report a message and a user: two rows in `reports`, each visible only to the reporter.
74. **Disappearing** Set 1 hour on a chat, send, then run `select purge_expired_messages();` after adjusting `expires_at` back: the message vanishes from both sides.
75. **Default disappearing** Set 24h as the default, start a new DM: the timer is already on.
76. **Rate limit** Loop 30 sends in ~5s: the 26th errors with `rate_limit`, and nothing extra is stored.
77. **Two-step PIN** Set one, reload: the PIN gate blocks the app until it is correct.
78. **Chat lock** Lock a chat with a PIN, reload, open it: the PIN is required first.
79. **E2EE** Turn encryption on in a chat, send from A: B reads it, while `select body, cipher from messages` shows a null body and ciphertext.
80. **E2EE limits** Search for that message globally: no hit, with the reason shown. Confirm the digest also skips it.
81. **Scheduled send** Schedule one 2 minutes out. Confirm B sees nothing (`select * from messages` has no row), then after `dispatch_scheduled_messages()` runs it appears for both.
82. **Recurring** Schedule a daily one, dispatch it, and confirm `send_at` advanced by a day instead of being marked sent.
83. **Edit/cancel schedule** Edit the body and time from the Scheduled view, then cancel one: status becomes `cancelled` and nothing sends.
84. **Digest** Trade 20 messages including two questions and a link, then hit "Catch me up": totals, most-active, sparkline, unanswered questions and links all match.
85. **Export chat** Export a conversation to .txt and check the timestamps, then Print/PDF.
86. **Export account** Settings -> Export my data: the JSON contains profile, settings, contacts, chats and messages.
87. **Devices** Check the device list shows both browsers, then "Log out of all devices" and confirm both sessions end.
88. **Account deletion** On a throwaway account, delete it: the profile is gone, its messages are wiped, and sign-in fails.
89. **Voice call** Call A -> B, accept, talk both ways, mute (the other side goes quiet), hang up. A call entry appears with a duration.
90. **Video call** Same with video: camera toggle blanks your feed on their side.
91. **Screen share** During a video call, share a tab: the other side sees the screen, stop it and the camera comes back.
92. **Missed call** Call and do not answer for 45s: both sides log a missed call, shown in red under Calls.
93. **Adaptive bitrate** Throttle to slow 3G mid-call: the quality label steps down (excellent -> poor) and video keeps moving instead of freezing.
94. **Mesh limit** Try a call in a 5-person group: refused with the SFU explanation, no half-broken call.
95. **Realtime resilience** Kill the network for 20s and restore it: new messages arrive again without a reload.
96. **Storage RLS** Copy a `media/<chat_id>/...` path and try `createSignedUrl` as a non-member: denied.
97. **Table RLS** In the SQL editor, `set role authenticated` with a foreign `sub` and select from `messages`: zero rows for chats you are not in.
98. **Push webhook** With the webhook and FCM keys configured, send with every tab closed: the notification arrives. Without keys, the function logs what it would have sent.
99. **Offline queue check** Send while offline: the bubble shows a failure marker rather than silently vanishing.
100. **Reload state** Reload mid-conversation: scroll position lands at the bottom, unread counts, pins, stars and theme all survive.
