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
].map(cut).join('\n').replace('const pkDate', 'let pkDate'); // (let: a test can say what day it is)

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
    const log = { api: [], toasts: [], went: [], timers: [], listeners: {} };
    // a clock the test moves by hand (only where it asks for one): new Date() and Date.now() follow it
    const clock = overrides.clock, TheDate = clock ? class extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.now); } static now() { return clock.now; } } : Date;
    const answers = { '/api/pos/alerts': { awaiting: 0, rejected: 0, outcomeUnknown: 0 }, '/api/pos/sales': { total: 0, sales: [] }, ...overrides.answers };
    const box = {
        console, Date: TheDate, Math, JSON, Map, Set, Number, String, Array, Object, Promise, Error, URLSearchParams, encodeURIComponent, setTimeout, clearTimeout,
        setInterval: (fn, ms) => { log.timers.push(ms); return log.timers.length; }, clearInterval: id => { log.timers.push('cleared'); },
        __api: async (url, opts) => { log.api.push(url); const key = Object.keys(answers).find(k => url.split('?')[0] === k); if (key) return typeof answers[key] === 'function' ? answers[key](url, opts) : answers[key]; throw new Error('no answer for ' + url); },
        __$: $, __toast: (m, ok) => log.toasts.push(m), __go: id => log.went.push(id),
        document: { body: element(), hidden: false, addEventListener(type, fn) { (log.listeners[type] = log.listeners[type] || []).push(fn); }, querySelectorAll: sel => (overrides.all && overrides.all[sel]) || [], createElement: element, getElementById: id => $('#' + id), head: element() },
        window: { print() { log.printed = (log.printed || 0) + 1; }, scrollTo() {}, addEventListener() {}, removeEventListener() {} }, navigator: {}, localStorage: { getItem: () => null, setItem() {} }, confirm: () => true,
    };
    box.self = box; box.window.document = box.document;
    const ctx = vm.createContext(box);
    // the same scripts, in the same order, as app.html loads them
    for (const f of ['pos-calc.js', 'pos-scan.js', 'pos-rates.js', 'pos-drill.js', 'pos.js', 'pos-camera.js', 'pos-customers.js', 'pos-reports.js']) vm.runInContext(pub(f), ctx, { filename: f });
    vm.runInContext(`
        const S = { token: 't', module: 'POS', tenantRole: 'OWNER' }, PAGE_ENTER = {};
        const showPlanHint = () => {}; // (the plan-limit hint under a list: not what these tests are about)
        const $ = __$, api = __api, toast = __toast, go = __go, route = () => {}, renderNav = () => {}, syncModules = () => false, saveSession = () => {};
        ${HELPERS}`, ctx, { filename: 'helpers.js' });
    const run = code => vm.runInContext(code, ctx);
    return { run, $, log, body: box.document.body, doc: box.document, fire: (type, ev) => (log.listeners[type] || []).forEach(f => f(ev)), set hidden(v) { box.document.hidden = v; }, answers };
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
    const reports = () => p.log.api.filter(u => u.startsWith('/api/pos/report?')).length;
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

// ---------- scanning, customers and labels ----------
const SCAN_SETUP = `${SETUP}
    POS.setup.items[0].barcode = '8964000123456'; POS.setup.items[0].taxRateCard = 8; POS.setup.items[1].barcode = null; POS.setup.items[2].barcode = null;
    POS.setup.items[1].taxRateCard = null; POS.itemsById = new Map(POS.setup.items.map(i => [i.id, i]));`;
const recorder = answers => { const bodies = []; return { bodies, answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, (url, opts) => { if (opts && opts.body) bodies.push([url, opts.body]); return typeof v === 'function' ? v(url, opts) : v; }])) }; };

test('POS screen: a scanned item goes into the sale, and the screen says what it is set to', async () => {
    const p = page();
    p.run(SCAN_SETUP);
    const r1 = await p.run("posScanSale('8964000123456')");
    assert.strictEqual(r1.ok, true);
    assert.match(r1.message, /^Tea: 100\.00 · tax 16% \(8% when paid by card\) · 1 in this sale$/);
    assert.deepStrictEqual(JSON.parse(p.run('JSON.stringify(POS.cart.map(c => [c.itemId, c.qty]))')), [['i1', '1']]);
    assert.match(decode(p.$('#pScanNote').innerHTML), /<b>Tea<\/b> added · 100\.00 · tax 16% \(8% by card\)/);
    const r2 = await p.run("posScanSale('  a\\n')"); // the code of the same item, as a scanner writes it
    assert.match(r2.message, /· 2 in this sale$/);
    assert.deepStrictEqual(JSON.parse(p.run('JSON.stringify(POS.cart.map(c => [c.itemId, c.qty]))')), [['i1', '2']]);
    assert.deepStrictEqual(p.log.api.filter(u => u.startsWith('/api/pos/lookup')), [], 'an item the screen has is never looked up');
    // an item with no fixed price says so
    const r3 = await p.run("posScanSale('C')");
    assert.match(r3.message, /^Lawn: enter the price · tax 5%/);
    assert.match(decode(p.$('#pScanNote').innerHTML), /type the price in the sale/);
});

test('POS screen: a code the screen does not know is looked up: a receipt, an item added a moment ago, or nothing', async () => {
    // nothing
    let p = page({ answers: { '/api/pos/lookup': { code: 'ZZZ', item: null, sale: null } } });
    p.run(SCAN_SETUP);
    let r = await p.run("posScanSale('ZZZ')");
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /Nothing matches "ZZZ"/);
    assert.ok(p.log.api.includes('/api/pos/lookup?code=ZZZ'));
    assert.match(decode(p.$('#pScanNote').innerHTML), /Nothing matches <b>ZZZ<\/b>.*Add it under Items/);
    // a receipt: the sale is named, with a way to open it
    p = page({ answers: { '/api/pos/lookup': { code: 'x', item: null, sale: { id: 's7', usin: '000007', state: 'FISCALIZED', totalBill: 3480 } } } });
    p.run(SCAN_SETUP);
    r = await p.run("posScanSale('https://reg.pra.punjab.gov.pk/IMSFiscalReport/SearchPOSInvoice_Report.aspx?PRAInvNo=ABC1')");
    assert.strictEqual(r.ok, true);
    assert.match(r.message, /That is a receipt: sale 000007/);
    const note = decode(p.$('#pScanNote').innerHTML);
    assert.match(note, /sale 000007<\/b> \(Fiscalized, 3,480\.00\)/);
    assert.ok(note.includes("posOpenSale('s7')"), 'with a button to open it');
    assert.strictEqual(p.run('POS.cart.length'), 0, 'a receipt is never put in the cart');
    // an item the server has but this screen's list does not: the list is fetched again and the item added
    const fresh = { id: 'i9', code: 'NEW1', barcode: null, name: 'New dish', category: '', pctCode: '98012000', taxRate: 16, taxRateCard: null, unitPrice: 300, openPrice: false, active: true };
    p = page({ answers: { '/api/pos/lookup': { code: 'NEW1', item: fresh, sale: null }, '/api/pos/setup': () => ({ testMode: false, counters: [], items: [fresh], paymentModes: [], profileComplete: true }) } });
    p.run(SCAN_SETUP);
    r = await p.run("posScanSale('NEW1')");
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(JSON.parse(p.run('JSON.stringify(POS.cart.map(c => c.itemId))')), ['i9']);
    // an item that has been switched off is not added
    p = page({ answers: { '/api/pos/lookup': { code: 'OFF', item: { ...fresh, active: false }, sale: null } } });
    p.run(SCAN_SETUP);
    r = await p.run("posScanSale('OFF')");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(p.run('POS.cart.length'), 0);
    // the server cannot be reached: the screen says so, and does not guess
    p = page({ answers: { '/api/pos/lookup': () => { throw new Error('Failed to fetch'); } } });
    p.run(SCAN_SETUP);
    r = await p.run("posScanSale('ZZZ')");
    assert.deepStrictEqual([r.ok, r.message], [false, 'Failed to fetch']);
});

test('POS screen: nothing is scanned while a sale is being sent, or when nothing was read', async () => {
    const p = page();
    p.run(SCAN_SETUP);
    p.run('POS.busy = true');
    assert.match((await p.run("posScanSale('A')")).message, /being sent/);
    p.run('POS.busy = false');
    assert.strictEqual((await p.run("posScanSale('   ')")).ok, false);
    assert.strictEqual((await p.run('posScanSale(undefined)')).ok, false);
    assert.strictEqual(p.run('POS.cart.length'), 0);
    assert.deepStrictEqual(p.log.api.filter(u => u.startsWith('/api/pos/lookup')), []);
});

