// Compliance & Deadlines: the CA's feedback of 9 November 2026, through the real server.
// - an obligation is three dates typed by hand and comes back every year (the CA's answer: no quarterly cycle; quarterly returns are
//   four obligations, added at once); "how many years" or unlimited; amber days and "prepare the next one by itself" per obligation
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

test('rules: the periods to come; placeholders in groups; the ways a reminder is given', () => {
    assert.strictEqual(R.detectFrequency, undefined, 'no cycle worked out from the dates any more (the CA)');
    assert.deepStrictEqual(Object.keys(R.CHANNELS), ['WHATSAPP', 'PHONE', 'EMAIL', 'OTHER']);
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

run('an obligation is its three dates and comes back every year; how many years or unlimited; amber and "by itself" per obligation', async () => {
    // Pakistan income tax: 1 Jul – 30 Jun, due 30 Sep: once a year, unlimited
    let r = await A.call(`/api/cmp/clients/${W.pk.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'Income Tax Return', periodStart: `${thisYear}-07-01`, periodEnd: `${thisYear + 1}-06-30`, dueDate: `${thisYear + 1}-09-30` } });
    assert.strictEqual(r.status, 200, r.text);
    W.itr = r.json;
    assert.deepStrictEqual([W.itr.frequency, W.itr.yearsTotal, W.itr.amberDays, W.itr.autoNext], ['YEARLY', null, 7, true]);
    // a quarter's dates: still once a year (the CA), for 2 years, amber 14 days before, next one by hand
    r = await A.call(`/api/cmp/clients/${W.ae.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'VAT Return', periodStart: day(-120), periodEnd: R.addDays(R.shiftMonths(day(-120), 3, false), -1), dueDate: day(5), yearsTotal: 2, amberDays: 14, autoNext: false,
        reminders: [{ offsetDays: -10, templateId: W.tpl.id }] } });
    assert.strictEqual(r.status, 200, r.text);
    W.vat = r.json;
    assert.deepStrictEqual([W.vat.frequency, W.vat.amberDays, W.vat.autoNext, W.vat.occurrences.length], ['YEARLY', 14, false, 1]); // period over, but not "by itself": no next one
    assert.strictEqual(W.vat.occurrences[0].view.colour, 'amber'); // due in 5 days, amber from 14
    // (a frequency can still be given through the API, e.g. by older screens)
    r = await A.call(`/api/cmp/clients/${W.ae.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'VAT Q1', frequency: 'YEARLY', periodStart: day(-120), periodEnd: R.addDays(R.shiftMonths(day(-120), 3, false), -1), dueDate: day(5) } });
    assert.strictEqual(r.json.frequency, 'YEARLY');
    W.q1 = r.json;
    // bad values
    assert.strictEqual((await A.call(`/api/cmp/clients/${W.ae.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'x', periodStart: day(1), periodEnd: day(2), dueDate: day(3), amberDays: 500 } })).status, 400);
    // edited: amber days and "by itself" (switched on: next year's comes at once, the period being over)
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
    assert.ok(!planned.some(x => x.obligation.id === W.vat.id && x.seq > 2), 'never past the number of years');
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

