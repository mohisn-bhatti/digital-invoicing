// The whole sale life against a real (local) database, with a stand-in for PRA. It makes its own business and removes it
// afterwards, and it only runs against a database on this computer.
require('dotenv').config({ quiet: true });
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { encrypt, decrypt, mask } = require('../src/crypto');
const praReal = require('../src/pos/pra');
const { createBreaker } = require('../src/pos/breaker');
const { createPosService, PosError } = require('../src/pos/service');
const { PosCalcError } = require('../src/pos/calc');
const { PosValidationError } = require('../src/pos/validate');
const { PosStateError } = require('../src/pos/states');

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '');
const prisma = new PrismaClient();
const W = { ok: false }; // set in the first test: is there a database to use?

// a stand-in for PRA that answers from a queue (the default answer is "accepted")
let fiscalSeq = 0;
const accepted = () => ({ outcome: 'FISCALIZED', httpStatus: 200, code: '100', invoiceNumber: `TEST${++fiscalSeq}00000000${fiscalSeq}`, message: 'ok', errors: [], raw: { Code: '100' }, durationMs: 5, mock: false });
const answer = (outcome, message, extra = {}) => ({ outcome, httpStatus: null, code: null, errors: [], raw: null, durationMs: 5, message, ...extra });
const pra = { mock: false, calls: [], queue: [], delay: 0 };
const praApi = {
    isMock: () => pra.mock, timeoutMs: () => 8000, verifyUrl: praReal.verifyUrl,
    async submit(args) {
        pra.calls.push(args);
        if (pra.delay) await new Promise(r => setTimeout(r, pra.delay));
        const next = pra.queue.shift();
        return next ? (typeof next === 'function' ? next(args) : next) : accepted();
    },
};
let clock = Date.parse('2026-10-19T08:00:00Z');
const now = () => new Date(clock);
const audits = [];
const audit = async (req, e) => { audits.push(`${e.action}: ${e.summary}`); };

let svc, tenantId, otherTenantId, counter, items, ctx, ctxOther;
const mk = tid => ({ tenantId: tid, email: 'cashier@test', req: null });
const sellOne = (over = {}) => svc.createSale(ctx, { counterId: counter.id, paymentMode: 1, buyer: {}, lines: [{ itemId: items.lunch.id, quantity: 2 }], ...over });
// the status the API would answer with (the routes turn the three input-error types into 400)
const statusOf = e => (e instanceof PosError ? e.status : e instanceof PosCalcError || e instanceof PosValidationError || e instanceof PosStateError ? 400 : undefined);
const rejects = async (p, status, re) => { await assert.rejects(p, e => { assert.ok(statusOf(e), String(e)); if (status) assert.strictEqual(statusOf(e), status, e.message); if (re) assert.match(e.message, re); return true; }); };

function run(name, fn) { test(name, async t => { if (!W.ok) return t.skip('no local database'); await fn(t); }); }

test('POS flow: set up a business', async t => {
    if (!local) return t.skip('this test only runs against a database on this computer');
    try { await Promise.race([prisma.$queryRaw`SELECT 1`, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]); } catch { return t.skip('no local database'); }
    if (!process.env.ENCRYPTION_KEY) return t.skip('no ENCRYPTION_KEY');
    W.ok = true;
    const tag = crypto.randomBytes(4).toString('hex');
    tenantId = (await prisma.tenant.create({ data: { companyName: `TEST POS ${tag}`, modules: ['INVOICING', 'POS'] } })).id;
    otherTenantId = (await prisma.tenant.create({ data: { companyName: `TEST POS other ${tag}`, modules: ['POS'] } })).id;
    ctx = mk(tenantId); ctxOther = mk(otherTenantId);
    svc = createPosService({ prisma, audit, encrypt, decrypt, mask, pra: praApi, breaker: createBreaker({ threshold: 1000, now: () => clock }), now }); // the breaker has its own test below
    await svc.saveProfile(ctx, { businessName: 'Test Restaurant', pntn: '1234567-8', address: 'MM Alam Road, Lahore', phone: '042111', receiptFooter: 'Thank you' });
    await svc.createBranch(ctx, { name: 'Main', address: 'MM Alam Road', city: 'Lahore' });
    const branch = (await svc.listBranches(tenantId))[0];
    await svc.createCounter(ctx, { branchId: branch.id, name: 'Till 1', posId: '900001', env: 'SANDBOX', token: 'sandbox-token-1234567890' });
    counter = (await svc.listBranches(tenantId))[0].counters[0];
    items = {
        lunch: await svc.createItem(ctx, { name: 'Lunch buffet', pctCode: '9801.2000', taxRate: 16, taxRateCard: 5, unitPrice: 1500, category: 'Food' }),
        drink: await svc.createItem(ctx, { name: 'Soft drink', pctCode: '98012000', taxRate: 16, unitPrice: 120.5, category: 'Drinks' }),
        hall: await svc.createItem(ctx, { name: 'Hall booking', pctCode: '98013000', taxRate: 5, unitPrice: 0, openPrice: true }),
    };
    assert.strictEqual(items.lunch.code, 'ITM0001');
    assert.strictEqual(items.drink.code, 'ITM0002');
    assert.strictEqual(items.lunch.pctCode, '98012000');
    assert.strictEqual(counter.hasToken, true);
    assert.match(counter.tokenMasked, /^••••7890$/);
    assert.ok(!JSON.stringify(await svc.listBranches(tenantId)).includes('sandbox-token'), 'the token never leaves the server');
});

