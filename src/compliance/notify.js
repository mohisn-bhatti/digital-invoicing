// In-app notifications for the firm's staff (the CA's "Deadline Tracker - Notification" sheet and item 37, 24 Nov 2026).
//
// Two sorts:
//   - events: something happened (an obligation added, data received, task done, invoice created / issued, payment received). event()
//     makes the notification at once, for the person assigned to the obligation (else the client's person), or for everyone in the firm
//     who works on compliance when nobody is assigned.
//   - scheduled: the reminder dates, the due date and the days after it, the midpoints while the data collection or the task is open, a
//     client reminder not sent on its date, and every few days while an invoice is still to create, an invoice still to send or a
//     payment still to receive. Nothing is stored ahead: run() (the background job, every ten minutes) works them out from the current
//     state each time and makes those whose day has come, at the firm's notification hour on the firm's clock. So a changed date simply
//     gives a new notification (its key holds the date), and what is completed, archived, cancelled or deleted gives nothing more. Each
//     is made once: its key is unique per firm.
// The days are the firm's own (CmpSettings.notifyRules: the panel on the right of the Notifications page) and so is which kinds are made
// (notifyPrefs: Settings). The dashboard shows what was made and what is still to come in a stretch of dates (worked out, not stored).
//   event(ctx, kind, data)   never throws, never holds up the request
//   forget(tenantId, where)  an obligation (or a client) is deleted: its notifications go too
//   run({ tenantId, limit }) the background job
//   registerRoutes(r)        /api/cmp/notify/*
const R = require('../../public/cmp-rules');
const C = require('../../public/cmp-countries');
const V = require('./validate');
const { bad, ciContains } = require('./common');

// A day missed (the server was asleep) is still made up to this many days later; older ones are not, so a firm is not flooded with
// years of past dates on the first run.
const LOOK_BACK = 3;
const dateOf = ymd => new Date(ymd + 'T00:00:00Z');
const ymd = R.ymdOf;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// kind → [group, label]. Groups, as the CA's Settings name them: TASK "Task and deadline alerts", BILLING "Invoice and payment alerts",
// FAILED "Failed reminder alerts".
const KINDS = {
    OBLIGATION_CREATED: ['TASK', 'New obligation'],
    REMINDER: ['TASK', 'Reminder dates (1st, 2nd, 3rd reminder)'],
    DUE_DATE: ['TASK', 'Due date'],
    AFTER_DUE: ['TASK', 'Overdue: days after the due date'],
    DATA_MIDPOINT: ['TASK', 'Data still to collect (midway between the dates)'],
    DATA_RECEIVED: ['TASK', 'Data received'],
    TASK_MIDPOINT: ['TASK', 'Task still open (midway between the dates)'],
    TASK_DONE: ['TASK', 'Task completed'],
    INVOICE_PENDING: ['BILLING', 'Invoice still to create (every few days)'],
    INVOICE_CREATED: ['BILLING', 'Invoice created'],
    ISSUE_PENDING: ['BILLING', 'Invoice still to send to the client (every few days)'],
    INVOICE_ISSUED: ['BILLING', 'Invoice issued'],
    RECEIPT_PENDING: ['BILLING', 'Payment still to receive (every few days)'],
    RECEIPT: ['BILLING', 'Payment received'],
    REMINDER_MISSED: ['FAILED', 'Client reminder not sent on its date'],
};
const GROUPS = { TASK: ['taskAlerts', 'Task and deadline alerts'], BILLING: ['invoiceAlerts', 'Invoice and payment alerts'], FAILED: ['failedAlerts', 'Failed reminder alerts'] };
const EVENTS = ['OBLIGATION_CREATED', 'DATA_RECEIVED', 'TASK_DONE', 'INVOICE_CREATED', 'INVOICE_ISSUED', 'RECEIPT'];
const BILLING_KINDS = Object.keys(KINDS).filter(k => KINDS[k][0] === 'BILLING');
// the order of one day's notifications on the dashboard: the most urgent first
const ORDER = ['AFTER_DUE', 'DUE_DATE', 'REMINDER_MISSED', 'REMINDER', 'DATA_MIDPOINT', 'TASK_MIDPOINT', 'RECEIPT_PENDING', 'ISSUE_PENDING', 'INVOICE_PENDING',
    'OBLIGATION_CREATED', 'DATA_RECEIVED', 'TASK_DONE', 'INVOICE_CREATED', 'INVOICE_ISSUED', 'RECEIPT'];

/* ---------- preferences (Settings: which notifications are made) ---------- */
const DEFAULT_PREFS = Object.freeze({ inApp: true, taskAlerts: true, invoiceAlerts: true, failedAlerts: true, events: Object.freeze(Object.fromEntries(Object.keys(KINDS).map(k => [k, true]))) });
// { inApp, taskAlerts, invoiceAlerts, failedAlerts, events: { KIND: true|false } }: what is left out takes its default (on); a kind this
// version does not know is dropped
function cleanPrefs(v) {
    if (v === undefined || v === null) v = {};
    if (typeof v !== 'object' || Array.isArray(v)) throw bad('The notification settings must be a set of on / off switches.');
    const onOff = (x, what) => { if (x === undefined || x === null) return true; if (typeof x !== 'boolean') throw bad(`${what}: choose on or off.`); return x; };
    const out = { inApp: onOff(v.inApp, 'In-app notifications') };
    for (const [pref, label] of Object.values(GROUPS)) out[pref] = onOff(v[pref], label);
    const ev = v.events === undefined || v.events === null ? {} : v.events;
    if (typeof ev !== 'object' || Array.isArray(ev)) throw bad('The notification preferences by event must be a set of on / off switches.');
    out.events = Object.fromEntries(Object.keys(KINDS).map(k => [k, onOff(ev[k], KINDS[k][1])]));
    return out;
}
// what is stored, read leniently: a value that no longer fits must not stop the notifications
const readPrefs = v => { try { return cleanPrefs(v); } catch { return cleanPrefs({}); } };
const wants = (prefs, kind) => Boolean(prefs.inApp && KINDS[kind] && prefs[GROUPS[KINDS[kind][0]][0]] && prefs.events[kind]);

