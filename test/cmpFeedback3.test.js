// Compliance & Deadlines: the CA's "Deadline Tracker - 1" of 16 November 2026, through the real server.
// - a custom field's type changes with its name, its values read as the new type; the values typed before are suggested again
// - the same obligation cannot be added twice for a client (not even by two clicks at once); a past due date is the screen's question
// - each obligation has its own 1st, 2nd and 3rd reminder (a day and its own message); a reminder's sends are counted ("sent twice") and
//   one can be taken off by hand
// - the tracker: data collection, then the task (never before the data), the invoice created, issued (sent) and the receipt, "2/7"
// - advance payments: gross amount, advance adjusted, net amount; used when the invoice is issued, given back when it is cancelled
// - the price bank keeps every price with its dates; completed obligations are billed on the invoice, each period only once
// - invoice formats per country (UAE - Dubai, UAE - Sharjah), the default first, frozen on the invoice when it is issued
// - "Invoices Created" and "Invoices Issued"
// Needs the local database; makes its own firm and removes it.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');
const R = require('../public/cmp-rules');
const V = require('../src/compliance/validate');

const A = createApi('cmpfb3');
A.models = ['cmpMessage', 'cmpReceipt', 'cmpInvoice', 'cmpAdvance', 'cmpCredit', 'cmpTaxRate', 'cmpItemPrice', 'cmpItem', 'cmpReminder', 'cmpOccurrence', 'cmpObligation', 'cmpFieldValue', 'cmpFieldDef', 'cmpTemplate', 'cmpClient', 'cmpSettings', 'cmpInvoiceType'];
const run = A.run;
const W = {};
const TZ = 'Asia/Dubai';
const today = R.dayIn(TZ);
const day = n => R.addDays(today, n);

