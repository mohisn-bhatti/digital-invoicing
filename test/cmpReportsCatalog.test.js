// Compliance & Deadlines: the Reports page's catalogue (the CA's reports sheet of 24 Nov 2026), through the real server.
// - every report of the catalogue answers with its columns, with and without filters
// - the numbers that matter: issued invoices and their taxes (with a discount), item- and tax-wise totals, the invoice sequence (a gap
//   and a duplicate), an amended invoice, advances and their allocation, receivables, collections, unallocated money, reminders (sent on
//   WhatsApp, given by phone, marked not sent), data quality and the history of a client
// - who sees what: no money reports without the invoice permission, no history without the logs permission; a download is a CSV
// Needs the local database; makes its own firm (made-up names only) and removes it.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');
const R = require('../public/cmp-rules');

const A = createApi('cmpcat');
A.models = ['cmpNotification', 'cmpMessage', 'cmpReceipt', 'cmpInvoice', 'cmpAdvance', 'cmpCredit', 'cmpTaxRate', 'cmpItemPrice', 'cmpItem', 'cmpObligationTemplate', 'cmpReminder',
    'cmpOccurrence', 'cmpObligation', 'cmpFieldValue', 'cmpFieldDef', 'cmpTemplate', 'cmpClient', 'cmpSettings', 'cmpInvoiceType'];
const run = A.run;
const W = {};
const today = R.dayIn('Asia/Dubai'); // (the clients' own calendar)
const day = n => R.addDays(today, n);
const RANGE = `from=${day(-400)}&to=${day(400)}`;
const post = (url, body, token = A.owner.token) => A.call(url, { token, method: 'POST', body });
const put = (url, body, token = A.owner.token) => A.call(url, { token, method: 'PUT', body });
const must = async (p, what) => { const r = await p; assert.strictEqual(r.status, 200, `${what}: ${r.text}`); return r.json; };
const report = (key, q = RANGE, token = A.owner.token) => A.call(`/api/cmp/catalog/${key}?${q}`, { token });
const ok = async (key, q, token) => must(report(key, q, token), key);
const aed = d => d.totals.find(t => t.currency === 'AED') || {};

test('catalogue API: start a server, a firm with the module and its users', { timeout: 90000 }, async t => {
    if (!(await A.setup(t, { modules: ['COMPLIANCE'] }))) return;
    await A.prisma.user.update({ where: { email: A.owner.email }, data: { cmpPerms: ['FULL'] } });
    await A.prisma.user.update({ where: { email: A.manager.email }, data: { cmpPerms: ['REPORTS', 'EXPORT'] } }); // no money, no logs
    await A.prisma.user.update({ where: { email: A.cashier.email }, data: { cmpPerms: ['REPORTS', 'LOGS'] } }); // the logs, no money, no downloads
});

