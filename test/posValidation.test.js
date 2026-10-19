// What every Point of Sale input accepts and refuses, as tables. Field sizes are PRA's (POS Component manual v1.0, section 6):
// BuyerName 150, BuyerPNTN 9 ("1234567-8"), BuyerCNIC 13, BuyerPhoneNumber 20, ItemCode 50, ItemName 150, PCTCode 8, InvoiceNumber 30.
const test = require('node:test');
const assert = require('node:assert');
const V = require('../src/pos/validate');
const C = require('../src/pos/calc');

const accepts = (fn, rows) => { for (const [input, want, why] of rows) assert.deepStrictEqual(fn(input), want, why || JSON.stringify(input)); };
const refuses = (fn, rows, re) => { for (const input of rows) assert.throws(() => fn(input), e => (re ? re.test(e.message) : e instanceof Error), `should be refused: ${JSON.stringify(input)}`); };
const blank = { name: '', pntn: '', cnic: '', phone: '' };

test('validation: buyer details are optional, and in PRA\'s format when given', () => {
    accepts(V.cleanBuyer, [
        [undefined, blank], [{}, blank], [null, blank], ['text', blank], [[], blank],
        [{ name: '  Ali   Khan ' }, { ...blank, name: 'Ali Khan' }, 'white space is tidied'],
        [{ name: 'Ali\u0000 Khan\u0007' }, { ...blank, name: 'Ali Khan' }, 'control characters are dropped (a NUL byte would crash the database)'],
        [{ pntn: '1234567-8' }, { ...blank, pntn: '1234567-8' }], [{ pntn: '12345678' }, { ...blank, pntn: '1234567-8' }], [{ pntn: ' 1234567 8 ' }, { ...blank, pntn: '1234567-8' }],
        [{ cnic: '3520212345671' }, { ...blank, cnic: '3520212345671' }], [{ cnic: '35202-1234567-1' }, { ...blank, cnic: '3520212345671' }],
        [{ phone: '0300-1234567' }, { ...blank, phone: '03001234567' }], [{ phone: '+92 300 1234567' }, { ...blank, phone: '923001234567' }],
        [{ phone: '(042) 111-222-333' }, { ...blank, phone: '042111222333' }], [{ phone: '00923001234567' }, { ...blank, phone: '00923001234567' }, 'PRA\'s own sample'],
    ]);
    refuses(b => V.cleanBuyer({ pntn: b }), ['1234567', '123456789', 'ABC12345678', '1234567-8x', '1234567--8x', '12-34'], /PNTN/);
    refuses(b => V.cleanBuyer({ cnic: b }), ['35202123456', '35202123456712', 'abc3520212345', '3520212345671x'], /CNIC/);
    refuses(b => V.cleanBuyer({ phone: b }), ['12345', '1'.repeat(21), 'call me', '0300-ABC4567', '++923001234567'], /phone/);
    refuses(n => V.cleanBuyer({ name: n }), ['x'.repeat(151)], /too long/);
    assert.strictEqual(V.cleanBuyer({ name: 'x'.repeat(150) }).name.length, 150, 'the limit itself is fine');
});