test('POS screen: Enter in the search box takes a barcode or code exactly; a receipt address is a receipt; a word still searches', async () => {
    const p = page({ answers: { '/api/pos/lookup': { code: 'x', item: null, sale: { id: 's7', usin: '000007', state: 'FISCALIZED', totalBill: 10 } } } });
    p.run(SCAN_SETUP);
    const press = (text) => { const e = { key: 'Enter', preventDefault() {}, target: { value: text } }; p.run('0'); return p.run(`posSearchKey(${JSON.stringify({ key: 'Enter', target: { value: text } })}.key ? { key: 'Enter', preventDefault() {}, target: { value: ${JSON.stringify(text)} } } : 0)`) ; };
    press('8964000123456'); await sleep(30);
    assert.deepStrictEqual(JSON.parse(p.run('JSON.stringify(POS.cart.map(c => [c.itemId, c.qty]))')), [['i1', '1']], 'by barcode');
    press('a'); await sleep(30);
    assert.strictEqual(p.run('POS.cart[0].qty'), '2', 'by code, capitals ignored');
    press('ric'); await sleep(30); // "Rice" is the only item with this in its name
    assert.deepStrictEqual(JSON.parse(p.run('JSON.stringify(POS.cart.map(c => c.itemId))')), ['i1', 'i2'], 'the only match goes in');
    press('https://reg.pra.punjab.gov.pk/IMSFiscalReport/SearchPOSInvoice_Report.aspx?PRAInvNo=ABC1'); await sleep(30);
    assert.ok(p.log.api.some(u => u.startsWith('/api/pos/lookup?code=https')), 'a receipt address is looked up');
    assert.strictEqual(p.run('POS.cart.length'), 2, 'and is never an item');
    press('zzzz'); await sleep(30);
    assert.ok(p.log.toasts.includes('No item matches.'));
});

test('POS screen: why the camera would not start', () => {
    const p = page();
    p.run('window.isSecureContext = true');
    const say = (name, message) => p.run(`posCameraError(${JSON.stringify({ name, message })})`);
    assert.match(say('NotAllowedError'), /blocked.*Allow the camera for this site/);
    assert.match(say('PermissionDeniedError'), /blocked/);
    assert.match(say('SecurityError'), /blocked/);
    assert.match(say('NotFoundError'), /No camera was found/);
    assert.match(say('OverconstrainedError'), /No camera was found/);
    assert.match(say('NotReadableError'), /used by another app/);
    assert.match(say('SomethingElse', 'boom'), /could not be started \(boom\)/);
    assert.match(p.run('posCameraError(null)'), /could not be started\.$/);
    p.run('window.isSecureContext = false');
    assert.match(say('NotAllowedError'), /secure \(https\) connection/, 'an address that is not https is the first thing to say');
});

test('POS screen: a label carries the QR, the name, the price and the code, and a name cannot break out of it', () => {
    const p = page();
    p.run(SCAN_SETUP);
    const label = (item, opts) => decode(p.run(`posLabelHtml(${JSON.stringify(item)}, ${JSON.stringify(opts)})`));
    const tea = { name: 'Packed <b>tea</b> & "co"', code: 'ITM0002', barcode: '8964000123456', unitPrice: 90, openPrice: false };
    const html = p.run(`posLabelHtml(${JSON.stringify(tea)}, { price: true, roll: false })`);
    assert.ok(html.includes('data-code="8964000123456"'), 'the QR holds the barcode when there is one');
    assert.ok(!html.includes('<b>tea</b>') && html.includes('&lt;b&gt;tea&lt;/b&gt;'), 'a name is text, never markup');
    assert.ok(label(tea, { price: true, roll: false }).includes('90.00'));
    assert.ok(!label(tea, { price: false, roll: false }).includes('90.00'), 'no price when it is not wanted');
    assert.ok(label({ ...tea, barcode: null }, { price: true }).includes('data-code="ITM0002"'), 'the code when there is no barcode');
    assert.ok(label({ ...tea, openPrice: true }, { price: true }).includes('price on sale'));
    assert.ok(label(tea, { roll: true }).includes('width:50mm;height:30mm'), 'a roll label is its own page');
    assert.ok(label(tea, { roll: false }).includes('width:62mm;height:36mm'));
    // printing: a sheet of 21 to a page, one label for each item and copy, and the page size set for the printer
    p.run("POS.items = [{ id: 'i1', name: 'Tea', code: 'A', barcode: '8964000123456', unitPrice: 100, openPrice: false, active: true }, { id: 'i2', name: 'Off', code: 'B', barcode: null, unitPrice: 5, openPrice: false, active: false }, { id: 'i3', name: 'Rice', code: 'C', barcode: null, unitPrice: 200, openPrice: false, active: true }]");
    p.run("document.getElementById('lbSize').value = 'sheet'; document.getElementById('lbPrice').checked = true; document.getElementById('lbCopies').value = '3'; posLabelsPrint()");
    const area = p.$('#posPrintArea').innerHTML;
    assert.strictEqual((area.match(/class="lblqr"/g) || []).length, 6, 'two items on sale, three copies each; the one switched off is left out');
    assert.ok(area.startsWith('<div style="display:grid;grid-template-columns:repeat(3,62mm)'));
    assert.strictEqual(p.$('#pageStyle').textContent, '@page { size: A4; margin: 8mm; }');
    assert.strictEqual(p.log.printed, 1);
    assert.ok(p.log.toasts.some(t => /QR code could not be drawn/.test(t)), 'with no QR library the codes are printed as text, and the cashier is told');
    p.run("document.getElementById('lbSize').value = 'roll'; document.getElementById('lbCopies').value = '999'; posLabelsPrint()");
    assert.strictEqual(((p.$('#posPrintArea').innerHTML).match(/class="lblqr"/g) || []).length, 40, 'at most 20 copies of each');
    assert.strictEqual(p.$('#pageStyle').textContent, '@page { size: 50mm 30mm; margin: 0; }');
});

test('POS screen: a chosen customer locks the buyer boxes, goes on the sale, and is forgotten after it', async () => {
    const khan = { id: 'c1', code: 'CUS0001', name: 'Khan Events', pntn: '1234567-8', cnic: '', phone: '03001234567', active: true };
    const rec = recorder({ '/api/pos/sales': { result: { outcome: 'REJECTED', message: 'no' }, sale: { id: 's1', usin: '000001', totalBill: 116, state: 'REJECTED' } } });
    const p = page({ answers: rec.answers });
    p.run(SCAN_SETUP);
    p.run("POS.cart = [{ itemId: 'i1', qty: '1', price: '', disc: '' }]; posRenderCart(); posRenderCustomer()");
    assert.match(p.$('#pCustomer').innerHTML, /Find by name, phone, CNIC or PNTN/);
    p.run(`posCust.hits = [${JSON.stringify(khan)}]; posCustPick('c1')`);
    assert.strictEqual(p.run('POS.customer.code'), 'CUS0001');
    assert.deepStrictEqual(JSON.parse(p.run('JSON.stringify(POS.buyer)')), { name: 'Khan Events', pntn: '1234567-8', cnic: '', phone: '03001234567' });
    assert.deepStrictEqual(['pbName', 'pbPntn', 'pbCnic', 'pbPhone'].map(id => p.$('#' + id).readOnly), [true, true, true, true], 'the boxes are locked');
    assert.deepStrictEqual(['pbName', 'pbPhone'].map(id => p.$('#' + id).value), ['Khan Events', '03001234567'], 'and show the customer');
    assert.match(p.$('#pCustomer').innerHTML, /Khan Events/);
    assert.match(p.$('#pCustomer').innerHTML, /These details go on the invoice/);
    assert.strictEqual(p.$('#pCustomerSave').innerHTML, '', 'no "save as a customer" for one that is saved');
    await p.run('posFinalize()');
    const [url, body] = rec.bodies.find(b => b[0] === '/api/pos/sales');
    assert.strictEqual(url, '/api/pos/sales');
    assert.strictEqual(body.customerId, 'c1', 'the sale names the customer');
    assert.strictEqual(p.run('POS.customer'), null, 'and the next sale starts with none');
    assert.strictEqual(p.$('#pbName').readOnly, false);
    // Change gives the boxes back, empty
    p.run(`posCust.hits = [${JSON.stringify(khan)}]; posCustPick('c1'); posCustClear()`);
    assert.deepStrictEqual([p.run('POS.customer'), p.$('#pbName').readOnly, p.$('#pbName').value, p.run('POS.buyer.name')], [null, false, '', '']);
});

