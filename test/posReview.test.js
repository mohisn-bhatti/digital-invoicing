// Regression tests for what a detailed review of the accounts / debit note / tax-inclusive / phone / rate-schedule work found. Each one failed before its fix.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');

const A = createApi('review');
const run = A.run;
test('review: start a server and a business', { timeout: 90000 }, async t => { await A.setup(t); });
test.after(async () => {
    if (A.ok) { await A.prisma.taxRate.deleteMany({ where: { code: { startsWith: '989999' } } }); if (A.admin) await A.prisma.user.deleteMany({ where: { email: A.admin.email } }); }
    await A.teardown();
});

const call = (url, who, method = 'GET', body) => A.call(url, { token: who === 'admin' ? A.admin.token : A[who].token, method, body });
const PKT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' });
const today = PKT.format(new Date());

run('review: setup', async () => {
    const branch = (await call('/api/pos/branches', 'owner', 'POST', { name: 'Main' })).json[0];
    A.counter = (await call('/api/pos/counters', 'owner', 'POST', { branchId: branch.id, name: 'Till 1', posId: '970001', env: 'SANDBOX' })).json[0].counters[0];
    A.item = (await call('/api/pos/items', 'manager', 'POST', { name: 'Hall hire', pctCode: '9801.3000', taxRate: 8, unitPrice: 40000 })).json;
    A.admin = { email: `review-admin-${A.tag}@example.com` };
    await A.prisma.user.create({ data: { email: A.admin.email, password: A.hash, role: 'SUPER_ADMIN', name: 'Review Admin' } });
    A.admin.token = await A.login(A.admin.email, A.password);
});

run('review: a phone number saved before numbers were checked never stops a sale, an edit, or switching a customer or vendor off', async () => {
    // saved straight into the database, the way every customer saved before the check was
    const cust = await A.prisma.posCustomer.create({ data: { tenantId: A.tenantId, code: 'CUS9001', name: 'Old Customer', phone: '12345' } });
    const vend = await A.prisma.posVendor.create({ data: { tenantId: A.tenantId, code: 'VEN9001', name: 'Old Vendor', phone: '999' } });
    const sale = await call('/api/pos/sales', 'cashier', 'POST', { counterId: A.counter.id, paymentMode: 1, customerId: cust.id, lines: [{ itemId: A.item.id, quantity: 1 }] });
    assert.strictEqual(sale.status, 200, sale.text);
    assert.strictEqual(sale.json.sale.buyer.name, 'Old Customer');
    assert.strictEqual(sale.json.sale.buyer.phone, '', 'the number that does not pass is left off the invoice, not sent to PRA');
    // switching them off, or changing the name, does not ask for the old number to be mended, and keeps it
    const off = await call(`/api/pos/customers/${cust.id}`, 'manager', 'PUT', { active: false });
    assert.strictEqual(off.status, 200, off.text);
    assert.strictEqual(off.json.phone, '12345');
    assert.strictEqual((await call(`/api/pos/customers/${cust.id}`, 'manager', 'PUT', { name: 'Renamed', phone: '12345' })).status, 200, 'sending the same old number back is not a change');
    // but a NEW number is checked
    assert.strictEqual((await call(`/api/pos/customers/${cust.id}`, 'manager', 'PUT', { phone: '777' })).status, 400);
    assert.strictEqual((await call(`/api/pos/customers/${cust.id}`, 'manager', 'PUT', { phone: '0300-1234567' })).json.phone, '03001234567', 'and a good one replaces it');
    const voff = await call(`/api/pos/vendors/${vend.id}`, 'manager', 'PUT', { active: false });
    assert.strictEqual(voff.status, 200, voff.text);
    assert.strictEqual(voff.json.phone, '999');
    assert.strictEqual((await call(`/api/pos/vendors/${vend.id}`, 'manager', 'PUT', { phone: '777' })).status, 400);
    assert.strictEqual((await call(`/api/pos/vendors/${vend.id}`, 'manager', 'PUT', { phone: '042 35761234' })).json.phone, '04235761234');
    // typing a bad number into a sale is still refused
    const typed = await call('/api/pos/sales', 'cashier', 'POST', { counterId: A.counter.id, paymentMode: 1, buyer: { name: 'X', phone: '12345' }, lines: [{ itemId: A.item.id, quantity: 1 }] });
    assert.strictEqual(typed.status, 400);
    assert.match(typed.json.error, /Buyer phone number/);
});

run('review: bill and voucher numbers are the highest plus one, even if rows were stored out of order', async () => {
    const v = (await call('/api/pos/vendors', 'manager', 'POST', { name: 'Numbering Vendor' })).json;
    const bill = () => call('/api/pos/purchases', 'manager', 'POST', { vendorId: v.id, lines: [{ itemName: 'x', quantity: 1, unitCost: 10 }] });
    const nums = [(await bill()).json.number, (await bill()).json.number];
    assert.deepStrictEqual(nums, ['PUR000001', 'PUR000002']);
    // two transactions that overlapped can leave the newest NUMBER with an older creation time: the next number must still be 3
    await A.prisma.posPurchase.updateMany({ where: { tenantId: A.tenantId, number: 'PUR000002' }, data: { createdAt: new Date('2020-01-01T00:00:00Z') } });
    const third = await bill();
    assert.strictEqual(third.status, 200, third.text);
    assert.strictEqual(third.json.number, 'PUR000003');
    const c = (await call('/api/pos/customers', 'cashier', 'POST', { name: 'Voucher Customer' })).json;
    const rcv = () => call('/api/pos/cash/receive', 'manager', 'POST', { customerId: c.id, amount: '10' });
    assert.strictEqual((await rcv()).json.number, 'RCV000001');
    assert.strictEqual((await rcv()).json.number, 'RCV000002');
    await A.prisma.posCashEntry.updateMany({ where: { tenantId: A.tenantId, number: 'RCV000002' }, data: { createdAt: new Date('2020-01-01T00:00:00Z') } });
    const r3 = await rcv();
    assert.strictEqual(r3.status, 200, r3.text);
    assert.strictEqual(r3.json.number, 'RCV000003');
    // payments are numbered apart from receipts
    assert.strictEqual((await call('/api/pos/cash/pay', 'manager', 'POST', { vendorId: v.id, amount: '5' })).json.number, 'PAY000001');
});

