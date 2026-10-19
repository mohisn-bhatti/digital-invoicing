// Matching words and codes exactly: "_" and "%" are ordinary characters (Prisma's case-insensitive comparison is ILIKE, where they are
// wildcards), capitals do not matter, and a scan or a search never names something it only looks like.
const test = require('node:test');
const assert = require('node:assert');
const { escapeLike, ciEquals, ciContains } = require('../src/pos/like');
const { createWorld } = require('../test-helpers/posWorld');

const W = createWorld('matching');
const run = W.run;
test('matching: set up a business', async t => { await W.setup(t); });
test.after(() => W.teardown());

const item = (body, ctx = W.ctx) => W.svc.createItem(ctx, { pctCode: '9801.2000', taxRate: 16, unitPrice: 10, ...body });

test('matching: the three characters that mean something to ILIKE get a backslash, nothing else changes', () => {
    assert.strictEqual(escapeLike('A_B%C\\D'), 'A\\_B\\%C\\\\D');
    assert.strictEqual(escapeLike('plain-CODE.1/2'), 'plain-CODE.1/2');
    assert.strictEqual(escapeLike(undefined), '');
    assert.deepStrictEqual(ciEquals('a_b'), { equals: 'a\\_b', mode: 'insensitive' });
    assert.deepStrictEqual(ciContains('50%'), { contains: '50\\%', mode: 'insensitive' });
});

run('matching: Prisma still takes the escaped value as it is (if it ever escapes by itself, this fails and the helper goes)', async () => {
    const made = await item({ name: 'Underscore', code: 'UND_ER' });
    await item({ name: 'Dash', code: 'UND-ER' });
    const exact = await W.prisma.posItem.findMany({ where: { tenantId: W.tenantId, code: ciEquals('und_er') } });
    assert.deepStrictEqual(exact.map(i => i.code), ['UND_ER'], 'the underscore is an underscore, and capitals do not matter');
    assert.strictEqual(made.code, 'UND_ER');
    const percent = await W.prisma.posItem.findMany({ where: { tenantId: W.tenantId, name: ciContains('%') } });
    assert.strictEqual(percent.length, 0, 'a percent sign is not "everything"');
});

run('matching: codes that differ by "_" or "-" are different items, and capitals still clash', async () => {
    await item({ name: 'Milk dash', code: 'MILK-1L', barcode: 'ABC-123' });
    const under = await item({ name: 'Milk underscore', code: 'MILK_1L', barcode: 'ABC_123' });
    assert.deepStrictEqual([under.code, under.barcode], ['MILK_1L', 'ABC_123'], 'made without a clash');
    await W.rejects(item({ name: 'Again', code: 'milk-1l' }), 409, /"milk-1l" is already the code or barcode of "Milk dash" \(MILK-1L\)/);
    assert.ok((await item({ name: 'Milk x', code: 'MILKX1L' })).id, 'a different letter in that place is a different code');
    await W.rejects(item({ name: 'Barcode again', barcode: 'abc_123' }), 409, /"abc_123" is already the code or barcode of "Milk underscore"/);
    await W.rejects(item({ name: 'Barcode as code', barcode: 'MILK_1L' }), 409, /"MILK_1L" is already the code or barcode of "Milk underscore"/);
    // the message always names what clashed (it used to say "undefined" when the database and the check disagreed)
    for (const body of [{ code: 'Milk-1L' }, { barcode: 'abc-123' }]) await W.rejects(item({ name: 'x', ...body }), 409, /^"(Milk-1L|abc-123)" is already/);
});

run('matching: an item can be changed, switched off and back on though another differs only by "_" or by capitals', async () => {
    // pairs that phase 1 allowed (only an exact repeat was refused): they are real rows and must stay editable
    const made = async (code, name) => W.prisma.posItem.create({ data: { tenantId: W.tenantId, code, name, pctCode: '98012000', taxRate: 16, unitPrice: 50 } });
    const a = await made('LEG-1', 'Legacy dash'), b = await made('LEG_1', 'Legacy underscore');
    const c = await made('Cola', 'Cola capital'), d = await made('COLA', 'Cola shouting');
    for (const row of [a, b, c, d]) {
        const edited = await W.svc.updateItem(W.ctx, row.id, { unitPrice: 77 });
        assert.strictEqual(edited.unitPrice, 77, `${row.code} can be edited`);
        assert.strictEqual((await W.svc.updateItem(W.ctx, row.id, { active: false })).active, false, `${row.code} can be switched off`);
        assert.strictEqual((await W.svc.updateItem(W.ctx, row.id, { active: true })).active, true, `${row.code} can be switched on`);
    }
    // but giving one of them a barcode that is already somebody's code is still refused
    await W.rejects(W.svc.updateItem(W.ctx, c.id, { barcode: 'LEG-1' }), 409, /"LEG-1" is already the code or barcode of "Legacy dash"/);
    assert.strictEqual((await W.svc.updateItem(W.ctx, c.id, { barcode: '5901234123457' })).barcode, '5901234123457', 'a free barcode is fine');
    // and a barcode already saved is not checked again when only the price changes
    assert.strictEqual((await W.svc.updateItem(W.ctx, c.id, { unitPrice: 78 })).unitPrice, 78);
});

