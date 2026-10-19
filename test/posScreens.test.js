// The cashier screens' own logic, run without a browser: the real public/pos.js and public/pos-calc.js are loaded into a sandbox with
// a stub page, and the few helpers they take from app.html (esc, money, canManage, pkDate, newRequestId) are cut out of app.html
// itself, so these tests cannot drift from it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const app = pub('app.html');
const cut = re => { const m = re.exec(app); assert.ok(m, `app.html no longer has ${re}`); return m[0]; };
const HELPERS = [
    /const esc = .*\n/, /const money = .*\n/, /const canManage = .*\n/, /const pkDate = .*\n/, /function newRequestId\(\) \{[\s\S]*?\n\}\n/,
].map(cut).join('\n');

function page(overrides = {}) {
    const registry = new Map(), made = [];
    const element = () => {
        const classes = new Set();
        const e = {
            innerHTML: '', textContent: '', value: '', checked: false, disabled: false, dataset: {}, style: {}, children: [],
            classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle(c, on) { (on === undefined ? !classes.has(c) : on) ? classes.add(c) : classes.delete(c); } },
            querySelectorAll: () => [], appendChild() {}, remove() {}, click() {}, scrollIntoView() {}, insertAdjacentHTML() {}, setAttribute() {},
        };
        made.push(e);
        return e;
    };
    const $ = sel => { if (!registry.has(sel)) registry.set(sel, element()); return registry.get(sel); };
    const log = { api: [], toasts: [], went: [], timers: [] };
    const answers = { '/api/pos/alerts': { awaiting: 0, rejected: 0, outcomeUnknown: 0 }, '/api/pos/sales': { total: 0, sales: [] }, ...overrides.answers };
    const box = {
        console, Date, Math, JSON, Map, Set, Number, String, Array, Object, Promise, Error, URLSearchParams, encodeURIComponent, setTimeout, clearTimeout,
        setInterval: (fn, ms) => { log.timers.push(ms); return log.timers.length; }, clearInterval: id => { log.timers.push('cleared'); },
        __api: async (url, opts) => { log.api.push(url); const key = Object.keys(answers).find(k => url.split('?')[0] === k); if (key) return typeof answers[key] === 'function' ? answers[key](url, opts) : answers[key]; throw new Error('no answer for ' + url); },
        __$: $, __toast: (m, ok) => log.toasts.push(m), __go: id => log.went.push(id),
        document: { body: element(), hidden: false, addEventListener() {}, querySelectorAll: sel => (overrides.all && overrides.all[sel]) || [], createElement: element, getElementById: () => null, head: element() },
        window: { print() { log.printed = (log.printed || 0) + 1; }, scrollTo() {} }, navigator: {}, localStorage: { getItem: () => null, setItem() {} }, confirm: () => true,
    };
    box.self = box; box.window.document = box.document;
    const ctx = vm.createContext(box);
    vm.runInContext(pub('pos-calc.js'), ctx, { filename: 'pos-calc.js' });
    vm.runInContext(pub('pos.js'), ctx, { filename: 'pos.js' });
    vm.runInContext(`
        const S = { token: 't', module: 'POS', tenantRole: 'OWNER' }, PAGE_ENTER = {};
        const $ = __$, api = __api, toast = __toast, go = __go, route = () => {}, renderNav = () => {}, syncModules = () => false, saveSession = () => {};
        ${HELPERS}`, ctx, { filename: 'helpers.js' });
    const run = code => vm.runInContext(code, ctx);
    return { run, $, log, body: box.document.body, doc: box.document, set hidden(v) { box.document.hidden = v; }, answers };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const decode = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, c) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[c]));
const SETUP = `POS.setup = { testMode: false, counters: [{ id: 'c1', name: 'Till 1', branch: 'Main', env: 'SANDBOX', hasToken: true, breaker: { open: false, fails: 0, retryInMs: 0 } }], paymentModes: PosCalc.PAYMENT_MODES, profileComplete: true,
    items: [{ id: 'i1', code: 'A', name: 'Tea', category: "Chef's Special", pctCode: '98012000', taxRate: 16, taxRateCard: null, unitPrice: 100, openPrice: false, active: true },
            { id: 'i2', code: 'B', name: 'Rice', category: "x');document.title='PWNED';//", pctCode: '98012000', taxRate: 16, taxRateCard: null, unitPrice: 200, openPrice: false, active: true },
            { id: 'i3', code: 'C', name: 'Lawn', category: 'C:\\\\temp\\\\', pctCode: '98013000', taxRate: 5, taxRateCard: null, unitPrice: 0, openPrice: true, active: true }] };
    POS.itemsById = new Map(POS.setup.items.map(i => [i.id, i])); POS.counterId = 'c1';`;

