// The Reports page's catalogue (the CA's "Deadline Tracker - Reports" sheet, 24 Nov 2026): every report of the sheet in its categories,
// each one a table with its columns, its totals (one line per currency: different currencies are never added together) and a short note
// wherever the data cannot say a thing literally. The seven reports of the old Reports page live on inside it, read from the same
// reports.report() as before: obligations → Obligation Register, overdue, upcoming, invoices → Invoice Register, receipts → Receipt
// Register, clients summary → Obligation Performance and Customer Balance, invoice aging → Receivables Aging.
//   registerRoutes(r)   GET /api/cmp/catalog (what this user may see), /api/cmp/catalog/:key (one report) and /api/cmp/catalog/:key/export
//   run(ctx, key, q)    one report: { key, title, info, columns [{ key, label, type }], rows, totals, cards, note }
//   list(ctx)           the categories and the reports this user may open
// Column types: text, day (a calendar day), at (a moment, shown on the firm's clock), money (in the row's currency), number.
// Every report needs REPORTS; the money ones need INVOICE too, the history ones (read from the activity log) LOGS too.
const R = require('../../public/cmp-rules');
const C = require('../../public/cmp-countries');
const V = require('./validate');
const { CmpError, bad, ciContains } = require('./common');
const { csvText } = require('../pos/csv');

const TAKE = 5000; // rows a report reads at most: a firm has hundreds of clients, not millions
const LOG_TAKE = 3000; // activity-log entries a history report reads at most
const ISSUED = ['ISSUED', 'SENT', 'PARTIAL', 'RECEIVED'];
const UNPAID = ['ISSUED', 'SENT', 'PARTIAL'];
const METHODS = { BANK: 'Bank transfer', CASH: 'Cash', CHEQUE: 'Cheque', CARD: 'Card', ONLINE: 'Online payment', OTHER: 'Other', CREDIT: 'Client credit' };
const INV_STATUS = { DRAFT: 'Draft', ISSUED: 'Issued', SENT: 'Sent', PARTIAL: 'Partially received', RECEIVED: 'Received', CANCELLED: 'Cancelled' };
// the template categories of 24 Nov 2026 (REMINDER: a template made before the three reminders were told apart), and the older ones
const PURPOSES = { REMINDER_1: '1st reminder', REMINDER_2: '2nd reminder', REMINDER_3: '3rd reminder', REMINDER: 'Reminder (category not chosen yet)', ADVANCE: 'Advance payment',
    INVOICE: 'Invoice', RECEIPT: 'Receipt', OTHER: 'Other', DATA_COLLECTION: 'Data collection', COMPLETION: 'Obligation completed' };
const MESSAGE_KINDS = { REMINDER: 'Reminder', ADVANCE: 'Advance payment', INVOICE: 'Invoice', RECEIPT: 'Receipt', OTHER: 'Other', DATA_COLLECTION: 'Data collection', COMPLETION: 'Obligation completed' };
const DOC_KINDS = { INVOICE: 'Invoice', RECEIPT: 'Receipt', ADVANCE: 'Advance payment receipt' };
const CHANNELS = { WHATSAPP: 'WhatsApp', PHONE: 'Phone call', EMAIL: 'Email', OTHER: 'Another way', ...(R.CHANNELS || {}) };
const REM_STATE = { SENT: 'Sent', HIGHLIGHTED: 'Due now (to send)', MISSED: 'Pending (its time passed, not sent)', BLEAK: 'Scheduled', CLOSED: 'Not needed (task done first)' };
const OB_STATUS = [['ALL', 'Everything'], ['OPEN', 'Open (not completed)'], ['OVERDUE', 'Overdue'], ['UPCOMING', 'Upcoming'], ['PERIOD_CLOSED', 'Period closed'], ['DATA_COLLECTED', 'Data collected'],
    ['FILED', 'Filed'], ['PAID', 'Paid'], ['COMPLETED', 'Completed'], ['CONFIRM', 'Dates to confirm']];
const INV_STATUS_OPTS = [['', 'Every status'], ...Object.entries(INV_STATUS), ['UNPAID', 'Not paid in full']];
const BY_MONTH = [['month', 'By month'], ['currency', 'One line per currency']];
// the parts of the module an activity-log action belongs to (the audit reports' Module column and filter)
const MODULES = [
    ['clients', 'Clients', ['cmp.client.']], ['obligations', 'Obligations', ['cmp.obligation.', 'cmp.occurrence.', 'cmp.reminder.', 'cmp.bulk.']],
    ['messages', 'Messages and reminders', ['cmp.message.']], ['templates', 'Message templates', ['cmp.template.']], ['fields', 'Additional information', ['cmp.field.']],
    ['advances', 'Advance payments', ['cmp.advance.']], ['invoices', 'Invoices', ['cmp.invoice.']], ['receipts', 'Receipts', ['cmp.receipt.']], ['items', 'Items', ['cmp.item.']],
    ['taxes', 'Taxes', ['cmp.tax.']], ['formats', 'Invoice and receipt formats', ['cmp.invtype.']], ['settings', 'Settings', ['cmp.settings.']], ['security', 'Security', ['cmp.security.']],
    ['notifications', 'Notifications', ['cmp.notify.', 'cmp.notification.']], ['downloads', 'Downloads', ['cmp.export.', 'cmp.log.']],
];
const ACTIONS = { create: 'Created', update: 'Changed', delete: 'Deleted', archive: 'Archived', restore: 'Restored', void: 'Undone', issue: 'Issued', sent: 'Marked sent',
    unsent: 'Marked not sent', cancel: 'Cancelled', generate: 'Next period prepared', overdue: 'Became overdue', stage: 'Step changed', data: 'Data collection',
    complete: 'Completed', reopen: 'Reopened', billing: 'Billing changed', pattern: 'Later periods\' dates changed', secrets_view: 'Password shown', manual: 'Reminder given another way',
    remember: 'Kept for later invoices', price: 'Another price kept', retire: 'Retired', next_period: 'Next periods prepared', assign: 'Assigned', export: 'Downloaded', template: 'Message template changed', signout: 'Signed out of other sessions' };
const ENTITY_LABEL = { CmpClient: 'Client', CmpObligation: 'Obligation', CmpOccurrence: 'Obligation period', CmpInvoice: 'Invoice', CmpReceipt: 'Receipt', CmpAdvance: 'Advance payment',
    CmpTemplate: 'Template', CmpFieldDef: 'Field', CmpTaxRate: 'Tax', CmpItem: 'Item', CmpInvoiceType: 'Format', CmpMessage: 'Message', CmpSettings: 'Settings', Export: 'Download' };
// (Compliance, Data Collection, Tasks and Staff: the reports of the CA's Comprehensive Dashboard SRS, section 5, 24 Nov 2026)
const CATEGORIES = [['clients', 'Clients'], ['obligations', 'Obligations'], ['compliance', 'Compliance'], ['reminders', 'Reminders'], ['data', 'Data Collection'], ['tasks', 'Tasks'],
    ['advances', 'Advance Payments'], ['created', 'Invoices Created'], ['issued', 'Invoices Issued'], ['receipts', 'Receipts'], ['receivables', 'Receivables'], ['staff', 'Staff'],
    ['items', 'Items & Taxes'], ['info', 'Additional Information'], ['templates', 'Message Templates'], ['formats', 'Invoice & Receipt Formats'], ['audit', 'Audit & Activity'], ['quality', 'Data Quality']];
const NO_PERM_DEFAULT = { REPORTS: 'see the notifications and reports', INVOICE: 'issue invoices and receipts', LOGS: 'see the message and activity logs', EXPORT: 'export data', SETUP: 'manage templates and custom fields' };
// the kinds of record whose names the history reports look up (the others are named by their kind only)
const LOOKED_UP = new Set(['CmpClient', 'CmpObligation', 'CmpOccurrence', 'CmpInvoice', 'CmpReceipt', 'CmpAdvance', 'CmpTemplate', 'CmpFieldDef', 'CmpTaxRate', 'CmpItem', 'CmpInvoiceType']);
const KIND_ORDER = ['Missing', 'Incomplete', 'Invalid', 'Duplicate', 'Configuration'];
const EMAIL_OK = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/i; // (the same rule as validate.js)

// each route and the permission(s) it asks for (test/cmpRouteGuards.test.js checks them); each report then asks for its own as well
const ROUTE_PERMS = { 'GET /api/cmp/catalog': ['REPORTS'], 'GET /api/cmp/catalog/:key': ['REPORTS'], 'GET /api/cmp/catalog/:key/export': ['EXPORT'] };

