// The customer, barcode and scan endpoints through the real server: who may do what, the camera permission, and a sale to a saved customer.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');

const A = createApi('custapi');
const run = A.run;
test('customers API: start a server and a business', { timeout: 90000 }, async t => { await A.setup(t); });
test.after(() => A.teardown());

run('customers API: the camera is allowed for this site (a scanner needs it) and nothing else is', async () => {
    const r = await A.call('/healthz');
    assert.strictEqual(r.headers.get('permissions-policy'), 'camera=(self), microphone=(), geolocation=()');
});

run('customers API: everyone at the counter can find and add a customer; only a manager changes or reviews one', async () => {
    const add = await A.call('/api/pos/customers', { token: A.cashier.token, method: 'POST', body: { name: 'Counter customer', phone: '0300-5551234' } });
    assert.strictEqual(add.status, 200, add.text);
    assert.strictEqual(add.json.code, 'CUS0001');
    const id = add.json.id;
    const list = await A.call('/api/pos/customers?q=counter&active=1', { token: A.cashier.token });
    assert.strictEqual(list.status, 200);
    assert.deepStrictEqual(list.json.customers.map(c => c.name), ['Counter customer']);
    // the cashier cannot change one, read the history, or download the list
    assert.strictEqual((await A.call(`/api/pos/customers/${id}`, { token: A.cashier.token, method: 'PUT', body: { name: 'changed' } })).status, 403);
    assert.strictEqual((await A.call(`/api/pos/customers/${id}`, { token: A.cashier.token })).status, 403);
    assert.strictEqual((await A.call('/api/pos/export/customers', { token: A.cashier.token })).status, 403);
    // the manager can
    const put = await A.call(`/api/pos/customers/${id}`, { token: A.manager.token, method: 'PUT', body: { name: 'Counter customer Ltd', address: 'Model Town' } });
    assert.strictEqual(put.status, 200, put.text);
    assert.strictEqual(put.json.name, 'Counter customer Ltd');
    const one = await A.call(`/api/pos/customers/${id}`, { token: A.manager.token });
    assert.strictEqual(one.status, 200);
    assert.deepStrictEqual(Object.keys(one.json).filter(k => ['sales', 'net', 'recent', 'lastSaleAt'].includes(k)).sort(), ['lastSaleAt', 'net', 'recent', 'sales']);
    const csv = await A.call('/api/pos/export/customers', { token: A.manager.token });
    assert.strictEqual(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /pos-customers\.csv/);
    assert.ok(csv.text.startsWith('﻿Code,Name,'), 'a spreadsheet program opens it as UTF-8');
    // bad input is a 400 with words, not a crash
    const bad = await A.call('/api/pos/customers', { token: A.cashier.token, method: 'POST', body: { name: 'X', pntn: '12' } });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.json.error, /PNTN/);
    const dup = await A.call('/api/pos/customers', { token: A.cashier.token, method: 'POST', body: { name: 'Twin', phone: '0300-5551234' } });
    assert.strictEqual(dup.status, 200, 'the same phone is allowed');
});

run('customers API: no login, no module, no access', async () => {
    assert.strictEqual((await A.call('/api/pos/customers')).status, 401);
    assert.strictEqual((await A.call('/api/pos/lookup?code=x')).status, 401);
    // a business without the Point of Sale module
    const t = await A.prisma.tenant.create({ data: { companyName: `TEST custapi nopos ${A.tag}`, modules: ['INVOICING'] } });
    A.tenants.push(t.id);
    const email = `custapi-nopos-${A.tag}@example.com`;
    await A.prisma.user.create({ data: { email, password: A.hash, role: 'CLIENT_USER', tenantRole: 'OWNER', tenantId: t.id } });
    const token = await A.login(email, A.password);
    assert.strictEqual((await A.call('/api/pos/customers', { token })).status, 403);
    assert.strictEqual((await A.call('/api/pos/lookup?code=x', { token })).status, 403);
});

