// Compliance & Deadlines: the CA's feedback of 9 November 2026, through the real server.
// - an obligation is three dates: how often it comes back follows from them; "how many years" or unlimited; amber days and "prepare the
//   next one by itself" set on each obligation
// - the periods still to come are shown ahead (Planned), the sheet is sorted by date then client, and filtered by one or several clients
// - an obligation can be deleted; once a message was sent, only with a note
// - a client with no WhatsApp; placeholders from everywhere, and a client's real values for the templates page (never its password)
// - an invoice can be cancelled at any stage (its receipts voided with it, when said), "sent" can be undone, items and services are kept
//   with their price per country; a logo and a header for invoices; every report by dates
// Needs the local database; makes its own firm and removes it.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');
const R = require('../public/cmp-rules');

const A = createApi('cmpfb');
A.models = ['cmpMessage', 'cmpReceipt', 'cmpInvoice', 'cmpTaxRate', 'cmpItem', 'cmpReminder', 'cmpOccurrence', 'cmpObligation', 'cmpFieldValue', 'cmpFieldDef', 'cmpTemplate', 'cmpClient', 'cmpSettings'];
const run = A.run;
const W = {};
const today = R.dayIn('Asia/Karachi');
const day = n => R.addDays(today, n);
const thisYear = Number(today.slice(0, 4));

test('rules: the cycle follows from the period; the periods to come; placeholders in groups', () => {
    assert.strictEqual(R.detectFrequency('2026-07-01', '2027-06-30'), 'YEARLY'); // Pakistan income tax year
    assert.strictEqual(R.detectFrequency('2025-11-01', '2026-01-31'), 'QUARTERLY');
    assert.strictEqual(R.detectFrequency('2026-02-01', '2026-02-28'), 'MONTHLY');
    assert.strictEqual(R.detectFrequency('2026-02-15', '2026-03-14'), 'MONTHLY');
    assert.strictEqual(R.detectFrequency('2026-01-01', '2026-06-30'), 'HALF_YEARLY');
    assert.strictEqual(R.detectFrequency('2026-03-10', '2026-04-02'), 'YEARLY'); // anything else comes back once a year
    const s = { basePeriodStart: '2026-07-01', basePeriodEnd: '2027-06-30', baseDueDate: '2027-09-30', baseSeq: 1, frequency: 'YEARLY', yearsTotal: null };
    assert.deepStrictEqual(R.projectPeriods(s, 2, '2030-12-31').map(p => [p.seq, p.dueDate]), [[2, '2028-09-30'], [3, '2029-09-30'], [4, '2030-09-30']]);
    assert.deepStrictEqual(R.projectPeriods({ ...s, yearsTotal: 2 }, 2, '2040-12-31').map(p => p.seq), [2]); // never past the years
    assert.strictEqual(R.projectPeriods({ ...s, frequency: 'QUARTERLY', basePeriodEnd: '2026-09-30', baseDueDate: '2026-10-28', yearsTotal: 1 }, 2, '2040-12-31').length, 3);
    const groups = Object.fromEntries(R.PLACEHOLDER_GROUPS);
    assert.ok(groups['Client details'].includes('WhatsApp Number') && groups.Invoice.includes('Amount Outstanding') && groups['Your firm'].includes('Firm Name'));
    assert.ok(!R.RESERVED.has(R.keyOf('WhatsApp Number')), 'a field called WhatsApp Number stays allowed (it is where WhatsApp messages go)');
    const r = R.render('[Client Code] [WhatsApp Number] [Days Left] [Portal Link] [Invoice Date] [Payment Due] [Amount Outstanding] [Receipt Date] [Receipt Amount] [Firm Name]', {
        client: { code: 'CL0007', contactNumber: '+971500000000' }, whatsapp: '+971511111111', daysLeft: -3, portalUrl: 'https://x.ae', occurrence: { dueDate: '2027-01-01' },
        invoice: { date: '2027-01-05', dueDate: '2027-01-20', outstandingText: 'AED 10.00' }, receipt: { date: '2027-01-10', amountText: 'AED 5.00' }, firm: { name: 'MYCO' } });
    assert.strictEqual(r.text, 'CL0007 +971511111111 3 days overdue https://x.ae 5 Jan 2027 20 Jan 2027 AED 10.00 10 Jan 2027 AED 5.00 MYCO');
    assert.deepStrictEqual(r.missing, []);
});

