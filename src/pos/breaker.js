// Circuit breaker for the PRA connection (SRS 4.7: show its state). After a few failed attempts in a row the counter gives the
// connection a rest, so the cashier gets an instant, clear message instead of waiting for another timeout. When the rest is over,
// exactly ONE caller is let through to try the connection (allow() hands out the trial and holds everyone else back for
// probeMs, or until that caller's answer is recorded): success closes the breaker, a failure starts the rest again.
// Kept in memory per server process.
function createBreaker({ threshold = 3, coolDownMs = 30000, probeMs = 10000, now = () => Date.now() } = {}) {
    const keys = new Map(); // key (counter id) → { fails, openUntil }
    return {
        // true = go ahead and try PRA. After a rest this answers true once; it is meant to be asked once per attempt.
        allow(key) {
            const s = keys.get(key);
            if (!s || !s.openUntil) return true;
            if (now() < s.openUntil) return false;
            s.openUntil = now() + probeMs; // the trial is taken: the others wait for its answer
            return true;
        },
        // ok = PRA could be reached (even if it said no); false = no connection or no answer
        record(key, ok) {
            if (ok) return void keys.delete(key);
            const s = keys.get(key) || { fails: 0, openUntil: 0 };
            s.fails += 1;
            if (s.fails >= threshold) s.openUntil = now() + coolDownMs;
            keys.set(key, s);
        },
        // for screens and early refusals: looking never uses up the trial
        state(key) {
            const s = keys.get(key);
            const retryInMs = s && s.openUntil > now() ? s.openUntil - now() : 0;
            return { open: retryInMs > 0, fails: s ? s.fails : 0, retryInMs };
        },
    };
}

module.exports = { createBreaker };
