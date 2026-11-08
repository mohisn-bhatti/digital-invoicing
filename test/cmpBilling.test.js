// Compliance & Deadlines, phases 2 and 3, through the real server: fee invoices with several taxes kept per country, issuing with
// gap-free numbers (also when many are issued at once), receipts and statuses, closing with or without an invoice, assignment and
// "My Tasks", bulk actions, the dashboard, calendar, reports and downloads. Needs the local database; makes its own firm and removes it.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');
const R = require('../public/cmp-rules');

const A = createApi('cmpbill');
A.models = ['cmpMessage', 'cmpReceipt', 'cmpInvoice', 'cmpTaxRate', 'cmpReminder', 'cmpOccurrence', 'cmpObligation', 'cmpFieldValue', 'cmpFieldDef', 'cmpTemplate', 'cmpClient', 'cmpSettings'];
const run = A.run;
const W = {};
const today = R.dayIn('Asia/Karachi');
const day = n => R.addDays(today, n);
const year = today.slice(0, 4);

test('billing API: start a server, a firm with the module and its users', { timeout: 90000 }, async t => {
    if (!(await A.setup(t, { modules: ['COMPLIANCE'] }))) return;
    const set = (email, cmpPerms) => A.prisma.user.update({ where: { email }, data: { cmpPerms } });
    await set(A.owner.email, ['FULL']);
    await set(A.manager.email, ['VIEW', 'CLIENT_EDIT', 'OBLIGATION_EDIT', 'WHATSAPP', 'COMPLETE', 'REPORTS']); // a preparer: no invoices
    await set(A.cashier.email, ['VIEW', 'WHATSAPP', 'INVOICE', 'REPORTS', 'EXPORT']); // billing
    W.ids = Object.fromEntries(await Promise.all(['owner', 'manager', 'cashier'].map(async k => [k, (await A.prisma.user.findUnique({ where: { email: A[k].email } })).id])));
    const tpl = await A.call('/api/cmp/templates', { token: A.owner.token, method: 'POST', body: { name: 'Invoice message', purpose: 'INVOICE', body: 'Dear [Client Name], invoice [Invoice Number] for [Invoice Amount] is attached. Receipt: [Receipt Number]' } });
    W.tpl = tpl.json;
    const mk = async (country, name, contactNumber) => (await A.call('/api/cmp/clients', { token: A.owner.token, method: 'POST', body: { country, name, contactNumber, portalUsername: 'u', portalPassword: 'p' } })).json.client;
    W.ae1 = await mk('AE', 'Dubai One LLC', '+971501110001');
    W.ae2 = await mk('AE', 'Dubai Two LLC', '+971501110002');
    W.pk = await mk('PK', 'Karachi Traders', '03001110003');
    W.kw = await mk('KW', 'Kuwait Co', '+96550001111');
    const ob = async (client, name, dueDate) => (await A.call(`/api/cmp/clients/${client.id}/obligations`, { token: A.owner.token, method: 'POST', body: { name, periodStart: day(-100), periodEnd: day(-10), dueDate } })).json;
    W.ob1 = await ob(W.ae1, 'VAT Return', day(20));
    W.ob2 = await ob(W.ae2, 'VAT Return', day(25));
    W.obPk = await ob(W.pk, 'Income Tax', day(-3));
    W.obKw = await ob(W.kw, 'Zakat', day(40));
    assert.ok(W.ob1.occurrences && W.obPk.occurrences, 'obligations made');
});

