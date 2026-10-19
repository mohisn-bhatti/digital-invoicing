// Filters and reports: every way of grouping is checked against a sum made a different way (straight from the saved lines), the list and
// the report agree for the same filters, test and real sales are kept apart, days end at midnight in Pakistan, and nothing a person types
// can reach the database as anything but a value.
const test = require('node:test');
const assert = require('node:assert');
const { createWorld } = require('../test-helpers/posWorld');
const R = require('../src/pos/reports');

const W = createWorld('reports');
const run = W.run;
test('reports: set up a business', async t => { await W.setup(t); });
test.after(() => W.teardown());

const PKT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' });
const PKT_HOUR = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', hourCycle: 'h23' });
const ali = () => W.ctxFor(W.tenantId, 'ali@test'), sara = () => W.ctxFor(W.tenantId, 'sara@test');
const at = iso => { W.clock = Date.parse(iso); };
const sell = (ctx, iso, over = {}) => { at(iso); return W.sellOne(over, ctx); };
const inTestMode = async fn => { W.pra.mock = true; try { return await fn(); } finally { W.pra.mock = false; } };
const by = (groupBy, filters = {}) => inTestMode(() => W.svc.reportBy(W.ctx, groupBy, { from: '2026-10-01', to: '2026-10-31', ...filters }));
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 0.005, `${what}: ${a} is not ${b}`);
const D = {}; // what the data set made, for the checks

run('reports: a week of sales, two cashiers, two counters, a customer, a return, a refusal and a cancellation', async () => {
    const branch2 = await W.svc.createBranch(W.ctx, { name: 'Annex', city: 'Lahore' });
    await W.svc.createCounter(W.ctx, { branchId: branch2.id, name: 'Till 2', posId: '900002', env: 'SANDBOX', token: 'sandbox-token-2222222222' });
    await W.svc.createCounter(W.ctx, { branchId: W.branch.id, name: 'Live till', posId: '900003', env: 'PRODUCTION', token: 'production-token-33333333' });
    const counters = (await W.svc.listBranches(W.tenantId)).flatMap(b => b.counters);
    D.till1 = W.counter; D.till2 = counters.find(c => c.name === 'Till 2'); D.live = counters.find(c => c.name === 'Live till');
    D.khan = await W.svc.createCustomer(W.ctx, { name: 'Khan Events', pntn: '1234567-8' });
    const { lunch, drink, hall } = W.items;
    // days are Pakistan days: 08:00Z is 13:00 there. 18:59Z on the 18th is 23:59 on the 18th; 19:00Z is already the 19th.
    D.s1 = (await sell(ali(), '2026-10-17T08:00:00Z', { lines: [{ itemId: lunch.id, quantity: 2 }] })).sale;
    D.s2 = (await sell(sara(), '2026-10-17T15:30:00Z', { paymentMode: 2, lines: [{ itemId: lunch.id, quantity: 1 }] })).sale; // card: the 5% rate
    D.s3 = (await sell(ali(), '2026-10-18T08:00:00Z', { counterId: D.till2.id, customerId: D.khan.id, lines: [{ itemId: drink.id, quantity: 4 }, { itemId: lunch.id, quantity: 1, discount: 150 }] })).sale;
    D.s4 = (await sell(sara(), '2026-10-18T18:59:00Z', { lines: [{ itemId: drink.id, quantity: 2 }] })).sale;   // 23:59 on the 18th
    D.s5 = (await sell(sara(), '2026-10-18T19:00:00Z', { lines: [{ itemId: drink.id, quantity: 3 }] })).sale;   // 00:00 on the 19th
    D.s6 = (await sell(ali(), '2026-10-19T07:00:00Z', { counterId: D.till2.id, paymentMode: 5, lines: [{ itemId: hall.id, quantity: 1, unitPrice: '20000.50', discountPercent: 10 }] })).sale;
    // a return of one lunch from the first sale
    at('2026-10-19T09:00:00Z');
    const d1 = await W.svc.saleDetail(W.ctx, D.s1.id);
    D.cn = (await W.svc.creditNote(ali(), D.s1.id, { lines: [{ lineId: d1.lines[0].id, quantity: 1 }], reason: 'One buffet not eaten' })).sale;
    // PRA refuses one; one is refused and cancelled; neither is in the figures
    at('2026-10-19T10:00:00Z');
    W.pra.queue.push(W.answer('REJECTED', 'Invalid buyer PNTN', { code: '110', httpStatus: 200 }));
    D.rejected = (await W.sellOne({ buyer: { name: 'Bad', pntn: '1111111-1' } }, ali())).sale;
    W.pra.queue.push(W.answer('REJECTED', 'Invalid buyer PNTN', { code: '110', httpStatus: 200 }));
    const toCancel = (await W.sellOne({ buyer: { name: 'Bad 2', pntn: '1111111-2' } }, ali())).sale;
    await W.svc.cancel(ali(), toCancel.id, 'Customer left');
    // a real (production) sale: a different kind of figure
    W.pra.mock = false;
    D.real = (await sell(ali(), '2026-10-19T11:00:00Z', { counterId: D.live.id, lines: [{ itemId: lunch.id, quantity: 1 }] })).sale;
    assert.strictEqual(D.real.env, 'PRODUCTION');
    assert.strictEqual(D.rejected.state, 'REJECTED');
});

