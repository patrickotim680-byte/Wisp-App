# Call tests

Headless, real WebRTC: several Chromium pages run the real `js/calls.js`, real
`util.js`/`state.js`, real CSS. Only `db.js` and `notify.js` are replaced
(`dbstub.js`, `notifystub.js`): Node plays Supabase, relays "Realtime" rows
between pages, and applies the same visibility rule as the `call_signals` RLS.

    npm i --no-save playwright && npx playwright install chromium
    node tests/calls/run.js          # exits non-zero on any failure
    SHOTS=/tmp node tests/calls/run.js   # also writes layout screenshots

Scenarios and expected results are in `TEST_PLAN.md`. Not covered (needs the
real stack): real Supabase Realtime/RLS, TURN on mobile networks, screen share
(headless Chromium has no screen picker).