test('feedback API: start a server, a firm with the module and its users', { timeout: 90000 }, async t => {
    if (!(await A.setup(t, { modules: ['COMPLIANCE'] }))) return;
    const set = (email, cmpPerms) => A.prisma.user.update({ where: { email }, data: { cmpPerms } });
    await set(A.owner.email, ['FULL']);
    await set(A.manager.email, ['VIEW', 'CLIENT_EDIT', 'OBLIGATION_EDIT', 'WHATSAPP', 'COMPLETE', 'REPORTS']); // no archive, no invoices
    W.tpl = (await A.call('/api/cmp/templates', { token: A.owner.token, method: 'POST', body: { name: 'Reminder', purpose: 'REMINDER', body: 'Dear [Client Name], [Obligation] is due on [Due Date].' } })).json;
    const mk = async (country, name, contactNumber, extra = {}) => (await A.call('/api/cmp/clients', { token: A.owner.token, method: 'POST', body: { country, name, contactNumber, portalUsername: 'u', portalPassword: 'secret-pw', ...extra } })).json.client;
    W.pk = await mk('PK', 'Zeta Traders', '03001112233');
    W.ae = await mk('AE', 'Alpha Trading LLC', '+971501112233');
    W.noWa = await mk('AE', 'Beta Without WhatsApp', '+971501112244', { noWhatsApp: true });
    assert.ok(W.pk && W.ae && W.noWa && W.noWa.noWhatsApp === true, 'clients made');
});

run('an obligation is its three dates: the cycle follows from them; how many years or unlimited; amber and "by itself" per obligation', async () => {
    // Pakistan income tax: 1 Jul – 30 Jun, due 30 Sep: once a year, unlimited
    let r = await A.call(`/api/cmp/clients/${W.pk.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'Income Tax Return', periodStart: `${thisYear}-07-01`, periodEnd: `${thisYear + 1}-06-30`, dueDate: `${thisYear + 1}-09-30` } });
    assert.strictEqual(r.status, 200, r.text);
    W.itr = r.json;
    assert.deepStrictEqual([W.itr.frequency, W.itr.yearsTotal, W.itr.amberDays, W.itr.autoNext], ['YEARLY', null, 7, true]);
    // a quarter: every quarter, for 1 year, amber 14 days before, next one by hand
    r = await A.call(`/api/cmp/clients/${W.ae.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'VAT Return', periodStart: day(-120), periodEnd: R.addDays(R.shiftMonths(day(-120), 3, false), -1), dueDate: day(5), yearsTotal: 1, amberDays: 14, autoNext: false,
        reminders: [{ offsetDays: -10, templateId: W.tpl.id }] } });
    assert.strictEqual(r.status, 200, r.text);
    W.vat = r.json;
    assert.deepStrictEqual([W.vat.frequency, W.vat.amberDays, W.vat.autoNext, W.vat.occurrences.length], ['QUARTERLY', 14, false, 1]); // period over, but not "by itself": no next one
    assert.strictEqual(W.vat.occurrences[0].view.colour, 'amber'); // due in 5 days, amber from 14
    // the same quarter, asked to come back once a year (one of four quarterly returns)
    r = await A.call(`/api/cmp/clients/${W.ae.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'VAT Q1', frequency: 'YEARLY', periodStart: day(-120), periodEnd: R.addDays(R.shiftMonths(day(-120), 3, false), -1), dueDate: day(5) } });
    assert.strictEqual(r.json.frequency, 'YEARLY');
    W.q1 = r.json;
    // bad values
    assert.strictEqual((await A.call(`/api/cmp/clients/${W.ae.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'x', periodStart: day(1), periodEnd: day(2), dueDate: day(3), amberDays: 500 } })).status, 400);
    // edited: amber days and "by itself" (switched on: the next quarter comes at once, its period being over)
    r = await A.call(`/api/cmp/obligations/${W.vat.id}`, { token: A.manager.token, method: 'PUT', body: { amberDays: 3, autoNext: true } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.amberDays, r.json.autoNext, r.json.occurrences.length], [3, true, 2]);
    assert.strictEqual(r.json.occurrences[0].view.colour, 'amber', 'still amber: its reminder is ready to send');
    const act = await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'cmp.obligation.update', entityId: W.vat.id }, orderBy: { createdAt: 'desc' } });
    assert.match(act.summary, /turns amber 14 → 3 days before, next period prepared by itself/);
});

