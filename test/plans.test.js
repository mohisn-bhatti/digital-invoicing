// The plans and prices on the website: one price list for FBR Digital Invoicing and PRA Point of Sale, 50% off annual prices,
// plans that build on each other, and no feature shown as a tick that is not built yet.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../public/plans');

const page = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('plans: the prices are the annual prices, half of the full prices', () => {
    assert.deepStrictEqual(P.PLANS.map(p => [p.id, p.full, p.price]), [['starter', 24000, 12000], ['pro', 60000, 30000], ['enterprise', 180000, 90000]]);
    for (const p of P.PLANS) assert.strictEqual(P.percentOff(p), 50, p.name);
    assert.deepStrictEqual(P.PLANS.map(p => P.rupees(p.price)), ['Rs. 12,000', 'Rs. 30,000', 'Rs. 90,000']);
    assert.strictEqual(P.PLANS.filter(p => p.popular).map(p => p.id).join(), 'pro', 'Pro is the popular one');
});

test('plans: FBR and PRA cost the same: there is one price list and nothing in it depends on the product', () => {
    assert.deepStrictEqual(P.PRODUCTS.map(p => p.id), ['fbr', 'pra']);
    for (const p of P.PLANS) assert.ok(!Object.keys(p).some(k => /^(fbr|pra)/i.test(k)), `${p.name} has a per-product field`);
    // the page builds both products' cards from this one list
    const html = page('index.html');
    assert.ok(/Plans\.PLANS\.map/.test(html) && !/fbrPrice|praPrice/.test(html));
});

test('plans: the limits of each plan', () => {
    assert.deepStrictEqual(P.limitTexts(P.plan('starter')), ['1 branch', '2 terminals', '1,000 products', '3 users']);
    assert.deepStrictEqual(P.limitTexts(P.plan('pro')), ['5 branches', '10 terminals', '10,000 products', '15 users']);
    assert.deepStrictEqual(P.limitTexts(P.plan('enterprise')), ['Unlimited branches', 'Unlimited terminals', 'Unlimited products', 'Unlimited users']);
});

test('plans: each plan includes everything the cheaper one does', () => {
    for (const f of P.FEATURES) {
        assert.strictEqual(f.in.length, 3, JSON.stringify(f.label));
        assert.ok(f.in[0] <= f.in[1] && f.in[1] <= f.in[2], `${JSON.stringify(f.label)} is in a cheaper plan but not a dearer one`);
        for (const prod of ['fbr', 'pra']) assert.ok(['live', 'soon', 'na'].includes(f.status[prod]), `${JSON.stringify(f.label)} has no status for ${prod}`);
    }
});

test('plans: the features shown for each product, in groups, with the right wording', () => {
    const fbr = P.featuresFor('fbr'), pra = P.featuresFor('pra');
    const labels = rows => rows.map(r => r.label);
    assert.ok(labels(fbr).includes('Real FBR invoice number on every sale') && !labels(fbr).some(l => /PRA/.test(l)));
    assert.ok(labels(pra).includes('Real PRA invoice number on every sale') && !labels(pra).some(l => /FBR/.test(l)));
    assert.ok(!labels(fbr).includes('All payment methods') && labels(pra).includes('All payment methods'), 'payment methods only apply to a point of sale');
    assert.ok(labels(fbr).includes('SDC/IMS setup for Tier-1 retailers') && !labels(pra).includes('SDC/IMS setup for Tier-1 retailers'));
    assert.ok(labels(fbr).includes('Debit notes & cancellations') && labels(pra).includes('Returns & credit notes'));
    // what every plan has comes first, then what the higher plans add
    for (const rows of [fbr, pra]) {
        const firstHigher = rows.findIndex(r => !r.in.every(Boolean));
        assert.ok(firstHigher > 0 && rows.slice(0, firstHigher).every(r => r.in.every(Boolean)) && rows.slice(firstHigher).every(r => !r.in.every(Boolean)));
    }
    assert.deepStrictEqual(P.featuresFor('nothing'), [], 'an unknown product has no rows');
});

test('plans: what is not built yet says "Soon" instead of showing a tick', () => {
    const soon = prod => P.featuresFor(prod).filter(r => r.soon).map(r => r.label).sort();
    // promised in the plans, not built: these must never be shown as available
    for (const prod of ['fbr', 'pra']) for (const label of ['Offline-first POS terminal', 'Multi-branch & warehouse stock', 'Scheduled reports', 'Stock transfers & audits']) assert.ok(soon(prod).includes(label), `${prod}: ${label}`);
    // the Point of Sale has no stock, no import and no Excel upload yet
    for (const label of ['Inventory & stock tracking', 'CSV product import', 'Excel bulk upload']) { assert.ok(soon('pra').includes(label), label); assert.ok(!soon('fbr').includes(label), label); }
});

test('plans: the text on the pages agrees with the prices', () => {
    const index = page('index.html'), contact = page('contact.html');
    for (const p of P.PLANS) {
        for (const text of [P.rupees(p.price), P.rupees(p.full)]) assert.ok(index.includes(text), `index.html does not say ${text}`);
        assert.ok(contact.includes(`${p.name} · ${P.rupees(p.price)} a year`), `contact.html does not offer ${p.name} at ${P.rupees(p.price)}`);
    }
    assert.ok(/<script src="\/plans\.js"><\/script>/.test(index) && /<script src="\/plans\.js"><\/script>/.test(contact));
    assert.match(index, /Rs\. 12,000 a year, Pro Rs\. 30,000 a year, Enterprise Rs\. 90,000 a year/, 'the no-script fallback');
});