run('customers API: barcodes on items, and what a scan finds', async () => {
    const mk = body => A.call('/api/pos/items', { token: A.manager.token, method: 'POST', body: { pctCode: '9801.2000', taxRate: 16, unitPrice: 250, ...body } });
    const tea = await mk({ name: 'Chai', barcode: '8964000999991', taxRateCard: 8 });
    assert.strictEqual(tea.status, 200, tea.text);
    assert.strictEqual(tea.json.barcode, '8964000999991');
    const dup = await mk({ name: 'Chai 2', barcode: '8964000999991' });
    assert.strictEqual(dup.status, 409);
    assert.match(dup.json.error, /already the code or barcode of "Chai"/);
    const found = await A.call('/api/pos/lookup?code=' + encodeURIComponent(' 8964000999991 '), { token: A.cashier.token });
    assert.strictEqual(found.status, 200);
    assert.deepStrictEqual([found.json.item.name, found.json.item.unitPrice, found.json.item.taxRate, found.json.item.taxRateCard], ['Chai', 250, 16, 8]);
    assert.strictEqual(found.json.sale, null);
    const none = await A.call('/api/pos/lookup?code=nothing', { token: A.cashier.token });
    assert.deepStrictEqual([none.json.item, none.json.sale], [null, null]);
    const noCode = await A.call('/api/pos/lookup', { token: A.cashier.token });
    assert.strictEqual(noCode.status, 200);
    assert.strictEqual(noCode.json.item, null);
    A.chai = tea.json;
});

run('customers API: a sale to a saved customer, and the receipt\'s QR finds the sale again', async () => {
    const owner = A.owner.token;
    const branch = (await A.call('/api/pos/branches', { token: owner, method: 'POST', body: { name: 'Main' } })).json[0];
    const counter = (await A.call('/api/pos/counters', { token: owner, method: 'POST', body: { branchId: branch.id, name: 'Till 1', posId: '910001', env: 'SANDBOX' } })).json[0].counters[0];
    const customer = (await A.call('/api/pos/customers?q=counter', { token: A.cashier.token })).json.customers[0];
    const sale = await A.call('/api/pos/sales', { token: A.cashier.token, method: 'POST', body: { counterId: counter.id, paymentMode: 1, customerId: customer.id, buyer: { name: 'typed and ignored' }, lines: [{ itemId: A.chai.id, quantity: 2 }] } });
    assert.strictEqual(sale.status, 200, sale.text);
    assert.strictEqual(sale.json.result.outcome, 'FISCALIZED', 'test mode: the answer is made up, the sale is real');
    assert.strictEqual(sale.json.sale.customer.code, 'CUS0001');
    assert.strictEqual(sale.json.sale.buyer.name, 'Counter customer Ltd');
    const rc = await A.call(`/api/pos/sales/${sale.json.sale.id}/receipt`, { token: A.cashier.token });
    const viaQr = await A.call('/api/pos/lookup?code=' + encodeURIComponent(rc.json.sale.verifyUrl), { token: A.cashier.token });
    assert.strictEqual(viaQr.json.sale.id, sale.json.sale.id);
    assert.strictEqual(viaQr.json.item, null);
    // filtered by customer
    const mine = await A.call(`/api/pos/sales?customerId=${customer.id}&from=&to=`, { token: A.cashier.token });
    assert.strictEqual(mine.json.total, 1);
    const others = await A.call('/api/pos/sales?customerId=nobody&from=&to=', { token: A.cashier.token });
    assert.strictEqual(others.json.total, 0);
    // a sale to a customer who does not exist is refused
    const refused = await A.call('/api/pos/sales', { token: A.cashier.token, method: 'POST', body: { counterId: counter.id, paymentMode: 1, customerId: 'nobody', lines: [{ itemId: A.chai.id, quantity: 1 }] } });
    assert.strictEqual(refused.status, 400);
    assert.match(refused.json.error, /customer is not available/);
});