run('a client with no WhatsApp: no WhatsApp message; its reminder is given by phone or email and marked so (the CA)', async () => {
    const ob = (await A.call(`/api/cmp/clients/${W.noWa.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'VAT Return', frequency: 'YEARLY', periodStart: day(-60), periodEnd: day(-30), dueDate: day(3), reminders: [{ offsetDays: -5, templateId: W.tpl.id }] } })).json;
    const occ = ob.occurrences[0], rem = ob.reminders[0];
    assert.strictEqual(occ.view.actionable, true, 'a reminder to give, by phone or email');
    let r = await A.call('/api/cmp/messages/prepare', { token: A.manager.token, method: 'POST', body: { kind: 'REMINDER', occurrenceId: occ.id, reminderId: rem.id } });
    assert.strictEqual(r.status, 409);
    assert.match(r.json.error, /has no WhatsApp/);
    const alerts = (await A.call('/api/cmp/alerts', { token: A.manager.token })).json;
    // marked as reminded by phone: the reminder is done, the log says how
    assert.strictEqual((await A.call('/api/cmp/messages/manual', { token: A.manager.token, method: 'POST', body: { occurrenceId: occ.id, reminderId: rem.id, channel: 'FAX' } })).status, 400);
    r = await A.call('/api/cmp/messages/manual', { token: A.manager.token, method: 'POST', body: { occurrenceId: occ.id, reminderId: rem.id, channel: 'PHONE', note: 'Spoke to the accountant' } });
    assert.strictEqual(r.status, 200, r.text);
    const after = (await A.call(`/api/cmp/obligations/${ob.id}`, { token: A.manager.token })).json.occurrences[0];
    assert.strictEqual(after.view.reminders[0].state, 'SENT');
    assert.strictEqual((await A.call('/api/cmp/alerts', { token: A.manager.token })).json.ready, alerts.ready - 1);
    const log = (await A.call(`/api/cmp/messages?clientId=${W.noWa.id}`, { token: A.owner.token })).json.messages;
    assert.deepStrictEqual([log[0].channel, log[0].body, log[0].phone], ['PHONE', 'Spoke to the accountant', '']);
    const csv = await A.call(`/api/cmp/messages?clientId=${W.noWa.id}&format=csv`, { token: A.owner.token });
    assert.match(csv.text, /,How,/); assert.match(csv.text, /Phone call/);
    // marked "not done" like any message: the reminder is due again
    assert.strictEqual((await A.call(`/api/cmp/messages/${r.json.message.id}/void`, { token: A.manager.token, method: 'POST' })).status, 200);
    assert.notStrictEqual((await A.call(`/api/cmp/obligations/${ob.id}`, { token: A.manager.token })).json.occurrences[0].view.reminders[0].state, 'SENT');
    r = await A.call(`/api/cmp/clients/${W.noWa.id}`, { token: A.owner.token, method: 'PUT', body: { ...W.noWa, portalPassword: '', noWhatsApp: false } });
    assert.strictEqual(r.status, 200, r.text);
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
    assert.match(r.json.error, /AED 525.00 was received against this invoice \(RCT-.*\)\. Choose what becomes of it: refund it, keep it as the client's credit, or void the receipts\./);
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

// ---------- the CA's answers (9 November 2026) ----------

run('several obligations at once (the four quarterly returns), each typed by hand and each coming back every year; all or none', async () => {
    const y = thisYear + 1, q = (n, a, b, due) => ({ name: `Sales Tax Q${n}`, periodStart: `${y}-${a}`, periodEnd: `${y}-${b}`, dueDate: `${due}` });
    const items = [q(1, '01-01', '03-31', `${y}-04-28`), q(2, '04-01', '06-30', `${y}-07-28`), q(3, '07-01', '09-30', `${y}-10-28`), q(4, '10-01', '12-31', `${y + 1}-01-28`)];
    const shared = { yearsTotal: 3, amberDays: 10, reminders: [{ offsetDays: -7, templateId: W.tpl.id }] };
    // a mistake in the third: none is added
    let r = await A.call(`/api/cmp/clients/${W.pk.id}/obligations`, { token: A.manager.token, method: 'POST', body: { ...shared, items: [items[0], items[1], { ...items[2], dueDate: `${y}-09-01` }, items[3]] } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /^Obligation 3 \(Sales Tax Q3\): The due date cannot be before the period end\./);
    assert.strictEqual(await A.prisma.cmpObligation.count({ where: { clientId: W.pk.id, name: { startsWith: 'Sales Tax Q' } } }), 0);
    assert.strictEqual((await A.call(`/api/cmp/clients/${W.pk.id}/obligations`, { token: A.manager.token, method: 'POST', body: { ...shared, items: [items[0], { ...items[1], name: 'sales tax  q1' }] } })).status, 400); // the same name twice
    r = await A.call(`/api/cmp/clients/${W.pk.id}/obligations`, { token: A.manager.token, method: 'POST', body: { ...shared, items } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json.obligations.map(o => [o.name, o.frequency, o.yearsTotal, o.amberDays, o.reminders.length, o.occurrences[0].dueDate]),
        items.map(i => [i.name, 'YEARLY', 3, 10, 1, i.dueDate]));
    // each comes back once a year: Q1 is planned for the next years on its own dates
    r = await A.call('/api/cmp/occurrences?' + new URLSearchParams({ status: 'PLANNED', from: `${y + 1}-01-01`, to: `${y + 1}-12-31`, projected: '1', clientId: W.pk.id, q: 'Sales Tax Q1' }), { token: A.manager.token });
    assert.deepStrictEqual(r.json.rows.map(x => [x.periodStart, x.dueDate]), [[`${y + 1}-01-01`, `${y + 1}-04-28`]]);
});

run('cancelling a paid invoice: refund it, keep it as the client\'s credit (which pays a later invoice), or void it', async () => {
    const issue = async amount => {
        const d = (await A.call('/api/cmp/invoices', { token: A.owner.token, method: 'POST', body: { clientId: W.ae.id, lines: [{ description: 'Advisory', amount }] } })).json;
        return (await A.call(`/api/cmp/invoices/${d.id}/issue`, { token: A.owner.token, method: 'POST' })).json;
    };
    const pay = (inv, body) => A.call(`/api/cmp/invoices/${inv.id}/receipts`, { token: A.owner.token, method: 'POST', body });
    // refund: the receipt stays, marked refunded with when and how
    let a = await issue('300');
    await pay(a, { amount: '300' });
    let r = await A.call(`/api/cmp/invoices/${a.id}/cancel`, { token: A.owner.token, method: 'POST', body: { reason: 'Client changed its mind', settle: 'REFUND', refund: { date: today, method: 'CREDIT' } } });
    assert.strictEqual(r.status, 400); // paid back "from credit" makes no sense
    r = await A.call(`/api/cmp/invoices/${a.id}/cancel`, { token: A.owner.token, method: 'POST', body: { reason: 'Client changed its mind', settle: 'REFUND', refund: { date: today, method: 'BANK', reference: 'TT-9' } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.status, r.json.cancelSettlement, r.json.receipts[0].voidedAt, r.json.receipts[0].settlement], ['CANCELLED', 'REFUND', null, 'REFUNDED']);
    assert.match(r.json.receipts[0].settlementNote, /^Refunded on .* by bank transfer \(ref\. TT-9\)$/);
    assert.strictEqual((await A.call(`/api/cmp/receipts/${r.json.receipts[0].id}/void`, { token: A.owner.token, method: 'POST', body: { reason: 'x' } })).status, 409); // its money was refunded: it stays
    // credit: kept for the client
    const b = await issue('200');
    await pay(b, { amount: '150' });
    r = await A.call(`/api/cmp/invoices/${b.id}/cancel`, { token: A.owner.token, method: 'POST', body: { reason: 'Wrong period', settle: 'CREDIT' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.cancelSettlement, r.json.receipts[0].settlement, r.json.clientCredit], ['CREDIT', 'CREDITED', [{ currency: 'AED', remaining: 150 }]]);
    assert.deepStrictEqual((await A.call(`/api/cmp/clients/${W.ae.id}`, { token: A.owner.token })).json.credit, [{ currency: 'AED', remaining: 150 }]);
    // the credit pays a later invoice: never more than there is
    const c = await issue('400');
    assert.strictEqual((await pay(c, { amount: '200', method: 'CREDIT' })).status, 400);
    r = await pay(c, { amount: '100', method: 'CREDIT' });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.invoice.status, r.json.invoice.received, r.json.invoice.clientCredit], ['PARTIAL', 100, [{ currency: 'AED', remaining: 50 }]]);
    // voiding that receipt gives the credit back
    const rc = r.json.invoice.receipts.find(x => x.method === 'CREDIT');
    r = await A.call(`/api/cmp/receipts/${rc.id}/void`, { token: A.owner.token, method: 'POST', body: { reason: 'Entered by mistake' } });
    assert.deepStrictEqual(r.json.clientCredit, [{ currency: 'AED', remaining: 150 }]);
    // void: the old way
    const d = await issue('50');
    await pay(d, { amount: '50' });
    r = await A.call(`/api/cmp/invoices/${d.id}/cancel`, { token: A.owner.token, method: 'POST', body: { reason: 'Cheque bounced', settle: 'VOID' } });
    assert.deepStrictEqual([r.json.cancelSettlement, Boolean(r.json.receipts[0].voidedAt)], ['VOID', true]);
    assert.strictEqual((await A.call(`/api/cmp/invoices/${d.id}/cancel`, { token: A.owner.token, method: 'POST', body: { reason: 'x', settle: 'GIFT' } })).status, 409); // (already cancelled)
    // the receipts report does not count money refunded or kept as credit
    const rep = (await A.call(`/api/cmp/reports/receipts?from=${thisYear}-01-01&to=${thisYear + 1}-12-31`, { token: A.owner.token })).json;
    const counted = rep.rows.filter(x => !x.voidedAt && !x.settlement).reduce((m, x) => m + x.amount, 0);
    assert.deepStrictEqual(rep.totals.map(t => t.total), counted ? [counted] : []);
    const act = await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'cmp.invoice.cancel', entityId: b.id } });
    assert.match(act.summary, /cancelled: Wrong period \(AED 150\.00 received, receipt RCT-.*: kept as credit\)/);
});

run('settings: a full letterhead picture instead of the logo and header', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    let r = await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { headerStyle: 'letterhead', letterhead: png } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.headerStyle, r.json.letterhead], ['LETTERHEAD', png]);
    assert.strictEqual((await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { headerStyle: 'BANNER' } })).status, 400);
    assert.strictEqual((await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { letterhead: 'data:image/svg+xml;base64,PHN2Zz4=' } })).status, 400);
    assert.strictEqual((await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { letterhead: 'data:image/png;base64,' + 'A'.repeat(1300000) } })).status, 400);
});

test.after(() => A.teardown());
