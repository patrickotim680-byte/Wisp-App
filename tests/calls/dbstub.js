// Stand-in for js/db.js: every call goes through Node, which plays "Supabase".
export const sb = null;
window.__subs = new Map();
export const ins = (t, row) => window.__ins(t, row);
export const upd = (t, p, m) => window.__upd(t, p, m);
export const sel = (t, b) => window.__sel(t, b);
export const del = async () => {};
export const rpc = async () => [];
export const publicUrl = () => null;
export function channel(key, build) {
  const handlers = [];
  const ch = { on(type, filter, cb) { handlers.push({ filter, cb }); return ch; }, subscribe() { return ch; } };
  build(ch);
  window.__subs.set(key, handlers);
  return ch;
}
export const drop = key => { window.__subs.delete(key); };
export const dropAll = () => window.__subs.clear();
window.__deliver = (table, row) => {
  for (const handlers of window.__subs.values()) for (const { filter, cb } of handlers) {
    if (filter.table !== table) continue;
    if (filter.filter) { const [col, val] = filter.filter.split('=eq.'); if (String(row[col]) !== val) continue; }
    cb({ new: row });
  }
};