test('validation: items', () => {
    const item = (over = {}) => ({ name: 'Tea', pctCode: '9801.2000', taxRate: '16', ...over });
    accepts(i => V.cleanItem(i).pctCode, [[item(), '98012000'], [item({ pctCode: '98012000' }), '98012000'], [item({ pctCode: '9801-2000' }), '98012000']]);
    accepts(i => V.cleanItem(i).code, [[item({ code: 'ITM-1' }), 'ITM-1'], [item({ code: 'a/b.c_d' }), 'a/b.c_d'], [item({ code: '' }), ''], [item({ code: 'x'.repeat(50) }), 'x'.repeat(50)]]);
    refuses(i => V.cleanItem(item({ code: i })), ['A B', 'x'.repeat(51), 'tea!', 'a,b', '<b>'], /code/i);
    refuses(i => V.cleanItem(item({ name: i })), ['', '   ', 'x'.repeat(151)], /name/i);
    refuses(i => V.cleanItem(item({ category: i })), ['x'.repeat(61)], /Category/);
    refuses(i => V.cleanItem(item({ pctCode: i })), ['9801200', '980120000', 'abcdefgh', '', '9801.20'], /PCT/);
    accepts(i => V.cleanItem(item({ taxRate: i })).taxRate, [['0', 0], ['16', 16], ['16.5', 16.5], ['100', 100], ['5.25', 5.25]]);
    refuses(i => V.cleanItem(item({ taxRate: i })), ['100.01', '-1', 'abc', '16.005', '', '1e1', '16%'], /Tax rate/);
    accepts(i => V.cleanItem(item({ taxRateCard: i })).taxRateCard, [['', null], [undefined, null], ['5', 5], ['0', 0]]);
    refuses(i => V.cleanItem(item({ taxRateCard: i })), ['x', '101', '-5', '5.005'], /card/);
    accepts(i => V.cleanItem(item({ unitPrice: i })).unitPrice, [['', 0], [undefined, 0], ['0', 0], ['120.5', 120.5], ['99999999.99', 99999999.99]]);
    refuses(i => V.cleanItem(item({ unitPrice: i })), ['100000000', '-1', '10.505', 'free', '1,000'], /Price/);
    assert.strictEqual(V.cleanItem(item({ openPrice: 'true' })).openPrice, true);
    assert.strictEqual(V.cleanItem(item({ openPrice: 'false' })).openPrice, false);
    assert.strictEqual(V.cleanItem(item({ active: false })).active, false);
    assert.strictEqual(V.cleanItem(item()).active, true, 'on sale unless switched off');
});

test('validation: how the sale was paid', () => {
    accepts(V.cleanPaymentMode, [[1, 1], [6, 6], ['3', 3], [' 4 ', 4], ['06', 6]]);
    refuses(V.cleanPaymentMode, [0, 7, -1, '1.5', 1.5, 'cash', '', null, undefined, true, false, [1], {}, '1e0', NaN, '100'], /paid/);
});

test('validation: business details, branches, counters and tokens', () => {
    accepts(p => V.cleanProfile(p).pntn, [[{ pntn: '1234567-8' }, '1234567-8'], [{ pntn: '1234567' }, '1234567'], [{ pntn: '' }, ''], [{}, '']]);
    refuses(p => V.cleanProfile({ pntn: p }), ['ABC', 'PNTN 1234567-8', '1234', '-1234567', '1234567-', '1'.repeat(21)]);
    refuses(n => V.cleanProfile({ businessName: n }), ['x'.repeat(151)], /Business name/);
    refuses(a => V.cleanProfile({ address: a }), ['x'.repeat(251)], /Address/);
    refuses(n => V.cleanBranch({ name: n }), ['', '  ', 'x'.repeat(81)]);
    assert.strictEqual(V.cleanBranch({ name: ' Main  branch ' }).name, 'Main branch');
    const counter = (over = {}) => ({ name: 'Till 1', posId: '900001', ...over });
    accepts(c => V.cleanCounter(counter(c)).posId, [[{}, '900001'], [{ posId: '0900001' }, '900001', 'leading zeros go'], [{ posId: ' 900001 ' }, '900001'], [{ posId: 123456789012345 }, '123456789012345']]);
    refuses(p => V.cleanCounter(counter({ posId: p })), ['', '000', 'abc', '90000a', 'POS-900001', '9000 01', '1234567890123456', '-5', '9.5', undefined, null], /POS ID/);
    refuses(n => V.cleanCounter(counter({ name: n })), ['', ' ', 'x'.repeat(61)]);
    accepts(c => V.cleanCounter(counter(c)).env, [[{}, 'SANDBOX'], [{ env: 'SANDBOX' }, 'SANDBOX'], [{ env: 'PRODUCTION' }, 'PRODUCTION']]);
    refuses(e => V.cleanCounter(counter({ env: e })), ['LIVE', 'production', 'prod', '', null, 1], /Sandbox or Production/);
    accepts(V.cleanToken, [['x'.repeat(16), 'x'.repeat(16)], ['  ' + 'y'.repeat(300) + '  ', 'y'.repeat(300)], ['x'.repeat(4096), 'x'.repeat(4096)]]);
    refuses(V.cleanToken, ['', 'short', 'x'.repeat(15), 'has a space in the middle of it', 'x'.repeat(4097), undefined, null], /token/);
});