run('POS flow: a sale goes to PRA and comes back fiscalized, with every record kept', async () => {
    pra.calls.length = 0;
    const r = await sellOne({ buyer: { name: 'Ali Khan', phone: '0300-1234567' }, lines: [{ itemId: items.lunch.id, quantity: 2, discount: 300 }, { itemId: items.drink.id, quantity: 3 }] });
    assert.strictEqual(r.result.outcome, 'FISCALIZED');
    const s = r.sale;
    assert.strictEqual(s.state, 'FISCALIZED');
    assert.strictEqual(s.usin, '000001');
    assert.match(s.fiscalNumber, /^TEST1/);
    assert.deepStrictEqual(s.totals, { quantity: 5, saleValue: 3061.5, discount: 300, tax: 489.84, bill: 3551.34 });
    assert.strictEqual(s.attempts, 1);
    assert.deepStrictEqual(s.events.map(e => [e.from, e.to]), [['DRAFT', 'AWAITING_FISCALIZATION'], ['AWAITING_FISCALIZATION', 'FISCALIZED']]);
    assert.strictEqual(s.tries.length, 1);
    assert.strictEqual(s.tries[0].outcome, 'FISCALIZED');
    assert.ok(s.submittedAt && s.respondedAt && s.fiscalizedAt && s.finalizedAt, 'the times are kept apart');
    // exactly what was sent
    assert.strictEqual(pra.calls.length, 1);
    const sent = pra.calls[0];
    assert.strictEqual(sent.env, 'SANDBOX');
    assert.strictEqual(sent.token, 'sandbox-token-1234567890');
    assert.strictEqual(sent.payload.POSID, 900001);
    assert.strictEqual(sent.payload.USIN, '000001');
    assert.strictEqual(sent.payload.BuyerPhoneNumber, '03001234567');
    assert.strictEqual(sent.payload.TotalBillAmount, 3551.34);
    assert.strictEqual(sent.payload.Items.length, 2);
    // the receipt, and printing it again sends nothing
    const rc = await svc.receipt(ctx, s.id);
    assert.strictEqual(rc.business.pntn, '1234567-8');
    assert.strictEqual(rc.counter.posId, '900001');
    assert.match(rc.sale.verifyUrl, /PRAInvNo=TEST1/);
    assert.strictEqual(rc.sale.lines.length, 2);
    await svc.receipt(ctx, s.id);
    assert.strictEqual(pra.calls.length, 1, 'a reprint never goes to PRA');
    // the next sale gets the next USIN
    assert.strictEqual((await sellOne()).sale.usin, '000002');
});

run('POS flow: card payments use the card rate, mixed use the standard one', async () => {
    const cash = (await sellOne({ paymentMode: 1 })).sale.totals.tax;
    const card = (await sellOne({ paymentMode: 2 })).sale.totals.tax;
    const mixed = (await sellOne({ paymentMode: 5 })).sale.totals.tax;
    assert.strictEqual(cash, 480);  // 2 × 1500 at 16%
    assert.strictEqual(card, 150);  // at 5%
    assert.strictEqual(mixed, 480);
});

