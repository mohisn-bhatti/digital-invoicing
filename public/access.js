// How long a client may use the application: the day it was integrated, the period it was given (months or years), the last day
// of access, the grace days after it, and what that makes of the client today.
//
//   - A client with no end date has no time limit (every client that existed before this).
//   - Dates are Pakistan calendar days ("YYYY-MM-DD"), stored at 00:00 Pakistan time.
//   - The last day of access is the integration day plus the period (19 Oct 2026 + 1 year = 19 Oct 2027). After it comes a grace
//     period, 3 days for a monthly plan and 7 for a yearly one, and the client is still active through its last day. When the
//     grace is over the client is made inactive by itself, and from then on it can only LOOK: it may log in, view, print and download its
//     records (the law asks businesses to keep them) but not make changes. Renewing it makes it active again. A client switched off by hand
//     is a different thing: it cannot log in at all.
//
// Pure functions that run in Node and in the browser (the Manage screen's preview uses this same file, so what it says is what the
// server does). The one thing that writes to the database, expireDueClients, is in src/subscription.js.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.Access = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const GRACE_DAYS = { MONTH: 3, YEAR: 7 };
    const SOON_DAYS = 30; // "ending soon": this many days or fewer left
    const UNITS = ['MONTH', 'YEAR'];
    const MAX_COUNT = { MONTH: 120, YEAR: 20 };

    class AccessError extends Error {}

    const PKT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' });
    const dayOf = d => PKT_DAY.format(d instanceof Date ? d : new Date(d)); // a moment → its Pakistan day
    const atMidnight = day => new Date(`${day}T00:00:00+05:00`);            // a day → the moment it is stored as
    const dayNo = day => { const [y, m, d] = day.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
    const dayFromNo = n => new Date(n * 86400000).toISOString().slice(0, 10);
    const addDays = (day, n) => dayFromNo(dayNo(day) + n);
    function isDay(text) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));
        if (!m) return false;
        const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
        return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
    }

    // a day plus whole months, keeping the day of the month (31 Jan + 1 month = 28 or 29 Feb)
    function addMonths(day, months) {
        const [y, m, d] = day.split('-').map(Number);
        const total = y * 12 + (m - 1) + months;
        const year = Math.floor(total / 12), month = total % 12;
        const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
    }
    const monthsOf = (unit, count) => (unit === 'YEAR' ? 12 : 1) * count;
    const graceDaysOf = unit => GRACE_DAYS[unit] || GRACE_DAYS.MONTH;

    // Where a client stands today.
    //   status: UNLIMITED · RUNNING · ENDING (30 days or fewer left) · GRACE (ended, still allowed) · EXPIRED (grace over)
    //   daysLeft: days until the last day (negative once it has passed); graceUntil: the last day of the grace period
    function access(tenant, now = new Date()) {
        if (!tenant || !tenant.accessEndsAt) return { status: 'UNLIMITED', daysLeft: null, endsOn: null, graceDays: 0, graceUntil: null, inactiveFrom: null, unit: null, count: null };
        const endsOn = dayOf(tenant.accessEndsAt);
        const daysLeft = dayNo(endsOn) - dayNo(dayOf(now));
        const graceDays = graceDaysOf(tenant.accessUnit);
        const status = daysLeft > SOON_DAYS ? 'RUNNING' : daysLeft >= 0 ? 'ENDING' : daysLeft >= -graceDays ? 'GRACE' : 'EXPIRED';
        return { status, daysLeft, endsOn, graceDays, graceUntil: addDays(endsOn, graceDays), inactiveFrom: addDays(endsOn, graceDays + 1), unit: tenant.accessUnit || null, count: tenant.accessCount ?? null };
    }

    // The length of a period: a whole number of months or years
    function cleanPeriod(unit, count) {
        const u = String(unit || '').toUpperCase();
        if (!UNITS.includes(u)) throw new AccessError('Choose months or years.');
        const n = typeof count === 'number' ? count : /^\d{1,3}$/.test(String(count).trim()) ? Number(count) : NaN;
        if (!Number.isInteger(n) || n < 1) throw new AccessError('Enter how many months or years (a whole number, 1 or more).');
        if (n > MAX_COUNT[u]) throw new AccessError(`That is too long: ${MAX_COUNT[u]} ${u === 'YEAR' ? 'years' : 'months'} at most.`);
        return { unit: u, count: n };
    }

    // Set the access period from scratch: the day the client was integrated, and how long it may use the application (or no limit)
    //   body: { integratedAt?: 'YYYY-MM-DD', unlimited?: true, unit, count }   current: the client as stored
    // Returns the fields to store.
    function setPeriod(body, current, now = new Date()) {
        const b = body || {};
        const integratedOn = b.integratedAt !== undefined && b.integratedAt !== '' ? String(b.integratedAt) : dayOf(current.integratedAt || now);
        if (!isDay(integratedOn)) throw new AccessError('The integration date must be a real date, written like 2026-10-19.');
        const year = Number(integratedOn.slice(0, 4));
        if (year < 2020 || year > 2100) throw new AccessError('The integration date is out of range.');
        const data = { integratedAt: atMidnight(integratedOn) };
        if (b.unlimited === true || b.unlimited === 'true') return { ...data, accessUnit: null, accessCount: null, accessEndsAt: null };
        const { unit, count } = cleanPeriod(b.unit, b.count);
        return { ...data, accessUnit: unit, accessCount: count, accessEndsAt: atMidnight(addMonths(integratedOn, monthsOf(unit, count))) };
    }

    // Renew: add a period to the end date, or to today when the end date has already passed, so nobody loses days by renewing
    // early and nobody is given the days they were without. With no period given, the last one is repeated.
    function renew(body, current, now = new Date()) {
        const b = body || {};
        const unit = b.unit || current.accessUnit, count = b.count !== undefined && b.count !== '' ? b.count : current.accessCount;
        if (!unit || !count) throw new AccessError('Choose how long to renew for: months or years.');
        const period = cleanPeriod(unit, count);
        const today = dayOf(now), ends = current.accessEndsAt ? dayOf(current.accessEndsAt) : today;
        const from = dayNo(ends) > dayNo(today) ? ends : today;
        return { accessUnit: period.unit, accessCount: period.count, accessEndsAt: atMidnight(addMonths(from, monthsOf(period.unit, period.count))) };
    }

    // What a client may do today: FULL (use everything), READ_ONLY (its access period is over: look, print, download, ask for a renewal, but change nothing)
    // or BLOCKED (switched off by hand: nothing, not even a login). Whether the nightly job has already noted that a period is over does not matter: the
    // dates decide.
    const ENDED_MESSAGE = 'Your access period has ended. Contact ETAX to renew it.';
    const INACTIVE_MESSAGE = 'This business account is inactive. Contact ETAX to reactivate it.';
    const longDay = day => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
    const readOnlyMessage = a => `Your access period ${a && a.endsOn ? `ended on ${longDay(a.endsOn)}` : 'has ended'}. You can look at, print and download your records, but you cannot make changes. Contact ETAX to renew it.`;
    function accessMode(tenant, now = new Date()) {
        if (!tenant) return { mode: 'FULL', message: null, endedOn: null };
        const a = access(tenant, now);
        if (tenant.active === false) {
            if (tenant.inactiveReason === 'EXPIRED') return { mode: 'READ_ONLY', message: readOnlyMessage(a), endedOn: a.endsOn };
            return { mode: 'BLOCKED', message: INACTIVE_MESSAGE, endedOn: null }; // by hand, or an older row with no reason
        }
        if (a.status === 'EXPIRED') return { mode: 'READ_ONLY', message: readOnlyMessage(a), endedOn: a.endsOn };
        return { mode: 'FULL', message: null, endedOn: null };
    }
    // The message for someone who may not even log in because of their client's state (null = they may, perhaps read-only)
    function blockedMessage(tenant, now = new Date()) {
        const m = accessMode(tenant, now);
        return m.mode === 'BLOCKED' ? m.message : null;
    }

    return { ENDED_MESSAGE, INACTIVE_MESSAGE, accessMode, readOnlyMessage, GRACE_DAYS, SOON_DAYS, UNITS, AccessError, dayOf, atMidnight, dayNo, dayFromNo, addDays, addMonths, isDay, access, cleanPeriod, setPeriod, renew, blockedMessage };
});
