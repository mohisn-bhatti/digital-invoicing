// The plans and prices on the website: one price list for FBR Digital Invoicing and PRA Point of Sale, 50% off annual prices,
// and plans that build on each other.
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

test('plans: which number is held against what (the application reads it from here)', () => {
    const kinds = ['branches', 'terminals', 'products', 'items', 'users'];
    assert.deepStrictEqual(kinds.map(k => P.limitOf(P.plan('starter'), k)), [1, 2, 1000, 1000, 3]);
    assert.deepStrictEqual(kinds.map(k => P.limitOf(P.plan('pro'), k)), [5, 10, 10000, 10000, 15]);
    for (const none of [P.plan('enterprise'), P.plan('nonsense'), null, undefined]) assert.strictEqual(P.limitOf(none, 'users'), null, 'no plan, or Enterprise: no limit');
    // everything the application counts has a number to be held to
    for (const kind of Object.keys(require('../src/limits').KINDS)) assert.ok(kind in P.KIND_INDEX, kind);
    // and the numbers shown on the website are these same ones, in the same order
    for (const p of P.PLANS.filter(x => x.limits)) assert.deepStrictEqual(['branches', 'terminals', 'products', 'users'].map(k => P.limitOf(p, k)), p.limits);
});

test('plans: how a limit stands: no limit, room left, full, over', () => {
    assert.deepStrictEqual(P.standing(7, null), { state: 'none', pct: 0, caption: 'no limit' });
    assert.deepStrictEqual(P.standing(1, 3), { state: 'ok', pct: 33, caption: '2 left' });
    assert.deepStrictEqual(P.standing(0, 1000), { state: 'ok', pct: 0, caption: '1,000 left' });
    assert.deepStrictEqual(P.standing(999, 1000), { state: 'ok', pct: 100, caption: '1 left' }, 'rounded: but it is not "full" until it is');
    assert.deepStrictEqual(P.standing(3, 3), { state: 'full', pct: 100, caption: 'full' });
    assert.deepStrictEqual(P.standing(5, 3), { state: 'over', pct: 100, caption: 'over the limit by 2' });
    assert.deepStrictEqual(P.standing(12000, 10000), { state: 'over', pct: 100, caption: 'over the limit by 2,000' });
});

test('plans: what a plan allows, in words', () => {
    assert.strictEqual(P.limitsSentence(P.plan('starter')), 'up to 1 branch, 2 terminals, 1,000 products, 3 users');
    assert.strictEqual(P.limitsSentence(P.plan('pro')), 'up to 5 branches, 10 terminals, 10,000 products, 15 users');
    assert.strictEqual(P.limitsSentence(P.plan('enterprise')), 'unlimited branches, terminals, products and users', 'never "up to unlimited"');
});

test('plans: the note under the plan picker says what the plan means for this client, and warns about what is over', () => {
    const rows = [{ kind: 'users', noun: 'users', used: 5, limit: 3 }, { kind: 'products', noun: 'products', used: 1000, limit: 1000 }, { kind: 'branches', noun: 'branches', used: 1, limit: 1 }];
    assert.deepStrictEqual(P.planNote(null, rows), { warn: false, text: 'No plan: no limits. The client can add as much as it likes.' });
    assert.deepStrictEqual(P.planNote(P.plan('pro'), rows), { warn: false, text: 'Pro: up to 5 branches, 10 terminals, 10,000 products, 15 users.' }, 'room on Pro: nothing to warn about');
    const starter = P.planNote(P.plan('starter'), rows);
    assert.strictEqual(starter.warn, true);
    assert.strictEqual(starter.text, 'Starter: up to 1 branch, 2 terminals, 1,000 products, 3 users. This client already has more than that (5 users, limit 3). It keeps all of them, and can add nothing until it is back under.', 'full is not over: only the users are named');
    assert.deepStrictEqual(P.planNote(P.plan('enterprise'), rows), { warn: false, text: 'Enterprise: unlimited branches, terminals, products and users.' });
    assert.strictEqual(P.planNote(P.plan('starter'), undefined).warn, false, 'the usage has not arrived yet');
});

