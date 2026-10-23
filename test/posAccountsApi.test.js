// Accounts through the real server: vendors, purchase bills, cash paid and received, the cash book, who may do what, and the rules
// that keep the books honest (no overpaying a bill, no voiding a bill that has payments, numbers handed out once).
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');

const A = createApi('accts');
const run = A.run;
test('accounts API: start a server and a business', { timeout: 90000 }, async t => { await A.setup(t); });
test.after(() => A.teardown());

const M = () => ({ token: A.manager.token });
const post = (url, body, who = M()) => A.call(url, { ...who, method: 'POST', body });
const put = (url, body, who = M()) => A.call(url, { ...who, method: 'PUT', body });
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
const bill = (vendorId, over = {}) => ({ vendorId, vendorRef: 'INV-77', lines: [{ itemName: 'Flour 50kg', quantity: 4, unitCost: 5250.5 }, { itemName: 'Oil 5L', quantity: 2.5, unitCost: 1999.99 }], tax: 3500.25, ...over });

run('accounts API: only a manager (or owner) reaches any of it', async () => {
    for (const url of ['/api/pos/vendors', '/api/pos/purchases', '/api/pos/cash', '/api/pos/cashbook', '/api/pos/export/cashbook', '/api/pos/export/vendors']) {
        assert.strictEqual((await A.call(url)).status, 401, url);
        assert.strictEqual((await A.call(url, { token: A.cashier.token })).status, 403, url);
        assert.strictEqual((await A.call(url, { token: A.manager.token })).status, 200, url);
    }
    assert.strictEqual((await post('/api/pos/vendors', { name: 'X' }, { token: A.cashier.token })).status, 403);
    assert.strictEqual((await post('/api/pos/cash/receive', {}, { token: A.cashier.token })).status, 403);
    // a business without the module
    const t = await A.prisma.tenant.create({ data: { companyName: `TEST accts nopos ${A.tag}`, modules: ['INVOICING'] } });
    A.tenants.push(t.id);
    const email = `accts-nopos-${A.tag}@example.com`;
    await A.prisma.user.create({ data: { email, password: A.hash, role: 'CLIENT_USER', tenantRole: 'OWNER', tenantId: t.id } });
    const token = await A.login(email, A.password);
    assert.strictEqual((await A.call('/api/pos/vendors', { token })).status, 403);
});

run('accounts API: vendors get a code, are checked, and carry a balance', async () => {
    const v = await post('/api/pos/vendors', { name: 'Al-Noor Traders', phone: '0300-1112223', ntn: '1234567-8', openingBalance: '1500.50' });
    assert.strictEqual(v.status, 200, v.text);
    assert.strictEqual(v.json.code, 'VEN0001');
    assert.strictEqual(v.json.balance, 1500.5, 'what we owed when the books were started');
    assert.strictEqual(v.json.phone, '03001112223');
    const two = await post('/api/pos/vendors', { name: 'Second Vendor' });
    assert.strictEqual(two.json.code, 'VEN0002');
    A.v1 = v.json; A.v2 = two.json;
    for (const bad of [{ name: '' }, { name: 'x', phone: '12' }, { name: 'x', openingBalance: 'abc' }, { name: 'x', openingBalance: '1.234' }, { name: 'x', openingBalance: '9999999999999' }]) {
        const r = await post('/api/pos/vendors', bad);
        assert.strictEqual(r.status, 400, JSON.stringify(bad) + r.text);
        assert.ok(r.json.error);
    }
    const ch = await put(`/api/pos/vendors/${v.json.id}`, { address: 'Lahore' });
    assert.strictEqual(ch.json.address, 'Lahore');
    assert.strictEqual(ch.json.name, 'Al-Noor Traders', 'a change of one field keeps the others');
    const found = await A.call('/api/pos/vendors?q=noor', M());
    assert.deepStrictEqual(found.json.vendors.map(x => x.code), ['VEN0001']);
    const pct = await A.call('/api/pos/vendors?q=' + encodeURIComponent('%'), M());
    assert.strictEqual(pct.json.total, 0, 'a % in the search box is not a wildcard');
    assert.strictEqual((await put('/api/pos/vendors/nope', { name: 'x' })).status, 404);
});

run('accounts API: a purchase bill adds up to the paisa, gets a number, and raises what is owed', async () => {
    const r = await post('/api/pos/purchases', bill(A.v1.id));
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.number, 'PUR000001');
    // 4 x 5250.50 = 21002.00 ; 2.5 x 1999.99 = 4999.975 -> 4999.98 (nearest paisa) ; items 26001.98 ; tax 3500.25
    assert.deepStrictEqual(r.json.lines.map(l => l.amount), [21002, 4999.98]);
    assert.strictEqual(r.json.subtotal, 26001.98);
    assert.strictEqual(r.json.total, 29502.23);
    assert.strictEqual(r.json.status, 'UNPAID');
    assert.strictEqual(r.json.due, 29502.23);
    assert.strictEqual(r.json.date, today);
    A.bill = r.json;
    const v = await A.call(`/api/pos/vendors/${A.v1.id}`, M());
    assert.strictEqual(v.json.balance, 1500.5 + 29502.23);
    assert.strictEqual(v.json.bills.length, 1);
    assert.strictEqual((await post('/api/pos/purchases', bill(A.v1.id))).json.number, 'PUR000002');
});