run('POS flow: prices come from the item, unless the item is "open price"', async () => {
    const sneaky = await sellOne({ lines: [{ itemId: items.lunch.id, quantity: 1, unitPrice: 1 }] }); // a client-sent price is ignored
    assert.strictEqual(sneaky.sale.totals.saleValue, 1500);
    await rejects(sellOne({ lines: [{ itemId: items.hall.id, quantity: 1 }] }), 400, /Enter the price/);
    const hall = await sellOne({ lines: [{ itemId: items.hall.id, quantity: 1, unitPrice: '25000.50', discountPercent: 10 }] });
    assert.strictEqual(hall.sale.totals.saleValue, 22500.45);
    assert.strictEqual(hall.sale.totals.tax, 1125.02); // 5% of 22,500.45 = 1,125.0225
});

run('POS flow: a sale PRA refuses can be corrected and sent again with the same USIN', async () => {
    clock += 10000;
    pra.queue.push(answer('REJECTED', 'Invalid buyer PNTN', { code: '110', httpStatus: 200 }));
    const r = await sellOne({ buyer: { name: 'Bad Buyer', pntn: '1111111-1' } });
    assert.strictEqual(r.result.outcome, 'REJECTED');
    assert.strictEqual(r.sale.state, 'REJECTED');
    assert.match(r.sale.lastError, /Invalid buyer PNTN/);
    const id = r.sale.id, usin = r.sale.usin;
    await rejects(svc.retry(ctx, id), 429, /Wait a few seconds/); // operator retries are rate limited
    clock += 5000;
    await svc.updateBuyer(ctx, id, { name: 'Good Buyer', pntn: '' });
    const again = await svc.retry(ctx, id);
    assert.strictEqual(again.sale.state, 'FISCALIZED');
    assert.strictEqual(again.sale.usin, usin, 'the same invoice keeps its number');
    assert.strictEqual(again.sale.attempts, 2);
    assert.strictEqual(pra.calls.at(-1).payload.BuyerName, 'Good Buyer');
    assert.strictEqual(pra.calls.at(-1).payload.BuyerPNTN, '');
    assert.deepStrictEqual(again.sale.events.filter(e => e.from !== e.to).map(e => e.to), ['AWAITING_FISCALIZATION', 'REJECTED', 'AWAITING_FISCALIZATION', 'FISCALIZED']);
    assert.ok(again.sale.events.some(e => e.from === 'REJECTED' && e.to === 'REJECTED' && /Buyer details corrected/.test(e.note)), 'the correction is recorded too');
    await rejects(svc.updateBuyer(ctx, id, { name: 'Late' }), 409, /not been fiscalized/);
});

run('POS flow: no connection means nothing was sent, so it can be tried again', async () => {
    clock += 10000;
    pra.queue.push(answer('NOT_SENT', 'Could not connect to PRA', { reason: 'NO_CONNECTION' }));
    const r = await sellOne();
    assert.strictEqual(r.result.outcome, 'NOT_SENT');
    assert.strictEqual(r.sale.state, 'AWAITING_FISCALIZATION');
    assert.match(r.sale.lastError, /Could not connect/);
    clock += 5000;
    const again = await svc.retry(ctx, r.sale.id);
    assert.strictEqual(again.sale.state, 'FISCALIZED');
    // and a sale that was never delivered can be cancelled, with a reason
    clock += 10000;
    pra.queue.push(answer('NOT_SENT', 'Could not connect to PRA', { reason: 'NO_CONNECTION' }));
    const stuck = await sellOne();
    await rejects(svc.cancel(ctx, stuck.sale.id, ''), 400, /why/);
    await svc.cancel(ctx, stuck.sale.id, 'Customer left');
    const gone = await svc.saleDetail(ctx, stuck.sale.id);
    assert.strictEqual(gone.state, 'CANCELLED');
    assert.strictEqual(gone.note, 'Customer left');
    await rejects(svc.retry(ctx, stuck.sale.id), 409);
});

