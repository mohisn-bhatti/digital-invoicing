// The owner's settings: how a new sale starts, what the receipt looks like, and what a new item starts with. Against the local
// database, with a stand-in for PRA.
const test = require('node:test');
const assert = require('node:assert');
const Rates = require('../public/pos-rates');
const { createWorld } = require('../test-helpers/posWorld');

const W = createWorld('settings');
const run = W.run;

test('settings: set up a business', async t => { await W.setup(t); });
test.after(() => W.teardown());

const FRESH = { defaultPaymentMode: 1, receiptHeader: '', receiptWidth: 80, showCashier: true, itemPct: '', itemTaxRate: null, itemTaxRateCard: null, itemCategory: '' };

run('settings: a business that never chose gets plain defaults (cash, 80 mm, cashier shown, nothing for new items)', async () => {
    assert.deepStrictEqual(await W.svc.getSettings(W.tenantId), FRESH, 'a business whose details were saved but whose settings were not');
    assert.deepStrictEqual(await W.svc.getSettings(W.otherTenantId), FRESH, 'a business with no profile row at all');
});

run('settings: saved, read back, and one thing can change without the rest', async () => {
    const a = await W.svc.saveSettings(W.ctx, { defaultPaymentMode: 2, receiptHeader: '  Fine   dining since 1998 ', receiptWidth: 58, showCashier: false, itemPct: '9801.2000', itemTaxRate: '16', itemTaxRateCard: 8, itemCategory: ' Food ' });
    assert.deepStrictEqual(a, { defaultPaymentMode: 2, receiptHeader: 'Fine dining since 1998', receiptWidth: 58, showCashier: false, itemPct: '98012000', itemTaxRate: 16, itemTaxRateCard: 8, itemCategory: 'Food' });
    assert.deepStrictEqual(await W.svc.getSettings(W.tenantId), a, 'what is read is what was saved');
    // only the paper changes: everything else stays
    const b = await W.svc.saveSettings(W.ctx, { receiptWidth: '80' });
    assert.deepStrictEqual(b, { ...a, receiptWidth: 80 });
    // an empty box means "nothing": a rate, a heading, a category cleared on purpose
    const c = await W.svc.saveSettings(W.ctx, { itemPct: '', itemTaxRateCard: '', itemTaxRate: null, itemCategory: '' });
    assert.deepStrictEqual(c, { ...b, itemPct: '', itemTaxRate: null, itemTaxRateCard: null, itemCategory: '' });
    // nothing sent changes nothing
    assert.deepStrictEqual(await W.svc.saveSettings(W.ctx, {}), c);
    assert.deepStrictEqual(await W.svc.saveSettings(W.ctx, null), c);
});

run('settings: they are kept apart from the business details, which neither lose nor gain from them', async () => {
    await W.svc.saveSettings(W.ctx, { receiptHeader: 'Open every day', defaultPaymentMode: 1 });
    const details = await W.svc.getProfile(W.tenantId);
    assert.deepStrictEqual([details.businessName, details.pntn, details.address, details.phone, details.receiptFooter], ['Test Restaurant', '1234567-8', 'MM Alam Road, Lahore', '042111', 'Thank you']);
    await W.svc.saveProfile(W.ctx, { businessName: 'Renamed Restaurant', pntn: '1234567-8', address: 'Gulberg, Lahore', phone: '', receiptFooter: '' });
    assert.strictEqual((await W.svc.getSettings(W.tenantId)).receiptHeader, 'Open every day', 'saving the details does not touch the settings');
    // a business with no profile row: the settings make the row, and the name still falls back to the company name
    await W.svc.saveSettings(W.ctxOther, { receiptWidth: 58 });
    assert.strictEqual((await W.svc.getSettings(W.otherTenantId)).receiptWidth, 58);
    const other = await W.svc.getProfile(W.otherTenantId);
    assert.match(other.businessName, /^TEST settings other /);
    assert.strictEqual(other.complete, false);
});

run('settings: what is refused (and a refusal saves nothing, not even the good fields beside it)', async () => {
    const before = await W.svc.getSettings(W.tenantId);
    const bad = async (body, re) => { await W.rejects(W.svc.saveSettings(W.ctx, { receiptHeader: 'must not be saved', ...body }), 400, re); };
    for (const v of [0, 7, 10, -1, 1.5, 'cash', true, [1], {}, null, '']) await bad({ defaultPaymentMode: v }, /how a new sale starts/);
    for (const v of [70, 59, 0, '80mm', '', 58.5, true, [80], null]) await bad({ receiptWidth: v }, /58 mm or 80 mm/);
    await bad({ receiptHeader: 'x'.repeat(121) }, /Receipt header is too long/);
    for (const v of ['maybe', 1, 0, '', null, [true]]) await bad({ showCashier: v }, /must be yes or no/);
    for (const v of ['123', '9801', 'abc', '9801.20000', '98012']) await bad({ itemPct: v }, /8 digits/);
    for (const v of [101, -1, 'abc', '1.234', '5%', '1e1']) await bad({ itemTaxRate: v }, /sales tax for new items/);
    for (const v of [101, -1, 'abc', '1.234']) await bad({ itemTaxRateCard: v }, /card payments for new items/);
    await bad({ itemCategory: 'c'.repeat(61) }, /Category is too long/);
    assert.deepStrictEqual(await W.svc.getSettings(W.tenantId), before, 'nothing changed');
    // what is allowed at the edges
    const edge = await W.svc.saveSettings(W.ctx, { defaultPaymentMode: '6', receiptHeader: 'h'.repeat(120), itemTaxRate: 0, itemTaxRateCard: '100', itemCategory: 'c'.repeat(60), itemPct: '9810.0000' });
    assert.deepStrictEqual([edge.defaultPaymentMode, edge.receiptHeader.length, edge.itemTaxRate, edge.itemTaxRateCard, edge.itemCategory.length, edge.itemPct], [6, 120, 0, 100, 60, '98100000']);
});

