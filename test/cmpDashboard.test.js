// Compliance & Deadlines: the Dashboard (the CA's "Comprehensive Dashboard" SRS, 24 Nov 2026), through the real server.
// - the ten figures, the upcoming and overdue tables, the reminders (sent, marked not sent, missed, scheduled), the stages, data
//   collection and tasks, the money per currency, the activity, the alerts, by country and by person, and the calendar
// - the filters apply to every part; the money and the activity only for those who may see them
// - it writes nothing: no row in any table, not even in the activity log
// Needs the local database; makes its own firm and removes it. Made-up names only.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');
const R = require('../public/cmp-rules');

const A = createApi('cmpdash');
A.models = ['cmpNotification', 'cmpMessage', 'cmpReceipt', 'cmpInvoice', 'cmpAdvance', 'cmpCredit', 'cmpTaxRate', 'cmpItemPrice', 'cmpItem', 'cmpObligationTemplate', 'cmpReminder', 'cmpOccurrence', 'cmpObligation', 'cmpFieldValue', 'cmpFieldDef', 'cmpTemplate', 'cmpClient', 'cmpSettings', 'cmpInvoiceType'];
const run = A.run;
const W = {};
const today = R.dayIn('Asia/Dubai');
const day = n => R.addDays(today, n);
const call = (url, method = 'GET', body, token) => A.call(url, { token: token || A.owner.token, method, body });
const ok = async (p, what = '') => { const r = await p; assert.strictEqual(r.status, 200, `${what} ${r.text}`); return r.json; };
const dash = (q = {}, token) => ok(call('/api/cmp/overview?' + new URLSearchParams(q), 'GET', undefined, token), 'overview');

test('dashboard API: start a server, a firm with clients in two countries and work in every state', { timeout: 120000 }, async t => {
    if (!(await A.setup(t, { modules: ['COMPLIANCE'] }))) return;
    await A.prisma.user.update({ where: { email: A.owner.email }, data: { cmpPerms: ['FULL'] } });
    await A.prisma.user.update({ where: { email: A.manager.email }, data: { cmpPerms: ['VIEW', 'REPORTS', 'WHATSAPP', 'COMPLETE'] } });
    W.manager = (await A.prisma.user.findUnique({ where: { email: A.manager.email } })).id;
    await ok(call('/api/cmp/settings', 'PUT', { reminderHour: 0 }));
    await ok(call('/api/cmp/fields', 'POST', { name: 'Trade Licence', countries: ['AE'] }));
    W.ae = (await ok(call('/api/cmp/clients', 'POST', { country: 'AE', name: 'Harbour Lane Trading', contactNumber: '+971501113344', portalUsername: 'u', portalPassword: 'p', assignedToId: W.manager }))).client;
    W.sa = (await ok(call('/api/cmp/clients', 'POST', { country: 'SA', name: 'Oasis Point Supplies', contactNumber: '+966501113344', noPortal: true }))).client;
    const tpl = await ok(call('/api/cmp/templates', 'POST', { name: 'First', purpose: 'REMINDER_1', body: '[Obligation] due [Due Date]' }));
    const tpl2 = await ok(call('/api/cmp/templates', 'POST', { name: 'Second', purpose: 'REMINDER_2', body: '[Obligation] soon' }));
    const it = (name, due, extra = {}) => ({ name, periodStart: R.addDays(due, -90), periodEnd: R.addDays(due, -30), dueDate: due, autoNext: false, ...extra });
    const obs = (await ok(call(`/api/cmp/clients/${W.ae.id}/obligations`, 'POST', { frequency: 'YEARLY', items: [
        it('VAT Return Q1', day(10), { reminders: [{ offsetDays: -10, templateId: tpl.id }, { offsetDays: -3, templateId: tpl2.id }] }),
        it('VAT Return Q2', day(-5), { reminders: [{ offsetDays: -10, templateId: tpl.id }] }),
        it('Corporate Tax', day(-1), {}),
    ] }), 'obligations')).obligations;
    [W.q1, W.q2, W.ct] = obs;
    W.sat = (await ok(call(`/api/cmp/clients/${W.sa.id}/obligations`, 'POST', { frequency: 'YEARLY', items: [it('Zakat Return', day(40))] }))).obligations[0];
    const occ = o => o.occurrences[0].id;
    // the 1st reminder of Q1: sent, marked not sent, sent again
    const send = () => ok(call('/api/cmp/messages', 'POST', { kind: 'REMINDER', occurrenceId: occ(W.q1), reminderId: W.q1.reminders[0].id, body: 'Hello', phone: '+971501113344' }), 'send');
    await send();
    await ok(call('/api/cmp/messages/void-last', 'POST', { occurrenceId: occ(W.q1), reminderId: W.q1.reminders[0].id }));
    W.afterVoid = await dash();
    await send();
    // Q2 (overdue): its data is in, the task is open; Corporate Tax: data in and the task done today
    await ok(call(`/api/cmp/occurrences/${occ(W.q2)}/data`, 'POST', { on: day(-2) }));
    await ok(call(`/api/cmp/occurrences/${occ(W.ct)}/data`, 'POST', { on: day(-1) }));
    await ok(call(`/api/cmp/occurrences/${occ(W.ct)}/complete`, 'POST', { mode: 'TASK', on: today }));
    // money: an advance of 300, an invoice of 1000 with 200 of the advance taken off, a receipt of 300 (AED); an unpaid SAR invoice of 100
    await ok(call('/api/cmp/advances', 'POST', { clientId: W.ae.id, amount: '300', description: 'Advance', receivedOn: today }));
    const adv = (await ok(call(`/api/cmp/advances?clientId=${W.ae.id}`)))[0];
    const inv = await ok(call('/api/cmp/invoices', 'POST', { occurrenceId: occ(W.ct) }));
    await ok(call(`/api/cmp/invoices/${inv.id}`, 'PUT', { currency: 'AED', lines: [{ description: 'Corporate tax return', amount: '1000', occurrenceId: occ(W.ct) }], taxes: [], advances: [{ advanceId: adv.id, amount: '200' }], issueDate: today }));
    await ok(call(`/api/cmp/invoices/${inv.id}/issue`, 'POST'));
    await ok(call(`/api/cmp/invoices/${inv.id}/receipts`, 'POST', { amount: '300' }));
    const sar = await ok(call('/api/cmp/invoices', 'POST', { clientId: W.sa.id }));
    await ok(call(`/api/cmp/invoices/${sar.id}`, 'PUT', { currency: 'SAR', lines: [{ description: 'Zakat', amount: '100' }], taxes: [], issueDate: today }));
    await ok(call(`/api/cmp/invoices/${sar.id}/issue`, 'POST'));
    W.inv = inv;
});

