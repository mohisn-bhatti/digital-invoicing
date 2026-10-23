// The settings endpoints through the real server: everyone at the business reads them, only the account owner changes them, bad input is
// a 400 with words, and the cashier screen and the receipt carry what was chosen.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');

const A = createApi('setapi');
const run = A.run;
test('settings API: start a server and a business', { timeout: 90000 }, async t => { await A.setup(t); });
test.after(() => A.teardown());

const get = who => A.call('/api/pos/settings', { token: A[who].token });
const put = (who, body) => A.call('/api/pos/settings', { token: A[who].token, method: 'PUT', body });

run('settings API: everyone at the business can read them, a stranger cannot', async () => {
    for (const who of ['owner', 'manager', 'cashier']) {
        const r = await get(who);
        assert.strictEqual(r.status, 200, `${who}: ${r.text}`);
        assert.deepStrictEqual(r.json, { defaultPaymentMode: 1, receiptHeader: '', receiptWidth: 80, showCashier: true, itemPct: '', itemTaxRate: null, itemTaxRateCard: null, itemCategory: '', retentionYears: 6, hasLogo: false });
    }
    assert.strictEqual((await A.call('/api/pos/settings')).status, 401);
    assert.strictEqual((await A.call('/api/pos/settings', { token: 'not-a-token' })).status, 401);
});

run('settings API: only the account owner changes them', async () => {
    for (const who of ['manager', 'cashier']) {
        const r = await put(who, { receiptWidth: 58 });
        assert.strictEqual(r.status, 403, `${who}: ${r.text}`);
    }
    assert.strictEqual((await A.call('/api/pos/settings', { method: 'PUT', body: { receiptWidth: 58 } })).status, 401);
    assert.strictEqual((await get('owner')).json.receiptWidth, 80, 'refused changes changed nothing');
    const r = await put('owner', { defaultPaymentMode: 2, receiptHeader: 'Fine dining', receiptWidth: 58, showCashier: false, itemPct: '9801.2000', itemTaxRate: 16, itemTaxRateCard: 8, itemCategory: 'Food' });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json, { defaultPaymentMode: 2, receiptHeader: 'Fine dining', receiptWidth: 58, showCashier: false, itemPct: '98012000', itemTaxRate: 16, itemTaxRateCard: 8, itemCategory: 'Food', retentionYears: 6, hasLogo: false });
    for (const who of ['manager', 'cashier']) assert.deepStrictEqual((await get(who)).json, r.json, `${who} sees what the owner chose`);
});

run('settings API: bad input is a 400 with words, never a crash', async () => {
    const before = (await get('owner')).json;
    const bad = async (body, re) => { const r = await put('owner', body); assert.strictEqual(r.status, 400, `${JSON.stringify(body)}: ${r.text}`); assert.match(r.json.error, re); };
    await bad({ defaultPaymentMode: 9 }, /how a new sale starts/);
    await bad({ receiptWidth: 70 }, /58 mm or 80 mm/);
    await bad({ showCashier: 'perhaps' }, /yes or no/);
    await bad({ itemPct: '12' }, /8 digits/);
    await bad({ itemTaxRate: 500 }, /more than 100/);
    await bad({ receiptHeader: 'x'.repeat(500) }, /too long/);
    await bad({ receiptWidth: [58] }, /58 mm or 80 mm/);
    const notAnObject = await A.call('/api/pos/settings', { token: A.owner.token, method: 'PUT', body: [1, 2, 3] });
    assert.strictEqual(notAnObject.status, 200, 'a list is not a set of settings: it changes nothing');
    assert.deepStrictEqual((await get('owner')).json, before);
});

run('settings API: the cashier screen and the receipt carry what was chosen', async () => {
    const owner = A.owner.token;
    const branch = (await A.call('/api/pos/branches', { token: owner, method: 'POST', body: { name: 'Main' } })).json[0];
    const counter = (await A.call('/api/pos/counters', { token: owner, method: 'POST', body: { branchId: branch.id, name: 'Till 1', posId: '940001', env: 'SANDBOX' } })).json[0].counters[0];
    const item = (await A.call('/api/pos/items', { token: A.manager.token, method: 'POST', body: { name: 'Chai', pctCode: '9801.2000', taxRate: 16, unitPrice: 100 } })).json;
    await put('owner', { defaultPaymentMode: 2, receiptHeader: 'Fine dining', receiptWidth: 58, showCashier: false });
    const setup = await A.call('/api/pos/setup', { token: A.cashier.token });
    assert.strictEqual(setup.status, 200, setup.text);
    assert.strictEqual(setup.json.settings.defaultPaymentMode, 2);
    assert.strictEqual(setup.json.settings.receiptWidth, 58);
    const sale = await A.call('/api/pos/sales', { token: A.cashier.token, method: 'POST', body: { counterId: counter.id, paymentMode: 2, lines: [{ itemId: item.id, quantity: 1 }] } });
    assert.strictEqual(sale.json.result.outcome, 'FISCALIZED', sale.text);
    const rc = await A.call(`/api/pos/sales/${sale.json.sale.id}/receipt`, { token: A.cashier.token });
    assert.deepStrictEqual(rc.json.look, { header: 'Fine dining', width: 58, showCashier: false });
    assert.strictEqual(rc.json.sale.cashier, '');
    await put('owner', { showCashier: true, receiptWidth: 80 });
    const again = await A.call(`/api/pos/sales/${sale.json.sale.id}/receipt`, { token: A.manager.token });
    assert.deepStrictEqual(again.json.look, { header: 'Fine dining', width: 80, showCashier: true });
    assert.match(again.json.sale.cashier, /^setapi-cashier-/, 'the name is back on the paper');
});

run('settings API: the change is in the activity trail, with who made it', async () => {
    const rows = await A.prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: 'pos.settings.update' }, orderBy: { createdAt: 'asc' } });
    assert.ok(rows.length >= 2, 'one entry for each save that changed something');
    assert.match(rows[0].summary, /^Point of Sale settings changed: defaultPaymentMode: 1 → 2/);
    assert.ok(rows.every(r => r.userEmail === A.owner.email), 'made by the account owner');
    assert.ok(rows.every(r => !/token|password/i.test(r.summary)));
});