run('a firm with clients, obligations, reminders, an advance, invoices, receipts and a credit', async () => {
    W.field = await must(post('/api/cmp/fields', { name: 'Trade Licence No', type: 'TEXT', countries: ['AE'] }), 'field');
    const tpl = (name, purpose, extra = {}) => A.prisma.cmpTemplate.create({ data: { tenantId: A.tenantId, name, purpose, body: 'Dear [Client Name], [Obligation] is due on [Due Date].', ...extra } });
    W.tR1 = await tpl('First reminder', 'REMINDER_1');
    W.tOld = await tpl('Old wording', 'REMINDER'); // made before the three reminders were told apart
    W.tRetired = await tpl('Retired receipt note', 'RECEIPT', { active: false });
    await must(post('/api/cmp/invoice-types', { name: 'UAE invoice', country: 'AE', isDefault: true }), 'format');
    W.vat = await must(post('/api/cmp/taxes', { name: 'VAT', rate: 5, countries: ['AE'], type: 'Output VAT' }), 'tax');
    W.stamp = await must(post('/api/cmp/taxes', { name: 'Stamp', rate: 1, countries: ['AE'] }), 'tax 2');
    W.oldItem = await must(post('/api/cmp/items', { name: 'Old Service', currency: 'AED', amount: '50', countries: ['AE'] }), 'item');

    const client = async body => (await must(post('/api/cmp/clients', { country: 'AE', portalUsername: 'user', portalPassword: 'pw-1', ...body }), body.name)).client;
    W.c1 = await client({ name: 'Cedar Lane Trading', contactNumber: '+971501112233', email: 'accounts@cedar.example', registrationNo: 'TRN-100', fields: { [W.field.id]: 'TL-12345' } });
    W.c2 = await client({ name: 'Cedar  Lane  trading', contactNumber: '+971502223344', noPortal: true });
    W.c4 = await client({ name: 'Harbor Point Studio', contactNumber: '+971503334455' });
    W.c5 = await client({ country: 'SA', name: 'Oasis Ridge Consulting', contactNumber: '+966501234567' });
    W.c3 = await client({ country: 'SA', name: 'Dune Valley Services', contactNumber: '+966507654321' });
    // details that the screens would refuse, as older data may have them
    await A.prisma.cmpClient.update({ where: { id: W.c2.id }, data: { contactNumber: '12', email: 'broken@' } });
    await must(post(`/api/cmp/clients/${W.c3.id}/archive`), 'archive');

    const obs = await must(post(`/api/cmp/clients/${W.c1.id}/obligations`, { frequency: 'YEARLY', items: [
        { name: 'VAT Return', periodStart: day(-100), periodEnd: day(-30), dueDate: day(-5), reminders: [{ offsetDays: -10, templateId: W.tR1.id }, { offsetDays: 0, body: 'Today is the day.' }] },
        { name: 'Corporate Tax', periodStart: day(-200), periodEnd: day(-20), dueDate: day(20), reminders: [{ offsetDays: -30, templateId: W.tR1.id }] },
        { name: 'Audit Fee', periodStart: day(-120), periodEnd: day(-40), dueDate: day(-20), reminders: [] },
    ] }), 'obligations');
    [W.vat, W.ct, W.audit] = obs.obligations;
    await must(post(`/api/cmp/clients/${W.c4.id}/obligations`, { name: 'Licence Renewal', periodStart: day(-60), periodEnd: day(10), dueDate: day(30), reminders: [] }), 'obligation c4');
    await A.prisma.cmpObligationTemplate.create({ data: { tenantId: A.tenantId, obligationId: W.audit.id, kind: 'RECEIPT', templateId: W.tRetired.id } });

    // reminders: one sent on WhatsApp then marked not sent, one given by phone, one sent on WhatsApp
    const vatOcc = W.vat.occurrences[0], [r10, r0] = [...W.vat.reminders].sort((a, b) => a.offsetDays - b.offsetDays);
    const m = await must(post('/api/cmp/messages', { occurrenceId: vatOcc.id, reminderId: r10.id, body: 'Your VAT return is due.', phone: '+971501112233' }), 'send');
    await must(post(`/api/cmp/messages/${m.message.id}/void`), 'void');
    await must(post('/api/cmp/messages/manual', { occurrenceId: vatOcc.id, reminderId: r0.id, channel: 'PHONE', note: 'Called the accountant' }), 'by phone');
    await must(post('/api/cmp/messages', { occurrenceId: W.ct.occurrences[0].id, reminderId: W.ct.reminders[0].id, body: 'Corporate tax is coming.', phone: '+971501112233' }), 'send 2');

    const auditOcc = W.audit.occurrences[0];
    await must(post(`/api/cmp/occurrences/${auditOcc.id}/data`, { on: day(-22) }), 'data');
    await must(post(`/api/cmp/occurrences/${auditOcc.id}/complete`, { on: day(-21), mode: 'TASK' }), 'complete');

    W.adv = await must(post('/api/cmp/advances', { clientId: W.c1.id, description: 'Retainer', amount: '200', receivedOn: day(-30), method: 'CASH' }), 'advance');
    const draft = body => must(post('/api/cmp/invoices', { currency: 'AED', taxes: [], ...body }), 'invoice');
    const issue = id => must(post(`/api/cmp/invoices/${id}/issue`), 'issue');
    // A: 1,000 + 500, less a discount of 100, VAT 5% on 1,400 = 70, total 1,470; an advance of 150 taken off; 1,000 received
    W.A = await draft({ clientId: W.c1.id, issueDate: day(-10), dueDate: day(-3), discount: '100', taxes: [{ name: 'VAT', rate: 5 }], advances: [{ advanceId: W.adv.id, amount: '150' }],
        lines: [{ description: 'Audit Fee FY', amount: '1000', occurrenceId: auditOcc.id, bankName: 'Audit Fee' }, { description: 'Bookkeeping', amount: '500', bankName: 'Bookkeeping' }] });
    assert.deepStrictEqual([W.A.subtotal, W.A.taxTotal, W.A.total, W.A.advanceAdjusted], [1500, 70, 1470, 150]);
    await issue(W.A.id);
    await must(post(`/api/cmp/invoices/${W.A.id}/sent`), 'sent');
    await must(post(`/api/cmp/invoices/${W.A.id}/receipts`, { amount: '1000', receivedOn: day(-8), method: 'BANK' }), 'receipt');
    // B (400) cancelled and made again as C (450) for the same period: an amended invoice
    W.B = await draft({ clientId: W.c1.id, issueDate: day(-9), lines: [{ description: 'VAT Return', amount: '400', occurrenceId: vatOcc.id, bankName: 'VAT Return' }] });
    await issue(W.B.id);
    await must(post(`/api/cmp/invoices/${W.B.id}/cancel`, { reason: 'Wrong amount' }), 'cancel B');
    W.C = await draft({ clientId: W.c1.id, issueDate: day(-7), lines: [{ description: 'VAT Return', amount: '450', occurrenceId: vatOcc.id, bankName: 'VAT Return' }] });
    await issue(W.C.id);
    // D1 and D2: the same client, total and date (a duplicate)
    W.D1 = await draft({ clientId: W.c2.id, issueDate: day(-2), lines: [{ description: 'Bookkeeping', amount: '100' }] });
    await issue(W.D1.id);
    W.D2 = await draft({ clientId: W.c2.id, issueDate: day(-2), lines: [{ description: 'Bookkeeping', amount: '100' }] });
    await issue(W.D2.id);
    // F: paid, then cancelled with the money kept as the client's credit
    W.F = await draft({ clientId: W.c4.id, issueDate: day(-3), lines: [{ description: 'Setup', amount: '200' }] });
    await issue(W.F.id);
    await must(post(`/api/cmp/invoices/${W.F.id}/receipts`, { amount: '200', receivedOn: day(-1), method: 'BANK' }), 'receipt F');
    await must(post(`/api/cmp/invoices/${W.F.id}/cancel`, { reason: 'Scope changed', settle: 'CREDIT' }), 'cancel F');
    // a draft with an item and a tax that are then retired
    W.E = await draft({ clientId: W.c4.id, lines: [{ description: 'Old Service', amount: '50', bankName: 'Old Service' }], taxes: [{ name: 'Stamp', rate: 1 }] });
    await must(put(`/api/cmp/items/${W.oldItem.id}`, { active: false }), 'retire item');
    await must(put(`/api/cmp/taxes/${W.stamp.id}`, { active: false }), 'retire tax');
    // the running numbers: 1 A, 2 B, 3 C, 4 D1, 5 D2, 6 F → D2 given 4 again (a duplicate) and F 8 (5, 6 and 7 missing)
    const seq = async id => (await A.prisma.cmpInvoice.findUnique({ where: { id } })).seqNo;
    assert.deepStrictEqual(await Promise.all([W.A, W.B, W.C, W.D1, W.D2, W.F].map(i => seq(i.id))), [1, 2, 3, 4, 5, 6]);
    await A.prisma.cmpInvoice.update({ where: { id: W.D2.id }, data: { seqNo: 4 } });
    await A.prisma.cmpInvoice.update({ where: { id: W.F.id }, data: { seqNo: 8 } });
    // a change with its old and new values (and a password that must never show)
    await A.prisma.auditLog.create({ data: { tenantId: A.tenantId, userEmail: A.owner.email, action: 'cmp.client.update', entityType: 'CmpClient', entityId: W.c1.id, summary: 'Client Cedar Lane Trading: email, password changed',
        details: { clientId: W.c1.id, changes: [{ field: 'Email', old: 'old@cedar.example', new: 'accounts@cedar.example' }, { field: 'Portal password', old: 'pw-0', new: 'pw-1' }] } } });
});