run('the sheet: the periods still to come as Planned, by due date then client name; one or several clients; the calendar shows the future', async () => {
    const from = `${thisYear}-01-01`, to = `${thisYear + 3}-12-31`;
    let r = await A.call('/api/cmp/occurrences?' + new URLSearchParams({ status: 'ALL', from, to, projected: '1' }), { token: A.manager.token });
    assert.strictEqual(r.status, 200, r.text);
    const planned = r.json.rows.filter(x => x.projected);
    assert.ok(planned.some(x => x.obligation.id === W.itr.id && x.dueDate === `${thisYear + 2}-09-30` && x.view.status === 'PLANNED'), 'next years of the income tax return are planned');
    assert.ok(!planned.some(x => x.obligation.id === W.vat.id && x.seq > 4), 'never past the number of years');
    assert.strictEqual(r.json.planned, planned.length);
    const keys = r.json.rows.map(x => [x.dueDate, x.client.name, x.obligation.name]);
    assert.deepStrictEqual(keys, [...keys].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2])), 'by due date, then client');
    // same day, two clients: alphabetical
    const same = r.json.rows.filter(x => x.dueDate === day(5));
    assert.deepStrictEqual(same.map(x => x.client.name), [...same.map(x => x.client.name)].sort());
    // only planned; only one client; two clients
    r = await A.call('/api/cmp/occurrences?' + new URLSearchParams({ status: 'PLANNED', from, to, projected: '1' }), { token: A.manager.token });
    assert.ok(r.json.rows.length && r.json.rows.every(x => x.projected));
    r = await A.call('/api/cmp/occurrences?' + new URLSearchParams({ status: 'ALL', from, to, projected: '1', clientId: W.pk.id }), { token: A.manager.token });
    assert.ok(r.json.rows.length && r.json.rows.every(x => x.client.id === W.pk.id));
    r = await A.call('/api/cmp/occurrences?' + new URLSearchParams({ status: 'ALL', from, to, clientId: `${W.pk.id},${W.ae.id}` }), { token: A.manager.token });
    assert.deepStrictEqual([...new Set(r.json.rows.map(x => x.client.id))].sort(), [W.pk.id, W.ae.id].sort());
    // without dates, nothing is planned (the whole future would be endless)
    r = await A.call('/api/cmp/occurrences?' + new URLSearchParams({ status: 'ALL', projected: '1' }), { token: A.manager.token });
    assert.ok(!r.json.rows.some(x => x.projected));
    // the calendar of a month two years on shows the income tax return
    r = await A.call('/api/cmp/calendar?' + new URLSearchParams({ from: `${thisYear + 2}-09-01`, to: `${thisYear + 2}-09-30`, projected: '1' }), { token: A.manager.token });
    assert.ok(r.json.rows.some(x => x.obligation.id === W.itr.id && x.projected));
    // an invoice of the period comes with its row
    assert.ok(r.json.rows.every(x => 'invoice' in x));
});

