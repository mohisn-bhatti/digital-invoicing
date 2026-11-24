// Compliance & Deadlines: the in-app notifications (the CA's notification sheet and item 37, 24 Nov 2026).
// - the scheduled ones, made by the background job with a clock the test moves: each on its day at the firm's hour (not before), once;
//   nothing for what is completed or archived; a moved due date gives a new one; billing every 3rd day while it is open
// - the events, for the person assigned (already read for the one who did it)
// - the firm's switches and days; the dashboard's notifications still to come
// - a failure kept with its error and tried again, up to the firm's number of tries
// - through the real server: each user sees their own and the firm-wide ones only
// Needs the local database; makes its own firm and removes it. The dates are in 2031, far from today, so a server running on this
// computer with the real clock never makes any of them. Made-up names only.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');
const R = require('../public/cmp-rules');
const CmpPerms = require('../public/cmp-perms');
const Notify = require('../src/compliance/notify');

const A = createApi('cmpntf');
A.models = ['cmpNotification', 'cmpMessage', 'cmpReceipt', 'cmpInvoice', 'cmpAdvance', 'cmpCredit', 'cmpTaxRate', 'cmpItemPrice', 'cmpItem', 'cmpReminder', 'cmpObligationTemplate',
    'cmpOccurrence', 'cmpObligation', 'cmpFieldValue', 'cmpFieldDef', 'cmpTemplate', 'cmpClient', 'cmpSettings', 'cmpInvoiceType'];
const run = A.run;
const W = {};
const TZ = 'Asia/Dubai';
const at = (day, hh, mm = 0) => R.zoned(day, hh, mm, TZ);
let clock = new Date();
const SCHEDULED = ['REMINDER', 'REMINDER_MISSED', 'DUE_DATE', 'AFTER_DUE', 'DATA_MIDPOINT', 'TASK_MIDPOINT', 'INVOICE_PENDING', 'ISSUE_PENDING', 'RECEIPT_PENDING'];
const rowsOf = where => A.prisma.cmpNotification.findMany({ where: { tenantId: A.tenantId, ...where }, orderBy: [{ forDay: 'asc' }, { key: 'asc' }] });
const daysOf = (rows, kind) => rows.filter(r => r.kind === kind).map(r => R.ymdOf(r.forDay));
const ctxOf = (key, perms) => ({ tenantId: A.tenantId, userId: W.ids[key], email: A[key].email, req: null, perms: CmpPerms.effective(perms) });
const sweep = () => W.svc.notify.run({ tenantId: A.tenantId });
const runLong = (name, fn) => test(name, { timeout: 120000 }, async t => { if (!A.ok) return t.skip('no local database'); await fn(t); });

