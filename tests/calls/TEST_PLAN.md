# Group calls: test plan, results, and code inspection

Run: `node tests/calls/run.js`. Result at time of writing: **43 / 43 pass**.
"Expected" is what the test asserts. IDs match the scenarios in `run.js`.

## 1. Normal cases

| ID | Case | Expected |
|----|------|----------|
| S1 | 4 people, video, caller + 3 invitees accept | Every person has 3 connected peer connections and 3 tiles, each carrying audio+video from a *different* person. An invitee (B) is connected to the other invitees (C, D), not only to the caller. Header reads "4 in call". Grid `data-n=3`, root has `multi`. |
| S2 | 3 people; B leaves, then C leaves | After B leaves, A and C are still in a live call using the 1:1 layout (no `multi`). When the last person leaves the call ends. The call row is written once, by the caller, as `ended`. At most one call-log message in the thread. |
| S5 | 3 people, voice only | Two audio-only tiles per person, no video, audio packets actually received from both peers; a tile gets the `speaking` ring when someone talks. |
| S6 | 1:1 DM, video | One full-bleed tile, no `multi`, header "Connected". Hang-up ends both sides; row is `ended`. (Regression: must look and behave as before.) |

## 2. Edge cases

| ID | Case | Expected |
|----|------|----------|
| S3 | One invitee declines, the other accepts | Caller drops only the decliner's tile, toasts "User B declined", keeps ringing; A and C connect. The call row is **not** marked `declined` for everyone. |
| S4 | Callee's live subscription missed the offer | Accepting re-reads `call_signals` and still connects. |
| S6 | Call that ends < 0.5 s after connecting | State is `ended`, not `declined` (state comes from "did media connect", not from rounded duration). |
| S9 | Caller hangs up while a callee is still ringing | Callee's ring stops, callee writes nothing. |
| S7 | Chat with 5 members | Call refused with a toast ("up to 4"), no call row created. |
| S1 | Someone leaves a 4-way | The other three continue; layout animates 3 tiles to 2. |

## 3. Invalid inputs (S8, injected while a call is live)

Null payload, string payload, `type` not a string, `candidates` not an array,
array of junk candidates, unparseable SDP offer from a real peer, wrong-shaped
answer, unknown signal type, duplicate row ids.
**Expected:** nothing throws into Realtime, the call stays up, both real links
stay connected and keep playing video, no phantom tiles.

## 4. Security cases (S8)

| Case | Expected |
|------|----------|
| Offer from a chat member who never joined the call | Ignored: no peer connection, no tile. *(Found failing, fixed: offers are honored only from the caller or someone who announced `ready`.)* |
| `bye` from someone not in the call | No effect. |
| Row addressed to another user (leaked to me) | Ignored client-side, in addition to the RLS rule. |
| Row I sent myself echoed back / returned by the catch-up read | Ignored. *(Found failing, fixed: callees built a peer connection to themselves.)* |
| Sender identity | Taken from `call_signals.sender_id` (RLS-enforced = `auth.uid()`), never from the payload. |

## 5. Code inspection findings (read against `supabase/schema.sql`)

Fixed in this change:
- Single shared `<video>`: every new peer's stream replaced the last, so in a group you only heard one person. Now one tile + `MediaStream` per person.
- Star topology: invitees never connected to each other (`ready` was ignored). Now a real mesh.
- One peer failing, one `bye`, or one decline ended the call for everyone. Now only that person's link is removed.
- Both invitees offering to each other at once (glare) left one direction muted. Now exactly one side of each pair opens the link.
- Bitrate/loss counters were shared across peers; each link now tracks its own and gets its share of the uplink.
- A screen share arriving on a new `msid` replaced the stream and silenced that person's voice.
- Every participant overwrote the shared call row and posted its own log bubble. Now the caller records it (callee only on a genuine 1:1 decline).
- No-answer ring on the callee side could never end if the caller vanished; now times out.

Open, **not** fixed (needs your decision or the real stack):
- **RLS `calls_update`** allows *any chat member* to update the call row (`using (is_member(chat_id))`), so a member can mark someone else's call `ended`/`declined`. Suggest restricting to the caller or participants.
- **No rate limit on `call_signals` inserts** (the rate trigger covers messages). A member could flood the table; rows are purged after 1 hour.
- **Duration** in a group is the caller's time in the call, not the whole call's.
- **No join-in-progress:** someone who dismissed the ring cannot rejoin.
- **More than 4 people** still needs an SFU (LiveKit). Mesh upload grows with each person.

## 6. Not verified (be honest about the gaps)

- Real Supabase Realtime delivery/ordering and the real RLS policies (stubbed; the stub applies the same visibility rule as `signals_read`).
- TURN relay on carrier-grade NAT (headless loopback only). Set `TURN_URL/USERNAME/CREDENTIAL` in Vercel.
- Screen share inside a group (headless Chromium has no picker). The code path was changed (`attachShare`), so test by hand: checklist items 91 and a 3-person variant.
- Real phone hardware, Android WebView, battery/CPU with 3 simultaneous video links.