run('every report of the catalogue answers with its columns, with and without filters', async () => {
    const cat = await must(A.call('/api/cmp/catalog', { token: A.owner.token }), 'catalogue');
    const keys = cat.categories.flatMap(c => c.reports.map(r => r.key));
    // the 76 of the CA's reports sheet, and the 14 of the Comprehensive Dashboard SRS (section 5) in their 4 categories
    assert.strictEqual(cat.categories.length, 18);
    assert.strictEqual(keys.length, 90);
    assert.strictEqual(new Set(keys).size, 90);
    for (const key of keys) {
        for (const q of [RANGE, '', `${RANGE}&country=AE&clientId=${W.c1.id}`]) {
            const d = await ok(key, q);
            assert.ok(d.title && d.columns.length, key);
            for (const c of d.columns) assert.ok(['text', 'day', 'at', 'money', 'number'].includes(c.type), `${key}: ${c.key} ${c.type}`);
            assert.ok(Array.isArray(d.rows) && Array.isArray(d.totals), key);
            // money is always with its currency, and never added across currencies
            if (d.columns.some(c => c.type === 'money')) for (const r of d.rows) assert.ok(r.currency || r[(d.columns.find(c => c.cur) || {}).cur], `${key}: a row without its currency`);
            assert.strictEqual(new Set(d.totals.map(t => t.currency || '')).size, d.totals.length, `${key}: one total line per currency`);
        }
    }
    assert.strictEqual((await report('nope')).status, 404);
    assert.strictEqual((await report('obligation-register', 'status=NOPE')).status, 400);
    assert.strictEqual((await report('obligation-register', 'from=2026-13-01')).status, 400);
});

