// Compliance & Deadlines: the CA's items 14–27 of 20 November 2026, through the real server.
// - the client's obligations edited together: each with its own settings (person, years, amber, by itself), and a lock against changes
// - notes with the data collection and the task
// - the tracker in pages (25, 50, …), a smart search (words, and "overdue", "locked"…)
// - an advance recorded from the invoice shows on the period; an advance can be changed (never below what is taken off)
// - an item or a tax at a new price or rate: both kept
// - receipt formats per country, frozen on the receipt
// Needs the local database; makes its own firm and removes it.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');
const R = require('../public/cmp-rules');

const A = createApi('cmpfb4');
A.models = ['cmpMessage', 'cmpReceipt', 'cmpInvoice', 'cmpAdvance', 'cmpCredit', 'cmpTaxRate', 'cmpItemPrice', 'cmpItem', 'cmpReminder', 'cmpOccurrence', 'cmpObligation', 'cmpFieldValue', 'cmpFieldDef', 'cmpTemplate', 'cmpClient', 'cmpSettings', 'cmpInvoiceType'];
const run = A.run;
const W = {};
const today = R.dayIn('Asia/Dubai');
const day = n => R.addDays(today, n);
const rows = async (q, token) => (await A.call('/api/cmp/occurrences?' + new URLSearchParams(q), { token: token || A.owner.token })).json;

test('feedback 4 API: start a server, a firm with the module and its users', { timeout: 90000 }, async t => {
    if (!(await A.setup(t, { modules: ['COMPLIANCE'] }))) return;
    await A.prisma.user.update({ where: { email: A.owner.email }, data: { cmpPerms: ['FULL'] } });
    await A.prisma.user.update({ where: { email: A.manager.email }, data: { cmpPerms: ['VIEW', 'OBLIGATION_EDIT', 'COMPLETE', 'ARCHIVE'] } });
    const r = await A.call('/api/cmp/clients', { token: A.owner.token, method: 'POST', body: { country: 'AE', name: 'Palm Grove Trading', contactNumber: '+971501112233', portalUsername: 'u', portalPassword: 'pw-1' } });
    W.c = r.json.client;
    W.manager = (await A.prisma.user.findUnique({ where: { email: A.manager.email } })).id;
    assert.ok(W.c, r.text);
});

