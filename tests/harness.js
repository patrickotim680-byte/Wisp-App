// Dependency-free assertions + the pass/fail ledger. Kept apart from run.js so
// the test files can import it without an import cycle through the runner.
export const state = { file: '', suite: '', pass: 0, fail: 0, failures: [] };

export function describe(name, fn) { const prev = state.suite; state.suite = name; fn(); state.suite = prev; }

export function it(name, fn) {
  const label = `${state.suite} \u203a ${name}`;
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error('async tests are not supported here on purpose');
    state.pass++;
    if (process.env.VERBOSE) console.log(`  ok   ${label}`);
  } catch (e) {
    state.fail++;
    state.failures.push({ label, file: state.file, message: e?.message || String(e) });
    console.log(`  FAIL ${label}\n       ${e?.message || e}`);
  }
}

const show = v => {
  try {
    return typeof v === 'string' ? JSON.stringify(v)
      : JSON.stringify(v, (k, x) => (x instanceof Map ? [...x] : x instanceof Set ? [...x] : x));
  } catch { return String(v); }
};

export const assert = {
  ok(v, msg = 'expected truthy') { if (!v) throw new Error(`${msg}: got ${show(v)}`); },
  not(v, msg = 'expected falsy') { if (v) throw new Error(`${msg}: got ${show(v)}`); },
  eq(a, b, msg = 'not equal') { if (a !== b) throw new Error(`${msg}: ${show(a)} !== ${show(b)}`); },
  deep(a, b, msg = 'not deep equal') {
    const A = show(a), B = show(b);
    if (A !== B) throw new Error(`${msg}: ${A} !== ${B}`);
  },
  match(str, re, msg = 'no match') { if (!re.test(String(str))) throw new Error(`${msg}: ${show(str)} !~ ${re}`); },
  throws(fn, msg = 'expected a throw') { try { fn(); } catch { return; } throw new Error(msg); },
};