run('clients and obligations: active, inactive, overdue, upcoming, completed, performance', async () => {
    let d = await ok('clients-active', '');
    assert.ok(!d.rows.some(r => r.name === 'Dune Valley Services'), 'an archived client is not active');
    assert.strictEqual(d.rows.find(r => r.code === W.c1.code).overdue, 1);
    d = await ok('clients-inactive', '');
    assert.deepStrictEqual(d.rows.map(r => r.name), ['Dune Valley Services']);
    d = await ok('client-register', '');
    assert.strictEqual(d.rows.find(r => r.name === 'Dune Valley Services').status, 'Inactive (archived)');
    d = await ok('obligations-overdue', '');
    assert.deepStrictEqual(d.rows.map(r => [r.obligation, r.days]), [['VAT Return', 5]]);
    d = await ok('obligations-upcoming', 'days=30');
    assert.ok(d.rows.some(r => r.obligation === 'Corporate Tax' && r.days === 20), JSON.stringify(d.rows));
    d = await ok('obligations-completed');
    assert.deepStrictEqual(d.rows.map(r => [r.obligation, r.completedOn, r.timing]), [['Audit Fee', day(-21), 'On time']]);
    d = await ok('obligation-performance', `from=${day(-30)}&to=${day(30)}`);
    const c1 = d.rows.find(r => r.name.startsWith('Cedar Lane Trading'));
    assert.deepStrictEqual([c1.total, c1.completed, c1.pending, c1.overdue, c1.rate], [3, 1, 1, 1, 33.3]); // (Audit Fee done, Corporate Tax pending, VAT overdue)
    assert.deepStrictEqual(['total', 'completed', 'rate'].map(k => d.totals[0][k]), [4, 1, 25]); // (and Licence Renewal of another client)
    d = await ok('obligation-performance', `${RANGE}&group=obligation`);
    assert.deepStrictEqual(['total', 'completed'].map(k => d.rows.find(r => r.name === 'Audit Fee')[k]), [2, 1]); // (and its next period)
});