run('accounts API: a bill is checked', async () => {
    const bad = async (over, re) => { const r = await post('/api/pos/purchases', bill(A.v1.id, over)); assert.strictEqual(r.status, 400, JSON.stringify(over) + r.text); assert.match(r.json.error, re); };
    await bad({ lines: [] }, /at least one line/);
    await bad({ lines: [{ itemName: '', quantity: 1, unitCost: 1 }] }, /what was bought/);
    await bad({ lines: [{ itemName: 'x', quantity: 0, unitCost: 1 }] }, /more than zero/);
    await bad({ lines: [{ itemName: 'x', quantity: 1, unitCost: -5 }] }, /number/);
    await bad({ lines: [{ itemName: 'x', quantity: 1000000, unitCost: 99999999 }] }, /too much/);
    await bad({ tax: 99999999 }, /tax on a bill cannot be more/);
    await bad({ date: '2999-01-01' }, /future/);
    await bad({ date: '2026-02-30' }, /real date/);
    await bad({ date: 'yesterday' }, /date like/);
    const none = await post('/api/pos/purchases', bill('nope'));
    assert.strictEqual(none.status, 404);
    // a switched-off vendor gets no new bills
    const off = await post('/api/pos/vendors', { name: 'Closed Co' });
    await put(`/api/pos/vendors/${off.json.id}`, { active: false });
    assert.strictEqual((await post('/api/pos/purchases', bill(off.json.id))).status, 409);
    // a bill dated in the past is fine
    const old = await post('/api/pos/purchases', bill(A.v1.id, { date: '2026-01-15', tax: 0 }));
    assert.strictEqual(old.json.date, '2026-01-15');
    assert.strictEqual(old.json.total, 26001.98);
});

run('accounts API: paying a vendor lowers what is owed, and a bill cannot be overpaid', async () => {
    const odd = await post('/api/pos/cash/pay', { vendorId: A.v1.id, purchaseId: A.bill.id, amount: '10000', method: 'barter' });
    assert.strictEqual(odd.status, 400, 'barter is not a way of paying');
    assert.match(odd.json.error, /cash, bank transfer, cheque or wallet/);
    const ok = await post('/api/pos/cash/pay', { vendorId: A.v1.id, purchaseId: A.bill.id, amount: '10000', method: 'BANK', reference: 'TRX-9' });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.json.number, 'PAY000001');
    assert.strictEqual(ok.json.purchaseNumber, 'PUR000001');
    const b = await A.call(`/api/pos/purchases/${A.bill.id}`, M());
    assert.deepStrictEqual([b.json.status, b.json.paid, b.json.due], ['PART', 10000, 19502.23]);
    const over = await post('/api/pos/cash/pay', { vendorId: A.v1.id, purchaseId: A.bill.id, amount: '19502.24' });
    assert.strictEqual(over.status, 409);
    assert.match(over.json.error, /Only 19,502.23 is still unpaid/);
    const rest = await post('/api/pos/cash/pay', { vendorId: A.v1.id, purchaseId: A.bill.id, amount: '19502.23', method: 'CASH' });
    assert.strictEqual(rest.status, 200, rest.text);
    assert.strictEqual((await A.call(`/api/pos/purchases/${A.bill.id}`, M())).json.status, 'PAID');
    // another vendor's bill, a missing vendor, a bad amount
    const bill2 = (await A.call('/api/pos/purchases?vendorId=' + A.v1.id, M())).json.purchases[0];
    assert.strictEqual((await post('/api/pos/cash/pay', { vendorId: A.v2.id, purchaseId: bill2.id, amount: '1' })).status, 404);
    assert.strictEqual((await post('/api/pos/cash/pay', { vendorId: 'nope', amount: '1' })).status, 404);
    for (const amount of ['0', '-5', 'abc', '1.234', '', '1000000000']) assert.strictEqual((await post('/api/pos/cash/pay', { vendorId: A.v1.id, amount })).status, 400, amount);
    // on account (no bill) is fine, even beyond what is owed: an advance to the vendor
    const adv = await post('/api/pos/cash/pay', { vendorId: A.v2.id, amount: '500', note: 'advance' });
    assert.strictEqual(adv.status, 200);
    assert.strictEqual((await A.call(`/api/pos/vendors/${A.v2.id}`, M())).json.balance, -500, 'paid in advance shows as a negative balance');
});