test('rules: the reminder buttons, the sends counted, the overall status', () => {
    const tz = 'Asia/Dubai', fire = R.zoned('2027-03-10', 9, 0, tz);
    const at = (ymd, h) => +R.zoned(ymd, h, 0, tz);
    assert.strictEqual(R.reminderButton({ fireAt: fire }, { tz, now: at('2027-03-09', 12) }), 'WAIT');
    assert.strictEqual(R.reminderButton({ fireAt: fire }, { tz, now: at('2027-03-10', 8) }), 'WAIT'); // (before the reminder hour)
    assert.strictEqual(R.reminderButton({ fireAt: fire }, { tz, now: at('2027-03-10', 10) }), 'DUE');
    assert.strictEqual(R.reminderButton({ fireAt: fire }, { tz, now: at('2027-03-11', 10) }), 'PENDING');
    assert.strictEqual(R.reminderButton({ fireAt: fire, sentCount: 2 }, { tz, now: at('2027-03-11', 10) }), 'SENT');
    assert.strictEqual(R.reminderButton({ fireAt: fire }, { tz, now: at('2027-03-11', 10), completed: true }), 'CLOSED');
    assert.deepStrictEqual([1, 2, 3, 4, 11, 12, 13, 21, 22].map(R.ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
    assert.deepStrictEqual([1, 2, 3].map(R.sentTimes), ['Sent', 'Sent twice', 'Sent 3 times']);
    // 3 reminders (one sent), data, task, invoice created, sent, received: 2 of 8
    const p = { reminders: [{ sentCount: 1 }, { state: 'MISSED' }, { state: 'BLEAK' }], dataCollectedOn: '2027-03-01', stage: 'DATA_COLLECTED', invoice: null };
    assert.deepStrictEqual(R.progress(p), { done: 2, total: 8 });
    // the task done before the third reminder's day: that reminder no longer counts; an issued, sent invoice: 5 of 7
    assert.deepStrictEqual(R.progress({ ...p, stage: 'COMPLETED', reminders: [{ sentCount: 1 }, { sentCount: 1 }, { state: 'CLOSED' }], invoice: { number: 'INV-1', status: 'SENT', sentAt: new Date() } }), { done: 6, total: 7 });
    // closed without an invoice: the invoice, its sending and its receipt do not count
    assert.deepStrictEqual(R.progress({ ...p, stage: 'COMPLETED', closeKind: 'FREE', reminders: [] }), { done: 2, total: 2 });
});

test('field values read as another type', () => {
    assert.strictEqual(V.convertFieldValue('DATE', 'TEXT', '2023-06-01'), '1 Jun 2023');
    assert.strictEqual(V.convertFieldValue('TEXT', 'DATE', '1 June 2023'), '2023-06-01');
    assert.strictEqual(V.convertFieldValue('TEXT', 'DATE', '01/06/2023'), '2023-06-01'); // day first
    assert.strictEqual(V.convertFieldValue('TEXT', 'DATE', '01 January to 31 December'), null);
    assert.strictEqual(V.convertFieldValue('TEXT', 'NUMBER', '1,250.50'), '1250.50');
    assert.strictEqual(V.convertFieldValue('MULTILINE', 'TEXT', 'Office 12\nDeira'), 'Office 12, Deira');
});

test('feedback 3 API: start a server, a firm with the module and its users', { timeout: 90000 }, async t => {
    if (!(await A.setup(t, { modules: ['COMPLIANCE'] }))) return;
    const set = (email, cmpPerms) => A.prisma.user.update({ where: { email }, data: { cmpPerms } });
    await set(A.owner.email, ['FULL']);
    await set(A.manager.email, ['VIEW', 'CLIENT_EDIT', 'OBLIGATION_EDIT', 'WHATSAPP', 'COMPLETE', 'REPORTS']); // no invoices
    W.tpl = (await A.call('/api/cmp/templates', { token: A.owner.token, method: 'POST', body: { name: 'Invoice', purpose: 'INVOICE', body: 'Invoice [Invoice Number]: [Invoice Amount].' } })).json;
    const mk = async (country, name, contactNumber, extra = {}) => (await A.call('/api/cmp/clients', { token: A.owner.token, method: 'POST', body: { country, name, contactNumber, portalUsername: 'u', portalPassword: 'pw-1', ...extra } })).json.client;
    W.ae = await mk('AE', 'Palm Grove Car Rental', '+971501112233', { reference: 'Mr Example' });
    W.ae2 = await mk('AE', 'Blue Sky Trading', '+971501112244', { reference: 'Mr Example' });
    W.pk = await mk('PK', 'Zeta Traders', '03001112233');
    assert.ok(W.ae && W.ae2 && W.pk, 'clients made');
});

run('a custom field: renamed and its type changed with it; the values typed before are suggested again', async () => {
    let r = await A.call('/api/cmp/fields', { token: A.owner.token, method: 'POST', body: { name: 'CT Deadline', type: 'DATE', countries: ['AE'] } });
    W.fDate = r.json;
    W.fPeriod = (await A.call('/api/cmp/fields', { token: A.owner.token, method: 'POST', body: { name: 'CT Period', type: 'TEXT', countries: ['AE'] } })).json;
    for (const c of [W.ae, W.ae2]) {
        r = await A.call(`/api/cmp/clients/${c.id}`, { token: A.owner.token, method: 'PUT', body: { fields: { [W.fDate.id]: '2023-06-01', [W.fPeriod.id]: '01 January to 31 December' } } });
        assert.strictEqual(r.status, 200, r.text);
    }
    // the date field should have been text (the CA): the type changes with the name, the dates become text
    r = await A.call(`/api/cmp/fields/${W.fDate.id}`, { token: A.owner.token, method: 'PUT', body: { name: 'CT Deadline (text)', type: 'TEXT' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.name, r.json.type], ['CT Deadline (text)', 'TEXT']);
    assert.strictEqual((await A.call(`/api/cmp/clients/${W.ae.id}`, { token: A.owner.token })).json.fields.find(f => f.id === W.fDate.id).value, '1 Jun 2023');
    // text that is not a date cannot become a date: refused, naming the clients
    r = await A.call(`/api/cmp/fields/${W.fPeriod.id}`, { token: A.owner.token, method: 'PUT', body: { type: 'DATE' } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /not a date: "01 January to 31 December" \(/);
    // back to a date: "1 Jun 2023" reads as one
    assert.strictEqual((await A.call(`/api/cmp/fields/${W.fDate.id}`, { token: A.owner.token, method: 'PUT', body: { type: 'DATE' } })).status, 200);
    assert.strictEqual((await A.prisma.cmpFieldValue.findFirst({ where: { fieldId: W.fDate.id, clientId: W.ae.id } })).value, '2023-06-01');
    // suggestions: each field's values most used first, and the references; never another country's fields
    r = await A.call('/api/cmp/fields/values?country=AE', { token: A.manager.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json.fields[W.fPeriod.id], ['01 January to 31 December']);
    assert.deepStrictEqual(r.json.reference, ['Mr Example']);
    assert.deepStrictEqual((await A.call('/api/cmp/fields/values?country=PK', { token: A.manager.token })).json.fields, {});
});

run('obligations: each with its own three reminders and messages; the same one twice is refused, even by two clicks at once', async () => {
    const due1 = day(4), q = (name, s, e, due, rems) => ({ name, periodStart: s, periodEnd: e, dueDate: due, reminders: rems });
    const items = [
        q('Value Added Tax Q1', day(-80), day(-10), due1, [{ offsetDays: -7, body: 'Dear [Client Name], [Obligation] is due on [Due Date].' }, { offsetDays: -2, body: 'Second: [Obligation], [Days Left].' }, { offsetDays: 0, body: 'Today: [Obligation].' }]),
        q('Value Added Tax Q2', day(-10), day(80), day(100), [{ offsetDays: -5, body: 'Q2 reminder for [Client Name].' }]),
    ];
    // two clicks at once: one is added, the other refused
    const both = await Promise.all([0, 1].map(() => A.call(`/api/cmp/clients/${W.ae.id}/obligations`, { token: A.manager.token, method: 'POST', body: { yearsTotal: null, items } })));
    assert.deepStrictEqual(both.map(x => x.status).sort(), [200, 409], both.map(x => x.text).join(' | '));
    assert.match(both.find(x => x.status === 409).json.error, /already has "Value Added Tax Q1"/);
    assert.strictEqual(await A.prisma.cmpObligation.count({ where: { clientId: W.ae.id } }), 2);
    W.q1 = both.find(x => x.status === 200).json.obligations[0];
    assert.deepStrictEqual(W.q1.reminders.map(r => [r.offsetDays, r.templateId, r.templateName]), [[-7, null, 'Own message'], [-2, null, 'Own message'], [0, null, 'Own message']]);
    // the same name again, whatever its case: refused; for another client: fine; renamed onto another one: refused
    let r = await A.call(`/api/cmp/clients/${W.ae.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'value added tax q1', periodStart: day(-80), periodEnd: day(-10), dueDate: due1 } });
    assert.strictEqual(r.status, 409);
    r = await A.call(`/api/cmp/clients/${W.ae2.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'Value Added Tax Q1', periodStart: day(-80), periodEnd: day(-10), dueDate: due1 } });
    assert.strictEqual(r.status, 200, r.text);
    W.other = r.json;
    const q2 = (await A.prisma.cmpObligation.findFirst({ where: { clientId: W.ae.id, name: 'Value Added Tax Q2' } }));
    assert.strictEqual((await A.call(`/api/cmp/obligations/${q2.id}`, { token: A.manager.token, method: 'PUT', body: { name: 'Value added tax Q1' } })).status, 409);
    // an archived one does not block a new one of that name
    assert.strictEqual((await A.call(`/api/cmp/obligations/${W.other.id}/archive`, { token: A.owner.token, method: 'POST' })).status, 200);
    r = await A.call(`/api/cmp/clients/${W.ae2.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'Value Added Tax Q1', periodStart: day(-80), periodEnd: day(-10), dueDate: due1 } });
    assert.strictEqual(r.status, 200, r.text);
    // a reminder with neither a message nor a template: refused, saying which
    r = await A.call(`/api/cmp/clients/${W.pk.id}/obligations`, { token: A.manager.token, method: 'POST', body: { items: [q('Sales Tax', day(-30), day(-1), day(20), [{ offsetDays: -3 }])] } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /Sales Tax.*message of the reminder 3 days before/);
    // the names used before are suggested in every country (name only outside it)
    const sug = (await A.call('/api/cmp/suggest/obligations?country=PK', { token: A.manager.token })).json;
    assert.ok(sug.some(s => s.name === 'Value Added Tax Q2' && s.otherCountry), JSON.stringify(sug));
});

run('a reminder\'s own message is what WhatsApp gets; its sends are counted, and one can be taken off', async () => {
    const occ = W.q1.occurrences[0], first = W.q1.occurrences[0].view.reminders[0]; // 7 days before the due date: its day was 3 days ago
    assert.deepStrictEqual([first.offsetDays, first.date, first.button, first.sentCount], [-7, day(-3), 'PENDING', 0]);
    let p = (await A.call('/api/cmp/messages/prepare', { token: A.manager.token, method: 'POST', body: { occurrenceId: occ.id, reminderId: first.id } })).json;
    assert.strictEqual(p.body, `Dear Palm Grove Car Rental, Value Added Tax Q1 is due on ${R.fmtDay(day(4))}.`);
    assert.strictEqual(p.templateName, '1st reminder');
    for (let i = 0; i < 2; i++) assert.strictEqual((await A.call('/api/cmp/messages', { token: A.manager.token, method: 'POST', body: { occurrenceId: occ.id, reminderId: first.id, body: p.body, phone: '+971501112233' } })).status, 200);
    const rowOf = async () => (await A.call('/api/cmp/occurrences?' + new URLSearchParams({ clientId: W.ae.id, status: 'ALL' }), { token: A.owner.token })).json.rows.find(x => x.id === occ.id);
    let row = await rowOf();
    assert.deepStrictEqual([row.view.reminders[0].button, row.view.reminders[0].sentCount], ['SENT', 2]);
    assert.strictEqual((await A.prisma.cmpMessage.findFirst({ where: { occurrenceId: occ.id }, orderBy: { createdAt: 'desc' } })).templateName, '1st reminder');
    // one did not go: taken off the count
    let r = await A.call('/api/cmp/messages/void-last', { token: A.manager.token, method: 'POST', body: { occurrenceId: occ.id, reminderId: first.id } });
    assert.strictEqual(r.status, 200, r.text);
    row = await rowOf();
    assert.deepStrictEqual([row.view.reminders[0].button, row.view.reminders[0].sentCount], ['SENT', 1]);
    // the second (2 days before the due date: in 2 days) and the third (on the due date) wait
    assert.deepStrictEqual(row.view.reminders.map(x => x.button), ['SENT', 'WAIT', 'WAIT']);
    // edited: the messages change, the days stay; the log says so
    r = await A.call(`/api/cmp/obligations/${W.q1.id}/reminders`, { token: A.manager.token, method: 'PUT', body: { reminders: [{ offsetDays: -7, body: 'Changed: [Obligation].' }, { offsetDays: -2, body: 'Second: [Obligation], [Days Left].' }] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json.reminders.map(x => [x.offsetDays, x.body]), [[-7, 'Changed: [Obligation].'], [-2, 'Second: [Obligation], [Days Left].']]);
    p = (await A.call('/api/cmp/messages/prepare', { token: A.manager.token, method: 'POST', body: { occurrenceId: occ.id, reminderId: first.id } })).json;
    assert.strictEqual(p.body, 'Changed: Value Added Tax Q1.');
});

run('the tracker: the data first, then the task (on its day); the invoice, its sending and the receipt; the overall status', async () => {
    const occ = W.q1.occurrences[0];
    let r = await A.call(`/api/cmp/occurrences/${occ.id}/complete`, { token: A.manager.token, method: 'POST', body: { on: today } });
    assert.strictEqual(r.status, 409);
    assert.match(r.json.error, /data collection first/);
    assert.strictEqual((await A.call(`/api/cmp/occurrences/${occ.id}/data`, { token: A.manager.token, method: 'POST', body: { on: day(1) } })).status, 400); // not in the future
    r = await A.call(`/api/cmp/occurrences/${occ.id}/data`, { token: A.manager.token, method: 'POST', body: { on: day(-2) } });
    assert.strictEqual(r.status, 200, r.text);
    let p = r.json.occurrences[0];
    assert.deepStrictEqual([p.stage, p.dataCollectedOn], ['DATA_COLLECTED', day(-2)]);
    assert.strictEqual((await A.call(`/api/cmp/occurrences/${occ.id}/complete`, { token: A.manager.token, method: 'POST', body: { on: day(-3) } })).status, 400); // before the data came in
    r = await A.call(`/api/cmp/occurrences/${occ.id}/complete`, { token: A.manager.token, method: 'POST', body: { on: day(-1) } });
    assert.strictEqual(r.status, 200, r.text);
    p = r.json.occurrences[0];
    assert.deepStrictEqual([p.stage, p.completedOn, p.closeKind], ['COMPLETED', day(-1), null]);
    assert.strictEqual((await A.call(`/api/cmp/occurrences/${occ.id}/data`, { token: A.manager.token, method: 'POST', body: { on: null } })).status, 409); // the task is done
    // no invoice (free work), and back
    assert.strictEqual((await A.call(`/api/cmp/occurrences/${occ.id}/billing`, { token: A.manager.token, method: 'POST', body: { mode: 'FREE' } })).json.occurrences[0].closeKind, 'FREE');
    assert.strictEqual((await A.call(`/api/cmp/occurrences/${occ.id}/billing`, { token: A.manager.token, method: 'POST', body: { mode: '' } })).json.occurrences[0].closeKind, null);
    const rowOf = async token => (await A.call('/api/cmp/occurrences?' + new URLSearchParams({ clientId: W.ae.id, status: 'ALL' }), { token: token || A.owner.token })).json.rows.find(x => x.id === occ.id);
    let row = await rowOf();
    // 2 reminders (1 sent, the other not needed any more), data, task, then the invoice to come: 3 of 6
    assert.deepStrictEqual(row.view.reminders.map(x => x.button), ['SENT', 'CLOSED']);
    assert.deepStrictEqual(row.progress, { done: 3, total: 6 });
    assert.strictEqual(row.invoice, null);
    // the preparer, who may not see fees, gets no money in the rows
    assert.strictEqual((await rowOf(A.manager.token)).invoice, null);
    W.occQ1 = occ;
});

run('advance payments, the price bank and the completed obligations on the invoice: gross, advance, net', async () => {
    // an advance of 1000 for the period, its description suggested later
    let r = await A.call('/api/cmp/advances', { token: A.owner.token, method: 'POST', body: { occurrenceId: W.occQ1.id, receivedOn: day(-5), description: 'Advance for VAT Q1', amount: '1000' } });
    assert.strictEqual(r.status, 200, r.text);
    W.adv = r.json;
    assert.deepStrictEqual([W.adv.currency, W.adv.amount, W.adv.available, W.adv.clientId], ['AED', 1000, 1000, W.ae.id]);
    assert.deepStrictEqual((await A.call('/api/cmp/advances/descriptions', { token: A.owner.token })).json, ['Advance for VAT Q1']);
    assert.strictEqual((await A.call('/api/cmp/advances', { token: A.manager.token })).status, 403); // the money is the invoice permission's
    // the client's completed obligations to bill: the Q1 period
    r = await A.call(`/api/cmp/clients/${W.ae.id}/billable`, { token: A.owner.token });
    assert.deepStrictEqual(r.json.map(b => [b.occurrenceId, b.name, b.price]), [[W.occQ1.id, 'Value Added Tax Q1', null]]);
    // a new invoice with the Q1 period and an item, kept in the price bank; an advance of 400 taken off
    r = await A.call('/api/cmp/invoices', { token: A.owner.token, method: 'POST', body: { clientId: W.ae.id } });
    W.inv = r.json;
    r = await A.call(`/api/cmp/invoices/${W.inv.id}`, { token: A.owner.token, method: 'PUT', body: {
        lines: [{ description: 'VAT Return Q1 — Mar – May', amount: '1500', occurrenceId: W.occQ1.id, save: true }, { description: 'VAT Amendment', amount: '200', save: true }],
        taxes: [{ name: 'VAT', rate: 5 }], advances: [{ advanceId: W.adv.id, amount: '400' }] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.subtotal, r.json.total, r.json.advanceAdjusted, r.json.net, r.json.outstanding], [1700, 1785, 400, 1385, 1385]);
    assert.deepStrictEqual(r.json.lines.map(l => [l.occurrenceId, l.bankName]), [[W.occQ1.id, 'Value Added Tax Q1'], [null, '']]);
    assert.deepStrictEqual(r.json.advanceDetails.map(a => [a.amount, a.adjusted]), [[1000, 400]]);
    // more than is left, or more than the gross amount: refused
    assert.strictEqual((await A.call(`/api/cmp/invoices/${W.inv.id}`, { token: A.owner.token, method: 'PUT', body: { advances: [{ advanceId: W.adv.id, amount: '1001' }] } })).status, 400);
    // the same period on a second invoice: refused; billable no longer offers it
    const second = (await A.call('/api/cmp/invoices', { token: A.owner.token, method: 'POST', body: { clientId: W.ae.id } })).json;
    r = await A.call(`/api/cmp/invoices/${second.id}`, { token: A.owner.token, method: 'PUT', body: { lines: [{ description: 'Again', amount: '1', occurrenceId: W.occQ1.id }] } });
    assert.strictEqual(r.status, 409);
    assert.deepStrictEqual((await A.call(`/api/cmp/clients/${W.ae.id}/billable`, { token: A.owner.token })).json, []);
    // the price bank: the obligation's price under its name, the item's; a new price is kept beside the old one, each with its date
    let items = (await A.call('/api/cmp/items?country=AE', { token: A.owner.token })).json;
    assert.deepStrictEqual(items.map(i => [i.name, i.prices.map(p => p.amount)]), [['VAT Amendment', [200]], ['Value Added Tax Q1', [1500]]]);
    r = await A.call(`/api/cmp/invoices/${second.id}`, { token: A.owner.token, method: 'PUT', body: { lines: [{ description: 'VAT Amendment', amount: '250', save: true }], taxes: [] } });
    assert.strictEqual(r.status, 200, r.text);
    items = (await A.call('/api/cmp/items?country=AE', { token: A.owner.token })).json;
    assert.deepStrictEqual(items.find(i => i.name === 'VAT Amendment').prices.map(p => [p.amount, p.lastOn]).sort(), [[200, today], [250, today]]);
    assert.strictEqual(items.find(i => i.name === 'VAT Amendment').amount, 250); // (the latest is suggested first)
    W.second = second;
    // issued: the advance is used now; a second invoice cannot use more than is left
    r = await A.call(`/api/cmp/invoices/${W.inv.id}/issue`, { token: A.owner.token, method: 'POST' });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.status, r.json.outstanding], ['ISSUED', 1385]);
    assert.strictEqual(Number((await A.prisma.cmpAdvance.findUnique({ where: { id: W.adv.id } })).used), 400);
    assert.strictEqual((await A.call(`/api/cmp/invoices/${second.id}`, { token: A.owner.token, method: 'PUT', body: { advances: [{ advanceId: W.adv.id, amount: '700' }] } })).status, 400);
    assert.strictEqual((await A.call(`/api/cmp/advances/${W.adv.id}/void`, { token: A.owner.token, method: 'POST', body: { reason: 'mistake' } })).status, 409); // part of it is used
    // [Invoice Amount] is the net; a receipt cannot be more than the net still owed
    const msg = (await A.call('/api/cmp/messages/prepare', { token: A.owner.token, method: 'POST', body: { kind: 'INVOICE', invoiceId: W.inv.id, templateId: W.tpl.id } })).json;
    assert.strictEqual(msg.body, `Invoice ${r.json.number}: AED 1,385.00.`);
    assert.strictEqual((await A.call(`/api/cmp/invoices/${W.inv.id}/receipts`, { token: A.owner.token, method: 'POST', body: { amount: '1386' } })).status, 400);
});

run('the tracker shows the invoice created, issued (sent twice, one taken off) and the receipt; the menu\'s created and issued lists', async () => {
    const rowOf = async () => (await A.call('/api/cmp/occurrences?' + new URLSearchParams({ clientId: W.ae.id, status: 'ALL' }), { token: A.owner.token })).json.rows.find(x => x.id === W.occQ1.id);
    let row = await rowOf();
    assert.deepStrictEqual([row.invoice.id, row.invoice.status, row.invoice.sentCount, row.invoice.advanceAdjusted], [W.inv.id, 'ISSUED', 0, 400]);
    assert.deepStrictEqual(row.advances.map(a => [a.amount, a.used]), [[1000, 400]]);
    assert.deepStrictEqual(row.progress, { done: 5, total: 7 }); // (the advance counts when there is one: the CA, 24 Nov 2026)
    const listOf = async stage => (await A.call(`/api/cmp/invoices?stage=${stage}`, { token: A.owner.token })).json.invoices.map(i => i.id);
    assert.ok((await listOf('created')).includes(W.inv.id) && !(await listOf('issued')).includes(W.inv.id));
    // sent twice on WhatsApp
    for (let i = 0; i < 2; i++) assert.strictEqual((await A.call('/api/cmp/messages', { token: A.owner.token, method: 'POST', body: { kind: 'INVOICE', invoiceId: W.inv.id, body: 'Invoice', phone: '+971501112233' } })).status, 200);
    row = await rowOf();
    assert.deepStrictEqual([row.invoice.status, row.invoice.sentCount], ['SENT', 2]);
    assert.ok((await listOf('issued')).includes(W.inv.id) && !(await listOf('created')).includes(W.inv.id));
    // both taken off: not sent any more
    for (let i = 0; i < 2; i++) assert.strictEqual((await A.call('/api/cmp/messages/void-last', { token: A.owner.token, method: 'POST', body: { invoiceId: W.inv.id } })).status, 200);
    row = await rowOf();
    assert.deepStrictEqual([row.invoice.status, row.invoice.sentCount, row.invoice.sentAt], ['ISSUED', 0, null]);
    // marked sent, then the money: the receipt, sent on WhatsApp
    await A.call(`/api/cmp/invoices/${W.inv.id}/sent`, { token: A.owner.token, method: 'POST' });
    const rc = (await A.call(`/api/cmp/invoices/${W.inv.id}/receipts`, { token: A.owner.token, method: 'POST', body: { amount: '1385', receivedOn: today } })).json;
    assert.strictEqual(rc.invoice.status, 'RECEIVED');
    await A.call('/api/cmp/messages', { token: A.owner.token, method: 'POST', body: { kind: 'RECEIPT', receiptId: rc.receiptId, body: 'Receipt', phone: '+971501112233' } });
    row = await rowOf();
    assert.deepStrictEqual([row.invoice.status, row.invoice.receipts.length, row.invoice.receipts[0].sentCount], ['RECEIVED', 1, 1]);
    assert.deepStrictEqual(row.progress, { done: 7, total: 7 });
    // cancelled (the money refunded): the advance taken off it can be used again
    const c = await A.call(`/api/cmp/invoices/${W.inv.id}/cancel`, { token: A.owner.token, method: 'POST', body: { reason: 'wrong period', settle: 'REFUND' } });
    assert.strictEqual(c.status, 200, c.text);
    assert.strictEqual(Number((await A.prisma.cmpAdvance.findUnique({ where: { id: W.adv.id } })).used), 0);
    assert.strictEqual((await A.call(`/api/cmp/clients/${W.ae.id}/billable`, { token: A.owner.token })).json.length, 1); // the period can be billed again
});

run('an invoice fully paid by advance is received when issued; the advance cannot be undone once used', async () => {
    const adv = (await A.call('/api/cmp/advances', { token: A.owner.token, method: 'POST', body: { clientId: W.ae2.id, description: 'Retainer', amount: '300' } })).json;
    const inv = (await A.call('/api/cmp/invoices', { token: A.owner.token, method: 'POST', body: { clientId: W.ae2.id } })).json;
    let r = await A.call(`/api/cmp/invoices/${inv.id}`, { token: A.owner.token, method: 'PUT', body: { lines: [{ description: 'Consultation', amount: '300' }], taxes: [], advances: [{ advanceId: adv.id, amount: '300' }] } });
    assert.deepStrictEqual([r.json.total, r.json.net, r.json.outstanding], [300, 0, 0]);
    r = await A.call(`/api/cmp/invoices/${inv.id}/issue`, { token: A.owner.token, method: 'POST' });
    assert.strictEqual(r.json.status, 'RECEIVED');
    assert.strictEqual((await A.call(`/api/cmp/advances/${adv.id}/void`, { token: A.owner.token, method: 'POST', body: { reason: 'x' } })).status, 409);
});

run('invoice formats per country: the default first, the type checked against the client\'s country, frozen when issued', async () => {
    const layout = { invoiceTitle: 'TAX INVOICE', taxLabel: 'TRN', taxNo: '100111222300003', blocks: [{ text: 'Trade licence [Client Code]', x: 120, y: -5, w: 30, size: 99, align: 'nowhere' }] };
    let r = await A.call('/api/cmp/invoice-types', { token: A.owner.token, method: 'POST', body: { name: 'UAE - Dubai', country: 'AE', isDefault: true, layout } });
    assert.strictEqual(r.status, 200, r.text);
    W.dubai = r.json;
    // the numbers are kept on the page
    assert.deepStrictEqual((({ x, y, w, size, align, doc }) => ({ x, y, w, size, align, doc }))(W.dubai.layout.blocks[0]), { x: 100, y: 0, w: 30, size: 32, align: 'left', doc: 'INVOICE' });
    W.sharjah = (await A.call('/api/cmp/invoice-types', { token: A.owner.token, method: 'POST', body: { name: 'UAE - Sharjah', country: 'AE', isDefault: true, layout: { invoiceTitle: 'INVOICE' } } })).json;
    const list = (await A.call('/api/cmp/invoice-types?country=AE', { token: A.manager.token })).json;
    assert.deepStrictEqual(list.map(t => [t.name, t.isDefault]), [['UAE - Sharjah', true], ['UAE - Dubai', false]]); // one default per country
    assert.strictEqual((await A.call('/api/cmp/invoice-types', { token: A.manager.token, method: 'POST', body: { name: 'X', country: 'AE' } })).status, 403);
    assert.strictEqual((await A.call('/api/cmp/invoice-types', { token: A.owner.token, method: 'POST', body: { name: 'UAE - Dubai', country: 'AE' } })).status, 409);
    // a new invoice starts with the country's default; another country's type is refused
    const inv = (await A.call('/api/cmp/invoices', { token: A.owner.token, method: 'POST', body: { clientId: W.ae.id } })).json;
    assert.strictEqual(inv.typeId, W.sharjah.id);
    const pkType = (await A.call('/api/cmp/invoice-types', { token: A.owner.token, method: 'POST', body: { name: 'Pakistan', country: 'PK' } })).json;
    assert.strictEqual((await A.call(`/api/cmp/invoices/${inv.id}`, { token: A.owner.token, method: 'PUT', body: { typeId: pkType.id } })).status, 400);
    r = await A.call(`/api/cmp/invoices/${inv.id}`, { token: A.owner.token, method: 'PUT', body: { typeId: W.dubai.id, lines: [{ description: 'Fee', amount: '10' }] } });
    assert.strictEqual(r.json.typeId, W.dubai.id);
    r = await A.call(`/api/cmp/invoices/${inv.id}/issue`, { token: A.owner.token, method: 'POST' });
    assert.deepStrictEqual([r.json.typeSnapshot.name, r.json.typeSnapshot.layout.invoiceTitle], ['UAE - Dubai', 'TAX INVOICE']);
    // the format changed later: the issued invoice keeps what it was printed with
    await A.call(`/api/cmp/invoice-types/${W.dubai.id}`, { token: A.owner.token, method: 'PUT', body: { layout: { invoiceTitle: 'INVOICE (NEW)' } } });
    assert.strictEqual((await A.call(`/api/cmp/invoices/${inv.id}`, { token: A.owner.token })).json.typeSnapshot.layout.invoiceTitle, 'TAX INVOICE');
});

run('a planned period opened from the tracker: new dates become the pattern from it on', async () => {
    const ob = (await A.call(`/api/cmp/clients/${W.pk.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'Income Tax Return', periodStart: '2026-07-01', periodEnd: '2027-06-30', dueDate: '2027-09-30', autoNext: false } })).json;
    let r = await A.call(`/api/cmp/obligations/${ob.id}/pattern`, { token: A.manager.token, method: 'PUT', body: { fromSeq: 1, periodStart: '2026-07-01', periodEnd: '2027-06-30', dueDate: '2027-10-15' } });
    assert.strictEqual(r.status, 409); // period 1 is there: its own dates are changed
    r = await A.call(`/api/cmp/obligations/${ob.id}/pattern`, { token: A.manager.token, method: 'PUT', body: { fromSeq: 3, periodStart: '2028-07-01', periodEnd: '2029-06-30', dueDate: '2029-10-15' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.baseSeq, r.json.baseDueDate], [3, '2029-10-15']);
    assert.deepStrictEqual(R.projectPeriods(r.json, 2, '2031-12-31').map(p => p.dueDate), ['2028-10-15', '2029-10-15', '2030-10-15', '2031-10-15']);
});

test('feedback 3 API: clean up', async () => { await A.teardown(); });
