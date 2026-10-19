// Circuit breaker for the PRA connection (SRS 4.7: show its state). After a few failed attempts in a row the counter gives the
// connection a rest, so the cashier gets an instant, clear message instead of waiting for another timeout. After the rest, one
// attempt is let through: success closes the breaker, another failure opens it again. Kept in memory per server process.
function createBreaker({ threshold = 3, coolDownMs = 30000, now = () => Date.now() } = {}) {
    const keys = new Map(); // key (counter id) → { fails, openUntil }
    return {
        allow(key) {
            const s = keys.get(key);
            return !s || !s.openUntil || now() >= s.openUntil;
        },
        // ok = PRA could be reached (even if it said no); false = no connection or no answer
        record(key, ok) {
            if (ok) return void keys.delete(key);
            const s = keys.get(key) || { fails: 0, openUntil: 0 };
            s.fails += 1;
            if (s.fails >= threshold) s.openUntil = now() + coolDownMs;
            keys.set(key, s);
        },
        state(key) {
            const s = keys.get(key);
            const retryInMs = s && s.openUntil > now() ? s.openUntil - now() : 0;
            return { open: retryInMs > 0, fails: s ? s.fails : 0, retryInMs };
        },
    };
}

module.exports = { createBreaker };