test('notifications: start a server, a firm with the module, its people, clients and obligations', { timeout: 90000 }, async t => {
    if (!(await A.setup(t, { modules: ['COMPLIANCE'] }))) return;
    const perms = { owner: ['FULL'], manager: ['VIEW', 'OBLIGATION_EDIT', 'COMPLETE', 'REPORTS'], cashier: ['VIEW', 'INVOICE'] }; // (the manager sees no money)
    for (const [k, p] of Object.entries(perms)) await A.prisma.user.update({ where: { email: A[k].email }, data: { cmpPerms: p } });
    W.ids = Object.fromEntries(await Promise.all(['owner', 'manager', 'cashier'].map(async k => [k, (await A.prisma.user.findUnique({ where: { email: A[k].email } })).id])));
    W.ctx = ctxOf('owner', perms.owner); W.mgr = ctxOf('manager', perms.manager); W.csh = ctxOf('cashier', perms.cashier);
    await A.prisma.cmpSettings.upsert({ where: { tenantId: A.tenantId }, create: { tenantId: A.tenantId, timeZone: TZ, notifyHour: 9 }, update: { timeZone: TZ, notifyHour: 9 } });
    const { createCompliance } = require('../src/compliance');
    const { createAudit } = require('../src/audit');
    const { encrypt, decrypt } = require('../src/crypto');
    W.parts = { prisma: A.prisma, audit: createAudit(A.prisma), encrypt, decrypt, now: () => clock };
    W.svc = createCompliance(W.parts);
    clock = at('2031-01-10', 10);
    // a client looked after by the manager, and one by nobody
    W.c1 = (await W.svc.clients.create(W.ctx, { country: 'AE', name: 'Palm Grove Trading', contactNumber: '+971501112233', noPortal: true, assignedToId: W.ids.manager })).client;
    W.c2 = (await W.svc.clients.create(W.ctx, { country: 'AE', name: 'Blue Lagoon Foods', contactNumber: '+971501112244', noPortal: true })).client;
    const ob = (client, name, periodEnd, dueDate, extra = {}) => W.svc.obligations.create(W.ctx, client.id, { name, frequency: 'YEARLY', autoNext: false, periodStart: '2031-01-01', periodEnd, dueDate, ...extra });
    const own = offsets => offsets.map(offsetDays => ({ offsetDays, body: 'Dear [Client Name], a reminder about [Obligation] due [Due Date].' }));
    // VAT: three reminders (8, 18 and 25 April), due 28 April; the manager's through the client
    W.o1 = await ob(W.c1, 'VAT Return', '2031-03-31', '2031-04-28', { reminders: own([-20, -10, -3]) });
    // Corporate Tax: no reminders, the cashier's; it will be done and billed
    W.o2 = await ob(W.c2, 'Corporate Tax Return', '2031-03-31', '2031-04-28', { assignedToId: W.ids.cashier });
    // the same dates, archived: never a word about it
    W.o3 = await ob(W.c1, 'Audit Report', '2031-03-31', '2031-04-28', { reminders: own([-20]) });
    await W.svc.obligations.setArchived(W.ctx, W.o3.id, true);
    // nobody's: for everyone in the firm
    W.o4 = await ob(W.c2, 'Zakat Return', '2031-05-31', '2031-06-10');
    W.o6 = await ob(W.c2, 'Payroll Return', '2031-06-30', '2031-07-10');
    W.o7 = await ob(W.c2, 'Excise Return', '2031-07-31', '2031-08-10');
    W.occ = k => W[k].occurrences[0].id;
    assert.ok(W.o1.occurrences && W.o7.occurrences, 'obligations made');
});

run('pure helpers: the defaults are the sheet\'s days; bad input is refused', () => {
    assert.deepStrictEqual(Notify.cleanRules({}), { reminderBefore: 0, dueBefore: [0], afterDue: [1, 3, 7], invoiceEvery: 3, issueEvery: 3, receiptEvery: 3, missedAfter: 1, retryAttempts: 3 });
    assert.deepStrictEqual(Notify.cleanRules({ afterDue: '7, 1, 3, 1', invoiceEvery: '5' }).afterDue, [1, 3, 7]);
    assert.deepStrictEqual(Notify.cleanRules({ dueBefore: [] }).dueBefore, []);
    for (const bad of [{ afterDue: [0] }, { afterDue: ['x'] }, { invoiceEvery: 0 }, { retryAttempts: 11 }, { reminderBefore: 1.5 }, []]) assert.throws(() => Notify.cleanRules(bad), e => e.status === 400, JSON.stringify(bad));
    const p = Notify.cleanPrefs({ invoiceAlerts: false, events: { DUE_DATE: false, SOMETHING_OLD: true } });
    assert.deepStrictEqual([p.inApp, p.taskAlerts, p.invoiceAlerts, p.failedAlerts, p.events.DUE_DATE, p.events.REMINDER, 'SOMETHING_OLD' in p.events], [true, true, false, true, false, true, false]);
    for (const bad of [{ inApp: 'yes' }, { events: [] }, { events: { DUE_DATE: 1 } }, 'on']) assert.throws(() => Notify.cleanPrefs(bad), e => e.status === 400, JSON.stringify(bad));
    assert.deepStrictEqual(Notify.cleanPrefs(null), JSON.parse(JSON.stringify(Notify.DEFAULT_PREFS)));
});