run('invoices issued: register, summary, customer-, item- and tax-wise, sequence, amended, cancelled', async () => {
    let d = await ok('issued-register');
    assert.deepStrictEqual(d.rows.map(r => r.invoice).sort(), [W.A, W.C, W.D1, W.D2].map(i => i.id).map(id => d.rows.find(r => r._link.invoice === id).invoice).sort());
    assert.strictEqual(d.rows.length, 4);
    assert.deepStrictEqual(['amount', 'discount', 'tax', 'total'].map(k => aed(d)[k]), [2150, 100, 70, 2120]);
    d = await ok('invoice-summary', `${RANGE}&group=currency`);
    const s = d.rows.find(r => r.currency === 'AED');
    assert.deepStrictEqual([s.count, s.taxable, s.tax, s.total, s.advance, s.received, s.outstanding], [4, 2050, 70, 2120, 150, 1000, 970]);
    d = await ok('invoices-by-customer');
    assert.deepStrictEqual(['count', 'amount', 'tax', 'total'].map(k => d.rows.find(r => r.client.startsWith('Cedar Lane Trading'))[k]), [2, 1850, 70, 1920]);
    d = await ok('invoices-by-item');
    const item = name => d.rows.find(r => r.item === name);
    assert.deepStrictEqual([item('Audit Fee').amount, item('Audit Fee').tax, item('Audit Fee').total], [1000, 46.67, 1046.67]);
    assert.deepStrictEqual([item('Bookkeeping').quantity, item('Bookkeeping').invoices, item('Bookkeeping').amount, item('Bookkeeping').tax], [3, 3, 700, 23.33]);
    assert.strictEqual(aed(d).tax, 70, 'the shares of tax add up to the tax');
    d = await ok('invoices-by-tax');
    assert.deepStrictEqual(d.rows.map(r => [r.tax, r.rate, r.invoices, r.taxable, r.amount]), [['No tax', null, 3, 650, 0], ['VAT', 5, 1, 1400, 70]]);
    assert.strictEqual(aed(d).amount, 70);
    d = await ok('tax-summary');
    assert.strictEqual(d.rows.find(r => r.tax === 'VAT').type, 'Output VAT');
    d = await ok('tax-transactions');
    assert.deepStrictEqual(d.rows.map(r => [r.tax, r.taxable, r.amount]), [['VAT', 1400, 70]]);
    d = await ok('invoice-sequence');
    assert.deepStrictEqual(d.rows.filter(r => r.check === 'Missing').map(r => r.seqNo), [5, 6, 7]);
    assert.strictEqual(d.rows.filter(r => r.check === 'Duplicate number').length, 2);
    assert.deepStrictEqual(d.cards.map(c => c.value), [6, 3, 2]);
    d = await ok('invoices-amended');
    const B = await A.prisma.cmpInvoice.findUnique({ where: { id: W.B.id } }), C = await A.prisma.cmpInvoice.findUnique({ where: { id: W.C.id } });
    assert.deepStrictEqual(d.rows.map(r => [r.original, r.originalTotal, r.revised, r.revisedTotal, r.difference, r.reason]), [[B.number, 400, C.number, 450, 50, 'Wrong amount']]);
    d = await ok('invoices-cancelled');
    assert.deepStrictEqual(d.rows.map(r => r.settlement).sort(), ['', 'Kept as the client\'s credit']);
    d = await ok('invoice-register');
    assert.ok(d.rows.some(r => r.status === 'Draft' && r._void), 'the draft is listed, not counted');
    assert.strictEqual(aed(d).total, 2120);
    d = await ok('invoices-draft', '');
    assert.deepStrictEqual(d.rows.map(r => [r.client.startsWith('Harbor Point Studio'), r.amount]), [[true, 50]]);
    d = await ok('invoice-status');
    assert.deepStrictEqual(Object.fromEntries(d.cards.map(c => [c.label, c.value])), { Draft: 1, Issued: 3, 'Partially received': 1, Cancelled: 2 });
});