test('POS screen: "save these details as a customer" saves first and the sale points at the customer; a clash does not stop the sale', async () => {
    const saved = { id: 'cNew', code: 'CUS0009', name: 'Walk In', pntn: '', cnic: '', phone: '' };
    let mode = 'ok';
    const rec = recorder({
        '/api/pos/customers': () => { if (mode === 'clash') throw new Error('A customer with this PNTN already exists: Khan Events (CUS0001).'); return saved; },
        '/api/pos/sales': { result: { outcome: 'REJECTED', message: 'no' }, sale: { id: 's1', usin: '000001', totalBill: 116, state: 'REJECTED' } },
    });
    const p = page({ answers: rec.answers });
    p.run(SCAN_SETUP);
    p.run("POS.cart = [{ itemId: 'i1', qty: '1', price: '', disc: '' }]; posRenderCart(); posRenderCustomer()");
    assert.strictEqual(p.$('#pCustomerSave').innerHTML, '', 'nothing to save until a name is typed');
    p.run("posBuyer('name', 'Walk In')");
    assert.match(p.$('#pCustomerSave').innerHTML, /Save these details as a customer/);
    p.run('POS.saveCustomer = true');
    await p.run('posFinalize()');
    const posted = rec.bodies.filter(b => b[0] === '/api/pos/customers');
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0][1].name, 'Walk In');
    assert.strictEqual(rec.bodies.find(b => b[0] === '/api/pos/sales')[1].customerId, 'cNew', 'the sale points at the new customer');
    assert.ok(p.log.toasts.some(t => /Saved as customer CUS0009/.test(t)));
    // a clash: the sale goes ahead with the details as typed
    mode = 'clash'; rec.bodies.length = 0; p.log.toasts.length = 0;
    p.run("POS.cart = [{ itemId: 'i1', qty: '1', price: '', disc: '' }]; POS.customer = null; posBuyer('name', 'Khan Again'); POS.saveCustomer = true; posRenderCart()");
    await p.run('posFinalize()');
    const sale = rec.bodies.find(b => b[0] === '/api/pos/sales')[1];
    assert.strictEqual(sale.customerId, undefined, 'no customer');
    assert.strictEqual(sale.buyer.name, 'Khan Again', 'the typed details are used');
    assert.ok(p.log.toasts.some(t => /Not saved as a customer: A customer with this PNTN already exists.*sale is made with the details typed/.test(t)), p.log.toasts.join(' | '));
});

test('POS screen: signing out of the cashier forgets the camera, the customer and the customers list', () => {
    const p = page();
    p.run(SCAN_SETUP);
    p.run("POS.customer = { id: 'c1' }; POS.saveCustomer = true; posCust.rows = [1, 2]; posCust.q = 'khan'; posCust.active = ''; posScan.open = true");
    p.run('posReset()');
    assert.deepStrictEqual([p.run('POS.customer'), p.run('POS.saveCustomer'), p.run('posCust.rows.length'), p.run('posCust.q'), p.run('posCust.active'), p.run('posScan.open')], [null, false, 0, '', '1', false]);
});

// ---------- reports ----------
const CLOSING = {
    date: '2026-10-19', scope: 'TEST', leftOut: 1, business: { name: 'Al <b>Noor</b>', pntn: '1234567-8', address: 'x' }, counter: { name: 'Till 1', posId: '900001', branch: 'Main' }, cashier: null,
    totals: { sales: 3, returns: 1, quantity: 6, saleValue: 4000, discount: 100, tax: 640, bill: 4640, returnValue: 1000, returnTax: 160, returnBill: 1160, returnQuantity: 1, netQuantity: 5, netValue: 3000, netTax: 480, netBill: 3480 },
    byPayment: [{ key: '1', label: 'Cash', netBill: 2320, returnBill: 1160 }, { key: '2', label: 'Card', netBill: 1160, returnBill: 0 }],
    byTaxRate: [{ key: '16.00', label: '16%', netValue: 3000, netTax: 480 }],
    byCashier: [{ key: 'ali@test', label: 'ali', netBill: 2320, sales: 2 }, { key: 'sara@test', label: 'sara', netBill: 1160, sales: 1 }],
    byCounter: [], cashExpected: 2320, firstSale: { usin: '000001', fiscalNumber: 'X1', at: '2026-10-19T04:00:00Z' }, lastSale: { usin: '000003', fiscalNumber: 'X3', at: '2026-10-19T12:00:00Z' },
    returned: [{ usin: '000004', refUsin: '000001', bill: 1160, note: 'x', at: '2026-10-19T09:00:00Z' }], notFiscalized: { waiting: 0, refused: 1, unknown: 0, cancelled: 2 },
};

test('POS screen: the date presets are Pakistan days', () => {
    const p = page();
    p.run("pkDate = () => '2026-10-21'"); // a Wednesday
    const range = n => JSON.parse(p.run(`JSON.stringify(posRange('${n}'))`));
    assert.deepStrictEqual(range('today'), ['2026-10-21', '2026-10-21']);
    assert.deepStrictEqual(range('yesterday'), ['2026-10-20', '2026-10-20']);
    assert.deepStrictEqual(range('week'), ['2026-10-19', '2026-10-21'], 'Monday to today');
    assert.deepStrictEqual(range('month'), ['2026-10-01', '2026-10-21']);
    assert.deepStrictEqual(range('lastmonth'), ['2026-09-01', '2026-09-30']);
    assert.deepStrictEqual(range('30'), ['2026-09-22', '2026-10-21']);
    p.run("pkDate = () => '2026-03-01'"); // across the end of February
    assert.deepStrictEqual(range('lastmonth'), ['2026-02-01', '2026-02-28']);
    assert.deepStrictEqual(range('yesterday'), ['2026-02-28', '2026-02-28']);
    p.run("pkDate = () => '2026-01-01'"); // across the new year; a Thursday: the week began on Monday 29 December
    assert.deepStrictEqual(range('week'), ['2025-12-29', '2026-01-01']);
    assert.deepStrictEqual(range('lastmonth'), ['2025-12-01', '2025-12-31']);
    p.run("pkDate = () => '2026-10-18'"); // a Sunday: the week began on Monday the 12th
    assert.deepStrictEqual(range('week'), ['2026-10-12', '2026-10-18']);
    assert.strictEqual(p.run("posLong('2026-10-19')"), 'Monday, 19 October 2026');
});

test('POS screen: the report asks for exactly the filters that are chosen', () => {
    const p = page();
    p.run("posRep.from = '2026-10-01'; posRep.to = '2026-10-31'");
    const q = () => Object.fromEntries(new URLSearchParams(p.run('posRepQuery().toString()')));
    assert.deepStrictEqual(q(), { from: '2026-10-01', to: '2026-10-31' }, 'no filter: only the dates');
    p.run("Object.assign(posRep.f, { counter: 'c:abc', cashier: 'ali@test', paymentMode: '2', invoiceType: 'sale', category: 'Food', taxRate: '16', minAmount: '500', maxAmount: '9000' })");
    assert.deepStrictEqual(q(), { from: '2026-10-01', to: '2026-10-31', counterId: 'abc', cashier: 'ali@test', paymentMode: '2', invoiceType: 'sale', category: 'Food', taxRate: '16', minAmount: '500', maxAmount: '9000' });
    p.run("posRep.f.counter = 'b:branch1'");
    assert.deepStrictEqual([q().branchId, q().counterId], ['branch1', undefined], 'a branch is not a counter');

    p.run("posRep.f.taxRate = '0'");
    assert.strictEqual(q().taxRate, '0', 'a rate of 0 is a filter, not "no filter"');
    // the filters in words, for the top of a printout
    p.run("posRep.opts = { cashiers: [{ email: 'ali@test', name: 'Ali Khan' }], paymentModes: [{ id: 2, label: 'Card' }], branches: [{ id: 'branch1', name: 'Main', active: true, counters: [{ id: 'abc', name: 'Till 1', active: true }] }] }");
    assert.match(p.run('posRepFilterWords()'), /^Filters: branch Main, cashier Ali Khan, paid by Card, sales only, category Food, tax rate 0%, bills from Rs 500, bills up to Rs 9000$/);
    p.run("posRep.f = { counter: '', cashier: '', paymentMode: '', invoiceType: '', category: '', taxRate: '', minAmount: '', maxAmount: '' }");
    assert.strictEqual(p.run('posRepFilterWords()'), 'No filters');
});

test('POS screen: a counter, and a payment type the list does not know, are still said in words', () => {
    const p = page();
    p.run("posRep.opts = { cashiers: [], paymentModes: [], branches: [{ id: 'branch1', name: 'Main', active: true, counters: [{ id: 'abc', name: 'Till 1', active: true }] }] }; posRep.f.counter = 'c:abc'");
    assert.strictEqual(p.run('posRepFilterWords()'), 'Filters: Main · Till 1', 'a counter is named with its branch');
    p.run("posRep.f.paymentMode = '4'");
    assert.strictEqual(p.run('posRepFilterWords()'), 'Filters: Main · Till 1, paid by payment type 4');
});

