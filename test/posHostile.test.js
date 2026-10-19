// Hostile or careless input through the real server: a NUL character (which the database cannot store) is a plain 400 or 404, never a
// server error; and the counter staff find customers without seeing what each one has spent.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');

const A = createApi('hostile');
const run = A.run;
test('hostile API: start a server and a business', { timeout: 90000 }, async t => { await A.setup(t); });
test.after(() => A.teardown());

const call = (who, url, method = 'GET', body) => A.call(url, { token: A[who].token, method, body });

run('hostile API: a NUL character anywhere is refused in words (400, or 404 for an id), never a server error', async () => {
    const plain = (await call('cashier', '/api/pos/customers', 'POST', { name: 'Plain' })).json;
    assert.strictEqual(plain.code, 'CUS0001');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
    const cases = [
        ['cashier', '/api/pos/customers?q=%00', 'GET', undefined, 400, /cannot be saved/],
        ['manager', '/api/pos/customers?q=ab%00cd', 'GET', undefined, 400, /cannot be saved/],
        ['manager', '/api/pos/export/customers?q=%00', 'GET', undefined, 400, /cannot be saved/],
        ['manager', '/api/pos/customers/%00', 'GET', undefined, 404, /Not found/],
        ['manager', '/api/pos/customers/%00', 'PUT', { name: 'x' }, 404, /Not found/],
        ['cashier', '/api/pos/sales/%00', 'GET', undefined, 404, /Not found/],
        ['cashier', '/api/pos/sales/%00/receipt', 'GET', undefined, 404, /Not found/],
        ['manager', '/api/pos/items/%00', 'PUT', { name: 'x' }, 404, /Not found/],
        ['cashier', '/api/pos/lookup?code=%00', 'GET', undefined, 400, /cannot be saved/],
        ['cashier', '/api/pos/sales?q=%00', 'GET', undefined, 400, /cannot be saved/],
        ['manager', `/api/pos/reports/by/item?from=${today}&to=${today}&cashier=%00`, 'GET', undefined, 400, /cannot be saved/],
        ['cashier', '/api/pos/sales', 'POST', { counterId: 'x', paymentMode: 1, customerId: '\u0000', lines: [] }, 400, /cannot be saved/],
        ['cashier', '/api/pos/sales', 'POST', { counterId: '\u0000', paymentMode: 1, lines: [] }, 400, /cannot be saved/],
        ['cashier', '/api/pos/customers', 'POST', { name: 'a\u0000b' }, 400, /cannot be saved/],
        ['owner', '/api/pos/settings', 'PUT', { receiptHeader: 'x\u0000' }, 400, /cannot be saved/],
        ['manager', '/api/pos/items', 'POST', { name: 'Deep', pctCode: '9801.2000', taxRate: 16, extra: { a: [{ b: 'x\u0000' }] } }, 400, /cannot be saved/],
        ['manager', '/api/pos/items', 'POST', { name: 'Key', pctCode: '9801.2000', taxRate: 16, ['k\u0000']: 1 }, 400, /cannot be saved/],
    ];
    for (const [who, url, method, body, status, re] of cases) {
        const r = await call(who, url, method, body);
        assert.strictEqual(r.status, status, `${method} ${url} as ${who}: ${r.text.slice(0, 200)}`);
        assert.match(r.json.error, re, `${method} ${url}`);
    }
    // a body with far more pieces than anything real is refused too
    const big = await call('manager', '/api/pos/items', 'POST', { name: 'Big', pctCode: '9801.2000', taxRate: 16, extra: Array.from({ length: 25000 }, () => 1) });
    assert.strictEqual(big.status, 400);
    assert.match(big.json.error, /too big/);
    // and ordinary requests are untouched
    assert.strictEqual((await call('cashier', '/api/pos/customers?q=plain')).json.total, 1);
    assert.strictEqual((await call('manager', `/api/pos/customers/${plain.id}`)).status, 200);
    assert.strictEqual((await call('manager', '/api/pos/customers/not-a-customer')).status, 404, 'an id that is just wrong is still a plain "not found"');
    const typed = await call('manager', '/api/pos/items', 'POST', { name: 'Chai (tea) & "milk" <ok>', pctCode: '9801.2000', taxRate: 16, unitPrice: 50 });
    assert.strictEqual(typed.status, 200, typed.text);
});

run('hostile API: the customer list shows what each one has spent to managers only', async () => {
    const owner = A.owner.token;
    const branch = (await A.call('/api/pos/branches', { token: owner, method: 'POST', body: { name: 'Main' } })).json[0];
    const counter = (await A.call('/api/pos/counters', { token: owner, method: 'POST', body: { branchId: branch.id, name: 'Till 1', posId: '960001', env: 'SANDBOX' } })).json[0].counters[0];
    const item = (await call('manager', '/api/pos/items', 'POST', { name: 'Lunch', pctCode: '9801.2000', taxRate: 16, unitPrice: 500 })).json;
    const khan = (await call('manager', '/api/pos/customers', 'POST', { name: 'Khan Events', pntn: '1234567-8', phone: '0300-1234567', address: 'Gulberg', notes: 'Pays by cheque' })).json;
    const sale = await call('manager', '/api/pos/sales', 'POST', { counterId: counter.id, paymentMode: 1, customerId: khan.id, lines: [{ itemId: item.id, quantity: 2 }] });
    assert.strictEqual(sale.json.result.outcome, 'FISCALIZED', sale.text);
    const spend = ['sales', 'salesTotal', 'returns', 'returnsTotal', 'net', 'lastSaleAt'];
    const seen = async who => (await call(who, '/api/pos/customers?q=khan')).json.customers[0];
    for (const who of ['owner', 'manager']) {
        const c = await seen(who);
        assert.strictEqual(c.salesTotal, 1160, `${who} sees the spend`);
        assert.ok(spend.every(k => k in c), who);
    }
    const c = await seen('cashier');
    assert.ok(spend.every(k => !(k in c)), `the cashier sees none of ${spend.join(', ')}: ${JSON.stringify(c)}`);
    // what finding a customer for a sale needs is all still there
    assert.deepStrictEqual(Object.keys(c).sort(), ['active', 'address', 'cnic', 'code', 'createdAt', 'id', 'name', 'notes', 'phone', 'pntn']);
    assert.deepStrictEqual([c.name, c.pntn, c.phone, c.id === khan.id], ['Khan Events', '1234567-8', '03001234567', true]);
    const total = (await call('cashier', '/api/pos/customers?q=khan')).json.total;
    assert.strictEqual(total, 1);
    // the sale to this customer still works for the cashier
    const again = await call('cashier', '/api/pos/sales', 'POST', { counterId: counter.id, paymentMode: 1, customerId: khan.id, lines: [{ itemId: item.id, quantity: 1 }] });
    assert.strictEqual(again.json.result.outcome, 'FISCALIZED', again.text);
});
