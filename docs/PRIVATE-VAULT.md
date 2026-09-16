# Wisp Private Vault

> Private Vault gives your most sensitive Wisp conversations an additional
> security boundary, protecting conversations, notifications and media behind
> dedicated authentication.

This document is the honest version. It describes what the feature does, how it
is built, and — at least as importantly — what it does not do. Nothing in the UI
is allowed to promise more than what is written here.

---

## 1. What it is

A separately protected area inside Wisp. Move a conversation into it and, on your
side:

- it leaves the normal conversation list and cannot be opened from there;
- it is excluded from normal Wisp search;
- its messages are not rendered outside the vault;
- its media does not appear in normal media browsing;
- its notifications never show a sender or a message;
- opening it requires vault authentication;
- its local copy on the device is encrypted with a key that only exists in memory
  while the vault is open.

Moving it back out is the same operation in reverse, and also needs
authentication.

It is not a hidden chat. A hidden chat is a flag the interface agrees to respect.
This changes how the information is handled in storage, in search, in
notifications, in media and in authentication — the list above is enforced in
four different places, described below, and three of them are not on the client.

---

## 2. Threat model

**What it is for.** Someone gets temporary access to your unlocked phone — a
friend borrowing it, a partner picking it up, a colleague looking over your
shoulder, a border check, a repair shop. They open Wisp. Private conversations
are not in the list, not in search, not in the gallery, and their notifications
say nothing. Getting to them needs a code or a biometric check that the person
holding the phone does not have.

**What it is not for, and cannot be.**

| Not protected against | Why |
|---|---|
| A fully compromised device | Malware with your privileges can read the app's memory while the vault is open. |
| Malware or an attacker with sufficient OS privileges | Same reason. No app-level design fixes a compromised platform. |
| Someone photographing the screen with another device | Nothing in software can stop a camera. |
| Screenshots | Screenshots are **not** blocked. The web platform has no API for it. Any app claiming otherwise on the web is wrong. |
| The recipient saving, forwarding or photographing what you sent them | They have the message. That is what sending it means. |
| A tampered-with operating system | Below the level anything here operates at. |
| Other endpoints the recipient controls | Their copy is theirs. |

And stated once, plainly, because the UI is not allowed to imply otherwise:
**this does not make anything unhackable, and it is not “100% impossible to
hack”.** It raises the cost of one specific, very common attack.

---

## 3. Key architecture

```
Wisp account
  ├─ normal conversation data
  └─ encryption identity (RSA-OAEP-2048 keypair, private key wrapped with a
     PBKDF2 key from the account password)

Private Vault  (per device, never synchronised)
  ├─ Vault Master Key (VMK) — 32 random bytes, non-extractable once imported
  │    ├─ wrap 1: AES-256-GCM under PBKDF2-SHA-256(vault code, 16-byte salt,
  │    │          600,000 iterations)
  │    └─ wrap 2 (optional): AES-256-GCM under HKDF-SHA-256(WebAuthn PRF secret)
  ├─ per-conversation local keys — HKDF-SHA-256(VMK, info = conversation id)
  ├─ vault-protected local storage — IndexedDB `wisp-vault`, every record is
  │    AES-GCM ciphertext, every key namespaced by account id
  └─ protected media — decrypted bytes cached only in the store above, served
       through blob: URLs that are revoked the moment the vault locks
```

**Primitives.** AES-256-GCM, PBKDF2-SHA-256, HKDF-SHA-256, SHA-256, WebAuthn —
all from the platform (WebCrypto). No cryptography is invented, implemented or
“improved” in this codebase. If you are reviewing one file, review
[`js/vault.js`](../js/vault.js); it is the whole boundary.

**The code is never stored.** Not raw, not hashed, not on the server, not in
`localStorage`. Only the wrapped master key is on disk. A wrong code fails
AES-GCM authentication, so there is no separate verifier sitting there to grind
offline beyond the wrap itself.

**The code is not your account password.** Setup refuses if you type the account
password. The reason is concrete: the account password gets typed on other
devices, travels through a password-reset email, and is kept in this tab's
`sessionStorage` so encrypted chats can be read. A vault behind it would add no
boundary.

**The master key is non-extractable.** It is imported as an HKDF key with
`extractable: false`, so per-conversation keys can be derived from it but the
bytes cannot be read back out of it. That is also why turning on biometric
unlock asks for the code once: re-wrapping the master key needs the raw bytes,
and Wisp deliberately does not keep them lying around for a whole session.

