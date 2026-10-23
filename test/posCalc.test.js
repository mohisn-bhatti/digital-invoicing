const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/pos/calc');
const V = require('../src/pos/validate');

test('POS maths: quantity × price − discount, tax on what is left, half-up to the paisa', () => {
    const r = C.calcSale([{ quantity: 3, unitPrice: 1000, discount: 500, taxRate: 16 }]);
    assert.deepStrictEqual(r.lines[0], { quantity: 3, unitPrice: 1000, gross: 3000, discount: 500, taxRate: 16, saleValue: 2500, taxCharged: 400, totalAmount: 2900, taxInclusive: false });
    assert.deepStrictEqual(r.totals, { quantity: 3, saleValue: 2500, discount: 500, tax: 400, bill: 2900 });
    // 0.5 paisa rounds up, 0.499 does not
    assert.strictEqual(C.calcSale([{ quantity: 1, unitPrice: 0.05, taxRate: 10 }]).totals.tax, 0.01);
    assert.strictEqual(C.calcSale([{ quantity: 1, unitPrice: 0.04, taxRate: 10 }]).totals.tax, 0);
    // fractional quantity, no float drift: 1.5 × 99.99 = 149.985 → 149.99
    assert.strictEqual(C.calcSale([{ quantity: 1.5, unitPrice: 99.99, taxRate: 0 }]).totals.saleValue, 149.99);
    // 0.1 + 0.2 style sums stay exact
    const many = C.calcSale(Array.from({ length: 10 }, () => ({ quantity: 1, unitPrice: 0.1, taxRate: 0 })));
    assert.strictEqual(many.totals.bill, 1);
});

test('POS maths: PRA manual example (SaleValue 1,298 at 17%) gives 220.66 to the paisa; PRA\'s sample shows 221', () => {
    const r = C.calcSale([{ quantity: 1, unitPrice: 1298, taxRate: 17 }]);
    assert.strictEqual(r.totals.tax, 220.66);
    assert.strictEqual(r.totals.bill, 1518.66);
});

test('POS maths: tax is charged line by line and the header is the sum of the lines', () => {
    const r = C.calcSale([{ quantity: 1, unitPrice: 0.05, taxRate: 10 }, { quantity: 1, unitPrice: 0.05, taxRate: 10 }]);
    assert.strictEqual(r.totals.tax, 0.02); // 0.01 + 0.01, not round(0.01) of the total
});

test('POS maths: bad figures are refused in plain words', () => {
    const bad = l => assert.throws(() => C.calcSale([l]), C.PosCalcError);
    bad({ quantity: 0, unitPrice: 10, taxRate: 0 });
    bad({ quantity: -1, unitPrice: 10, taxRate: 0 });
    bad({ quantity: 1, unitPrice: 'abc', taxRate: 0 });
    bad({ quantity: 1, unitPrice: 10, discount: 11, taxRate: 0 });
    bad({ quantity: 1, unitPrice: 10, taxRate: 101 });
    bad({ quantity: 1e-7, unitPrice: 10, taxRate: 0 }); // exponent notation is not a plain number
    assert.throws(() => C.calcSale([]), /at least one item/);
});

test('POS maths: card payments can have their own tax rate; mixed payments use the standard rate', () => {
    const item = { taxRate: 16, taxRateCard: 5 };
    assert.strictEqual(C.rateFor(item, 2), 5);
    assert.strictEqual(C.rateFor(item, 1), 16);
    assert.strictEqual(C.rateFor(item, 5), 16);
    assert.strictEqual(C.rateFor({ taxRate: 16, taxRateCard: null }, 2), 16);
    assert.strictEqual(C.rateFor({ taxRate: 16 }, 2), 16);
    assert.strictEqual(C.rateFor({ taxRate: 16, taxRateCard: 0 }, 2), 0); // a zero card rate is a real rate
});

test('POS maths: a discount typed as a percentage becomes rupees', () => {
    assert.strictEqual(C.discountFromPercent({ quantity: 2, unitPrice: 250 }, 10), 50);
    assert.strictEqual(C.discountFromPercent({ quantity: 1, unitPrice: 99.99 }, 12.5), 12.5); // 12.49875 → 12.50
    assert.throws(() => C.discountFromPercent({ quantity: 1, unitPrice: 10 }, 101), C.PosCalcError);
});

