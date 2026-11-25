// Network awareness: a single place every other module asks "is this
// connection weak or metered right now?" instead of guessing. Used to skip
// or defer anything that isn't the message text itself — link previews,
// typing pings, bigger history pages — on 2G/3G or when the person has
// turned on Data Saver.
//
// Not every browser exposes the Network Information API (iOS Safari never
// has), so the default assumption when it's missing is "normal speed"
// rather than pessimistically throttling everyone. Where it does exist
// (Chrome/Android, which is most of the actual 2G install base), it's
// reliable enough to act on.
const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;

/** True when the connection is explicitly metered/slow and non-text work
 *  should be deferred: Data Saver is on, or effectiveType reports 2G/3G.
 *  (effectiveType is a rolling estimate of real throughput+RTT, not just the
 *  radio generation, so it also catches a congested/weak 4G cell that is
 *  behaving like 2G.) */
export function isSlowNetwork() {
  if (!conn) return false;
  if (conn.saveData) return true;
  return conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g' || conn.effectiveType === '3g';
}

export const isOnline = () => navigator.onLine !== false;

/** Fires fn on any signal that the network situation may have changed:
 *  effectiveType/downlink change, or the browser flipping online/offline.
 *  Returns an unsubscribe function. */
export function onNetworkChange(fn) {
  conn?.addEventListener?.('change', fn);
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => {
    conn?.removeEventListener?.('change', fn);
    window.removeEventListener('online', fn);
    window.removeEventListener('offline', fn);
  };
}