run('several obligations at once, each with its own settings; the lock keeps one from being changed, archived or deleted', async () => {
    const it = (name, due, extra = {}) => ({ name, periodStart: R.addDays(due, -90), periodEnd: R.addDays(due, -30), dueDate: due, ...extra });
    let r = await A.call(`/api/cmp/clients/${W.c.id}/obligations`, { token: A.owner.token, method: 'POST', body: { frequency: 'YEARLY', items: [
        it('VAT Return Q1', day(10), { yearsTotal: 3, amberDays: 14, autoNext: false, assignedToId: W.manager, portalUrl: 'https://eservices.tax.gov.ae/', notes: 'Q1 notes' }),
        it('Corporate Tax', day(40), { locked: true }),
    ] } });
    assert.strictEqual(r.status, 200, r.text);
    const [q1, ct] = r.json.obligations;
    assert.deepStrictEqual([q1.yearsTotal, q1.amberDays, q1.autoNext, q1.assignedToId, q1.portalUrl, q1.notes, q1.locked], [3, 14, false, W.manager, 'https://eservices.tax.gov.ae/', 'Q1 notes', false]);
    assert.deepStrictEqual([ct.yearsTotal, ct.amberDays, ct.autoNext, ct.assignedToId, ct.locked], [null, 7, true, null, true]);
    W.q1 = q1; W.ct = ct;
    // locked: no change of any kind, no archive, no delete
    const refused = async (url, method, body) => { const x = await A.call(url, { token: A.manager.token, method, body }); assert.strictEqual(x.status, 409, `${method} ${url}: ${x.text}`); assert.match(x.json.error, /is locked/); };
    await refused(`/api/cmp/obligations/${ct.id}`, 'PUT', { name: 'Corporate Tax 2' });
    await refused(`/api/cmp/obligations/${ct.id}/reminders`, 'PUT', { reminders: [{ offsetDays: -5, body: 'x' }] });
    await refused(`/api/cmp/occurrences/${ct.occurrences[0].id}`, 'PUT', { dueDate: day(45) });
    await refused(`/api/cmp/obligations/${ct.id}/pattern`, 'PUT', { fromSeq: 2, periodStart: day(300), periodEnd: day(330), dueDate: day(400) });
    await refused(`/api/cmp/obligations/${ct.id}/archive`, 'POST');
    await refused(`/api/cmp/obligations/${ct.id}/delete`, 'POST', {});
    // the work on it goes on (data, notes)
    assert.strictEqual((await A.call(`/api/cmp/occurrences/${ct.occurrences[0].id}`, { token: A.manager.token, method: 'PUT', body: { notes: 'waiting for the client' } })).status, 200);
    // unlocked and changed in one go; then locked again
    r = await A.call(`/api/cmp/obligations/${ct.id}`, { token: A.manager.token, method: 'PUT', body: { locked: false, name: 'Corporate Tax Return' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.name, r.json.locked], ['Corporate Tax Return', false]);
    r = await A.call(`/api/cmp/obligations/${ct.id}`, { token: A.manager.token, method: 'PUT', body: { amberDays: 10, locked: true } });
    assert.deepStrictEqual([r.json.amberDays, r.json.locked], [10, true]);
    const log = await A.prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: 'cmp.obligation.update' }, orderBy: { createdAt: 'asc' } });
    assert.ok(log.some(l => /unlocked/.test(l.summary)) && log.some(l => / locked/.test(l.summary)), log.map(l => l.summary).join(' | '));
});

run('notes with the data collection and the task; changed later', async () => {
    const occ = W.q1.occurrences[0];
    let r = await A.call(`/api/cmp/occurrences/${occ.id}/data`, { token: A.manager.token, method: 'POST', body: { on: today, note: 'bank statements still to come' } });
    assert.strictEqual(r.status, 200, r.text);
    r = await A.call(`/api/cmp/occurrences/${occ.id}/complete`, { token: A.manager.token, method: 'POST', body: { on: today, note: 'filed on the portal' } });
    assert.strictEqual(r.status, 200, r.text);
    let p = r.json.occurrences.find(x => x.id === occ.id);
    assert.deepStrictEqual([p.dataNote, p.taskNote], ['bank statements still to come', 'filed on the portal']);
    r = await A.call(`/api/cmp/occurrences/${occ.id}`, { token: A.manager.token, method: 'PUT', body: { dataNote: 'all received', taskNote: '' } });
    p = r.json.occurrences.find(x => x.id === occ.id);
    assert.deepStrictEqual([p.dataNote, p.taskNote], ['all received', '']);
    const row = (await rows({ clientId: W.c.id, status: 'ALL' })).rows.find(x => x.id === occ.id);
    assert.strictEqual(row.dataNote, 'all received');
    W.occ = occ;
});