### Biometrics, and why there is no fallback

Biometric unlock uses a WebAuthn platform credential with the **PRF extension**:
the authenticator returns a secret that only it can produce, only after a
successful user-verification check, and that secret is what unwraps the master
key. The device check is doing real cryptographic work.

Where the browser has no PRF extension, Wisp says so and offers nothing. This is
deliberate. Without PRF, WebAuthn can only tell us *“a human passed a device
check”*. To turn that into an unlock we would have to keep a second copy of the
master key wrapped under something stored on the device in the clear — which
anyone holding the unlocked phone could read straight out of IndexedDB without
ever touching the fingerprint sensor. That is a decorative lock that silently
downgrades the code to nothing. Settings states the capability honestly:
*available*, *not available in this browser*, or *no device authentication here*.

---

## 4. What the server holds, and what it does not

**On the server:** the *fact* that a conversation is in your vault
(`chat_members.vaulted`, per member row, so vaulting is one-sided and the other
participant is not told), plus your vault preferences (auto-lock choice, screen
guard). That has to be server-side, because it is what lets the chat list, the
search function and the push function leave private conversations out **at the
source** rather than trusting a client to hide them.

**Never on the server:** the vault code, the vault master key, anything derived
from it, or a plaintext copy of a private conversation. Vaulting a conversation
turns on end-to-end encryption for it, so from that point message bodies reach
Postgres as ciphertext and attachment bytes reach object storage as ciphertext.

There is no server-side way to open a vault, no admin path, no support path, and
no developer backdoor. There is nothing to add one to: the server has no key.

### Where isolation is actually enforced

| Boundary | Enforced in | Not merely |
|---|---|---|
| Not in the chat list | `chat_overview()` excludes vaulted rows in SQL | filtered client-side |
| Not in search | `search_messages()` excludes vaulted rows in SQL | hidden in the results view |
| Not in the media gallery | `shared_media()` refuses without an explicit `p_vault` opt-in | skipped while rendering |
| Not in digests or exports | `chat_digest()` and `export_chat_text()` refuse; `export_my_data()` omits them | trimmed after the fact |
| No notification preview | stripped in the push Edge Function, before FCM | stripped on the device |
| Not in the local plaintext cache | `js/cache.js` routes them to the vault store, and scrubs the plain cache on the way in | left there and ignored |

A tampered-with or replaced client has nothing to un-hide for the first four:
the rows are not sent.

---

## 5. Notification privacy

Three tiers apply to your normal conversations (Settings → Notifications):

| Tier | Shows |
|---|---|
| **Standard** | `Sarah — Are you free tonight?` |
| **Private** | `Wisp — New message` |
| **Maximum privacy** | `Wisp — New message`, one shared tag so the lock screen does not count conversations out, and a tap opens Wisp rather than a conversation |

A conversation in Private Vault **ignores this setting** and always produces
`Wisp — New private message`: no sender, no contents, no conversation id in the
payload, and no deep link. Not configurable — a preview setting somebody forgot
to change is precisely how a private conversation ends up on a lock screen.

This is applied in three places, because a push arrives while the app is closed
and the vault is locked:

1. **`supabase/functions/push-notify/index.ts`** strips the payload server-side
   before handing it to FCM, and marks Android `visibility: PRIVATE` with a
   collapse tag.
2. **`sw.js`** renders any payload marked private generically regardless of what
   it contains, and never deep-links.
3. **`js/notify.js`** does the same for in-app notifications.

The realtime event that arrives while the vault is locked carries only
ciphertext, because a vaulted conversation is end-to-end encrypted — so there is
no plaintext body in the event for anything to leak. The unread badge also
excludes private conversations: a badge that climbs when a private message
arrives is itself a notification about a private conversation, on a surface that
needs no authentication.

---

## 6. Auto-relock, and the screen guard

Settings → Private Vault → *Lock automatically*: Immediately · After 30 seconds ·
After 1 minute (default) · After 5 minutes · When Wisp leaves the foreground ·
When the device locks.

The countdown starts when Wisp goes to the background or you leave the vault —
not while you are reading. **A reload or an app restart always locks it**,
because the master key only ever lived in the document's memory and nothing about
the unlocked state is persisted.