run('advances, receipts, receivables and collections', async () => {
    let d = await ok('advance-register');
    assert.deepStrictEqual(d.rows.map(r => [r.number, r.amount, r.method, r.status]), [[W.adv.number, 200, 'Cash', 'Partly adjusted']]);
    assert.ok(/^ADV-/.test(W.adv.number), 'the advance has its receipt number');
    d = await ok('advance-balance', '');
    assert.deepStrictEqual(['received', 'adjusted', 'remaining'].map(k => d.rows[0][k]), [200, 150, 50]);
    d = await ok('advance-allocation');
    assert.deepStrictEqual(d.rows.map(r => [r.advance, r.allocated, r.balance]), [[W.adv.number, 150, 50]]);
    d = await ok('advance-unallocated', '');
    assert.deepStrictEqual(d.rows.map(r => r.balance), [50]);
    d = await ok('receipt-register');
    assert.strictEqual(d.rows.length, 2);
    assert.strictEqual(aed(d).amount, 1000, 'money kept as credit is not counted twice');
    d = await ok('receipts-by-method');
    assert.deepStrictEqual(d.rows.map(r => [r.method, r.of, r.amount]), [['Bank transfer', 'Receipts', 1000], ['Cash', 'Advance payments', 200]]);
    d = await ok('collection-summary');
    assert.deepStrictEqual(['received', 'advances', 'total'].map(k => aed(d)[k]), [1000, 200, 1200]);
    d = await ok('receipts-unallocated', '');
    assert.deepStrictEqual(d.rows.map(r => [r.client.slice(0, 5), r.source, r.balance]), [['Cedar', 'Advance payment', 50], ['Harbo', 'Client credit', 200]]);
    d = await ok('receipts-by-invoice');
    const a = d.rows.find(r => r._link.invoice === W.A.id);
    assert.deepStrictEqual([a.total, a.advance, a.count, a.paid, a.balance], [1470, 150, 1, 1000, 320]);
    d = await ok('receivables-outstanding', '');
    assert.strictEqual(aed(d).outstanding, 970);
    d = await ok('receivables-overdue', '');
    assert.deepStrictEqual(d.rows.map(r => [r.balance, r.days]), [[320, 3]]);
    d = await ok('receivables-aging', '');
    assert.strictEqual(aed(d).balance, 970);
    d = await ok('customer-balance');
    const c1 = d.rows.find(r => r.client.startsWith('Cedar Lane Trading'));
    assert.deepStrictEqual([c1.invoiced, c1.received, c1.balance], [1920, 1150, 770]);
    d = await ok('collection-status');
    assert.deepStrictEqual(['invoiced', 'collected', 'outstanding', 'overdue'].map(k => d.rows[0][k]), [2120, 1150, 650, 320]);
});