// The same sums made the long way: every saved line, grouped here in JavaScript, no SQL
async function reference(groupBy) {
    const counters = new Map((await W.prisma.posCounter.findMany({ where: { tenantId: W.tenantId } })).map(c => [c.id, c]));
    const lines = await W.prisma.posSaleLine.findMany({ where: { sale: { tenantId: W.tenantId, state: 'FISCALIZED', env: 'SANDBOX' } }, include: { sale: true } });
    const keyOf = l => {
        const s = l.sale, day = PKT_DAY.format(s.createdAt);
        switch (groupBy) {
            case 'day': return day;
            case 'month': return day.slice(0, 7);
            case 'weekday': return String(new Date(`${day}T12:00:00Z`).getUTCDay() || 7);
            case 'hour': return PKT_HOUR.format(s.createdAt);
            case 'item': return l.itemCode;
            case 'category': return l.category;
            case 'cashier': return s.createdBy.toLowerCase();
            case 'counter': return s.counterId;
            case 'branch': return counters.get(s.counterId).branchId;
            case 'payment': return String(s.paymentMode);
            case 'taxRate': return Number(l.taxRate).toFixed(2);
            case 'customer': return s.customerId || '';
            default: throw new Error(groupBy);
        }
    };
    const out = new Map();
    for (const l of lines) {
        const k = keyOf(l), g = out.get(k) || { sold: new Set(), returned: new Set(), qty: 0, rqty: 0, value: 0, rvalue: 0, discount: 0, tax: 0, rtax: 0, bill: 0, rbill: 0 };
        const sale = l.sale.invoiceType === 1;
        (sale ? g.sold : g.returned).add(l.saleId);
        g[sale ? 'qty' : 'rqty'] += Number(l.quantity); g[sale ? 'value' : 'rvalue'] += Number(l.saleValue); g[sale ? 'tax' : 'rtax'] += Number(l.taxCharged); g[sale ? 'bill' : 'rbill'] += Number(l.totalAmount);
        if (sale) g.discount += Number(l.discount);
        out.set(k, g);
    }
    return out;
}