**Lock Private Vault** is a one-tap action in the vault bar, the list header, and
Settings, plus <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>. No
confirmation, deliberately: the moment you need it is the moment somebody is
reaching for your phone. It drops the keys, clears decrypted conversations and
media, revokes every blob URL, closes the open private conversation, pulls
private conversations back out of application state, and puts the gate back.

### The honest limitation

When Wisp is backgrounded, a cover is painted **synchronously** on
`visibilitychange`, before the browser takes its app-switcher snapshot. That is
the strongest thing the web platform offers.

It is not a guarantee. There is no web API equivalent to iOS's
`isSecureTextEntry` snapshot suppression or Android's `FLAG_SECURE`, so it is
possible for an OS to capture a frame before the cover lands. On web, *“the
device locks”* is also indistinguishable from *“the tab was hidden”* — both
arrive as the same event, and both are treated as locking triggers.

---

## 7. Failed attempts, and the absence of recovery

Wrong codes get progressively slower to try: three free attempts, then 15s, 30s,
1m, 5m, 15m, 30m, 1h, capped at an hour. The counter is persisted, so closing the
tab does not reset it.

Optionally (**off by default**) the encrypted local copy can be erased after ten
wrong codes. Off by default on purpose: with it on, somebody guessing badly can
destroy data, which is its own kind of attack.

**There is no recovery mechanism, and that is the feature.** Specifically, there
is none of this:

- no unlock with the Wisp account password;
- no recovery code the server can issue;
- no support or admin path;
- no master password, developer key or backdoor of any kind.

Any of those would mean anybody who learns your account password owns the vault,
which is the exact attack this exists to stop.

What does exist is **Erase vault data on this device**. It deletes the local key
and the encrypted local copies. It cannot reveal anything, because it destroys
the key rather than using it. The conversations stay in the vault for your
account, so they do not reappear in the normal list; set a new code on that
device and they are re-fetched from the server, still end-to-end encrypted.

If real vault recovery or device migration is built later, it has to be designed
explicitly as a security feature — an authenticated, rate-limited, user-visible
ceremony — and not as a quiet bypass bolted onto the side.

---

## 8. Cross-device behaviour

Vault key material is **per device and is not synchronised**. This first
implementation deliberately does not attempt multi-device vault sync, because
synchronising a local security boundary is a separate security problem, not a
convenience feature.

What does follow your account is the *flag*: a conversation you vaulted is out of
the normal list on every device, immediately. On a second device the vault starts
as *not set up*, you give it its own code, and the conversations are read there
over the existing end-to-end encryption.

If sync is added later it must preserve end-to-end encryption and must not turn
the server into a holder of decrypted vault contents. Anything else is not the
same feature.

---

## 9. Known limitations

Beyond the threat-model table:

- **Screenshots are not blocked.** No web API for it. Not claimed anywhere.
- **The app-switcher cover is best-effort**, per section 6.
- **Biometric unlock needs WebAuthn PRF.** Absent that, the code is the only way
  in, and Settings says so.
- **The vault is per device**, per section 8.
- **The server knows *which* conversations are private**, though not what they
  say. That is the cost of enforcing the exclusions in SQL instead of trusting
  the client, and it is the right trade.
- **In-vault server-side text search returns little**, because private
  conversations are end-to-end encrypted and the server has no plaintext to
  match. The vault search says so instead of implying the result was exhaustive.
- **Encrypted conversations *outside* the vault still cache plaintext locally**,
  in `wisp-cache`. That is pre-existing behaviour and unchanged; it is one of the
  concrete things moving a conversation into the vault fixes.
- **The underlying end-to-end encryption is modest**: per-chat AES-256-GCM
  wrapped per member with RSA-OAEP-2048. No forward secrecy, no post-compromise
  security, no ratchet, no safety numbers. It is not the Signal protocol and does
  not pretend to be. See the README.

## 10. Deliberately not built

Asked for, and refused, with reasons:

- **A fake calculator or any app disguise, and secret codes that launch Wisp.**
  Deception is not security. It fails the moment anyone taps the app twice, and
  an app pretending not to be a messenger is worse than useless if the person
  searching the phone is anything but casual.
- **A frontend-only lock.** A `locked = true` boolean with the messages still in
  a plaintext local database is a lock on a door in a house with no walls.
