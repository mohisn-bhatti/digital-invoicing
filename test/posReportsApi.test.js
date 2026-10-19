// The report and filter endpoints through the real server: who may see what, a cashier's closing sheet is only their own, bad input is a
// 400 with words, and the list, the spreadsheet and the reports take the same filters.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');

const A = createApi('repapi');
const run = A.run;
test('reports API: start a server and a business', { timeout: 90000 }, async t => { await A.setup(t); });
test.after(() => A.teardown());

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
const get = (url, who) => A.call(url, { token: A[who].token });

run('reports API: some sales to report on (the server is in test mode: every sale is a test sale)', async () => {
    const owner = A.owner.token;
    const branch = (await A.call('/api/pos/branches', { token: owner, method: 'POST', body: { name: 'Main' } })).json[0];
    A.counter = (await A.call('/api/pos/counters', { token: owner, method: 'POST', body: { branchId: branch.id, name: 'Till 1', posId: '930001', env: 'SANDBOX' } })).json[0].counters[0];
    const mk = async body => (await A.call('/api/pos/items', { token: A.manager.token, method: 'POST', body: { pctCode: '9801.2000', taxRate: 16, ...body } })).json;
    A.tea = await mk({ name: 'Chai', unitPrice: 100, category: 'Drinks' });
    A.rice = await mk({ name: 'Biryani', unitPrice: 500, category: 'Food', taxRateCard: 8 });
    const sell = (who, body) => A.call('/api/pos/sales', { token: A[who].token, method: 'POST', body: { counterId: A.counter.id, paymentMode: 1, ...body } });
    for (const [who, body] of [['cashier', { lines: [{ itemId: A.tea.id, quantity: 2 }] }], ['cashier', { paymentMode: 2, lines: [{ itemId: A.rice.id, quantity: 1 }] }], ['manager', { lines: [{ itemId: A.rice.id, quantity: 3 }] }], ['owner', { lines: [{ itemId: A.tea.id, quantity: 1 }] }]]) {
        const r = await sell(who, body);
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json.result.outcome, 'FISCALIZED');
    }
});

run('reports API: managers see reports and the filter boxes; a cashier does not', async () => {
    const q = `from=${today()}&to=${today()}`;
    for (const who of ['owner', 'manager']) {
        const opts = await get('/api/pos/reports/options', who);
        assert.strictEqual(opts.status, 200, opts.text);
        assert.ok(opts.json.cashiers.length >= 3 && opts.json.categories.includes('Food'));
        const rep = await get(`/api/pos/reports/by/item?${q}`, who);
        assert.strictEqual(rep.status, 200, rep.text);
        assert.strictEqual(rep.json.totals.sales, 4);
        assert.deepStrictEqual(rep.json.rows.map(r => r.label).sort(), ['Biryani', 'Chai']);
        assert.strictEqual(rep.json.scope, 'TEST');
    }
    for (const url of ['/api/pos/reports/options', `/api/pos/reports/by/item?${q}`, `/api/pos/export/report/item?${q}`]) assert.strictEqual((await get(url, 'cashier')).status, 403, url);
    assert.strictEqual((await A.call(`/api/pos/reports/by/item?${q}`)).status, 401);
});

run('reports API: filters through the query string, the same in the list, the spreadsheet and the reports', async () => {
    const q = `from=${today()}&to=${today()}`;
    const cashier = A.cashier.email;
    const list = await get(`/api/pos/sales?${q}&cashier=${encodeURIComponent(cashier)}&state=FISCALIZED`, 'manager');
    assert.strictEqual(list.json.total, 2);
    const rep = await get(`/api/pos/reports/by/day?${q}&cashier=${encodeURIComponent(cashier)}`, 'manager');
    assert.strictEqual(rep.json.totals.sales, 2, 'the report agrees with the list');
    const card = await get(`/api/pos/reports/by/payment?${q}&paymentMode=2`, 'manager');
    assert.deepStrictEqual(card.json.rows.map(r => r.label), ['Card']);
    const food = await get(`/api/pos/reports/by/category?${q}&category=Food`, 'manager');
    assert.deepStrictEqual(food.json.rows.map(r => r.label), ['Food']);
    assert.strictEqual(food.json.totals.sales, 2);
    const csv = await get(`/api/pos/export/sales?${q}&paymentMode=2`, 'manager');
    assert.strictEqual(csv.status, 200);
    assert.strictEqual(csv.text.trim().split('\r\n').length, 2, 'a header and the one card sale');
    // the spreadsheet of a report
    const rcsv = await get(`/api/pos/export/report/cashier?${q}`, 'manager');
    assert.strictEqual(rcsv.status, 200);
    assert.match(rcsv.headers.get('content-disposition'), /pos-report-cashier-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}-test\.csv/);
    assert.ok(rcsv.text.startsWith('﻿Cashier,Invoices,'));
    assert.match(rcsv.text.trim().split('\r\n').pop(), /^Total,4,/);
});

run('reports API: bad input is a 400 with words, never a crash', async () => {
    const q = `from=${today()}&to=${today()}`;
    const bad = async (url, re) => { const r = await get(url, 'manager'); assert.strictEqual(r.status, 400, `${url}: ${r.text}`); assert.match(r.json.error, re); };
    await bad('/api/pos/reports/by/item', /Choose the dates/);
    await bad('/api/pos/reports/by/colour?' + q, /group the report by/);
    await bad('/api/pos/reports/by/__proto__?' + q, /group the report by/);
    await bad(`/api/pos/reports/by/item?${q}&paymentMode=9`, /how the sale was paid/);
    await bad('/api/pos/reports/by/item?from=2026-02-31&to=2026-03-01', /real date/);
    await bad('/api/pos/reports/by/item?from=2024-01-01&to=2026-10-01', /400 days at most/);
    await bad('/api/pos/sales?minAmount=abc', /smallest bill/);
    await bad('/api/pos/sales?state=NONSENSE', /status/);
    await bad('/api/pos/reports/closing', /day to close/);
    const odd = await get(`/api/pos/reports/by/item?${q}&cashier=${encodeURIComponent("x' OR '1'='1")}`, 'manager');
    assert.strictEqual(odd.status, 200);
    assert.strictEqual(odd.json.totals.sales, 0);
});