run('a reminder marked "not sent" is one to send; sent again, it counts as sent (the user checks WhatsApp by hand)', async () => {
    const r = W.afterVoid.reminders.rows.find(x => x.occurrence.obligation.name === 'VAT Return Q1' && x.n === 1);
    assert.deepStrictEqual([r.status, r.sends, r.voided], ['MARKED_NOT_SENT', 0, 1]);
    const d = await dash(), r2 = d.reminders.rows.find(x => x.occurrence.obligation.name === 'VAT Return Q1' && x.n === 1);
    assert.deepStrictEqual([r2.status, r2.sends, r2.voided, r2.channel], ['SENT', 1, 1, 'WHATSAPP']);
    assert.deepStrictEqual(d.reminders.inPeriod, { sent: 1, otherWay: 0, markedNotSent: 1 }); // (two sends: the first marked not sent)
});

run('the ten figures, the tables, the stages, data collection and tasks', async () => {
    const d = await dash({ days: 30 });
    assert.deepStrictEqual(d.kpis, { activeClients: 2, missingInfo: 1, open: 3, overdue: 1, upcoming: 1, remindersDue: 1, dataPending: 2, taskPending: 1 });
    assert.deepStrictEqual(d.upcoming.rows.map(r => r.obligation.name), ['VAT Return Q1']);
    assert.deepStrictEqual(d.upcoming.rows[0].reminders.map(x => x.button), ['SENT', 'WAIT']);
    assert.deepStrictEqual([d.overdue.rows[0].obligation.name, d.overdue.rows[0].daysOverdue, d.overdue.rows[0].lastReminder.status], ['VAT Return Q2', 5, 'NOT_SENT']);
    assert.strictEqual((await dash({ days: 60 })).kpis.upcoming, 2, 'Zakat (in 40 days) with a 60-day window');
    assert.deepStrictEqual(d.reminders.counts, { DUE: 0, MISSED: 1, MARKED_NOT_SENT: 0, SCHEDULED: 1, SENT: 1, OTHER_WAY: 0, NOT_NEEDED: 0 });
    assert.deepStrictEqual([d.workflow.OPEN, d.workflow.OVERDUE, d.workflow.DATA_PENDING, d.workflow.DATA_COLLECTED, d.workflow.COMPLETED, d.workflow.CONFIRM], [3, 1, 2, 1, 1, 0]);
    assert.deepStrictEqual([d.data.pending, d.data.late], [2, 0]);
    assert.deepStrictEqual([d.tasks.pending, d.tasks.overdue, d.tasks.completed, d.tasks.completedRows[0].obligation.name], [1, 1, 1, 'Corporate Tax']);
    assert.ok(d.alerts.some(a => a.key === 'OVERDUE' && a.count === 1) && d.alerts.some(a => a.key === 'MISSED') && d.alerts.some(a => a.key === 'MISSING'), JSON.stringify(d.alerts));
    assert.deepStrictEqual(d.byCountry.map(c => [c.key, c.clients, c.open]), [['AE', 1, 2], ['SA', 1, 1]]);
    assert.ok(d.byPerson.some(p => p.key === W.manager && p.open === 2 && p.clients === 1), JSON.stringify(d.byPerson));
});