run('the tracker in pages, and a smart search', async () => {
    // more obligations: 12 in all
    const items = Array.from({ length: 10 }, (_, i) => ({ name: `Licence ${String(i + 1).padStart(2, '0')}`, periodStart: day(-60 + i), periodEnd: day(-20 + i), dueDate: day(i === 0 ? -1 : 50 + i) }));
    assert.strictEqual((await A.call(`/api/cmp/clients/${W.c.id}/obligations`, { token: A.owner.token, method: 'POST', body: { items } })).status, 200);
    // (each licence's period is over, so its next one is prepared by itself: 1 + 1 + 10 × 2 periods)
    const all = await rows({ clientId: W.c.id, status: 'ALL', limit: 5 });
    assert.deepStrictEqual([all.total, all.rows.length, all.offset, all.limit], [22, 5, 0, 5]);
    const pages = [all];
    for (let off = 5; off < all.total; off += 5) pages.push(await rows({ clientId: W.c.id, status: 'ALL', limit: 5, offset: off }));
    assert.deepStrictEqual(pages.map(p => p.rows.length), [5, 5, 5, 5, 2]);
    const ids = pages.flatMap(p => p.rows.map(r => r.id));
    assert.strictEqual(new Set(ids).size, 22, 'every period once across the pages');
    const dues = pages.flatMap(p => p.rows.map(r => r.dueDate));
    assert.deepStrictEqual(dues, [...dues].sort(), 'still by due date across pages');
    // only the money of the page is looked up: a page without the invoice permission has none
    assert.ok(all.rows.every(r => r.progress), 'each row of the page has its overall status');
    // smart search: words, and status words
    const names = async q => [...new Set((await rows({ clientId: W.c.id, status: 'ALL', q })).rows.map(r => r.obligation.name))].sort();
    assert.deepStrictEqual(await names('licence 03'), ['Licence 03']);
    assert.deepStrictEqual(await names('overdue'), ['Licence 01']);
    assert.deepStrictEqual(await names('locked'), ['Corporate Tax Return']);
    assert.deepStrictEqual(await names('completed vat'), ['VAT Return Q1']);
});