run('review: a debit note is held to the Rs 50,000 rule too, taking the buyer from the sale', async () => {
    const mk = body => call('/api/pos/sales', 'cashier', 'POST', { counterId: A.counter.id, paymentMode: 1, lines: [{ itemId: A.item.id, quantity: 1 }], ...body });
    const noBuyer = (await mk({})).json.sale;
    const lineId = noBuyer.lines[0].id;
    // 2 more at 40,000 = 80,000 before tax, on a sale that has no buyer details
    const refused = await call(`/api/pos/sales/${noBuyer.id}/debit-note`, 'manager', 'POST', { reason: 'more hire', lines: [{ lineId, quantity: 2 }] });
    assert.strictEqual(refused.status, 400, refused.text);
    assert.match(refused.json.error, /above Rs 50,000/);
    assert.match(refused.json.error, /new sale to a saved customer/);
    // under the line it is fine without a buyer
    assert.strictEqual((await call(`/api/pos/sales/${noBuyer.id}/debit-note`, 'manager', 'POST', { reason: 'one more', lines: [{ lineId, quantity: 1 }] })).status, 200);
    // the same debit on a sale that has the buyer's name and CNIC goes through
    const withBuyer = (await mk({ buyer: { name: 'Khan Events', cnic: '3520212345671' } })).json.sale;
    const ok = await call(`/api/pos/sales/${withBuyer.id}/debit-note`, 'manager', 'POST', { reason: 'more hire', lines: [{ lineId: withBuyer.lines[0].id, quantity: 2 }] });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.json.sale.totals.saleValue, 80000);
    assert.strictEqual(ok.json.sale.buyer.name, 'Khan Events');
});

run('review: the "sales" filter of the list takes in debit notes, as the report does, so a report row and its invoices agree', async () => {
    const list = await call(`/api/pos/sales?from=${today}&to=${today}&state=FISCALIZED&invoiceType=sale&limit=500`, 'manager');
    assert.strictEqual(list.status, 200, list.text);
    const types = list.json.sales.map(s => s.invoiceType);
    assert.ok(types.includes(2), 'the debit notes are in it');
    assert.ok(!types.includes(3), 'the credit notes are not');
    const rep = await call(`/api/pos/reports/by/day?from=${today}&to=${today}`, 'manager');
    const day = rep.json.rows.find(r => r.key === today);
    assert.strictEqual(list.json.total, day.sales, 'the list has exactly as many invoices as the report row counted');
    const credit = await call('/api/pos/sales?invoiceType=return&limit=50', 'manager');
    assert.ok(credit.json.sales.every(s => s.invoiceType === 3));
    assert.strictEqual((await call('/api/pos/sales?invoiceType=debit', 'manager')).status, 400, 'a kind it does not know is still refused');
    // and the closing sheet's first and last invoice of the day take in debit notes
    const sheet = await call(`/api/pos/reports/closing?date=${today}`, 'manager');
    assert.strictEqual(sheet.status, 200, sheet.text);
    const newest = (await call(`/api/pos/sales?from=${today}&to=${today}&state=FISCALIZED&invoiceType=sale&limit=1`, 'manager')).json.sales[0];
    assert.strictEqual(sheet.json.lastSale.usin, newest.usin);
});

run('review: an item that follows the schedule can still be switched off or renamed after its rate row is voided, but cannot be pointed at a heading with no rate', async () => {
    const rate = await call('/api/admin/rates', 'admin', 'POST', { authority: 'PRA', code: '9899.9940', label: 'Review test heading', rate: 12, effectiveFrom: '2026-01-01', sourceName: 'Test schedule', sourceRef: 'x' });
    assert.strictEqual(rate.status, 200, rate.text);
    const it = await call('/api/pos/items', 'manager', 'POST', { name: 'Follower', pctCode: '9899.9940', taxRate: 5, unitPrice: 100, followSchedule: true });
    assert.strictEqual(it.status, 200, it.text);
    await call(`/api/admin/rates/${rate.json.id}/void`, 'admin', 'POST', { reason: 'test' });
    const off = await call(`/api/pos/items/${it.json.id}`, 'manager', 'PUT', { active: false });
    assert.strictEqual(off.status, 200, off.text);
    assert.strictEqual((await call(`/api/pos/items/${it.json.id}`, 'manager', 'PUT', { name: 'Follower renamed' })).status, 200);
    // but changing the heading to one the schedule has no rate for is refused while it follows
    const moved = await call(`/api/pos/items/${it.json.id}`, 'manager', 'PUT', { pctCode: '9899.9941' });
    assert.strictEqual(moved.status, 400);
    assert.match(moved.json.error, /schedule has no rate for 9899\.9941/);
    // and switching following on for a heading with no rate is refused
    const plain = (await call('/api/pos/items', 'manager', 'POST', { name: 'Plain', pctCode: '9899.9941', taxRate: 5, unitPrice: 100 })).json;
    assert.strictEqual((await call(`/api/pos/items/${plain.id}`, 'manager', 'PUT', { followSchedule: true })).status, 400);
});