test('POS credit notes: partial returns, and the last return takes exactly what is left', () => {
    const sold = C.calcSale([{ quantity: 3, unitPrice: 33.33, discount: 1, taxRate: 16 }]).lines[0];
    const none = { quantity: 0, discount: 0, saleValue: 0, taxCharged: 0 };
    const one = C.creditLine(sold, 1, none);
    assert.strictEqual(one.quantity, 1);
    assert.strictEqual(one.unitPrice, 33.33);
    const two = C.creditLine(sold, 1, { quantity: 1, discount: one.discount, saleValue: one.saleValue, taxCharged: one.taxCharged });
    const last = C.creditLine(sold, 1, {
        quantity: 2, discount: Math.round((one.discount + two.discount) * 100) / 100,
        saleValue: Math.round((one.saleValue + two.saleValue) * 100) / 100, taxCharged: Math.round((one.taxCharged + two.taxCharged) * 100) / 100,
    });
    const sum = k => Math.round((one[k] + two[k] + last[k]) * 100) / 100;
    assert.strictEqual(sum('saleValue'), sold.saleValue);
    assert.strictEqual(sum('taxCharged'), sold.taxCharged);
    assert.strictEqual(sum('discount'), sold.discount);
    assert.strictEqual(sum('totalAmount'), sold.totalAmount);
    assert.throws(() => C.creditLine(sold, 2, { quantity: 2, discount: 0, saleValue: 0, taxCharged: 0 }), /more than was sold/);
    assert.throws(() => C.creditLine(sold, 0, none), C.PosCalcError);
});

test('POS buyer details: optional, but in PRA\'s format when given', () => {
    assert.deepStrictEqual(V.cleanBuyer({}), { name: '', pntn: '', cnic: '', phone: '' });
    assert.deepStrictEqual(V.cleanBuyer({ name: '  Ali   Khan ', pntn: '12345678', cnic: '35202-1234567-1', phone: '+92 300 1234567' }),
        { name: 'Ali Khan', pntn: '1234567-8', cnic: '3520212345671', phone: '923001234567' });
    assert.throws(() => V.cleanBuyer({ pntn: '12345' }), /PNTN/);
    assert.throws(() => V.cleanBuyer({ cnic: '123' }), /CNIC/);
    assert.throws(() => V.cleanBuyer({ phone: '12' }), /phone/);
    assert.throws(() => V.cleanBuyer({ name: 'x'.repeat(151) }), /too long/);
});

test('POS items: 8-digit PCT code, rates, price', () => {
    const ok = V.cleanItem({ name: 'Lunch buffet', pctCode: '9801.2000', taxRate: '16', taxRateCard: '5', unitPrice: '1500' });
    assert.strictEqual(ok.pctCode, '98012000');
    assert.strictEqual(ok.taxRateCard, 5);
    assert.strictEqual(ok.openPrice, false);
    assert.strictEqual(V.cleanItem({ name: 'x', pctCode: '98012000', taxRate: 0, taxRateCard: '' }).taxRateCard, null);
    assert.throws(() => V.cleanItem({ name: 'x', pctCode: '9801', taxRate: 5 }), /8 digits/);
    assert.throws(() => V.cleanItem({ name: '', pctCode: '98012000', taxRate: 5 }), /name/);
    assert.throws(() => V.cleanItem({ name: 'x', pctCode: '98012000', taxRate: 101 }), /more than 100/);
    assert.throws(() => V.cleanItem({ name: 'x', pctCode: '98012000', taxRate: 5, code: 'a b' }), /Item code/);
    assert.throws(() => V.cleanItem({ name: 'x', pctCode: '98012000', taxRate: 5, unitPrice: '1.234' }), /decimal/);
});

test('POS counters and tokens', () => {
    assert.deepStrictEqual(V.cleanCounter({ name: ' Till 1 ', posId: '000123456', env: 'PRODUCTION' }), { name: 'Till 1', posId: '123456', env: 'PRODUCTION' });
    assert.strictEqual(V.cleanCounter({ name: 'T', posId: '99' }).env, 'SANDBOX');
    assert.throws(() => V.cleanCounter({ name: 'T', posId: '' }), /POS ID/);
    assert.throws(() => V.cleanCounter({ name: 'T', posId: '0' }), /POS ID/);
    assert.throws(() => V.cleanToken('short'), /token/);
    assert.throws(() => V.cleanToken('has a space inside the token value'), /token/);
    assert.strictEqual(V.cleanToken('  11111111-2222-3333-4444-555555555555 '), '11111111-2222-3333-4444-555555555555');
    assert.strictEqual(V.cleanPaymentMode('2'), 2);
    assert.throws(() => V.cleanPaymentMode(7), /paid/);
});

test('POS maths: figures too big for the database are refused in plain words', () => {
    const refuses = (lines, re) => assert.throws(() => C.calcSale(lines), e => e instanceof C.PosCalcError && re.test(e.message));
    refuses([{ quantity: 1000001, unitPrice: 1, taxRate: 0 }], /1,000,000/);
    refuses([{ quantity: 1, unitPrice: '100000000', taxRate: 0 }], /99,999,999\.99/);
    refuses([{ quantity: 1000000, unitPrice: '99999999.99', taxRate: 0 }], /too much/);
    refuses(Array.from({ length: 200 }, () => ({ quantity: 1000, unitPrice: '99999999.99', taxRate: 0 })), /too much for one invoice/);
    // right at the limits is fine
    assert.strictEqual(C.calcSale([{ quantity: 1000000, unitPrice: '99999.99', taxRate: 0 }]).totals.bill, 99999990000);
    assert.strictEqual(C.calcSale([{ quantity: 1, unitPrice: '99999999.99', taxRate: 100 }]).totals.bill, 199999999.98);
});