for (const groupBy of ['day', 'month', 'weekday', 'hour', 'item', 'category', 'cashier', 'counter', 'branch', 'payment', 'taxRate', 'customer']) {
    run(`reports: by ${groupBy} adds up exactly what the saved lines add up to`, async () => {
        const rep = await by(groupBy), want = await reference(groupBy);
        assert.deepStrictEqual(rep.rows.map(r => r.key).sort(), [...want.keys()].map(k => (groupBy === 'taxRate' ? k : k)).sort(), 'the same groups');
        for (const r of rep.rows) {
            const w = want.get(r.key);
            assert.strictEqual(r.sales, w.sold.size, `${r.key}: sales`); assert.strictEqual(r.returns, w.returned.size, `${r.key}: returns`);
            near(r.quantity, w.qty, `${r.key} quantity`); near(r.saleValue, w.value, `${r.key} value`); near(r.discount, w.discount, `${r.key} discount`);
            near(r.tax, w.tax, `${r.key} tax`); near(r.bill, w.bill, `${r.key} bill`);
            near(r.returnBill, w.rbill, `${r.key} returned`); near(r.netBill, w.bill - w.rbill, `${r.key} net`); near(r.netTax, w.tax - w.rtax, `${r.key} net tax`); near(r.netQuantity, w.qty - w.rqty, `${r.key} net quantity`);
        }
        // the totals are the whole, not the sum of groups counted twice (a sale with two items is one sale)
        const all = [...want.values()];
        near(rep.totals.netBill, all.reduce((t, g) => t + g.bill - g.rbill, 0), 'total net');
        assert.strictEqual(rep.totals.sales, 7 - 1 /* S1..S6 */ + 0, 'six sales in the figures: not the refused or cancelled ones, not the real one');
        assert.strictEqual(rep.totals.returns, 1);
        assert.strictEqual(rep.scope, 'TEST');
        assert.strictEqual(rep.leftOut, 1, 'the production sale is said to be left out');
        const shares = rep.rows.reduce((t, r) => t + r.share, 0);
        assert.ok(Math.abs(shares - 100) <= 0.05 * rep.rows.length + 0.001, `the shares (each to a tenth of a percent) add up to 100: ${shares}`);
    });
}

run('reports: the labels say who and what, not ids', async () => {
    const lab = async (groupBy, filters) => Object.fromEntries((await by(groupBy, filters)).rows.map(r => [r.key, r.label]));
    assert.deepStrictEqual(Object.values(await lab('payment')).sort(), ['Card', 'Cash', 'Mixed']);
    assert.deepStrictEqual(Object.values(await lab('counter')).sort(), ['Annex · Till 2', 'Main · Till 1']);
    assert.deepStrictEqual(Object.values(await lab('branch')).sort(), ['Annex', 'Main']);
    assert.deepStrictEqual(Object.values(await lab('cashier')).sort(), ['ali', 'sara'], 'the part of the email before the @ (no user of that name here)');
    assert.deepStrictEqual(Object.values(await lab('customer')).sort(), ['Khan Events (CUS0001)', 'No saved customer']);
    assert.deepStrictEqual(Object.values(await lab('taxRate')).sort(), ['16%', '5%']);
    assert.deepStrictEqual(Object.values(await lab('weekday')).sort(), ['Monday', 'Saturday', 'Sunday']); // 17, 18 and 19 October 2026
    assert.deepStrictEqual(Object.keys(await lab('hour')).sort(), ['00', '12', '13', '14', '20', '23']);
    assert.ok(Object.values(await lab('hour')).includes('13:00 to 13:59'));
    assert.deepStrictEqual(Object.values(await lab('day')), ['Sat, 17 Oct 2026', 'Sun, 18 Oct 2026', 'Mon, 19 Oct 2026'], 'a day is a date people read, in order');
    assert.deepStrictEqual(Object.keys(await lab('day')), ['2026-10-17', '2026-10-18', '2026-10-19'], 'and its key stays sortable');
    assert.deepStrictEqual(Object.values(await lab('month')), ['October 2026']);
    assert.deepStrictEqual(Object.values(await lab('item')).sort(), ['Hall booking', 'Lunch buffet', 'Soft drink']);
    assert.deepStrictEqual(Object.values(await lab('category')).sort(), ['Drinks', 'Food', 'Halls']);
});

run('reports: the day ends at midnight in Pakistan (23:59 and 00:00 are different days)', async () => {
    const days = Object.fromEntries((await by('day')).rows.map(r => [r.key, r]));
    assert.deepStrictEqual(Object.keys(days).sort(), ['2026-10-17', '2026-10-18', '2026-10-19']);
    // 18 Oct: S3 (13:00) and S4 (23:59); 19 Oct: S5 (00:00), S6 and the credit note
    assert.strictEqual(days['2026-10-18'].sales, 2);
    assert.strictEqual(days['2026-10-19'].sales, 2);
    assert.strictEqual(days['2026-10-19'].returns, 1);
    // a one-day range takes exactly that day
    const one = await by('item', { from: '2026-10-18', to: '2026-10-18' });
    assert.strictEqual(one.totals.sales, 2);
    const next = await by('item', { from: '2026-10-19', to: '2026-10-19' });
    assert.strictEqual(next.totals.sales, 2);
});