run('reminders: register, history, performance, template usage', async () => {
    let d = await ok('reminder-performance');
    const t = d.totals[0];
    assert.deepStrictEqual([t.whatsapp, t.other, t.failed, t.pending], [1, 1, 1, 0]);
    assert.strictEqual(t.total, 3 + t.scheduled); // (the next periods' reminders are still to come)
    d = await ok('reminder-register');
    const ct = d.rows.find(r => r.obligation === 'Corporate Tax' && r.status.startsWith('Sent'));
    assert.deepStrictEqual([ct.channel, ct.template], ['WhatsApp', 'First reminder']);
    assert.ok(d.rows.some(r => r.obligation === 'VAT Return' && /marked not sent/.test(r.status)));
    assert.ok(d.rows.some(r => r.obligation === 'VAT Return' && r.channel === 'Phone call'));
    d = await ok('reminder-history', RANGE, A.cashier.token);
    assert.deepStrictEqual(d.rows.map(r => r.status.split(' ')[0]).sort(), ['Failed', 'Given', 'Handed']);
    d = await ok('reminder-template-usage');
    const first = d.rows.find(r => r.template === 'First reminder');
    assert.deepStrictEqual([first.uses, first.voided, first.channels], [1, 1, 'WhatsApp 1']);
    assert.strictEqual(d.rows.find(r => r.template === 'Old wording').uses, 0);
    d = await ok('template-usage');
    assert.ok(d.rows.some(r => r.template === 'Retired receipt note' && r.uses === 0 && r.status === 'Retired'));
});

run('data quality, additional information and history', async () => {
    let d = await ok('client-quality', '');
    const c2 = d.rows.filter(r => r.code === W.c2.code).map(r => `${r.kind}: ${r.check}`).sort();
    assert.deepStrictEqual(c2, ['Duplicate: Same name', 'Incomplete: Additional information', 'Invalid: Contact number', 'Invalid: Email', 'Missing: Registration No.']);
    assert.ok(d.rows.some(r => r.code === W.c4.code && r.check === 'Email' && r.kind === 'Missing'));
    d = await ok('dq-duplicates', '');
    assert.deepStrictEqual(d.rows.map(r => `${r.area}: ${r.check}`).sort(), ['Clients: Same name', 'Clients: Same name', 'Invoices: Same client, total and date', 'Invoices: Same client, total and date']);
    d = await ok('dq-duplicates', '', A.manager.token);
    assert.ok(!d.rows.some(r => r.area === 'Invoices'), 'no invoices for those who may not see them');
    d = await ok('dq-config', '');
    const issues = d.rows.map(r => `${r.check} | ${r.record}`);
    for (const want of ['No default invoice format | Saudi Arabia', 'Template category not chosen | Old wording', 'Retired item still on a draft invoice', 'Retired tax still on a draft invoice', 'Message uses a retired template | Audit Fee']) assert.ok(issues.some(x => x.startsWith(want)), `${want}\n${issues.join('\n')}`);
    assert.ok(issues.some(x => /^Obligation with no reminders \| Licence Renewal/.test(x)));
    assert.ok(!issues.some(x => x === 'No default invoice format | United Arab Emirates'));
    d = await ok('dq-config', '', A.manager.token);
    assert.ok(!d.rows.some(r => ['Items', 'Taxes'].includes(r.area)), 'items and taxes are checked for those who may see them');
    d = await ok('dq-summary', '');
    assert.ok(d.cards.find(c => c.label === 'Duplicate').value >= 4);
    d = await ok('field-missing', '');
    assert.deepStrictEqual(d.rows.map(r => r.code).sort(), [W.c2.code, W.c4.code].sort());
    d = await ok('field-usage', '');
    assert.deepStrictEqual(['clients', 'populated', 'blank'].map(k => d.rows[0][k]), [3, 1, 2]);
    // history, read from the activity log: old and new values, a password never shown
    d = await ok('client-history', RANGE, A.cashier.token);
    const email = d.rows.find(r => r.field === 'Email');
    assert.deepStrictEqual([email.old, email.new], ['old@cedar.example', 'accounts@cedar.example']);
    assert.deepStrictEqual(['old', 'new'].map(k => d.rows.find(r => r.field === 'Portal password')[k]), ['••••', '••••']);
    d = await ok('audit-trail', RANGE, A.cashier.token);
    assert.ok(d.rows.some(r => r.module === 'Invoices' && r.action === 'Cancelled'));
    d = await ok('records-created', `${RANGE}&module=clients`, A.cashier.token);
    assert.ok(d.rows.length >= 5 && d.rows.every(r => r.module === 'Clients'));
    assert.ok(d.rows.some(r => r.record === `Client Cedar Lane Trading (${W.c1.code})`));
    d = await ok('records-modified', RANGE, A.cashier.token);
    assert.ok(d.rows.some(r => r.action === 'Archived'));
    assert.ok(!d.rows.some(r => r.action === 'Created'));
});