test('POS credit notes: returned one unit at a time, no note is ever negative and the notes add up to the sale', () => {
    // each case: a sold line (qty, price, discount, tax rate), returned one unit per note
    for (const [qty, price, disc, rate] of [[10, 0.10, 0, 5], [8, 1, 0.20, 2.5], [12, 10, 0.30, 16], [78, 10, 195, 5], [300, 14.30, 0, 5], [7, 33.33, 1, 16]]) {
        const sold = C.calcSale([{ quantity: qty, unitPrice: price, discount: disc, taxRate: rate }]);
        const orig = sold.lines[0];
        let done = { quantity: 0, discount: 0, saleValue: 0, taxCharged: 0 };
        const notes = [];
        for (let i = 0; i < qty; i++) {
            const c = C.creditLine(orig, 1, done);
            for (const k of ['saleValue', 'discount', 'taxCharged', 'totalAmount']) assert.ok(c[k] >= 0, `${k} of note ${i + 1} (${qty} x ${price}) is ${c[k]}`);
            notes.push(c);
            const add = (a, b) => Math.round((a + b) * 100) / 100;
            done = { quantity: done.quantity + 1, discount: add(done.discount, c.discount), saleValue: add(done.saleValue, c.saleValue), taxCharged: add(done.taxCharged, c.taxCharged) };
        }
        const t = C.totalsOf(notes);
        assert.deepStrictEqual([t.saleValue, t.discount, t.tax, t.bill], [sold.totals.saleValue, sold.totals.discount, sold.totals.tax, sold.totals.bill], `${qty} x ${price}`);
    }
});

test('POS maths: no figure is rounded behind the user\'s back (extra decimals are refused, trailing zeros are fine)', () => {
    assert.throws(() => C.calcLine({ quantity: '1.00005', unitPrice: 10 }), /Quantity can have 4 decimal places at most/);
    assert.throws(() => C.calcLine({ quantity: 1, unitPrice: '10.505' }), /Price can have 2 decimal places at most/);
    assert.throws(() => C.calcLine({ quantity: 1, unitPrice: 10, discount: '0.005' }), /Discount can have 2 decimal places at most/);
    assert.throws(() => C.calcLine({ quantity: 1, unitPrice: 10, taxRate: '16.005' }), /Tax rate can have 2 decimal places at most/);
    assert.throws(() => C.discountFromPercent({ quantity: 1, unitPrice: 10 }, '12.345'), /Discount % can have 2 decimal places at most/);
    assert.throws(() => C.creditLine({ quantity: 2, discount: 0, saleValue: 20, taxCharged: 3.2, unitPrice: 10, taxRate: 16 }, '0.00001', { quantity: 0, discount: 0, saleValue: 0, taxCharged: 0 }), /Return quantity can have 4 decimal places/);
    const ok = C.calcLine({ quantity: '1.5000', unitPrice: '10.500', discount: '0.50', taxRate: '16.00' });
    assert.strictEqual(ok.total, 1769n); // 1.5 x 10.50 = 15.75, less 0.50 = 15.25, plus 16% (2.44) = 17.69 rupees
});

test('POS rule: above Rs 50,000 before tax the buyer\'s name and CNIC or NTN are needed (PRA e-IMS Rules, rule 6)', () => {
    assert.strictEqual(C.BUYER_REQUIRED_ABOVE, 50000);
    const named = { name: 'Ali Khan', cnic: '3520212345671' }, firm = { name: 'Khan Traders', pntn: '1234567-8' };
    for (const v of [0, 1, 49999.99, 50000, '50000.00']) assert.strictEqual(C.buyerProblem(v, {}), '', `${v} needs nothing`);
    for (const [v, b] of [[50000.01, named], [50000.01, firm], [1e6, { name: 'A', cnic: '1' }], [51000, { name: ' x ', pntn: '1' }]]) assert.strictEqual(C.buyerProblem(v, b), '', `${v} with ${JSON.stringify(b)}`);
    for (const b of [{}, undefined, null, { name: 'Ali Khan' }, { cnic: '3520212345671' }, { pntn: '1234567-8' }, { name: '   ', cnic: '3520212345671' }, { name: 'Ali', cnic: '  ', pntn: '' }]) {
        assert.match(C.buyerProblem(50000.01, b), /Rs 50,000.*name and CNIC.*NTN/, JSON.stringify(b));
    }
});