run('POS flow: when PRA\'s answer is lost the sale is never sent again by itself', async () => {
    clock += 10000;
    pra.queue.push(answer('UNKNOWN', 'PRA did not answer in time'));
    const r = await sellOne();
    assert.strictEqual(r.sale.state, 'OUTCOME_UNKNOWN');
    const id = r.sale.id;
    const callsBefore = pra.calls.length;
    clock += 10000;
    await rejects(svc.retry(ctx, id), 409, /never sent again by itself/);
    await rejects(svc.cancel(ctx, id, 'Try to cancel'), 409, /Check PRA/);
    assert.strictEqual(pra.calls.length, callsBefore, 'nothing was sent');
    assert.ok(audits.some(a => a.startsWith('pos.sale.unknown')), 'the people in charge are alerted through the audit log');
    assert.strictEqual((await svc.overview(ctx)).outcomeUnknown >= 1, true);
    // resolving needs a note and a real invoice number
    await rejects(svc.resolve(ctx, id, { result: 'FISCALIZED', fiscalNumber: 'ABC123456', note: 'x' }), 400, /how you checked/);
    await rejects(svc.resolve(ctx, id, { result: 'FISCALIZED', fiscalNumber: '12', note: 'Found in the IMS report' }), 400, /exactly as/);
    await svc.resolve(ctx, id, { result: 'STILL_UNKNOWN', note: 'IRIS is down, will check tomorrow' });
    assert.strictEqual((await svc.saleDetail(ctx, id)).state, 'OUTCOME_UNKNOWN');
    await svc.resolve(ctx, id, { result: 'FISCALIZED', fiscalNumber: '9000052011142444901', note: 'Found in the IMS Fiscal Report on 19 Oct' });
    const d = await svc.saleDetail(ctx, id);
    assert.strictEqual(d.state, 'FISCALIZED');
    assert.strictEqual(d.fiscalNumber, '9000052011142444901');
    assert.strictEqual(d.resolvedBy, 'cashier@test');
    await rejects(svc.resolve(ctx, id, { result: 'NOT_FOUND', note: 'second try here' }), 409, /not waiting/);
    // a second sale cannot take the same PRA number
    clock += 10000;
    pra.queue.push(answer('UNKNOWN', 'PRA did not answer in time'));
    const r2 = await sellOne();
    await rejects(svc.resolve(ctx, r2.sale.id, { result: 'FISCALIZED', fiscalNumber: '9000052011142444901', note: 'Found in the report' }), 409, /another sale/);
    // "not found at PRA" opens the way to send again or cancel
    await svc.resolve(ctx, r2.sale.id, { result: 'NOT_FOUND', note: 'Searched the IMS Fiscal Report: not there' });
    assert.strictEqual((await svc.saleDetail(ctx, r2.sale.id)).state, 'REJECTED');
    clock += 5000;
    assert.strictEqual((await svc.retry(ctx, r2.sale.id)).sale.state, 'FISCALIZED');
});

run('POS flow: a double click or two screens cannot send one sale twice', async () => {
    clock += 10000;
    pra.queue.push(answer('NOT_SENT', 'Could not connect to PRA', { reason: 'NO_CONNECTION' }));
    const r = await sellOne();
    clock += 10000;
    pra.calls.length = 0;
    pra.delay = 80;
    const two = await Promise.allSettled([svc.retry(ctx, r.sale.id), svc.retry(ctx, r.sale.id)]);
    pra.delay = 0;
    assert.strictEqual(pra.calls.length, 1, 'only one request went to PRA');
    assert.deepStrictEqual(two.map(x => x.status).sort(), ['fulfilled', 'rejected']);
    const lost = two.find(x => x.status === 'rejected').reason;
    assert.strictEqual(statusOf(lost), 409, String(lost));
    assert.strictEqual((await svc.saleDetail(ctx, r.sale.id)).state, 'FISCALIZED');
});

run('POS flow: a send that was interrupted becomes "outcome unknown"', async () => {
    clock += 10000;
    pra.queue.push(answer('NOT_SENT', 'Could not connect to PRA', { reason: 'NO_CONNECTION' }));
    const r = await sellOne();
    // as if the server died while waiting for PRA: submitted, never answered
    await prisma.posSale.update({ where: { id: r.sale.id }, data: { submittedAt: new Date(clock - 120000), respondedAt: null, attempts: 1 } });
    await rejects(svc.cancel(ctx, r.sale.id, 'Cancel it please'), 409, /Check PRA|being sent/);
    const d = await svc.saleDetail(ctx, r.sale.id);
    assert.strictEqual(d.state, 'OUTCOME_UNKNOWN');
    assert.match(d.lastError, /server stopped/);
    // one that was submitted a moment ago is simply "being sent"
    clock += 10000;
    pra.queue.push(answer('NOT_SENT', 'Could not connect to PRA', { reason: 'NO_CONNECTION' }));
    const r2 = await sellOne();
    await prisma.posSale.update({ where: { id: r2.sale.id }, data: { submittedAt: new Date(clock - 1000), respondedAt: null, attempts: 1 } });
    await rejects(svc.retry(ctx, r2.sale.id), 409, /being sent right now/);
    await prisma.posSale.update({ where: { id: r2.sale.id }, data: { respondedAt: new Date(clock) } }); // leave it tidy
});