run('an obligation added: the person assigned hears of it, once', async () => {
    await W.svc.notify.event(W.ctx, 'OBLIGATION_CREATED', { obligationId: W.o1.id });
    await W.svc.notify.event(W.ctx, 'OBLIGATION_CREATED', { obligationId: W.o1.id });
    const rows = await rowsOf({ kind: 'OBLIGATION_CREATED', obligationId: W.o1.id });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].userId, W.ids.manager);
    assert.match(rows[0].title, /New obligation: VAT Return — Palm Grove Trading/);
    // nobody assigned: for everyone
    await W.svc.notify.event(W.ctx, 'OBLIGATION_CREATED', { obligationId: W.o4.id });
    assert.strictEqual((await rowsOf({ kind: 'OBLIGATION_CREATED', obligationId: W.o4.id }))[0].userId, null);
    // the dashboard shows what is still to come: the manager's VAT reminders, never the archived one, never the cashier's work
    const d = await W.svc.notify.list(W.mgr, { from: '2031-04-01', to: '2031-05-01' });
    const vat = d.coming.filter(x => x.occurrenceId === W.occ('o1'));
    assert.deepStrictEqual(vat.filter(x => x.kind === 'REMINDER').map(x => x.forDay), ['2031-04-08', '2031-04-18', '2031-04-25']);
    assert.ok(vat.some(x => x.kind === 'DUE_DATE' && x.forDay === '2031-04-28'));
    assert.ok(!d.coming.some(x => x.occurrenceId === W.occ('o3') || x.occurrenceId === W.occ('o2')), 'neither archived nor someone else\'s');
    assert.ok(!d.coming.some(x => x.kind === 'REMINDER_MISSED'), 'a missed reminder is not announced ahead');
});