run('a client with no WhatsApp: no message can be prepared, and its reminders are not counted as ready to send', async () => {
    const ob = (await A.call(`/api/cmp/clients/${W.noWa.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'VAT Return', frequency: 'YEARLY', periodStart: day(-60), periodEnd: day(-30), dueDate: day(3), reminders: [{ offsetDays: -5, templateId: W.tpl.id }] } })).json;
    const occ = ob.occurrences[0];
    assert.strictEqual(occ.view.actionable, false);
    let r = await A.call('/api/cmp/messages/prepare', { token: A.manager.token, method: 'POST', body: { kind: 'REMINDER', occurrenceId: occ.id, reminderId: ob.reminders[0].id } });
    assert.strictEqual(r.status, 409);
    assert.match(r.json.error, /has no WhatsApp/);
    const alerts = (await A.call('/api/cmp/alerts', { token: A.manager.token })).json;
    r = await A.call(`/api/cmp/clients/${W.noWa.id}`, { token: A.owner.token, method: 'PUT', body: { ...W.noWa, portalPassword: '', noWhatsApp: false } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual((await A.call('/api/cmp/alerts', { token: A.manager.token })).json.ready, alerts.ready + 1, 'counted again once it has WhatsApp');
    assert.strictEqual((await A.call('/api/cmp/messages/prepare', { token: A.manager.token, method: 'POST', body: { kind: 'REMINDER', occurrenceId: occ.id, reminderId: ob.reminders[0].id } })).status, 200);
    W.noWaOb = ob;
});

run('the templates page: a client\'s real value for every placeholder, in groups; never the password', async () => {
    await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { firmName: 'MYCO', firmPhone: '+92 300 1234567' } });
    const r = await A.call(`/api/cmp/templates/context?clientId=${W.ae.id}`, { token: A.manager.token });
    assert.strictEqual(r.status, 200, r.text);
    const v = Object.fromEntries(r.json.groups.flatMap(g => g.items.map(i => [i.name, i.value])));
    assert.deepStrictEqual([v['Client Name'], v['Client Code'], v['Country'], v['Firm Name'], v['WhatsApp Number']], ['Alpha Trading LLC', W.ae.code, 'United Arab Emirates', 'MYCO', '+971501112233']);
    assert.ok(v.Obligation && v['Due Date'], 'its next open obligation');
    assert.deepStrictEqual(r.json.groups.map(g => g.title), ['Client details', 'Additional information', 'Obligation', 'Invoice', 'Receipt', 'Your firm']);
    assert.ok(!JSON.stringify(r.json).includes('portalPassword') && !JSON.stringify(r.json).includes('secret-pw') && !/pinCode/.test(JSON.stringify(r.json)), 'no password, not even encrypted');
    assert.strictEqual((await A.call(`/api/cmp/templates/context?clientId=${W.ae.id}&occurrenceId=${W.itr.occurrences[0].id}`, { token: A.manager.token })).status, 400); // another client's period
    // a custom field may not take a new built-in name, but may be called WhatsApp Number
    assert.strictEqual((await A.call('/api/cmp/fields', { token: A.owner.token, method: 'POST', body: { name: 'Days Left', countries: ['AE'] } })).status, 400);
    assert.strictEqual((await A.call('/api/cmp/fields', { token: A.owner.token, method: 'POST', body: { name: 'WhatsApp Number', countries: ['AE'] } })).status, 200);
});

run('an obligation is deleted for good; once a message was sent, only with a note, and the message stays in the log', async () => {
    // no message: deleted at once (the manager may not: deleting is the archive permission)
    assert.strictEqual((await A.call(`/api/cmp/obligations/${W.q1.id}/delete`, { token: A.manager.token, method: 'POST', body: {} })).status, 403);
    let r = await A.call(`/api/cmp/obligations/${W.q1.id}/delete`, { token: A.owner.token, method: 'POST', body: {} });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(await A.prisma.cmpObligation.count({ where: { id: W.q1.id } }), 0);
    assert.strictEqual(await A.prisma.cmpOccurrence.count({ where: { obligationId: W.q1.id } }), 0);
    // a message was sent: a note is required
    const occ = W.noWaOb.occurrences[0];
    const sent = await A.call('/api/cmp/messages', { token: A.manager.token, method: 'POST', body: { kind: 'REMINDER', occurrenceId: occ.id, reminderId: W.noWaOb.reminders[0].id, body: 'Hello', phone: '+971501112244' } });
    assert.strictEqual(sent.status, 200, sent.text);
    const before = await A.call(`/api/cmp/obligations/${W.noWaOb.id}`, { token: A.owner.token });
    assert.deepStrictEqual(before.json.usage, { messages: 1, invoices: 0 });
    r = await A.call(`/api/cmp/obligations/${W.noWaOb.id}/delete`, { token: A.owner.token, method: 'POST', body: {} });
    assert.strictEqual(r.status, 409);
    assert.match(r.json.error, /1 WhatsApp message was sent.*note/);
    r = await A.call(`/api/cmp/obligations/${W.noWaOb.id}/delete`, { token: A.owner.token, method: 'POST', body: { note: 'Added to the wrong client' } });
    assert.strictEqual(r.status, 200, r.text);
    const m = await A.prisma.cmpMessage.findUnique({ where: { id: sent.json.message.id } });
    assert.deepStrictEqual([m.occurrenceId, m.reminderId, m.body], [null, null, 'Hello']);
    const a = await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'cmp.obligation.delete', entityId: W.noWaOb.id } });
    assert.match(a.summary, /deleted \(2 periods, 1 message sent\)\. Note: Added to the wrong client/);
});

run('invoices: items kept with their price per country; "sent" undone; cancelled at any stage, its receipts voided with it when said', async () => {
    let r = await A.call('/api/cmp/invoices', { token: A.owner.token, method: 'POST', body: { clientId: W.ae.id } });
    const id = r.json.id;
    r = await A.call(`/api/cmp/invoices/${id}`, { token: A.owner.token, method: 'PUT', body: { lines: [{ description: 'VAT return  filing', amount: '500', save: true }, { description: 'Not kept', amount: '10' }] } });
    assert.strictEqual(r.status, 200, r.text);
    let items = (await A.call('/api/cmp/items?country=AE', { token: A.owner.token })).json;
    assert.deepStrictEqual(items.map(x => [x.name, x.currency, x.amount, x.countries]), [['VAT return filing', 'AED', 500, ['AE']]]);
    assert.deepStrictEqual((await A.call('/api/cmp/items?country=PK', { token: A.owner.token })).json, []); // another country: not suggested
    // a new price typed on an invoice replaces the saved one (the same item, whatever the spaces and case)
    await A.call(`/api/cmp/invoices/${id}`, { token: A.owner.token, method: 'PUT', body: { lines: [{ description: 'vat return filing', amount: '525', save: true }] } });
    items = (await A.call('/api/cmp/items?country=AE', { token: A.owner.token })).json;
    assert.deepStrictEqual(items.map(x => [x.amount]), [[525]]);
    assert.strictEqual((await A.call('/api/cmp/items', { token: A.owner.token, method: 'POST', body: { name: 'Audit', currency: 'XXX', amount: 1, countries: ['AE'] } })).status, 400);
    r = await A.call('/api/cmp/items', { token: A.owner.token, method: 'POST', body: { name: 'Audit', currency: 'KWD', amount: '100.125', countries: ['KW'] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual((await A.call('/api/cmp/items', { token: A.owner.token, method: 'POST', body: { name: 'audit', currency: 'KWD', amount: '1', countries: ['KW'] } })).status, 409);
    // issued, sent, undone
    assert.strictEqual((await A.call(`/api/cmp/invoices/${id}/issue`, { token: A.owner.token, method: 'POST' })).status, 200);
    assert.strictEqual((await A.call(`/api/cmp/invoices/${id}/sent`, { token: A.owner.token, method: 'POST' })).json.status, 'SENT');
    r = await A.call(`/api/cmp/invoices/${id}/unsent`, { token: A.owner.token, method: 'POST' });
    assert.deepStrictEqual([r.json.status, r.json.sentAt], ['ISSUED', null]);
    // paid in full, then cancelled: refused until the receipts are said to go with it
    r = await A.call(`/api/cmp/invoices/${id}/receipts`, { token: A.owner.token, method: 'POST', body: { amount: '525' } });
    assert.strictEqual(r.json.invoice.status, 'RECEIVED');
    r = await A.call(`/api/cmp/invoices/${id}/cancel`, { token: A.owner.token, method: 'POST', body: { reason: 'Wrong client' } });
    assert.strictEqual(r.status, 409);
    assert.match(r.json.error, /AED 525.00 was received against this invoice \(RCT-.*\)\. Cancelling it voids that receipt too\./);
    r = await A.call(`/api/cmp/invoices/${id}/cancel`, { token: A.owner.token, method: 'POST', body: { reason: 'Wrong client', voidReceipts: true } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.status, r.json.received, r.json.receipts.every(x => x.voidedAt), r.json.receipts[0].voidReason], ['CANCELLED', 0, true, 'Invoice cancelled: Wrong client']);
    W.cancelled = id;
});

run('settings: a logo (a small picture) and a header for invoices; anything else as a logo is refused', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    let r = await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { logo: png, invoiceHeader: 'Chartered Accountants\nTax Advisors' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.logo, r.json.invoiceHeader], [png, 'Chartered Accountants\nTax Advisors']);
    assert.strictEqual((await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { logo: 'data:text/html;base64,PHNjcmlwdD4=' } })).status, 400);
    assert.strictEqual((await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { logo: 'javascript:alert(1)' } })).status, 400);
    assert.strictEqual((await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { logo: 'data:image/png;base64,' + 'A'.repeat(500000) } })).status, 400);
    assert.strictEqual((await A.call('/api/cmp/me', { token: A.manager.token })).json.settings.logo, png);
});

run('reports by dates: obligations (with the planned ones), invoices, receipts, a summary per client; downloads', async () => {
    const q = new URLSearchParams({ from: `${thisYear}-01-01`, to: `${thisYear + 1}-12-31` });
    let r = await A.call(`/api/cmp/reports/obligations?${q}&projected=1`, { token: A.manager.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.json.rows.length && r.json.counts);
    assert.strictEqual((await A.call(`/api/cmp/reports/invoices?${q}`, { token: A.manager.token })).status, 403); // invoices need the invoice permission
    r = await A.call(`/api/cmp/reports/invoices?${q}`, { token: A.owner.token });
    assert.ok(r.json.rows.some(i => i.id === W.cancelled));
    r = await A.call(`/api/cmp/reports/receipts?${q}`, { token: A.owner.token });
    assert.ok(r.json.rows.length >= 1 && r.json.rows.every(x => x.voidedAt));
    r = await A.call(`/api/cmp/reports/clients?${q}`, { token: A.owner.token });
    const ae = r.json.rows.find(x => x.client.id === W.ae.id);
    assert.ok(ae && ae.periods >= 1 && r.json.money === true);
    r = await A.call(`/api/cmp/reports/clients?${q}`, { token: A.manager.token });
    assert.strictEqual(r.json.money, false); // no money for those who do not invoice
    await A.prisma.user.update({ where: { email: A.owner.email }, data: { cmpPerms: ['FULL'] } });
    r = await A.call(`/api/cmp/export/clientsummary?${q}`, { token: A.owner.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.text, /Client code,Client,Country,Periods due,Completed,Open,Overdue,Invoiced,Received,Outstanding/);
    // a client's page for a stretch of dates
    r = await A.call(`/api/cmp/clients/${W.ae.id}?from=${thisYear + 5}-01-01&to=${thisYear + 5}-12-31`, { token: A.owner.token });
    assert.deepStrictEqual([r.json.invoices.length, r.json.messages.length, r.json.activity.length], [0, 0, 0]);
    assert.ok(r.json.obligations.length >= 1, 'the obligations themselves always come (the screen shows their periods of those dates)');
});

test.after(() => A.teardown());