run('POS flow: a credit note returns part of a sale and the notes add up to the sale', async () => {
    clock += 10000;
    const sold = (await sellOne({ lines: [{ itemId: items.lunch.id, quantity: 3, discount: 100 }, { itemId: items.drink.id, quantity: 2 }] })).sale;
    const [l1, l2] = sold.lines;
    await rejects(svc.creditNote(ctx, sold.id, { lines: [{ lineId: l1.id, quantity: 4 }], reason: 'Too many' }), 400, /more than was sold/);
    await rejects(svc.creditNote(ctx, sold.id, { lines: [], reason: 'Nothing' }), 400, /Choose what/);
    await rejects(svc.creditNote(ctx, sold.id, { lines: [{ lineId: l1.id, quantity: 1 }], reason: '' }), 400, /reason/);
    clock += 10000;
    const c1 = await svc.creditNote(ctx, sold.id, { lines: [{ lineId: l1.id, quantity: 1 }], reason: 'Customer returned one' });
    assert.strictEqual(c1.sale.state, 'FISCALIZED');
    assert.strictEqual(c1.sale.invoiceType, 3);
    assert.strictEqual(c1.sale.refUsin, sold.usin);
    assert.strictEqual(pra.calls.at(-1).payload.InvoiceType, 3);
    assert.strictEqual(pra.calls.at(-1).payload.RefUSIN, sold.usin);
    assert.ok(c1.sale.totals.bill > 0);
    clock += 10000;
    const c2 = await svc.creditNote(ctx, sold.id, { lines: [{ lineId: l1.id, quantity: 2 }, { lineId: l2.id, quantity: 2 }], reason: 'Everything else' });
    const detail = await svc.saleDetail(ctx, sold.id);
    assert.deepStrictEqual(detail.lines.map(l => l.returned.quantity), [3, 2]);
    const sumBill = Math.round((c1.sale.totals.bill + c2.sale.totals.bill) * 100) / 100;
    assert.strictEqual(sumBill, sold.totals.bill, 'the credit notes add up to the sale to the paisa');
    assert.strictEqual(detail.creditNotes.length, 2);
    await rejects(svc.creditNote(ctx, sold.id, { lines: [{ lineId: l1.id, quantity: 1 }], reason: 'Again' }), 400, /more than was sold/);
    // a credit note itself cannot be returned, and a sale that is not fiscalized cannot be credited
    await rejects(svc.creditNote(ctx, c1.sale.id, { lines: [{ lineId: c1.sale.lines[0].id, quantity: 1 }], reason: 'Nope' }), 409, /Only a fiscalized sale/);
});

run('POS flow: a credit note PRA has not accepted does not use up the returnable quantity', async () => {
    clock += 10000;
    const sold = (await sellOne({ lines: [{ itemId: items.lunch.id, quantity: 1 }] })).sale;
    clock += 10000;
    pra.queue.push(answer('REJECTED', 'RefUSIN not found', { code: '120' }));
    const bad = await svc.creditNote(ctx, sold.id, { lines: [{ lineId: sold.lines[0].id, quantity: 1 }], reason: 'Return' });
    assert.strictEqual(bad.sale.state, 'REJECTED');
    await svc.cancel(ctx, bad.sale.id, 'PRA refused it, will redo');
    clock += 10000;
    const good = await svc.creditNote(ctx, sold.id, { lines: [{ lineId: sold.lines[0].id, quantity: 1 }], reason: 'Return, second try' });
    assert.strictEqual(good.sale.state, 'FISCALIZED');
});