/* ---------- the trigger days (the panel on the right of the Notifications page) ---------- */
// The sheet's days are the defaults: on each reminder date, on the due date, 1, 3 and 7 days after it, every 3rd day while billing is open.
const DEFAULT_RULES = Object.freeze({ reminderBefore: 0, dueBefore: Object.freeze([0]), afterDue: Object.freeze([1, 3, 7]), invoiceEvery: 3, issueEvery: 3, receiptEvery: 3, missedAfter: 1, retryAttempts: 3 });
// key → [what it is, smallest, largest, a list of days?]
const RULES = {
    reminderBefore: ['Days before each reminder date (0 = on the date)', 0, 30],
    dueBefore: ['Days before the due date (0 = on the due date)', 0, 365, true],
    afterDue: ['Days after the due date', 1, 365, true],
    invoiceEvery: ['Invoice still to create: every so many days', 1, 90],
    issueEvery: ['Invoice still to send: every so many days', 1, 90],
    receiptEvery: ['Payment still to receive: every so many days', 1, 90],
    missedAfter: ['Reminder not sent: days after its date', 1, 30],
    retryAttempts: ['Tries for a notification that failed', 1, 10],
};
function cleanRules(v) {
    if (v === undefined || v === null) v = {};
    if (typeof v !== 'object' || Array.isArray(v)) throw bad('The notification days must be given by name.');
    const whole = (x, [what, min, max]) => {
        const n = typeof x === 'string' && x.trim() !== '' ? Number(x.trim()) : x;
        if (!Number.isInteger(n) || n < min || n > max) throw bad(`${what}: enter a whole number from ${min} to ${max}.`);
        return n;
    };
    const out = {};
    for (const [key, spec] of Object.entries(RULES)) {
        const x = v[key];
        if (x === undefined || x === null) { out[key] = Array.isArray(DEFAULT_RULES[key]) ? [...DEFAULT_RULES[key]] : DEFAULT_RULES[key]; continue; }
        if (!spec[3]) { out[key] = whole(x, spec); continue; }
        // a list of days: [1, 3, 7] or "1, 3, 7"; each once, in order; none at all is allowed (that day is not used)
        const list = Array.isArray(x) ? x : typeof x === 'string' ? x.split(/[\s,;]+/).filter(Boolean) : null;
        if (!list) throw bad(`${spec[0]}: enter the days as a list, e.g. 1, 3, 7.`);
        if (list.length > 10) throw bad(`${spec[0]}: at most 10 days.`);
        out[key] = [...new Set(list.map(n => whole(n, spec)))].sort((a, b) => a - b);
    }
    return out;
}
const readRules = v => { try { return cleanRules(v); } catch { return cleanRules({}); } };

const errText = e => String((e && e.message) || e || 'failed').slice(0, 500);

