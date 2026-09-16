# Test plan — chat lock and group calls

Two features, one branch. This is the plan first, then what running it actually
found, then the part only a human with two phones can do.

Run the automated half with:

```bash
node tests/run.js            # everything
node tests/run.js lockcore   # one file
VERBOSE=1 node tests/run.js  # list every passing case too
```

No `npm install`, no dev dependencies — same rule as the rest of the app.

**Current result: 190 cases, 0 failures, 4 files.**

| File | What it covers | Cases |
|---|---|---|
| `tests/lockcore.test.js` | every chat-lock rule: PIN validation, cooldown ladder, previews, notification redaction, relock policy, search scoping | 40 |
| `tests/callcore.test.js` | capacity, polite/initiator roles, roster reducer, grid, speaking hysteresis, bitrate ladder, signal validation and acceptance, copy | 47 |
| `tests/mesh.test.js` | a simulated 3–4 person room: who connects to whom, who offers, late join, leave, rejoin, hostile signals | 14 |
| `tests/static.test.js` | the shipped files themselves: syntax, imports resolve, every `$('#id')` exists, every `rpc()` exists, migration is idempotent, and the rules written twice (JS + SQL) agree | 89 |

## What is genuinely tested, and what is not

Tested for real, in Node, every run:

* every pure decision the two features make (`js/lockcore.js`, `js/callcore.js`),
* the mesh algorithm end to end, against a fake signal bus and a fake server,
* the files as shipped: an import that does not resolve, an element id that is
  not in `index.html`, an RPC name no migration defines, a class the CSS never
  styles — all of these fail the suite,
* cross-language drift: the cooldown ladder, the call capacity, the PIN shape,
  the relock modes and the heartbeat window all exist in both JS and SQL, and
  the tests parse the SQL and compare it to the JS.

Not tested by the suite, and honestly cannot be here:

* **real media.** No browser, no camera, no `RTCPeerConnection` in the sandbox.
  Whether Chrome and Safari actually exchange audio is the manual pass below.
* **Postgres.** No database in the sandbox either, so `verify_chat_lock()`,
  `join_call()` and the RLS policies are reviewed and mirrored, not executed.
  The migration ships a self-check query at the bottom for exactly this reason.
* **Push delivery.** Needs FCM credentials and a real device.

Anything in the manual list has an expected output written next to it, so a
disagreement is a bug report rather than a shrug.

---

# 1. Chat lock

## 1.1 Normal cases

| # | Case | Expected output | Where |
|---|---|---|---|
| L1 | Set a PIN on a chat (`4820`), typed twice | Chat shows a padlock in the list; a Locked tab appears | manual + `lock: normal` |
| L2 | Reopen the chat | PIN pad first, chat only after the right PIN | manual |
| L3 | Right PIN | Pad closes, thread opens, attempt counter resets to 0 | manual, `verify_chat_lock` returns `{ok:true}` |
| L4 | Chat list row for a locked chat | Preview reads exactly `Locked chat` — never the message | auto: `previewFor` |
| L5 | Unlock, then look at the list | Real preview is back for this session | auto |
| L6 | Change the PIN | Current PIN asked first, then new one twice | manual |
| L7 | Remove the lock | Current PIN asked; padlock and Locked tab disappear | manual |
| L8 | Relock choice = "when the app is closed" | Chat stays open all session; reload asks again | auto: `relockDue('session')` + manual reload |
| L9 | Relock choice = "as soon as I leave" | Closing the chat or backgrounding the app relocks it | auto: `relockDue('immediate', away)` |
| L10 | Relock choice = 1m / 15m | Relocks that long after you were last in it | auto: boundary at 59.999s vs 60s |
| L11 | Notification from a locked chat | Title `Wisp`, body `Message in a locked chat`, no name, no text | auto: `notifyPayload` |
| L12 | Tap that notification | Opens the app, does **not** deep-link into the chat; PIN gate first | code path in `notify.js` |
| L13 | Global search for a word that is only in a locked chat | No hit, with the reason shown under the results | auto: `searchableUnlocked` + SQL filter |
| L14 | Unlock the chat, search again | Hit appears | auto |
| L15 | Starred message from a locked chat, in Saved | Row reads `In a locked chat`, no sender, no text | code path in `panels.js` |

## 1.2 Edge cases