test('POS screen: the closing sheet says what was sold, how it was paid and what the drawer should hold', () => {
    const p = page();
    const html = decode(p.run(`posClosingHtml(${JSON.stringify(CLOSING)}, { screen: true })`));
    for (const need of ['DAILY CLOSING', 'Monday, 19 October 2026', 'Main · Till 1 (POS 900001)', 'All cashiers', '3 invoices', '4,640.00', 'NET TOTAL', '3,480.00', 'Net sales tax', '480.00',
        'Cash', '2,320.00', '(− 1,160.00 returned)', 'Sales tax by rate', '16% on 3,000.00', 'By cashier', 'ali', 'First sale', '000001', 'Last sale', '000003',
        'CASH THAT SHOULD BE IN THE DRAWER', 'Cash sales less cash given back', 'Returns made', '000004 for sale 000001', 'TEST SALES: NOT REAL FIGURES', '1 production sale is not counted', '2 cancelled']) {
        assert.ok(html.includes(need), `the sheet says "${need}"`);
    }
    assert.match(html, /1 sale is not fiscalized yet/, 'it warns that one sale still needs sorting');
    const raw = p.run(`posClosingHtml(${JSON.stringify(CLOSING)}, { screen: true })`);
    assert.ok(!raw.includes('Al <b>Noor</b>') && raw.includes('Al &lt;b&gt;Noor&lt;/b&gt;'), 'the business name is text, never markup');
    assert.ok(!html.includes('Count the drawer and write it here'), 'the screen has nothing to fill in');
    assert.ok(html.includes('Print A4') && html.includes('Print 80 mm slip'));
    // the paper copy has the lines to fill in and sign, and no buttons
    const paper = decode(p.run(`posClosingHtml(${JSON.stringify(CLOSING)}, { paper: 'a4' })`));
    assert.ok(paper.includes('Count the drawer and write it here') && paper.includes('Cashier') && paper.includes('Manager') && paper.includes('Printed'));
    assert.ok(!paper.includes('Print A4'));
    const slip = p.run(`posClosingHtml(${JSON.stringify(CLOSING)}, { paper: 'slip' })`);
    assert.ok(slip.includes('max-width:80mm') && slip.includes('width:100%'), 'as wide as the roll, never wider than the page');
    p.run('posClosingPrint(\'slip\')');
    assert.strictEqual(p.$('#pageStyle').textContent, '@page { margin: 3mm; }', 'no page size is asked for: Chrome ignores "80mm auto"');
    p.run('posClosingPrint(\'a4\')');
    assert.strictEqual(p.$('#pageStyle').textContent, '@page { size: A4; margin: 15mm; }');
    assert.strictEqual(p.run('posClosingOpen.data.date'), '2026-10-19', 'what is showing is what the Print buttons print');
    // a quiet day, in the live figures: nothing to warn about
    const quiet = decode(p.run(`posClosingHtml(${JSON.stringify({ ...CLOSING, scope: 'LIVE', leftOut: 0, totals: { ...CLOSING.totals, sales: 0, returns: 0, bill: 0, returnBill: 0, netBill: 0, netTax: 0, saleValue: 0, tax: 0, discount: 0 }, firstSale: null, lastSale: null, returned: [], byPayment: [], byTaxRate: [], byCashier: [], cashExpected: 0, notFiscalized: { waiting: 0, refused: 0, unknown: 0, cancelled: 0 } })}, { screen: true })`));
    assert.ok(quiet.includes('No sales on this day.') && !quiet.includes('TEST SALES') && !quiet.includes('not fiscalized yet') && !quiet.includes('Returns made'));
});

test('POS screen: the analysis table shows each group with its share, and a label cannot break out of the page', () => {
    const p = page();
    const row = (label, over = {}) => ({ key: label, label, sales: 2, returns: 0, quantity: 3, returnQuantity: 0, saleValue: 300, discount: 0, tax: 48, bill: 348, returnValue: 0, returnTax: 0, returnBill: 0, netQuantity: 3, netValue: 300, netTax: 48, netBill: 348, share: 50, ...over });
    const report = { groupBy: 'item', title: 'Item', scope: 'LIVE', leftOut: 0, filters: { from: '2026-10-01', to: '2026-10-31' }, rows: [row('Chai <img src=x onerror=alert(1)>'), row('Biryani', { returns: 1, returnBill: 116, netBill: 232, discount: 10 })], totals: row('Total', { sales: 4, quantity: 6, netBill: 696, bill: 696 }) };
    const html = p.run(`posAnalysisHtml(${JSON.stringify(report)})`);
    assert.ok(!html.includes('<img src=x'), 'a name is text, never markup');
    const text = decode(html);
    for (const need of ['Sales by item', 'Thursday, 1 October 2026', 'Biryani', 'Net total', '696.00', '−116.00', '50%', 'Average bill', 'Discount given']) assert.ok(text.includes(need), `says "${need}"`);
    assert.ok((html.match(/style="width:50%"/g) || []).length >= 2, 'the share is drawn as a bar');
    // a share outside 0 to 100 never draws a bar wider than its box
    assert.ok(p.run(`posAnalysisHtml(${JSON.stringify({ ...report, rows: [row('x', { share: 180 }), row('y', { share: -5 })] })})`).includes('style="width:100%"'));
    // nothing to show
    assert.ok(decode(p.run(`posAnalysisHtml(${JSON.stringify({ ...report, rows: [] })})`)).includes('No fiscalized sales match these filters.'));
    // test-mode figures say so
    assert.ok(decode(p.run(`posAnalysisHtml(${JSON.stringify({ ...report, scope: 'TEST', leftOut: 3 })})`)).includes('Test sales: not real figures.') && decode(p.run(`posAnalysisHtml(${JSON.stringify({ ...report, scope: 'TEST', leftOut: 3 })})`)).includes('3 production sales are not counted here.'));
    // the tax summary: what the monthly return needs
    const tax = decode(p.run(`posTaxHtml(${JSON.stringify({ ...report, groupBy: 'taxRate', title: 'Tax rate', rows: [row('16%', { returnValue: 100, returnTax: 16, netValue: 200, netTax: 32 })], totals: row('Total', { returnValue: 100, returnTax: 16, netValue: 200, netTax: 32, tax: 48, returns: 1 }) })})`));
    for (const need of ['Sales tax by rate', 'Tax to pay (net)', '32.00', 'Value returned', '−100.00', '−16.00', 'taxed at the card rate']) assert.ok(tax.includes(need), `the tax summary says "${need}"`);
});

