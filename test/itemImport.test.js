const test = require('node:test');
const assert = require('node:assert');
const { checkImport } = require('../src/itemImport');

const HEAD = ['name', 'description', 'notes', 'hsCode', 'uoM', 'p1Name', 'p1Amount', 'p2Name', 'p2Amount', 'saleType', 'rate', 'refs', 'comment'];
const TAX_HEAD = ['itemName', 'name', 'kind', 'value', 'applyOn', 'fbrBox', 'refs', 'comment'];
const ctx = (extra = {}) => ({
    saleTypes: ['Goods at standard rate (default)', 'Exempt Goods'],
    existing: [{ name: 'Rice 6155', hsCode: '1006.3010', saleType: 'Exempt Goods' }],
    officialCodes: new Set(['1701.9910', '1006.3010', '0401.1000']),
    findRef: t => (t.toLowerCase() === 'sro 663(i)/2026' ? { reference: 'SRO 663(I)/2026', url: 'https://fbr/x.pdf', source: 'SRO' } : null),
    ...extra,
});
const good = (o = {}) => ({ row: 2, name: 'Sugar', description: 'White sugar', notes: 'Bulk', hsCode: '1701.9910', uoM: 'KG',
    p1Name: 'Retail', p1Amount: 150, saleType: 'Goods at standard rate (default)', rate: '18%', refs: 'SRO 663(I)/2026; 6th Schd Table I', comment: 'ok', ...o });
const run = (items, taxes = [], c = ctx()) => checkImport({ itemHeaders: HEAD, items, taxHeaders: TAX_HEAD, taxes }, c);
const msgs = r => r.errors.flatMap(e => e.messages.map(m => `${e.sheet}:${e.row}:${m}`));

test('a clean file is ready, references matched to the FBR list, more taxes attached', () => {
    const r = run([good()], [
        { row: 2, itemName: 'Sugar', name: 'Withholding', kind: '%', value: 2, applyOn: 'Value before tax', fbrBox: 'Extra Tax', refs: 'Sales Tax Act', comment: 'c' },
        { row: 3, itemName: 'sugar', name: 'Cess', kind: '%', value: '1', applyOn: 'Sales tax amount + Withholding', fbrBox: 'FED Payable' },
        { row: 4, itemName: 'Sugar', name: 'Municipal', kind: 'Fixed Rs', value: '5,500', fbrBox: 'extra tax' },
    ]);
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.ready.length, 1);
    const { item, rule } = r.ready[0];
    assert.deepStrictEqual(item.prices, [{ label: 'Retail', price: 150 }]);
    assert.strictEqual(rule.lawRefs[0].url, 'https://fbr/x.pdf');
    assert.strictEqual(rule.lawRefs[1].reference, '6th Schd Table I');
    assert.deepStrictEqual(rule.extraTaxes.map(t => [t.name, t.kind, t.value, t.base, t.fbrField]),
        [['Withholding', 'PCT', 2, 'VALUE', 'extraTax'], ['Cess', 'PCT', 1, 'SALES_TAX+TAX:0', 'fedPayable'], ['Municipal', 'FIXED', 5500, '', 'extraTax']]);
});

test('Excel numbers: HS code 1701.991 and rate 0.18 are read back correctly', () => {
    const r = run([good({ hsCode: 1701.991, rate: 0.18 })]);
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.ready[0].item.hsCode, '1701.9910');
    assert.strictEqual(r.ready[0].rule.rate, '18%');
});

test('every missing field is reported at once', () => {
    const r = run([good({ description: '', notes: '', uoM: '', hsCode: '', p1Name: '', p1Amount: '', saleType: '', rate: '' })]);
    const m = msgs(r).join('\n');
    for (const want of ['Item description is missing', 'Item notes are missing', 'UOM is missing', 'HS code is missing', 'At least one price is required', 'Sale type is missing', 'Sales tax rate is missing']) {
        assert.ok(m.includes(want.replace('are missing', 'is missing')) || m.includes(want), `expected "${want}" in:\n${m}`);
    }
    assert.strictEqual(r.ready.length, 0);
});

test('half-filled prices, wrong sale type, bad HS code, exempt without reference', () => {
    const m = msgs(run([good({ p1Amount: '', p2Name: '', p2Amount: 5 }), good({ row: 3, name: 'B', hsCode: '12', saleType: 'Std' }),
        good({ row: 4, name: 'C', hsCode: '0401.1000', saleType: 'Exempt Goods', refs: '' })])).join('\n');
    assert.match(m, /Items:2:Price 1 \("Retail"\) has a name but no amount/);
    assert.match(m, /Items:2:Price 2 has an amount but no name/);
    assert.match(m, /Items:3:HS code "12" should look like 0101.2100/);
    assert.match(m, /Items:3:Sale type "Std" is not in the list/);
    assert.match(m, /Items:4:"Exempt Goods" needs at least one Sales tax reference/);
});

test('duplicates: HS code + sale type (existing and in the file), names; same HS with another sale type is fine', () => {
    const r = run([
        good({ name: 'Rice new', hsCode: '1006.3010', saleType: 'Exempt Goods', refs: '6th Schd Table I' }), // same pair as Rice 6155
        good({ row: 3, name: 'Rice std', hsCode: '1006.3010' }),                                           // other sale type → ok
        good({ row: 4, name: 'Sugar 2' }), good({ row: 5, name: 'Sugar 3' }),                               // same pair twice in file
        good({ row: 6, name: 'rice 6155', hsCode: '0401.1000' }),                                           // existing name
    ]);
    const m = msgs(r).join('\n');
    assert.match(m, /Items:2:HS code 1006.3010 with sale type "Exempt Goods" is already used by your item "Rice 6155"/);
    assert.doesNotMatch(m, /Items:3:/);
    assert.match(m, /Items:5:HS code 1701.9910 with sale type "Goods at standard rate \(default\)" is also on row 4/);
    assert.match(m, /Items:6:An item named "Rice 6155" already exists/);
});

test('more taxes: unknown item, bad type / box / apply-on, missing columns', () => {
    const r = run([good()], [
        { row: 2, itemName: 'Milk 2', name: 'X', kind: '%', value: 1, applyOn: 'Value before tax', fbrBox: 'Extra Tax' },
        { row: 3, itemName: 'Sugar', name: 'Cess', kind: 'percent', value: 1, applyOn: 'Withholding', fbrBox: 'Extra Tax' },
        { row: 4, itemName: 'Sugar', name: 'Y', kind: 'flat', value: 'abc', fbrBox: 'Discount' },
    ]);
    const m = msgs(r).join('\n');
    assert.match(m, /More taxes:2:Item "Milk 2" is not on the Items sheet/);
    assert.match(m, /More taxes:3:Apply on names "Withholding", which is not a tax above it/);
    assert.match(m, /More taxes:4:Type "flat" should be % or Fixed Rs/);
    assert.match(m, /More taxes:4:Rate or Rs "abc" is not a number/);
    assert.match(m, /More taxes:4:FBR box "Discount" should be/);

    const f = checkImport({ itemHeaders: ['name'], items: [good()] }, ctx());
    assert.match(msgs(f)[0], /File:null:Columns .*"Item description".* not found on the Items sheet/);
    assert.match(msgs(checkImport({ itemHeaders: HEAD, items: [] }, ctx()))[0], /no items/);
});

test('HS code not in the FBR list is a warning, not an error', () => {
    const r = run([good({ hsCode: '9999.9999' })]);
    assert.deepStrictEqual(r.errors, []);
    assert.match(r.warnings[0].messages[0], /not in the FBR list/);
});
