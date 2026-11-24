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
    assert.deepStrictEqual(d.kpis, { activeClients: 2, newClients: 2, missingInfo: 1, open: 3, overdue: 1, upcoming: 1, remindersDue: 1, dataPending: 2, taskPending: 1 });
    assert.strictEqual((await dash({ preset: 'lastyear' })).kpis.newClients, 0, 'new clients are those added in the dates chosen');
    assert.deepStrictEqual(d.upcoming.rows.map(r => r.obligation.name), ['VAT Return Q1']);
    assert.deepStrictEqual(d.upcoming.rows[0].reminders.map(x => x.button), ['SENT', 'WAIT']);
    assert.deepStrictEqual([d.overdue.rows[0].obligation.name, d.overdue.rows[0].daysOverdue, d.overdue.rows[0].lastReminder.status], ['VAT Return Q2', 5, 'NOT_SENT']);
    assert.strictEqual((await dash({ days: 60 })).kpis.upcoming, 2, 'Zakat (in 40 days) with a 60-day window');
    assert.deepStrictEqual(d.reminders.counts, { DUE: 0, MISSED: 1, MARKED_NOT_SENT: 0, SCHEDULED: 1, SENT: 1, OTHER_WAY: 0, NOT_NEEDED: 0 });
    // (Q2 has its data in but is past its due date: overdue, as My Obligations shows it, so not counted under "data collected")
    assert.deepStrictEqual([d.workflow.OPEN, d.workflow.OVERDUE, d.workflow.DATA_PENDING, d.workflow.DATA_COLLECTED, d.workflow.COMPLETED, d.workflow.CONFIRM], [3, 1, 2, 0, 1, 0]);
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
    assert.deepStrictEqual(d.finance.created, { count: 2, drafts: 0 }, 'invoices created in the dates (8.3: by the day they were created)');
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
    // the communication log: both sends of the reminder, the first marked not sent
    assert.deepStrictEqual(d.communication.rows.map(x => [x.kind, x.status, x.channel]).sort(), [['REMINDER', 'MARKED_NOT_SENT', 'WHATSAPP'], ['REMINDER', 'SENT', 'WHATSAPP']]);
    assert.ok(d.communication.rows.every(x => /VAT Return Q1/.test(x.related) && x.link.period), JSON.stringify(d.communication.rows[0]));
    // the Obligation filter applies to the activity too (FR-010)
    const q2 = await dash({ obligation: 'VAT Return Q2' }), q2labels = q2.activity.rows.map(a => a.label);
    assert.ok(q2labels.includes('Data collection updated') && !q2labels.includes('Task completed') && !q2labels.includes('Invoice issued') && !q2labels.some(l => l.startsWith('Reminder sent')), q2labels.join(', '));
    assert.strictEqual(q2.communication.rows.length, 0);
    const m = await dash({}, A.manager.token);
    assert.ok(!m.communication, 'the communication log needs the logs permission');
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

run('the reports of the SRS section 5: data collection, tasks, staff, countries, annual compliance', async () => {
    const rep = async (key, q = {}) => ok(call(`/api/cmp/catalog/${key}?` + new URLSearchParams(q)), key);
    assert.deepStrictEqual((await rep('data-pending')).rows.map(r => r.obligation).sort(), ['VAT Return Q1', 'Zakat Return']);
    assert.deepStrictEqual((await rep('tasks-pending')).rows.map(r => r.obligation), ['VAT Return Q2']);
    assert.deepStrictEqual((await rep('tasks-overdue')).rows.map(r => [r.obligation, r.days]), [['VAT Return Q2', 5]]);
    assert.deepStrictEqual((await rep('tasks-completed')).rows.map(r => r.obligation), ['Corporate Tax']);
    assert.deepStrictEqual((await rep('data-completed', { from: day(-3), to: today })).rows.map(r => r.obligation).sort(), ['Corporate Tax', 'VAT Return Q2']);
    const wl = (await rep('staff-workload')).rows, mgr = wl.find(r => r.person === 'manager'), none = wl.find(r => r.person === 'Nobody');
    assert.deepStrictEqual([mgr.clients, mgr.open, mgr.overdue, mgr.data, mgr.tasks, mgr.reminders], [1, 2, 1, 1, 1, 1]);
    assert.deepStrictEqual([none.clients, none.open], [1, 1]);
    const so = (await rep('staff-obligations', { days: 30 })).rows.find(r => r.person === 'manager');
    assert.deepStrictEqual([so.open, so.overdue, so.soon, so.completed], [2, 1, 1, 1]);
    assert.deepStrictEqual((await rep('staff-tasks')).rows.find(r => r.person === 'manager').pending, 1);
    assert.deepStrictEqual((await rep('clients-by-country')).rows.map(r => [r.country, r.active, r.open, r.overdue]), [['Saudi Arabia', 1, 1, 0], ['United Arab Emirates', 1, 2, 1]]);
    assert.deepStrictEqual((await rep('clients-by-person')).rows.map(r => [r.person, r.active, r.open]).sort(), [['Nobody', 1, 1], ['manager', 1, 2]]);
    assert.deepStrictEqual((await rep('staff-clients')).rows.map(r => [r.person, r.client.split(' (')[0], r.open]).sort(), [['Nobody', 'Oasis Point Supplies', 1], ['manager', 'Harbour Lane Trading', 2]]);
    const dl = await rep('deadlines-by-country', { days: 60 });
    assert.deepStrictEqual(dl.rows.map(r => [r.country, r.obligation]), [['Saudi Arabia', 'Zakat Return'], ['United Arab Emirates', 'VAT Return Q2'], ['United Arab Emirates', 'VAT Return Q1']]);
    // the dates around today: Q1 open, Q2 overdue, Corporate Tax completed a day after its due date (late); compliance 0 of 2
    const ac = (await rep('annual-compliance', { from: day(-30), to: day(30), group: 'client' })).rows.find(r => /Harbour Lane/.test(r.name));
    assert.deepStrictEqual([ac.due, ac.onTime, ac.late, ac.open, ac.overdue, ac.rate], [3, 0, 1, 1, 1, '0%']);
});