test('POS screen: a category name can never run as script (apostrophe, quote, backslash)', () => {
    const p = page();
    p.run(SETUP);
    p.run('posRenderCats()');
    const html = p.$('#pCats').innerHTML;
    assert.ok(!/onclick="posCategory\('/.test(html), 'the name is not put inside a script string');
    const chips = [...html.matchAll(/data-cat="([^"]*)" onclick="posCategory\(this\.dataset\.cat\)"/g)].map(m => decode(m[1]));
    assert.deepStrictEqual(chips, ['', 'C:\\temp\\', "Chef's Special", "x');document.title='PWNED';//"], 'every chip (All first, then sorted) carries its name exactly');
    assert.ok(!html.includes('<script') && !html.includes('"><'), 'nothing breaks out of the attribute');
    p.run('posCategory("Chef\'s Special")'); // what the click handler passes: the decoded name, used as it is
    assert.strictEqual(p.run('POS.cat'), "Chef's Special");
});

test('POS screen: "Show them" lists that status on every date; a first visit to the list is today', async () => {
    const p = page();
    p.run(SETUP);
    p.run("posShowState('OUTCOME_UNKNOWN')");
    assert.deepStrictEqual(p.log.went, ['p-sales']);
    await p.run('posEnterSales()');
    const listed = p.log.api.find(u => u.startsWith('/api/pos/sales'));
    assert.ok(/state=OUTCOME_UNKNOWN/.test(listed) && !/from=|to=/.test(listed), listed);
    assert.strictEqual(p.$('#psFrom').value, '', 'the date boxes are empty: all dates');
    // a fresh start opens on today
    const q = page();
    q.run(SETUP);
    await q.run('posEnterSales()');
    const today = q.run('pkDate()');
    const first = q.log.api.find(u => u.startsWith('/api/pos/sales'));
    assert.ok(first.includes('from=' + today) && first.includes('to=' + today), first);
});

test('POS screen: the totals are only fetched again when the dates change (not for a search or a status filter)', async () => {
    const p = page({ answers: { '/api/pos/report': { sales: { bill: 0, count: 0, tax: 0 }, returns: { bill: 0, count: 0 }, net: { bill: 0, saleValue: 0, tax: 0 }, byPayment: [], items: [], notFiscalized: { waiting: 0, refused: 0, unknown: 0, cancelled: 0 }, scope: 'LIVE', leftOut: 0 } } });
    p.run(SETUP);
    await p.run('posEnterSales()');
    const reports = () => p.log.api.filter(u => u.startsWith('/api/pos/report')).length;
    assert.strictEqual(reports(), 1);
    p.$('#psState').value = 'FISCALIZED';
    await p.run('posSalesFilter()');
    assert.strictEqual(reports(), 1, 'a status filter does not recompute the totals');
    p.$('#psFrom').value = '2026-10-01';
    await p.run('posSalesFilter()');
    assert.strictEqual(reports(), 2, 'a new date does');
    await p.run('posLoadSales()');
    assert.strictEqual(reports(), 3, 'so does Refresh');
});

test('POS screen: nothing of the last login stays for the next (cart, buyer, sale key, windows, timers)', () => {
    const p = page();
    p.run(SETUP);
    p.run("POS.cart = [{ itemId: 'i1', qty: '2', price: '', disc: '' }]; POS.buyer.name = 'Ali'; POS.buyer.cnic = '3520112345671'; POS.ref = 'abc'; POS.refSig = 'sig'; POS.lost = true; POS.result = { x: 1 }; POS.detail = { id: 1 }; POS.cat = 'Food'; POS.q = 'te'");
    p.$('#posModal'); p.$('#posReceiptModal');
    p.body.classList.add('print-pos');
    p.run('posReset()');
    assert.deepStrictEqual(JSON.parse(p.run('JSON.stringify([POS.cart, POS.buyer, POS.ref, POS.refSig, POS.lost, POS.result, POS.detail, POS.cat, POS.q, POS.setup, POS.counterId])')),
        [[], { name: '', pntn: '', cnic: '', phone: '' }, null, null, false, null, null, '', '', null, null]);
    assert.ok(p.$('#posModal').classList.contains('hidden') && p.$('#posReceiptModal').classList.contains('hidden'), 'windows are closed');
    assert.ok(!p.body.classList.contains('print-pos'), 'and printing no longer means this receipt');
    assert.ok(p.log.timers.includes('cleared'), 'the timers are stopped');
});

test('POS screen: clearing the sale starts a new one (a new sale key), also after a lost answer', () => {
    const p = page();
    p.run(SETUP);
    p.run("POS.ref = 'abc'; POS.refSig = 'sig'; POS.lost = true; POS.cart = [{ itemId: 'i1', qty: '1', price: '', disc: '' }]");
    p.run('posClear()');
    assert.deepStrictEqual(JSON.parse(p.run('JSON.stringify([POS.ref, POS.refSig, POS.lost, POS.cart.length])')), [null, null, false, 0]);
});

test('POS screen: the sale key is a real key the server accepts', () => {
    const p = page();
    for (let i = 0; i < 50; i++) assert.match(p.run('newRequestId()'), /^[A-Za-z0-9_-]{8,64}$/);
});

const receipt = (sale = {}) => `posReceiptHtml(${JSON.stringify({
    business: { name: 'Test Restaurant', pntn: '1234567-8', address: 'MM Alam Road', phone: '', footer: '' }, branch: null, counter: { name: 'Till 1', posId: '900001' },
    sale: { usin: '000001', fiscalNumber: 'X1', verifyUrl: 'https://example/x', invoiceType: 1, refUsin: null, paymentMode: 1, mock: false, env: 'PRODUCTION', at: '2026-10-19T08:00:00Z', cashier: 'ali',
        buyer: { name: '', pntn: '', cnic: '', phone: '' }, totals: { quantity: 3, saleValue: 300, discount: 0, tax: 48, bill: 348 },
        lines: [{ itemName: 'Tea', quantity: 3, unitPrice: 100, discount: 0, taxRate: 16, saleValue: 300, taxCharged: 48, totalAmount: 348 }], ...sale },
})})`;

test('POS screen: a receipt says when it is a test, in test mode and for a sandbox counter on a live server', () => {
    const p = page();
    assert.ok(!/NOT A (FISCAL|REAL)/.test(p.run(receipt())), 'a production receipt has no banner');
    assert.match(p.run(receipt({ mock: true, env: 'SANDBOX' })), /TEST MODE: NOT A FISCAL INVOICE/);
    const sandbox = p.run(receipt({ mock: false, env: 'SANDBOX' }));
    assert.match(sandbox, /PRA SANDBOX TEST: NOT A REAL INVOICE/);
    assert.ok(!/TEST MODE/.test(sandbox));
});

test('POS screen: the receipt wraps long text on 80 mm paper, and shows the total quantity', () => {
    const p = page();
    const html = p.run(receipt({ cashier: 'a-very-long-cashier-name-that-would-not-fit', buyer: { name: 'A buyer with a very long name that goes on', pntn: '', cnic: '', phone: '' } }));
    assert.ok(html.includes('flex-wrap:wrap') && html.includes('overflow-wrap:anywhere'), 'rows can wrap');
    assert.match(html, /Total quantity/);
});

test('POS screen: while a receipt is open, printing means that receipt (and only then)', async () => {
    const p = page({ answers: { '/api/pos/sales/s1/receipt': JSON.parse(JSON.stringify({ business: { name: 'T', pntn: '1', address: 'a', phone: '', footer: '' }, branch: null, counter: { name: 'Till 1', posId: '1' }, sale: { usin: '000001', fiscalNumber: 'X1', verifyUrl: 'u', invoiceType: 1, paymentMode: 1, mock: false, env: 'PRODUCTION', at: '2026-10-19T08:00:00Z', cashier: 'a', buyer: { name: '', pntn: '', cnic: '', phone: '' }, totals: { quantity: 1, saleValue: 1, discount: 0, tax: 0, bill: 1 }, lines: [] } })) } });
    p.run(SETUP);
    await p.run("posShowReceipt('s1')");
    assert.ok(p.body.classList.contains('print-pos'));
    p.run('posCloseReceipt()');
    assert.ok(!p.body.classList.contains('print-pos'));
});

test('POS screen: the alert strip asks the light endpoint, and not while the tab is hidden', async () => {
    const p = page();
    p.run(SETUP);
    p.hidden = true;
    await p.run('posPollAlerts()');
    assert.strictEqual(p.log.api.length, 0, 'nobody is looking: nothing is asked');
    p.hidden = false;
    await p.run('posPollAlerts()');
    assert.deepStrictEqual(p.log.api, ['/api/pos/alerts']);
});

test('POS screen: after a sale the counter state comes with the answer, so the catalogue is not downloaded again', () => {
    const p = page({ answers: { '/api/pos/setup': () => { throw new Error('the catalogue must not be reloaded'); } } });
    p.run(SETUP);
    p.run('POS.setupAt = Date.now()');
    p.run("posAfterSend({ outcome: 'NOT_SENT', breaker: { open: true, fails: 1, retryInMs: 15000 } })");
    assert.ok(p.run('posPauseLeft(posCounter())') > 14000, 'the pause is known');
    assert.ok(!p.log.api.includes('/api/pos/setup'));
    // an answer without it (or an old catalogue) reloads
    const q = page({ answers: { '/api/pos/setup': { testMode: false, counters: [], items: [], paymentModes: [], profileComplete: true } } });
    q.run(SETUP); q.run('POS.setupAt = 0');
    q.run("posAfterSend({ outcome: 'FISCALIZED' })");
    assert.ok(q.log.api.includes('/api/pos/setup'));
});

test('POS screen: "return everything" fills in what is left of every line', () => {
    const inputs = [{ dataset: { max: '2' }, value: '' }, { dataset: { max: '1.5' }, value: '' }];
    const p = page({ all: { '#posForm input[data-line]': inputs } });
    p.run('posReturnAll()');
    assert.deepStrictEqual(inputs.map(i => i.value), ['2', '1.5']);
});

test('POS screen: the whitelisting email is filled from the business and its production counters', () => {
    const p = page();
    p.run("POS.profile = { businessName: 'Test Restaurant', pntn: '1234567-8' }; POS.branches = [{ counters: [{ env: 'SANDBOX', posId: '111' }, { env: 'PRODUCTION', posId: '900001' }] }]; POS.ip = '203.0.113.9'");
    const mail = p.run('posWhitelistEmail()');
    for (const line of ['To: eims@pra.punjab.gov.pk', 'PNTN: 1234567-8', 'BUSINESS NAME: Test Restaurant', 'POS ID: 900001', 'SERVER IP: 203.0.113.9']) assert.ok(mail.includes(line), line);
    assert.ok(!mail.includes('111'), 'a sandbox POS ID is not given for whitelisting');
});

test('POS screen: a bill above Rs 50,000 asks for the buyer first, and Finalize waits for the details', () => {
    const p = page();
    p.run(SETUP);
    p.run("POS.cart = [{ itemId: 'i3', qty: '1', price: '60000', disc: '' }]; posRenderCart()");
    assert.strictEqual(p.$('#pGo').disabled, true);
    assert.match(p.$('#pGo').textContent, /Add the buyer details/);
    assert.strictEqual(p.$('#pBuyerBox').open, true, 'the buyer box opens by itself');
    assert.match(p.$('#pBuyerSum').textContent, /required/);
    p.run("posBuyer('name', 'Ali Khan')");
    assert.strictEqual(p.$('#pGo').disabled, true, 'a name alone is not enough');
    p.run("posBuyer('cnic', '35202-1234567-1')");
    assert.strictEqual(p.$('#pGo').disabled, false);
    assert.match(p.$('#pBuyerSum').textContent, /optional/);
    // a smaller bill never asks
    p.run("POS.cart = [{ itemId: 'i3', qty: '1', price: '49999', disc: '' }]; POS.buyer = posBlankBuyer(); posRenderCart()");
    assert.strictEqual(p.$('#pGo').disabled, false);
});
