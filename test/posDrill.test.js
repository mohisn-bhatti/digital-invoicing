// From a report row to the invoices behind it: which list filters each way of grouping gives.
const test = require('node:test');
const assert = require('node:assert');
const D = require('../public/pos-drill');

const range = { from: '2026-10-05', to: '2026-11-20' };

test('drill: each way of grouping names its group by the filter the sales list has', () => {
    const f = (groupBy, key) => D.forRow(groupBy, { key }, range);
    assert.deepStrictEqual(f('day', '2026-10-19'), { from: '2026-10-19', to: '2026-10-19' });
    assert.deepStrictEqual(f('item', 'ITM0003'), { itemCode: 'ITM0003' });
    assert.deepStrictEqual(f('category', 'Food'), { category: 'Food' });
    assert.deepStrictEqual(f('category', ''), { category: '__none' }, 'no category is its own filter');
    assert.deepStrictEqual(f('cashier', 'ali@test.pk'), { cashier: 'ali@test.pk' });
    assert.deepStrictEqual(f('counter', 'c1'), { counterId: 'c1' });
    assert.deepStrictEqual(f('branch', 'b1'), { branchId: 'b1' });
    assert.deepStrictEqual(f('payment', '2'), { paymentMode: '2' });
    assert.deepStrictEqual(f('taxRate', '16.00'), { taxRate: '16.00' });
    assert.deepStrictEqual(f('customer', 'cu1'), { customerId: 'cu1' });
    assert.deepStrictEqual(f('customer', ''), { customerId: 'none' }, 'no saved customer is its own filter');
});

test('drill: a month row covers only the days of that month that are inside the report', () => {
    const m = key => D.forRow('month', { key }, range);
    assert.deepStrictEqual(m('2026-10'), { from: '2026-10-05', to: '2026-10-31' }, 'the report starts on the 5th');
    assert.deepStrictEqual(m('2026-11'), { from: '2026-11-01', to: '2026-11-20' }, 'and ends on the 20th');
    assert.deepStrictEqual(D.forRow('month', { key: '2026-02' }, { from: '2026-01-01', to: '2026-12-31' }), { from: '2026-02-01', to: '2026-02-28' });
    assert.deepStrictEqual(D.forRow('month', { key: '2028-02' }, { from: '2028-01-01', to: '2028-12-31' }), { from: '2028-02-01', to: '2028-02-29' }, 'a leap year');
    assert.deepStrictEqual(D.forRow('month', { key: '2026-12' }, { from: '2026-12-10', to: '2026-12-12' }), { from: '2026-12-10', to: '2026-12-12' }, 'a short report inside one month');
});

test('drill: the hour and the weekday of a sale cannot narrow the list, so those rows have no list', () => {
    for (const g of ['hour', 'weekday']) {
        assert.strictEqual(D.can(g), false);
        assert.strictEqual(D.forRow(g, { key: '12' }, range), null);
    }
    for (const g of ['day', 'month', 'item', 'category', 'cashier', 'counter', 'branch', 'payment', 'taxRate', 'customer']) assert.strictEqual(D.can(g), true, g);
});

test('drill: nonsense gives nothing, never a crash and never a prototype property', () => {
    for (const g of ['__proto__', 'constructor', 'toString', 'nope', '', undefined, null, 5]) assert.strictEqual(D.forRow(g, { key: 'x' }, range), null, String(g));
    for (const row of [null, undefined, {}, { key: 5 }, { key: null }, 'x']) assert.strictEqual(D.forRow('item', row, range), null, JSON.stringify(row));
    assert.strictEqual(D.forRow('month', { key: 'October' }, range), null, 'a month that is not a month');
    assert.strictEqual(D.forRow('day', { key: '19/10/2026' }, range), null, 'a day that is not a day');
    assert.deepStrictEqual(D.forRow('item', { key: 'ITM1' }), { itemCode: 'ITM1' }, 'no range is fine for a group that needs none');
});