- **Custom or invented cryptography.** Platform primitives only.
- **A master password, a developer backdoor, an admin backdoor.**
- **A server-side plaintext copy, or automatic plaintext vault backups.**
- **PIN or password storage in plaintext.**
- **Claims that screenshots are impossible or that conversations cannot be
  hacked.**
- **Emoji in the security interface, and animation flourishes.** A security
  screen that performs is a security screen people stop reading.

The old per-chat **Chat lock** PIN is superseded. `set_chat_lock` /
`verify_chat_lock` remain so conversations locked with it keep opening, and
moving a conversation into the vault clears them. The UI no longer offers it.

---

## 11. Deploying this

1. Supabase SQL editor → run `supabase/migrations/20260916_private_vault.sql`,
   then `supabase/migrations/20260916_private_vault_guards.sql`. Both are
   idempotent.
2. Redeploy the push function so notification stripping is live:
   `supabase functions deploy push-notify --no-verify-jwt`
3. Deploy the static site as usual. No build step, no new dependency — the vault
   adds `js/vault.js`, `js/vault-ui.js` and `vault.css`.
4. Private Vault must be **served over HTTPS** on a stable hostname. WebAuthn is
   bound to the origin's hostname, so biometric unlock stops working if the
   hostname changes, and the code still works in that case.

---

## 12. Manual test checklist

Two accounts, A and B, in two browser profiles. Nothing here is automated — run
it before calling the feature done.

1. **Lock a conversation.** A: chat → details → Private Vault → Move in. It
   leaves the list. The way into the vault is at the end of the list.
2. **Authenticate.** Tap Private Vault: the gate appears, not the conversation.
   Wrong code is refused. Right code opens it.
3. **Unlock and read.** The conversation opens and reads normally, with a lock
   mark beside the name.
4. **Close and reopen Wisp.** Reload: the vault is locked again, the conversation
   is still out of the normal list.
5. **Background Wisp.** Switch tabs/apps: the cover paints. Check the
   app-switcher preview shows the cover, not the conversation.
6. **Lock the phone.** Same as above, plus the auto-lock setting is honoured.
7. **Receive a private message while locked.** From B: the notification reads
   `Wisp — New private message`. No sender, no text. The unread badge does not
   move. Tapping it opens the vault gate, not the conversation.
8. **Notification previews.** Set Notifications → Privacy to each of Standard,
   Private, Maximum and confirm a *normal* conversation's notification changes
   accordingly, while the private one never does.
9. **Search for a private conversation.** Search its name from the normal search
   box: no hit, and `search_messages` returns no rows for it in SQL either.
10. **Search for private message content.** Same: nothing. Then search from
    inside the unlocked vault and confirm the vault search runs.
11. **Open private media.** Send a photo inside a private conversation. It opens
    in the thread. In Storage, download the object directly: it is ciphertext,
    not an image. Confirm it does not appear in a normal conversation's gallery.
12. **Failed code attempts.** Get it wrong repeatedly: the delay grows and
    survives a reload. Confirm the account password does **not** unlock the vault
    anywhere.
13. **Biometric failure and fallback.** Cancel the device prompt: the code field
    still works. On a browser without PRF, confirm Settings says it is
    unavailable rather than offering it.
14. **Move conversations in and out.** Move one out: it returns to the list,
    search and notifications, and encryption stays on.
15. **Multiple private conversations.** Vault three. All appear inside, none
    outside.
16. **App restart.** Close the tab entirely and return: locked.
17. **Device restart.** Same.
18. **Offline behaviour.** Go offline, unlock the vault, open a private
    conversation: the local encrypted copy still decrypts and renders.
19. **Log out and back in.** Log out, log in as B on the same browser: B cannot
    reach A's vault (records are namespaced per account). Log back in as A: the
    vault is intact and locked.
20. **Multiple devices.** On a second device, the conversation is absent from the
    normal list and the vault starts as not set up.
21. **Lock Everything.** With the vault open and a private conversation on
    screen, press <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd>: the
    conversation closes, the gate returns, and any private image already on
    screen stops resolving.
22. **Saved, digests, exports.** Star a message, then vault its conversation: it
    disappears from Saved with a note saying where it went. Confirm Catch me up
    and Export are not offered for it, and that `export_my_data` omits it.
23. **The old chat lock.** On a conversation locked with the old PIN, confirm it
    still opens with that PIN, and that moving it into the vault clears it.