test('plans: the one-line hint on a page: what is used, and what to do when it is full or over', () => {
    const usage = (plan, rows) => ({ plan: plan ? { id: plan.toLowerCase(), name: plan } : null, rows: rows.map(([kind, noun, one, used, limit]) => ({ kind, noun, one, used, limit })) });
    const users = (used, limit = 3) => ['users', 'users', 'user', used, limit];
    // room left: quiet
    assert.deepStrictEqual(P.hint(usage('Starter', [users(2)]), ['users']), { tone: 'slate', lead: 'Starter plan:', text: '2 of 3 users used.' });
    // full: amber, and who to ask depends on who is reading
    assert.deepStrictEqual(P.hint(usage('Starter', [users(3)]), ['users']), { tone: 'amber', lead: 'Starter plan:', text: '3 of 3 users used. Ask ETAX to move you to a bigger plan to add more.' });
    assert.strictEqual(P.hint(usage('Starter', [users(3)]), ['users'], { admin: true }).text, '3 of 3 users used. Change the plan under Manage → Overview to add more.');
    // over: red, and it says nothing more can be added
    assert.deepStrictEqual(P.hint(usage('Starter', [users(5)]), ['users']), { tone: 'red', lead: 'Starter plan:', text: '5 of 3 users used. Over the limit: nothing more can be added until it is back under. Ask ETAX to move you to a bigger plan to add more.' });
    // several kinds in one line, a singular for a limit of one, thousands with a comma; the worst one sets the tone
    const pos = usage('Starter', [['branches', 'branches', 'branch', 1, 1], ['terminals', 'terminals (counters)', 'terminal (counter)', 2, 2], ['items', 'items', 'item', 3, 1000], users(1)]);
    assert.deepStrictEqual(P.hint(pos, ['branches', 'terminals']), { tone: 'amber', lead: 'Starter plan:', text: '1 of 1 branch, 2 of 2 terminals (counters) used. Ask ETAX to move you to a bigger plan to add more.' });
    assert.strictEqual(P.hint(pos, ['items']).text, '3 of 1,000 items used.');
    assert.strictEqual(P.hint(usage('Pro', [['products', 'products', 'product', 10000, 10000]]), ['products']).text, '10,000 of 10,000 products used. Ask ETAX to move you to a bigger plan to add more.');
    // nothing to say: no plan, no limit (Enterprise), or none of these kinds on the page
    assert.strictEqual(P.hint(usage(null, [users(2, null)]), ['users']), null, 'no plan');
    assert.strictEqual(P.hint(usage('Enterprise', [users(40, null)]), ['users']), null, 'Enterprise has no limit');
    assert.strictEqual(P.hint(usage('Starter', [users(2)]), ['items']), null, 'not a kind this page shows');
    assert.strictEqual(P.hint(null, ['users']), null);
    assert.strictEqual(P.hint({ plan: { id: 'starter', name: 'Starter' } }, ['users']), null, 'a reply without rows');
});

test('plans: every feature has a picture, and the page draws every picture it uses', () => {
    const html = page('index.html');
    const drawn = new Set([...html.slice(html.indexOf('const GLYPH = {'), html.indexOf('const icon = ')).matchAll(/^\s{4}(\w+): '</gm)].map(m => m[1]));
    assert.ok(drawn.size >= 20, `found ${drawn.size} drawings`);
    for (const f of P.FEATURES) assert.ok(f.icon && drawn.has(f.icon), `${JSON.stringify(f.label)} has no drawing (${f.icon})`);
    for (const prod of ['fbr', 'pra']) assert.ok(P.featuresFor(prod).every(r => r.icon), 'the rows carry their picture');
    const cards = ['building', 'terminal', 'box', 'user', 'infinity']; // branches, terminals, products, users, unlimited
    for (const name of cards) assert.ok(drawn.has(name), `the plan cards need "${name}"`);
    const used = new Set([...P.FEATURES.map(f => f.icon), ...cards]);
    for (const name of drawn) assert.ok(used.has(name), `"${name}" is drawn but nothing uses it`);
});

test('plans: each plan includes everything the cheaper one does', () => {
    for (const f of P.FEATURES) {
        assert.strictEqual(f.in.length, 3, JSON.stringify(f.label));
        assert.ok(f.in[0] <= f.in[1] && f.in[1] <= f.in[2], `${JSON.stringify(f.label)} is in a cheaper plan but not a dearer one`);
        for (const prod of ['fbr', 'pra']) assert.ok(['live', 'na'].includes(f.status[prod]), `${JSON.stringify(f.label)} has no status for ${prod}`);
    }
});

test('plans: the features shown for each product, in groups, with the right wording', () => {
    const fbr = P.featuresFor('fbr'), pra = P.featuresFor('pra');
    const labels = rows => rows.map(r => r.label);
    assert.ok(labels(fbr).includes('Real FBR invoice number on every sale') && !labels(fbr).some(l => /PRA/.test(l)));
    assert.ok(labels(pra).includes('Real PRA invoice number on every sale') && !labels(pra).some(l => /FBR/.test(l)));
    assert.ok(!labels(fbr).includes('All payment methods') && labels(pra).includes('All payment methods'), 'payment methods only apply to a point of sale');
    assert.ok(labels(fbr).includes('SDC/IMS setup for Tier-1 retailers') && !labels(pra).includes('SDC/IMS setup for Tier-1 retailers'));
    assert.ok(labels(fbr).includes('Returns, debit notes & cancellations') && labels(pra).includes('Returns & credit notes'));
    // what every plan has comes first, then what the higher plans add
    for (const rows of [fbr, pra]) {
        const firstHigher = rows.findIndex(r => !r.in.every(Boolean));
        assert.ok(firstHigher > 0 && rows.slice(0, firstHigher).every(r => r.in.every(Boolean)) && rows.slice(firstHigher).every(r => !r.in.every(Boolean)));
    }
    assert.deepStrictEqual(P.featuresFor('nothing'), [], 'an unknown product has no rows');
});

test('plans: everything a plan includes is shown with a tick, and nothing is marked "Soon"', () => {
    for (const prod of ['fbr', 'pra']) for (const r of P.featuresFor(prod)) assert.ok(!('soon' in r), r.label);
    const html = page('index.html');
    assert.ok(!/Soon<\/span>|text-amber-100|\bSOON\b/.test(html), 'the page has no "Soon" tag');
    // the pricing sheet has 20 rows; each product leaves out the one that does not apply to it (payment methods for FBR, SDC/IMS for PRA)
    assert.strictEqual(P.FEATURES.length, 20);
    assert.strictEqual(P.featuresFor('fbr').length, 19);
    assert.strictEqual(P.featuresFor('pra').length, 19);
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