runLong('a month day by day: each on its day at the firm\'s hour, once; done work, archived work and closed billing say nothing more', async () => {
    const o2 = W.occ('o2');
    for (let day = '2031-04-01'; day <= '2031-05-17'; day = R.addDays(day, 1)) {
        clock = at(day, 8, 30); // before the firm's hour (9:00, Dubai): nothing of today yet
        assert.strictEqual((await sweep()).made, 0, `${day} 08:30`);
        clock = at(day, 9, 30);
        await sweep();
        assert.strictEqual((await sweep()).made, 0, `${day}: made twice`);
        if (day === '2031-04-23') { // the dashboard: today's invoice reminder made; the next one coming, then every 3 days
            const d = await W.svc.notify.list(W.csh, { from: day, to: '2031-05-23' });
            assert.ok(d.made.some(x => x.kind === 'INVOICE_PENDING' && x.occurrenceId === o2 && x.forDay === day));
            assert.deepStrictEqual(d.coming.filter(x => x.kind === 'INVOICE_PENDING' && x.occurrenceId === o2).map(x => [x.forDay, x.repeats]), [['2031-04-26', 3]]);
        }
        clock = at(day, 12);
        if (day === '2031-04-10') {
            await W.svc.obligations.setDataCollected(W.ctx, o2, day);
            await W.svc.notify.event(W.ctx, 'DATA_RECEIVED', { occurrenceId: o2, day });
        }
        if (day === '2031-04-20') {
            await W.svc.obligations.complete(W.ctx, o2, 'TASK', { on: day });
            await W.svc.notify.event(W.ctx, 'TASK_DONE', { occurrenceId: o2, day });
        }
        if (day === '2031-05-06') {
            W.inv = await W.svc.invoices.create(W.ctx, { occurrenceId: o2, currency: 'AED', lines: [{ description: 'Corporate tax return', amount: '1000', occurrenceId: o2 }], taxes: [] });
            await W.svc.notify.event(W.ctx, 'INVOICE_CREATED', { invoiceId: W.inv.id });
            await W.svc.invoices.issue(W.ctx, W.inv.id);
            await W.svc.notify.event(W.ctx, 'INVOICE_ISSUED', { invoiceId: W.inv.id });
        }
        if (day === '2031-05-10') await W.svc.invoices.markSent(W.ctx, W.inv.id);
        if (day === '2031-05-14') {
            W.receipt = (await W.svc.invoices.addReceipt(W.ctx, W.inv.id, { amount: '1000', receivedOn: day, method: 'BANK' })).receiptId;
            await W.svc.notify.event(W.ctx, 'RECEIPT', { receiptId: W.receipt, invoiceId: W.inv.id });
        }
    }
    // VAT: never done, nothing sent: each reminder date, the day after each (not sent), the midpoints while the data is awaited, the due
    // date and 1, 3 and 7 days after it; all for the manager
    const vat = await rowsOf({ occurrenceId: W.occ('o1'), kind: { in: SCHEDULED } });
    assert.deepStrictEqual(daysOf(vat, 'REMINDER'), ['2031-04-08', '2031-04-18', '2031-04-25']);
    assert.deepStrictEqual(daysOf(vat, 'REMINDER_MISSED'), ['2031-04-09', '2031-04-19', '2031-04-26']);
    assert.deepStrictEqual(daysOf(vat, 'DATA_MIDPOINT'), ['2031-04-04', '2031-04-13', '2031-04-21', '2031-04-26']);
    assert.deepStrictEqual(daysOf(vat, 'DUE_DATE'), ['2031-04-28']);
    assert.deepStrictEqual(daysOf(vat, 'AFTER_DUE'), ['2031-04-29', '2031-05-01', '2031-05-05']);
    assert.deepStrictEqual([...new Set(vat.map(r => r.userId))], [W.ids.manager]);
    assert.ok(vat.every(r => r.status === 'DONE' && r.attempts === 1));
    // Corporate Tax: the data came in on 10 April, so its midpoint (14 April) is the task's; done on 20 April: no due date, no overdue;
    // an invoice to create every 3rd day from then until it was issued (6 May); to send every 3rd day until it was sent (10 May); a
    // payment to receive every 3rd day until it was paid in full (14 May)
    const ct = await rowsOf({ occurrenceId: o2, kind: { in: SCHEDULED } });
    assert.deepStrictEqual(daysOf(ct, 'DATA_MIDPOINT'), []);
    assert.deepStrictEqual(daysOf(ct, 'TASK_MIDPOINT'), ['2031-04-14']);
    assert.deepStrictEqual([...daysOf(ct, 'DUE_DATE'), ...daysOf(ct, 'AFTER_DUE')], []);
    assert.deepStrictEqual(daysOf(ct, 'INVOICE_PENDING'), ['2031-04-23', '2031-04-26', '2031-04-29', '2031-05-02', '2031-05-05']);
    assert.deepStrictEqual(daysOf(ct, 'ISSUE_PENDING'), ['2031-05-09']);
    assert.deepStrictEqual(daysOf(ct, 'RECEIPT_PENDING'), ['2031-05-13']);
    assert.ok(ct.every(r => r.userId === W.ids.cashier));
    // archived: nothing scheduled at all (only "new obligation", made when it was added, before it was archived)
    assert.deepStrictEqual((await rowsOf({ obligationId: W.o3.id })).map(r => r.kind).filter(k => k !== 'OBLIGATION_CREATED'), []);
    // the events: for the person assigned, already read by the one who did it
    const ev = await rowsOf({ occurrenceId: o2, kind: { in: ['DATA_RECEIVED', 'TASK_DONE', 'INVOICE_CREATED', 'INVOICE_ISSUED', 'RECEIPT'] } });
    assert.deepStrictEqual(ev.map(r => r.kind).sort(), ['DATA_RECEIVED', 'INVOICE_CREATED', 'INVOICE_ISSUED', 'RECEIPT', 'TASK_DONE']);
    assert.ok(ev.every(r => r.userId === W.ids.cashier && r.readBy.includes(W.ids.owner) && !r.readBy.includes(W.ids.cashier)), JSON.stringify(ev.map(r => [r.kind, r.userId, r.readBy])));
    const inv = await A.prisma.cmpInvoice.findUnique({ where: { id: W.inv.id } });
    assert.match(ev.find(r => r.kind === 'INVOICE_ISSUED').title, new RegExp(`Invoice issued: ${inv.number} — Blue Lagoon Foods`));
    assert.match(ev.find(r => r.kind === 'RECEIPT').body, /AED 1,000\.00 received .* Paid in full\./);
    assert.match(ev.find(r => r.kind === 'DATA_RECEIVED').body, /came in on 10 Apr 2031/);
});