| # | Case | Expected output |
|---|---|---|
| L16 | Attachment with no caption in a locked chat | Still `Locked chat`, not `Photo` (auto) |
| L17 | Chat that is both locked and encrypted | `Locked chat` wins over `Encrypted message` (auto) |
| L18 | Empty chat, no lock | `No messages yet` (auto) |
| L19 | Unknown relock mode in the DB (hand-edited row) | Degrades to "session", never to "never lock" (auto) |
| L20 | Unlocked at epoch 0 | Treated as a real timestamp, not as "never unlocked" (auto — this was a real bug, see §4) |
| L21 | A chat that vanished (left the group) while unlocked | Sweep drops it quietly, no crash (auto) |
| L22 | `hide_preview` off but chat locked | List shows the preview; the notification is **still** redacted (auto) |
| L23 | `hide_in_list` on | Chat appears only under the Locked tab, including in Unread (auto) |
| L24 | Cancel the PIN pad | Nothing opens, previous screen untouched, no attempt counted (manual) |
| L25 | Two tabs, one account, same chat | Unlocking in one does not unlock the other (in-memory per tab, manual) |
| L26 | Reload while a chat is unlocked | Asks again — a reload is an app restart as far as a lock goes (manual) |
| L27 | Lock a chat, then be removed from that group | Lock row goes with the membership; nothing to unlock (manual) |

## 1.3 Invalid inputs

| # | Input | Expected output |
|---|---|---|
| L28 | `123` (too short) | `Use 4 to 8 digits.` — refused before any request (auto) |
| L29 | `123456789` (too long) | Refused (auto) |
| L30 | `12a4`, `12 4`, `1.23`, `+1234`, empty, spaces | `Digits only.` (auto) |
| L31 | Arabic-Indic digits `٤٥٦٧` | Refused (auto) — Postgres' `^[0-9]{4,8}$` refuses them too |
| L32 | `0000`, `1111`, `999999` | Refused as a repeated digit (auto, both languages) |
| L33 | `1234`, `4321`, `9876`, `01234567` | Refused as a run (auto, both languages) |
| L34 | `null` / `undefined` PIN | Refused; never treated as "remove the lock" (auto) |
| L35 | Numeric `4820` instead of a string | Coerced and accepted (auto) |
| L36 | Confirmation PIN differs from the first | Refused, nothing sent to the server (manual, code path) |
| L37 | `verify_chat_lock` on a chat with no lock | `{ok:true, locked:false}` — no gate to pass (SQL) |
| L38 | `verify_chat_lock` on a chat you are not in | Raises `not a member` (SQL, RLS-backed) |
| L39 | Empty password in "forgot the PIN" | Refused locally; empty is never sent to `verify_account_password` (auto/SQL) |

## 1.4 Security cases

| # | Attack | Expected output |
|---|---|---|
| L40 | Brute force the PIN | 5 free tries, then 30s → 60s → 5m → 15m → 15m forever. 10,000 guesses costs **more than 100 days** (auto, computed from the ladder) |
| L41 | Cooldown enforced client-side only? | No — the counter and the deadline live in `chat_members` and are applied inside `verify_chat_lock()`. Reloading the page does not reset them (SQL) |
| L42 | Turn the lock off instead of guessing it | `set_chat_lock()` requires the current PIN. A wrong one also increments the counter (SQL) |
| L43 | Same, straight from devtools with the session token | Same refusal — the check is in Postgres, not in the UI (SQL) |
| L44 | Read the PIN out of the database | It is a bcrypt hash (`crypt(pin, gen_salt('bf'))`). Nothing readable exists, for anyone, including the owner |
| L45 | Read the message text of a locked chat from the chat list payload | `chat_overview()` returns `null` for the body and the kind — it never leaves Postgres (SQL) |
| L46 | Find it through global search instead | `search_messages()` excludes locked chats unless their id is passed in `p_unlocked` (SQL) |
| L47 | Read it off the lock screen (local notification) | Redacted by `notifyPayload()`, whatever the preview setting is (auto) |
| L48 | Read it off the lock screen (FCM push, app closed) | Redacted in `supabase/functions/push-notify` too, and the data payload carries no chat id (auto: static check) |
| L49 | Remove the lock with the account password | Allowed by design: `reset_chat_lock()` checks the password against GoTrue's own bcrypt hash. This is the recovery path, and it is the documented limit of the feature |
| L50 | Wrong password on that path | Returns `false`, lock stays on, nothing leaks |
| L51 | Is this encryption? | **No.** Stated in the panel and in this plan: it stops someone holding your phone. The server can still read the chat unless E2EE is on |

---

# 2. Group calls

## 2.1 Normal cases