run('reports: filters narrow the figures, and the list agrees with the report for the same filters', async () => {
    const cases = [
        {}, { counterId: D.till2.id }, { branchId: D.till2.branchId }, { cashier: 'ALI@test' }, { cashier: 'sara@test' }, { paymentMode: 1 }, { paymentMode: 2 }, { paymentMode: 5 },
        { customerId: D.khan.id }, { customerId: 'none' }, { itemId: W.items.drink.id }, { category: 'Food' }, { category: 'Halls' }, { taxRate: 5 }, { taxRate: '16' },
        { minAmount: 2000 }, { maxAmount: 2000 }, { minAmount: 500, maxAmount: 3000 }, { from: '2026-10-18', to: '2026-10-18' }, { cashier: 'ali@test', paymentMode: 1, category: 'Food' },
        { counterId: D.till2.id, customerId: D.khan.id }, { invoiceType: 'sale' }, { invoiceType: 'return' },
    ];
    for (const f of cases) {
        const rep = await by('day', f);
        const listed = await inTestMode(() => W.svc.listSales(W.ctx, { from: '2026-10-01', to: '2026-10-31', state: 'FISCALIZED', limit: 500, ...f }));
        const sold = listed.sales.filter(s => s.invoiceType === 1 && s.env === 'SANDBOX').length, back = listed.sales.filter(s => s.invoiceType === 3 && s.env === 'SANDBOX').length;
        assert.strictEqual(rep.totals.sales, sold, `${JSON.stringify(f)}: sales in the report and in the list`);
        assert.strictEqual(rep.totals.returns, back, `${JSON.stringify(f)}: returns in the report and in the list`);
    }
    // and the figures themselves move the way they should: four sales were paid in cash (S1, S3, S4, S5)
    assert.strictEqual((await by('day', { paymentMode: 1 })).totals.sales, 4);
});

run('reports: the filters in the list are exact', async () => {
    const list = f => inTestMode(() => W.svc.listSales(W.ctx, { from: '2026-10-01', to: '2026-10-31', limit: 500, ...f }));
    const ids = async f => (await list(f)).sales.map(s => s.usin).sort();
    const all = await ids({});
    assert.ok(all.length >= 9, 'every sale in range, whatever its state');
    assert.deepStrictEqual(await ids({ state: 'REJECTED' }), [D.rejected.usin]);
    assert.deepStrictEqual(await ids({ state: 'CANCELLED' }).then(a => a.length), 1);
    assert.deepStrictEqual(await ids({ invoiceType: 'return' }), [D.cn.usin]);
    assert.deepStrictEqual(await ids({ customerId: D.khan.id }), [D.s3.usin]);
    assert.ok((await ids({ customerId: 'none' })).length === all.length - 1, 'sales with no saved customer');
    assert.deepStrictEqual(await ids({ q: D.s2.fiscalNumber.toLowerCase() }), [D.s2.usin], 'by PRA number, any case');
    assert.deepStrictEqual(await ids({ q: D.s4.usin }), [D.s4.usin]);
    assert.deepStrictEqual(await ids({ itemId: W.items.hall.id }), [D.s6.usin]);
    assert.deepStrictEqual(await ids({ category: 'Halls' }), [D.s6.usin]);
    assert.deepStrictEqual(await ids({ taxRate: 5 }), [D.s2.usin, D.s6.usin].sort(), 'the hall, and the card payment (its line carries the 5% it was taxed at)');
    assert.deepStrictEqual(await ids({ cashier: 'Sara@Test', state: 'FISCALIZED' }), [D.s2.usin, D.s4.usin, D.s5.usin].sort());
    const big = (await list({ minAmount: 18000 })).sales;
    assert.deepStrictEqual(big.map(s => s.usin), [D.s6.usin], 'bills of at least Rs 18,000 (the hall: 20,000.50 less 10%, and 5% tax)');
    assert.strictEqual((await list({ counterId: D.till2.id })).total, 2);
    assert.strictEqual((await list({ branchId: D.till2.branchId })).total, 2);
    // paging still works with the filters
    const page = await list({ limit: 3, offset: 3 });
    assert.strictEqual(page.sales.length, 3);
    assert.strictEqual(page.total, all.length);
});