run('settings: control characters are dropped from the text boxes; markup is kept as typed (the screens escape it)', async () => {
    const s = await W.svc.saveSettings(W.ctx, { receiptHeader: 'Line one\u0000\u0007\nLine two', itemCategory: 'Food\u0001' });
    assert.strictEqual(s.receiptHeader, 'Line one Line two');
    assert.strictEqual(s.itemCategory, 'Food');
    const t = await W.svc.saveSettings(W.ctx, { receiptHeader: '<b>Bold</b> & "quoted"' });
    assert.strictEqual(t.receiptHeader, '<b>Bold</b> & "quoted"', 'kept as typed: the screens escape it when they show it');
});

run('settings: the cashier screen is told how a sale starts, and the receipt carries the paper choices', async () => {
    await W.svc.saveSettings(W.ctx, { defaultPaymentMode: 2, receiptHeader: 'Fine dining', receiptWidth: 58, showCashier: true });
    const setup = await W.svc.cashierSetup(W.ctx);
    assert.strictEqual(setup.settings.defaultPaymentMode, 2);
    assert.ok(setup.paymentModes.some(m => m.id === setup.settings.defaultPaymentMode), 'one of the ways the screen offers');
    const sale = (await W.sellOne({ paymentMode: 2 })).sale;
    const shown = await W.svc.receipt(W.ctx, sale.id);
    assert.deepStrictEqual(shown.look, { header: 'Fine dining', width: 58, showCashier: true });
    assert.strictEqual(shown.sale.cashier, 'cashier', 'the part of the email before the @');
    await W.svc.saveSettings(W.ctx, { showCashier: false, receiptWidth: 80 });
    const hidden = await W.svc.receipt(W.ctx, sale.id);
    assert.deepStrictEqual(hidden.look, { header: 'Fine dining', width: 80, showCashier: false });
    assert.strictEqual(hidden.sale.cashier, '', 'not on the paper, so not in what the paper is made from');
    // the sale itself is the same either way: the settings change how it looks, never what was sold
    const detail = await W.svc.saleDetail(W.ctx, sale.id);
    assert.strictEqual(detail.createdBy, 'cashier@test');
    assert.strictEqual(hidden.sale.totals.bill, shown.sale.totals.bill);
});

run('settings: one business never sees or changes another\'s', async () => {
    await W.svc.saveSettings(W.ctx, { defaultPaymentMode: 4, receiptHeader: 'Mine' });
    await W.svc.saveSettings(W.ctxOther, { defaultPaymentMode: 3, receiptHeader: 'Theirs' });
    assert.deepStrictEqual([(await W.svc.getSettings(W.tenantId)).receiptHeader, (await W.svc.getSettings(W.otherTenantId)).receiptHeader], ['Mine', 'Theirs']);
    assert.strictEqual((await W.svc.cashierSetup(W.ctxOther)).settings.defaultPaymentMode, 3);
});

run('settings: the activity trail says what changed, and a save that changes nothing leaves no entry', async () => {
    await W.svc.saveSettings(W.ctx, { receiptWidth: 80, itemTaxRate: 5 });
    const mark = W.audits.length;
    await W.svc.saveSettings(W.ctx, { receiptWidth: 58, itemTaxRate: 5 });
    const entries = W.audits.slice(mark);
    assert.deepStrictEqual(entries, ['pos.settings.update: Point of Sale settings changed: receiptWidth: 80 → 58']);
    await W.svc.saveSettings(W.ctx, { receiptWidth: 58, itemTaxRate: '5' });
    assert.strictEqual(W.audits.length, mark + 1, 'the same values again: nothing to record');
    await W.svc.saveSettings(W.ctx, { itemTaxRate: '' });
    assert.match(W.audits[W.audits.length - 1], /itemTaxRate: 5 → none/);
});

run('settings: the suggested rates point at real service headings in the PCT table', async () => {
    assert.ok(Rates.PRESETS.length >= 5);
    assert.strictEqual(new Set(Rates.PRESETS.map(p => p.id)).size, Rates.PRESETS.length, 'each suggestion has its own name');
    const words = { restaurant: /restaurant/i, hotel: /hotel/i, hall: /marriage|lawn|banquet/i, caterer: /cater/i, beauty: /beauty/i };
    for (const p of Rates.PRESETS) {
        const row = await W.prisma.hsCode.findFirst({ where: { code: p.pct } });
        assert.ok(row, `${p.pct} (${p.label}) is in the table`);
        assert.match(row.description, words[p.id], `${p.pct} is the heading for ${p.label}: "${row.description}"`);
        assert.ok(p.rate >= 0 && p.rate <= 100 && (p.card === null || (p.card >= 0 && p.card <= p.rate)), `${p.label}: sensible rates`);
        // what a suggestion fills in is accepted as it is (the item form sends these three boxes)
        const item = await W.svc.createItem(W.ctx, { name: `Suggested ${p.id}`, pctCode: p.pct, taxRate: p.rate, taxRateCard: p.card === null ? '' : p.card, unitPrice: 10 });
        assert.strictEqual(item.pctCode, p.pct.replace('.', ''));
    }
    assert.strictEqual(Rates.find('hall').pct, '9801.3000');
    assert.strictEqual(Rates.find('nope'), null);
    assert.strictEqual(Rates.describe(Rates.find('restaurant')), '9801.2000 · 16% (8% on card)');
    assert.strictEqual(Rates.describe(Rates.find('beauty')), '9810.0000 · 5%');
});