run('acceptance: clients in other time zones (AT-003), a cancelled invoice (AT-006), an undone receipt (AT-007), no passwords (AT-012)', async () => {
    // AT-003: a client far east (New Zealand) and one far west (the United States): each period's days are counted on its client's calendar
    for (const [cc, name] of [['NZ', 'Kauri Bay Ltd'], ['US', 'Maple Row Inc']]) {
        const c = (await ok(call('/api/cmp/clients', 'POST', { country: cc, name, contactNumber: cc === 'NZ' ? '+64211234567' : '+12025550123', noPortal: true }), name)).client;
        await ok(call(`/api/cmp/clients/${c.id}/obligations`, 'POST', { name: 'Annual Return', periodStart: day(-60), periodEnd: day(-1), dueDate: day(1), autoNext: false }));
    }
    const d = await dash({ days: 30 });
    for (const r of [...d.upcoming.rows, ...d.overdue.rows]) assert.strictEqual(r.daysLeft, R.daysBetween(R.dayIn(r.client.timeZone), r.dueDate), `${r.client.name}: ${r.daysLeft}`);
    assert.ok(d.upcoming.rows.some(r => r.client.country === 'NZ') && d.upcoming.rows.some(r => r.client.country === 'US'));
    // AT-006: the SAR invoice cancelled: out of the outstanding, shown as cancelled, not invoiced
    const sarInv = (await ok(call('/api/cmp/invoices?currency=SAR'))).invoices.find(i => i.number);
    await ok(call(`/api/cmp/invoices/${sarInv.id}/cancel`, 'POST', { reason: 'Issued by mistake' }));
    let f = (await dash()).finance, sar = f.currencies.find(x => x.currency === 'SAR');
    assert.deepStrictEqual([sar.invoices.outstanding, sar.invoices.invoiced, f.counts.CANCELLED, f.outstanding.rows.some(r => r.currency === 'SAR')], [0, 0, 1, false]);
    // AT-007: the AED receipt undone: out of the receipts booked (shown as undone), and the invoice owes it again
    const inv = await ok(call(`/api/cmp/invoices/${W.inv.id}`));
    await ok(call(`/api/cmp/receipts/${inv.receipts[0].id}/void`, 'POST', { reason: 'Bounced cheque' }));
    f = (await dash()).finance; const aed = f.currencies.find(x => x.currency === 'AED');
    assert.deepStrictEqual([aed.receipts.total, aed.receipts.count, aed.receipts.undone, aed.receipts.undoneCount, aed.invoices.outstanding], [0, 0, 300, 1, 800]);
    // AT-012: a client's portal password and PIN never appear in the dashboard, its calendar or the reports
    const c = (await ok(call('/api/cmp/clients', 'POST', { country: 'AE', name: 'Cedar Crest Trading', contactNumber: '+971501115566', portalUsername: 'cedar', portalPassword: 'Zq9-Secret-Pass!', pinCode: '7319' }))).client;
    await ok(call(`/api/cmp/clients/${c.id}/obligations`, 'POST', { name: 'VAT Return', periodStart: day(-60), periodEnd: day(-1), dueDate: day(3), autoNext: false }));
    const texts = [(await call('/api/cmp/overview?days=30')).text, (await call(`/api/cmp/overview/calendar?from=${day(-10)}&to=${day(10)}`)).text, (await call('/api/cmp/catalog/staff-clients')).text, (await call('/api/cmp/catalog/client-register')).text];
    for (const t of texts) { assert.ok(!t.includes('Zq9-Secret-Pass!') && !t.includes('7319') && !/portalPassword|pinCode/.test(t), t.slice(0, 200)); }
});

