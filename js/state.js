// Single mutable app state + a tiny pub/sub so views can re-render on change.
export const S = {
  me: null,            // profiles row
  settings: null,      // user_settings row
  chats: [],           // chat_overview() rows
  chat: null,          // active overview row
  chatToken: 0,        // bumped on every open/close so a superseded openChat() can bail out
  members: [],         // members of active chat (with profile)
  people: new Map(),   // user_id -> people_info row
  msgs: [],            // messages of active chat, ascending
  status: new Map(),   // message_id -> [{user_id, delivered_at, read_at}]
  reacts: new Map(),   // message_id -> [{user_id, emoji}]
  starred: new Set(),
  bookmarked: new Set(),
  selection: new Set(),
  replyTo: null,
  pending: [],         // staged attachments
  view: 'chats',
  folder: null,
  folders: [],
  typing: new Map(),   // chat_id -> Map(user_id, ts)
  keys: null,          // { pub, priv } CryptoKeys
  chatKeys: new Map(), // chat_id -> AES CryptoKey
  unlocked: new Set(), // chat ids unlocked this session
};

const subs = new Map();
export function on(evt, fn) {
  if (!subs.has(evt)) subs.set(evt, new Set());
  subs.get(evt).add(fn);
  return () => subs.get(evt).delete(fn);
}
export function emit(evt, payload) {
  (subs.get(evt) || []).forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } });
}
export const person = id => S.people.get(id) || null;
export const nameOf = id => id === S.me?.id ? 'You' : (person(id)?.display_name || 'Unknown');