run('POS flow: a connection that keeps failing is given a rest', async () => {
    const own = createPosService({ prisma, audit, encrypt, decrypt, mask, pra: praApi, breaker: createBreaker({ threshold: 3, coolDownMs: 30000, now: () => clock }), now });
    const sell = () => own.createSale(ctx, { counterId: counter.id, paymentMode: 1, buyer: {}, lines: [{ itemId: items.drink.id, quantity: 1 }] });
    pra.calls.length = 0;
    for (let i = 0; i < 3; i++) { clock += 10000; pra.queue.push(answer('NOT_SENT', 'Could not connect to PRA', { reason: 'NO_CONNECTION' })); assert.strictEqual((await sell()).result.outcome, 'NOT_SENT'); }
    assert.strictEqual(pra.calls.length, 3);
    clock += 1000;
    const blocked = await sell();
    assert.strictEqual(blocked.result.reason, 'BREAKER_OPEN');
    assert.match(blocked.result.message, /rest/);
    assert.strictEqual(pra.calls.length, 3, 'nothing was sent while resting');
    assert.strictEqual((await own.cashierSetup(ctx)).counters[0].breaker.open, true);
    clock += 31000;
    assert.strictEqual((await sell()).result.outcome, 'FISCALIZED'); // the test attempt gets through and closes it
});

run('POS flow: production counters are held to the rules', async () => {
    const branch = (await svc.listBranches(tenantId))[0];
    await svc.createCounter(ctx, { branchId: branch.id, name: 'Live till', posId: '900002', env: 'PRODUCTION', token: 'production-token-1234567890' });
    const live = (await svc.listBranches(tenantId))[0].counters.find(c => c.name === 'Live till');
    const sellLive = () => svc.createSale(ctx, { counterId: live.id, paymentMode: 1, buyer: {}, lines: [{ itemId: items.drink.id, quantity: 1 }] });
    pra.mock = true;
    await rejects(sellLive(), 400, /test mode/); // fake fiscal numbers must never reach a production receipt
    pra.mock = false;
    await svc.saveProfile(ctx, { businessName: 'Test Restaurant', pntn: '', address: '', phone: '', receiptFooter: '' });
    await rejects(sellLive(), 400, /Add the business name, address and PNTN/);
    await svc.saveProfile(ctx, { businessName: 'Test Restaurant', pntn: '1234567-8', address: 'MM Alam Road, Lahore', phone: '', receiptFooter: '' });
    clock += 10000;
    const ok = await sellLive();
    assert.strictEqual(ok.sale.env, 'PRODUCTION');
    assert.strictEqual(pra.calls.at(-1).env, 'PRODUCTION');
    assert.strictEqual(pra.calls.at(-1).token, 'production-token-1234567890');
    // a counter with pending sales cannot change its POS ID
    pra.queue.push(answer('NOT_SENT', 'Could not connect to PRA', { reason: 'NO_CONNECTION' }));
    clock += 10000;
    await sellLive();
    await rejects(svc.updateCounter(ctx, live.id, { posId: '900003' }), 409, /waiting for PRA/);
    // rotating the token: used from the next send; the old token is gone
    await svc.setToken(ctx, live.id, 'production-token-rotated-9999');
    assert.ok(audits.some(a => /PRA token replaced/.test(a)));
    assert.ok(!audits.some(a => /rotated-9999|1234567890/.test(a)), 'a token is never written to the log');
    // decommissioning removes the token, switches the counter off, and says how many sales still wait
    const gone = await svc.decommission(ctx, live.id);
    assert.strictEqual(gone.pending, 1);
    const after = (await svc.listBranches(tenantId))[0].counters.find(c => c.name === 'Live till');
    assert.deepStrictEqual([after.hasToken, after.active], [false, false]);
    await rejects(sellLive(), 400, /switched off/);
});

run('POS flow: one business cannot see or change another\'s sales, items or counters', async () => {
    const s = (await sellOne()).sale;
    await rejects(svc.saleDetail(ctxOther, s.id), 404);
    await rejects(svc.receipt(ctxOther, s.id), 404);
    await rejects(svc.cancel(ctxOther, s.id, 'not mine'), 404);
    await rejects(svc.creditNote(ctxOther, s.id, { lines: [{ lineId: s.lines[0].id, quantity: 1 }], reason: 'not mine' }), 404);
    await rejects(svc.updateItem(ctxOther, items.lunch.id, { name: 'hijacked', pctCode: '98012000', taxRate: 0 }), 404);
    await rejects(svc.setToken(ctxOther, counter.id, 'another-business-token-1234'), 404);
    await rejects(svc.createSale(ctxOther, { counterId: counter.id, paymentMode: 1, lines: [{ itemId: items.lunch.id, quantity: 1 }] }), 400, /Choose the counter/);
    assert.deepStrictEqual((await svc.listSales(ctxOther)).sales, []);
    assert.strictEqual((await svc.listItems(otherTenantId)).length, 0);
    assert.strictEqual((await svc.overview(ctxOther)).todaySales.count, 0);
});