run('accounts API: voiding keeps the record, needs a reason, and puts the figures back', async () => {
    const bills = (await A.call('/api/pos/purchases?vendorId=' + A.v1.id, M())).json.purchases;
    const paidBill = bills.find(b => b.number === 'PUR000001');
    const blocked = await post(`/api/pos/purchases/${paidBill.id}/void`, { reason: 'wrong vendor' });
    assert.strictEqual(blocked.status, 409);
    assert.match(blocked.json.error, /set against this bill/);
    const pays = (await A.call('/api/pos/cash?kind=PAYMENT&vendorId=' + A.v1.id, M())).json.entries;
    assert.strictEqual((await post(`/api/pos/cash/${pays[0].id}/void`, { reason: '' })).status, 400, 'a reason is needed');
    const vd = await post(`/api/pos/cash/${pays[0].id}/void`, { reason: 'typed twice' });
    assert.strictEqual(vd.status, 200, vd.text);
    assert.strictEqual(vd.json.voided, true);
    assert.strictEqual((await post(`/api/pos/cash/${pays[0].id}/void`, { reason: 'again' })).status, 409, 'once only');
    const after = await A.call('/api/pos/cash?kind=PAYMENT&vendorId=' + A.v1.id, M());
    assert.strictEqual(after.json.entries.length, pays.length - 1, 'a voided voucher drops out of the list');
    assert.strictEqual((await A.call('/api/pos/cash?voided=all&kind=PAYMENT&vendorId=' + A.v1.id, M())).json.entries.length, pays.length, 'but is still there when asked for');
    // the bill is no longer fully paid; void the other payment too, then the bill can go
    for (const p of pays.slice(1)) await post(`/api/pos/cash/${p.id}/void`, { reason: 'test' });
    const v = await post(`/api/pos/purchases/${paidBill.id}/void`, { reason: 'wrong vendor' });
    assert.strictEqual(v.status, 200, v.text);
    assert.strictEqual(v.json.status, 'VOID');
    assert.strictEqual(v.json.voidedBy, A.manager.email);
    const vendor = (await A.call(`/api/pos/vendors/${A.v1.id}`, M())).json;
    assert.strictEqual(vendor.balance, 57004.71, 'opening 1,500.50 + PUR000002 29,502.23 + the January bill 26,001.98: the voided bill and its voided payments no longer count');
    assert.strictEqual((await post(`/api/pos/purchases/${paidBill.id}/void`, { reason: 'again' })).status, 409);
});

run('accounts API: receiving cash from a customer, an advance, and the opening balance', async () => {
    const c = (await post('/api/pos/customers', { name: 'Hall booking family', phone: '0321-5550000' }, { token: A.cashier.token })).json;
    const r = await post('/api/pos/cash/receive', { customerId: c.id, amount: '50000', method: 'CASH', note: 'banquet advance' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.number, 'RCV000001');
    assert.strictEqual(r.json.customerName, 'Hall booking family');
    const l = await A.call(`/api/pos/customers/${c.id}/ledger`, M());
    assert.deepStrictEqual([l.json.received, l.json.balance, l.json.receipts], [50000, -50000, 1], 'money held for them shows as a negative balance');
    const o = await put(`/api/pos/customers/${c.id}/opening-balance`, { openingBalance: '12000' });
    assert.strictEqual(o.status, 200, o.text);
    assert.strictEqual(o.json.balance, -38000);
    assert.strictEqual((await put(`/api/pos/customers/${c.id}/opening-balance`, { openingBalance: 'lots' })).status, 400);
    assert.strictEqual((await post('/api/pos/cash/receive', { amount: '10' })).status, 404, 'a customer is needed');
    assert.strictEqual((await post('/api/pos/cash/receive', { customerId: c.id, amount: '10', method: 'barter' })).status, 400);
    assert.strictEqual((await A.call(`/api/pos/customers/${c.id}/ledger`, { token: A.cashier.token })).status, 403);
    // the audit trail says what happened, never more than that
    const log = await A.prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: { startsWith: 'pos.cash' } } });
    assert.ok(log.some(x => /Received 50,000.00 \(Cash\) from Hall booking family/.test(x.summary)));
    A.cust = c; A.firstEntry = r.json.id;
    const one = await A.call(`/api/pos/cash/${r.json.id}`, M());
    assert.strictEqual(one.json.number, 'RCV000001');
    assert.strictEqual((await A.call('/api/pos/cash/nope', M())).status, 404);
});