const dateOf = d => new Date(d + 'T00:00:00Z');
const ymd = v => (v ? R.ymdOf(v) : '');
const num = v => Number(v || 0);
const decimals = cur => C.currencyDecimals(cur || 'USD');
// money is added up in whole minor units of its currency (fils, cents…), so 3-decimal currencies stay exact
const toMinor = (n, cur) => Math.round(num(n) * 10 ** decimals(cur));
const toMajor = (m, cur) => m / 10 ** decimals(cur);
const plus = (cur, ...xs) => toMajor(xs.reduce((s, x) => s + toMinor(x, cur), 0), cur);
const countryName = code => (code ? (C.get(code) || { name: code }).name : '');
const cl = c => (c ? `${c.name} (${c.code})` : '');
const monthOf = d => `${R.MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const col = (key, label, type = 'text', more = {}) => ({ key, label, type, ...more });
const purposeLabel = p => (R.templateCategory ? R.templateCategory(p) : PURPOSES[p]) || PURPOSES[p] || p;
const actionLabel = a => { const p = String(a).split('.'); return p[1] === 'export' || a === 'cmp.log.export' ? 'Downloaded' : ACTIONS[p.slice(2).join('.')] || p.slice(2).join(' ').replace(/_/g, ' ') || a; };
const moduleOf = a => (MODULES.find(m => m[2].some(p => String(a).startsWith(p))) || [0, 'Other'])[1];
const scopeText = (all, list) => (all ? 'All countries' : (list || []).map(countryName).join(', ') || '(no country)');

// The totals under a table: one line per currency, adding up its money columns (unless marked noSum) and its number columns marked sum;
// a row marked _skip (a draft, a void receipt…) is shown but not counted
function totalsOf(columns, rows, noun = ['row', 'rows']) {
    const money = columns.filter(c => c.type === 'money' && !c.noSum), counts = columns.filter(c => c.type === 'number' && c.sum);
    if (!money.length && !counts.length) return [];
    const by = new Map();
    for (const r of rows) {
        if (r._skip) continue;
        const cur = money.length ? r.currency || '' : '';
        const t = by.get(cur) || { currency: cur, n: 0, m: {}, c: {} };
        t.n++;
        for (const c of money) t.m[c.key] = (t.m[c.key] || 0) + toMinor(r[c.key], cur);
        for (const c of counts) t.c[c.key] = (t.c[c.key] || 0) + num(r[c.key]);
        by.set(cur, t);
    }
    return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map(t => ({
        label: `Total${t.currency ? ' ' + t.currency : ''} · ${t.n} ${t.n === 1 ? noun[0] : noun[1]}`, ...(t.currency ? { currency: t.currency } : {}),
        ...Object.fromEntries(money.map(c => [c.key, toMajor(t.m[c.key] || 0, t.currency)])), ...Object.fromEntries(counts.map(c => [c.key, Math.round((t.c[c.key] || 0) * 1000) / 1000])),
    }));
}
// a secret is never shown in a history, even if an older entry held one
const masked = (field, v) => (/password|pin\b|pin code/i.test(String(field)) && v ? '••••' : v);

function createReportsCatalog({ prisma, audit, common, obligations, invoices, reports, now = () => new Date() } = {}) {
    let NO_PERM = NO_PERM_DEFAULT;
    const methods = (invoices && invoices.METHODS) || METHODS;

    /* ---------- filters ---------- */
    const days = f => (f.from || f.to ? { ...(f.from ? { gte: dateOf(f.from) } : {}), ...(f.to ? { lte: dateOf(f.to) } : {}) } : undefined);
    const moments = f => (f.from || f.to ? { ...(f.from ? { gte: R.zoned(f.from, 0, 0, f.tz) } : {}), ...(f.to ? { lt: R.zoned(R.addDays(f.to, 1), 0, 0, f.tz) } : {}) } : undefined);
    const inRange = (f, d) => Boolean(d) && (!f.from || d >= f.from) && (!f.to || d <= f.to);
    const dayIn = (f, t) => (t ? R.dayIn(f.tz, t) : '');
    // a money document of the firm's (an invoice, a receipt, an advance): of one client, or of the clients of one country
    const ofClient = f => ({ ...(f.clientId ? { clientId: f.clientId } : {}), ...(f.country ? { client: { country: f.country } } : {}) });
    const liveOb = f => ({ archivedAt: null, client: { archivedAt: null, ...(f.country ? { country: f.country } : {}) } });
    async function team(f) {
        if (!f.names) f.names = new Map((await prisma.user.findMany({ where: { tenantId: f.tenantId }, select: { id: true, name: true, email: true } })).map(u => [u.id, u.name || u.email]));
        return f.names;
    }
    const who = (names, id) => (id ? names.get(id) || 'someone no longer active' : '');
    const pick = (v, opts, what) => { const k = String(v ?? opts[0][0]); if (!opts.some(o => o[0] === k)) throw bad(`Unknown ${what}.`); return k; };

    async function filtersOf(ctx, def, q = {}) {
        const s = await common.settings(ctx.tenantId), tz = s.timeZone;
        const f = { tenantId: ctx.tenantId, perms: ctx.perms, tz, settings: s, today: R.dayIn(tz, now()), from: '', to: '' };
        const has = def.filters || {};
        if (has.range) {
            f.from = q.from ? V.day(q.from, 'From') : ''; f.to = q.to ? V.day(q.to, 'To') : '';
            if (f.from && f.to && f.to < f.from) throw bad('The "to" date is before the "from" date.');
        }
        if (has.country && q.country) f.country = V.country(q.country).code;
        if (has.client && q.clientId) f.clientId = String(q.clientId).slice(0, 64);
        if (has.days) { const n = Number(q.days) || 30; if (!Number.isInteger(n) || n < 1 || n > 366) throw bad('Choose a window of 1 to 366 days.'); f.days = n; }
        if (has.status) f.status = pick(q.status || undefined, has.status, 'status');
        if (has.group) f.group = pick(q.group || undefined, has.group, 'grouping');
        if (has.module && q.module) f.module = pick(q.module, MODULES, 'module');
        if (has.user && q.user) f.user = String(q.user).trim().slice(0, 100);
        return f;
    }

    /* ---------- the activity log (the history reports) ---------- */
    async function logs(f, { prefixes, actions, where = {} } = {}) {
        const w = { tenantId: f.tenantId, action: { startsWith: 'cmp.' }, ...where }, AND = [];
        if (actions) AND.push({ action: { in: actions } });
        if (prefixes) AND.push({ OR: prefixes.map(p => ({ action: { startsWith: p } })) });
        if (f.module) AND.push({ OR: MODULES.find(m => m[0] === f.module)[2].map(p => ({ action: { startsWith: p } })) });
        if (f.user) AND.push({ userEmail: ciContains(f.user) });
        const mw = moments(f);
        if (mw) w.createdAt = mw;
        if (AND.length) w.AND = AND;
        return prisma.auditLog.findMany({ where: w, orderBy: { createdAt: 'desc' }, take: LOG_TAKE });
    }
    const detailOf = (l, k) => (l.details && typeof l.details === 'object' && !Array.isArray(l.details) ? l.details[k] : undefined);
    // The names of what the entries are about (looked up together); a record deleted since is described by the entry's own summary
    async function names(f, list) {
        const ids = {}, add = (type, id) => { if (id) (ids[type] = ids[type] || new Set()).add(String(id)); };
        for (const l of list) {
            add(l.entityType, l.entityId);
            add('CmpClient', detailOf(l, 'clientId'));
            add('CmpObligation', detailOf(l, 'obligationId'));
        }
        const t = f.tenantId, get = (type, q) => (ids[type] ? q([...ids[type]]) : Promise.resolve([]));
        const [cls, obs, occs, invs, rcs, advs, tpls, defs, taxes, items, types] = await Promise.all([
            get('CmpClient', id => prisma.cmpClient.findMany({ where: { tenantId: t, id: { in: id } }, select: { id: true, name: true, code: true } })),
            get('CmpObligation', id => prisma.cmpObligation.findMany({ where: { tenantId: t, id: { in: id } }, select: { id: true, name: true, clientId: true } })),
            get('CmpOccurrence', id => prisma.cmpOccurrence.findMany({ where: { tenantId: t, id: { in: id } }, select: { id: true, periodStart: true, periodEnd: true, clientId: true, obligation: { select: { id: true, name: true } } } })),
            get('CmpInvoice', id => prisma.cmpInvoice.findMany({ where: { tenantId: t, id: { in: id } }, select: { id: true, number: true, clientId: true } })),
            get('CmpReceipt', id => prisma.cmpReceipt.findMany({ where: { tenantId: t, id: { in: id } }, select: { id: true, number: true, clientId: true } })),
            get('CmpAdvance', id => prisma.cmpAdvance.findMany({ where: { tenantId: t, id: { in: id } }, select: { id: true, number: true, description: true, clientId: true } })),
            get('CmpTemplate', id => prisma.cmpTemplate.findMany({ where: { tenantId: t, id: { in: id } }, select: { id: true, name: true, version: true } })),
            get('CmpFieldDef', id => prisma.cmpFieldDef.findMany({ where: { tenantId: t, id: { in: id } }, select: { id: true, name: true } })),
            get('CmpTaxRate', id => prisma.cmpTaxRate.findMany({ where: { tenantId: t, id: { in: id } }, select: { id: true, name: true, rate: true } })),
            get('CmpItem', id => prisma.cmpItem.findMany({ where: { tenantId: t, id: { in: id } }, select: { id: true, name: true } })),
            get('CmpInvoiceType', id => prisma.cmpInvoiceType.findMany({ where: { tenantId: t, id: { in: id } }, select: { id: true, name: true, kind: true } })),
        ]);
        const m = new Map();
        for (const x of cls) m.set('CmpClient:' + x.id, cl(x));
        for (const x of obs) m.set('CmpObligation:' + x.id, x.name);
        for (const x of occs) m.set('CmpOccurrence:' + x.id, `${x.obligation.name} · ${R.periodName(x)}`);
        for (const x of invs) m.set('CmpInvoice:' + x.id, x.number || 'Draft invoice');
        for (const x of rcs) m.set('CmpReceipt:' + x.id, x.number);
        for (const x of advs) m.set('CmpAdvance:' + x.id, x.number || x.description);
        for (const x of tpls) m.set('CmpTemplate:' + x.id, x.name);
        for (const x of defs) m.set('CmpFieldDef:' + x.id, x.name);
        for (const x of taxes) m.set('CmpTaxRate:' + x.id, `${x.name} ${Number(x.rate)}%`);
        for (const x of items) m.set('CmpItem:' + x.id, x.name);
        for (const x of types) m.set('CmpInvoiceType:' + x.id, x.name);
        const clientOf = l => {
            const id = detailOf(l, 'clientId') || (l.entityType === 'CmpClient' ? l.entityId : null);
            return id ? m.get('CmpClient:' + id) || '' : '';
        };
        const nameOf = l => (l.entityType && l.entityId ? m.get(`${l.entityType}:${l.entityId}`) : null);
        return {
            client: clientOf,
            obligation: l => { const id = detailOf(l, 'obligationId') || (l.entityType === 'CmpObligation' ? l.entityId : null); return (id && m.get('CmpObligation:' + id)) || (l.entityType === 'CmpOccurrence' ? nameOf(l) || '' : ''); },
            record: l => {
                if (l.entityType === 'CmpSettings') return 'Module settings';
                const label = ENTITY_LABEL[l.entityType] || l.entityType || '';
                if (!LOOKED_UP.has(l.entityType)) return label;
                const n = nameOf(l);
                return n ? `${label} ${n}` : `${label} (deleted)`;
            },
            template: id => m.get('CmpTemplate:' + id),
        };
    }
    // One line per field that changed (details.changes: [{ field, old, new }]); an entry written before those were kept shows its summary
    function expand(list, nm, { recordOf, keep } = {}) {
        const rows = [];
        for (const l of list) {
            const base = { at: l.createdAt, module: moduleOf(l.action), action: actionLabel(l.action), record: recordOf ? recordOf(l, nm) : nm.record(l), client: nm.client(l), user: l.userEmail };
            const ch = (detailOf(l, 'changes') || []).filter(c => c && typeof c === 'object' && (!keep || keep(c, l)));
            if (Array.isArray(detailOf(l, 'changes')) && detailOf(l, 'changes').length && !ch.length) continue; // (none of its changes is wanted here)
            if (ch.length) ch.forEach((c, i) => rows.push({ ...base, field: String(c.field || ''), old: masked(c.field, c.old ?? ''), new: masked(c.field, c.new ?? ''), details: i ? '' : l.summary, version: detailOf(l, 'version') ?? '' }));
            else rows.push({ ...base, field: '', old: '', new: '', details: l.summary, version: detailOf(l, 'version') ?? '' });
        }
        return rows;
    }
    const HISTORY_NOTE = 'From the activity log. Changes recorded since 24 Nov 2026 show each field with its old and new value; older entries show what was written at the time.';
    const historyCols = (recordLabel = 'Record', extra = []) => [col('at', 'When', 'at'), col('record', recordLabel), col('action', 'Action'), col('field', 'Field'), col('old', 'Old value'), col('new', 'New value'),
        ...extra, col('details', 'Details', 'text', { wide: true }), col('user', 'User')];
    const history = (prefixes, { recordLabel, recordOf, actions, keep, extra } = {}) => async f => {
        const list = await logs(f, { prefixes, actions });
        const nm = await names(f, list);
        return { columns: historyCols(recordLabel, extra), rows: expand(list, nm, { recordOf, keep }) };
    };

    /* ---------- reminders: each reminder of each period with its state (the way the notifications work it out) ---------- */
    async function reminderItems(f) {
        const where = { tenantId: f.tenantId, obligation: { ...liveOb(f), reminders: { some: {} } }, ...(f.clientId ? { clientId: f.clientId } : {}) };
        // (a reminder is at most a year from its due date)
        if (f.from || f.to) where.dueDate = { ...(f.from ? { gte: dateOf(R.addDays(f.from, -370)) } : {}), ...(f.to ? { lte: dateOf(R.addDays(f.to, 370)) } : {}) };
        const occs = await prisma.cmpOccurrence.findMany({ where, take: TAKE, orderBy: { dueDate: 'asc' }, include: { obligation: { include: { client: true, reminders: { include: { template: { select: { id: true, name: true, active: true } } } } } } } });
        const ids = occs.map(o => o.id), at = now();
        const [sent, msgs] = await Promise.all([
            obligations.sentMap(ids),
            ids.length ? prisma.cmpMessage.findMany({ where: { tenantId: f.tenantId, occurrenceId: { in: ids }, reminderId: { not: null } }, orderBy: { createdAt: 'asc' }, select: { occurrenceId: true, reminderId: true, channel: true, templateName: true, createdAt: true, voidedAt: true } }) : [],
        ]);
        const byRem = new Map();
        for (const m of msgs) { const k = `${m.occurrenceId}:${m.reminderId}`; if (!byRem.has(k)) byRem.set(k, []); byRem.get(k).push(m); }
        const out = [], work = R.workOf ? R.workOf(f.settings) : null; // (a reminder on a weekend or holiday moves, as the firm chose)
        for (const o of occs) {
            const c = o.obligation.client;
            R.reminderStates(o, obligations.reminderList(o.obligation.reminders), { tz: c.timeZone, hour: f.settings.reminderHour, now: at, sent: sent.get(o.id) || new Map(), work }).forEach((r, i) => {
                const day = R.dayIn(c.timeZone, r.fireAt);
                if ((f.from || f.to) && !inRange(f, day)) return;
                const ms = byRem.get(`${o.id}:${r.id}`) || [], live = ms.filter(m => !m.voidedAt);
                out.push({ occ: o, client: c, r, n: i + 1, day, live, voided: ms.filter(m => m.voidedAt), last: live[live.length - 1] || null });
            });
        }
        return out;
    }
    // each reminder in exactly one of these
    const bucket = x => (x.r.state === 'SENT' ? (x.last && x.last.channel !== 'WHATSAPP' ? 'other' : 'whatsapp') : x.voided.length ? 'failed'
        : ['HIGHLIGHTED', 'MISSED'].includes(x.r.state) ? 'pending' : x.r.state === 'BLEAK' ? 'scheduled' : 'notNeeded');
    const REMINDER_NOTE = 'A WhatsApp link cannot report delivery: "Sent on WhatsApp" is a reminder handed to WhatsApp, "Given another way" one marked as given by phone, email or another way, "Failed" one whose message was marked "not sent" (and not sent again), "Pending" one whose time has come and that is not sent yet.';

    /* ---------- invoices and their lines ---------- */
    const owed = i => (['DRAFT', 'CANCELLED'].includes(i.status) ? 0 : plus(i.currency, i.total) - plus(i.currency, i.advanceAdjusted) - plus(i.currency, i.received));
    const owedOf = i => toMajor(toMinor(i.total, i.currency) - toMinor(i.advanceAdjusted, i.currency) - toMinor(i.received, i.currency), i.currency);
    // the amount the taxes are worked out on: the subtotal less the discount plus the additional charges
    const taxableOf = i => toMajor(toMinor(i.subtotal, i.currency) - toMinor(i.discount, i.currency) + toMinor(i.charges, i.currency), i.currency);
    const CLIENT_SEL = { select: { id: true, code: true, name: true, country: true, registrationNo: true, archivedAt: true } };
    async function issuedInvoices(f, { lines = false, taxes = false, receipts = false, where = {} } = {}) {
        const dw = days(f);
        return prisma.cmpInvoice.findMany({ where: { tenantId: f.tenantId, status: { in: ISSUED }, ...ofClient(f), ...(dw ? { issueDate: dw } : {}), ...where }, take: TAKE, orderBy: [{ issueDate: 'asc' }, { seqNo: 'asc' }],
            include: { client: CLIENT_SEL, ...(lines ? { lines: { orderBy: { sortOrder: 'asc' } } } : {}), ...(taxes ? { taxes: { orderBy: { sortOrder: 'asc' } } } : {}),
                ...(receipts ? { receipts: { where: { voidedAt: null, settlement: '' }, orderBy: { receivedOn: 'asc' } } } : {}) } });
    }
    const itemName = l => String(l.bankName || l.description || '').trim();
    // each line of the issued invoices with its share of the invoice's taxes (in proportion to the line's amount)
    function linesWithTax(invs) {
        const out = [];
        for (const i of invs) {
            const sub = toMinor(i.subtotal, i.currency), tax = toMinor(i.taxTotal, i.currency);
            for (const l of i.lines) {
                const amt = toMinor(l.amount, i.currency), share = sub ? Math.round(amt * tax / sub) : 0;
                out.push({ inv: i, name: itemName(l), key: R.keyOf(itemName(l)), currency: i.currency, amount: toMajor(amt, i.currency), tax: toMajor(share, i.currency) });
            }
        }
        return out;
    }
    const invRecord = i => ({ invoice: i.number || '(draft)', client: cl(i.client), country: countryName(i.client && i.client.country), currency: i.currency });

    /* ---------- data quality: every check, each giving the records it found ---------- */
    async function quality(f) {
        const t = f.tenantId, money = f.perms.has('INVOICE'), setup = money || f.perms.has('SETUP');
        const cw = { tenantId: t, archivedAt: null, ...(f.country ? { country: f.country } : {}) };
        const [cls, defs, values, obs, toConfirm, settingsRow, types, tpls, obTpls] = await Promise.all([
            prisma.cmpClient.findMany({ where: cw, orderBy: [{ name: 'asc' }, { code: 'asc' }], take: TAKE }),
            prisma.cmpFieldDef.findMany({ where: { tenantId: t }, orderBy: { name: 'asc' } }),
            prisma.cmpFieldValue.findMany({ where: { tenantId: t }, select: { clientId: true, fieldId: true }, take: TAKE * 20 }),
            prisma.cmpObligation.findMany({ where: { tenantId: t, ...liveOb(f) }, take: TAKE, include: { client: { select: { id: true, code: true, name: true, country: true } }, reminders: { include: { template: { select: { name: true, active: true } } } } } }),
            prisma.cmpOccurrence.findMany({ where: { tenantId: t, datesConfirmed: false, stage: { not: 'COMPLETED' }, obligation: liveOb(f) }, take: TAKE, orderBy: { dueDate: 'asc' }, include: { obligation: { select: { id: true, name: true, client: { select: { id: true, code: true, name: true, country: true } } } } } }),
            prisma.cmpSettings.findUnique({ where: { tenantId: t } }),
            prisma.cmpInvoiceType.findMany({ where: { tenantId: t, active: true } }),
            prisma.cmpTemplate.findMany({ where: { tenantId: t } }),
            prisma.cmpObligationTemplate.findMany({ where: { tenantId: t, obligation: liveOb(f) }, include: { template: { select: { name: true, active: true } }, obligation: { select: { id: true, name: true, client: { select: { id: true, code: true, name: true, country: true } } } } } }),
        ]);
        const out = [], push = x => out.push({ value: '', detail: '', country: '', ...x });
        const have = new Set(values.map(v => `${v.clientId}:${v.fieldId}`));
        const applies = (d, c) => d.active && (d.allCountries || d.countries.includes(c.country));
        const cRec = c => ({ area: 'Clients', record: cl(c), code: c.code, client: c.name, country: countryName(c.country), link: { client: c.id } });
        // clients: missing, incomplete and invalid details
        for (const c of cls) {
            const r = cRec(c);
            if (!c.contactNumber) push({ ...r, kind: 'Missing', check: 'Contact number' });
            if (!c.email) push({ ...r, kind: 'Missing', check: 'Email' });
            if (!c.registrationNo) push({ ...r, kind: 'Missing', check: 'Registration No.' });
            if (!c.noPortal && (!c.portalUsername || !c.portalPasswordEnc)) push({ ...r, kind: 'Missing', check: 'Portal login', detail: !c.portalUsername ? 'No username' : 'No password' });
            const miss = defs.filter(d => applies(d, c) && !have.has(`${c.id}:${d.id}`)).map(d => d.name);
            if (miss.length) push({ ...r, kind: 'Incomplete', check: 'Additional information', detail: miss.join(', ') });
            if (c.contactNumber && !R.waPhone(c.contactNumber, (C.get(c.country) || {}).dial)) push({ ...r, kind: 'Invalid', check: 'Contact number', detail: `"${c.contactNumber}" is not a phone number WhatsApp can use`, value: c.contactNumber });
            if (c.email && !EMAIL_OK.test(c.email)) push({ ...r, kind: 'Invalid', check: 'Email', detail: `"${c.email}" is not a valid email address`, value: c.email });
        }
        // duplicates: the same name, registration no. or contact number (each record of a group is listed, with the others it matches)
        const dupes = (list, keyOf, check, recOf, area) => {
            const g = new Map();
            for (const x of list) { const k = keyOf(x); if (k) { if (!g.has(k)) g.set(k, []); g.get(k).push(x); } }
            for (const [, xs] of g) if (xs.length > 1) for (const x of xs) push({ ...recOf(x), area, kind: 'Duplicate', check, value: x._v, detail: `Same as ${xs.filter(y => y !== x).map(y => recOf(y).record).join(', ')}` });
        };
        const withV = (list, f2) => list.map(x => Object.assign(x, { _v: f2(x) }));
        dupes(withV(cls, c => c.name), c => R.keyOf(c.name), 'Same name', cRec, 'Clients');
        dupes(withV(cls.map(c => ({ ...c })), c => c.registrationNo), c => String(c.registrationNo || '').trim().toLowerCase().replace(/\s+/g, ''), 'Same registration no.', cRec, 'Clients');
        dupes(withV(cls.map(c => ({ ...c })), c => c.contactNumber), c => (c.contactNumber ? R.waPhone(c.contactNumber, (C.get(c.country) || {}).dial) || c.contactNumber.replace(/\D/g, '') : ''), 'Same contact number', cRec, 'Clients');
        const oRec = o => ({ record: `${o.name} · ${cl(o.client)}`, client: o.client.name, code: o.client.code, country: countryName(o.client.country), link: { client: o.client.id } });
        dupes(withV(obs, o => o.name), o => `${o.clientId}:${R.keyOf(o.name)}`, 'Same obligation twice for a client', oRec, 'Obligations');
        for (const o of toConfirm) push({ area: 'Obligations', kind: 'Incomplete', check: 'Dates to confirm', record: `${o.obligation.name} · ${R.periodName(o)} · ${cl(o.obligation.client)}`, client: o.obligation.client.name, code: o.obligation.client.code,
            country: countryName(o.obligation.client.country), detail: `Copied from the period before (due ${R.fmtDay(o.dueDate)}): to check and confirm`, link: { period: [o.obligation.id, o.id] } });
        // invoices, receipts and advances twice (money: only for those who may see it)
        if (money) {
            const [invs, rcs, advs] = await Promise.all([
                prisma.cmpInvoice.findMany({ where: { tenantId: t, status: { in: ISSUED }, ...ofClient(f) }, take: TAKE, include: { client: CLIENT_SEL } }),
                prisma.cmpReceipt.findMany({ where: { tenantId: t, voidedAt: null, settlement: '', ...(f.clientId ? { clientId: f.clientId } : {}), ...(f.country ? { invoice: { client: { country: f.country } } } : {}) }, take: TAKE, include: { invoice: { select: { number: true, currency: true, client: CLIENT_SEL } } } }),
                prisma.cmpAdvance.findMany({ where: { tenantId: t, voidedAt: null, ...ofClient(f) }, take: TAKE, include: { client: CLIENT_SEL } }),
            ]);
            const iRec = i => ({ record: `Invoice ${i.number} · ${cl(i.client)}`, client: i.client.name, code: i.client.code, country: countryName(i.client.country), link: { invoice: i.id } });
            dupes(withV(invs, i => `${i.currency} ${num(i.total)} on ${R.fmtDay(i.issueDate)}`), i => `${i.clientId}|${i.currency}|${toMinor(i.total, i.currency)}|${ymd(i.issueDate)}`, 'Same client, total and date', iRec, 'Invoices');
            const rRec = r => ({ record: `Receipt ${r.number} · ${cl(r.invoice.client)}`, client: r.invoice.client.name, code: r.invoice.client.code, country: countryName(r.invoice.client.country), link: { invoice: r.invoiceId } });
            dupes(withV(rcs, r => `${r.invoice.currency} ${num(r.amount)} on ${R.fmtDay(r.receivedOn)}`), r => `${r.invoiceId}|${toMinor(r.amount, r.invoice.currency)}|${ymd(r.receivedOn)}`, 'Same invoice, amount and date', rRec, 'Receipts');
            const aRec = a => ({ record: `Advance ${a.number || a.description} · ${cl(a.client)}`, client: a.client.name, code: a.client.code, country: countryName(a.client.country), link: { client: a.clientId } });
            dupes(withV(advs, a => `${a.currency} ${num(a.amount)} on ${R.fmtDay(a.receivedOn)}`), a => `${a.clientId}|${a.currency}|${toMinor(a.amount, a.currency)}|${ymd(a.receivedOn)}`, 'Same client, amount and date', aRec, 'Advance payments');
        }
        // configuration: what is set up wrongly, or not yet
        const cfg = (area, check, record, detail, link) => push({ area, kind: 'Configuration', check, record, detail, link });
        const countries = [...new Set(cls.map(c => c.country))].sort();
        for (const [kind, label] of Object.entries(DOC_KINDS)) {
            for (const cc of countries) if (!types.some(x => (x.kind || 'INVOICE') === kind && x.country === cc && x.isDefault)) cfg('Formats', `No default ${label.toLowerCase()} format`, countryName(cc), `The ${label.toLowerCase()}s of its ${cls.filter(c => c.country === cc).length} client(s) are printed with the standard layout`);
        }
        for (const tpl of tpls.filter(x => x.active && x.purpose === 'REMINDER')) cfg('Templates', 'Template category not chosen', tpl.name, 'Choose 1st, 2nd or 3rd reminder for it');
        for (const o of obs) {
            if (!o.reminders.length) cfg('Obligations', 'Obligation with no reminders', `${o.name} · ${cl(o.client)}`, 'Nothing reminds the client of it', { client: o.client.id });
            for (const r of o.reminders) if (r.template && !r.template.active) cfg('Obligations', 'Reminder uses a retired template', `${o.name} · ${cl(o.client)}`, `${R.offsetLabel(r.offsetDays)}: "${r.template.name}"`, { client: o.client.id });
        }
        for (const x of obTpls) if (x.template && !x.template.active) cfg('Obligations', 'Message uses a retired template', `${x.obligation.name} · ${cl(x.obligation.client)}`, `${MESSAGE_KINDS[x.kind] || x.kind} message: "${x.template.name}"`, { client: x.obligation.client.id });
        for (const d of defs.filter(x => x.active && !x.allCountries && !x.countries.length)) cfg('Additional information', 'Field for no country', d.name, 'It shows for no client');
        const s = settingsRow || {};
        if (!s.firmName) cfg('Settings', 'Firm name not set', 'Settings', 'It is printed on invoices and receipts');
        if (!Array.isArray(s.waSenders) || !s.waSenders.length) cfg('Settings', 'No WhatsApp number of the firm', 'Settings', 'Messages go from whichever WhatsApp is open');
        for (const [k, label] of [['invoiceFormat', 'Invoice'], ['receiptFormat', 'Receipt'], ['advanceFormat', 'Advance payment receipt']]) {
            if (s[k] && !/\{N+\}/.test(s[k])) cfg('Settings', `${label} number has no running number`, s[k], 'Add {NNNN} so that every number is different');
        }
        if (setup) {
            const [taxes, items] = await Promise.all([prisma.cmpTaxRate.findMany({ where: { tenantId: t } }), prisma.cmpItem.findMany({ where: { tenantId: t } })]);
            for (const cc of countries) if (!taxes.some(x => x.active && (x.allCountries || x.countries.includes(cc)))) cfg('Taxes', 'No tax set up for a country', countryName(cc), 'No tax is suggested on its invoices (fine if the country has no tax on fees)');
            for (const x of taxes.filter(y => y.active && !y.allCountries && !y.countries.length)) cfg('Taxes', 'Tax for no country', `${x.name} ${Number(x.rate)}%`, 'It is suggested on no invoice');
            for (const x of items.filter(y => y.active && !y.allCountries && !y.countries.length)) cfg('Items', 'Item for no country', x.name, 'It is suggested on no invoice');
            for (const x of items.filter(y => y.active && num(y.amount) === 0)) cfg('Items', 'Item with no price', `${x.name} (${x.currency})`, 'Its suggested price is zero');
            if (money) {
                // a retired item or tax still on a draft: it would be issued with it
                const drafts = await prisma.cmpInvoice.findMany({ where: { tenantId: t, status: 'DRAFT', ...ofClient(f) }, take: TAKE, include: { client: CLIENT_SEL, lines: true, taxes: true } });
                const retiredItems = new Map(items.filter(x => !x.active).map(x => [`${x.key}|${x.currency}`, x])), retiredTaxes = taxes.filter(x => !x.active);
                for (const d of drafts) {
                    for (const l of d.lines) { const it = retiredItems.get(`${R.keyOf(itemName(l))}|${d.currency}`); if (it) cfg('Items', 'Retired item still on a draft invoice', `Draft for ${cl(d.client)}`, `"${it.name}" is no longer suggested`, { invoice: d.id }); }
                    for (const x of d.taxes) { const tx = retiredTaxes.find(y => y.name.toLowerCase() === x.name.toLowerCase() && num(y.rate) === num(x.rate)); if (tx) cfg('Taxes', 'Retired tax still on a draft invoice', `Draft for ${cl(d.client)}`, `${tx.name} ${Number(tx.rate)}% is no longer suggested`, { invoice: d.id }); }
                }
            }
        }
        return out;
    }
    const issueCols = [col('code', 'Code', 'text', { csvOnly: true }), col('record', 'Record'), col('country', 'Country')];
    const issueRows = list => list.map(x => ({ area: x.area, kind: x.kind, check: x.check, record: x.record, code: x.code || '', client: x.client || '', country: x.country, detail: x.detail, value: x.value, _link: x.link }));

    /* ---------- the reports ---------- */
    const REP = ['REPORTS'], INV = ['INVOICE'], LOG = ['LOGS'], ITEMS = ['INVOICE', 'SETUP'];
    const occCols = daysLabel => [col('dueDate', 'Due date', 'day'), col('client', 'Client'), col('country', 'Country'), col('obligation', 'Obligation'), col('period', 'Period'), col('status', 'Status'),
        col('days', daysLabel, 'number'), col('assignedTo', 'Assigned to')];
    const occRow = (r, nm, d = r.view.daysLeft) => ({ dueDate: r.dueDate, client: cl(r.client), country: countryName(r.client.country), obligation: r.obligation.name, period: R.periodName(r),
        status: R.STATUS[r.view.status] || r.view.status, days: r.view.status === 'COMPLETED' ? null : d, assignedTo: who(nm, r.assignedToId), _link: { period: [r.obligation.id, r.id] } });
    const occQ = f => ({ ...(f.country ? { country: f.country } : {}), ...(f.clientId ? { clientId: f.clientId } : {}) });
    // the periods not completed (with their reminders' states), as the tracker works them out; and those completed in the dates chosen
    const openRows = async f => (await obligations.listOccurrences({ tenantId: f.tenantId, perms: f.perms }, { money: '0', status: 'OPEN', limit: 20000, ...occQ(f) })).rows;
    const taskOpen = r => ['DATA_COLLECTED', 'FILED', 'PAID'].includes(r.stage);
    const completedIn = f => prisma.cmpOccurrence.findMany({ where: { tenantId: f.tenantId, stage: 'COMPLETED', obligation: liveOb(f), ...(f.clientId ? { clientId: f.clientId } : {}), ...(f.from || f.to ? { OR: [{ completedOn: days(f) }, { completedOn: null, closedAt: moments(f) }] } : {}) },
        take: TAKE * 4, select: { id: true, obligation: { select: { assignedToId: true, client: { select: { assignedToId: true } } } } } });
    async function staffTasks(f) {
        const nm = await team(f), [open, done] = await Promise.all([openRows(f), completedIn(f)]);
        const by = new Map(), get = k => { if (!by.has(k)) by.set(k, { person: k ? who(nm, k) : 'Nobody', pending: 0, today: 0, overdue: 0, completed: 0 }); return by.get(k); };
        for (const r of open.filter(taskOpen)) { const x = get(r.assignedToId || ''); x.pending++; if (r.view.daysLeft === 0) x.today++; if (r.view.overdue) x.overdue++; }
        for (const o of done) get(o.obligation.assignedToId || o.obligation.client.assignedToId || '').completed++;
        const rows = [...by.values()].sort((a, b) => b.pending - a.pending || a.person.localeCompare(b.person));
        const columns = [col('person', 'Person'), col('pending', 'Tasks pending', 'number', { sum: true }), col('today', 'Due today', 'number', { sum: true }), col('overdue', 'Overdue', 'number', { sum: true }), col('completed', f.from || f.to ? 'Completed in the dates' : 'Completed (all time)', 'number', { sum: true })];
        return { columns, rows, totals: totalsOf(columns, rows, ['person', 'people']), note: 'A task is an obligation\'s work: open once its data is collected, until it is marked done.' };
    }

    const DEFS = [
        /* ----- Clients ----- */
        { key: 'client-register', cat: 'clients', title: 'Client Register', info: 'Client name, code, registration no., contact, email, country, status', need: [REP], filters: { country: 1 },
            note: 'Every client, archived ones included (status Inactive).',
            run: async f => {
                const nm = await team(f);
                const list = await prisma.cmpClient.findMany({ where: { tenantId: f.tenantId, ...(f.country ? { country: f.country } : {}) }, orderBy: [{ name: 'asc' }, { code: 'asc' }], take: TAKE });
                return { columns: [col('code', 'Code'), col('name', 'Client'), col('registrationNo', 'Registration No.'), col('contactNumber', 'Contact number'), col('email', 'Email'), col('country', 'Country'),
                    col('status', 'Status'), col('assignedTo', 'Assigned to'), col('createdOn', 'Added on', 'day')],
                rows: list.map(c => ({ code: c.code, name: c.name, registrationNo: c.registrationNo, contactNumber: c.contactNumber, email: c.email, country: countryName(c.country), status: c.archivedAt ? 'Inactive (archived)' : 'Active',
                    assignedTo: who(nm, c.assignedToId), createdOn: dayIn(f, c.createdAt), _link: { client: c.id } })) };
            } },
        { key: 'clients-active', cat: 'clients', title: 'Active Clients', info: 'Active clients and their basic details', need: [REP], filters: { country: 1 },
            run: async f => {
                const nm = await team(f), at = now();
                const list = await prisma.cmpClient.findMany({ where: { tenantId: f.tenantId, archivedAt: null, ...(f.country ? { country: f.country } : {}) }, orderBy: [{ name: 'asc' }, { code: 'asc' }], take: TAKE });
                const open = list.length ? await prisma.cmpOccurrence.findMany({ where: { tenantId: f.tenantId, clientId: { in: list.map(c => c.id) }, stage: { not: 'COMPLETED' }, obligation: { archivedAt: null } }, select: { clientId: true, dueAt: true } }) : [];
                const n = new Map();
                for (const o of open) { const x = n.get(o.clientId) || { open: 0, overdue: 0 }; x.open++; if (o.dueAt <= at) x.overdue++; n.set(o.clientId, x); }
                const columns = [col('code', 'Code'), col('name', 'Client'), col('country', 'Country'), col('contactNumber', 'Contact number'), col('email', 'Email'), col('registrationNo', 'Registration No.'),
                    col('assignedTo', 'Assigned to'), col('open', 'Open obligations', 'number', { sum: true }), col('overdue', 'Overdue', 'number', { sum: true })];
                const rows = list.map(c => ({ code: c.code, name: c.name, country: countryName(c.country), contactNumber: c.contactNumber, email: c.email, registrationNo: c.registrationNo, assignedTo: who(nm, c.assignedToId),
                    open: (n.get(c.id) || {}).open || 0, overdue: (n.get(c.id) || {}).overdue || 0, _link: { client: c.id } }));
                return { columns, rows, totals: totalsOf(columns, rows, ['client', 'clients']) };
            } },
        { key: 'clients-inactive', cat: 'clients', title: 'Inactive Clients', info: 'Inactive clients, status and date', need: [REP], filters: { country: 1 },
            note: 'Inactive = archived: out of the lists, dashboards and reminders, and can be restored.',
            run: async f => {
                const list = await prisma.cmpClient.findMany({ where: { tenantId: f.tenantId, archivedAt: { not: null }, ...(f.country ? { country: f.country } : {}) }, orderBy: { archivedAt: 'desc' }, take: TAKE });
                return { columns: [col('code', 'Code'), col('name', 'Client'), col('country', 'Country'), col('status', 'Status'), col('archivedAt', 'Inactive since', 'at'), col('archivedBy', 'By')],
                    rows: list.map(c => ({ code: c.code, name: c.name, country: countryName(c.country), status: 'Inactive (archived)', archivedAt: c.archivedAt, archivedBy: c.archivedBy || '', _link: { client: c.id } })) };
            } },
        { key: 'clients-new', cat: 'clients', title: 'New Clients', info: 'Newly added clients and creation date', need: [REP], filters: { range: 'date added', country: 1 },
            run: async f => {
                const mw = moments(f);
                const list = await prisma.cmpClient.findMany({ where: { tenantId: f.tenantId, ...(mw ? { createdAt: mw } : {}), ...(f.country ? { country: f.country } : {}) }, orderBy: { createdAt: 'desc' }, take: TAKE });
                return { columns: [col('createdAt', 'Added', 'at'), col('code', 'Code'), col('name', 'Client'), col('country', 'Country'), col('createdBy', 'Added by'), col('status', 'Status')],
                    rows: list.map(c => ({ createdAt: c.createdAt, code: c.code, name: c.name, country: countryName(c.country), createdBy: c.createdBy, status: c.archivedAt ? 'Inactive (archived)' : 'Active', _link: { client: c.id } })) };
            } },
        { key: 'client-activity', cat: 'clients', title: 'Client Activity', info: 'Client, activity, module, date and user', need: [REP, LOG], filters: { range: 'date', client: 1 },
            note: 'Everything the activity log noted about a client: its details, obligations, messages, invoices and payments.',
            run: async f => {
                const where = f.clientId ? { OR: [{ entityType: 'CmpClient', entityId: f.clientId }, { details: { path: ['clientId'], equals: f.clientId } }] } : {};
                const list = (await logs(f, { where })).filter(l => l.entityType === 'CmpClient' || detailOf(l, 'clientId'));
                const nm = await names(f, list);
                return { columns: [col('at', 'When', 'at'), col('client', 'Client'), col('module', 'Module'), col('action', 'Activity'), col('details', 'Details', 'text', { wide: true }), col('user', 'User')],
                    rows: list.map(l => ({ at: l.createdAt, client: nm.client(l), module: moduleOf(l.action), action: actionLabel(l.action), details: l.summary, user: l.userEmail, _link: (detailOf(l, 'clientId') || l.entityId) ? { client: detailOf(l, 'clientId') || l.entityId } : undefined })) };
            } },
        { key: 'client-history', cat: 'clients', title: 'Client History', info: 'Client changes, old value, new value, date and user', need: [REP, LOG], filters: { range: 'date', client: 1 }, note: HISTORY_NOTE,
            run: async f => {
                const list = await logs(f, { prefixes: ['cmp.client.'], where: f.clientId ? { entityId: f.clientId } : {} });
                const nm = await names(f, list.filter(l => l.action !== 'cmp.client.secrets_view'));
                return { columns: historyCols('Client'), rows: expand(list.filter(l => l.action !== 'cmp.client.secrets_view'), nm, { recordOf: l => nm.client(l) || nm.record(l) }) };
            } },
        { key: 'client-quality', cat: 'clients', title: 'Client Data Quality', info: 'Missing, duplicate or incomplete client information', need: [REP], filters: { country: 1 },
            note: 'Active clients only. A phone number is invalid when WhatsApp could not use it; the additional information is the fields set up for the client\'s country.',
            run: async f => {
                const list = (await quality(f)).filter(x => x.area === 'Clients').sort((a, b) => a.record.localeCompare(b.record) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
                return { columns: [col('code', 'Code'), col('client', 'Client'), col('country', 'Country'), col('kind', 'Problem'), col('check', 'Information'), col('detail', 'Details', 'text', { wide: true })], rows: issueRows(list) };
            } },

        /* ----- Obligations ----- */
        { key: 'obligation-register', cat: 'obligations', title: 'Obligation Register', info: 'Client, obligation, period, due date and status', need: [REP], filters: { range: 'due date', country: 1, client: 1, status: OB_STATUS },
            note: 'Periods still to come are shown as Planned (made when their turn comes).',
            run: async f => {
                const nm = await team(f);
                const d = await reports.report({ tenantId: f.tenantId, perms: f.perms }, 'obligations', { from: f.from, to: f.to, status: f.status, projected: '1', ...occQ(f) });
                return { columns: [...occCols('Days left'), col('dataCollectedOn', 'Data collected', 'day'), col('completedOn', 'Completed', 'day')],
                    rows: d.rows.map(r => ({ ...occRow(r, nm), dataCollectedOn: r.dataCollectedOn || '', completedOn: r.completedOn || '' })),
                    cards: Object.entries(d.counts || {}).map(([k, n]) => ({ label: R.STATUS[k] || k, value: n })) };
            } },
        { key: 'obligations-upcoming', cat: 'obligations', title: 'Upcoming Obligations', info: 'Upcoming deadlines, client, obligation and days remaining', need: [REP], filters: { days: 1, country: 1, client: 1 },
            run: async f => {
                const nm = await team(f);
                const d = await reports.report({ tenantId: f.tenantId, perms: f.perms }, 'upcoming', { days: f.days, ...occQ(f) });
                return { columns: occCols('Days remaining'), rows: d.rows.map(r => occRow(r, nm)) };
            } },
        { key: 'obligations-overdue', cat: 'obligations', title: 'Overdue Obligations', info: 'Overdue deadlines, client, obligation and days overdue', need: [REP], filters: { country: 1, client: 1 },
            note: 'Overdue = not completed by the end of its due date, on the client\'s own calendar.',
            run: async f => {
                const nm = await team(f);
                const d = await reports.report({ tenantId: f.tenantId, perms: f.perms }, 'overdue', occQ(f));
                return { columns: occCols('Days overdue'), rows: d.rows.map(r => occRow(r, nm, -r.view.daysLeft)) };
            } },
        { key: 'obligations-completed', cat: 'obligations', title: 'Completed Obligations', info: 'Completed obligations, due date and completion date', need: [REP], filters: { range: 'completion date', country: 1, client: 1 },
            run: async f => {
                const where = { tenantId: f.tenantId, stage: 'COMPLETED', obligation: liveOb(f), ...(f.clientId ? { clientId: f.clientId } : {}) };
                if (f.from || f.to) where.OR = [{ completedOn: days(f) }, { completedOn: null, closedAt: moments(f) }];
                const list = await prisma.cmpOccurrence.findMany({ where, take: TAKE, orderBy: [{ completedOn: 'desc' }, { closedAt: 'desc' }], include: { obligation: { select: { id: true, name: true, client: { select: { id: true, code: true, name: true, country: true } } } } } });
                let onTime = 0, late = 0;
                const rows = list.map(o => {
                    const done = o.completedOn ? ymd(o.completedOn) : dayIn(f, o.closedAt), lateBy = done ? R.daysBetween(ymd(o.dueDate), done) : 0;
                    if (lateBy > 0) late++; else onTime++;
                    return { client: cl(o.obligation.client), country: countryName(o.obligation.client.country), obligation: o.obligation.name, period: R.periodName(o), dueDate: ymd(o.dueDate), dataCollectedOn: ymd(o.dataCollectedOn), completedOn: done,
                        timing: lateBy > 0 ? `${lateBy} day${lateBy === 1 ? '' : 's'} late` : 'On time', billing: o.closeKind === 'FREE' ? 'Closed without an invoice' : o.closeKind === 'INVOICE' ? 'With an invoice' : 'Invoice to follow', closedBy: o.closedBy || '',
                        _link: { period: [o.obligation.id, o.id] } };
                });
                return { columns: [col('client', 'Client'), col('country', 'Country'), col('obligation', 'Obligation'), col('period', 'Period'), col('dueDate', 'Due date', 'day'), col('dataCollectedOn', 'Data collected', 'day'),
                    col('completedOn', 'Completed', 'day'), col('timing', 'On time?'), col('billing', 'Billing'), col('closedBy', 'Marked by')], rows, cards: [{ label: 'On time', value: onTime }, { label: 'Late', value: late }] };
            } },
        { key: 'obligation-calendar', cat: 'obligations', title: 'Obligation Calendar', info: 'Client obligations by date and status', need: [REP], filters: { range: 'due date', country: 1, client: 1 },
            note: 'Every due date in the dates chosen, month by month; periods still to come show as Planned.',
            run: async f => {
                const d = await reports.report({ tenantId: f.tenantId, perms: f.perms }, 'obligations', { from: f.from, to: f.to, status: 'ALL', projected: '1', ...occQ(f) });
                return { columns: [col('month', 'Month'), col('dueDate', 'Due date', 'day'), col('weekday', 'Day'), col('client', 'Client'), col('obligation', 'Obligation'), col('period', 'Period'), col('status', 'Status')],
                    rows: d.rows.map(r => ({ month: monthOf(r.dueDate), dueDate: r.dueDate, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(r.dueDate + 'T00:00:00Z').getUTCDay()], client: cl(r.client), obligation: r.obligation.name,
                        period: R.periodName(r), status: R.STATUS[r.view.status] || r.view.status, _link: { period: [r.obligation.id, r.id] } })) };
            } },
        { key: 'obligation-performance', cat: 'obligations', title: 'Obligation Performance', info: 'Total, completed, pending and overdue obligations', need: [REP], filters: { range: 'due date', country: 1, group: [['client', 'By client'], ['obligation', 'By obligation']] },
            note: 'The periods due in the dates chosen. Pending = not completed and not yet overdue.',
            run: async f => {
                const columns = [col('name', f.group === 'obligation' ? 'Obligation' : 'Client'), ...(f.group === 'obligation' ? [col('clients', 'Clients', 'number')] : [col('country', 'Country')]), col('total', 'Total', 'number', { sum: true }), col('completed', 'Completed', 'number', { sum: true }),
                    col('pending', 'Pending', 'number', { sum: true }), col('overdue', 'Overdue', 'number', { sum: true }), col('rate', 'Completed (%)', 'number')];
                let rows;
                if (f.group === 'obligation') {
                    const at = now(), dw = days(f);
                    const occs = await prisma.cmpOccurrence.findMany({ where: { tenantId: f.tenantId, obligation: liveOb(f), ...(dw ? { dueDate: dw } : {}) }, take: TAKE * 4, select: { clientId: true, stage: true, dueAt: true, obligation: { select: { name: true } } } });
                    const g = new Map();
                    for (const o of occs) {
                        const k = R.keyOf(o.obligation.name), x = g.get(k) || { name: o.obligation.name, clients: new Set(), total: 0, completed: 0, pending: 0, overdue: 0 };
                        x.clients.add(o.clientId); x.total++;
                        if (o.stage === 'COMPLETED') x.completed++; else if (o.dueAt <= at) x.overdue++; else x.pending++;
                        g.set(k, x);
                    }
                    rows = [...g.values()].sort((a, b) => a.name.localeCompare(b.name)).map(x => ({ ...x, clients: x.clients.size, rate: pct(x.completed, x.total) }));
                } else {
                    const d = await reports.report({ tenantId: f.tenantId, perms: new Set() }, 'clients', { from: f.from, to: f.to, ...(f.country ? { country: f.country } : {}) });
                    rows = d.rows.filter(r => r.periods).map(r => ({ name: cl(r.client), country: countryName(r.client.country), total: r.periods, completed: r.completed, pending: r.open - r.overdue, overdue: r.overdue, rate: pct(r.completed, r.periods), _link: { client: r.client.id } }));
                }
                const totals = totalsOf(columns, rows, f.group === 'obligation' ? ['obligation', 'obligations'] : ['client', 'clients']);
                for (const t of totals) t.rate = pct(t.completed, t.total);
                return { columns, rows, totals };
            } },
        { key: 'obligation-history', cat: 'obligations', title: 'Obligation History', info: 'Obligation changes, old value, new value, date and user', need: [REP, LOG], filters: { range: 'date', client: 1 }, note: HISTORY_NOTE,
            run: async f => {
                const list = await logs(f, { prefixes: ['cmp.obligation.', 'cmp.occurrence.', 'cmp.reminder.'], where: f.clientId ? { details: { path: ['clientId'], equals: f.clientId } } : {} });
                const nm = await names(f, list);
                return { columns: historyCols('Obligation', [col('client', 'Client')]), rows: expand(list, nm, { recordOf: l => nm.obligation(l) || nm.record(l) }) };
            } },

        /* ----- Reminders ----- */
        { key: 'reminder-register', cat: 'reminders', title: 'Reminder Register', info: 'Client, obligation, reminder date, channel, template and status', need: [REP], filters: { range: 'reminder date', country: 1, client: 1 }, note: REMINDER_NOTE,
            run: async f => {
                const list = await reminderItems(f);
                list.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || a.client.name.localeCompare(b.client.name));
                return { columns: [col('day', 'Reminder date', 'day'), col('client', 'Client'), col('obligation', 'Obligation'), col('period', 'Period'), col('dueDate', 'Due date', 'day'), col('reminder', 'Reminder'),
                    col('channel', 'Channel'), col('template', 'Template'), col('status', 'Status')],
                rows: list.map(x => ({ day: x.day, client: cl(x.client), obligation: x.occ.obligation.name, period: R.periodName(x.occ), dueDate: ymd(x.occ.dueDate), reminder: `${R.ordinal(x.n)} · ${R.offsetLabel(x.r.offsetDays).toLowerCase()}`,
                    channel: x.last ? CHANNELS[x.last.channel] || x.last.channel : '', template: (x.last && x.last.templateName) || x.r.templateName || '',
                    status: `${REM_STATE[x.r.state] || x.r.state}${x.live.length > 1 ? ` (${x.live.length} times)` : ''}${x.r.state !== 'SENT' && x.voided.length ? ' · marked not sent' : ''}`, _link: { period: [x.occ.obligation.id, x.occ.id] } })) };
            } },
        { key: 'reminder-history', cat: 'reminders', title: 'Reminder History', info: 'Reminder sent, date/time, channel, template and delivery status', need: [REP, LOG], filters: { range: 'date sent', country: 1, client: 1 }, note: REMINDER_NOTE,
            run: async f => {
                const mw = moments(f);
                const list = await prisma.cmpMessage.findMany({ where: { tenantId: f.tenantId, kind: 'REMINDER', ...(mw ? { createdAt: mw } : {}), ...ofClient(f) }, orderBy: { createdAt: 'desc' }, take: TAKE,
                    include: { client: { select: { id: true, code: true, name: true } }, occurrence: { select: { periodStart: true, periodEnd: true, obligation: { select: { name: true } } } }, reminder: { select: { offsetDays: true } } } });
                return { columns: [col('at', 'Sent', 'at'), col('client', 'Client'), col('obligation', 'Obligation'), col('period', 'Period'), col('reminder', 'Reminder'), col('channel', 'Channel'), col('template', 'Template'),
                    col('status', 'Delivery status'), col('voidedAt', 'Marked not sent', 'at'), col('user', 'Sent by')],
                rows: list.map(m => ({ at: m.createdAt, client: cl(m.client), obligation: m.occurrence ? m.occurrence.obligation.name : '', period: m.occurrence ? R.periodName(m.occurrence) : '', reminder: m.reminder ? R.offsetLabel(m.reminder.offsetDays) : '',
                    channel: CHANNELS[m.channel] || m.channel, template: m.templateName, user: m.userEmail,
                    status: m.voidedAt ? `Failed (marked not sent${m.voidedBy ? ` by ${m.voidedBy}` : ''})` : m.channel === 'WHATSAPP' ? 'Handed to WhatsApp' : `Given by ${String(CHANNELS[m.channel] || m.channel).toLowerCase()} (marked by hand)`, voidedAt: m.voidedAt || null,
                    _link: { client: m.clientId } })) };
            } },
        { key: 'reminder-performance', cat: 'reminders', title: 'Reminder Performance', info: 'Total reminders, sent, delivered, failed and pending', need: [REP], filters: { range: 'reminder date', country: 1, client: 1 }, note: REMINDER_NOTE,
            run: async f => {
                const g = new Map();
                for (const x of await reminderItems(f)) {
                    const k = x.day.slice(0, 7), t = g.get(k) || { month: monthOf(x.day), total: 0, whatsapp: 0, other: 0, failed: 0, pending: 0, scheduled: 0, notNeeded: 0 };
                    t.total++; t[bucket(x)]++; g.set(k, t);
                }
                const columns = [col('month', 'Month'), col('total', 'Total reminders', 'number', { sum: true }), col('whatsapp', 'Sent on WhatsApp', 'number', { sum: true }), col('other', 'Given another way', 'number', { sum: true }),
                    col('failed', 'Failed (marked not sent)', 'number', { sum: true }), col('pending', 'Pending', 'number', { sum: true }), col('scheduled', 'Scheduled', 'number', { sum: true }), col('notNeeded', 'Not needed (task done first)', 'number', { sum: true })];
                const rows = [...g.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, t]) => t);
                return { columns, rows, totals: totalsOf(columns, rows, ['month', 'months']) };
            } },
        { key: 'reminder-template-usage', cat: 'reminders', title: 'Template Usage', info: 'Template, number of uses, last used date and channel', need: [REP], filters: { range: 'date sent', country: 1, client: 1 },
            note: 'Reminders only (the Message Templates category has every kind of message). A reminder marked "not sent" is not counted as a use.',
            run: async f => templateUsage(f, { kind: 'REMINDER' }) },

        /* ----- Advance payments ----- */
        { key: 'advance-register', cat: 'advances', title: 'Advance Payment Register', info: 'Receipt no., client, date, amount, payment method and status', need: [REP, INV], filters: { range: 'date received', country: 1, client: 1 },
            note: 'Void advances are listed but not counted.',
            run: async f => {
                const dw = days(f);
                const list = await prisma.cmpAdvance.findMany({ where: { tenantId: f.tenantId, ...ofClient(f), ...(dw ? { receivedOn: dw } : {}) }, orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }], take: TAKE, include: { client: CLIENT_SEL } });
                const columns = [col('number', 'Receipt no.'), col('receivedOn', 'Date', 'day'), col('client', 'Client'), col('description', 'Description'), col('amount', 'Amount', 'money'), col('method', 'Payment method'), col('reference', 'Reference'),
                    col('used', 'Adjusted', 'money'), col('status', 'Status'), col('sentAt', 'Sent to the client', 'at')];
                const rows = list.map(a => ({ number: a.number || '', receivedOn: ymd(a.receivedOn), client: cl(a.client), description: a.description, currency: a.currency, amount: num(a.amount), method: methods[a.method] || a.method || '', reference: a.reference || '',
                    used: num(a.used), sentAt: a.sentAt || null, status: a.voidedAt ? `Void: ${a.voidReason}` : num(a.used) <= 0 ? 'Not adjusted yet' : toMinor(a.used, a.currency) >= toMinor(a.amount, a.currency) ? 'Fully adjusted' : 'Partly adjusted',
                    _skip: Boolean(a.voidedAt), _link: { client: a.clientId } }));
                return { columns, rows, totals: totalsOf(columns, rows, ['advance', 'advances']) };
            } },
        { key: 'advance-balance', cat: 'advances', title: 'Advance Payment Balance', info: 'Client, advance received, adjusted amount and remaining balance', need: [REP, INV], filters: { country: 1, client: 1 },
            note: 'Every advance to date (undone ones left out). Adjusted = taken off issued invoices.',
            run: async f => {
                const list = await prisma.cmpAdvance.findMany({ where: { tenantId: f.tenantId, voidedAt: null, ...ofClient(f) }, take: TAKE, include: { client: CLIENT_SEL } });
                const g = new Map();
                for (const a of list) {
                    const k = `${a.clientId}|${a.currency}`, x = g.get(k) || { client: cl(a.client), country: countryName(a.client.country), currency: a.currency, count: 0, m: 0, u: 0, _link: { client: a.clientId } };
                    x.count++; x.m += toMinor(a.amount, a.currency); x.u += toMinor(a.used, a.currency); g.set(k, x);
                }
                const columns = [col('client', 'Client'), col('country', 'Country'), col('count', 'Advances', 'number', { sum: true }), col('received', 'Advance received', 'money'), col('adjusted', 'Adjusted', 'money'), col('remaining', 'Remaining balance', 'money')];
                const rows = [...g.values()].sort((a, b) => a.client.localeCompare(b.client) || a.currency.localeCompare(b.currency))
                    .map(x => ({ client: x.client, country: x.country, currency: x.currency, count: x.count, received: toMajor(x.m, x.currency), adjusted: toMajor(x.u, x.currency), remaining: toMajor(x.m - x.u, x.currency), _link: x._link }));
                return { columns, rows, totals: totalsOf(columns, rows, ['client', 'clients']) };
            } },
        { key: 'advance-allocation', cat: 'advances', title: 'Advance Payment Allocation', info: 'Advance, invoice/reference, allocated amount and balance', need: [REP, INV], filters: { range: 'date received', country: 1, client: 1 },
            note: 'An advance is allocated when the invoice it is taken off is issued (a draft only plans it). Balance = what is left of the advance now.',
            run: async f => {
                const dw = days(f);
                const advs = await prisma.cmpAdvance.findMany({ where: { tenantId: f.tenantId, voidedAt: null, ...ofClient(f), ...(dw ? { receivedOn: dw } : {}) }, orderBy: { receivedOn: 'asc' }, take: TAKE, include: { client: CLIENT_SEL } });
                const ids = new Set(advs.map(a => a.id));
                const invs = advs.length ? await prisma.cmpInvoice.findMany({ where: { tenantId: f.tenantId, status: { in: ISSUED }, advanceAdjusted: { gt: 0 }, clientId: { in: [...new Set(advs.map(a => a.clientId))] } }, select: { id: true, number: true, issueDate: true, advanceUse: true } }) : [];
                const uses = new Map();
                for (const i of invs) for (const u of Array.isArray(i.advanceUse) ? i.advanceUse : []) if (u && ids.has(u.advanceId)) { if (!uses.has(u.advanceId)) uses.set(u.advanceId, []); uses.get(u.advanceId).push({ inv: i, amount: num(u.amount) }); }
                const rows = [];
                for (const a of advs) {
                    const base = { advance: a.number || a.description, receivedOn: ymd(a.receivedOn), client: cl(a.client), currency: a.currency, advanceAmount: num(a.amount), balance: plus(a.currency, a.amount) - plus(a.currency, a.used) };
                    const us = uses.get(a.id) || [];
                    if (!us.length) rows.push({ ...base, invoice: '— (not adjusted yet)', invoiceDate: '', allocated: 0, _link: { client: a.clientId } });
                    for (const u of us) rows.push({ ...base, invoice: u.inv.number, invoiceDate: ymd(u.inv.issueDate), allocated: u.amount, _link: { invoice: u.inv.id } });
                }
                const columns = [col('advance', 'Advance'), col('receivedOn', 'Received', 'day'), col('client', 'Client'), col('advanceAmount', 'Advance amount', 'money', { noSum: true }), col('invoice', 'Invoice'), col('invoiceDate', 'Invoice date', 'day'),
                    col('allocated', 'Allocated', 'money'), col('balance', 'Balance', 'money', { noSum: true })];
                return { columns, rows, totals: totalsOf(columns, rows) };
            } },
        { key: 'advance-unallocated', cat: 'advances', title: 'Unallocated Advances', info: 'Client, advance date, amount and unallocated balance', need: [REP, INV], filters: { country: 1, client: 1 },
            note: 'Advances with money not yet taken off an issued invoice, as of today.',
            run: async f => {
                const list = await prisma.cmpAdvance.findMany({ where: { tenantId: f.tenantId, voidedAt: null, ...ofClient(f) }, orderBy: { receivedOn: 'asc' }, take: TAKE, include: { client: CLIENT_SEL } });
                const columns = [col('client', 'Client'), col('advance', 'Advance'), col('receivedOn', 'Advance date', 'day'), col('description', 'Description'), col('amount', 'Amount', 'money'), col('used', 'Adjusted', 'money'), col('balance', 'Unallocated balance', 'money'), col('age', 'Days since received', 'number')];
                const rows = list.filter(a => toMinor(a.amount, a.currency) > toMinor(a.used, a.currency)).map(a => ({ client: cl(a.client), advance: a.number || '', receivedOn: ymd(a.receivedOn), description: a.description, currency: a.currency,
                    amount: num(a.amount), used: num(a.used), balance: plus(a.currency, a.amount) - plus(a.currency, a.used), age: Math.max(0, R.daysBetween(ymd(a.receivedOn), f.today)), _link: { client: a.clientId } }));
                return { columns, rows, totals: totalsOf(columns, rows, ['advance', 'advances']) };
            } },
        { key: 'advance-history', cat: 'advances', title: 'Advance Payment History', info: 'Changes, old value, new value, date and user', need: [REP, INV, LOG], filters: { range: 'date' }, note: HISTORY_NOTE,
            run: history(['cmp.advance.'], { recordLabel: 'Advance', extra: [col('client', 'Client')] }) },

        /* ----- Invoices created ----- */
        { key: 'invoice-register', cat: 'created', title: 'Invoice Register', info: 'Invoice no., client, date, amount, tax, total and status', need: [REP, INV], filters: { range: 'invoice date', country: 1, client: 1, status: INV_STATUS_OPTS },
            note: 'Drafts (no date yet) show whatever the dates; drafts and cancelled invoices are listed but not counted in the totals.',
            run: async f => {
                const d = await reports.report({ tenantId: f.tenantId, perms: f.perms }, 'invoices', { from: f.from, to: f.to, ...(f.clientId ? { clientId: f.clientId } : {}), ...(f.status ? { status: f.status } : {}) });
                const list = d.rows.filter(i => !f.country || i.client.country === f.country);
                // (the discount and charges, when the list does not carry them)
                const extra = new Map(list.length && list[0].discount === undefined ? (await prisma.cmpInvoice.findMany({ where: { tenantId: f.tenantId, id: { in: list.map(i => i.id) } }, select: { id: true, discount: true, charges: true } })).map(x => [x.id, x]) : []);
                const columns = [col('invoice', 'Invoice no.'), col('issueDate', 'Date', 'day'), col('client', 'Client'), col('for', 'For'), col('amount', 'Amount', 'money'), col('discount', 'Discount', 'money'), col('charges', 'Charges', 'money'),
                    col('tax', 'Tax', 'money'), col('total', 'Total', 'money'), col('received', 'Received', 'money'), col('outstanding', 'Outstanding', 'money'), col('status', 'Status')];
                const rows = list.map(i => ({ ...invRecord(i), issueDate: i.issueDate, for: i.obligation ? `${i.obligation.name} ${R.periodName(i.obligation)}` : '', amount: i.subtotal, discount: num(i.discount ?? (extra.get(i.id) || {}).discount),
                    charges: num(i.charges ?? (extra.get(i.id) || {}).charges), tax: i.taxTotal, total: i.total, received: i.received, outstanding: ['DRAFT', 'CANCELLED'].includes(i.status) ? null : i.outstanding, status: INV_STATUS[i.status] || i.status,
                    _skip: ['DRAFT', 'CANCELLED'].includes(i.status), _link: { invoice: i.id } }));
                return { columns, rows, totals: totalsOf(columns, rows, ['invoice', 'invoices']) };
            } },
        { key: 'invoices-draft', cat: 'created', title: 'Draft Invoices', info: 'Draft invoices, client, date, amount and status', need: [REP, INV], filters: { country: 1, client: 1 },
            note: 'A draft has no number and no date yet: the date is when it was made.',
            run: async f => {
                const list = await prisma.cmpInvoice.findMany({ where: { tenantId: f.tenantId, status: 'DRAFT', ...ofClient(f) }, orderBy: { createdAt: 'desc' }, take: TAKE, include: { client: CLIENT_SEL, occurrence: { select: { periodStart: true, periodEnd: true, obligation: { select: { name: true } } } } } });
                const columns = [col('createdAt', 'Made', 'at'), col('client', 'Client'), col('for', 'For'), col('amount', 'Amount', 'money'), col('tax', 'Tax', 'money'), col('total', 'Total', 'money'), col('status', 'Status'), col('createdBy', 'Made by')];
                const rows = list.map(i => ({ createdAt: i.createdAt, client: cl(i.client), country: countryName(i.client.country), currency: i.currency, for: i.occurrence ? `${i.occurrence.obligation.name} ${R.periodName(i.occurrence)}` : '', amount: num(i.subtotal), tax: num(i.taxTotal), total: num(i.total),
                    status: 'Draft', createdBy: i.createdBy, _link: { invoice: i.id } }));
                return { columns, rows, totals: totalsOf(columns, rows, ['draft', 'drafts']) };
            } },
        { key: 'invoice-status', cat: 'created', title: 'Invoice Status', info: 'Invoice, client, amount, status and relevant date', need: [REP, INV], filters: { range: 'invoice date', country: 1, client: 1, status: INV_STATUS_OPTS },
            note: 'The relevant date: made (draft), issued, sent, last payment, or cancelled.',
            run: async f => {
                const dw = days(f), st = f.status === 'UNPAID' ? { in: UNPAID } : f.status || undefined;
                const list = await prisma.cmpInvoice.findMany({ where: { tenantId: f.tenantId, ...ofClient(f), ...(st ? { status: st } : {}), ...(dw ? { OR: [{ issueDate: dw }, { status: 'DRAFT' }] } : {}) }, orderBy: [{ createdAt: 'desc' }], take: TAKE,
                    include: { client: CLIENT_SEL, receipts: { where: { voidedAt: null }, orderBy: { receivedOn: 'desc' }, take: 1, select: { receivedOn: true } } } });
                const counts = {};
                const rows = list.map(i => {
                    counts[i.status] = (counts[i.status] || 0) + 1;
                    const last = i.receipts[0] ? ymd(i.receipts[0].receivedOn) : '';
                    const [what, when] = { DRAFT: ['Made', dayIn(f, i.createdAt)], ISSUED: ['Issued', ymd(i.issueDate)], SENT: ['Sent', dayIn(f, i.sentAt) || ymd(i.issueDate)], PARTIAL: ['Last payment', last], RECEIVED: ['Paid in full', last || ymd(i.issueDate)], CANCELLED: ['Cancelled', dayIn(f, i.cancelledAt)] }[i.status] || ['', ''];
                    return { ...invRecord(i), total: num(i.total), outstanding: ['DRAFT', 'CANCELLED'].includes(i.status) ? null : owedOf(i), status: INV_STATUS[i.status] || i.status, dateOf: what, date: when, _skip: ['DRAFT', 'CANCELLED'].includes(i.status), _link: { invoice: i.id } };
                });
                const columns = [col('invoice', 'Invoice no.'), col('client', 'Client'), col('total', 'Amount', 'money'), col('outstanding', 'Outstanding', 'money'), col('status', 'Status'), col('dateOf', 'Date of'), col('date', 'Relevant date', 'day')];
                return { columns, rows, totals: totalsOf(columns, rows, ['invoice', 'invoices']), cards: Object.keys(INV_STATUS).filter(k => counts[k]).map(k => ({ label: INV_STATUS[k], value: counts[k] })) };
            } },
        { key: 'invoice-history-created', cat: 'created', title: 'Invoice History', info: 'Invoice changes, old value, new value, date and user', need: [REP, INV, LOG], filters: { range: 'date' },
            note: `${HISTORY_NOTE} Here: drafts made, changed, deleted and issued (what happens after issuing is under Invoices Issued).`,
            run: async f => {
                const list = (await logs(f, { prefixes: ['cmp.invoice.', 'cmp.tax.remember', 'cmp.item.remember'] })).filter(l => !['cmp.invoice.sent', 'cmp.invoice.unsent', 'cmp.invoice.cancel'].includes(l.action));
                const nm = await names(f, list);
                return { columns: historyCols('Invoice', [col('client', 'Client')]), rows: expand(list, nm) };
            } },
        { key: 'invoices-cancelled', cat: 'created', title: 'Cancelled Invoices', info: 'Invoice, client, amount, cancellation date and reason', need: [REP, INV], filters: { range: 'cancellation date', country: 1, client: 1 },
            run: async f => {
                const mw = moments(f);
                const list = await prisma.cmpInvoice.findMany({ where: { tenantId: f.tenantId, status: 'CANCELLED', ...ofClient(f), ...(mw ? { cancelledAt: mw } : {}) }, orderBy: { cancelledAt: 'desc' }, take: TAKE, include: { client: CLIENT_SEL } });
                const columns = [col('invoice', 'Invoice no.'), col('issueDate', 'Invoice date', 'day'), col('client', 'Client'), col('total', 'Amount', 'money'), col('cancelledAt', 'Cancelled', 'at'), col('cancelledBy', 'By'), col('reason', 'Reason', 'text', { wide: true }), col('settlement', 'Money received')];
                const rows = list.map(i => ({ ...invRecord(i), issueDate: ymd(i.issueDate), total: num(i.total), cancelledAt: i.cancelledAt, cancelledBy: i.cancelledBy || '', reason: i.cancelReason,
                    settlement: { REFUND: 'Refunded', CREDIT: 'Kept as the client\'s credit', VOID: 'Receipts voided' }[i.cancelSettlement] || '', _link: { invoice: i.id } }));
                return { columns, rows, totals: totalsOf(columns, rows, ['invoice', 'invoices']) };
            } },

        /* ----- Invoices issued ----- */
        { key: 'issued-register', cat: 'issued', title: 'Issued Invoice Register', info: 'Invoice no., issue date, client, amount, tax and total', need: [REP, INV], filters: { range: 'issue date', country: 1, client: 1 },
            note: 'Issued = given a number and not cancelled; "Sent" says when it went to the client.',
            run: async f => {
                const list = await issuedInvoices(f);
                const columns = [col('invoice', 'Invoice no.'), col('issueDate', 'Issue date', 'day'), col('client', 'Client'), col('registrationNo', 'Client registration no.'), col('amount', 'Amount', 'money'), col('discount', 'Discount', 'money'),
                    col('charges', 'Charges', 'money'), col('tax', 'Tax', 'money'), col('total', 'Total', 'money'), col('sentOn', 'Sent', 'day'), col('status', 'Status')];
                const rows = list.map(i => ({ ...invRecord(i), issueDate: ymd(i.issueDate), registrationNo: i.client.registrationNo, amount: num(i.subtotal), discount: num(i.discount), charges: num(i.charges), tax: num(i.taxTotal), total: num(i.total),
                    sentOn: dayIn(f, i.sentAt), status: INV_STATUS[i.status] || i.status, _link: { invoice: i.id } }));
                return { columns, rows, totals: totalsOf(columns, rows, ['invoice', 'invoices']) };
            } },
        { key: 'invoice-summary', cat: 'issued', title: 'Invoice Summary', info: 'Invoice count, taxable amount, tax and total', need: [REP, INV], filters: { range: 'issue date', country: 1, client: 1, group: BY_MONTH },
            note: 'Issued invoices (not cancelled). Taxable amount = amount less discount plus charges.',
            run: async f => {
                const g = new Map();
                for (const i of await issuedInvoices(f)) {
                    const d = ymd(i.issueDate), k = `${f.group === 'month' ? d.slice(0, 7) : ''}|${i.currency}`;
                    const x = g.get(k) || { sort: k, period: f.group === 'month' ? monthOf(d) : i.currency, currency: i.currency, count: 0, m: { taxable: 0, tax: 0, total: 0, advance: 0, received: 0, outstanding: 0 } };
                    x.count++;
                    x.m.taxable += toMinor(taxableOf(i), i.currency); x.m.tax += toMinor(i.taxTotal, i.currency); x.m.total += toMinor(i.total, i.currency);
                    x.m.advance += toMinor(i.advanceAdjusted, i.currency); x.m.received += toMinor(i.received, i.currency); x.m.outstanding += toMinor(owedOf(i), i.currency);
                    g.set(k, x);
                }
                const columns = [col('period', f.group === 'month' ? 'Month' : 'Currency'), col('count', 'Invoices', 'number', { sum: true }), col('taxable', 'Taxable amount', 'money'), col('tax', 'Tax', 'money'), col('total', 'Total', 'money'),
                    col('advance', 'Advance adjusted', 'money'), col('received', 'Received', 'money'), col('outstanding', 'Outstanding', 'money')];
                const rows = [...g.values()].sort((a, b) => a.sort.localeCompare(b.sort)).map(x => ({ period: x.period, currency: x.currency, count: x.count, ...Object.fromEntries(Object.entries(x.m).map(([k, v]) => [k, toMajor(v, x.currency)])) }));
                return { columns, rows, totals: totalsOf(columns, rows, f.group === 'month' ? ['month', 'months'] : ['currency', 'currencies']) };
            } },
        { key: 'invoices-by-customer', cat: 'issued', title: 'Customer-wise Invoices', info: 'Client, invoice count, amount, tax and total', need: [REP, INV], filters: { range: 'issue date', country: 1 },
            run: async f => {
                const g = new Map();
                for (const i of await issuedInvoices(f)) {
                    const k = `${i.clientId}|${i.currency}`, x = g.get(k) || { client: cl(i.client), country: countryName(i.client.country), currency: i.currency, count: 0, a: 0, t: 0, s: 0, _link: { client: i.clientId } };
                    x.count++; x.a += toMinor(taxableOf(i), i.currency); x.t += toMinor(i.taxTotal, i.currency); x.s += toMinor(i.total, i.currency); g.set(k, x);
                }
                const columns = [col('client', 'Client'), col('country', 'Country'), col('count', 'Invoices', 'number', { sum: true }), col('amount', 'Taxable amount', 'money'), col('tax', 'Tax', 'money'), col('total', 'Total', 'money')];
                const rows = [...g.values()].sort((a, b) => a.client.localeCompare(b.client)).map(x => ({ client: x.client, country: x.country, currency: x.currency, count: x.count, amount: toMajor(x.a, x.currency), tax: toMajor(x.t, x.currency), total: toMajor(x.s, x.currency), _link: x._link }));
                return { columns, rows, totals: totalsOf(columns, rows, ['client', 'clients']) };
            } },
        { key: 'invoices-by-item', cat: 'issued', title: 'Item-wise Invoices', info: 'Item, quantity, amount, tax and total', need: [REP, INV], filters: { range: 'issue date', country: 1, client: 1 },
            note: 'Quantity = the number of invoice lines that billed the item (a line has no quantity of its own). Each line carries its share of the invoice\'s tax, in proportion to its amount.',
            run: async f => {
                const g = new Map();
                for (const l of linesWithTax(await issuedInvoices(f, { lines: true }))) {
                    const k = `${l.key}|${l.currency}`, x = g.get(k) || { item: l.name, currency: l.currency, quantity: 0, invs: new Set(), a: 0, t: 0 };
                    x.quantity++; x.invs.add(l.inv.id); x.a += toMinor(l.amount, l.currency); x.t += toMinor(l.tax, l.currency); g.set(k, x);
                }
                const columns = [col('item', 'Item'), col('quantity', 'Quantity', 'number', { sum: true }), col('invoices', 'Invoices', 'number'), col('amount', 'Amount', 'money'), col('tax', 'Tax', 'money'), col('total', 'Total', 'money')];
                const rows = [...g.values()].sort((a, b) => a.item.localeCompare(b.item)).map(x => ({ item: x.item, currency: x.currency, quantity: x.quantity, invoices: x.invs.size, amount: toMajor(x.a, x.currency), tax: toMajor(x.t, x.currency), total: toMajor(x.a + x.t, x.currency) }));
                return { columns, rows, totals: totalsOf(columns, rows, ['item', 'items']) };
            } },
        { key: 'invoices-by-tax', cat: 'issued', title: 'Tax-wise Invoices', info: 'Tax type/rate, taxable amount and tax', need: [REP, INV], filters: { range: 'issue date', country: 1, client: 1 },
            note: 'Each tax with the taxable amount of the invoices it was charged on (an invoice with two taxes counts in both, so the taxable amounts are not added up).',
            run: async f => taxTable(f, { withType: false }) },
        { key: 'invoice-sequence', cat: 'issued', title: 'Invoice Sequence', info: 'Invoice numbers, missing numbers and duplicate numbers', need: [REP, INV], filters: { range: 'issue date' },
            note: 'By the running number every invoice gets when it is issued (never reset). Missing = a running number between the first and last shown with no invoice; a cancelled invoice keeps its number.',
            run: async f => {
                const dw = days(f);
                const list = await prisma.cmpInvoice.findMany({ where: { tenantId: f.tenantId, seqNo: { not: null }, ...(dw ? { issueDate: dw } : {}) }, orderBy: [{ seqNo: 'asc' }, { createdAt: 'asc' }], take: TAKE, include: { client: CLIENT_SEL } });
                const bySeq = new Map(), byNo = new Map();
                for (const i of list) { bySeq.set(i.seqNo, (bySeq.get(i.seqNo) || 0) + 1); byNo.set(i.number, (byNo.get(i.number) || 0) + 1); }
                const rows = list.map(i => ({ seqNo: i.seqNo, invoice: i.number, issueDate: ymd(i.issueDate), client: cl(i.client), status: INV_STATUS[i.status] || i.status,
                    check: bySeq.get(i.seqNo) > 1 || byNo.get(i.number) > 1 ? 'Duplicate number' : i.status === 'CANCELLED' ? 'OK (cancelled, keeps its number)' : 'OK', _link: { invoice: i.id } }));
                let missing = 0;
                if (list.length) {
                    const lo = list[0].seqNo, hi = list[list.length - 1].seqNo;
                    for (let s = lo; s <= hi && missing < TAKE; s++) if (!bySeq.has(s)) { rows.push({ seqNo: s, invoice: '', issueDate: '', client: '', status: '', check: 'Missing' }); missing++; }
                }
                rows.sort((a, b) => a.seqNo - b.seqNo);
                return { columns: [col('seqNo', 'Running no.', 'number'), col('invoice', 'Invoice no.'), col('issueDate', 'Issue date', 'day'), col('client', 'Client'), col('status', 'Status'), col('check', 'Check')], rows,
                    cards: [{ label: 'Invoices', value: list.length }, { label: 'Missing numbers', value: missing }, { label: 'Duplicate numbers', value: rows.filter(r => r.check === 'Duplicate number').length }] };
            } },
        { key: 'invoices-amended', cat: 'issued', title: 'Amended Invoices', info: 'Original invoice, revised invoice, date and difference', need: [REP, INV], filters: { range: 'amendment date', country: 1, client: 1 },
            note: 'An invoice is amended by cancelling it and making a new one: the original is a cancelled invoice and the revised one the next invoice of the same client for the same obligation period. Difference = revised total − original total.',
            run: async f => {
                const mw = moments(f);
                const cancelled = await prisma.cmpInvoice.findMany({ where: { tenantId: f.tenantId, status: 'CANCELLED', ...ofClient(f), ...(mw ? { cancelledAt: mw } : {}) }, orderBy: { cancelledAt: 'desc' }, take: TAKE, include: { client: CLIENT_SEL, lines: { select: { occurrenceId: true } } } });
                const occOf = i => new Set([i.occurrenceId, ...i.lines.map(l => l.occurrenceId)].filter(Boolean));
                const all = [...new Set(cancelled.flatMap(i => [...occOf(i)]))];
                const later = all.length ? await prisma.cmpInvoice.findMany({ where: { tenantId: f.tenantId, status: { not: 'CANCELLED' }, OR: [{ occurrenceId: { in: all } }, { lines: { some: { occurrenceId: { in: all } } } }] }, orderBy: { createdAt: 'asc' }, include: { lines: { select: { occurrenceId: true } } } }) : [];
                const rows = [];
                for (const c of cancelled) {
                    const occ = occOf(c), n = later.find(x => x.clientId === c.clientId && x.createdAt > c.createdAt && [...occOf(x)].some(id => occ.has(id)));
                    if (!n) continue;
                    rows.push({ client: cl(c.client), original: c.number, originalDate: ymd(c.issueDate), currency: c.currency, originalTotal: num(c.total), amendedOn: c.cancelledAt, reason: c.cancelReason, revised: n.number || '(draft)', revisedDate: ymd(n.issueDate),
                        revisedCurrency: n.currency, revisedTotal: num(n.total), difference: n.currency === c.currency ? plus(c.currency, n.total) - plus(c.currency, c.total) : null, _link: { invoice: n.id } });
                }
                const columns = [col('client', 'Client'), col('original', 'Original invoice'), col('originalDate', 'Original date', 'day'), col('originalTotal', 'Original total', 'money', { noSum: true }), col('amendedOn', 'Amended (cancelled)', 'at'),
                    col('reason', 'Reason', 'text', { wide: true }), col('revised', 'Revised invoice'), col('revisedDate', 'Revised date', 'day'), col('revisedTotal', 'Revised total', 'money', { noSum: true, cur: 'revisedCurrency' }), col('difference', 'Difference', 'money')];
                return { columns, rows, totals: totalsOf(columns, rows, ['amendment', 'amendments']) };
            } },
        { key: 'invoice-history-issued', cat: 'issued', title: 'Invoice History', info: 'Changes, old value, new value, date and user', need: [REP, INV, LOG], filters: { range: 'date' },
            note: `${HISTORY_NOTE} Here: invoices issued, sent (or marked not sent) and cancelled.`,
            run: async f => {
                const list = (await logs(f, { prefixes: ['cmp.invoice.'] })).filter(l => !['cmp.invoice.create', 'cmp.invoice.update', 'cmp.invoice.delete'].includes(l.action));
                const nm = await names(f, list);
                return { columns: historyCols('Invoice', [col('client', 'Client')]), rows: expand(list, nm) };
            } },

        /* ----- Receipts ----- */
        { key: 'receipt-register', cat: 'receipts', title: 'Receipt Register', info: 'Receipt no., client, date, amount, payment method and status', need: [REP, INV], filters: { range: 'date received', country: 1, client: 1 },
            note: 'Void receipts, and money refunded or kept as credit when its invoice was cancelled, are listed but not counted (credit is counted when it pays an invoice).',
            run: async f => {
                const d = await reports.report({ tenantId: f.tenantId, perms: f.perms }, 'receipts', { from: f.from, to: f.to, ...(f.clientId ? { clientId: f.clientId } : {}) });
                const columns = [col('number', 'Receipt no.'), col('receivedOn', 'Date', 'day'), col('client', 'Client'), col('invoice', 'Invoice'), col('amount', 'Amount', 'money'), col('method', 'Payment method'), col('reference', 'Reference'), col('status', 'Status'), col('createdBy', 'Recorded by')];
                const rows = d.rows.filter(r => !f.country || r.client.country === f.country).sort((a, b) => (a.receivedOn < b.receivedOn ? -1 : a.receivedOn > b.receivedOn ? 1 : 0) || String(a.number).localeCompare(String(b.number))).map(r => ({
                    number: r.number, receivedOn: r.receivedOn, client: cl(r.client), country: countryName(r.client.country), invoice: r.invoice.number, currency: r.currency, amount: r.amount, method: methods[r.method] || r.method, reference: r.reference,
                    status: r.voidedAt ? `Void: ${r.voidReason}` : r.settlement === 'REFUNDED' ? 'Refunded (invoice cancelled)' : r.settlement === 'CREDITED' ? 'Kept as credit (invoice cancelled)' : 'Valid', createdBy: r.createdBy,
                    _skip: Boolean(r.voidedAt || r.settlement), _link: { invoice: r.invoice.id } }));
                return { columns, rows, totals: totalsOf(columns, rows, ['receipt', 'receipts']) };
            } },
        { key: 'receipts-by-customer', cat: 'receipts', title: 'Customer Receipts', info: 'Client, receipt count and total received', need: [REP, INV], filters: { range: 'date received', country: 1 },
            run: async f => {
                const g = new Map();
                for (const r of await liveReceipts(f)) {
                    const cur = r.invoice.currency, k = `${r.clientId}|${cur}`, x = g.get(k) || { client: cl(r.invoice.client), country: countryName(r.invoice.client.country), currency: cur, count: 0, m: 0, _link: { client: r.clientId } };
                    x.count++; x.m += toMinor(r.amount, cur); g.set(k, x);
                }
                const columns = [col('client', 'Client'), col('country', 'Country'), col('count', 'Receipts', 'number', { sum: true }), col('received', 'Total received', 'money')];
                const rows = [...g.values()].sort((a, b) => a.client.localeCompare(b.client)).map(x => ({ client: x.client, country: x.country, currency: x.currency, count: x.count, received: toMajor(x.m, x.currency), _link: x._link }));
                return { columns, rows, totals: totalsOf(columns, rows, ['client', 'clients']) };
            } },
        { key: 'receipts-by-invoice', cat: 'receipts', title: 'Invoice-wise Receipts', info: 'Invoice, amount, receipts, paid amount and balance', need: [REP, INV], filters: { range: 'invoice date', country: 1, client: 1 },
            note: 'Issued invoices. An advance taken off an invoice counts as paid.',
            run: async f => {
                const list = await issuedInvoices(f, { receipts: true });
                const columns = [col('invoice', 'Invoice no.'), col('issueDate', 'Date', 'day'), col('client', 'Client'), col('total', 'Amount', 'money'), col('advance', 'Advance adjusted', 'money'), col('count', 'Receipts', 'number', { sum: true }),
                    col('receipts', 'Receipt nos.'), col('paid', 'Paid amount', 'money'), col('balance', 'Balance', 'money')];
                const rows = list.map(i => ({ ...invRecord(i), issueDate: ymd(i.issueDate), total: num(i.total), advance: num(i.advanceAdjusted), count: i.receipts.length, receipts: i.receipts.map(r => r.number).join(', '), paid: num(i.received), balance: owedOf(i), _link: { invoice: i.id } }));
                return { columns, rows, totals: totalsOf(columns, rows, ['invoice', 'invoices']) };
            } },
        { key: 'receipt-allocation', cat: 'receipts', title: 'Receipt Allocation', info: 'Receipt, invoice/reference, allocated amount and balance', need: [REP, INV], filters: { range: 'date received', country: 1, client: 1 },
            note: 'A receipt is always made against one invoice, so all of it is allocated to that invoice (unallocated money is under Unallocated Receipts). Balance = what the invoice still owes today.',
            run: async f => {
                const list = await liveReceipts(f);
                const columns = [col('number', 'Receipt'), col('receivedOn', 'Date', 'day'), col('client', 'Client'), col('invoice', 'Invoice'), col('method', 'Paid by'), col('allocated', 'Allocated', 'money'), col('unallocated', 'Unallocated', 'money'), col('balance', 'Invoice balance', 'money', { noSum: true })];
                const rows = list.map(r => ({ number: r.number, receivedOn: ymd(r.receivedOn), client: cl(r.invoice.client), invoice: r.invoice.number, method: methods[r.method] || r.method, currency: r.invoice.currency, allocated: num(r.amount), unallocated: 0,
                    balance: owed(r.invoice), _link: { invoice: r.invoiceId } }));
                return { columns, rows, totals: totalsOf(columns, rows, ['receipt', 'receipts']) };
            } },
        { key: 'receipts-unallocated', cat: 'receipts', title: 'Unallocated Receipts', info: 'Client, receipt, amount and unallocated balance', need: [REP, INV], filters: { country: 1, client: 1 },
            note: 'Money received and not yet set against an invoice, as of today: the client\'s credit (kept when an invoice was cancelled) and advances not yet taken off an invoice.',
            run: async f => {
                const [credits, advs] = await Promise.all([
                    prisma.cmpCredit.findMany({ where: { tenantId: f.tenantId, ...ofClient(f) }, orderBy: { createdAt: 'asc' }, take: TAKE, include: { client: CLIENT_SEL } }),
                    prisma.cmpAdvance.findMany({ where: { tenantId: f.tenantId, voidedAt: null, ...ofClient(f) }, orderBy: { receivedOn: 'asc' }, take: TAKE, include: { client: CLIENT_SEL } }),
                ]);
                const from = credits.length ? new Map((await prisma.cmpInvoice.findMany({ where: { tenantId: f.tenantId, id: { in: credits.map(c => c.fromInvoiceId).filter(Boolean) } }, select: { id: true, number: true } })).map(i => [i.id, i.number])) : new Map();
                const rows = [
                    ...credits.filter(c => toMinor(c.amount, c.currency) > toMinor(c.used, c.currency)).map(c => ({ client: cl(c.client), source: 'Client credit', reference: c.fromInvoiceId ? `From cancelled invoice ${from.get(c.fromInvoiceId) || ''}`.trim() : c.note, date: dayIn(f, c.createdAt), currency: c.currency,
                        amount: num(c.amount), used: num(c.used), balance: plus(c.currency, c.amount) - plus(c.currency, c.used), _link: { client: c.clientId } })),
                    ...advs.filter(a => toMinor(a.amount, a.currency) > toMinor(a.used, a.currency)).map(a => ({ client: cl(a.client), source: 'Advance payment', reference: a.number || a.description, date: ymd(a.receivedOn), currency: a.currency,
                        amount: num(a.amount), used: num(a.used), balance: plus(a.currency, a.amount) - plus(a.currency, a.used), _link: { client: a.clientId } })),
                ].sort((a, b) => a.client.localeCompare(b.client) || a.date.localeCompare(b.date));
                const columns = [col('client', 'Client'), col('source', 'Money'), col('reference', 'Receipt / reference'), col('date', 'Date', 'day'), col('amount', 'Amount', 'money'), col('used', 'Used', 'money'), col('balance', 'Unallocated balance', 'money')];
                return { columns, rows, totals: totalsOf(columns, rows) };
            } },
        { key: 'receipts-by-method', cat: 'receipts', title: 'Payment Method', info: 'Payment method, receipt count and amount', need: [REP, INV], filters: { range: 'date received', country: 1, client: 1 },
            note: 'Receipts against invoices and advance payments, by how they were paid. Client credit = a receipt paid from money kept for the client.',
            run: async f => {
                const dw = days(f), g = new Map();
                const [rcs, advs] = await Promise.all([liveReceipts(f), prisma.cmpAdvance.findMany({ where: { tenantId: f.tenantId, voidedAt: null, ...ofClient(f), ...(dw ? { receivedOn: dw } : {}) }, take: TAKE })]);
                const add = (of, method, cur, amount) => { const k = `${of}|${method}|${cur}`, x = g.get(k) || { of, method: methods[method] || method, currency: cur, count: 0, m: 0 }; x.count++; x.m += toMinor(amount, cur); g.set(k, x); };
                for (const r of rcs) add('Receipts', r.method, r.invoice.currency, r.amount);
                for (const a of advs) add('Advance payments', a.method || 'BANK', a.currency, a.amount);
                const columns = [col('method', 'Payment method'), col('of', 'Of'), col('count', 'Count', 'number', { sum: true }), col('amount', 'Amount', 'money')];
                const rows = [...g.values()].sort((a, b) => a.method.localeCompare(b.method) || a.of.localeCompare(b.of)).map(x => ({ method: x.method, of: x.of, currency: x.currency, count: x.count, amount: toMajor(x.m, x.currency) }));
                return { columns, rows, totals: totalsOf(columns, rows) };
            } },
        { key: 'collection-summary', cat: 'receipts', title: 'Collection Summary', info: 'Daily/monthly receipts and total amount', need: [REP, INV], filters: { range: 'date received', country: 1, client: 1, group: [['month', 'Monthly'], ['day', 'Daily']] },
            note: 'Money received on receipts and as advance payments. A receipt paid from client credit counts when it pays the invoice; money refunded is left out.',
            run: async f => {
                const dw = days(f), g = new Map();
                const [rcs, advs] = await Promise.all([liveReceipts(f), prisma.cmpAdvance.findMany({ where: { tenantId: f.tenantId, voidedAt: null, ...ofClient(f), ...(dw ? { receivedOn: dw } : {}) }, take: TAKE })]);
                const slot = (d, cur) => { const p = f.group === 'day' ? d : d.slice(0, 7), k = `${p}|${cur}`; if (!g.has(k)) g.set(k, { sort: k, period: f.group === 'day' ? d : monthOf(d), currency: cur, receipts: 0, r: 0, a: 0 }); return g.get(k); };
                for (const r of rcs) { const x = slot(ymd(r.receivedOn), r.invoice.currency); x.receipts++; x.r += toMinor(r.amount, r.invoice.currency); }
                for (const a of advs) { const x = slot(ymd(a.receivedOn), a.currency); x.a += toMinor(a.amount, a.currency); }
                const columns = [col('period', f.group === 'day' ? 'Day' : 'Month', f.group === 'day' ? 'day' : 'text'), col('receipts', 'Receipts', 'number', { sum: true }), col('received', 'Received on receipts', 'money'), col('advances', 'Advance payments', 'money'), col('total', 'Total collected', 'money')];
                const rows = [...g.values()].sort((a, b) => a.sort.localeCompare(b.sort)).map(x => ({ period: x.period, currency: x.currency, receipts: x.receipts, received: toMajor(x.r, x.currency), advances: toMajor(x.a, x.currency), total: toMajor(x.r + x.a, x.currency) }));
                return { columns, rows, totals: totalsOf(columns, rows, f.group === 'day' ? ['day', 'days'] : ['month', 'months']) };
            } },
        { key: 'receipt-history', cat: 'receipts', title: 'Receipt History', info: 'Changes, old value, new value, date and user', need: [REP, INV, LOG], filters: { range: 'date' }, note: HISTORY_NOTE,
            run: history(['cmp.receipt.'], { recordLabel: 'Receipt', extra: [col('client', 'Client')] }) },

        /* ----- Receivables ----- */
        { key: 'receivables-outstanding', cat: 'receivables', title: 'Outstanding Receivables', info: 'Client, invoice, amount received and outstanding balance', need: [REP, INV], filters: { country: 1, client: 1 },
            note: 'Every issued invoice not paid in full, as of today (an advance taken off counts as received).',
            run: async f => {
                const list = await prisma.cmpInvoice.findMany({ where: { tenantId: f.tenantId, status: { in: UNPAID }, ...ofClient(f) }, orderBy: [{ issueDate: 'asc' }], take: TAKE, include: { client: CLIENT_SEL } });
                const columns = [col('client', 'Client'), col('invoice', 'Invoice no.'), col('issueDate', 'Invoice date', 'day'), col('dueDate', 'Payment due', 'day'), col('total', 'Amount', 'money'), col('received', 'Amount received', 'money'), col('outstanding', 'Outstanding balance', 'money')];
                const rows = list.map(i => ({ ...invRecord(i), issueDate: ymd(i.issueDate), dueDate: ymd(i.dueDate), total: num(i.total), received: plus(i.currency, i.received, i.advanceAdjusted), outstanding: owedOf(i), _link: { invoice: i.id } }));
                return { columns, rows, totals: totalsOf(columns, rows, ['invoice', 'invoices']) };
            } },
        { key: 'receivables-aging', cat: 'receivables', title: 'Receivables Aging', info: 'Client, invoice, due date, balance and days outstanding', need: [REP, INV], filters: { country: 1, client: 1 },
            note: 'Invoices not paid in full, by days since the invoice date (0-30, 31-60, 61-90, over 90).',
            run: async f => {
                const d = await reports.report({ tenantId: f.tenantId, perms: f.perms }, 'aging', f.clientId ? { clientId: f.clientId } : {});
                const B = d.buckets || ['0-30', '31-60', '61-90', '90+'];
                const columns = [col('client', 'Client'), col('invoice', 'Invoice no.'), col('issueDate', 'Invoice date', 'day'), col('dueDate', 'Payment due', 'day'), col('age', 'Days outstanding', 'number'),
                    ...B.map((b, i) => col(`b${i}`, `${b} days`, 'money')), col('balance', 'Balance', 'money')];
                const rows = d.rows.filter(i => !f.country || i.client.country === f.country).map(i => ({ ...invRecord(i), issueDate: i.issueDate, dueDate: i.dueDate, age: i.age, ...Object.fromEntries(B.map((b, k) => [`b${k}`, i.bucket === b ? i.outstanding : null])), balance: i.outstanding, _link: { invoice: i.id } }));
                return { columns, rows, totals: totalsOf(columns, rows, ['invoice', 'invoices']) };
            } },
        { key: 'receivables-overdue', cat: 'receivables', title: 'Overdue Receivables', info: 'Client, invoice, balance and days overdue', need: [REP, INV], filters: { country: 1, client: 1 },
            note: 'Invoices not paid in full whose payment due date has passed (an invoice with no payment due date is never overdue: see Receivables Aging).',
            run: async f => {
                const list = await prisma.cmpInvoice.findMany({ where: { tenantId: f.tenantId, status: { in: UNPAID }, dueDate: { lt: dateOf(f.today) }, ...ofClient(f) }, orderBy: { dueDate: 'asc' }, take: TAKE, include: { client: CLIENT_SEL } });
                const columns = [col('client', 'Client'), col('invoice', 'Invoice no.'), col('issueDate', 'Invoice date', 'day'), col('dueDate', 'Payment due', 'day'), col('balance', 'Balance', 'money'), col('days', 'Days overdue', 'number')];
                const rows = list.map(i => ({ ...invRecord(i), issueDate: ymd(i.issueDate), dueDate: ymd(i.dueDate), balance: owedOf(i), days: R.daysBetween(ymd(i.dueDate), f.today), _link: { invoice: i.id } }));
                return { columns, rows, totals: totalsOf(columns, rows, ['invoice', 'invoices']) };
            } },
        { key: 'customer-balance', cat: 'receivables', title: 'Customer Balance', info: 'Client, invoiced amount, received amount and balance', need: [REP, INV], filters: { range: 'invoice date', country: 1, client: 1 },
            note: 'The invoices dated in the dates chosen (choose All history for the whole balance); received includes advances taken off. Archived clients are left out. Credit = money kept for the client, to date.',
            run: async f => {
                const d = await reports.report({ tenantId: f.tenantId, perms: f.perms }, 'clients', { from: f.from, to: f.to, ...(f.country ? { country: f.country } : {}) });
                const credits = await prisma.cmpCredit.findMany({ where: { tenantId: f.tenantId, ...ofClient(f) }, select: { clientId: true, currency: true, amount: true, used: true } });
                const credit = new Map();
                for (const c of credits) credit.set(`${c.clientId}|${c.currency}`, (credit.get(`${c.clientId}|${c.currency}`) || 0) + toMinor(c.amount, c.currency) - toMinor(c.used, c.currency));
                const rows = [];
                for (const r of d.rows) {
                    if (f.clientId && r.client.id !== f.clientId) continue;
                    for (const m of r.money || []) rows.push({ client: cl(r.client), country: countryName(r.client.country), currency: m.currency, invoiced: m.invoiced, received: m.received, balance: m.outstanding, credit: toMajor(credit.get(`${r.client.id}|${m.currency}`) || 0, m.currency), _link: { client: r.client.id } });
                }
                const columns = [col('client', 'Client'), col('country', 'Country'), col('invoiced', 'Invoiced', 'money'), col('received', 'Received', 'money'), col('balance', 'Balance', 'money'), col('credit', 'Credit available', 'money')];
                return { columns, rows, totals: totalsOf(columns, rows, ['client', 'clients']) };
            } },
        { key: 'collection-status', cat: 'receivables', title: 'Collection Status', info: 'Outstanding, overdue and collected amounts', need: [REP, INV], filters: { range: 'invoice date', country: 1, client: 1 },
            note: 'The issued invoices dated in the dates chosen: collected (receipts and advances taken off), outstanding but not yet due (or with no payment due date) and overdue, as of today.',
            run: async f => {
                const g = new Map();
                for (const i of await issuedInvoices(f)) {
                    const x = g.get(i.currency) || { currency: i.currency, count: 0, inv: 0, col: 0, out: 0, over: 0 };
                    const owe = toMinor(owedOf(i), i.currency);
                    x.count++; x.inv += toMinor(i.total, i.currency); x.col += toMinor(i.received, i.currency) + toMinor(i.advanceAdjusted, i.currency);
                    if (owe > 0 && i.dueDate && ymd(i.dueDate) < f.today) x.over += owe; else x.out += owe;
                    g.set(i.currency, x);
                }
                const columns = [col('currency', 'Currency'), col('count', 'Invoices', 'number'), col('invoiced', 'Invoiced', 'money'), col('collected', 'Collected', 'money'), col('outstanding', 'Outstanding (not yet due)', 'money'), col('overdue', 'Overdue', 'money'), col('rate', 'Collected (%)', 'number')];
                const rows = [...g.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map(x => ({ currency: x.currency, count: x.count, invoiced: toMajor(x.inv, x.currency), collected: toMajor(x.col, x.currency), outstanding: toMajor(x.out, x.currency), overdue: toMajor(x.over, x.currency), rate: pct(x.col, x.inv) }));
                return { columns, rows };
            } },

        /* ----- Items & taxes ----- */
        { key: 'item-register', cat: 'items', title: 'Item Register', info: 'Item code, name, category, unit and status', need: [REP, ITEMS], filters: {},
            run: async f => {
                const list = await prisma.cmpItem.findMany({ where: { tenantId: f.tenantId }, orderBy: [{ name: 'asc' }, { currency: 'asc' }], take: TAKE, include: { prices: { orderBy: { lastOn: 'desc' }, take: 1 } } });
                const columns = [col('code', 'Item code'), col('name', 'Name'), col('category', 'Category'), col('unit', 'Unit'), col('price', 'Price', 'money', { noSum: true }), col('countries', 'Countries'), col('lastBilled', 'Last price used', 'day'), col('status', 'Status')];
                return { columns, rows: list.map(i => ({ code: i.code || '', name: i.name, category: i.category || '', unit: i.unit || '', currency: i.currency, price: num(i.amount), countries: scopeText(i.allCountries, i.countries),
                    lastBilled: i.prices[0] ? ymd(i.prices[0].lastOn) : '', status: i.active ? 'Active' : 'Retired (not suggested)' })) };
            } },
        { key: 'item-usage', cat: 'items', title: 'Item Usage', info: 'Item, quantity, invoice count and sales amount', need: [REP, INV], filters: { range: 'issue date', country: 1, client: 1 },
            note: 'From issued invoices. Quantity = the number of invoice lines that billed it.',
            run: async f => {
                const g = new Map();
                for (const l of linesWithTax(await issuedInvoices(f, { lines: true }))) {
                    const k = `${l.key}|${l.currency}`, x = g.get(k) || { item: l.name, currency: l.currency, quantity: 0, invs: new Set(), a: 0, last: '' };
                    x.quantity++; x.invs.add(l.inv.id); x.a += toMinor(l.amount, l.currency); if (ymd(l.inv.issueDate) > x.last) x.last = ymd(l.inv.issueDate); g.set(k, x);
                }
                const columns = [col('item', 'Item'), col('quantity', 'Quantity', 'number', { sum: true }), col('invoices', 'Invoices', 'number'), col('amount', 'Sales amount', 'money'), col('last', 'Last billed', 'day')];
                const rows = [...g.values()].sort((a, b) => b.a - a.a || a.item.localeCompare(b.item)).map(x => ({ item: x.item, currency: x.currency, quantity: x.quantity, invoices: x.invs.size, amount: toMajor(x.a, x.currency), last: x.last }));
                return { columns, rows, totals: totalsOf(columns, rows, ['item', 'items']) };
            } },
        { key: 'tax-config', cat: 'items', title: 'Tax Configuration', info: 'Tax name, type, rate, effective date and status', need: [REP, ITEMS], filters: {},
            note: 'Effective date: from when the rate applies, or (when not given) the day it was recorded.',
            run: async f => {
                const list = await prisma.cmpTaxRate.findMany({ where: { tenantId: f.tenantId }, orderBy: [{ name: 'asc' }, { rate: 'asc' }] });
                return { columns: [col('name', 'Tax name'), col('type', 'Type'), col('rate', 'Rate (%)', 'number'), col('effective', 'Effective from', 'day'), col('countries', 'Countries'), col('status', 'Status')],
                    rows: list.map(t => ({ name: t.name, type: t.type || '', rate: Number(t.rate), effective: t.effectiveFrom ? ymd(t.effectiveFrom) : dayIn(f, t.createdAt), countries: scopeText(t.allCountries, t.countries), status: t.active ? 'Active' : 'Retired (not suggested)' })) };
            } },
        { key: 'item-tax-mapping', cat: 'items', title: 'Item Tax Mapping', info: 'Item, applicable tax and tax rate', need: [REP, INV], filters: { range: 'issue date', country: 1 },
            note: 'Taxes are set per country, not per item: this shows the taxes on the issued invoices that billed each item.',
            run: async f => {
                const g = new Map();
                for (const i of await issuedInvoices(f, { lines: true, taxes: true })) {
                    const items = new Map(i.lines.map(l => [R.keyOf(itemName(l)), itemName(l)]));
                    for (const [k, name] of items) {
                        for (const t of i.taxes.length ? i.taxes : [null]) {
                            const key = `${k}|${t ? `${t.name.toLowerCase()}|${Number(t.rate)}` : '-'}`, x = g.get(key) || { item: name, tax: t ? t.name : 'No tax', rate: t ? Number(t.rate) : null, invs: new Set(), last: '' };
                            x.invs.add(i.id); if (ymd(i.issueDate) > x.last) x.last = ymd(i.issueDate); g.set(key, x);
                        }
                    }
                }
                return { columns: [col('item', 'Item'), col('tax', 'Applicable tax'), col('rate', 'Tax rate (%)', 'number'), col('invoices', 'Invoices', 'number'), col('last', 'Last used', 'day')],
                    rows: [...g.values()].sort((a, b) => a.item.localeCompare(b.item) || a.tax.localeCompare(b.tax)).map(x => ({ item: x.item, tax: x.tax, rate: x.rate, invoices: x.invs.size, last: x.last })) };
            } },
        { key: 'tax-summary', cat: 'items', title: 'Tax Summary', info: 'Tax type/rate, taxable amount and tax amount', need: [REP, INV], filters: { range: 'issue date', country: 1, client: 1 },
            note: 'From issued invoices; the type comes from the tax configuration (same name and rate). The taxable amounts are not added up (an invoice with two taxes counts in both).',
            run: async f => taxTable(f, { withType: true }) },
        { key: 'tax-transactions', cat: 'items', title: 'Tax Transaction Report', info: 'Tax applied by invoice, client and period', need: [REP, INV], filters: { range: 'issue date', country: 1, client: 1 },
            note: 'Each tax on each issued invoice; the period is the invoice\'s month.',
            run: async f => {
                const rows = [];
                for (const i of await issuedInvoices(f, { taxes: true })) {
                    for (const t of i.taxes) rows.push({ ...invRecord(i), issueDate: ymd(i.issueDate), period: monthOf(ymd(i.issueDate)), tax: t.name, rate: Number(t.rate), taxable: taxableOf(i), amount: num(t.amount), _link: { invoice: i.id } });
                }
                const columns = [col('invoice', 'Invoice no.'), col('issueDate', 'Date', 'day'), col('period', 'Period'), col('client', 'Client'), col('tax', 'Tax'), col('rate', 'Rate (%)', 'number'), col('taxable', 'Taxable amount', 'money', { noSum: true }), col('amount', 'Tax amount', 'money')];
                return { columns, rows, totals: totalsOf(columns, rows, ['tax line', 'tax lines']) };
            } },
        { key: 'item-history', cat: 'items', title: 'Item History', info: 'Item changes, old value, new value, date and user', need: [REP, ITEMS, LOG], filters: { range: 'date' }, note: HISTORY_NOTE,
            run: history(['cmp.item.'], { recordLabel: 'Item' }) },
        { key: 'tax-history', cat: 'items', title: 'Tax History', info: 'Tax changes, old value, new value, date and user', need: [REP, ITEMS, LOG], filters: { range: 'date' }, note: HISTORY_NOTE,
            run: history(['cmp.tax.'], { recordLabel: 'Tax' }) },

        /* ----- Additional information ----- */
        { key: 'field-register', cat: 'info', title: 'Custom Field Register', info: 'Field name, type, module, mandatory status and status', need: [REP], filters: {},
            note: 'Additional information belongs to clients. Every field in use is expected for the clients of its countries: a blank one is listed as missing.',
            run: async f => {
                const list = await prisma.cmpFieldDef.findMany({ where: { tenantId: f.tenantId }, orderBy: [{ active: 'desc' }, { name: 'asc' }], include: { _count: { select: { values: true } } } });
                return { columns: [col('name', 'Field name'), col('type', 'Type'), col('module', 'Module'), col('countries', 'Countries'), col('mandatory', 'Mandatory'), col('values', 'Values kept', 'number'), col('status', 'Status')],
                    rows: list.map(d => ({ name: d.name, type: V.FIELD_TYPES[d.type] || d.type, module: 'Clients', countries: scopeText(d.allCountries, d.countries), mandatory: d.active ? 'Yes (shown as missing when blank)' : 'No (retired)', values: d._count.values, status: d.active ? 'Active' : 'Retired (values kept, hidden)' })) };
            } },
        { key: 'field-missing', cat: 'info', title: 'Missing Information', info: 'Client/record and missing custom fields', need: [REP], filters: { country: 1 },
            note: 'Active clients with fields of their country left blank.',
            run: async f => {
                const list = (await quality(f)).filter(x => x.area === 'Clients' && x.check === 'Additional information');
                const columns = [col('code', 'Code'), col('client', 'Client'), col('country', 'Country'), col('count', 'Missing', 'number', { sum: true }), col('fields', 'Missing fields', 'text', { wide: true })];
                const rows = list.map(x => ({ code: x.code, client: x.client, country: x.country, count: x.detail.split(', ').length, fields: x.detail, _link: x.link }));
                return { columns, rows, totals: totalsOf(columns, rows, ['client', 'clients']) };
            } },
        { key: 'field-usage', cat: 'info', title: 'Field Usage', info: 'Field name, populated records and blank records', need: [REP], filters: { country: 1 },
            note: 'Among the active clients each field is for.',
            run: async f => {
                const [defs, cls, vals] = await Promise.all([
                    prisma.cmpFieldDef.findMany({ where: { tenantId: f.tenantId }, orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
                    prisma.cmpClient.findMany({ where: { tenantId: f.tenantId, archivedAt: null, ...(f.country ? { country: f.country } : {}) }, select: { id: true, country: true }, take: TAKE }),
                    prisma.cmpFieldValue.findMany({ where: { tenantId: f.tenantId }, select: { clientId: true, fieldId: true }, take: TAKE * 20 }),
                ]);
                const have = new Set(vals.map(v => `${v.clientId}:${v.fieldId}`));
                return { columns: [col('name', 'Field name'), col('countries', 'Countries'), col('clients', 'Clients it is for', 'number'), col('populated', 'Populated', 'number'), col('blank', 'Blank', 'number'), col('rate', 'Filled (%)', 'number'), col('status', 'Status')],
                    rows: defs.map(d => {
                        const mine = cls.filter(c => d.allCountries || d.countries.includes(c.country)), filled = mine.filter(c => have.has(`${c.id}:${d.id}`)).length;
                        return { name: d.name, countries: scopeText(d.allCountries, d.countries), clients: mine.length, populated: filled, blank: d.active ? mine.length - filled : null, rate: d.active ? pct(filled, mine.length) : null, status: d.active ? 'Active' : 'Retired' };
                    }) };
            } },
        { key: 'field-history', cat: 'info', title: 'Information History', info: 'Field changes, old value, new value, date and user', need: [REP, LOG], filters: { range: 'date', client: 1 },
            note: `${HISTORY_NOTE} The fields themselves (added, renamed, retired) and the values typed for clients.`,
            run: async f => {
                const fieldNames = new Set((await prisma.cmpFieldDef.findMany({ where: { tenantId: f.tenantId }, select: { name: true } })).map(d => R.keyOf(d.name)));
                const list = (await logs(f, { prefixes: ['cmp.field.', 'cmp.client.create', 'cmp.client.update'], where: f.clientId ? { OR: [{ entityId: f.clientId }, { details: { path: ['clientId'], equals: f.clientId } }] } : {} }))
                    // a client entry counts when it changed one of the fields (by its changes, or the names an older entry listed)
                    .filter(l => l.action.startsWith('cmp.field.') || (detailOf(l, 'changes') || []).some(c => c && fieldNames.has(R.keyOf(c.field))) || (detailOf(l, 'changed') || []).some(n => fieldNames.has(R.keyOf(n))));
                const nm = await names(f, list);
                return { columns: historyCols('Field / client'), rows: expand(list, nm, { recordOf: l => (l.action.startsWith('cmp.field.') ? nm.record(l) : nm.client(l)), keep: (c, l) => l.action.startsWith('cmp.field.') || fieldNames.has(R.keyOf(c.field)) }) };
            } },

        /* ----- Message templates ----- */
        { key: 'template-register', cat: 'templates', title: 'Template Register', info: 'Template name, type, channel and status', need: [REP], filters: {},
            run: async f => {
                const list = await prisma.cmpTemplate.findMany({ where: { tenantId: f.tenantId }, orderBy: [{ active: 'desc' }, { name: 'asc' }], include: { _count: { select: { reminders: true, docLinks: true } } } });
                return { columns: [col('name', 'Template name'), col('type', 'Type'), col('country', 'Country'), col('channel', 'Channel'), col('version', 'Version', 'number'), col('used', 'Used by (reminders and obligations)', 'number'), col('status', 'Status'), col('updatedAt', 'Last changed', 'at'), col('updatedBy', 'By')],
                    rows: list.map(t => ({ name: t.name, type: purposeLabel(t.purpose), country: t.country ? countryName(t.country) : 'All countries', channel: 'WhatsApp', version: t.version || 1, used: t._count.reminders + t._count.docLinks,
                        status: t.active ? 'Active' : 'Retired', updatedAt: t.updatedAt, updatedBy: t.updatedBy || t.createdBy })) };
            } },
        { key: 'template-usage', cat: 'templates', title: 'Template Usage', info: 'Template, usage count and last used date', need: [REP], filters: { range: 'date sent', country: 1, client: 1 },
            note: 'Every kind of message; templates never used in the dates chosen show 0. A message marked "not sent" is not counted as a use.',
            run: async f => templateUsage(f, {}) },
        { key: 'template-history', cat: 'templates', title: 'Template History', info: 'Template changes, versions, date and user', need: [REP, LOG], filters: { range: 'date' },
            note: `${HISTORY_NOTE} A template's version goes up each time its message changes.`,
            run: history(['cmp.template.'], { recordLabel: 'Template', extra: [col('version', 'Version')] }) },

        /* ----- Invoice & receipt formats ----- */
        { key: 'format-register', cat: 'formats', title: 'Format Register', info: 'Format name, document type, default status and status', need: [REP], filters: { country: 1 },
            run: async f => {
                const list = await prisma.cmpInvoiceType.findMany({ where: { tenantId: f.tenantId, ...(f.country ? { country: f.country } : {}) }, orderBy: [{ kind: 'asc' }, { country: 'asc' }, { name: 'asc' }] });
                return { columns: [col('name', 'Format name'), col('kind', 'Document type'), col('country', 'Country'), col('isDefault', 'Default'), col('status', 'Status'), col('updatedAt', 'Last changed', 'at')],
                    rows: list.map(t => ({ name: t.name, kind: DOC_KINDS[t.kind || 'INVOICE'] || t.kind, country: countryName(t.country), isDefault: t.isDefault ? 'Default for its country' : '', status: t.active ? 'Active' : 'Retired', updatedAt: t.updatedAt })) };
            } },
        { key: 'format-usage', cat: 'formats', title: 'Format Usage', info: 'Format, document type and usage count', need: [REP, INV], filters: { range: 'document date', country: 1 },
            note: 'Issued invoices (by issue date), receipts and advance payment receipts (by date received) printed with each format.',
            run: async f => {
                const dw = days(f), cw = f.country ? { client: { country: f.country } } : {};
                const [types, invs, rcs, advs] = await Promise.all([
                    prisma.cmpInvoiceType.findMany({ where: { tenantId: f.tenantId, ...(f.country ? { country: f.country } : {}) } }),
                    prisma.cmpInvoice.groupBy({ by: ['typeId'], where: { tenantId: f.tenantId, status: { not: 'DRAFT' }, ...cw, ...(dw ? { issueDate: dw } : {}) }, _count: { _all: true }, _max: { issueDate: true } }),
                    prisma.cmpReceipt.groupBy({ by: ['typeId'], where: { tenantId: f.tenantId, voidedAt: null, ...(f.country ? { invoice: { client: { country: f.country } } } : {}), ...(dw ? { receivedOn: dw } : {}) }, _count: { _all: true }, _max: { receivedOn: true } }),
                    prisma.cmpAdvance.groupBy({ by: ['typeId'], where: { tenantId: f.tenantId, voidedAt: null, ...cw, ...(dw ? { receivedOn: dw } : {}) }, _count: { _all: true }, _max: { receivedOn: true } }),
                ]);
                const rows = [];
                for (const [kind, list, last] of [['INVOICE', invs, 'issueDate'], ['RECEIPT', rcs, 'receivedOn'], ['ADVANCE', advs, 'receivedOn']]) {
                    for (const t of types.filter(x => (x.kind || 'INVOICE') === kind)) { const u = list.find(x => x.typeId === t.id); rows.push({ name: t.name, kind: DOC_KINDS[kind], country: countryName(t.country), uses: u ? u._count._all : 0, last: u ? ymd(u._max[last]) : '', status: t.active ? 'Active' : 'Retired' }); }
                    for (const u of list.filter(x => x.typeId && !types.some(t => t.id === x.typeId))) rows.push({ name: '(a format of another country)', kind: DOC_KINDS[kind], country: '', uses: u._count._all, last: ymd(u._max[last]), status: '' });
                    const none = list.find(x => !x.typeId);
                    if (none) rows.push({ name: '(no format: the standard layout)', kind: DOC_KINDS[kind], country: '', uses: none._count._all, last: ymd(none._max[last]), status: '' });
                }
                const columns = [col('name', 'Format'), col('kind', 'Document type'), col('country', 'Country'), col('uses', 'Usage count', 'number', { sum: true }), col('last', 'Last used', 'day'), col('status', 'Status')];
                return { columns, rows, totals: totalsOf(columns, rows, ['line', 'lines']) };
            } },
        { key: 'format-history', cat: 'formats', title: 'Format History', info: 'Format changes, versions, date and user', need: [REP, LOG], filters: { range: 'date' },
            note: `${HISTORY_NOTE} Each issued invoice, receipt and advance receipt keeps the format as it was that day.`,
            run: history(['cmp.invtype.'], { recordLabel: 'Format' }) },

        /* ----- Audit & activity ----- */
        { key: 'audit-trail', cat: 'audit', title: 'Audit Trail', info: 'Module, record, action, field, old value, new value, date and user', need: [REP, LOG], filters: { range: 'date', module: MODULES.map(m => [m[0], m[1]]), user: 1 }, note: HISTORY_NOTE,
            run: async f => {
                const list = await logs(f);
                const nm = await names(f, list);
                return { columns: [col('at', 'When', 'at'), col('module', 'Module'), col('record', 'Record'), col('action', 'Action'), col('field', 'Field'), col('old', 'Old value'), col('new', 'New value'), col('details', 'Details', 'text', { wide: true }), col('user', 'User')],
                    rows: expand(list, nm) };
            } },
        { key: 'user-activity', cat: 'audit', title: 'User Activity', info: 'User, module, action, record and date/time', need: [REP, LOG], filters: { range: 'date', module: MODULES.map(m => [m[0], m[1]]), user: 1 },
            run: async f => {
                const list = await logs(f);
                const nm = await names(f, list);
                const by = {};
                for (const l of list) by[l.userEmail] = (by[l.userEmail] || 0) + 1;
                return { columns: [col('user', 'User'), col('module', 'Module'), col('action', 'Action'), col('record', 'Record'), col('at', 'Date / time', 'at'), col('details', 'Details', 'text', { wide: true })],
                    rows: list.map(l => ({ user: l.userEmail, module: moduleOf(l.action), action: actionLabel(l.action), record: nm.record(l) || nm.client(l), at: l.createdAt, details: l.summary })),
                    cards: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([u, n]) => ({ label: u, value: n })) };
            } },
        { key: 'records-created', cat: 'audit', title: 'Created Records', info: 'Module, record, creation date/time and user', need: [REP, LOG], filters: { range: 'date', module: MODULES.map(m => [m[0], m[1]]), user: 1 },
            note: 'Everything added: clients, obligations (and the next periods prepared), templates, fields, invoices, receipts, advances, items, taxes and formats.',
            run: async f => recordsBy(f, l => /\.(create|generate)$/.test(l.action)) },
        { key: 'records-modified', cat: 'audit', title: 'Modified Records', info: 'Module, record, modification date/time and user', need: [REP, LOG], filters: { range: 'date', module: MODULES.map(m => [m[0], m[1]]), user: 1 },
            note: 'Every change that is not an addition or a deletion: details changed, steps, archiving, issuing, sending, cancelling… (downloads and passwords shown are not changes).',
            run: async f => recordsBy(f, l => !/\.(create|generate|delete)$/.test(l.action) && !UNDONE.includes(l.action) && !/^cmp\.(export|log)\./.test(l.action) && l.action !== 'cmp.client.secrets_view') },
        { key: 'records-deleted', cat: 'audit', title: 'Deleted Records', info: 'Module, record, deletion date/time and user', need: [REP, LOG], filters: { range: 'date', module: MODULES.map(m => [m[0], m[1]]), user: 1 },
            note: 'Deleted for good: obligations, draft invoices and templates. Receipts and advances are never removed: undone ones (voided) are listed here too.',
            run: async f => recordsBy(f, l => /\.delete$/.test(l.action) || UNDONE.includes(l.action)) },

        /* ----- Data quality ----- */
        { key: 'dq-summary', cat: 'quality', title: 'Data Quality Summary', info: 'Missing, duplicate, invalid and incomplete records', need: [REP], filters: { country: 1 },
            note: 'Each check with the number of records it found. Details: Duplicate Records, Missing Information and Configuration Issues; invalid phone numbers and emails are under Clients → Client Data Quality. Invoices, receipts and advances are checked only for those who may see them.',
            run: async f => {
                const g = new Map();
                for (const x of await quality(f)) { const k = `${KIND_ORDER.indexOf(x.kind)}|${x.area}|${x.check}`; const y = g.get(k) || { kind: x.kind, area: x.area, check: x.check, records: 0 }; y.records++; g.set(k, y); }
                const columns = [col('kind', 'Problem'), col('area', 'Area'), col('check', 'Check'), col('records', 'Records', 'number', { sum: true })];
                const rows = [...g.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
                const by = {};
                for (const r of rows) by[r.kind] = (by[r.kind] || 0) + r.records;
                return { columns, rows, totals: totalsOf(columns, rows, ['check', 'checks']), cards: KIND_ORDER.map(k => ({ label: k, value: by[k] || 0 })) };
            } },
        { key: 'dq-duplicates', cat: 'quality', title: 'Duplicate Records', info: 'Duplicate clients, invoices, receipts or other records', need: [REP], filters: { country: 1 },
            note: 'Clients with the same name, registration no. or contact number; an obligation twice for a client; invoices of the same client, total and date; receipts of the same invoice, amount and date; advances of the same client, amount and date.',
            run: async f => {
                const list = (await quality(f)).filter(x => x.kind === 'Duplicate');
                return { columns: [col('area', 'Type'), ...issueCols, col('check', 'Matched on'), col('value', 'Value'), col('detail', 'Same as', 'text', { wide: true })], rows: issueRows(list) };
            } },
        { key: 'dq-missing', cat: 'quality', title: 'Missing Information', info: 'Records with missing required information', need: [REP], filters: { country: 1 },
            note: 'Clients without a contact number, email, registration no. or portal login (unless they have no portal), or with additional information of their country left blank; obligation periods whose copied dates are still to confirm.',
            run: async f => {
                const list = (await quality(f)).filter(x => x.kind === 'Missing' || x.kind === 'Incomplete');
                return { columns: [col('area', 'Area'), ...issueCols, col('kind', 'Problem'), col('check', 'Missing'), col('detail', 'Details', 'text', { wide: true })], rows: issueRows(list) };
            } },
        { key: 'dq-config', cat: 'quality', title: 'Configuration Issues', info: 'Missing tax mappings, inactive items, invalid settings and similar issues', need: [REP], filters: { country: 1 },
            note: 'Countries with clients but no default format or no tax, retired items or taxes still on draft invoices, templates whose category is not chosen, obligations with no reminders or with a retired template, settings missing or wrong. Taxes and items are checked for those who may see them.',
            run: async f => {
                const list = (await quality(f)).filter(x => x.kind === 'Configuration');
                return { columns: [col('area', 'Area'), col('check', 'Issue'), col('record', 'Record'), col('detail', 'Details', 'text', { wide: true })], rows: issueRows(list) };
            } },

        /* ----- the CA's Comprehensive Dashboard SRS, section 5 (24 Nov 2026): country and person summaries, annual compliance, data
           collection, tasks (each obligation's Task step: open once its data is collected) and staff ----- */
        { key: 'clients-by-country', cat: 'clients', title: 'Country-wise Client Summary', info: 'Clients, new clients and their obligations, country by country', need: [REP], filters: { range: 'client added on' },
            note: 'Active = not archived. New = added in the dates chosen. Open and overdue obligations are those of the active clients.',
            run: async f => {
                const [cls, open] = await Promise.all([prisma.cmpClient.findMany({ where: { tenantId: f.tenantId }, select: { country: true, archivedAt: true, createdAt: true }, take: 20000 }), openRows(f)]);
                const by = new Map(), get = k => { if (!by.has(k)) by.set(k, { country: countryName(k), active: 0, archived: 0, added: 0, open: 0, overdue: 0 }); return by.get(k); };
                for (const c of cls) { const x = get(c.country); if (c.archivedAt) x.archived++; else x.active++; if (inRange(f, dayIn(f, c.createdAt))) x.added++; }
                for (const r of open) { const x = get(r.client.country); x.open++; if (r.view.overdue) x.overdue++; }
                const rows = [...by.values()].sort((a, b) => a.country.localeCompare(b.country));
                const columns = [col('country', 'Country'), col('active', 'Active clients', 'number', { sum: true }), col('archived', 'Archived', 'number', { sum: true }), col('added', f.from || f.to ? 'New in the dates' : 'Added (all time)', 'number', { sum: true }),
                    col('open', 'Open obligations', 'number', { sum: true }), col('overdue', 'Overdue', 'number', { sum: true })];
                return { columns, rows, totals: totalsOf(columns, rows, ['country', 'countries']) };
            } },
        { key: 'clients-by-person', cat: 'clients', title: 'Assigned-user-wise Client Summary', info: 'Clients and their obligations, person by person', need: [REP], filters: { country: 1 },
            note: 'A client counts for the person it is assigned to ("Nobody" when none). Open and overdue obligations count for the obligation\'s own person, else the client\'s.',
            run: async f => {
                const nm = await team(f);
                const [cls, open] = await Promise.all([prisma.cmpClient.findMany({ where: { tenantId: f.tenantId, ...(f.country ? { country: f.country } : {}) }, select: { assignedToId: true, archivedAt: true }, take: 20000 }), openRows(f)]);
                const by = new Map(), get = k => { if (!by.has(k)) by.set(k, { person: k ? who(nm, k) : 'Nobody', active: 0, archived: 0, open: 0, overdue: 0 }); return by.get(k); };
                for (const c of cls) { const x = get(c.assignedToId || ''); if (c.archivedAt) x.archived++; else x.active++; }
                for (const r of open) { const x = get(r.assignedToId || ''); x.open++; if (r.view.overdue) x.overdue++; }
                const rows = [...by.values()].sort((a, b) => b.active - a.active || a.person.localeCompare(b.person));
                const columns = [col('person', 'Person'), col('active', 'Active clients', 'number', { sum: true }), col('archived', 'Archived clients', 'number', { sum: true }), col('open', 'Open obligations', 'number', { sum: true }), col('overdue', 'Overdue', 'number', { sum: true })];
                return { columns, rows, totals: totalsOf(columns, rows, ['person', 'people']) };
            } },
        { key: 'deadlines-by-country', cat: 'compliance', title: 'Country-wise Statutory Deadlines', info: 'Deadlines due soon (and overdue), country by country', need: [REP], filters: { days: 1, country: 1, client: 1 },
            note: 'Every period not completed whose due date is within the window (overdue ones included), by country then due date; each on its client\'s own calendar.',
            run: async f => {
                const nm = await team(f);
                const list = (await openRows(f)).filter(r => r.view.daysLeft <= f.days).sort((a, b) => countryName(a.client.country).localeCompare(countryName(b.client.country)) || (a.dueDate < b.dueDate ? -1 : 1));
                const cards = {}; for (const r of list) cards[countryName(r.client.country)] = (cards[countryName(r.client.country)] || 0) + 1;
                return { columns: [col('country', 'Country'), col('dueDate', 'Due date', 'day'), col('client', 'Client'), col('obligation', 'Obligation'), col('period', 'Period'), col('days', 'Days left', 'number'), col('status', 'Status'), col('assignedTo', 'Assigned to')],
                    rows: list.map(r => ({ ...occRow(r, nm), country: countryName(r.client.country) })), cards: Object.entries(cards).map(([label, value]) => ({ label, value })) };
            } },
        { key: 'annual-compliance', cat: 'compliance', title: 'Annual Compliance Status', info: 'Periods due in the year: completed on time, late, open, overdue; compliance rate', need: [REP],
            filters: { range: 'due date', country: 1, client: 1, group: [['client', 'By client'], ['obligation', 'By obligation'], ['country', 'By country']] },
            note: 'The periods whose due date is in the dates chosen (this calendar year when none are chosen). On time = completed on or before its due date. Rate = on time ÷ the periods that can be judged (due date passed, or completed already).',
            run: async f => {
                const y = f.today.slice(0, 4), from = f.from || `${y}-01-01`, to = f.to || `${y}-12-31`, at = now();
                const list = await prisma.cmpOccurrence.findMany({ where: { tenantId: f.tenantId, obligation: liveOb(f), dueDate: { gte: dateOf(from), lte: dateOf(to) }, ...(f.clientId ? { clientId: f.clientId } : {}) }, take: TAKE * 4,
                    select: { stage: true, dueDate: true, dueAt: true, completedOn: true, closedAt: true, obligation: { select: { name: true, client: { select: { id: true, code: true, name: true, country: true } } } } } });
                const keyOf = o => (f.group === 'obligation' ? o.obligation.name.trim() : f.group === 'country' ? countryName(o.obligation.client.country) : cl(o.obligation.client));
                const by = new Map();
                for (const o of list) {
                    const k = keyOf(o); if (!by.has(k)) by.set(k, { name: k, due: 0, onTime: 0, late: 0, open: 0, overdue: 0, judged: 0 });
                    const x = by.get(k), done = o.stage === 'COMPLETED', passed = +o.dueAt <= +at;
                    x.due++; if (passed || done) x.judged++; // (completed before its due date: on time already; open and not due yet: not judged)
                    if (done) { const day = o.completedOn ? ymd(o.completedOn) : dayIn(f, o.closedAt); if (day && day > ymd(o.dueDate)) x.late++; else x.onTime++; }
                    else if (passed) x.overdue++; else x.open++;
                }
                const rows = [...by.values()].map(x => ({ ...x, rate: x.judged ? `${Math.round(x.onTime / x.judged * 100)}%` : '—' })).sort((a, b) => a.name.localeCompare(b.name));
                const all = rows.reduce((m, x) => ({ due: m.due + x.due, onTime: m.onTime + x.onTime, judged: m.judged + x.judged }), { due: 0, onTime: 0, judged: 0 });
                const columns = [col('name', f.group === 'obligation' ? 'Obligation' : f.group === 'country' ? 'Country' : 'Client'), col('due', 'Periods due', 'number', { sum: true }), col('onTime', 'On time', 'number', { sum: true }),
                    col('late', 'Late', 'number', { sum: true }), col('open', 'Open (not due yet)', 'number', { sum: true }), col('overdue', 'Overdue', 'number', { sum: true }), col('rate', 'Compliance rate')];
                return { columns, rows, totals: totalsOf(columns, rows), cards: [{ label: `${R.fmtDay(from, f.settings.dateFormat)} – ${R.fmtDay(to, f.settings.dateFormat)}`, value: `${all.due} due` }, { label: 'Compliance rate', value: all.judged ? `${Math.round(all.onTime / all.judged * 100)}%` : '—' }] };
            } },
        { key: 'data-pending', cat: 'data', title: 'Pending Data Collection', info: 'Periods whose data is not collected yet, with the day it is expected by', need: [REP], filters: { country: 1, client: 1 },
            note: 'Expected by = the last reminder\'s day (else the due date); late once that day has passed on the client\'s calendar. "Partially collected" needs a list of the documents of each obligation, which the module does not keep.',
            run: async f => {
                const nm = await team(f), at = now();
                const list = (await openRows(f)).filter(r => r.stage === 'OPEN');
                let late = 0;
                const rows = list.map(r => {
                    const by = r.view.reminders.reduce((m, x) => (x.date > m ? x.date : m), '') || r.dueDate, lateBy = R.daysBetween(by, R.dayIn(r.client.timeZone, at));
                    if (lateBy > 0) late++;
                    return { dueDate: r.dueDate, client: cl(r.client), country: countryName(r.client.country), obligation: r.obligation.name, period: R.periodName(r), expectedBy: by, late: lateBy > 0 ? lateBy : null,
                        sent: r.view.reminders.reduce((m, x) => m + (x.sentCount || 0), 0), assignedTo: who(nm, r.assignedToId), _link: { period: [r.obligation.id, r.id] } };
                }).sort((a, b) => (a.expectedBy < b.expectedBy ? -1 : 1));
                return { columns: [col('expectedBy', 'Expected by', 'day'), col('client', 'Client'), col('country', 'Country'), col('obligation', 'Obligation'), col('period', 'Period'), col('dueDate', 'Due date', 'day'),
                    col('late', 'Days late', 'number'), col('sent', 'Reminders sent', 'number'), col('assignedTo', 'Assigned to')], rows, cards: [{ label: 'Pending', value: rows.length }, { label: 'Late', value: late }] };
            } },
        { key: 'data-completed', cat: 'data', title: 'Completed Data Collection', info: 'Periods whose data was collected in the dates chosen', need: [REP], filters: { range: 'collection date', country: 1, client: 1 },
            run: async f => {
                const list = await prisma.cmpOccurrence.findMany({ where: { tenantId: f.tenantId, obligation: liveOb(f), dataCollectedOn: days(f) || { not: null }, ...(f.clientId ? { clientId: f.clientId } : {}) }, take: TAKE, orderBy: { dataCollectedOn: 'desc' },
                    select: { id: true, seq: true, periodStart: true, periodEnd: true, dueDate: true, dataCollectedOn: true, dataCollectedBy: true, dataNote: true, obligation: { select: { id: true, name: true, client: { select: { id: true, code: true, name: true, country: true } } } } } });
                return { columns: [col('collectedOn', 'Collected on', 'day'), col('client', 'Client'), col('country', 'Country'), col('obligation', 'Obligation'), col('period', 'Period'), col('dueDate', 'Due date', 'day'),
                    col('before', 'Days before the due date', 'number'), col('by', 'Marked by'), col('note', 'Note')],
                    rows: list.map(o => ({ collectedOn: ymd(o.dataCollectedOn), client: cl(o.obligation.client), country: countryName(o.obligation.client.country), obligation: o.obligation.name, period: R.periodName(o), dueDate: ymd(o.dueDate),
                        before: R.daysBetween(ymd(o.dataCollectedOn), ymd(o.dueDate)), by: o.dataCollectedBy || '', note: o.dataNote || '', _link: { period: [o.obligation.id, o.id] } })) };
            } },
        { key: 'tasks-pending', cat: 'tasks', title: 'Pending Tasks', info: 'Tasks open (data collected, not completed)', need: [REP], filters: { country: 1, client: 1 },
            note: 'A task is an obligation\'s work: open once its data is collected, until it is marked done.',
            run: async f => {
                const nm = await team(f), list = (await openRows(f)).filter(taskOpen).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
                return { columns: [...occCols('Days left').slice(0, 5), col('dataCollectedOn', 'Data collected', 'day'), col('days', 'Days left', 'number'), col('assignedTo', 'Assigned to')],
                    rows: list.map(r => ({ ...occRow(r, nm), dataCollectedOn: r.dataCollectedOn })), cards: [{ label: 'Pending', value: list.length }, { label: 'Due today', value: list.filter(r => r.view.daysLeft === 0).length }, { label: 'Overdue', value: list.filter(r => r.view.overdue).length }] };
            } },
        { key: 'tasks-completed', cat: 'tasks', title: 'Completed Tasks', info: 'Tasks completed in the dates chosen, on time or late', need: [REP], filters: { range: 'completion date', country: 1, client: 1 },
            run: async f => DEFS.find(d => d.key === 'obligations-completed').run(f) },
        { key: 'tasks-overdue', cat: 'tasks', title: 'Overdue Tasks', info: 'Open tasks whose due date has passed', need: [REP], filters: { country: 1, client: 1 },
            note: 'Open tasks (data collected) past the due date. Periods still waiting for their data are in Pending Data Collection.',
            run: async f => {
                const nm = await team(f), list = (await openRows(f)).filter(r => taskOpen(r) && r.view.overdue).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
                return { columns: [...occCols('Days overdue').slice(0, 5), col('dataCollectedOn', 'Data collected', 'day'), col('days', 'Days overdue', 'number'), col('assignedTo', 'Assigned to')],
                    rows: list.map(r => ({ ...occRow(r, nm, -r.view.daysLeft), dataCollectedOn: r.dataCollectedOn })) };
            } },
        { key: 'tasks-by-staff', cat: 'tasks', title: 'Staff-wise Task Summary', info: 'Tasks pending, due today, overdue and completed, person by person', need: [REP], filters: { range: 'completion date', country: 1 }, run: async f => staffTasks(f) },
        { key: 'staff-clients', cat: 'staff', title: 'Staff-wise Client Allocation', info: 'Each person\'s clients, with their open and overdue obligations', need: [REP], filters: { country: 1 },
            run: async f => {
                const nm = await team(f);
                const [cls, open] = await Promise.all([prisma.cmpClient.findMany({ where: { tenantId: f.tenantId, archivedAt: null, ...(f.country ? { country: f.country } : {}) }, select: { id: true, code: true, name: true, country: true, assignedToId: true }, take: 20000 }), openRows(f)]);
                const ob = new Map(); for (const r of open) { const x = ob.get(r.client.id) || { open: 0, overdue: 0 }; x.open++; if (r.view.overdue) x.overdue++; ob.set(r.client.id, x); }
                const rows = cls.map(c => ({ person: c.assignedToId ? who(nm, c.assignedToId) : 'Nobody', client: cl(c), country: countryName(c.country), open: (ob.get(c.id) || {}).open || 0, overdue: (ob.get(c.id) || {}).overdue || 0, _link: { client: c.id } }))
                    .sort((a, b) => a.person.localeCompare(b.person) || a.client.localeCompare(b.client));
                const columns = [col('person', 'Person'), col('client', 'Client'), col('country', 'Country'), col('open', 'Open obligations', 'number', { sum: true }), col('overdue', 'Overdue', 'number', { sum: true })];
                return { columns, rows, totals: totalsOf(columns, rows, ['client', 'clients']) };
            } },
        { key: 'staff-obligations', cat: 'staff', title: 'Staff-wise Obligation Summary', info: 'Obligations open, overdue, due soon and completed, person by person', need: [REP], filters: { range: 'completion date', days: 1, country: 1 },
            note: 'An obligation counts for its own person, else its client\'s ("Nobody" when neither has one).',
            run: async f => {
                const nm = await team(f), [open, done] = await Promise.all([openRows(f), completedIn(f)]);
                const by = new Map(), get = k => { if (!by.has(k)) by.set(k, { person: k ? who(nm, k) : 'Nobody', open: 0, overdue: 0, soon: 0, completed: 0 }); return by.get(k); };
                for (const r of open) { const x = get(r.assignedToId || ''); x.open++; if (r.view.overdue) x.overdue++; else if (r.view.daysLeft <= f.days) x.soon++; }
                for (const o of done) get(o.obligation.assignedToId || o.obligation.client.assignedToId || '').completed++;
                const rows = [...by.values()].sort((a, b) => b.open - a.open || a.person.localeCompare(b.person));
                const columns = [col('person', 'Person'), col('open', 'Open', 'number', { sum: true }), col('overdue', 'Overdue', 'number', { sum: true }), col('soon', `Due in ${f.days} days`, 'number', { sum: true }), col('completed', f.from || f.to ? 'Completed in the dates' : 'Completed (all time)', 'number', { sum: true })];
                return { columns, rows, totals: totalsOf(columns, rows, ['person', 'people']) };
            } },
        { key: 'staff-tasks', cat: 'staff', title: 'Staff-wise Task Summary', info: 'Tasks pending, due today, overdue and completed, person by person', need: [REP], filters: { range: 'completion date', country: 1 }, run: async f => staffTasks(f) },
        { key: 'staff-workload', cat: 'staff', title: 'Staff Workload Summary', info: 'What each person has on hand: clients, obligations, data to collect, tasks, reminders to send', need: [REP], filters: { country: 1 },
            note: 'Reminders to send: due, or not sent after their day. An obligation counts for its own person, else its client\'s.',
            run: async f => {
                const nm = await team(f), [cls, open] = await Promise.all([prisma.cmpClient.findMany({ where: { tenantId: f.tenantId, archivedAt: null, ...(f.country ? { country: f.country } : {}) }, select: { assignedToId: true }, take: 20000 }), openRows(f)]);
                const by = new Map(), get = k => { if (!by.has(k)) by.set(k, { person: k ? who(nm, k) : 'Nobody', clients: 0, open: 0, overdue: 0, week: 0, data: 0, tasks: 0, reminders: 0 }); return by.get(k); };
                for (const c of cls) get(c.assignedToId || '').clients++;
                for (const r of open) {
                    const x = get(r.assignedToId || ''); x.open++; if (r.view.overdue) x.overdue++; else if (r.view.daysLeft <= 7) x.week++;
                    if (r.stage === 'OPEN') x.data++; else x.tasks++;
                    x.reminders += r.view.reminders.filter(m => m.state === 'HIGHLIGHTED' || m.state === 'MISSED').length;
                }
                const rows = [...by.values()].sort((a, b) => b.open - a.open || a.person.localeCompare(b.person));
                const columns = [col('person', 'Person'), col('clients', 'Clients', 'number', { sum: true }), col('open', 'Open obligations', 'number', { sum: true }), col('overdue', 'Overdue', 'number', { sum: true }), col('week', 'Due in 7 days', 'number', { sum: true }),
                    col('data', 'Data to collect', 'number', { sum: true }), col('tasks', 'Tasks open', 'number', { sum: true }), col('reminders', 'Reminders to send', 'number', { sum: true })];
                return { columns, rows, totals: totalsOf(columns, rows, ['person', 'people']) };
            } },
    ];
    const UNDONE = ['cmp.receipt.void', 'cmp.advance.void'];

    /* ---------- shared pieces of several reports ---------- */
    // the receipts that count: not void, and not money refunded or kept as credit when their invoice was cancelled
    async function liveReceipts(f) {
        const dw = days(f);
        return prisma.cmpReceipt.findMany({ where: { tenantId: f.tenantId, voidedAt: null, settlement: '', ...(f.clientId ? { clientId: f.clientId } : {}), ...(f.country ? { invoice: { client: { country: f.country } } } : {}), ...(dw ? { receivedOn: dw } : {}) },
            orderBy: [{ receivedOn: 'asc' }, { seqNo: 'asc' }], take: TAKE, include: { invoice: { select: { id: true, number: true, currency: true, status: true, total: true, received: true, advanceAdjusted: true, client: CLIENT_SEL } } } });
    }
    // each tax (name and rate) with the taxable amount of the invoices it was on, and its amount; invoices with no tax on a line of their own
    async function taxTable(f, { withType }) {
        const conf = withType ? await prisma.cmpTaxRate.findMany({ where: { tenantId: f.tenantId }, select: { name: true, rate: true, type: true } }) : [];
        const g = new Map();
        for (const i of await issuedInvoices(f, { taxes: true })) {
            const base = toMinor(taxableOf(i), i.currency);
            for (const t of i.taxes.length ? i.taxes : [null]) {
                const k = `${t ? `${t.name.toLowerCase()}|${Number(t.rate)}` : '~'}|${i.currency}`;
                const x = g.get(k) || { tax: t ? t.name : 'No tax', rate: t ? Number(t.rate) : null, currency: i.currency, invoices: 0, b: 0, a: 0 };
                x.invoices++; x.b += base; x.a += t ? toMinor(t.amount, i.currency) : 0; g.set(k, x);
            }
        }
        const typeOf = x => (conf.find(c => c.name.toLowerCase() === x.tax.toLowerCase() && Number(c.rate) === x.rate) || {}).type || '';
        const columns = [col('tax', 'Tax'), ...(withType ? [col('type', 'Type')] : []), col('rate', 'Rate (%)', 'number'), col('invoices', 'Invoices', 'number'), col('taxable', 'Taxable amount', 'money', { noSum: true }), col('amount', 'Tax amount', 'money')];
        const rows = [...g.values()].sort((a, b) => a.tax.localeCompare(b.tax) || (a.rate || 0) - (b.rate || 0)).map(x => ({ tax: x.tax, type: withType ? typeOf(x) : undefined, rate: x.rate, currency: x.currency, invoices: x.invoices, taxable: toMajor(x.b, x.currency), amount: toMajor(x.a, x.currency) }));
        return { columns, rows, totals: totalsOf(columns, rows, ['tax', 'taxes']) };
    }
    // how often each template was used (messages marked "not sent" counted apart), with the last use and the channels
    async function templateUsage(f, { kind }) {
        const mw = moments(f);
        const [msgs, tpls] = await Promise.all([
            prisma.cmpMessage.findMany({ where: { tenantId: f.tenantId, ...(kind ? { kind } : {}), ...(mw ? { createdAt: mw } : {}), ...ofClient(f) }, take: TAKE * 4, select: { templateId: true, templateName: true, kind: true, channel: true, createdAt: true, voidedAt: true } }),
            prisma.cmpTemplate.findMany({ where: { tenantId: f.tenantId, ...(kind === 'REMINDER' ? { purpose: { startsWith: 'REMINDER' } } : {}) } }),
        ]);
        const g = new Map();
        const slot = (k, name, type) => { if (!g.has(k)) g.set(k, { template: name, type, uses: 0, voided: 0, last: null, ch: {} }); return g.get(k); };
        for (const t of tpls) if (t.active || !kind) slot('t:' + t.id, t.name, purposeLabel(t.purpose)).status = t.active ? 'Active' : 'Retired';
        for (const m of msgs) {
            const t = m.templateId && tpls.find(x => x.id === m.templateId);
            const x = t ? slot('t:' + t.id, t.name, purposeLabel(t.purpose)) : slot('n:' + (m.templateName || '-'), m.templateName || '(no template: typed by hand)', `${MESSAGE_KINDS[m.kind] || m.kind}${m.templateId ? ' (template deleted)' : ''}`);
            if (t && !x.status) x.status = t.active ? 'Active' : 'Retired';
            if (m.voidedAt) { x.voided++; continue; }
            x.uses++; x.ch[m.channel] = (x.ch[m.channel] || 0) + 1;
            if (!x.last || m.createdAt > x.last) x.last = m.createdAt;
        }
        const columns = [col('template', 'Template'), col('type', 'Type'), col('uses', 'Number of uses', 'number', { sum: true }), col('voided', 'Marked not sent', 'number', { sum: true }), col('last', 'Last used', 'at'), col('channels', 'Channel'), col('status', 'Status')];
        const rows = [...g.values()].sort((a, b) => b.uses - a.uses || a.template.localeCompare(b.template)).map(x => ({ template: x.template, type: x.type, uses: x.uses, voided: x.voided, last: x.last,
            channels: Object.entries(x.ch).map(([c, n]) => `${CHANNELS[c] || c} ${n}`).join(', '), status: x.status || '' }));
        return { columns, rows, totals: totalsOf(columns, rows, ['template', 'templates']) };
    }
    // the activity-log entries of one kind (added, changed, deleted) as records: module, record, when, who
    async function recordsBy(f, keep) {
        const list = (await logs(f)).filter(keep);
        const nm = await names(f, list);
        return { columns: [col('module', 'Module'), col('record', 'Record'), col('action', 'Action'), col('at', 'Date / time', 'at'), col('user', 'User'), col('details', 'Details', 'text', { wide: true })],
            rows: list.map(l => ({ module: moduleOf(l.action), record: nm.record(l) || nm.client(l), action: actionLabel(l.action), at: l.createdAt, user: l.userEmail, details: l.summary })) };
    }

    const BY_KEY = new Map(DEFS.map(d => [d.key, d]));
    const allowed = (def, perms) => def.need.every(group => group.some(p => perms.has(p)));
    function check(def, perms) {
        const missing = def.need.find(group => !group.some(p => perms.has(p)));
        if (missing) throw new CmpError(403, `You do not have permission to ${NO_PERM[missing[0]] || 'see this report'}. Ask the ETAX administrator.`);
    }
    const meta = d => ({ key: d.key, title: d.title, info: d.info, filters: d.filters || {}, money: d.need.some(g => g.includes('INVOICE')), history: d.need.some(g => g.includes('LOGS')) });

    // the categories and reports this user may open
    function list(ctx) {
        return { categories: CATEGORIES.map(([id, title]) => ({ id, title, reports: DEFS.filter(d => d.cat === id && allowed(d, ctx.perms)).map(meta) })).filter(c => c.reports.length) };
    }
    // one report, with the filters asked for (q: from, to, country, clientId, days, status, group, module, user)
    async function run(ctx, key, q = {}) {
        const def = BY_KEY.get(String(key || ''));
        if (!def) throw new CmpError(404, 'Unknown report.');
        check(def, ctx.perms);
        const f = await filtersOf(ctx, def, q);
        const out = await def.run(f);
        const columns = [...out.columns];
        // money reports carry the currency as its own column in the download (on the screen it is written with each amount)
        if (columns.some(c => c.type === 'money') && !columns.some(c => c.key === 'currency')) columns.splice(columns.findIndex(c => c.type === 'money'), 0, col('currency', 'Currency', 'text', { csvOnly: true }));
        const rows = out.rows.map(r => { const { _skip, ...rest } = r; return _skip ? { ...rest, _void: true } : rest; });
        const cat = CATEGORIES.find(c => c[0] === def.cat);
        return { key: def.key, category: cat ? cat[1] : '', title: def.title, info: def.info, columns, rows, totals: out.totals || [], cards: out.cards || [], note: [def.note, out.note].filter(Boolean).join(' '),
            filters: { from: f.from, to: f.to, country: f.country || '', clientId: f.clientId || '', days: f.days, status: f.status, group: f.group }, timeZone: f.tz, today: f.today, truncated: out.rows.length >= TAKE };
    }
    // the same report as a spreadsheet (CSV, opens in Excel): its columns, then its totals
    async function exportCsv(ctx, key, q, res) {
        const d = await run(ctx, key, q);
        const cols = d.columns.filter(c => !c.screenOnly);
        const cell = (c, row) => {
            const v = row[c.key];
            if (v === null || v === undefined || v === '') return '';
            if (c.type === 'money') return Number(v).toFixed(decimals(row[c.cur || 'currency']));
            if (c.type === 'number') return String(v);
            if (c.type === 'at') return csvText(R.fmtAt(new Date(v), d.timeZone));
            if (c.type === 'day') return R.ymdOf(v);
            return csvText(v);
        };
        const lines = [cols.map(c => csvText(c.type === 'at' ? `${c.label} (${C.zoneCity(d.timeZone)})` : c.label)).join(','), ...d.rows.map(r => cols.map(c => cell(c, r)).join(','))];
        if (d.totals.length) {
            lines.push('');
            for (const t of d.totals) lines.push(cols.map((c, i) => (i === 0 ? csvText(t.label) : c.key in t && c.key !== 'currency' ? cell(c, t) : c.key === 'currency' ? csvText(t.currency || '') : '')).join(','));
        }
        await audit(ctx.req, { tenantId: ctx.tenantId, action: 'cmp.export.report', entityType: 'Export', summary: `Report "${d.title}" (${d.category}) downloaded (${d.rows.length} rows)`, details: { report: d.key, from: d.filters.from, to: d.filters.to } });
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="compliance-${d.key}-${d.today}.csv"` });
        return res.send('﻿' + lines.join('\r\n') + '\r\n');
    }

    function registerRoutes({ route, can, NO_PERM: np }) {
        if (np) NO_PERM = { ...NO_PERM_DEFAULT, ...np };
        route('get', '/api/cmp/catalog', can(...ROUTE_PERMS['GET /api/cmp/catalog']), (req, ctx) => list(ctx));
        route('get', '/api/cmp/catalog/:key', can(...ROUTE_PERMS['GET /api/cmp/catalog/:key']), (req, ctx) => run(ctx, req.params.key, req.query));
        // a download needs the export permission AND the report's own (see the notifications and reports, plus money or logs)
        route('get', '/api/cmp/catalog/:key/export', can(...ROUTE_PERMS['GET /api/cmp/catalog/:key/export']), (req, ctx, res) => exportCsv(ctx, req.params.key, req.query, res));
    }

    return { registerRoutes, run, list, exportCsv, keys: () => DEFS.map(d => d.key) };
}

module.exports = { createReportsCatalog, ROUTE_PERMS };