function createNotify({ prisma, audit, common, obligations, now = () => new Date(), deliver = null } = {}) {
    // deliver(notification): another way it is passed on once made (none yet: in-app only; e-mail to staff could plug in here). A failure
    // is kept on the notification (FAILED, with the error) and tried again at the next runs, up to the firm's number of tries.

    /* ---------- the firm ---------- */
    async function config(tenantId) {
        const s = await prisma.cmpSettings.findUnique({ where: { tenantId }, select: { timeZone: true, notifyHour: true, notifyPrefs: true, notifyRules: true, dateFormat: true, numberFormat: true } });
        return { tz: (s && s.timeZone) || 'Asia/Karachi', hour: s && Number.isInteger(s.notifyHour) ? s.notifyHour : 9, prefs: readPrefs(s && s.notifyPrefs), rules: readRules(s && s.notifyRules),
            dateFormat: (s && s.dateFormat) || 'D MMM YYYY', numberFormat: (s && s.numberFormat) || '1,234.56' };
    }
    const fmt = (cfg, d) => R.fmtDay(d, cfg.dateFormat);
    const money = (cfg, n, cur) => { const d = C.currencyDecimals(cur); return `${cur} ${typeof R.fmtNum === 'function' ? R.fmtNum(Number(n), d, cfg.numberFormat) : Number(n).toFixed(d)}`; };
    // the team members who can still sign in: a notification for someone who left goes to the next person, else to everyone
    async function team(tenantId) {
        return new Set((await prisma.user.findMany({ where: { tenantId, role: 'CLIENT_USER', active: true }, select: { id: true } })).map(u => u.id));
    }
    const pick = (people, ...ids) => ids.find(id => id && people.has(id)) || null;
    // the last day whose notifications are due: today once the firm's hour has come, else yesterday
    function clock(cfg, at = now()) {
        const today = R.dayIn(cfg.tz, at);
        return { today, upTo: +at >= +R.zoned(today, cfg.hour, 0, cfg.tz) ? today : R.addDays(today, -1) };
    }

    /* ---------- the scheduled notifications of one open period ---------- */
    // p: { id, obligationId, clientId, userId, label, period, periodEnd, dueDate, dataCollectedOn, reminders: [{ id, n, date, sent }] }
    function periodTriggers(p, cfg, from, to, { coming = false } = {}) {
        const out = [], r = cfg.rules, due = p.dueDate, f = d => fmt(cfg, d);
        const add = (kind, key, day, title, body) => {
            if (day < from || day > to || !wants(cfg.prefs, kind)) return;
            out.push({ kind, key, forDay: day, title, body, userId: p.userId, clientId: p.clientId, obligationId: p.obligationId, occurrenceId: p.id, invoiceId: null });
        };
        const tail = `${p.period}, due ${f(due)}.`;
        // the reminder dates as the obligations compute them (a reminder already sent needs no notification), and the day after one that
        // was not sent (the CA's "failed reminder alerts")
        for (const m of p.reminders) {
            if (m.sent) continue;
            const nth = R.ordinal(m.n);
            add('REMINDER', `REM:${p.id}:${m.id}:${m.date}:${r.reminderBefore}`, R.addDays(m.date, -r.reminderBefore), `${nth} reminder: ${p.label}`,
                `The ${nth} reminder ${r.reminderBefore ? `comes due on ${f(m.date)}` : `is due on ${f(m.date)}`}: send it to the client. ${tail}`);
            if (!coming) add('REMINDER_MISSED', `MISS:${p.id}:${m.id}:${m.date}`, R.addDays(m.date, r.missedAfter), `${nth} reminder not sent: ${p.label}`,
                `It came due on ${f(m.date)} and was not sent or marked done. ${tail}`);
        }
        for (const n of r.dueBefore) add('DUE_DATE', `DUE:${p.id}:${due}:${n}`, R.addDays(due, -n), n ? `Due in ${plural(n, 'day')}: ${p.label}` : `Due date: ${p.label}`,
            `Due on ${f(due)} and not completed yet. ${p.period}.`);
        for (const n of r.afterDue) add('AFTER_DUE', `LATE:${p.id}:${due}:${n}`, R.addDays(due, n), `Overdue by ${plural(n, 'day')}: ${p.label}`,
            `It was due on ${f(due)} and is not completed. ${p.period}.`);
        // midway between each two dates of: the period end, the reminders that are set, the due date (the CA: data collection while it is
        // open; the task while it is open, i.e. once the data is in)
        const points = [...new Set([p.periodEnd, ...p.reminders.map(m => m.date), due])].filter(d => d >= p.periodEnd && d <= due).sort();
        for (let i = 1; i < points.length; i++) {
            const gap = R.daysBetween(points[i - 1], points[i]);
            if (gap < 2) continue; // (no day between them)
            const mid = R.addDays(points[i - 1], Math.floor(gap / 2));
            if (!p.dataCollectedOn) add('DATA_MIDPOINT', `DMID:${p.id}:${mid}`, mid, `Data still to collect: ${p.label}`, `The client's data has not come in yet. ${tail}`);
            else if (mid >= p.dataCollectedOn) add('TASK_MIDPOINT', `TMID:${p.id}:${mid}`, mid, `Task still open: ${p.label}`, `The data came in on ${f(p.dataCollectedOn)}; the task is not done yet. ${tail}`);
        }
        return out;
    }
    // every so many days from the day a billing step opened, while it is open (the dashboard: the next two, in case today's is made
    // already; it shows one and says the rest repeat)
    function cadence(open, every, from, to, coming) {
        const days = [];
        if (!open || !every) return days;
        for (let k = Math.max(1, Math.ceil(R.daysBetween(open, from) / every)); ; k++) {
            const d = R.addDays(open, k * every);
            if (d > to) break;
            days.push(d);
            if (coming && days.length === 2) break;
        }
        return days;
    }

    const OB_SELECT = { id: true, name: true, assignedToId: true, amberDays: true, client: { select: { id: true, name: true, code: true, timeZone: true, assignedToId: true } }, reminders: { select: { id: true, offsetDays: true, templateId: true, body: true } } };
    const live = { archivedAt: null, client: { archivedAt: null } };
    // one period as periodTriggers needs it; its reminders' dates come from obligations.present (the same days the tracker shows)
    function periodOf(o, ob, { settings, sent, at, people }) {
        const v = obligations.present(o, { reminders: obligations.reminderList(ob.reminders), tz: ob.client.timeZone, settings, sent, at, amberDays: ob.amberDays });
        return { id: o.id, obligationId: ob.id, clientId: ob.client.id, userId: pick(people, ob.assignedToId, ob.client.assignedToId), label: `${ob.name} — ${ob.client.name}`, period: R.periodName(o),
            periodEnd: ymd(o.periodEnd), dueDate: ymd(o.dueDate), dataCollectedOn: o.dataCollectedOn ? ymd(o.dataCollectedOn) : null,
            reminders: v.view.reminders.map((m, i) => ({ id: m.id, n: i + 1, date: m.date, sent: m.state === 'SENT' || m.sentCount > 0 })) };
    }

    // Every scheduled notification of a firm whose day falls in from..to, from the state things are in now. coming: for the dashboard (the
    // periods still to come too; billing reminders only the next one each)
    async function scheduled(tenantId, cfg, from, to, { coming = false } = {}) {
        const at = now(), r = cfg.rules, out = [], f = d => fmt(cfg, d);
        const [settings, people] = await Promise.all([common.settings(tenantId), team(tenantId)]);
        const ctx = { settings, at, people };

        // 1. the periods not completed (a reminder is at most a year from its due date, the days after it at most a year too)
        const open = await prisma.cmpOccurrence.findMany({
            where: { tenantId, stage: { not: 'COMPLETED' }, obligation: live, dueDate: { gte: dateOf(R.addDays(from, -400)), lte: dateOf(R.addDays(to, 400)) } },
            take: 5000, orderBy: { dueDate: 'asc' }, include: { obligation: { select: OB_SELECT } },
        });
        const sent = await obligations.sentMap(open.map(o => o.id));
        for (const o of open) out.push(...periodTriggers(periodOf(o, o.obligation, { ...ctx, sent }), cfg, from, to, { coming }));

        // 2. the periods done whose invoice is still to create (the tracker's "Invoice created" pending: no invoice with a number yet, and
        // not closed without one)
        const add = (kind, key, day, base, title, body) => { if (wants(cfg.prefs, kind)) out.push({ kind, key, forDay: day, title, body, ...base }); };
        if (wants(cfg.prefs, 'INVOICE_PENDING')) {
            const done = await prisma.cmpOccurrence.findMany({
                where: { tenantId, stage: 'COMPLETED', OR: [{ closeKind: null }, { closeKind: { not: 'FREE' } }], completedOn: { lte: dateOf(to) }, obligation: live },
                take: 5000, orderBy: { completedOn: 'desc' },
                select: { id: true, seq: true, periodStart: true, periodEnd: true, dueDate: true, completedOn: true, obligation: { select: { id: true, name: true, assignedToId: true, client: { select: { id: true, name: true, assignedToId: true } } } } },
            });
            const ids = done.map(o => o.id), billed = new Set();
            if (ids.length) {
                const invs = await prisma.cmpInvoice.findMany({ where: { tenantId, status: { not: 'CANCELLED' }, number: { not: null }, OR: [{ occurrenceId: { in: ids } }, { lines: { some: { occurrenceId: { in: ids } } } }] },
                    select: { occurrenceId: true, lines: { where: { occurrenceId: { in: ids } }, select: { occurrenceId: true } } } });
                for (const i of invs) { if (i.occurrenceId) billed.add(i.occurrenceId); for (const l of i.lines) billed.add(l.occurrenceId); }
            }
            for (const o of done) {
                if (billed.has(o.id)) continue;
                const ob = o.obligation, open1 = ymd(o.completedOn), label = `${ob.name} — ${ob.client.name}`;
                const base = { userId: pick(people, ob.assignedToId, ob.client.assignedToId), clientId: ob.client.id, obligationId: ob.id, occurrenceId: o.id, invoiceId: null, repeats: r.invoiceEvery };
                for (const day of cadence(open1, r.invoiceEvery, from, to, coming)) add('INVOICE_PENDING', `INVP:${o.id}:${day}`, day, base, `Invoice to create: ${label}`, `The task was completed on ${f(open1)} and there is no invoice yet. ${R.periodName(o)}.`);
            }
        }

        // 3. invoices issued and not sent to the client yet, and invoices sent and not paid in full (the tracker's "Invoice issued" and
        // "Receipt"); never for a cancelled one, nor an archived client's or obligation's
        if (wants(cfg.prefs, 'ISSUE_PENDING') || wants(cfg.prefs, 'RECEIPT_PENDING')) {
            const invs = await prisma.cmpInvoice.findMany({
                where: { tenantId, status: { in: ['ISSUED', 'SENT', 'PARTIAL'] }, number: { not: null }, client: { archivedAt: null } }, take: 5000, orderBy: { createdAt: 'desc' },
                select: { id: true, number: true, status: true, currency: true, total: true, received: true, advanceAdjusted: true, issueDate: true, issuedAt: true, sentAt: true,
                    client: { select: { id: true, name: true, assignedToId: true } }, occurrence: { select: { id: true, obligation: { select: { id: true, archivedAt: true, assignedToId: true } } } },
                    receipts: { where: { voidedAt: null, settlement: '' }, orderBy: { receivedOn: 'asc' }, take: 1, select: { receivedOn: true } } },
            });
            for (const i of invs) {
                const ob = i.occurrence ? i.occurrence.obligation : null;
                if (ob && ob.archivedAt) continue;
                const base = { userId: pick(people, ob && ob.assignedToId, i.client.assignedToId), clientId: i.client.id, obligationId: ob ? ob.id : null, occurrenceId: i.occurrence ? i.occurrence.id : null, invoiceId: i.id };
                if (i.status === 'ISSUED' && !i.sentAt) {
                    const open1 = ymd(i.issueDate) || R.dayIn(cfg.tz, i.issuedAt || at);
                    for (const day of cadence(open1, r.issueEvery, from, to, coming)) add('ISSUE_PENDING', `ISSP:${i.id}:${day}`, day, { ...base, repeats: r.issueEvery }, `Invoice to send: ${i.number} — ${i.client.name}`,
                        `Issued on ${f(open1)} for ${money(cfg, i.total, i.currency)}; not sent to the client yet.`);
                } else {
                    const open1 = i.sentAt ? R.dayIn(cfg.tz, i.sentAt) : i.receipts[0] ? ymd(i.receipts[0].receivedOn) : ymd(i.issueDate);
                    const owed = Number(i.total) - Number(i.advanceAdjusted || 0) - Number(i.received);
                    for (const day of cadence(open1, r.receiptEvery, from, to, coming)) add('RECEIPT_PENDING', `RCTP:${i.id}:${day}`, day, { ...base, repeats: r.receiptEvery }, `Payment to receive: ${i.number} — ${i.client.name}`,
                        `${money(cfg, owed, i.currency)} still due${i.sentAt ? ` (sent on ${f(open1)})` : ''}.`);
                }
            }
        }

        // 4. the dashboard only: the periods still to come, not made yet (shown as Planned on the calendar), with the same rules
        if (coming) {
            const obs = await prisma.cmpObligation.findMany({ where: { tenantId, ...live }, take: 3000,
                select: { ...OB_SELECT, frequency: true, yearsTotal: true, basePeriodStart: true, basePeriodEnd: true, baseDueDate: true, baseSeq: true, occurrences: { orderBy: { seq: 'desc' }, take: 1, select: { seq: true } } } });
            const none = new Map();
            for (const ob of obs) {
                const series = { basePeriodStart: ymd(ob.basePeriodStart), basePeriodEnd: ymd(ob.basePeriodEnd), baseDueDate: ymd(ob.baseDueDate), baseSeq: ob.baseSeq, frequency: ob.frequency, yearsTotal: ob.yearsTotal };
                for (const d of R.projectPeriods(series, (ob.occurrences[0] ? ob.occurrences[0].seq : 0) + 1, R.addDays(to, 400), 120)) {
                    if (R.addDays(d.dueDate, 400) < from) continue;
                    const o = { id: `plan:${ob.id}:${d.seq}`, seq: d.seq, periodStart: dateOf(d.periodStart), periodEnd: dateOf(d.periodEnd), dueDate: dateOf(d.dueDate), stage: 'OPEN', datesConfirmed: false, overridden: false, notes: '' };
                    out.push(...periodTriggers(periodOf(o, ob, { ...ctx, sent: none }), cfg, from, to, { coming: true }));
                }
            }
        }
        return out;
    }

    /* ---------- events ---------- */
    const eventKey = (kind, d) => {
        const id = { OBLIGATION_CREATED: d.obligationId, DATA_RECEIVED: d.occurrenceId, TASK_DONE: d.occurrenceId, INVOICE_CREATED: d.invoiceId, INVOICE_ISSUED: d.invoiceId, RECEIPT: d.receiptId }[kind];
        if (!id || /[:\s]/.test(String(id))) return null;
        return `EV:${kind}:${id}${kind === 'DATA_RECEIVED' || kind === 'TASK_DONE' ? `:${R.ymdOk(String(d.day || '')) ? d.day : ''}` : ''}`;
    };
    // (a failed one is made again from its key, which holds all it is about)
    const dataOfKey = key => {
        const [, kind, id, day] = String(key).split(':');
        const field = { OBLIGATION_CREATED: 'obligationId', DATA_RECEIVED: 'occurrenceId', TASK_DONE: 'occurrenceId', INVOICE_CREATED: 'invoiceId', INVOICE_ISSUED: 'invoiceId', RECEIPT: 'receiptId' }[kind];
        return { kind, data: { [field]: id, day: day || undefined } };
    };
    const INV_SELECT = { id: true, number: true, status: true, currency: true, total: true, received: true, advanceAdjusted: true, issueDate: true,
        client: { select: { id: true, name: true, assignedToId: true, archivedAt: true } },
        occurrence: { select: { id: true, seq: true, periodStart: true, periodEnd: true, dueDate: true, obligation: { select: { id: true, name: true, assignedToId: true, archivedAt: true } } } } };
    // The notification an event makes, or null when there is nothing to say (it is gone, archived or cancelled)
    async function composeEvent(tenantId, cfg, kind, d) {
        const key = eventKey(kind, d);
        if (!key) return null;
        const people = await team(tenantId), today = R.dayIn(cfg.tz, now()), f = x => fmt(cfg, x);
        const base = { kind, key, forDay: today, invoiceId: null };
        if (kind === 'OBLIGATION_CREATED') {
            const ob = await prisma.cmpObligation.findFirst({ where: { id: String(d.obligationId), tenantId }, select: { id: true, name: true, assignedToId: true, archivedAt: true,
                client: { select: { id: true, name: true, assignedToId: true, archivedAt: true } }, occurrences: { orderBy: { seq: 'asc' }, take: 1, select: { id: true, periodStart: true, periodEnd: true, dueDate: true } } } });
            if (!ob || ob.archivedAt || ob.client.archivedAt) return null;
            const first = ob.occurrences[0], userId = pick(people, ob.assignedToId, ob.client.assignedToId);
            return { ...base, userId, clientId: ob.client.id, obligationId: ob.id, occurrenceId: first ? first.id : null, title: `New obligation: ${ob.name} — ${ob.client.name}`,
                body: `${first ? `${R.periodName(first)}, due ${f(first.dueDate)}. ` : ''}${userId ? 'Assigned to you.' : 'Nobody is assigned to it yet.'}` };
        }
        if (kind === 'DATA_RECEIVED' || kind === 'TASK_DONE') {
            const o = await prisma.cmpOccurrence.findFirst({ where: { id: String(d.occurrenceId), tenantId }, select: { id: true, seq: true, periodStart: true, periodEnd: true, dueDate: true, dataCollectedOn: true, completedOn: true, closeKind: true,
                obligation: { select: { id: true, name: true, assignedToId: true, archivedAt: true, client: { select: { id: true, name: true, assignedToId: true, archivedAt: true } } } } } });
            if (!o || o.obligation.archivedAt || o.obligation.client.archivedAt) return null;
            const ob = o.obligation, label = `${ob.name} — ${ob.client.name}`;
            const day = R.ymdOk(String(d.day || '')) ? d.day : ymd((kind === 'DATA_RECEIVED' ? o.dataCollectedOn : o.completedOn) || dateOf(today));
            const more = { userId: pick(people, ob.assignedToId, ob.client.assignedToId), clientId: ob.client.id, obligationId: ob.id, occurrenceId: o.id };
            if (kind === 'DATA_RECEIVED') return { ...base, ...more, title: `Data received: ${label}`, body: `${R.periodName(o)}: the client's data came in on ${f(day)}. Due ${f(o.dueDate)}; the task is next.` };
            return { ...base, ...more, title: `Task completed: ${label}`, body: `${R.periodName(o)}: done on ${f(day)}. ${o.closeKind === 'FREE' ? 'Closed without an invoice.' : 'The invoice is next.'}` };
        }
        let inv, receipt = null;
        if (kind === 'RECEIPT') {
            receipt = await prisma.cmpReceipt.findFirst({ where: { id: String(d.receiptId), tenantId }, select: { id: true, number: true, amount: true, receivedOn: true, voidedAt: true, invoice: { select: INV_SELECT } } });
            if (!receipt || receipt.voidedAt) return null;
            inv = receipt.invoice;
        } else inv = await prisma.cmpInvoice.findFirst({ where: { id: String(d.invoiceId), tenantId }, select: INV_SELECT });
        if (!inv || inv.status === 'CANCELLED' || inv.client.archivedAt) return null;
        const occ = inv.occurrence, ob = occ ? occ.obligation : null;
        if (ob && ob.archivedAt) return null;
        const what = ob ? `${ob.name} ${R.periodName(occ)}` : '';
        const more = { userId: pick(people, ob && ob.assignedToId, inv.client.assignedToId), clientId: inv.client.id, obligationId: ob ? ob.id : null, occurrenceId: occ ? occ.id : null, invoiceId: inv.id };
        if (kind === 'INVOICE_CREATED') {
            return { ...base, ...more, title: `Invoice created: ${inv.number || 'draft'} — ${inv.client.name}`,
                body: `${what ? `${what}. ` : ''}${Number(inv.total) > 0 ? `${money(cfg, inv.total, inv.currency)}. ` : 'The fee is still to enter. '}${inv.number ? 'Next: send it to the client.' : 'Next: issue it.'}` };
        }
        if (kind === 'INVOICE_ISSUED') {
            return { ...base, ...more, title: `Invoice issued: ${inv.number || 'draft'} — ${inv.client.name}`,
                body: `${money(cfg, inv.total, inv.currency)}${inv.issueDate ? ` dated ${f(inv.issueDate)}` : ''}${what ? ` for ${what}` : ''}. Next: send it to the client.` };
        }
        const owed = Number(inv.total) - Number(inv.advanceAdjusted || 0) - Number(inv.received);
        return { ...base, ...more, title: `Payment received: ${receipt.number} — ${inv.client.name}`,
            body: `${money(cfg, receipt.amount, inv.currency)} received on ${f(receipt.receivedOn)} for invoice ${inv.number}. ${owed > 0 ? `${money(cfg, owed, inv.currency)} still due.` : 'Paid in full.'}` };
    }

    /* ---------- making one ---------- */
    const rowData = (tenantId, t, extra = {}) => ({ tenantId, key: t.key, kind: t.kind, userId: t.userId || null, clientId: t.clientId || null, obligationId: t.obligationId || null,
        occurrenceId: t.occurrenceId && !String(t.occurrenceId).startsWith('plan:') ? t.occurrenceId : null, invoiceId: t.invoiceId || null,
        title: String(t.title).slice(0, 300), body: String(t.body || '').slice(0, 2000), forDay: dateOf(t.forDay), readBy: t.readBy || [], ...extra });
    // Made once (the key is unique per firm: a second run, or two at once, finds it there), then passed on; a failure is kept with its error.
    // Returns 1 when it was made and passed on.
    async function make(tenantId, t) {
        try { await prisma.cmpNotification.create({ data: rowData(tenantId, t) }); } catch (e) { if (e.code === 'P2002') return 0; throw e; }
        if (!deliver) return 1;
        try { await deliver({ tenantId, ...t }); return 1; } catch (e) {
            await prisma.cmpNotification.update({ where: { tenantId_key: { tenantId, key: t.key } }, data: { status: 'FAILED', lastError: errText(e) } });
            return 0;
        }
    }
    // One more try of a failed one (t: what it says now; null when it could not be worked out). The try is claimed first, so two runs at
    // once never count it twice.
    async function retry(tenantId, row, t) {
        const claim = await prisma.cmpNotification.updateMany({ where: { id: row.id, status: 'FAILED', attempts: row.attempts }, data: { attempts: row.attempts + 1 } });
        if (!claim.count) return 0;
        try {
            if (!t) throw new Error('What it is about could not be found.');
            if (deliver) await deliver({ tenantId, ...t });
            await prisma.cmpNotification.update({ where: { id: row.id }, data: { status: 'DONE', lastError: '', title: String(t.title).slice(0, 300), body: String(t.body || '').slice(0, 2000), createdAt: now() } });
            return 1;
        } catch (e) {
            await prisma.cmpNotification.update({ where: { id: row.id }, data: { lastError: errText(e) } });
            return 0;
        }
    }

    // Something happened (common.notify calls this without waiting): never throws
    async function event(ctx, kind, data = {}) {
        try {
            if (!prisma || !ctx || !ctx.tenantId || !EVENTS.includes(kind)) return;
            const cfg = await config(ctx.tenantId);
            if (!wants(cfg.prefs, kind)) return;
            let t;
            try { t = await composeEvent(ctx.tenantId, cfg, kind, data || {}); } catch (err) {
                // kept as failed (its key holds what it is about), and made again at the next run
                const key = eventKey(kind, data || {});
                if (!key) throw err;
                await prisma.cmpNotification.create({ data: rowData(ctx.tenantId, { key, kind, title: KINDS[kind][1], forDay: R.dayIn(cfg.tz, now()), obligationId: data.obligationId, occurrenceId: data.occurrenceId, invoiceId: data.invoiceId },
                    { status: 'FAILED', lastError: errText(err) }) }).catch(e => { if (e.code !== 'P2002') throw e; });
                return;
            }
            if (!t) return;
            if (ctx.userId) t.readBy = [ctx.userId]; // (the person who did it knows already)
            await make(ctx.tenantId, t);
        } catch (err) { console.error('compliance notification not made:', kind, err.message); }
    }

    // An obligation (or a client) deleted: its notifications go too (those still to come were never stored)
    async function forget(tenantId, where = {}) {
        try {
            if (!prisma || !tenantId) return;
            const w = where.obligationId ? { obligationId: String(where.obligationId) } : where.clientId ? { clientId: String(where.clientId) } : null;
            if (w) await prisma.cmpNotification.deleteMany({ where: { tenantId, ...w } });
        } catch (err) { console.error('compliance notifications not removed:', err.message); }
    }

    /* ---------- the background job ---------- */
    async function runFirm(tenantId, limit) {
        const cfg = await config(tenantId);
        if (!cfg.prefs.inApp) return 0;
        const { today, upTo } = clock(cfg), from = R.addDays(today, -LOOK_BACK);
        let made = 0;
        const due = upTo >= from ? await scheduled(tenantId, cfg, from, upTo) : [];
        const have = new Set((await prisma.cmpNotification.findMany({ where: { tenantId, forDay: { gte: dateOf(from), lte: dateOf(upTo) } }, select: { key: true } })).map(x => x.key));
        const fresh = new Set();
        for (const t of due) {
            if (made >= limit) break;
            if (have.has(t.key)) continue;
            fresh.add(t.key);
            made += await make(tenantId, t);
        }
        // the failed ones (not those that failed just now), once more each run, up to the firm's number of tries: an event is made again
        // from its key; a scheduled one only while it is still due (not done, moved, archived or too old since)
        const byKey = new Map(due.map(t => [t.key, t]));
        const again = await prisma.cmpNotification.findMany({ where: { tenantId, status: 'FAILED', attempts: { lt: cfg.rules.retryAttempts } }, orderBy: { createdAt: 'asc' }, take: 50 });
        for (const row of again) {
            if (fresh.has(row.key)) continue;
            let t = null;
            if (EVENTS.includes(row.kind)) {
                const { kind, data } = dataOfKey(row.key);
                try { t = await composeEvent(tenantId, cfg, kind, data); } catch { t = null; }
            } else {
                t = byKey.get(row.key);
                if (!t) continue;
            }
            made += await retry(tenantId, row, t);
        }
        return made;
    }
    // tenantId: that firm only (the tests); otherwise every active firm with the module. limit: at most so many made in one run (the rest
    // come at the next one, ten minutes later, while they are within the look-back)
    async function run({ tenantId = null, limit = 500 } = {}) {
        if (!prisma) return { made: 0 };
        const firms = await prisma.tenant.findMany({ where: { active: true, modules: { has: 'COMPLIANCE' }, ...(tenantId ? { id: tenantId } : {}) }, select: { id: true }, take: 5000 });
        let made = 0;
        for (const f of firms) {
            if (made >= limit) break;
            try { made += await runFirm(f.id, limit - made); } catch (err) { console.error('compliance notifications failed for a firm:', err.message); }
        }
        return { made };
    }

    /* ---------- what a user sees ---------- */
    const readerOf = ctx => ctx.userId || 'ADMIN'; // (the administrator in a workspace reads as one)
    // their own and the firm-wide ones (everyone's for full access, when asked, and for the administrator in a workspace); the money ones
    // need the invoice permission; failed ones only for full access
    function visible(ctx, everyone) {
        const AND = [];
        if (ctx.userId && !(everyone && ctx.perms.has('FULL'))) AND.push({ OR: [{ userId: ctx.userId }, { userId: null }] });
        if (!ctx.perms.has('INVOICE')) AND.push({ kind: { notIn: BILLING_KINDS } });
        if (!ctx.perms.has('FULL')) AND.push({ status: 'DONE' });
        return AND;
    }
    const seesComing = (ctx, everyone, t) => (!ctx.userId || (everyone && ctx.perms.has('FULL')) || !t.userId || t.userId === ctx.userId) && (ctx.perms.has('INVOICE') || !BILLING_KINDS.includes(t.kind));
    const RECENT = 90; // days: the bell counts what was made in this time
    async function count(ctx) {
        const where = { tenantId: ctx.tenantId, status: 'DONE', createdAt: { gte: new Date(+now() - RECENT * R.DAY) }, NOT: { readBy: { has: readerOf(ctx) } }, AND: visible(ctx, false) };
        const [unread, latest] = await Promise.all([
            prisma.cmpNotification.count({ where }),
            prisma.cmpNotification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 3, select: { id: true, kind: true, title: true, createdAt: true } }),
        ]);
        return { unread, latest };
    }
    const view = (ctx, n) => ({ id: n.id, key: n.key, kind: n.kind, group: (KINDS[n.kind] || ['TASK'])[0], title: n.title, body: n.body, forDay: ymd(n.forDay), createdAt: n.createdAt,
        read: n.readBy.includes(readerOf(ctx)), status: n.status, userId: n.userId, clientId: n.clientId, obligationId: n.obligationId, occurrenceId: n.occurrenceId, invoiceId: n.invoiceId,
        ...(ctx.perms.has('FULL') ? { attempts: n.attempts, lastError: n.lastError } : {}) });
    const sortKey = t => `${t.forDay}|${String(ORDER.indexOf(t.kind)).padStart(2, '0')}|${t.title}`;

    // The dashboard: ?from=&to= (days, the firm's calendar; at most 400 days; default today), q (words in the title or text), who=all (full
    // access: everyone's). made: the notifications of those days; earlier: older ones not read yet; coming: those still to come in those
    // days (worked out now, not stored), the first 1000.
    async function list(ctx, q = {}) {
        const cfg = await config(ctx.tenantId), { today } = clock(cfg);
        const from = q.from ? V.day(q.from, 'From') : today, to = q.to ? V.day(q.to, 'To') : from;
        if (to < from) throw bad('The "To" date cannot be before the "From" date.');
        if (R.daysBetween(from, to) > 400) throw bad('Choose at most one year at a time.');
        const everyone = q.who === 'all' && ctx.perms.has('FULL'), text = String(q.q || '').trim().slice(0, 100);
        const where = extra => ({ tenantId: ctx.tenantId, ...extra, AND: [...visible(ctx, everyone), ...(text ? [{ OR: [{ title: ciContains(text) }, { body: ciContains(text) }] }] : [])] });
        const [made, earlier, unread] = await Promise.all([
            prisma.cmpNotification.findMany({ where: where({ forDay: { gte: dateOf(from), lte: dateOf(to) } }), orderBy: [{ forDay: 'asc' }, { createdAt: 'asc' }], take: 1000 }),
            prisma.cmpNotification.findMany({ where: where({ forDay: { lt: dateOf(from) }, status: 'DONE', createdAt: { gte: new Date(+now() - RECENT * R.DAY) }, NOT: { readBy: { has: readerOf(ctx) } } }), orderBy: [{ forDay: 'desc' }, { createdAt: 'desc' }], take: 100 }),
            count(ctx),
        ]);
        let coming = [];
        if (to >= today) {
            const start = from > today ? from : today;
            const have = new Set((await prisma.cmpNotification.findMany({ where: { tenantId: ctx.tenantId, forDay: { gte: dateOf(start), lte: dateOf(to) } }, select: { key: true } })).map(x => x.key));
            const words = text.toLowerCase();
            const repeating = new Set(); // (a billing reminder: only the next one, "then every N days")
            coming = (cfg.prefs.inApp ? await scheduled(ctx.tenantId, cfg, start, to, { coming: true }) : [])
                .filter(t => !have.has(t.key) && seesComing(ctx, everyone, t) && (!words || `${t.title} ${t.body}`.toLowerCase().includes(words)))
                .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))
                .filter(t => { if (!t.repeats) return true; const of = t.key.slice(0, t.key.lastIndexOf(':')); if (repeating.has(of)) return false; repeating.add(of); return true; });
        }
        const groups = { TASK: 0, BILLING: 0, FAILED: 0 };
        for (const t of [...made, ...coming]) groups[(KINDS[t.kind] || ['TASK'])[0]]++;
        return {
            today, from, to, timeZone: cfg.tz, notifyHour: cfg.hour, inApp: cfg.prefs.inApp, unread: unread.unread,
            made: made.map(n => view(ctx, n)), earlier: earlier.map(n => view(ctx, n)),
            coming: coming.slice(0, 1000).map(t => ({ key: t.key, kind: t.kind, group: KINDS[t.kind][0], title: t.title, body: t.body, forDay: t.forDay, coming: true, at: R.zoned(t.forDay, cfg.hour, 0, cfg.tz),
                repeats: t.repeats || null, userId: t.userId, clientId: t.clientId, obligationId: t.obligationId, occurrenceId: t.occurrenceId, invoiceId: t.invoiceId })),
            comingTotal: coming.length, groups,
            failed: ctx.perms.has('FULL') ? made.filter(n => n.status === 'FAILED').length : 0,
        };
    }
    // marked read by this user: { ids: [...] } or { all: true } (everything they see; who: 'all' for full access)
    async function markRead(ctx, b = {}) {
        const reader = readerOf(ctx), where = { tenantId: ctx.tenantId, NOT: { readBy: { has: reader } } };
        if (b.all === true) where.AND = visible(ctx, b.who === 'all');
        else {
            const ids = Array.isArray(b.ids) ? b.ids.map(String).filter(id => id && id.length <= 64).slice(0, 1000) : [];
            if (!ids.length) throw bad('Say which notifications were read.');
            where.id = { in: ids };
            where.AND = visible(ctx, true);
        }
        const r = await prisma.cmpNotification.updateMany({ where, data: { readBy: { push: reader } } });
        return { marked: r.count, ...(await count(ctx)) };
    }
    async function rules(ctx) {
        const cfg = await config(ctx.tenantId);
        return { rules: cfg.rules, prefs: cfg.prefs, notifyHour: cfg.hour, timeZone: cfg.tz, canEdit: ctx.perms.has('FULL'), defaults: { rules: DEFAULT_RULES, prefs: DEFAULT_PREFS },
            labels: Object.fromEntries(Object.entries(RULES).map(([k, v]) => [k, v[0]])), kinds: Object.entries(KINDS).map(([kind, [group, label]]) => ({ kind, group, label })), groups: GROUPS };
    }
    // the trigger days changed from the panel (the settings save can change them too: cleanRules)
    async function putRules(ctx, b = {}) {
        const next = cleanRules(b.rules !== undefined ? b.rules : b);
        const before = (await config(ctx.tenantId)).rules;
        await prisma.cmpSettings.upsert({ where: { tenantId: ctx.tenantId }, create: { tenantId: ctx.tenantId, notifyRules: next }, update: { notifyRules: next } });
        const txt = v => (Array.isArray(v) ? v.join(', ') || 'none' : String(v));
        const what = Object.keys(RULES).filter(k => txt(before[k]) !== txt(next[k])).map(k => `${RULES[k][0].toLowerCase()}: ${txt(before[k])} → ${txt(next[k])}`);
        if (what.length && audit) await audit(ctx.req, { tenantId: ctx.tenantId, action: 'cmp.settings.update', entityType: 'CmpSettings', entityId: ctx.tenantId, summary: `Notification days: ${what.join('; ')}`,
            details: { changes: Object.keys(RULES).filter(k => txt(before[k]) !== txt(next[k])).map(k => ({ field: RULES[k][0], old: txt(before[k]), new: txt(next[k]) })) } });
        return rules(ctx);
    }

    function registerRoutes({ route, can }) {
        route('get', '/api/cmp/notify', can('VIEW'), (req, ctx) => list(ctx, req.query));
        route('get', '/api/cmp/notify/count', can('VIEW'), (req, ctx) => count(ctx));
        route('post', '/api/cmp/notify/read', can('VIEW'), (req, ctx) => markRead(ctx, req.body || {}));
        route('get', '/api/cmp/notify/rules', can('VIEW'), (req, ctx) => rules(ctx));
        route('put', '/api/cmp/notify/rules', can('FULL'), (req, ctx) => putRules(ctx, req.body || {}));
    }

    return { event, forget, run, registerRoutes, list, count, markRead, rules, putRules, scheduled };
}

// each route and the permission(s) it asks for (test/cmpRouteGuards.test.js checks them)
const ROUTE_PERMS = {
    'GET /api/cmp/notify': ['VIEW'], 'GET /api/cmp/notify/count': ['VIEW'], 'POST /api/cmp/notify/read': ['VIEW'],
    'GET /api/cmp/notify/rules': ['VIEW'], 'PUT /api/cmp/notify/rules': ['FULL'],
};

module.exports = { createNotify, ROUTE_PERMS, DEFAULT_PREFS, DEFAULT_RULES, cleanPrefs, cleanRules, KINDS, EVENTS, LOOK_BACK };