run('a due date moved: the old day says nothing, the new day does (and the dashboard follows)', async () => {
    const o4 = W.occ('o4');
    clock = at('2031-06-03', 12);
    let d = await W.svc.notify.list(W.ctx, { from: '2031-06-03', to: '2031-06-30' });
    assert.ok(d.coming.some(x => x.occurrenceId === o4 && x.kind === 'DUE_DATE' && x.forDay === '2031-06-10'));
    await W.svc.obligations.updateOccurrence(W.ctx, o4, { dueDate: '2031-06-15' });
    d = await W.svc.notify.list(W.ctx, { from: '2031-06-03', to: '2031-06-30' });
    assert.deepStrictEqual(d.coming.filter(x => x.occurrenceId === o4 && x.kind === 'DUE_DATE').map(x => x.forDay), ['2031-06-15']);
    for (const day of ['2031-06-10', '2031-06-15']) { clock = at(day, 9, 30); await sweep(); }
    const rows = await rowsOf({ occurrenceId: o4, kind: 'DUE_DATE' });
    assert.deepStrictEqual(rows.map(r => [R.ymdOf(r.forDay), r.key.split(':')[2], r.userId]), [['2031-06-15', '2031-06-15', null]]);
    // made: not "coming" any more; the manager sees it (it is for everyone), the dashboard of that day lists it
    d = await W.svc.notify.list(W.mgr, { from: '2031-06-15', to: '2031-06-15' });
    assert.ok(d.made.some(x => x.occurrenceId === o4 && x.kind === 'DUE_DATE' && !x.read));
    assert.ok(!d.coming.some(x => x.occurrenceId === o4 && x.kind === 'DUE_DATE'));
});

run('the firm\'s switches and days: a kind switched off is not made; the days after the due date are the firm\'s', async () => {
    const o6 = W.occ('o6');
    await W.svc.notify.putRules(W.ctx, { rules: { afterDue: [2] } });
    await A.prisma.cmpSettings.update({ where: { tenantId: A.tenantId }, data: { notifyPrefs: { events: { DUE_DATE: false } } } });
    for (const day of ['2031-07-10', '2031-07-11', '2031-07-12', '2031-07-13']) { clock = at(day, 9, 30); await sweep(); }
    let rows = await rowsOf({ occurrenceId: o6, kind: { in: SCHEDULED } });
    assert.deepStrictEqual(daysOf(rows, 'DUE_DATE'), []);
    assert.deepStrictEqual(daysOf(rows, 'AFTER_DUE'), ['2031-07-12']);
    const log = await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'cmp.settings.update', summary: { startsWith: 'Notification days' } } });
    assert.match(log.summary, /days after the due date: 1, 3, 7 → 2/);
    // in-app notifications off: no event, nothing scheduled
    await A.prisma.cmpSettings.update({ where: { tenantId: A.tenantId }, data: { notifyPrefs: { inApp: false } } });
    await W.svc.notify.event(W.ctx, 'DATA_RECEIVED', { occurrenceId: o6, day: '2031-07-13' });
    clock = at('2031-07-14', 9, 30);
    assert.strictEqual((await sweep()).made, 0);
    // the money alerts off: no invoice event either
    await A.prisma.cmpSettings.update({ where: { tenantId: A.tenantId }, data: { notifyPrefs: { invoiceAlerts: false } } });
    await W.svc.notify.event(W.ctx, 'INVOICE_ISSUED', { invoiceId: W.inv.id }); // (made once already: still one)
    rows = await rowsOf({ occurrenceId: o6, kind: 'DATA_RECEIVED' });
    assert.strictEqual(rows.length, 0);
    assert.strictEqual((await rowsOf({ kind: 'INVOICE_ISSUED' })).length, 1);
    await A.prisma.cmpSettings.update({ where: { tenantId: A.tenantId }, data: { notifyPrefs: {}, notifyRules: {} } });
});