// ---------- settings: how a sale starts, what the receipt looks like, what a new item starts with ----------
const withDefault = (mode, extra = '') => `${SCAN_SETUP}; POS.setup.settings = { defaultPaymentMode: ${mode}, receiptHeader: '', receiptWidth: 80, showCashier: true, itemPct: '', itemTaxRate: null, itemTaxRateCard: null, itemCategory: '' }; ${extra}`;
const pickedButton = p => (p.$('#pPay').innerHTML.match(/posMode\((\d)\)" class="[^"]*bg-emerald-700 border-emerald-700 text-white/) || [])[1];

test('POS screen: a new sale starts as the owner chose, until the cashier picks a way', async () => {
    const tea = { id: 'i1', code: 'A', name: 'Tea', category: '', pctCode: '98012000', taxRate: 16, taxRateCard: null, unitPrice: 100, openPrice: false, active: true };
    const setup = mode => ({ testMode: false, counters: [], items: [tea], paymentModes: JSON.parse(JSON.stringify(require('../public/pos-calc.js').PAYMENT_MODES)), profileComplete: true, settings: { defaultPaymentMode: mode } });
    let mode = 2;
    const p = page({ answers: { '/api/pos/setup': () => setup(mode) } });
    await p.run('posLoadSetup()');
    assert.strictEqual(p.run('POS.mode'), 2, 'card, as chosen');
    p.run('posRenderPay()');
    assert.strictEqual(pickedButton(p), '2', 'and the Card button shows as picked');
    // the cashier picks cash: a reload (the owner changed the default) does not take it away
    p.run('posMode(1)');
    mode = 4; await p.run('posLoadSetup()');
    assert.strictEqual(p.run('POS.mode'), 1);
    // clearing the sale starts the next one as the (new) default, picked by nobody
    p.run('posClear()');
    assert.deepStrictEqual([p.run('POS.mode'), p.run('POS.modePicked')], [4, false]);
    // a reload brings a new default while nobody has picked: the screen follows it, and the buttons too
    mode = 3; await p.run('posLoadSetup()');
    assert.strictEqual(p.run('POS.mode'), 3);
    assert.strictEqual(pickedButton(p), '3');
    // a sale being made keeps its way when the default changes under it
    p.run("POS.cart = [{ itemId: 'i1', qty: '1', price: '', disc: '' }]; POS.mode = 3");
    mode = 6; await p.run('posLoadSetup()');
    assert.strictEqual(p.run('POS.mode'), 3, 'not changed in the middle of a sale');
});

test('POS screen: a default the screen does not offer (or none at all) means cash', async () => {
    const setup = settings => ({ testMode: false, counters: [], items: [], paymentModes: [{ id: 1, label: 'Cash' }, { id: 2, label: 'Card' }], profileComplete: true, ...(settings === undefined ? {} : { settings }) });
    for (const [settings, want] of [[{ defaultPaymentMode: 9 }, 1], [{ defaultPaymentMode: 'card' }, 1], [{ defaultPaymentMode: 5 }, 1], [{}, 1], [null, 1], [undefined, 1], [{ defaultPaymentMode: 2 }, 2]]) {
        const p = page({ answers: { '/api/pos/setup': () => setup(settings) } });
        await p.run('posLoadSetup()');
        assert.strictEqual(p.run('POS.mode'), want, JSON.stringify(settings));
    }
});

test('POS screen: a finished sale hands the next one the default way, and signing out forgets the settings', async () => {
    const rec = recorder({ '/api/pos/sales': { result: { outcome: 'REJECTED', message: 'no' }, sale: { id: 's1', usin: '000001', totalBill: 116, state: 'REJECTED' } } });
    const p = page({ answers: rec.answers });
    p.run(withDefault(2));
    p.run("posMode(1); POS.cart = [{ itemId: 'i1', qty: '1', price: '', disc: '' }]; posRenderCart()");
    await p.run('posFinalize()');
    assert.strictEqual(rec.bodies.find(b => b[0] === '/api/pos/sales')[1].paymentMode, 1, 'this sale was paid the way the cashier picked');
    assert.deepStrictEqual([p.run('POS.mode'), p.run('POS.modePicked')], [2, false], 'the next one starts as the default');
    p.run("POS.settings = { itemPct: '98012000' }; POS.receiptWidth = 58");
    p.run('posReset()');
    assert.deepStrictEqual([p.run('POS.settings'), p.run('POS.receiptWidth'), p.run('POS.mode'), p.run('POS.modePicked')], [null, 80, 1, false]);
});

const rcData = (look, sale = {}) => ({
    business: { name: 'Test Restaurant', pntn: '1234567-8', address: 'MM Alam Road', phone: '', footer: '' }, branch: null, counter: { name: 'Till 1', posId: '900001' },
    ...(look === undefined ? {} : { look }),
    sale: { usin: '000001', fiscalNumber: 'X1', verifyUrl: 'https://example/x', invoiceType: 1, refUsin: null, paymentMode: 1, mock: false, env: 'PRODUCTION', at: '2026-10-19T08:00:00Z', cashier: 'ali',
        buyer: { name: '', pntn: '', cnic: '', phone: '' }, totals: { quantity: 3, saleValue: 300, discount: 0, tax: 48, bill: 348 },
        lines: [{ itemName: 'Tea', quantity: 3, unitPrice: 100, discount: 0, taxRate: 16, saleValue: 300, taxCharged: 48, totalAmount: 348 }], ...sale },
});
const shownReceipt = (p, rc) => decode(p.run(`posReceiptHtml(${JSON.stringify(rc)})`));

test('POS screen: the receipt prints the owner\'s header line and the cashier\'s name only when asked to', () => {
    const p = page();
    const plain = shownReceipt(p, rcData({ header: 'Fine dining since 1998', width: 80, showCashier: true }));
    assert.ok(plain.includes('Fine dining since 1998') && plain.includes('Cashier') && plain.includes('ali'));
    assert.ok(plain.indexOf('Test Restaurant') < plain.indexOf('Fine dining since 1998') && plain.indexOf('Fine dining since 1998') < plain.indexOf('MM Alam Road'), 'the header is under the business name, above the address');
    const quiet = shownReceipt(p, rcData({ header: '', width: 80, showCashier: false }));
    assert.ok(!quiet.includes('Cashier') && !/>ali</.test(quiet), 'no cashier line');
    assert.ok(quiet.includes('Counter') && quiet.includes('Till 1'), 'the rest of the receipt is the same');
    assert.ok(!shownReceipt(p, rcData({ header: '', width: 80, showCashier: true }, { cashier: '' })).includes('Cashier'), 'an empty name is not printed as an empty line');
    // an answer without the look (an old one): the paper as it always was
    const old = shownReceipt(p, rcData(undefined));
    assert.ok(old.includes('Cashier') && old.includes('ali'));
    // text is text: a header cannot become markup
    const html = p.run(`posReceiptHtml(${JSON.stringify(rcData({ header: '<img src=x onerror=alert(1)>', width: 80, showCashier: true }))})`);
    assert.ok(!html.includes('<img src=x') && html.includes('&lt;img src=x'));
});

test('POS screen: the receipt window and the print use the paper the owner chose', async () => {
    for (const [width, size, font] of [[58, 58, '10px'], [80, 80, ''], [70, 80, ''], [undefined, 80, '']]) {
        const rc = rcData({ header: '', width, showCashier: true });
        const p = page({ answers: { '/api/pos/sales/s1/receipt': JSON.parse(JSON.stringify(rc)) } });
        p.run(SETUP);
        await p.run("posShowReceipt('s1')");
        const shown = p.run('POS.receiptWidth');
        assert.strictEqual(shown, size === 58 ? 58 : 80, `width ${width}`);
        assert.strictEqual(p.$('#posReceipt').style.width, `${shown}mm`);
        assert.strictEqual(p.$('#posReceipt').style.maxWidth, `${shown}mm`, 'on paper it can be narrower than that (the page), never wider');
        assert.strictEqual(p.$('#posReceipt').style.fontSize, font);
        p.run('posPrintReceipt()');
        // Chrome ignores "size: 80mm auto" (auto cannot go with a length), so the printer's own paper size is used: only the margin is set
        assert.strictEqual(p.$('#pageStyle').textContent, '@page { margin: 3mm; }');
        assert.strictEqual(p.log.printed, 1);
    }
});

test('POS screen: a new item starts from the owner\'s defaults; an item being edited keeps its own', () => {
    const p = page();
    p.run(SETUP);
    p.run("POS.items = [{ id: 'i1', code: 'A', barcode: null, name: 'Tea', category: 'Drinks', pctCode: '98013000', taxRate: 5, taxRateCard: null, unitPrice: 100, openPrice: false, active: true }]");
    const field = (id, html = p.$('#piForm').innerHTML) => { const m = new RegExp(`id="${id}" value="([^"]*)"`).exec(html); return m ? decode(m[1]) : null; };
    p.run('POS.settings = null; posItemForm()');
    assert.deepStrictEqual(['fiPct', 'fiRate', 'fiRateCard', 'fiCat'].map(id => field(id)), ['', '', '', ''], 'no settings: a blank form, as before');
    p.run("POS.settings = { itemPct: '98012000', itemTaxRate: 16, itemTaxRateCard: 8, itemCategory: 'Food & Drink' }; posItemForm()");
    assert.deepStrictEqual(['fiPct', 'fiRate', 'fiRateCard', 'fiCat'].map(id => field(id)), ['9801.2000', '16', '8', 'Food & Drink']);
    p.run("posItemForm(null, { barcode: '8964000123456', name: 'Scanned', category: 'Snacks' })");
    assert.deepStrictEqual(['fiBarcode', 'fiName', 'fiCat', 'fiPct', 'fiRate'].map(id => field(id)), ['8964000123456', 'Scanned', 'Snacks', '9801.2000', '16'], 'what a scan knows wins; the rest is the default');
    p.run("posItemForm('i1')");
    assert.deepStrictEqual(['fiPct', 'fiRate', 'fiRateCard', 'fiCat'].map(id => field(id)), ['9801.3000', '5', '', 'Drinks'], 'its own values, not the defaults');
    // a tax of nothing is a rate, not a blank
    p.run("POS.settings = { itemPct: '', itemTaxRate: 0, itemTaxRateCard: 0, itemCategory: '' }; posItemForm()");
    assert.deepStrictEqual(['fiPct', 'fiRate', 'fiRateCard'].map(id => field(id)), ['', '0', '0']);
});

test('POS screen: a quick rate fills the heading and the tax boxes, and says to check the schedule', () => {
    const p = page();
    p.run(SETUP);
    p.run('POS.settings = null; POS.items = []; posItemForm()');
    const html = p.$('#piForm').innerHTML;
    for (const id of ['restaurant', 'hotel', 'hall', 'caterer', 'beauty']) assert.ok(html.includes(`<option value="${id}">`), `offers ${id}`);
    assert.ok(decode(html).includes('9801.2000 · 16% (8% on card)'));
    p.$('#fiPreset').value = 'restaurant';
    p.run("posApplyRate('restaurant', 'fi')");
    assert.deepStrictEqual(['#fiPct', '#fiRate', '#fiRateCard'].map(id => p.$(id).value), ['9801.2000', 16, 8]);
    assert.strictEqual(p.$('#fiPreset').value, '', 'the list goes back to its title: the boxes are the truth now');
    assert.match(p.$('#fiRateNote').textContent, /Filled in for restaurant, café, fast food: 9801\.2000 · 16% \(8% on card\)\. .*current schedule/);
    p.run("posApplyRate('hall', 'fi')");
    assert.deepStrictEqual(['#fiPct', '#fiRate', '#fiRateCard'].map(id => p.$(id).value), ['9801.3000', 8, ''], 'a flat rate empties the card box');
    p.run("posApplyRate('nonsense', 'fi')");
    assert.deepStrictEqual(['#fiPct', '#fiRate', '#fiRateCard'].map(id => p.$(id).value), ['9801.3000', 8, ''], 'an unknown name changes nothing');
    // the same list works for the Settings boxes
    p.run("posApplyRate('beauty', 'sd')");
    assert.deepStrictEqual(['#sdPct', '#sdRate', '#sdRateCard'].map(id => p.$(id).value), ['9810.0000', 5, '']);
});

const DEFAULTS = { defaultPaymentMode: 2, receiptHeader: 'Fine <dining>', receiptWidth: 58, showCashier: false, itemPct: '98012000', itemTaxRate: 16, itemTaxRateCard: 8, itemCategory: 'Food' };

test('POS screen: the Defaults card shows what is saved, and escapes it', () => {
    const p = page();
    p.run(`POS.setup = null; POS.settings = ${JSON.stringify(DEFAULTS)}`);
    const html = p.run('posSettingsCard()');
    assert.match(html, /<option value="2" selected>Card<\/option>/);
    assert.match(html, /<option value="58" selected>58 mm roll<\/option>/);
    assert.ok(!/id="sdCashier" type="checkbox" style="width:auto" checked/.test(html), 'the cashier box is not ticked');
    assert.ok(html.includes('value="Fine &lt;dining&gt;"') && !html.includes('Fine <dining>'));
    assert.ok(html.includes('id="sdPct" value="9801.2000"') && html.includes('id="sdRate" value="16"') && html.includes('id="sdRateCard" value="8"') && html.includes('id="sdCat" value="Food"'));
    const fresh = p.run("POS.settings = { defaultPaymentMode: 1, receiptHeader: '', receiptWidth: 80, showCashier: true, itemPct: '', itemTaxRate: null, itemTaxRateCard: null, itemCategory: '' }; posSettingsCard()");
    assert.match(fresh, /<option value="1" selected>Cash<\/option>/);
    assert.match(fresh, /<option value="80" selected>80 mm roll<\/option>/);
    assert.match(fresh, /id="sdCashier" type="checkbox" style="width:auto" checked/);
    assert.ok(fresh.includes('id="sdRate" value=""') && fresh.includes('id="sdPct" value=""'));
});

test('POS screen: saving the defaults sends the boxes, shows what the server kept, and tells the sale screen', async () => {
    let sent = null, answer = null;
    const p = page({ answers: { '/api/pos/settings': (url, opts) => { sent = opts; if (answer instanceof Error) throw answer; return answer; } } });
    p.run(withDefault(1));
    p.run('POS.settings = { defaultPaymentMode: 1 }');
    const fill = { '#sdMode': '2', '#sdWidth': '58', '#sdHeader': '  Fine   dining ', '#sdPct': '9801.2000', '#sdRate': '16', '#sdRateCard': '8', '#sdCat': ' Food ' };
    for (const [id, v] of Object.entries(fill)) p.$(id).value = v;
    p.$('#sdCashier').checked = false;
    answer = { ...DEFAULTS, receiptHeader: 'Fine dining', itemCategory: 'Food' };
    await p.run('posSaveSettings()');
    assert.strictEqual(sent.method, 'PUT');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(sent.body)), { defaultPaymentMode: '2', receiptWidth: '58', showCashier: false, receiptHeader: '  Fine   dining ', itemPct: '9801.2000', itemTaxRate: '16', itemTaxRateCard: '8', itemCategory: ' Food ' });
    assert.ok(p.log.toasts.includes('Defaults saved'));
    assert.deepStrictEqual(['#sdHeader', '#sdCat', '#sdPct', '#sdRate', '#sdRateCard'].map(id => p.$(id).value), ['Fine dining', 'Food', '9801.2000', 16, 8], 'the boxes show what was kept');
    assert.strictEqual(p.run('POS.settings.receiptWidth'), 58);
    assert.strictEqual(p.run('POS.setup.settings.defaultPaymentMode'), 2, 'the cashier screen of this browser starts from it at once');
    // the server says no: its words are shown, and nothing changes here
    p.log.toasts.length = 0; answer = new Error('The receipt paper is 58 mm or 80 mm wide.');
    p.run('POS.settings.receiptWidth = 58');
    await p.run('posSaveSettings()');
    assert.deepStrictEqual(p.log.toasts, ['The receipt paper is 58 mm or 80 mm wide.']);
    assert.strictEqual(p.run('POS.settings.receiptWidth'), 58);
});

test('POS screen: the Items page and the Settings page ask for the defaults; a failed ask is not a failed page', async () => {
    const calls = [];
    const p = page({ answers: { '/api/pos/items': [], '/api/pos/settings': () => { calls.push('settings'); return { itemPct: '98012000', itemTaxRate: 16 }; } } });
    p.run(SETUP);
    await p.run('posEnterItems()');
    assert.deepStrictEqual(calls, ['settings']);
    assert.strictEqual(p.run('POS.settings.itemTaxRate'), 16);
    // the settings cannot be read: the item form still opens, blank
    const q = page({ answers: { '/api/pos/items': [], '/api/pos/settings': () => { throw new Error('offline'); } } });
    q.run(SETUP);
    await q.run('posEnterItems()');
    assert.strictEqual(q.run('POS.settings'), null);
    q.run('posItemForm()');
    assert.ok(q.$('#piForm').innerHTML.includes('Add an item'));
    assert.deepStrictEqual(q.log.toasts, [], 'no error is shown for it');
});

// ---------- the scanner that types, and the camera, on the cashier screen ----------
const keys = (p, clock, text, { target = { tagName: 'BODY' }, gap = 5, enter = true } = {}) => {
    const sent = [];
    const press = k => { const ev = { key: k, target, ctrlKey: false, metaKey: false, altKey: false, prevented: false, preventDefault() { this.prevented = true; } }; p.fire('keydown', ev); sent.push(ev); clock.now += gap; };
    for (const ch of text) press(ch);
    if (enter) { clock.now -= gap - 2; press('Enter'); }
    return sent;
};
function scannerPage() {
    const clock = { now: Date.parse('2026-10-19T08:00:00Z') };
    const p = page({ clock });
    p.run(SETUP);
    p.run("S.page = 'p-sale'; const __scanned = []; posScanSale = async c => { __scanned.push(c); return { ok: true, message: 'ok' }; }; posBeep = () => {}; posInstallScanner();");
    for (const id of ['posModal', 'posReceiptModal', 'posScanModal']) p.$('#' + id).classList.add('hidden'); // (no window is open)
    return { p, clock, scanned: () => JSON.parse(p.run('JSON.stringify(__scanned)')) };
}

test('POS screen: a scan that arrives while the counter list has the keyboard is a scan, and never changes the counter', async () => {
    const { p, clock, scanned } = scannerPage();
    const list = { tagName: 'SELECT', id: 'pCounter' };
    const sent = keys(p, clock, 'MILK1', { target: list });
    assert.deepStrictEqual(scanned(), ['MILK1'], 'the item was looked up');
    assert.ok(sent.every(e => e.prevented), 'every letter and the Enter were kept from the list (its "type to pick" would have changed the counter)');
    // a person typing letters on the list does not pick a counter either, and starts no scan
    const slow = keys(p, clock, 'ab', { target: list, gap: 400, enter: false });
    assert.ok(slow.every(e => e.prevented));
    assert.deepStrictEqual(scanned(), ['MILK1']);
    // but what a person uses the list with still works: the arrows, Space and Enter on their own
    const nav = [];
    for (const k of ['ArrowDown', 'ArrowUp', ' ', 'Enter', 'Tab']) { const ev = { key: k, target: list, ctrlKey: false, metaKey: false, altKey: false, prevented: false, preventDefault() { this.prevented = true; } }; clock.now += 1000; p.fire('keydown', ev); nav.push(ev.prevented); }
    assert.deepStrictEqual(nav, [false, false, false, false, false]);
});

test('POS screen: a short code is a scan too, so its Enter never presses the button that has the focus', async () => {
    const { p, clock, scanned } = scannerPage();
    const button = { tagName: 'BUTTON' };
    const three = keys(p, clock, 'TEA', { target: button });
    assert.deepStrictEqual(scanned(), ['TEA']);
    assert.strictEqual(three[three.length - 1].prevented, true, 'the Enter of the scan did not press the button');
    keys(p, clock, 'AB', { target: button });
    assert.deepStrictEqual(scanned(), ['TEA', 'AB']);
    // a single key and Enter is a person: the button gets its Enter
    const one = keys(p, clock, 'x', { target: button });
    assert.strictEqual(one[one.length - 1].prevented, false);
    // Enter on its own, and Enter long after a stray burst, are a person's too
    const lone = keys(p, clock, '', { target: button });
    assert.strictEqual(lone[0].prevented, false);
    keys(p, clock, 'ITM0001', { target: { tagName: 'BODY' }, enter: false }); clock.now += 5000;
    const late = keys(p, clock, '', { target: button });
    assert.strictEqual(late[0].prevented, false, 'seconds later it is not the end of a scan');
    assert.deepStrictEqual(scanned(), ['TEA', 'AB']);
});

test('POS screen: boxes the cashier types in, and open windows, are left alone by the scanner', async () => {
    const { p, clock, scanned } = scannerPage();
    for (const tagName of ['INPUT', 'TEXTAREA']) {
        const sent = keys(p, clock, 'ITM0001', { target: { tagName } });
        assert.ok(sent.every(e => !e.prevented), tagName);
    }
    assert.deepStrictEqual(scanned(), []);
    p.$('#posModal').classList.remove('hidden');
    assert.ok(keys(p, clock, 'ITM0001').every(e => !e.prevented), 'a window is open');
    p.$('#posModal').classList.add('hidden');
    p.run("S.page = 'p-sales'");
    assert.ok(keys(p, clock, 'ITM0001').every(e => !e.prevented), 'only the sale screen takes scans');
    assert.deepStrictEqual(scanned(), []);
    p.run("S.page = 'p-sale'");
    keys(p, clock, 'ITM0001');
    assert.deepStrictEqual(scanned(), ['ITM0001'], 'and it does there');
});

test('POS screen: one code held in front of the camera is one scan, however long it stays', async () => {
    const clock = { now: Date.parse('2026-10-19T08:00:00Z') };
    const p = page({ clock });
    p.run(SETUP);
    p.run("const __got = []; posBeep = () => {}; Object.assign(posScan, { open: true, continuous: true, last: '', seenAt: 0, busy: false, handler: async t => { __got.push(t); return { ok: true, message: 'in' }; } });");
    const got = () => JSON.parse(p.run('JSON.stringify(__got)'));
    const sight = async (code, ms = 0) => { clock.now += ms; await p.run(`posScanGot(${JSON.stringify(code)})`); };
    await sight('ITM0001');
    for (let i = 0; i < 100; i++) await sight('ITM0001', 120); // twelve seconds in front of the camera
    assert.deepStrictEqual(got(), ['ITM0001'], 'counted once');
    await sight('ITM0001', 1300); // out of sight for a moment, then back: the next unit
    assert.deepStrictEqual(got(), ['ITM0001', 'ITM0001']);
    for (let i = 0; i < 20; i++) await sight('ITM0001', 500); // flickering in and out, never gone for long
    assert.deepStrictEqual(got(), ['ITM0001', 'ITM0001'], 'a camera that misses a few frames does not count it again');
    await sight('ITM0002', 100); // another item is its own scan at once
    assert.deepStrictEqual(got(), ['ITM0001', 'ITM0001', 'ITM0002']);
    await sight('ITM0001', 100); // and the first one coming back right after it counts, because it was not what the camera last saw
    assert.deepStrictEqual(got(), ['ITM0001', 'ITM0001', 'ITM0002', 'ITM0001']);
    // a code typed or pasted into the camera window is always meant
    p.$('#posScanType').value = 'ITM0001'; await p.run('posScanTyped()');
    assert.strictEqual(got().length, 5);
    p.$('#posScanType').value = 'ITM0001'; await p.run('posScanTyped()');
    assert.strictEqual(got().length, 6);
});

test('POS screen: the counter list gives the keyboard back once a counter is picked', () => {
    const p = page();
    p.run(SETUP);
    let blurred = 0;
    p.doc.activeElement = { id: 'pCounter', blur() { blurred++; } };
    p.run("posPickCounter('c1')");
    assert.strictEqual(blurred, 1);
    p.doc.activeElement = { id: 'something-else', blur() { blurred += 10; } };
    p.run("posPickCounter('c1')");
    assert.strictEqual(blurred, 1, 'only that list');
    p.doc.activeElement = null;
    p.run("posPickCounter('c1')"); // nothing focused: no harm
});

test('POS screen: the cashier names of one login are not the next login\'s', () => {
    const p = page();
    p.run("POS.cashiers = [{ email: 'old@business.pk', name: 'Old Staff' }]");
    p.run('posReset()');
    assert.strictEqual(p.run('POS.cashiers'), null);
});

// ---------- from a report row to its invoices ----------
const repRow = (key, label, over = {}) => ({ key, label, sales: 2, returns: 0, quantity: 3, returnQuantity: 0, saleValue: 300, discount: 0, tax: 48, bill: 348, returnValue: 0, returnTax: 0, returnBill: 0, netQuantity: 3, netValue: 300, netTax: 48, netBill: 348, share: 50, ...over });
const repData = (groupBy, rows, over = {}) => ({ groupBy, title: groupBy, scope: 'LIVE', leftOut: 0, filters: { from: '2026-10-05', to: '2026-11-20' }, rows, totals: repRow('Total', { sales: 4 }), ...over });
const drillPage = (groupBy, rows, over = {}, opts = {}) => {
    const p = page(opts);
    p.run(SETUP);
    p.run(`S.page = 'p-reports'; posRep.opts = { branches: [{ id: 'b1', name: 'Main branch', counters: [] }, { id: 'b2', name: 'Annex', counters: [] }] }; posRep.last = { kind: 'analysis', groupBy: ${JSON.stringify(groupBy)}, data: ${JSON.stringify(repData(groupBy, rows, over))} }`);
    return p;
};
const salesNow = p => JSON.parse(p.run('JSON.stringify(POS.sales)'));

test('POS screen: a blank set of sales filters has every filter in it, and a new one can be added to', () => {
    const p = page();
    const blank = JSON.parse(p.run('JSON.stringify(posBlankSales())'));
    assert.deepStrictEqual(Object.keys(blank).sort(), ['branchId', 'branchName', 'cashier', 'category', 'counterId', 'customerId', 'customerName', 'env', 'from', 'invoiceType', 'itemCode', 'itemName', 'maxAmount', 'minAmount', 'paymentMode', 'q', 'state', 'taxRate', 'to'].sort());
    assert.strictEqual(blank.from, null, 'a first visit is not a date');
    assert.deepStrictEqual(JSON.parse(p.run("JSON.stringify(posBlankSales({ from: '', env: 'SANDBOX' }))")), { ...blank, from: '', env: 'SANDBOX' });
    assert.deepStrictEqual(salesNow(p), blank, 'and that is how the list starts');
});

test('POS screen: a report row opens its invoices with the report\'s own filters, its group, "fiscalized" and the kind of sale the figures cover', () => {
    // an item row of a test-mode report that was narrowed to one category, one cashier and a size of bill
    let p = drillPage('item', [repRow('ITM0001', 'Lunch buffet <b>')], { scope: 'TEST', filters: { from: '2026-10-05', to: '2026-11-20', category: 'Food', cashier: 'ali@test', minAmount: 1000, taxRate: 16, invoiceType: 'sale', paymentMode: 2, counterId: 'c9' } });
    p.run('posRepDrill(0)');
    assert.deepStrictEqual(p.log.went, ['p-sales']);
    assert.deepStrictEqual(salesNow(p), { ...JSON.parse(p.run('JSON.stringify(posBlankSales())')), from: '2026-10-05', to: '2026-11-20', state: 'FISCALIZED', env: 'SANDBOX', counterId: 'c9', cashier: 'ali@test', paymentMode: '2', invoiceType: 'sale', minAmount: '1000', category: 'Food', taxRate: '16', itemCode: 'ITM0001', itemName: 'Lunch buffet <b>' });
    // a live report says real sales
    p = drillPage('cashier', [repRow('sara@test', 'Sara')], { scope: 'LIVE' });
    p.run('posRepDrill(0)');
    assert.deepStrictEqual([salesNow(p).env, salesNow(p).cashier, salesNow(p).from, salesNow(p).to], ['PRODUCTION', 'sara@test', '2026-10-05', '2026-11-20']);
});

test('POS screen: every way of grouping that has a list opens the right one, and the others have no link', () => {
    const open = (groupBy, key, label = 'x', over) => { const p = drillPage(groupBy, [repRow(key, label)], over); p.run('posRepDrill(0)'); return { went: p.log.went, sales: salesNow(p) }; };
    const pick = (o, ...ks) => Object.fromEntries(ks.map(k => [k, o.sales[k]]));
    assert.deepStrictEqual(pick(open('day', '2026-10-19'), 'from', 'to'), { from: '2026-10-19', to: '2026-10-19' });
    assert.deepStrictEqual(pick(open('month', '2026-10'), 'from', 'to'), { from: '2026-10-05', to: '2026-10-31' }, 'only the days of the month that the report covers');
    assert.deepStrictEqual(pick(open('month', '2026-11'), 'from', 'to'), { from: '2026-11-01', to: '2026-11-20' });
    assert.deepStrictEqual(pick(open('category', 'Food'), 'category'), { category: 'Food' });
    assert.deepStrictEqual(pick(open('category', '', 'No category'), 'category'), { category: '__none' });
    assert.deepStrictEqual(pick(open('counter', 'c1', 'Main · Till 1'), 'counterId'), { counterId: 'c1' });
    assert.deepStrictEqual(pick(open('branch', 'b2', 'Annex'), 'branchId', 'branchName'), { branchId: 'b2', branchName: 'Annex' });
    assert.deepStrictEqual(pick(open('payment', '2', 'Card'), 'paymentMode'), { paymentMode: '2' });
    assert.deepStrictEqual(pick(open('taxRate', '16.00', '16%'), 'taxRate'), { taxRate: '16.00' });
    assert.deepStrictEqual(pick(open('customer', 'cu1', 'Khan Events (CUS0001)'), 'customerId', 'customerName'), { customerId: 'cu1', customerName: 'Khan Events (CUS0001)' });
    assert.deepStrictEqual(pick(open('customer', '', 'No saved customer'), 'customerId'), { customerId: 'none' });
    // the hour and the weekday of a sale cannot narrow the list: nothing opens
    for (const g of ['hour', 'weekday']) { const o = open(g, '12'); assert.deepStrictEqual(o.went, [], g); }
    // a row that is not there, or a report that is not showing, does nothing
    const p = drillPage('item', [repRow('A', 'A')]);
    p.run('posRepDrill(7)'); p.run('posRep.last = null; posRepDrill(0)'); p.run("posRep.last = { kind: 'closing', data: {} }; posRepDrill(0)");
    assert.deepStrictEqual(p.log.went, []);
});

test('POS screen: from the Sales page itself a report row refreshes the list instead of navigating', async () => {
    const p = drillPage('item', [repRow('ITM0001', 'Lunch buffet')]);
    p.run("S.page = 'p-sales'");
    p.run('posRepDrill(0)'); await sleep(50);
    assert.deepStrictEqual(p.log.went, []);
    const asked = p.log.api.find(u => u.startsWith('/api/pos/sales?'));
    assert.ok(asked && /itemCode=ITM0001/.test(asked) && /state=FISCALIZED/.test(asked) && /env=PRODUCTION/.test(asked) && /from=2026-10-05/.test(asked), asked);
});

test('POS screen: the report rows carry an Invoices link for the ways of grouping that have a list', () => {
    const p = page();
    const rows = [repRow('ITM0001', 'Lunch'), repRow('ITM0002', 'Tea')];
    const links = html => [...html.matchAll(/data-drill="(\d+)" onclick="posRepDrill\(\1\)"/g)].map(m => Number(m[1]));
    assert.deepStrictEqual(links(p.run(`posAnalysisHtml(${JSON.stringify(repData('item', rows))})`)), [0, 1, 0, 1], 'one in the table and one on the card of each row');
    assert.deepStrictEqual(links(p.run(`posAnalysisHtml(${JSON.stringify(repData('hour', rows))})`)), [], 'the hour has none');
    assert.deepStrictEqual(links(p.run(`posAnalysisHtml(${JSON.stringify(repData('weekday', rows))})`)), []);
    assert.deepStrictEqual(links(p.run(`posTaxHtml(${JSON.stringify(repData('taxRate', [repRow('16.00', '16%'), repRow('5.00', '5%')]))})`)), [0, 1], 'the tax summary has one on each rate');
    // the table has a column for it (its header and its cell in the total row), so the columns line up
    const html = p.run(`posAnalysisHtml(${JSON.stringify(repData('item', rows))})`);
    const head = /<thead[\s\S]*?<\/thead>/.exec(html)[0], foot = /border-t-2[\s\S]*?<\/tr>/.exec(html)[0];
    assert.strictEqual((head.match(/<th[ >]/g) || []).length, (foot.match(/<td[ >]/g) || []).length, 'a cell for every column in the total row');
    assert.strictEqual((head.match(/<th[ >]/g) || []).length, 11, 'ten columns and the link');
    const hourHtml = p.run(`posAnalysisHtml(${JSON.stringify(repData('hour', rows))})`);
    assert.strictEqual((/<thead[\s\S]*?<\/thead>/.exec(hourHtml)[0].match(/<th[ >]/g) || []).length, 10, 'no extra column where there is no link');
});

test('POS screen: the filters that have no box show as chips, text is only text, and each chip can be taken away alone', async () => {
    const p = page();
    p.run(SETUP);
    p.run("POS.sales = posBlankSales({ from: '2026-10-01', to: '2026-10-31', state: 'FISCALIZED', cashier: 'ali@test', customerId: 'cu1', customerName: 'Khan <img src=x onerror=alert(1)>', itemCode: 'ITM1', itemName: 'Lunch', category: 'Food', taxRate: '16', branchId: 'b1', branchName: 'Main', env: 'SANDBOX' })");
    p.run('posRenderSalesChips()');
    const html = p.$('#psCust').innerHTML;
    assert.ok(!html.includes('<img src=x'), 'a name is text');
    const text = decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
    for (const need of ['Customer: Khan <img src=x onerror=alert(1)>', 'Item: Lunch', 'Category: Food', 'Tax rate: 16%', 'Branch: Main', 'Showing: test sales only']) assert.ok(text.includes(need), `says "${need}": ${text}`);
    assert.deepStrictEqual([...html.matchAll(/data-chip="(\w+)"/g)].map(m => m[1]), ['customerId', 'itemCode', 'category', 'taxRate', 'branchId', 'env']);
    // none of them: nothing at all
    p.run('POS.sales = posBlankSales(); posRenderSalesChips()');
    assert.strictEqual(p.$('#psCust').innerHTML, '');
    // the special values are worded
    p.run("POS.sales = posBlankSales({ customerId: 'none', category: '__none', env: 'PRODUCTION' }); posRenderSalesChips()");
    const words = decode(p.$('#psCust').innerHTML.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
    assert.ok(/Customer: No saved customer/.test(words) && /Category: No category/.test(words) && /Showing: real sales only/.test(words), words);
    // taking one away: only that one (and the name that went with it), then the list and its totals are asked for again with what is left
    p.run("POS.sales = posBlankSales({ from: '2026-10-01', to: '2026-10-31', state: 'FISCALIZED', customerId: 'cu1', customerName: 'Khan', itemCode: 'ITM1', itemName: 'Lunch', category: 'Food', env: 'SANDBOX' })");
    p.log.api.length = 0;
    p.run("posSalesDrop('itemCode')"); await sleep(30);
    assert.deepStrictEqual([salesNow(p).itemCode, salesNow(p).itemName, salesNow(p).category, salesNow(p).customerName, salesNow(p).env, salesNow(p).from], ['', '', 'Food', 'Khan', 'SANDBOX', '2026-10-01']);
    const list = p.log.api.find(u => u.startsWith('/api/pos/sales?')), totals = p.log.api.find(u => u.startsWith('/api/pos/report?'));
    assert.ok(list && !/itemCode/.test(list) && /category=Food/.test(list) && /customerId=cu1/.test(list) && /env=SANDBOX/.test(list) && /state=FISCALIZED/.test(list), list);
    assert.ok(totals && !/itemCode/.test(totals) && /category=Food/.test(totals) && !/state=/.test(totals), totals);
    p.run("posSalesDrop('customerId')");
    assert.deepStrictEqual([salesNow(p).customerId, salesNow(p).customerName, salesNow(p).from], ['', '', '2026-10-01'], 'the dates stay when a customer chip goes');
    assert.deepStrictEqual([...p.$('#psCust').innerHTML.matchAll(/data-chip="(\w+)"/g)].map(m => m[1]), ['category', 'env']);
});

test('POS screen: the Sales list asks for its chips, keeps them while the boxes change, and "Today" starts clean', async () => {
    const p = page();
    p.run(SETUP);
    p.run("POS.sales = posBlankSales({ from: '2026-10-01', to: '2026-10-31', itemCode: 'ITM1', itemName: 'Lunch', category: 'Food', taxRate: '16', branchId: 'b1', env: 'SANDBOX', customerId: 'cu1', customerName: 'Khan' })");
    const q = p.run('posSalesQuery().toString()');
    for (const part of ['itemCode=ITM1', 'category=Food', 'taxRate=16', 'branchId=b1', 'env=SANDBOX', 'customerId=cu1']) assert.ok(q.includes(part), part);
    assert.ok(!/itemName|customerName|branchName/.test(q), 'only the filters, not the words for the chips');
    const key = p.run('posSalesTotalsKey()');
    p.run("POS.sales.itemCode = 'ITM2'");
    assert.notStrictEqual(p.run('posSalesTotalsKey()'), key, 'a chip changes what the totals depend on');
    // typing in a box keeps the chips
    p.run("POS.sales.itemCode = 'ITM1'");
    p.$('#psFrom').value = '2026-10-02'; p.$('#psTo').value = '2026-10-30'; p.$('#psState').value = 'FISCALIZED'; p.$('#psQ').value = 'x'; p.$('#psCounter').value = ''; p.$('#psPay').value = ''; p.$('#psType').value = ''; p.$('#psMin').value = ''; p.$('#psMax').value = ''; p.$('#psCashier').value = '';
    p.run('posSalesFilter()'); await sleep(30);
    const kept = salesNow(p);
    assert.deepStrictEqual([kept.itemCode, kept.itemName, kept.category, kept.taxRate, kept.branchId, kept.env, kept.customerId, kept.customerName, kept.from, kept.q], ['ITM1', 'Lunch', 'Food', '16', 'b1', 'SANDBOX', 'cu1', 'Khan', '2026-10-02', 'x']);
    // Today and the other ways in start clean
    p.run('posSalesToday()'); await sleep(30);
    const clean = salesNow(p);
    assert.deepStrictEqual([clean.itemCode, clean.category, clean.taxRate, clean.branchId, clean.env, clean.customerId, clean.state], ['', '', '', '', '', '', '']);
    p.run("posShowState('REJECTED')");
    assert.deepStrictEqual([salesNow(p).state, salesNow(p).from, salesNow(p).env], ['REJECTED', '', '']);
    // the customers page: that customer, every date, and the chip's cross takes the customer away and nothing else
    p.run("posSalesCustomer('cu9', 'Walk-in')");
    assert.deepStrictEqual([salesNow(p).customerId, salesNow(p).customerName, salesNow(p).from, salesNow(p).to], ['cu9', 'Walk-in', '', '']);
});

test('POS screen: a counter that is switched off is shown, not hidden behind "All counters", when a report row points at it', async () => {
    const p = page();
    p.run(SETUP);
    p.run("POS.sales = posBlankSales({ from: '', to: '', counterId: 'gone' }); POS.cashiers = []");
    await p.run('posFillSalesFilters()');
    const html = p.$('#psCounter').innerHTML;
    assert.ok(/<option value="gone" selected>A counter that is switched off<\/option>/.test(html), html);
    p.run("POS.sales = posBlankSales({ from: '', to: '', counterId: 'c1' })");
    await p.run('posFillSalesFilters()');
    assert.ok(!/switched off/.test(p.$('#psCounter').innerHTML), 'a counter that is in use is just itself');
});