run('reports: what is refused', async () => {
    const bad = (f, re) => W.rejects(by('day', f), 400, re);
    await bad({ from: '2026-02-31' }, /real date/);
    await bad({ from: '2026-10-20', to: '2026-10-01' }, /after the "to" date/);
    await bad({ paymentMode: 9 }, /how the sale was paid/);
    await bad({ paymentMode: 'cash' }, /how the sale was paid/);
    await bad({ invoiceType: 'refund' }, /sales or returns/);
    await bad({ taxRate: '16%' }, /tax rate/);
    await bad({ taxRate: 101 }, /tax rate/);
    await bad({ minAmount: '-5' }, /smallest bill/);
    await bad({ minAmount: 500, maxAmount: 100 }, /more than the largest/);
    await bad({ state: 'MADE_UP' }, /status/);
    await W.rejects(W.svc.reportBy(W.ctx, 'day', { from: '2026-10-01' }), 400, /Choose the dates/);
    await W.rejects(W.svc.reportBy(W.ctx, 'day', {}), 400, /Choose the dates/);
    await W.rejects(W.svc.reportBy(W.ctx, 'day', { from: '2025-01-01', to: '2026-10-31' }), 400, /400 days at most/);
    await W.rejects(W.svc.reportBy(W.ctx, 'color', { from: '2026-10-01', to: '2026-10-02' }), 400, /what to group the report by/);
    await W.rejects(W.svc.reportBy(W.ctx, '__proto__', { from: '2026-10-01', to: '2026-10-02' }), 400);
    // the list refuses the same
    await W.rejects(W.svc.listSales(W.ctx, { from: '2026-13-01' }), 400, /real date/);
    await W.rejects(W.svc.listSales(W.ctx, { paymentMode: 0 }), 400);
    assert.strictEqual((await by('day', { from: '2025-09-17', to: '2026-10-21' })).totals.sales, 6, 'a year and a month is allowed');
});

run('reports: what a person types is only ever a value', async () => {
    const nasty = ["' OR 1=1 --", '"; DROP TABLE "PosSale"; --', "ali@test' OR 'x'='x", '\u0000\u0001x', '%', '_', 'a'.repeat(500)];
    for (const text of nasty) {
        for (const f of [{ cashier: text }, { category: text }, { customerId: text }, { itemId: text }, { counterId: text }, { branchId: text }]) {
            const rep = await by('item', f);
            assert.strictEqual(rep.totals.sales, 0, `${JSON.stringify(f).slice(0, 50)} matches nothing and breaks nothing`);
            await inTestMode(() => W.svc.listSales(W.ctx, { from: '2026-10-01', to: '2026-10-31', q: text, ...f }));
        }
    }
    assert.ok((await W.prisma.posSale.count({ where: { tenantId: W.tenantId } })) >= 9, 'the table is still there');
});

run('reports: test sales and real sales are never added together', async () => {
    const test = await by('item');
    assert.strictEqual(test.scope, 'TEST');
    assert.strictEqual(test.leftOut, 1);
    const live = await W.svc.reportBy(W.ctx, 'item', { from: '2026-10-01', to: '2026-10-31' }); // the server is live again (mock off)
    assert.strictEqual(live.scope, 'LIVE');
    assert.strictEqual(live.totals.sales, 1, 'only the real sale');
    assert.strictEqual(live.leftOut, 7, 'the six test sales and the return are said to be left out');
    assert.deepStrictEqual(live.rows.map(r => r.label), ['Lunch buffet']);
});

run('reports: another business\'s sales are never in them', async () => {
    const rep = await inTestMode(() => W.svc.reportBy(W.ctxOther, 'day', { from: '2026-10-01', to: '2026-10-31' }));
    assert.strictEqual(rep.totals.sales, 0);
    assert.deepStrictEqual(rep.rows, []);
    const close = await inTestMode(() => W.svc.reportClosing(W.ctxOther, { date: '2026-10-18' }));
    assert.strictEqual(close.totals.sales, 0);
    const opts = await W.svc.reportOptions(W.ctxOther);
    assert.deepStrictEqual(opts.cashiers, []);
});