run('an advance recorded from the invoice shows on the period; an advance changes, never below what is taken off', async () => {
    const inv = (await A.call('/api/cmp/invoices', { token: A.owner.token, method: 'POST', body: { occurrenceId: W.occ.id } })).json;
    const adv = (await A.call('/api/cmp/advances', { token: A.owner.token, method: 'POST', body: { clientId: W.c.id, description: 'Cash', amount: '100' } })).json;
    assert.strictEqual(adv.occurrenceId, null);
    let r = await A.call(`/api/cmp/invoices/${inv.id}`, { token: A.owner.token, method: 'PUT', body: { lines: [{ description: 'VAT Return Q1', amount: '500', occurrenceId: W.occ.id }], taxes: [], advances: [{ advanceId: adv.id, amount: '60' }] } });
    assert.strictEqual(r.status, 200, r.text);
    const row = (await rows({ clientId: W.c.id, status: 'ALL' })).rows.find(x => x.id === W.occ.id);
    assert.deepStrictEqual(row.advances.map(a => [a.id, a.amount]), [[adv.id, 100]]);
    assert.deepStrictEqual([row.invoice.total, row.invoice.advanceAdjusted, row.invoice.outstanding], [500, 60, 440]);
    // changed while nothing is used yet; once used, not below what is used
    r = await A.call(`/api/cmp/advances/${adv.id}`, { token: A.owner.token, method: 'PUT', body: { amount: '120', description: 'Cash advance', receivedOn: day(-2) } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.amount, r.json.description, r.json.receivedOn], [120, 'Cash advance', day(-2)]);
    assert.strictEqual((await A.call(`/api/cmp/invoices/${inv.id}/issue`, { token: A.owner.token, method: 'POST' })).status, 200);
    r = await A.call(`/api/cmp/advances/${adv.id}`, { token: A.owner.token, method: 'PUT', body: { amount: '50' } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /cannot be less/);
    assert.strictEqual((await A.call(`/api/cmp/advances/${adv.id}`, { token: A.owner.token, method: 'PUT', body: { currency: 'USD' } })).status, 409);
    assert.strictEqual((await A.call(`/api/cmp/advances/${adv.id}`, { token: A.manager.token, method: 'PUT', body: { amount: '200' } })).status, 403);
    W.inv = inv;
});

run('an item or a tax at a new price or rate: both are kept', async () => {
    let r = await A.call('/api/cmp/items', { token: A.owner.token, method: 'POST', body: { name: 'Professional fee', currency: 'AED', amount: '5', countries: ['AE'] } });
    assert.strictEqual(r.status, 200, r.text);
    r = await A.call('/api/cmp/items', { token: A.owner.token, method: 'POST', body: { name: 'professional fee', currency: 'AED', amount: '10', countries: ['AE'] } });
    assert.strictEqual(r.status, 409);
    assert.match(r.json.error, /already there in AED \(AED 5\.00\)/);
    r = await A.call('/api/cmp/items', { token: A.owner.token, method: 'POST', body: { name: 'professional fee', currency: 'AED', amount: '10', countries: ['AE'], addPrice: true } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.amount, r.json.prices.map(p => p.amount).sort((a, b) => a - b)], [10, [5, 10]]);
    // a tax: VAT 5%, then 15% beside it (the old one stays)
    const vat = (await A.call('/api/cmp/taxes', { token: A.owner.token, method: 'POST', body: { name: 'VAT', rate: 5, countries: ['AE'] } })).json;
    r = await A.call(`/api/cmp/taxes/${vat.id}`, { token: A.owner.token, method: 'PUT', body: { name: 'VAT', rate: 15, countries: ['AE'], keepOld: true } });
    assert.strictEqual(r.status, 200, r.text);
    const list = (await A.call('/api/cmp/taxes?country=AE', { token: A.owner.token })).json;
    assert.deepStrictEqual(list.map(t => [t.name, t.rate]), [['VAT', 5], ['VAT', 15]]);
});

run('receipt formats per country, the default first; frozen on the receipt; an invoice takes only an invoice format', async () => {
    let r = await A.call('/api/cmp/invoice-types', { token: A.owner.token, method: 'POST', body: { name: 'UAE receipt', kind: 'RECEIPT', country: 'AE', isDefault: true, layout: { receiptTitle: 'RECEIPT VOUCHER', receiptNote: 'Subject to realisation.' } } });
    assert.strictEqual(r.status, 200, r.text);
    W.rcType = r.json;
    assert.strictEqual(W.rcType.kind, 'RECEIPT');
    const inv1 = (await A.call('/api/cmp/invoice-types', { token: A.owner.token, method: 'POST', body: { name: 'UAE invoice', country: 'AE', isDefault: true, layout: { invoiceTitle: 'TAX INVOICE' } } })).json;
    // one default per country and kind: both stay defaults
    const list = (await A.call('/api/cmp/invoice-types?country=AE', { token: A.manager.token })).json;
    assert.deepStrictEqual(list.map(t => [t.kind, t.name, t.isDefault]), [['INVOICE', 'UAE invoice', true], ['RECEIPT', 'UAE receipt', true]]);
    assert.deepStrictEqual((await A.call('/api/cmp/invoice-types?kind=RECEIPT', { token: A.manager.token })).json.map(t => t.name), ['UAE receipt']);
    // a receipt: the country's default receipt format, frozen on it
    r = await A.call(`/api/cmp/invoices/${W.inv.id}/receipts`, { token: A.owner.token, method: 'POST', body: { amount: '40' } });
    assert.strictEqual(r.status, 200, r.text);
    const rc = r.json.invoice.receipts[0];
    assert.deepStrictEqual([rc.typeId, rc.typeSnapshot.layout.receiptTitle], [W.rcType.id, 'RECEIPT VOUCHER']);
    // an invoice format on a receipt, or a receipt format on an invoice: refused
    assert.strictEqual((await A.call(`/api/cmp/invoices/${W.inv.id}/receipts`, { token: A.owner.token, method: 'POST', body: { amount: '1', typeId: inv1.id } })).status, 400);
    const draft = (await A.call('/api/cmp/invoices', { token: A.owner.token, method: 'POST', body: { clientId: W.c.id } })).json;
    assert.strictEqual(draft.typeId, inv1.id, 'a new invoice starts with the invoice format, not the receipt one');
    assert.strictEqual((await A.call(`/api/cmp/invoices/${draft.id}`, { token: A.owner.token, method: 'PUT', body: { typeId: W.rcType.id } })).status, 400);
});

test('feedback 4 API: clean up', async () => { await A.teardown(); });