run('the money per currency: advances received, adjusted, unallocated; invoiced, net, outstanding; receipts', async () => {
    const d = await dash({ preset: 'month' }), aed = d.finance.currencies.find(x => x.currency === 'AED'), sar = d.finance.currencies.find(x => x.currency === 'SAR');
    assert.deepStrictEqual(aed.advances, { received: 300, receivedCount: 1, adjusted: 200, unallocated: 100, count: 1 });
    assert.deepStrictEqual(aed.invoices, { invoiced: 1000, net: 800, outstanding: 500, unpaid: 1 });
    assert.deepStrictEqual([aed.receipts.total, aed.receipts.count, aed.receipts.methods.BANK], [300, 1, 300]);
    assert.deepStrictEqual(sar.invoices, { invoiced: 100, net: 100, outstanding: 100, unpaid: 1 });
    assert.deepStrictEqual(d.finance.counts, { DRAFT: 0, ISSUED: 1, SENT: 0, PARTIAL: 1, RECEIVED: 0, CANCELLED: 0 });
    assert.deepStrictEqual(d.finance.outstanding.rows.map(r => [r.currency, r.gross, r.advanceAdjusted, r.received, r.outstanding]).sort(), [['AED', 1000, 200, 300, 500], ['SAR', 100, 0, 0, 100]]);
    assert.deepStrictEqual(d.finance.advancesByClient.map(a => [a.client.name, a.received, a.adjusted, a.remaining]), [['Harbour Lane Trading', 300, 200, 100]]);
    // last year: nothing in the dates, the outstanding (as of now) still there
    const ly = await dash({ preset: 'lastyear' }), aedLy = ly.finance.currencies.find(x => x.currency === 'AED');
    assert.deepStrictEqual([aedLy.invoices.invoiced, aedLy.receipts.total, aedLy.invoices.outstanding, ly.tasks.completed], [0, 0, 500, 0]);
});

run('the filters apply to every part: country, client, obligation, person', async () => {
    const sa = await dash({ country: 'SA', days: 60 });
    assert.deepStrictEqual([sa.kpis.activeClients, sa.kpis.missingInfo, sa.kpis.open, sa.kpis.upcoming], [1, 0, 1, 1]);
    assert.deepStrictEqual(sa.finance.currencies.map(x => x.currency), ['SAR']);
    assert.ok(sa.byCountry.every(c => c.key === 'SA'));
    const q2 = await dash({ obligation: 'VAT Return Q2' });
    assert.deepStrictEqual([q2.kpis.open, q2.kpis.overdue, q2.kpis.taskPending], [1, 1, 1]);
    const mine = await dash({ assignee: W.manager });
    assert.deepStrictEqual([mine.kpis.activeClients, mine.kpis.open], [1, 2]);
    const nobody = await dash({ assignee: 'none' });
    assert.deepStrictEqual([nobody.kpis.activeClients, nobody.kpis.open], [1, 1]);
    const one = await dash({ clientId: W.ae.id });
    assert.deepStrictEqual([one.kpis.activeClients, one.kpis.open], [1, 2]);
    assert.strictEqual((await call('/api/cmp/overview?days=0')).status, 400);
    assert.strictEqual((await call(`/api/cmp/overview?preset=custom&from=${today}&to=${day(-1)}`)).status, 400);
    const custom = await dash({ preset: 'custom', from: day(-1), to: today });
    assert.deepStrictEqual([custom.period.from, custom.period.to, custom.tasks.completed], [day(-1), today, 1]);
});