run('reports API: the closing sheet: a manager sees the whole till, a cashier only their own sales', async () => {
    const day = today();
    const all = await get(`/api/pos/reports/closing?date=${day}`, 'manager');
    assert.strictEqual(all.status, 200, all.text);
    assert.strictEqual(all.json.totals.sales, 4);
    assert.ok(all.json.byCashier.length === 3);
    assert.ok(all.json.cashExpected > 0);
    assert.strictEqual(all.json.business.name.length > 0, true);
    // the cashier asks for the whole day, or for somebody else's sales: they get their own
    for (const extra of ['', `&cashier=${encodeURIComponent(A.manager.email)}`, '&cashier=', `&cashier=${encodeURIComponent(A.owner.email)}`]) {
        const mine = await get(`/api/pos/reports/closing?date=${day}${extra}`, 'cashier');
        assert.strictEqual(mine.status, 200, mine.text);
        assert.strictEqual(mine.json.totals.sales, 2, `only the cashier's own two sales (${extra || 'no filter'})`);
        assert.strictEqual(mine.json.cashier, A.cashier.email);
        assert.deepStrictEqual(mine.json.byCashier.map(c => c.key), [A.cashier.email.toLowerCase()]);
    }
    // the same for one counter
    const t1 = await get(`/api/pos/reports/closing?date=${day}&counterId=${A.counter.id}`, 'manager');
    assert.deepStrictEqual([t1.json.counter.name, t1.json.counter.posId, t1.json.totals.sales], ['Till 1', '930001', 4]);
});

run('reports API: a customer filter and a branch filter in the list', async () => {
    const cust = (await A.call('/api/pos/customers', { token: A.cashier.token, method: 'POST', body: { name: 'Regular' } })).json;
    const r = await A.call('/api/pos/sales', { token: A.cashier.token, method: 'POST', body: { counterId: A.counter.id, paymentMode: 1, customerId: cust.id, lines: [{ itemId: A.tea.id, quantity: 1 }] } });
    assert.strictEqual(r.status, 200, r.text);
    const q = `from=${today()}&to=${today()}`;
    assert.strictEqual((await get(`/api/pos/sales?${q}&customerId=${cust.id}`, 'cashier')).json.total, 1);
    assert.strictEqual((await get(`/api/pos/sales?${q}&customerId=none`, 'cashier')).json.total, 4);
    const byCust = await get(`/api/pos/reports/by/customer?${q}`, 'manager');
    assert.deepStrictEqual(byCust.json.rows.map(x => x.label).sort(), [`Regular (${cust.code})`, 'No saved customer'].sort());
    const branchId = (await get('/api/pos/branches', 'manager')).json[0].id;
    assert.strictEqual((await get(`/api/pos/sales?${q}&branchId=${branchId}`, 'cashier')).json.total, 5);
});

run('reports API: a report row\'s invoices through the list: the item code and the kind of sale are filters, and agree with the report', async () => {
    const q = `from=${today()}&to=${today()}`;
    const rep = await get(`/api/pos/reports/by/item?${q}`, 'manager');
    const chai = rep.json.rows.find(r => r.label === 'Chai');
    assert.ok(chai, JSON.stringify(rep.json.rows.map(r => r.label)));
    for (const who of ['manager', 'cashier']) { // the list is everyone's; the report is the manager's
        const list = await get(`/api/pos/sales?${q}&itemCode=${chai.key}&state=FISCALIZED&env=SANDBOX`, who);
        assert.strictEqual(list.status, 200, list.text);
        assert.strictEqual(list.json.total, chai.sales + chai.returns, who);
    }
    const real = await get(`/api/pos/sales?${q}&itemCode=${chai.key}&env=PRODUCTION`, 'manager');
    assert.strictEqual(real.json.total, 0, 'the server is in test mode: there are no real sales');
    // the totals above the list and the spreadsheet take the same filters
    const totals = await get(`/api/pos/report?${q}&itemCode=${chai.key}`, 'manager');
    assert.strictEqual(totals.json.sales.count + totals.json.returns.count, chai.sales + chai.returns);
    const csv = await get(`/api/pos/export/sales?${q}&itemCode=${chai.key}&state=FISCALIZED`, 'manager');
    assert.strictEqual(csv.text.trim().split('\r\n').length - 1, chai.sales + chai.returns);
    // bad input is a 400 with words
    for (const bad of ['env=banana', 'env=', 'itemCode=%00']) {
        const r = await get(`/api/pos/sales?${q}&${bad}`, 'manager');
        if (bad === 'env=') assert.strictEqual(r.status, 200, 'an empty box is no filter');
        else assert.strictEqual(r.status, 400, `${bad}: ${r.text}`);
    }
    const odd = await get(`/api/pos/sales?${q}&itemCode=${encodeURIComponent("x' OR '1'='1")}`, 'manager');
    assert.deepStrictEqual([odd.status, odd.json.total], [200, 0]);
    // a closing sheet is the whole till: those filters do not narrow it
    const full = await get(`/api/pos/reports/closing?date=${today()}`, 'manager'), narrowed = await get(`/api/pos/reports/closing?date=${today()}&itemCode=${chai.key}&env=PRODUCTION`, 'manager');
    assert.deepStrictEqual(narrowed.json.totals, full.json.totals);
});