run('matching: a scan of a code that two items answer to leads to neither (the barcode of each is the way out)', async () => {
    assert.strictEqual((await W.svc.lookup(W.ctx, 'cola')).item, null, 'Cola and COLA: no guessing');
    const found = await W.svc.lookup(W.ctx, '5901234123457');
    assert.strictEqual(found.item && found.item.name, 'Cola capital');
});

run('matching: a lookup of "%" or "_" finds nothing, and real numbers are still found', async () => {
    const sale = (await W.sellOne({ paymentMode: 1 })).sale;
    const real = await W.svc.lookup(W.ctx, sale.usin);
    assert.strictEqual(real.sale && real.sale.id, sale.id, 'the sale\'s own number');
    const full = await W.svc.saleDetail(W.ctx, sale.id);
    for (const code of [full.fiscalNumber, full.fiscalNumber.toLowerCase(), `https://reg.pra.punjab.gov.pk/IMSFiscalReport/SearchPOSInvoice_Report.aspx?PRAInvNo=${full.fiscalNumber}`]) assert.strictEqual((await W.svc.lookup(W.ctx, code)).sale.id, sale.id, code);
    const prefix = full.fiscalNumber.slice(0, 4);
    for (const code of ['%', '_', '%%', `${prefix}%`, `${prefix}_`, '____', `${full.fiscalNumber.slice(0, -1)}_`, '000_01', '0000%']) {
        const r = await W.svc.lookup(W.ctx, code);
        assert.deepStrictEqual([r.sale, r.item], [null, null], `"${code}" names nothing`);
    }
});

run('matching: a cashier\'s sheet holds only that cashier\'s sales, though another login differs by "_" or "."', async () => {
    const day = '2026-10-19';
    const ann = W.ctxFor(W.tenantId, 'ann_lee-x@test.pk'), other = W.ctxFor(W.tenantId, 'ann.lee-x@test.pk');
    await W.sellOne({}, ann);
    const theirs = (await W.sellOne({}, other)).sale; // the later sale
    const sheetOf = who => W.svc.reportClosing(W.ctx, { date: day, cashier: who });
    W.pra.mock = true; // (the figures cover the sandbox counter's sales while the server is in test mode)
    let a, b;
    try { a = await sheetOf('ann_lee-x@test.pk'); b = await sheetOf('ann.lee-x@test.pk'); } finally { W.pra.mock = false; }
    assert.strictEqual(a.totals.sales, 1);
    assert.strictEqual(b.totals.sales, 1);
    assert.notStrictEqual(a.lastSale.usin, theirs.usin, 'the last sale on her sheet is hers');
    assert.strictEqual(b.lastSale.usin, theirs.usin);
    assert.strictEqual(a.firstSale.usin, a.lastSale.usin);
    // the list, and a refused sale: nothing of the other login leaks into either
    assert.strictEqual((await W.svc.listSales(W.ctx, { cashier: 'ann_lee-x@test.pk', from: day, to: day })).total, 1);
    assert.strictEqual((await W.svc.listSales(W.ctx, { cashier: 'ANN_LEE-X@TEST.PK', from: day, to: day })).total, 1, 'capitals do not matter');
    assert.strictEqual((await W.svc.listSales(W.ctx, { cashier: 'ann_%@test.pk', from: day, to: day })).total, 0, 'a pattern is not a name');
});

run('matching: searches for "%" and "_" look for those characters, not for everything', async () => {
    const q = async v => ({
        items: (await W.svc.listItems(W.tenantId, { q: v })).length,
        customers: (await W.svc.listCustomers(W.ctx, { q: v })).total,
        sales: (await W.svc.listSales(W.ctx, { q: v })).total,
    });
    await W.svc.createCustomer(W.ctx, { name: 'Plain Name' });
    assert.deepStrictEqual(await q('%'), { items: 0, customers: 0, sales: 0 });
    const underscored = await q('_');
    assert.deepStrictEqual([underscored.customers, underscored.sales], [0, 0]);
    assert.ok(underscored.items >= 2, 'items whose code really has an underscore are found (MILK_1L, LEG_1, UND_ER ...)');
    assert.strictEqual((await W.svc.listItems(W.tenantId, { q: 'milk_1' })).length, 1, 'only the underscore one');
    assert.strictEqual((await W.svc.listCustomers(W.ctx, { q: 'plain' })).total, 1);
    assert.ok((await W.svc.searchPct('rest%')).length === 0, 'a heading search is not a pattern either');
});