| # | Case | Expected output | Where |
|---|---|---|---|
| C1 | 1:1 voice call, accept, talk, hang up | Exactly as before this branch — one full-bleed tile, one call bubble in the thread | manual |
| C2 | Group of 3, A calls | B and C both ring; either can accept | manual |
| C3 | B accepts, then C accepts | All three hear each other — **including B↔C** | auto (`mesh: three people`) + manual |
| C4 | Participant grid | 2 people → 2 tiles side by side; 3–4 → 2×2; 5–6 → 3×2 | auto: `gridLayout` |
| C5 | Someone is talking | Green ring on their tile, on within ~120ms, off after ~700ms of silence | auto: `speakingNext` |
| C6 | Mute yourself | Slashed mic on your button; a mic-off badge on your tile for everyone else | manual (`call_heartbeat` carries the flag) |
| C7 | D joins 5 minutes late from the chat banner | D meshes with A, B and C; only D sends offers; everyone sees a fourth tile | auto + manual |
| C8 | The banner in a chat with a live call | "Mercy and Ali are on a voice call · Join" | auto: `joinBannerText` |
| C9 | Calls tab | A "Happening now" section above the history, with Join | manual |
| C10 | `#call/<id>` link | Opens the app and joins that room, if you are a member of its chat | manual |
| C11 | One person leaves | Their tile disappears for everyone; the rest of the call is untouched | auto (`leaving`) + manual |
| C12 | Last person leaves | Room closes; **exactly one** bubble: `Voice group call · ended · 12:04` | SQL `finalize_call` + static check |
| C13 | Screen share mid-call | Everyone sees the screen; stopping brings the camera back | manual |
| C14 | Host ends for everyone | Everyone's overlay closes, one bubble | manual |
| C15 | Call badge on the Calls tab | Shows the number of live calls in your chats | manual |

## 2.2 Edge cases

| # | Case | Expected output |
|---|---|---|
| C16 | Two people tap "call" in the same chat at the same second | One room, both in it — `start_call()` reuses a live call instead of making a second (SQL) |
| C17 | 7th person joins an audio call | Refused with "full at 6 … Wisp meshes peer to peer and does not ship an SFU" (auto) |
| C18 | 5th person joins a video call | Refused the same way (auto) |
| C19 | Someone leaves a full call, then a new person joins | Slot freed, join works (auto) |
| C20 | Rejoin a call you are already in | No-op, not a duplicate tile, not a second participant (auto) |
| C21 | Two people join in the same millisecond | Exactly one of them offers — never both, never neither (auto) |
| C22 | Nobody answers | 45s ring, then `missed` for both sides, room closed (SQL + manual) |
| C23 | Decline a 1:1 | Call ends, caller sees `declined` (SQL: `declineEndsCall`) |
| C24 | Decline a group ring | Your ring stops; the room stays open and the Join banner appears (auto + SQL) |
| C25 | Close the tab mid-call | `pagehide` sends a leave; if it does not arrive, `sweep_stale_calls()` clears the room after 75s of no heartbeat (auto: heartbeat window; cron) |
| C26 | Kill the network for 20s mid-call | One peer failing drops that peer, not the call; the call ends only when the last peer is gone (code path, manual) |
| C27 | Throttle to slow 3G | Quality label steps down; a shared screen is capped but never downscaled (auto: `qualityStep`) |
| C28 | 4 people on video | Per-peer bitrate is the ladder divided by the number of peers — mesh shares one uplink (code path) |
| C29 | Join a call whose chat you have muted | Ring is suppressed, the banner is not — a call is not a message (code path) |
| C30 | Broadcast list | Calling is refused, in the client and in `start_call()` |
| C31 | Camera off in a video call | Their tile shows their photo, not a black rectangle (CSS + track `mute` events) |
| C32 | Join a call that just ended | "That call has already ended", no half-open overlay (SQL raises `call_ended`) |

## 2.3 Invalid inputs

| # | Input | Expected output |
|---|---|---|
| C33 | Unknown call kind (`hologram`) | Treated as audio, capacity 6 (auto) |
| C34 | Participant row with no `user_id` | Ignored by the reducer (auto) |
| C35 | A leave event for someone who was never there | No-op (auto) |
| C36 | Nonsense tile count (`0`, `-3`, `NaN`, `'x'`) | Still a drawable grid (auto) |
| C37 | `join_call` with a call id that does not exist | `no_such_call` (SQL) |
| C38 | `join_call` on a chat you are not a member of | `not a member` (SQL, and RLS would refuse the read anyway) |
| C39 | `#call/<garbage>` link | One error toast, no overlay (code path) |
| C40 | Signal with no SDP / wrong SDP type / non-SDP string | Rejected before `setRemoteDescription` (auto, 6 variants) |
| C41 | ICE with no candidate string | Rejected (auto) |
| C42 | `end_call_for_all` by a non-host, non-admin | `host or admin only` (SQL) |

## 2.4 Security cases