test('validation: quantities, prices and discounts in the money maths', () => {
    const line = (over = {}) => ({ quantity: 1, unitPrice: 100, taxRate: 16, ...over });
    for (const q of ['1', '0.0001', '1000000', '2.5', '3.0000', 7]) assert.doesNotThrow(() => C.calcLine(line({ quantity: q })), `quantity ${q}`);
    for (const [q, re] of [['', /Quantity/], ['abc', /Quantity/], ['-1', /Quantity/], ['1e3', /Quantity/], ['1,5', /Quantity/], ['0', /more than zero/], ['0.0000', /more than zero/], ['1000000.0001', /1,000,000/], ['0.00001', /4 decimal/], [null, /Quantity/], [undefined, /Quantity/], [{}, /Quantity/]]) {
        assert.throws(() => C.calcLine(line({ quantity: q })), re, `quantity ${JSON.stringify(q)}`);
    }
    for (const p of ['0', '0.01', '99999999.99', 150.5]) assert.doesNotThrow(() => C.calcLine(line({ quantity: 1, unitPrice: p })), `price ${p}`);
    for (const [p, re] of [['', /Price/], ['-1', /Price/], ['free', /Price/], ['10.505', /2 decimal/], ['100000000', /99,999,999\.99/], [undefined, /Price/]]) {
        assert.throws(() => C.calcLine(line({ unitPrice: p })), re, `price ${JSON.stringify(p)}`);
    }
    for (const d of [undefined, null, '', '0', '100', 0.5, '99.99']) assert.doesNotThrow(() => C.calcLine(line({ discount: d })), `discount ${d}`);
    for (const [d, re] of [['100.01', /more than the item amount/], ['-1', /Discount/], ['ten', /Discount/], ['0.005', /2 decimal/]]) assert.throws(() => C.calcLine(line({ discount: d })), re, `discount ${d}`);
    for (const r of [undefined, '', '0', '16', '100', '0.01']) assert.doesNotThrow(() => C.calcLine(line({ taxRate: r })), `rate ${r}`);
    for (const [r, re] of [['100.01', /100%/], ['-5', /Tax rate/], ['sixteen', /Tax rate/], ['16.001', /2 decimal/]]) assert.throws(() => C.calcLine(line({ taxRate: r })), re, `rate ${r}`);
    assert.throws(() => C.calcSale([]), /at least one/);
    assert.throws(() => C.calcSale(null), /at least one/);
    assert.throws(() => C.calcSale([line({ quantity: 1000000, unitPrice: 99999999.99 })]), /too much/);
    assert.throws(() => C.calcSale([line({ quantity: 1, unitPrice: 99999999.99 }), ...Array(1000).fill(line({ quantity: 1, unitPrice: 99999999.99 }))]), /too much for one invoice/);
    assert.throws(() => C.discountFromPercent(line(), '100.01'), /100%/);
    assert.throws(() => C.discountFromPercent(line(), '-1'), /Discount %/);
    assert.strictEqual(C.discountFromPercent(line({ quantity: 3, unitPrice: 33.33 }), '10'), 10);
});

test('validation: every figure in the PRA payload stays inside PRA\'s field sizes', () => {
    const { buildPayload, reconcile } = require('../src/pos/payload');
    const calc = C.calcSale([{ quantity: '2', unitPrice: '1500', discount: '300', taxRate: 16 }]);
    const lines = calc.lines.map(l => ({ ...l, itemCode: 'x'.repeat(50), itemName: 'y'.repeat(150), pctCode: '98012000' }));
    const p = buildPayload({ posId: '900001', usin: '000001', dateTime: new Date('2026-10-19T08:00:00Z'), buyer: { name: 'z'.repeat(150), pntn: '1234567-8', cnic: '3520212345671', phone: '1'.repeat(20) }, paymentMode: 1, invoiceType: 1, lines, totals: calc.totals });
    assert.deepStrictEqual(reconcile(p), []);
    assert.ok(p.InvoiceNumber === '' && p.USIN.length <= 50 && p.BuyerName.length <= 150 && p.BuyerPNTN.length <= 9 && p.BuyerCNIC.length === 13 && p.BuyerPhoneNumber.length <= 20);
    assert.ok(p.Items.every(i => i.ItemCode.length <= 50 && i.ItemName.length <= 150 && i.PCTCode.length === 8));
    assert.match(p.DateTime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.strictEqual(p.DateTime, '2026-10-19 13:00:00', 'Pakistan time (UTC+5)');
    assert.ok([1, 2, 3, 4, 5, 6].includes(p.PaymentMode) && [1, 2, 3].includes(p.InvoiceType));
});