run('reports: the closing sheet for a day', async () => {
    const c = await inTestMode(() => W.svc.reportClosing(W.ctx, { date: '2026-10-19' }));
    assert.strictEqual(c.date, '2026-10-19');
    assert.strictEqual(c.scope, 'TEST');
    assert.strictEqual(c.business.name, 'Test Restaurant');
    assert.strictEqual(c.counter, null);
    assert.strictEqual(c.totals.sales, 2, 'S5 at 00:00 and S6');
    assert.strictEqual(c.totals.returns, 1);
    // first and last sale of the day
    assert.strictEqual(c.firstSale.usin, D.s5.usin);
    assert.strictEqual(c.lastSale.usin, D.s6.usin);
    assert.strictEqual(c.firstSale.fiscalNumber, D.s5.fiscalNumber);
    // how it was paid; the cash that should be in the drawer is the cash sales less the cash returned
    const pay = Object.fromEntries(c.byPayment.map(p => [p.label, p]));
    assert.deepStrictEqual(Object.keys(pay).sort(), ['Cash', 'Mixed']);
    near(c.cashExpected, pay.Cash.netBill, 'cash expected');
    near(pay.Cash.returnBill, Number(D.cn.totalBill), 'the return was paid back in cash');
    near(c.cashExpected, pay.Cash.bill - Number(D.cn.totalBill), 'cash less the cash given back');
    // tax by rate adds up to the day's tax
    near(c.byTaxRate.reduce((t, r) => t + r.netTax, 0), c.totals.netTax, 'tax by rate');
    // what still needs sorting before the day is closed: the refused sale and the cancelled one
    assert.deepStrictEqual(c.notFiscalized, { waiting: 0, refused: 1, unknown: 0, cancelled: 1 });
    assert.deepStrictEqual(c.returned.map(r => [r.usin, r.refUsin]), [[D.cn.usin, D.s1.usin]]);
    assert.strictEqual(c.leftOut, 1, 'the real sale of the day is said to be left out');
    // one counter, one cashier
    const t2 = await inTestMode(() => W.svc.reportClosing(W.ctx, { date: '2026-10-19', counterId: D.till2.id }));
    assert.deepStrictEqual(t2.counter, { name: 'Till 2', posId: '900002', branch: 'Annex' });
    assert.strictEqual(t2.totals.sales, 1);
    assert.strictEqual(t2.firstSale.usin, D.s6.usin);
    assert.deepStrictEqual(t2.notFiscalized, { waiting: 0, refused: 0, unknown: 0, cancelled: 0 }, 'the refused sales were on Till 1');
    const mine = await inTestMode(() => W.svc.reportClosing(W.ctx, { date: '2026-10-19', cashier: 'sara@test' }));
    assert.strictEqual(mine.cashier, 'sara@test');
    assert.strictEqual(mine.totals.sales, 1);
    assert.strictEqual(mine.firstSale.usin, D.s5.usin);
    // a day with nothing
    const empty = await inTestMode(() => W.svc.reportClosing(W.ctx, { date: '2026-10-25' }));
    assert.deepStrictEqual([empty.totals.sales, empty.firstSale, empty.lastSale, empty.cashExpected], [0, null, null, 0]);
    // it is for one day, and filters that would narrow the till are ignored
    await W.rejects(W.svc.reportClosing(W.ctx, {}), 400, /day to close/);
    await W.rejects(W.svc.reportClosing(W.ctx, { from: '2026-10-18', to: '2026-10-19' }), 400, /day to close/);
    const same = await inTestMode(() => W.svc.reportClosing(W.ctx, { date: '2026-10-19', category: 'Halls', itemId: 'x' }));
    assert.strictEqual(same.totals.sales, 2);
});