run('a notification that could not be passed on is kept as failed with its error, and tried again up to the firm\'s number of tries', async () => {
    let down = true;
    const { createNotify } = require('../src/compliance/notify');
    const N = createNotify({ ...W.parts, common: W.svc.common, clients: W.svc.clients, obligations: W.svc.obligations, invoices: W.svc.invoices, comms: W.svc.comms,
        deliver: async () => { if (down) throw new Error('Mail server down'); } });
    const o7 = W.occ('o7'), row = async () => (await rowsOf({ occurrenceId: o7, kind: 'DUE_DATE' }))[0];
    clock = at('2031-08-10', 9, 30);
    assert.strictEqual((await N.run({ tenantId: A.tenantId })).made, 0);
    let r = await row();
    assert.deepStrictEqual([r.status, r.attempts, r.lastError], ['FAILED', 1, 'Mail server down']);
    // not shown to the staff while it has failed (full access sees it, with its error)
    assert.ok(!(await W.svc.notify.list(W.csh, { from: '2031-08-10', to: '2031-08-10' })).made.some(x => x.id === r.id));
    const full = (await W.svc.notify.list(W.ctx, { from: '2031-08-10', to: '2031-08-10' })).made.find(x => x.id === r.id);
    assert.deepStrictEqual([full.status, full.lastError], ['FAILED', 'Mail server down']);
    for (const n of [2, 3]) { clock = at('2031-08-10', 9, 30 + n); await N.run({ tenantId: A.tenantId }); assert.strictEqual((await row()).attempts, n); }
    // three tries (the default) and no more, even once it would work
    down = false;
    await N.run({ tenantId: A.tenantId });
    r = await row();
    assert.deepStrictEqual([r.status, r.attempts], ['FAILED', 3]);
    // the firm allows five: the fourth try goes through
    await W.svc.notify.putRules(W.ctx, { rules: { retryAttempts: 5 } });
    assert.strictEqual((await N.run({ tenantId: A.tenantId })).made, 1);
    r = await row();
    assert.deepStrictEqual([r.status, r.attempts, r.lastError], ['DONE', 4, '']);
    assert.strictEqual((await rowsOf({ occurrenceId: o7, kind: 'DUE_DATE' })).length, 1);
    await A.prisma.cmpSettings.update({ where: { tenantId: A.tenantId }, data: { notifyRules: {} } });
});

run('an obligation deleted: its notifications go', async () => {
    const before = (await rowsOf({ obligationId: W.o6.id })).length;
    assert.ok(before > 0);
    await W.svc.notify.forget(A.tenantId, { obligationId: W.o6.id });
    assert.strictEqual((await rowsOf({ obligationId: W.o6.id })).length, 0);
});