run('POS flow: items keep their code, reject duplicates, and the PCT search finds the service headings', async () => {
    await rejects(svc.createItem(ctx, { code: 'ITM0001', name: 'Another', pctCode: '98012000', taxRate: 16 }), 409, /item code/);
    const u = await svc.updateItem(ctx, items.drink.id, { name: 'Cola', pctCode: '98012000', taxRate: 16, unitPrice: 130, code: 'CHANGED' });
    assert.strictEqual(u.code, 'ITM0002', 'the code is on past sales and never changes');
    assert.strictEqual(u.unitPrice, 130);
    const sold = await sellOne({ lines: [{ itemId: items.drink.id, quantity: 1 }] });
    assert.strictEqual(sold.sale.lines[0].itemName, 'Cola');
    await svc.updateItem(ctx, items.drink.id, { name: 'Cola', pctCode: '98012000', taxRate: 16, unitPrice: 130, active: false });
    await rejects(sellOne({ lines: [{ itemId: items.drink.id, quantity: 1 }] }), 400, /no longer available/);
    assert.strictEqual((await svc.listItems(tenantId, { activeOnly: true })).some(i => i.id === items.drink.id), false);
    const found = await svc.searchPct('restaurants');
    assert.ok(found.some(r => r.code === '9801.2000' && r.pctCode === '98012000'), JSON.stringify(found.slice(0, 3)));
    assert.ok((await svc.searchPct('9801')).every(r => r.pctCode.startsWith('9801')));
    assert.deepStrictEqual(await svc.searchPct('x'), []);
});

run('POS flow: the sales list filters, and the overview counts what needs attention', async () => {
    const all = await svc.listSales(ctx, {});
    assert.ok(all.total >= 10);
    const unk = await svc.listSales(ctx, { state: 'OUTCOME_UNKNOWN' });
    assert.ok(unk.sales.every(s => s.state === 'OUTCOME_UNKNOWN'));
    const byNo = await svc.listSales(ctx, { q: '000001' });
    assert.ok(byNo.sales.some(s => s.usin === '000001'), 'a search finds a sale by its invoice number');
    assert.strictEqual((await svc.listSales(ctx, { q: 'no-such-buyer-anywhere' })).total, 0);
    assert.ok(all.sales.every(s => s.counterName));
    const o = await svc.overview(ctx);
    assert.strictEqual(o.testMode, false);
    assert.ok(o.todaySales.count >= 0 && Array.isArray(o.counters));
    assert.strictEqual(o.profileComplete, true);
    const setup = await svc.cashierSetup(ctx);
    assert.ok(setup.counters.every(c => c.hasToken !== undefined) && setup.items.length >= 2);
    assert.ok(!JSON.stringify(setup).includes('production-token'));
});

run('POS flow: the audit trail records the administrative actions and never a token', async () => {
    for (const re of [/pos\.profile\.update/, /pos\.branch\.create/, /pos\.counter\.create/, /pos\.counter\.token/, /pos\.counter\.decommission/, /pos\.item\.create/, /pos\.item\.update/, /pos\.sale\.cancel/, /pos\.sale\.resolve/, /pos\.sale\.credit/]) {
        assert.ok(audits.some(a => re.test(a)), `no audit entry for ${re}`);
    }
    assert.ok(!audits.some(a => /sandbox-token|production-token/.test(a)));
});

test.after(async () => {
    if (W.ok) {
        for (const id of [tenantId, otherTenantId].filter(Boolean)) {
            await prisma.posSale.deleteMany({ where: { tenantId: id } }); // lines, events and attempts go with them
            await prisma.posCounter.deleteMany({ where: { tenantId: id } });
            await prisma.posBranch.deleteMany({ where: { tenantId: id } });
            await prisma.posItem.deleteMany({ where: { tenantId: id } });
            await prisma.posProfile.deleteMany({ where: { tenantId: id } });
            await prisma.tenant.delete({ where: { id } });
        }
    }
    await prisma.$disconnect();
});