run('reports: the boxes the filters offer', async () => {
    const o = await W.svc.reportOptions(W.ctx);
    assert.deepStrictEqual(o.branches.map(b => [b.name, b.counters.map(c => c.name).sort()]).sort(), [['Annex', ['Till 2']], ['Main', ['Live till', 'Till 1']]]);
    assert.deepStrictEqual(o.cashiers.map(c => c.email), ['ali@test', 'sara@test']);
    assert.deepStrictEqual(o.categories, ['Drinks', 'Food', 'Halls']);
    assert.deepStrictEqual(o.taxRates, [5, 16]);
    assert.deepStrictEqual(o.paymentModes.map(m => m.label), ['Cash', 'Card', 'Gift Voucher', 'Loyalty Card', 'Mixed', 'Cheque']);
    assert.ok(o.groupings.some(g => g.id === 'day' && g.title === 'Day') && o.groupings.some(g => g.id === 'taxRate'));
    assert.strictEqual(o.testMode, false);
});

run('reports: the report as a spreadsheet', async () => {
    await W.svc.createItem(W.ctx, { name: '=HYPERLINK("http://x")', pctCode: '9801.2000', taxRate: 16, unitPrice: 10, category: '@cat' });
    const odd = (await W.svc.listItems(W.tenantId, {})).find(i => i.name.startsWith('='));
    await sell(ali(), '2026-10-19T12:00:00Z', { lines: [{ itemId: odd.id, quantity: 1 }] });
    const r = await inTestMode(() => W.svc.reportCsv(W.ctx, 'item', { from: '2026-10-01', to: '2026-10-31' }));
    assert.match(r.filename, /^pos-report-item-2026-10-01-to-2026-10-31-test\.csv$/);
    const lines = r.csv.trim().split('\r\n');
    assert.match(lines[0], /^Item,Invoices,Quantity,Value before tax,Discount,Sales tax,Total,Returns,Returned total,Net quantity,Net value,Net sales tax,Net total,Share %$/);
    assert.ok(lines.some(l => /^Lunch buffet,/.test(l)));
    const byDay = await inTestMode(() => W.svc.reportCsv(W.ctx, 'day', { from: '2026-10-01', to: '2026-10-31' }));
    assert.ok(byDay.csv.split('\r\n')[1].startsWith('2026-10-17,'), 'dates in a spreadsheet stay as 2026-10-17');
    assert.ok(/^Total,/.test(lines[lines.length - 1]) && /,100\.0$/.test(lines[lines.length - 1]));
    assert.ok(r.csv.includes(`"'=HYPERLINK(""http://x"")"`), 'a name that Excel would run as a formula is defused');
    assert.strictEqual(lines.length, r.rows + 2);
    assert.ok(W.audits.some(a => /pos\.export: Exported the report by item \(2026-10-01 to 2026-10-31\)/.test(a)));
    await W.rejects(W.svc.reportCsv(W.ctx, 'item', { from: '2026-10-01' }), 400, /Choose the dates/);
});

// ---------- from a report row to the invoices behind it ----------
const Drill = require('../public/pos-drill');

run('reports: a row\'s invoices are exactly the invoices the row counted, for every way of grouping and with filters carried over', async () => {
    const drillable = ['day', 'month', 'item', 'category', 'cashier', 'counter', 'branch', 'payment', 'taxRate', 'customer'];
    const wholeInvoice = new Set(['day', 'month', 'cashier', 'counter', 'branch', 'payment', 'customer']); // the row adds up whole invoices (not just some lines of each)
    let rows = 0;
    for (const [label, extra] of [['everything', {}], ['sales only', { invoiceType: 'sale' }], ['returns only', { invoiceType: 'return' }], ['drinks only', { category: 'Drinks' }], ['one cashier', { cashier: 'ali@test' }], ['bills of 1,000 and more', { minAmount: '1000' }], ['the 16% lines', { taxRate: '16' }]]) {
        for (const g of drillable) {
            const rep = await by(g, extra);
            const range = { from: rep.filters.from, to: rep.filters.to };
            for (const row of rep.rows) {
                const mine = Drill.forRow(g, row, range);
                assert.ok(mine, `${label} / ${g} / ${row.label}: there is a list for every row`);
                // what the Sales page sends: the report's own filters, then the row's group, then "fiscalized" and the kind of sale the figures cover
                const list = await W.svc.listSales(W.ctx, { ...rep.filters, ...mine, state: 'FISCALIZED', env: 'SANDBOX', limit: 500 });
                assert.strictEqual(list.total, row.sales + row.returns, `${label} / ${g} / ${row.label}: the list has ${list.total} invoices, the row counted ${row.sales + row.returns}`);
                assert.strictEqual(list.sales.length, list.total);
                if (wholeInvoice.has(g) && !extra.category && !extra.taxRate) {
                    const net = list.sales.reduce((t, s) => t + (s.invoiceType === 3 ? -1 : 1) * s.totalBill, 0);
                    near(net, row.netBill, `${label} / ${g} / ${row.label}: the invoices add up to the row's net total`);
                }
                rows++;
            }
        }
    }
    assert.ok(rows > 100, `a good many rows were checked (${rows})`);
});