run('the money and the activity only for those who may see them; the activity has what happened', async () => {
    const d = await dash();
    assert.ok(d.money && d.logs && d.activity.rows.length);
    const labels = new Set(d.activity.rows.map(a => a.label));
    for (const l of ['Client created', 'Obligation created', 'Data collection updated', 'Task completed', 'Advance received', 'Invoice issued', 'Advance adjusted', 'Receipt booked', 'Reminder sent on WhatsApp', 'Message marked not sent']) assert.ok(labels.has(l) || [...labels].some(x => x.startsWith(l)), `${l} in ${[...labels].join(', ')}`);
    const m = await dash({}, A.manager.token);
    assert.ok(!m.money && !m.finance && !m.logs && !m.activity);
    assert.strictEqual((await call('/api/cmp/overview', 'GET', undefined, A.cashier.token)).status, 403);
});

run('the calendar: due dates, reminders and tasks for a stretch of days; with the filters', async () => {
    const c = await ok(call(`/api/cmp/overview/calendar?from=${day(-15)}&to=${day(15)}`));
    const kinds = c.entries.map(e => `${e.type}:${e.occurrence.obligation.name}:${e.date}`);
    for (const k of [`due:VAT Return Q1:${day(10)}`, `due:VAT Return Q2:${day(-5)}`, `reminder:VAT Return Q1:${day(0)}`, `reminder:VAT Return Q1:${day(7)}`, `reminder:VAT Return Q2:${day(-15)}`, `task:Corporate Tax:${today}`]) assert.ok(kinds.includes(k), `${k} in ${kinds.join(' | ')}`);
    const sa = await ok(call(`/api/cmp/overview/calendar?from=${day(-15)}&to=${day(15)}&country=SA`));
    assert.strictEqual(sa.entries.length, 0);
    assert.strictEqual((await call(`/api/cmp/overview/calendar?from=${day(0)}&to=${day(100)}`)).status, 400);
    assert.strictEqual((await call(`/api/cmp/overview/calendar?from=${day(0)}&to=${day(10)}`, 'GET', undefined, A.manager.token)).status, 200);
});

run('the obligations list opens the dashboard\'s new figures: data collection pending, task pending', async () => {
    const dp = await ok(call('/api/cmp/occurrences?status=DATA_PENDING'));
    assert.deepStrictEqual(dp.rows.map(r => r.obligation.name).sort(), ['VAT Return Q1', 'Zakat Return']);
    const tp = await ok(call('/api/cmp/occurrences?status=TASK_PENDING'));
    assert.deepStrictEqual(tp.rows.map(r => r.obligation.name), ['VAT Return Q2']);
});

run('it writes nothing: every table of the firm and the activity log are the same before and after', async () => {
    const countAll = async () => {
        const out = {};
        for (const m of A.models) out[m] = await A.prisma[m].count({ where: { tenantId: A.tenantId } }).catch(() => -1);
        out.auditLog = await A.prisma.auditLog.count({ where: { tenantId: A.tenantId } });
        out.settings = JSON.stringify(await A.prisma.cmpSettings.findUnique({ where: { tenantId: A.tenantId }, select: { updatedAt: true } }));
        return out;
    };
    const before = await countAll();
    for (const q of [{}, { preset: 'year', days: 90 }, { country: 'AE' }, { preset: 'lastyear' }]) await dash(q);
    await ok(call(`/api/cmp/overview/calendar?from=${day(-30)}&to=${day(30)}`));
    assert.deepStrictEqual(await countAll(), before);
});

test('dashboard API: clean up', async () => { await A.teardown(); });