run('API: each user sees their own and the firm-wide notifications (the money ones with the invoice permission), and marks them read', async () => {
    // (start from nothing unread)
    for (const k of ['owner', 'manager', 'cashier']) assert.strictEqual((await A.call('/api/cmp/notify/read', { token: A[k].token, method: 'POST', body: { all: true } })).status, 200);
    const day = '2032-02-02', mk = (key, kind, userId, extra = {}) => A.prisma.cmpNotification.create({ data: { tenantId: A.tenantId, key, kind, userId, title: key, forDay: new Date(day + 'T00:00:00Z'), ...extra } });
    const rows = { mine: await mk('for the manager', 'DUE_DATE', W.ids.manager), theirs: await mk('for the cashier', 'DUE_DATE', W.ids.cashier), all: await mk('for everyone', 'AFTER_DUE', null),
        money: await mk('payment to receive', 'RECEIPT_PENDING', null), failed: await mk('could not be passed on', 'DUE_DATE', null, { status: 'FAILED', lastError: 'Mail server down' }) };
    const seen = async (k, extra = '') => { const r = await A.call(`/api/cmp/notify?from=${day}&to=${day}${extra}`, { token: A[k].token }); assert.strictEqual(r.status, 200, r.text); return r.json.made.map(x => x.title).sort(); };
    assert.deepStrictEqual(await seen('manager'), ['for everyone', 'for the manager']);
    assert.deepStrictEqual(await seen('cashier'), ['for everyone', 'for the cashier', 'payment to receive']);
    assert.deepStrictEqual(await seen('owner'), ['could not be passed on', 'for everyone', 'payment to receive']);
    assert.deepStrictEqual(await seen('owner', '&who=all'), ['could not be passed on', 'for everyone', 'for the cashier', 'for the manager', 'payment to receive']);
    assert.deepStrictEqual(await seen('manager', '&who=all'), ['for everyone', 'for the manager'], 'only full access sees everyone\'s');
    const count = async k => (await A.call('/api/cmp/notify/count', { token: A[k].token })).json.unread;
    assert.deepStrictEqual([await count('manager'), await count('cashier')], [2, 3]);
    // read by the manager: not by the cashier; someone else's cannot be marked
    let r = await A.call('/api/cmp/notify/read', { token: A.manager.token, method: 'POST', body: { ids: [rows.all.id, rows.theirs.id] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.marked, r.json.unread], [1, 1]);
    assert.strictEqual(await count('cashier'), 3);
    assert.deepStrictEqual((await A.prisma.cmpNotification.findUnique({ where: { id: rows.theirs.id } })).readBy, []);
    // the trigger days: everyone may read them, only full access changes them
    r = await A.call('/api/cmp/notify/rules', { token: A.manager.token });
    assert.deepStrictEqual([r.status, r.json.canEdit, r.json.rules.afterDue], [200, false, [1, 3, 7]]);
    assert.strictEqual((await A.call('/api/cmp/notify/rules', { token: A.manager.token, method: 'PUT', body: { rules: { afterDue: [2] } } })).status, 403);
    assert.strictEqual((await A.call('/api/cmp/notify/rules', { token: A.owner.token, method: 'PUT', body: { rules: { afterDue: [0] } } })).status, 400);
    r = await A.call('/api/cmp/notify/rules', { token: A.owner.token, method: 'PUT', body: { rules: { afterDue: '2, 4', invoiceEvery: 5 } } });
    assert.deepStrictEqual([r.status, r.json.rules.afterDue, r.json.rules.invoiceEvery, r.json.canEdit], [200, [2, 4], 5, true]);
    assert.strictEqual((await A.call('/api/cmp/notify?from=2032-01-01&to=2033-06-01', { token: A.owner.token })).status, 400, 'at most a year at a time');
    assert.strictEqual((await A.call('/api/cmp/notify/count')).status, 401);
});

test('notifications: clean up', async () => {
    await new Promise(r => setTimeout(r, 500)); // (the notifications the services sent without waiting)
    await A.teardown();
});