run('reports: without the kind of sale a row\'s list takes in the other kind too, which is why the link says it', async () => {
    const rep = await by('item');
    const lunch = rep.rows.find(r => r.label === 'Lunch buffet');
    const mine = Drill.forRow('item', lunch, { from: rep.filters.from, to: rep.filters.to });
    const base = { ...rep.filters, ...mine, state: 'FISCALIZED', limit: 500 };
    const kind = await W.svc.listSales(W.ctx, { ...base, env: 'SANDBOX' }), both = await W.svc.listSales(W.ctx, base), real = await W.svc.listSales(W.ctx, { ...base, env: 'production' });
    assert.strictEqual(kind.total, lunch.sales + lunch.returns);
    assert.strictEqual(real.total, 1, 'the one real sale of the lunch (counter "Live till")');
    assert.strictEqual(both.total, kind.total + real.total);
    await W.rejects(W.svc.listSales(W.ctx, { env: 'banana' }), 400, /test \(sandbox\) or real \(production\)/);
    await W.rejects(W.svc.reportBy(W.ctx, 'item', { from: '2026-10-01', to: '2026-10-31', env: ['SANDBOX', 'x'] }), 400, /test \(sandbox\) or real \(production\)/);
});

run('reports: the item filter works by code, in the list, the totals and the reports, and a closing sheet ignores it', async () => {
    const { lunch } = W.items;
    const q = { from: '2026-10-01', to: '2026-10-31', itemCode: lunch.code, state: 'FISCALIZED', env: 'SANDBOX', limit: 500 };
    const list = await W.svc.listSales(W.ctx, q);
    assert.ok(list.total > 0);
    const rep = await inTestMode(() => W.svc.reportBy(W.ctx, 'item', { from: '2026-10-01', to: '2026-10-31', itemCode: lunch.code }));
    assert.deepStrictEqual(rep.rows.map(r => r.label), ['Lunch buffet'], 'only that item is in the report');
    assert.strictEqual(rep.totals.sales + rep.totals.returns, list.total);
    assert.strictEqual((await W.svc.listSales(W.ctx, { ...q, itemCode: 'NO-SUCH-ITEM' })).total, 0);
    assert.strictEqual((await W.svc.listSales(W.ctx, { ...q, itemCode: lunch.code.toLowerCase() })).total, 0, 'a code is matched as it is stored');
    for (const hostile of ["x' OR '1'='1", '%', '_', 'ITM%']) assert.strictEqual((await W.svc.listSales(W.ctx, { ...q, itemCode: hostile })).total, 0, hostile);
    // the spreadsheet and the totals take the same filter
    const csv = await W.svc.salesCsv(W.ctx, { ...q, detail: 'lines' });
    assert.strictEqual(csv.rows, list.total, 'the spreadsheet has the same invoices as the list (each with all of its lines)');
    assert.ok(csv.csv.includes('Lunch buffet'));
    const totals = await inTestMode(() => W.svc.salesReport(W.ctx, { from: '2026-10-01', to: '2026-10-31', itemCode: lunch.code }));
    assert.strictEqual(totals.sales.count + totals.returns.count, list.total);
    // the closing sheet is the whole till for the day, whatever else is asked
    const sheet = await inTestMode(() => W.svc.reportClosing(W.ctx, { date: '2026-10-18' }));
    const same = await inTestMode(() => W.svc.reportClosing(W.ctx, { date: '2026-10-18', itemCode: lunch.code, env: 'PRODUCTION', category: 'Food' }));
    assert.deepStrictEqual(same.totals, sheet.totals);
});
