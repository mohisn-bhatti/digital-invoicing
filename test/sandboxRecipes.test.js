const test = require('node:test');
const assert = require('node:assert');
const { RECIPES, pickSaleType, pickRate, pickSro, pickSerial, pickUom } = require('../src/sandboxRecipes');
const { calcInvoice } = require('../src/tax');
const { buildPayload } = require('../src/fbr');
const { SCENARIOS } = require('../src/scenarios');

test('a test invoice for every sandbox scenario in the spec, and each one builds through ETAX\'s own invoice code', () => {
    assert.deepStrictEqual(Object.keys(RECIPES).sort(), SCENARIOS.map(s => s.id).sort());
    const tenant = { sellerNtnCnic: '3617803', sellerBusinessName: 'Seller', sellerProvince: 'PUNJAB', sellerAddress: 'Pakpattan' };
    for (const [id, r] of Object.entries(RECIPES)) {
        const buyerRegistrationType = r.buyer === 'REG' ? 'Registered' : 'Unregistered';
        const { lines } = calcInvoice([r.item], { buyerRegistrationType, furtherTaxRate: 4, endConsumer: Boolean(r.endConsumer) });
        const p = buildPayload(tenant, { invoiceType: 'Sale Invoice', invoiceDate: '2026-10-12', buyerRegistrationType, buyerNtnCnic: r.buyer === 'REG' ? '5339653' : '',
            buyerBusinessName: 'B', buyerProvince: 'PUNJAB', buyerAddress: 'A', fbrEnv: 'SANDBOX', scenarioId: id }, lines);
        assert.strictEqual(p.scenarioId, id);
        assert.match(p.items[0].hsCode, /^\d{4}\.\d{4}$/, id);
        if (r.confirmed !== false) assert.ok(!r.note || /minimum price/.test(r.note), `${id} confirmed but has a warning note`);
    }
    // amounts FBR's sandbox confirmed
    const st = id => calcInvoice([RECIPES[id].item], { buyerRegistrationType: 'Unregistered', furtherTaxRate: 4 }).lines[0].salesTaxApplicable;
    assert.strictEqual(st('SN017'), 1124); // FED in ST mode
    assert.strictEqual(st('SN021'), 300);  // Rs.3 × 100
    assert.strictEqual(st('SN023'), 2000); // Rs.200 × 10
});

test('test invoices follow FBR\'s live lists: spelling, rate, SRO, serial, unit', () => {
    assert.strictEqual(pickSaleType('Exempt Goods', ['Exempt goods', ' 3rd Schedule Goods ']), 'Exempt goods');
    assert.strictEqual(pickSaleType('3rd Schedule Goods', [' 3rd Schedule Goods ']), '3rd Schedule Goods');
    assert.strictEqual(pickSaleType('Gone', ['Other']), null);
    const rates = [{ id: 436, desc: '0.5%' }, { id: 413, desc: '1%' }];
    assert.deepStrictEqual(pickRate('1%', rates), { id: 413, desc: '1%' });
    assert.deepStrictEqual(pickRate('2%', rates), { id: 436, desc: '0.5%' }); // not offered any more → FBR's first
    assert.strictEqual(pickRate('1%', []), null);
    assert.strictEqual(pickSro('eighth schedule table 1', [{ id: 372, desc: 'EIGHTH SCHEDULE Table 1' }]).id, 372);
    assert.strictEqual(pickSerial('99', [{ id: 1, desc: '70' }]).desc, '70');
    assert.strictEqual(pickUom('KG', ['Liter']), 'Liter');
    assert.strictEqual(pickUom('KG', null), 'KG');
});