run('accounts API: the cash book has an opening balance, a running balance and a closing balance that agree', async () => {
    const b = await A.call(`/api/pos/cashbook?from=${today.slice(0, 8)}01&to=${today}`, M());
    assert.strictEqual(b.status, 200, b.text);
    const live = b.json.entries;
    assert.ok(live.length >= 2);
    assert.ok(live.every(e => !e.voided), 'voided vouchers are not in the book');
    assert.strictEqual(b.json.closing, Math.round((b.json.opening + b.json.received - b.json.paid) * 100) / 100);
    assert.strictEqual(live[live.length - 1].balance, b.json.closing, 'the last running balance is the closing balance');
    const byMethod = Object.values(b.json.byMethod);
    assert.strictEqual(Math.round(byMethod.reduce((s, m) => s + m.in, 0) * 100) / 100, b.json.received);
    // a later period opens with everything before it
    const next = await A.call(`/api/pos/cashbook?from=${today}&to=${today}`, M());
    assert.ok(next.json.opening <= b.json.closing);
    const cash = await A.call(`/api/pos/cashbook?from=${today}&to=${today}&method=CASH`, M());
    assert.ok(cash.json.entries.every(e => e.method === 'CASH'));
    assert.strictEqual((await A.call('/api/pos/cashbook?from=2026-12-01&to=2026-01-01', M())).status, 400);
    const csv = await A.call(`/api/pos/export/cashbook?from=${today}&to=${today}`, M());
    assert.strictEqual(csv.status, 200);
    assert.ok(csv.text.startsWith('﻿Date,Number,Type,Party'));
    assert.match(csv.text, /Opening balance/);
    assert.match(csv.text, /Closing balance/);
    const vcsv = await A.call('/api/pos/export/vendors', M());
    assert.ok(vcsv.text.startsWith('﻿Code,Vendor,NTN'));
});

run('accounts API: the vendors list can show only those still owed, and bills can be filtered to the unpaid', async () => {
    const owing = await A.call('/api/pos/vendors?owing=1', M());
    assert.ok(owing.json.vendors.every(v => v.balance > 0));
    assert.strictEqual(owing.json.totalOwed, Math.round(owing.json.vendors.reduce((s, v) => s + v.balance * 100, 0)) / 100);
    const open = await A.call('/api/pos/purchases?status=OPEN', M());
    assert.ok(open.json.purchases.every(p => p.status === 'UNPAID' || p.status === 'PART'));
    assert.strictEqual(open.json.totals.due, Math.round(open.json.purchases.reduce((n, p) => n + p.due * 100, 0)) / 100);
});

run('accounts API: two bills made at the same moment get two numbers, and two payments cannot overpay one bill', async () => {
    const mk = () => post('/api/pos/purchases', bill(A.v2.id, { tax: 0, lines: [{ itemName: 'Race', quantity: 1, unitCost: 100 }] }));
    const both = await Promise.all([mk(), mk(), mk()]);
    assert.ok(both.every(r => r.status === 200), both.map(r => r.text).join());
    assert.strictEqual(new Set(both.map(r => r.json.number)).size, 3);
    const target = both[0].json;
    const pays = await Promise.all([1, 2, 3].map(() => post('/api/pos/cash/pay', { vendorId: A.v2.id, purchaseId: target.id, amount: '60' })));
    assert.strictEqual(pays.filter(r => r.status === 200).length, 1, 'only one 60 fits into 100');
    assert.strictEqual(pays.filter(r => r.status === 409).length, 2);
});

run('accounts API: nothing from another business is visible or changeable', async () => {
    const t = await A.prisma.tenant.create({ data: { companyName: `TEST accts other ${A.tag}`, modules: ['POS'] } });
    A.tenants.push(t.id);
    const email = `accts-other-${A.tag}@example.com`;
    await A.prisma.user.create({ data: { email, password: A.hash, role: 'CLIENT_USER', tenantRole: 'OWNER', tenantId: t.id } });
    const token = await A.login(email, A.password);
    assert.strictEqual((await A.call('/api/pos/vendors', { token })).json.total, 0);
    assert.strictEqual((await A.call(`/api/pos/vendors/${A.v1.id}`, { token })).status, 404);
    assert.strictEqual((await A.call(`/api/pos/purchases/${A.bill.id}`, { token })).status, 404);
    assert.strictEqual((await post(`/api/pos/purchases/${A.bill.id}/void`, { reason: 'mine now' }, { token })).status, 404);
    assert.strictEqual((await post('/api/pos/cash/pay', { vendorId: A.v1.id, amount: '1' }, { token })).status, 404);
    assert.strictEqual((await post('/api/pos/cash/receive', { customerId: A.cust.id, amount: '1' }, { token })).status, 404);
    assert.strictEqual((await A.call(`/api/pos/customers/${A.cust.id}/ledger`, { token })).status, 404);
    assert.strictEqual((await A.call(`/api/pos/cash/${A.firstEntry}`, { token })).status, 404);
    assert.strictEqual((await A.call('/api/pos/cashbook', { token })).json.entries.length, 0);
    // cleanup of the extra business's own rows is handled by the shared teardown
});