run('completing: "generate invoice" needs the invoice permission and makes a draft in the client\'s currency; "close without" makes none', async () => {
    const y1 = W.ob1.occurrences[0];
    let r = await A.call(`/api/cmp/occurrences/${y1.id}/complete`, { token: A.manager.token, method: 'POST', body: { mode: 'INVOICE' } });
    assert.strictEqual(r.status, 403);
    r = await A.call(`/api/cmp/occurrences/${y1.id}/complete`, { token: A.owner.token, method: 'POST', body: { mode: 'INVOICE' } });
    assert.strictEqual(r.status, 200, r.text);
    W.inv1 = r.json.invoiceId;
    const inv = (await A.call(`/api/cmp/invoices/${W.inv1}`, { token: A.cashier.token })).json;
    assert.deepStrictEqual([inv.status, inv.number, inv.currency, inv.lines[0].description, inv.obligation.name], ['DRAFT', null, 'AED', `VAT Return — ${R.periodName(y1)}`, 'VAT Return']);
    assert.strictEqual((await A.prisma.cmpOccurrence.findUnique({ where: { id: y1.id } })).closeKind, 'INVOICE');
    // free work for family: closed without an invoice
    r = await A.call(`/api/cmp/occurrences/${W.obKw.occurrences[0].id}/complete`, { token: A.manager.token, method: 'POST', body: { mode: 'FREE' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.invoiceId, undefined);
    assert.strictEqual((await A.prisma.cmpOccurrence.findUnique({ where: { id: W.obKw.occurrences[0].id } })).closeKind, 'FREE');
    assert.strictEqual((await A.call('/api/cmp/invoices', { token: A.manager.token })).status, 403); // the preparer sees no fees
});

run('taxes: several on one invoice, each on the subtotal; kept for the client\'s country and suggested there only', async () => {
    let r = await A.call(`/api/cmp/invoices/${W.inv1}`, { token: A.cashier.token, method: 'PUT', body: {
        lines: [{ description: 'VAT return filing', amount: '1500' }, { description: 'Data entry', amount: '250.50' }],
        taxes: [{ name: 'VAT', rate: 5, save: true }, { name: 'Municipality fee', rate: '2.5', save: true }], dueDate: day(30) } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.subtotal, r.json.taxTotal, r.json.total, r.json.taxes.map(t => t.amount)], [1750.5, 131.29, 1881.79, [87.53, 43.76]]);
    // a new draft for another UAE client suggests both; a Pakistani client's suggests none
    const d2 = (await A.call('/api/cmp/invoices', { token: A.cashier.token, method: 'POST', body: { clientId: W.ae2.id } })).json;
    assert.deepStrictEqual(d2.taxes.map(t => `${t.name} ${t.rate}`).sort(), ['Municipality fee 2.5', 'VAT 5']);
    W.inv2 = d2.id;
    const dpk = (await A.call('/api/cmp/invoices', { token: A.cashier.token, method: 'POST', body: { clientId: W.pk.id } })).json;
    assert.deepStrictEqual([dpk.currency, dpk.taxes], ['PKR', []]);
    W.invPk = dpk.id;
    assert.deepStrictEqual((await A.call('/api/cmp/taxes?country=PK', { token: A.cashier.token })).json, []);
    assert.strictEqual((await A.call('/api/cmp/taxes?country=AE', { token: A.cashier.token })).json.length, 2);
    // a Kuwaiti invoice has 3 decimals; more is refused
    const dkw = (await A.call('/api/cmp/invoices', { token: A.cashier.token, method: 'POST', body: { clientId: W.kw.id } })).json;
    assert.strictEqual(dkw.currency, 'KWD');
    r = await A.call(`/api/cmp/invoices/${dkw.id}`, { token: A.cashier.token, method: 'PUT', body: { lines: [{ description: 'Fee', amount: '10.1234' }] } });
    assert.strictEqual(r.status, 400);
    r = await A.call(`/api/cmp/invoices/${dkw.id}`, { token: A.cashier.token, method: 'PUT', body: { lines: [{ description: 'Fee', amount: '10.125' }], currency: 'KWD' } });
    assert.strictEqual(r.json.total, 10.125);
    W.invKw = dkw.id;
    assert.strictEqual((await A.call(`/api/cmp/invoices/${dkw.id}`, { token: A.cashier.token, method: 'PUT', body: { currency: 'XXX' } })).status, 400);
    assert.strictEqual((await A.call(`/api/cmp/invoices/${dkw.id}`, { token: A.cashier.token, method: 'PUT', body: { taxes: [{ name: 'VAT', rate: 150 }] } })).status, 400);
});

run('issuing: the next number, never twice even when many are issued at once; an issued invoice no longer changes', async () => {
    assert.strictEqual((await A.call(`/api/cmp/invoices/${W.inv2}/issue`, { token: A.cashier.token, method: 'POST' })).status, 400); // the fee is still zero
    let r = await A.call(`/api/cmp/invoices/${W.inv1}/issue`, { token: A.cashier.token, method: 'POST' });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.number, r.json.status, r.json.issueDate], [`INV-${year}-0001`, 'ISSUED', today]);
    assert.strictEqual((await A.call(`/api/cmp/invoices/${W.inv1}`, { token: A.cashier.token, method: 'PUT', body: { notes: 'x' } })).status, 409);
    assert.strictEqual((await A.call(`/api/cmp/invoices/${W.inv1}`, { token: A.cashier.token, method: 'DELETE' })).status, 409);
    assert.strictEqual((await A.call(`/api/cmp/invoices/${W.inv1}/issue`, { token: A.cashier.token, method: 'POST' })).status, 409);
    // 12 drafts issued at the same moment: 12 different consecutive numbers
    const drafts = [];
    for (let i = 0; i < 12; i++) drafts.push((await A.call('/api/cmp/invoices', { token: A.cashier.token, method: 'POST', body: { clientId: W.pk.id, lines: [{ description: `Fee ${i}`, amount: 1000 + i }] } })).json.id);
    const issued = await Promise.all(drafts.map(id => A.call(`/api/cmp/invoices/${id}/issue`, { token: A.cashier.token, method: 'POST' })));
    assert.ok(issued.every(x => x.status === 200), issued.map(x => x.text).join('\n'));
    const nums = issued.map(x => Number(x.json.number.slice(-4))).sort((a, b) => a - b);
    assert.deepStrictEqual(nums, Array.from({ length: 12 }, (_, i) => i + 2));
    // a draft can be deleted
    assert.strictEqual((await A.call(`/api/cmp/invoices/${W.invPk}`, { token: A.cashier.token, method: 'DELETE' })).status, 200);
    assert.ok(await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'cmp.invoice.issue', summary: { contains: `INV-${year}-0001` } } }));
});