run('each figure opens the same periods it counts; the Obligation filter is one rule everywhere', async () => {
    const d = await dash({ days: 30 });
    // "due in the next 30 days": open, not past the due date, without the planned periods (OPEN_NOT_DUE over those dates)
    const win = await ok(call(`/api/cmp/occurrences?status=OPEN_NOT_DUE&from=${today}&to=${day(30)}&projected=1`));
    assert.deepStrictEqual(win.rows.map(r => r.obligation.name).sort(), d.upcoming.rows.map(r => r.obligation.name).sort());
    assert.ok(win.rows.every(r => !r.projected));
    // the stages: the list of each opens as many periods as the figure says
    for (const st of ['DATA_COLLECTED', 'FILED', 'PAID', 'OVERDUE', 'CONFIRM', 'DATA_PENDING', 'TASK_PENDING']) {
        const l = await ok(call(`/api/cmp/occurrences?status=${st}`)), n = { DATA_COLLECTED: d.workflow.DATA_COLLECTED, FILED: d.workflow.FILED, PAID: d.workflow.PAID, OVERDUE: d.workflow.OVERDUE, CONFIRM: d.workflow.CONFIRM, DATA_PENDING: d.kpis.dataPending, TASK_PENDING: d.kpis.taskPending }[st];
        assert.strictEqual(l.rows.length, n, st);
    }
    // the obligation by its exact name (not the search box): dots, case and spaces do not count; another obligation's name is not a match
    const one = await ok(call('/api/cmp/occurrences?status=ALL&obligation=' + encodeURIComponent('v.a.t.  return q2')));
    assert.deepStrictEqual(one.rows.map(r => r.obligation.name), ['VAT Return Q2']);
    // every part of the dashboard by the same rule: the open periods, the completed tasks and the money of "Corporate Tax"
    const ct = await dash({ obligation: 'corporate  tax.' });
    assert.deepStrictEqual([ct.kpis.open, ct.tasks.completed, ct.workflow.COMPLETED, ct.finance.currencies.find(x => x.currency === 'AED').invoices.invoiced], [0, 1, 1, 1000]);
    assert.ok(ct.activity.rows.some(a => a.label === 'Task completed'), ct.activity.rows.map(a => a.label).join(', '));
    assert.strictEqual(new Set(d.obligationNames.map(R.keyOf)).size, d.obligationNames.length, 'each name once');
});

run('the calendar shows the periods still to come of monthly obligations (worked out only as far as the reminders reach)', async () => {
    const c = (await ok(call('/api/cmp/clients', 'POST', { country: 'AE', name: 'Palm Grove Services', contactNumber: '+971501117788', noPortal: true }))).client;
    await ok(call(`/api/cmp/clients/${c.id}/obligations`, 'POST', { name: 'Payroll Return', frequency: 'MONTHLY', periodStart: day(-40), periodEnd: day(-10), dueDate: day(5), reminders: [{ offsetDays: -3, body: 'Payroll due [Due Date]' }] }), 'monthly');
    const cal = await ok(call(`/api/cmp/overview/calendar?from=${day(40)}&to=${day(100)}&clientId=${c.id}`));
    const due = cal.entries.filter(e => e.type === 'due'), rem = cal.entries.filter(e => e.type === 'reminder');
    assert.ok(due.length >= 1 && due.every(e => e.occurrence.projected), JSON.stringify(due.map(e => e.date)));
    // (each planned reminder 3 days before a planned due date of the calendar, or of the days just after it)
    assert.ok(rem.length >= 1 && rem.every(e => e.planned && (due.some(x => x.date === R.addDays(e.date, 3)) || R.addDays(e.date, 3) > day(100))), JSON.stringify(rem.map(e => e.date)));
});

run('the compliance rate counts a period completed before its due date as on time, never above 100%', async () => {
    const z = W.sat.occurrences[0].id;
    await ok(call(`/api/cmp/occurrences/${z}/data`, 'POST', { on: today }));
    await ok(call(`/api/cmp/occurrences/${z}/complete`, 'POST', { mode: 'TASK', on: today }));
    const rows = (await ok(call(`/api/cmp/catalog/annual-compliance?from=${day(-30)}&to=${day(60)}&group=client`))).rows;
    assert.deepStrictEqual(rows.filter(r => /Oasis Point/.test(r.name)).map(r => [r.due, r.onTime, r.rate]), [[1, 1, '100%']]);
    assert.ok(rows.every(r => r.rate === '—' || Number(r.rate.replace('%', '')) <= 100), JSON.stringify(rows.map(r => r.rate)));
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