run('who sees what: money only with the invoice permission, history only with the logs permission; downloads', async () => {
    const keysOf = async token => (await must(A.call('/api/cmp/catalog', { token }), 'catalogue')).categories.flatMap(c => c.reports.map(r => r.key));
    const mgr = await keysOf(A.manager.token), csh = await keysOf(A.cashier.token);
    for (const k of ['issued-register', 'receipt-register', 'advance-balance', 'receivables-aging', 'invoice-register', 'tax-summary', 'item-register', 'format-usage']) {
        assert.ok(!mgr.includes(k), `${k} is not listed without the invoice permission`);
        assert.strictEqual((await report(k, RANGE, A.manager.token)).status, 403, k);
    }
    for (const k of ['client-history', 'obligation-history', 'reminder-history', 'audit-trail', 'user-activity', 'records-deleted', 'template-history']) {
        assert.ok(!mgr.includes(k), `${k} is not listed without the logs permission`);
        assert.strictEqual((await report(k, RANGE, A.manager.token)).status, 403, k);
        assert.ok(csh.includes(k), k);
    }
    assert.ok(!csh.includes('invoice-history-created') && !csh.includes('advance-history'));
    assert.strictEqual((await report('invoice-history-created', RANGE, A.cashier.token)).status, 403);
    assert.ok(mgr.includes('client-register') && mgr.includes('dq-summary') && mgr.includes('template-register'));
    assert.ok(!(await must(A.call('/api/cmp/catalog', { token: A.manager.token }), 'catalogue')).categories.some(c => ['Invoices Issued', 'Receivables', 'Audit & Activity'].includes(c.title)));

    // downloads: the export permission and the report's own
    let r = await A.call(`/api/cmp/catalog/client-register/export?country=AE`, { token: A.manager.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.ok(r.text.startsWith('﻿Code,Client,Registration No.,Contact number,Email,Country,Status'), r.text.slice(0, 80));
    assert.ok(r.text.includes('Cedar Lane Trading') && !r.text.includes('Oasis Ridge'));
    assert.strictEqual((await A.call(`/api/cmp/catalog/issued-register/export?${RANGE}`, { token: A.manager.token })).status, 403);
    assert.strictEqual((await A.call(`/api/cmp/catalog/client-register/export`, { token: A.cashier.token })).status, 403);
    r = await A.call(`/api/cmp/catalog/issued-register/export?${RANGE}`, { token: A.owner.token });
    assert.strictEqual(r.status, 200, r.text);
    const lines = r.text.replace('﻿', '').trim().split('\r\n');
    assert.strictEqual(lines[0], 'Invoice no.,Issue date,Client,Client registration no.,Currency,Amount,Discount,Charges,Tax,Total,Sent,Status');
    assert.strictEqual(lines.length, 1 + 4 + 2);
    assert.ok(lines[lines.length - 1].startsWith('Total AED · 4 invoices,,,,AED,2150.00,100.00,0.00,70.00,2120.00'), lines[lines.length - 1]);
    const logged = await A.prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: 'cmp.export.report' } });
    assert.deepStrictEqual(logged.map(l => l.details.report).sort(), ['client-register', 'issued-register']);
});

test('catalogue API: clean up', async () => { await A.teardown(); });