run('WhatsApp on an invoice and a receipt: the numbers and amount are filled in; sending the invoice marks it sent', async () => {
    let r = await A.call('/api/cmp/messages/prepare', { token: A.cashier.token, method: 'POST', body: { invoiceId: W.inv1, templateId: W.tpl.id } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.kind, r.json.body], ['INVOICE', `Dear Dubai One LLC, invoice INV-${year}-0001 for AED 1,881.79 is attached. Receipt: `]);
    assert.deepStrictEqual(r.json.empty, ['Receipt Number']);
    r = await A.call('/api/cmp/messages', { token: A.cashier.token, method: 'POST', body: { invoiceId: W.inv1, templateId: W.tpl.id, body: r.json.body, phone: r.json.phone } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual((await A.call(`/api/cmp/invoices/${W.inv1}`, { token: A.cashier.token })).json.status, 'SENT');
    assert.strictEqual((await A.call('/api/cmp/messages/prepare', { token: A.cashier.token, method: 'POST', body: { invoiceId: W.inv2 } })).status, 409); // a draft cannot be sent
});

run('receipts: partly received, then received; too much is refused; a voided receipt puts the money back; cancelling keeps the number', async () => {
    let r = await A.call(`/api/cmp/invoices/${W.inv1}/receipts`, { token: A.cashier.token, method: 'POST', body: { amount: '1000', method: 'BANK', reference: 'TT-123' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.invoice.status, r.json.invoice.received, r.json.invoice.outstanding, r.json.invoice.receipts[0].number], ['PARTIAL', 1000, 881.79, `RCT-${year}-0001`]);
    const firstReceipt = r.json.receiptId;
    r = await A.call(`/api/cmp/invoices/${W.inv1}/receipts`, { token: A.cashier.token, method: 'POST', body: { amount: '900' } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /more than is still owed \(AED 881\.79\)/);
    r = await A.call(`/api/cmp/invoices/${W.inv1}/receipts`, { token: A.cashier.token, method: 'POST', body: { amount: '881.79', method: 'CASH' } });
    assert.deepStrictEqual([r.json.invoice.status, r.json.invoice.outstanding], ['RECEIVED', 0]);
    assert.strictEqual((await A.call(`/api/cmp/invoices/${W.inv1}/receipts`, { token: A.cashier.token, method: 'POST', body: { amount: 1 } })).status, 409);
    // a receipt message
    r = await A.call('/api/cmp/messages/prepare', { token: A.cashier.token, method: 'POST', body: { receiptId: firstReceipt, templateId: W.tpl.id } });
    assert.strictEqual(r.json.kind, 'RECEIPT');
    assert.ok(r.json.body.endsWith(`Receipt: RCT-${year}-0001`));
    // cancelling with money received is refused; void the receipts first
    assert.strictEqual((await A.call(`/api/cmp/invoices/${W.inv1}/cancel`, { token: A.cashier.token, method: 'POST', body: { reason: 'wrong client' } })).status, 409);
    assert.strictEqual((await A.call(`/api/cmp/receipts/${firstReceipt}/void`, { token: A.cashier.token, method: 'POST', body: {} })).status, 400); // a reason is needed
    r = await A.call(`/api/cmp/receipts/${firstReceipt}/void`, { token: A.cashier.token, method: 'POST', body: { reason: 'bounced' } });
    assert.deepStrictEqual([r.json.status, r.json.received], ['PARTIAL', 881.79]);
    const second = r.json.receipts.find(x => !x.voidedAt).id;
    await A.call(`/api/cmp/receipts/${second}/void`, { token: A.cashier.token, method: 'POST', body: { reason: 'entered twice' } });
    r = await A.call(`/api/cmp/invoices/${W.inv1}/cancel`, { token: A.cashier.token, method: 'POST', body: { reason: 'wrong client' } });
    assert.deepStrictEqual([r.json.status, r.json.number, r.json.cancelReason], ['CANCELLED', `INV-${year}-0001`, 'wrong client']);
    assert.deepStrictEqual((await A.call('/api/cmp/receipts', { token: A.cashier.token })).json.map(x => Boolean(x.voidedAt)), [true, true]);
});

run('assignment and My Tasks: the obligation\'s person, else the client\'s; only the firm\'s own team', async () => {
    let r = await A.call(`/api/cmp/clients/${W.ae2.id}`, { token: A.owner.token, method: 'PUT', body: { assignedToId: W.ids.manager } });
    assert.strictEqual(r.status, 200, r.text);
    r = await A.call(`/api/cmp/obligations/${W.obPk.id}`, { token: A.owner.token, method: 'PUT', body: { assignedToId: W.ids.manager } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual((await A.call(`/api/cmp/clients/${W.pk.id}`, { token: A.owner.token, method: 'PUT', body: { assignedToId: '00000000-0000-0000-0000-000000000000' } })).status, 400);
    r = await A.call('/api/cmp/my-tasks', { token: A.manager.token });
    const names = rows => [...new Set(rows.map(x => x.client.name))].sort();
    assert.deepStrictEqual(names(r.json.rows), ['Dubai Two LLC', 'Karachi Traders']); // every open period of theirs (year 2 was prepared too)
    assert.deepStrictEqual(r.json.clients.map(c => c.name), ['Dubai Two LLC']);
    assert.strictEqual((await A.call('/api/cmp/my-tasks', { token: A.owner.token })).json.rows.length, 0);
    assert.deepStrictEqual(names((await A.call('/api/cmp/occurrences?assignee=none', { token: A.owner.token })).json.rows), ['Dubai One LLC', 'Kuwait Co']);
    assert.deepStrictEqual((await A.call(`/api/cmp/clients?assignee=${W.ids.manager}`, { token: A.owner.token })).json.clients.map(c => c.name), ['Dubai Two LLC']);
});

run('bulk: next period for several clients of one country; the step for many; archive each with its own history line', async () => {
    // year 1 of each UAE VAT has confirmed dates and its year 2 was prepared already (the period was over): confirm year 2 of one, leave the other
    const y2 = async ob => (await A.call(`/api/cmp/obligations/${ob.id}`, { token: A.owner.token })).json.occurrences.find(o => o.seq === 2);
    const a2 = await y2(W.ob1), b2 = await y2(W.ob2);
    await A.call(`/api/cmp/occurrences/${a2.id}`, { token: A.owner.token, method: 'PUT', body: { confirm: true } });
    let r = await A.call('/api/cmp/bulk/next-period', { token: A.manager.token, method: 'POST', body: { obligationIds: [W.ob1.id, W.ob2.id, W.obPk.id] } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /one country/);
    r = await A.call('/api/cmp/bulk/next-period', { token: A.manager.token, method: 'POST', body: { obligationIds: [W.ob1.id, W.ob2.id] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.done.length, r.json.skipped.length, r.json.skipped[0].reason], [1, 1, "the last period's dates are not confirmed yet"]);
    assert.strictEqual((await A.call('/api/cmp/bulk/next-period', { token: A.cashier.token, method: 'POST', body: { obligationIds: [W.ob1.id] } })).status, 403);
    // the step for several periods at once (a completed one is skipped)
    r = await A.call('/api/cmp/bulk/stage', { token: A.manager.token, method: 'POST', body: { occurrenceIds: [b2.id, W.obPk.occurrences[0].id, W.ob1.occurrences[0].id], stage: 'DATA_COLLECTED' } });
    assert.deepStrictEqual([r.json.done.length, r.json.skipped.map(s => s.reason)], [2, ['already completed']]);
    // bulk assign needs the right permission for what is assigned
    assert.strictEqual((await A.call('/api/cmp/bulk/assign', { token: A.cashier.token, method: 'POST', body: { clientIds: [W.pk.id], userId: W.ids.cashier } })).status, 403);
    r = await A.call('/api/cmp/bulk/assign', { token: A.manager.token, method: 'POST', body: { clientIds: [W.pk.id, W.ae1.id], userId: W.ids.cashier } });
    assert.strictEqual(r.json.done, 2);
    // archive two clients: each gets its own line in its history
    assert.strictEqual((await A.call('/api/cmp/bulk/archive', { token: A.manager.token, method: 'POST', body: { clientIds: [W.kw.id] } })).status, 403);
    r = await A.call('/api/cmp/bulk/archive', { token: A.owner.token, method: 'POST', body: { clientIds: [W.kw.id] } });
    assert.strictEqual(r.json.done, 1);
    assert.ok(await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'cmp.client.archive', entityId: W.kw.id } }));
    await A.call(`/api/cmp/clients/${W.kw.id}/restore`, { token: A.owner.token, method: 'POST' });
});

run('dashboard, calendar and reports: windows of days; overdue first; invoice aging by currency (with the invoice permission only)', async () => {
    assert.strictEqual((await A.call('/api/cmp/dashboard', { token: W.viewer || A.manager.token })).status, 200);
    let r = await A.call('/api/cmp/dashboard?days=7', { token: A.owner.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.days, r.json.summary.overdue, r.json.overdue.map(x => x.client.name)], [7, 1, ['Karachi Traders']]);
    assert.ok(r.json.upcoming.every(x => x.dueDate <= day(7)));
    const r30 = (await A.call('/api/cmp/dashboard?days=30', { token: A.owner.token })).json;
    assert.deepStrictEqual(r30.upcoming.map(x => x.client.name).sort(), ['Dubai Two LLC']);
    assert.ok(r30.byCountry.some(c => c.country === 'PK' && c.overdue === 1));
    assert.ok(Array.isArray(r30.unpaid)); // the owner has the invoice permission
    assert.strictEqual((await A.call('/api/cmp/dashboard?days=7', { token: A.manager.token })).json.unpaid, null);
    assert.strictEqual((await A.call('/api/cmp/dashboard?days=999', { token: A.owner.token })).status, 400);
    // calendar
    assert.strictEqual((await A.call(`/api/cmp/calendar?from=${day(0)}&to=${day(90)}`, { token: A.owner.token })).status, 400);
    r = await A.call(`/api/cmp/calendar?from=${day(-10)}&to=${day(30)}`, { token: A.manager.token });
    assert.ok(r.json.rows.some(x => x.client.name === 'Karachi Traders' && x.view.overdue));
    // reports
    assert.deepStrictEqual((await A.call('/api/cmp/reports/overdue', { token: A.manager.token })).json.rows.map(x => x.obligation.name), ['Income Tax']);
    assert.strictEqual((await A.call('/api/cmp/reports/aging', { token: A.manager.token })).status, 403);
    r = await A.call('/api/cmp/reports/aging', { token: A.cashier.token });
    assert.strictEqual(r.status, 200, r.text);
    const pkr = r.json.totals.find(t => t.currency === 'PKR');
    assert.deepStrictEqual([pkr.count, pkr['0-30'], pkr.total], [12, 12066, 12066]); // the 12 issued at once: 1000 … 1011
    assert.strictEqual((await A.call('/api/cmp/reports/nothing', { token: A.cashier.token })).status, 400);
});

run('downloads: need the export permission and the permission for that data; follow the filters; never contain passwords; logged', async () => {
    assert.strictEqual((await A.call('/api/cmp/export/clients', { token: A.manager.token })).status, 403); // no EXPORT
    let r = await A.call('/api/cmp/export/clients?country=AE', { token: A.cashier.token });
    assert.strictEqual(r.status, 200, r.text);
    const lines = r.text.replace(/^﻿/, '').trim().split('\r\n');
    assert.strictEqual(lines.length, 3); // header + the two UAE clients
    assert.ok(!/portal|password/i.test(r.text));
    assert.ok(await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'cmp.export.clients' } }));
    r = await A.call('/api/cmp/export/invoices?status=UNPAID', { token: A.cashier.token });
    assert.strictEqual(r.text.replace(/^﻿/, '').trim().split('\r\n').length, 13);
    // the owner has EXPORT through full access; a user with EXPORT but not INVOICE cannot download invoices
    await A.prisma.user.update({ where: { email: A.manager.email }, data: { cmpPerms: ['VIEW', 'EXPORT'] } });
    assert.strictEqual((await A.call('/api/cmp/export/invoices', { token: A.manager.token })).status, 403);
    assert.strictEqual((await A.call('/api/cmp/export/obligations?status=OVERDUE', { token: A.manager.token })).text.split('\r\n').filter(Boolean).length, 2);
    assert.strictEqual((await A.call('/api/cmp/export/aging', { token: A.manager.token })).status, 403);
    for (const k of ['receipts', 'overdue', 'upcoming', 'aging']) assert.strictEqual((await A.call(`/api/cmp/export/${k}`, { token: A.owner.token })).status, 200, k);
});

run('WhatsApp numbers the firm sends from: with a country code; one default; the log keeps which one was used', async () => {
    let r = await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { waSenders: [{ label: 'Business', phone: '0333 1234567', open: 'WEB' }] } });
    assert.strictEqual(r.status, 400); // no country code: it could be anyone's
    assert.match(r.json.error, /country code/);
    r = await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { waSenders: [{ label: 'Business WhatsApp', phone: '+92 333 1234567', open: 'WEB' }, { label: 'Dubai office', phone: '00971 50 000 2222', open: 'BUSINESS', isDefault: true }] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json.waSenders.map(s => [s.label, s.phone, s.open, s.isDefault]), [['Business WhatsApp', '+923331234567', 'WEB', false], ['Dubai office', '+971500002222', 'BUSINESS', true]]);
    assert.strictEqual((await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { waSenders: [{ label: 'a', phone: '+923331234567' }, { label: 'b', phone: '+92 333 1234567' }] } })).status, 400);
    const pkBiz = r.json.waSenders[0];
    // sent from the chosen number; without a choice, from the default one
    r = await A.call('/api/cmp/messages', { token: A.cashier.token, method: 'POST', body: { kind: 'OTHER', clientId: W.ae1.id, body: 'Hello  \nthere', phone: '+971501110001', fromId: pkBiz.id } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.open, r.json.from.phone, r.json.text], ['WEB', '+923331234567', 'Hello\nthere']);
    r = await A.call('/api/cmp/messages', { token: A.cashier.token, method: 'POST', body: { kind: 'OTHER', clientId: W.ae1.id, body: 'Hi', phone: '+971501110001' } });
    assert.deepStrictEqual([r.json.open, r.json.from.label], ['BUSINESS', 'Dubai office']);
    assert.strictEqual((await A.call('/api/cmp/messages', { token: A.cashier.token, method: 'POST', body: { kind: 'OTHER', clientId: W.ae1.id, body: 'Hi', phone: '+971501110001', fromId: 'nope' } })).status, 400);
    const log = (await A.call(`/api/cmp/messages?clientId=${W.ae1.id}`, { token: A.owner.token })).json.messages;
    assert.deepStrictEqual(log.slice(0, 2).map(m => m.fromPhone), ['+971500002222', '+923331234567']);
});

run('settings: the firm\'s invoice details and number formats', async () => {
    let r = await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { firmName: 'Bhatti & Co Chartered Accountants', firmTaxNo: '100000000000003', bankDetails: 'Bank: X\nIBAN: AE00', invoiceFormat: 'BC/{YY}/{NNN}' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.firmName, r.json.bankDetails, r.json.invoiceFormat], ['Bhatti & Co Chartered Accountants', 'Bank: X\nIBAN: AE00', 'BC/{YY}/{NNN}']);
    assert.strictEqual((await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { invoiceFormat: 'NO-NUMBER' } })).status, 400);
    const d = (await A.call('/api/cmp/invoices', { token: A.cashier.token, method: 'POST', body: { clientId: W.ae1.id, lines: [{ description: 'Advisory', amount: 100 }] } })).json;
    r = await A.call(`/api/cmp/invoices/${d.id}/issue`, { token: A.cashier.token, method: 'POST' });
    assert.strictEqual(r.json.number, `BC/${year.slice(2)}/014`); // the counter carries on
});
test.after(() => A.teardown());