| # | Attack | Expected output |
|---|---|---|
| C43 | A chat member who is **not** in the call posts an `answer` or ICE at it | Dropped by `signalAccepted()` before it reaches any peer connection — this is the one that mattered: `call_signals` is insertable by any chat member (auto, incl. the mesh sim) |
| C44 | The same person posts a first `offer` | Allowed, deliberately: that is a normal late join, and their participant row may land after their offer. Anyone outside the chat is still refused |
| C45 | Somebody outside the chat entirely | Refused by RLS on insert, and by `signalAccepted` on read (auto) |
| C46 | Signal addressed to another participant | Ignored (auto). RLS also filters it out server-side |
| C47 | 70 KB of junk SDP | Dropped on size before being parsed (auto) |
| C48 | `{"__proto__":{"type":"offer"}}` | Not accepted as an offer (auto) |
| C49 | Fake a 7th tile client-side to get past the cap | Capacity is enforced in `join_call()` in Postgres; the client agreeing is a courtesy (auto + SQL) |
| C50 | Read a call roster for a chat you are not in | `cp_read` policy requires membership of the call's chat |
| C51 | Insert a participant row as somebody else | `cp_insert` requires `user_id = auth.uid()` |
| C52 | Mute somebody else | `cp_write` is your own row only; `call_heartbeat()` writes `auth.uid()`'s row |
| C53 | Keep a room alive forever to spy on who joins | Rooms with one participant close immediately; stale ones close after 75s. `live_calls()` only lists calls with activity in the last 2 minutes |

---

# 3. Deploying it (and the SQL to paste)

1. **Supabase → SQL editor → New query.** Paste
   `supabase/migrations/20260916_chat_lock_and_group_calls.sql` whole, Run.
   It is idempotent; running it twice is safe. Expect a couple of `notice`
   lines and no errors.
2. Optional sanity check, same editor:
   ```sql
   select chat_lock_cooldown(4), chat_lock_cooldown(5), chat_lock_cooldown(8);
   select chat_lock_pin_ok('1234'), chat_lock_pin_ok('0000'), chat_lock_pin_ok('4820');
   select call_capacity('audio'), call_capacity('video');
   select * from live_calls();
   ```
   Expected: `0, 30, 900` · `f, f, t` · `6, 4` · zero rows.
3. **Realtime.** The migration adds `call_participants` to the
   `supabase_realtime` publication. If it printed the "publication missing"
   notice, enable Realtime in the dashboard and re-run section 7.
4. **pg_cron.** If enabled, the migration schedules `wisp_calls` every minute.
   Without it, group calls still work; a browser that dies mid-call just leaves
   a room advertised for up to two minutes.
5. **Push (optional).** Redeploy the function and add a second webhook:
   ```bash
   supabase functions deploy push-notify --no-verify-jwt
   ```
   Database → Webhooks → Create: table `public.calls`, event `INSERT`, type
   Supabase Edge Functions, function `push-notify`. That is what rings a phone
   with no tab open.
6. **Deploy the branch** (Vercel preview is enough to test).

Order matters: SQL first, then the code. The client calls the new RPCs and a
missing one is a 404 at runtime.

# 4. What running the plan found

Real failures, fixed in this branch:

1. **`relockDue()` treated epoch 0 as "never unlocked."** A falsy check on a
   timestamp. Harmless in practice today, exactly the kind of thing that makes
   a lock re-prompt (or fail to) at the edges. Caught by L20, fixed with an
   explicit null check.
2. **`.row-join` and `.row-lock` had no CSS.** The chat list rendered a Join
   button and a padlock with no rules behind them. Caught by the static style
   check, not by looking at it.
3. **The mesh simulation would not connect anyone** until the joiner was seeded
   with the whole roster before the fan-out — which is the same ordering the
   real client depends on (`join_call()` reply → `refreshRoster()` →
   `syncPeers()`). Documented in the sim so the dependency is explicit.

Bugs in the old code that the new tests now pin down (they are why the features
"did not really work"):

* callee-to-callee never connected in a group — only the caller built peers.
* no way to join a call after the ring: no banner, no link, no Calls-tab entry.
* every client wrote its own "call ended" message, so a 3-way call left 3.
* the 4-person cap was hard-coded in the client and could not be trusted.
* the chat lock had unlimited PIN attempts.
* the lock could be switched off without knowing the PIN.
* a locked chat leaked its last message into the chat list, its text into
  notifications and pushes, and its content into global search.
* `S.unlocked` never expired, so a lock was a one-time speed bump per page load.

# 5. Still not shipped, and why

* **More than 6 audio / 4 video.** Mesh. An SFU (LiveKit, mediasoup) is the
  only honest fix and this repo does not run a server.
* **iOS lock-screen ringing.** Needs CallKit + PushKit in a native app.
* **Biometric chat lock.** Needs WebAuthn with a platform authenticator; the
  PIN is what ships.
* **A locked chat is not hidden from `export_my_data()`.** That export is your
  own data behind your own password, deliberately.
