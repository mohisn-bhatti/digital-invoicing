const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/pos/calc');
const { buildPayload, reconcile, praDateTime } = require('../src/pos/payload');
const pra = require('../src/pos/pra');
const { createBreaker } = require('../src/pos/breaker');
const { canMove, assertMove, STATES } = require('../src/pos/states');

// A two-item sale: lunch (16%, 5% on card) and a drink (16%), 10% off the lunch
function sale(over = {}) {
    const calc = C.calcSale([
        { quantity: 2, unitPrice: 1500, discount: 300, taxRate: 16 },
        { quantity: 3, unitPrice: 120.5, taxRate: 16 },
    ]);
    const names = [{ itemCode: 'LUNCH', itemName: 'Lunch buffet', pctCode: '98012000' }, { itemCode: 'DRINK', itemName: 'Soft drink', pctCode: '98012000' }];
    return {
        posId: '123456', usin: '000001', dateTime: new Date('2026-10-19T07:30:15Z'), paymentMode: 1, invoiceType: 1,
        buyer: { name: 'Ali Khan', pntn: '', cnic: '', phone: '923001234567' },
        lines: calc.lines.map((l, i) => ({ ...names[i], ...l })), totals: calc.totals, ...over,
    };
}

test('POS payload: the same fields, in the same order, as PRA\'s sample JSON', () => {
    const p = buildPayload(sale());
    assert.deepStrictEqual(Object.keys(p), ['InvoiceNumber', 'POSID', 'USIN', 'DateTime', 'BuyerName', 'BuyerPNTN', 'BuyerCNIC', 'BuyerPhoneNumber',
        'TotalBillAmount', 'TotalQuantity', 'TotalSaleValue', 'TotalTaxCharged', 'Discount', 'FurtherTax', 'PaymentMode', 'RefUSIN', 'InvoiceType', 'Items']);
    assert.deepStrictEqual(Object.keys(p.Items[0]), ['ItemCode', 'ItemName', 'Quantity', 'PCTCode', 'TaxRate', 'SaleValue', 'TotalAmount', 'TaxCharged', 'Discount', 'FurtherTax', 'InvoiceType', 'RefUSIN']);
    assert.strictEqual(p.InvoiceNumber, '');
    assert.strictEqual(p.POSID, 123456);
    assert.strictEqual(typeof p.POSID, 'number');
    assert.strictEqual(p.USIN, '000001');
    assert.strictEqual(p.DateTime, '2026-10-19 12:30:15'); // Pakistan time (UTC+5)
    assert.strictEqual(p.RefUSIN, null);
    assert.strictEqual(p.InvoiceType, 1);
    assert.strictEqual(p.PCTCode, undefined);
    assert.strictEqual(p.Items[0].PCTCode, '98012000');
});

test('POS payload: the figures add up, with the discount treated as PRA\'s manual shows it (SaleValue is after the discount)', () => {
    const p = buildPayload(sale());
    // lunch: 2 × 1500 = 3000 − 300 = 2700, tax 432, total 3132;  drink: 361.50, tax 57.84, total 419.34
    assert.deepStrictEqual(p.Items.map(i => [i.SaleValue, i.Discount, i.TaxCharged, i.TotalAmount]), [[2700, 300, 432, 3132], [361.5, 0, 57.84, 419.34]]);
    assert.strictEqual(p.TotalSaleValue, 3061.5);
    assert.strictEqual(p.TotalTaxCharged, 489.84);
    assert.strictEqual(p.Discount, 300);
    assert.strictEqual(p.TotalBillAmount, 3551.34);
    assert.strictEqual(p.TotalQuantity, 5);
    assert.deepStrictEqual(reconcile(p), []);
});

test('POS payload: the SRS reading (SaleValue before the discount) reconciles too, and the two differ only when there is a discount', () => {
    const s = sale();
    const gross = buildPayload(s, 'GROSS');
    assert.strictEqual(gross.Items[0].SaleValue, 3000);
    assert.strictEqual(gross.Items[0].TotalAmount, 3132);
    assert.strictEqual(gross.TotalSaleValue, 3061.5);
    assert.deepStrictEqual(reconcile(gross, 'GROSS'), []);
    assert.notDeepStrictEqual(reconcile(gross, 'NET'), []); // checked against the wrong reading, it is flagged
    // with no discount the two readings send exactly the same items
    const c = C.calcSale([{ quantity: 1, unitPrice: 100, taxRate: 5 }]);
    const plain = sale({ lines: [{ itemCode: 'A', itemName: 'A', pctCode: '98012000', ...c.lines[0] }], totals: c.totals });
    assert.deepStrictEqual(buildPayload(plain, 'NET').Items, buildPayload(plain, 'GROSS').Items);
});

test('POS payload: a sale that does not add up is caught before anything is sent', () => {
    const p = buildPayload(sale());
    p.TotalBillAmount += 0.01;
    assert.ok(reconcile(p).length >= 1);
    const q = buildPayload(sale());
    q.Items[1].TaxCharged += 1;
    assert.ok(reconcile(q).length >= 1);
    assert.ok(reconcile(buildPayload(sale({ usin: '' }))).some(x => /USIN/.test(x)));
    assert.ok(reconcile({ ...buildPayload(sale({ invoiceType: 3 })), RefUSIN: null }).some(x => /RefUSIN/.test(x)));
});

test('POS payload: a credit note names the invoice it returns', () => {
    const p = buildPayload(sale({ invoiceType: 3, refUsin: '000001', usin: '000002' }));
    assert.strictEqual(p.InvoiceType, 3);
    assert.strictEqual(p.RefUSIN, '000001');
    assert.ok(p.Items.every(i => i.RefUSIN === '000001' && i.InvoiceType === 3));
    assert.deepStrictEqual(reconcile(p), []);
});

test('POS payload: Pakistan time, midnight rollover', () => {
    assert.strictEqual(praDateTime(new Date('2026-12-31T19:00:00Z')), '2027-01-01 00:00:00');
    assert.strictEqual(praDateTime(new Date('2026-06-01T00:00:00Z')), '2026-06-01 05:00:00');
});

test('PRA reply: only Code "100" with an invoice number is a fiscal invoice', () => {
    const ok = pra.classifyResponse(200, '{"InvoiceNumber":"9000052011142444901","Code":"100","Response":"Fiscal Invoice Number generated successfully.","Errors":null}');
    assert.strictEqual(ok.outcome, 'FISCALIZED');
    assert.strictEqual(ok.invoiceNumber, '9000052011142444901');
    // a bare 20-digit number must not be rounded by JSON
    const bare = pra.classifyResponse(200, '{"InvoiceNumber":90000520191112000369,"Response":"Invoice received successfully","Code":"100"}');
    assert.strictEqual(bare.outcome, 'FISCALIZED');
    assert.strictEqual(bare.invoiceNumber, '90000520191112000369');
    // PRA's manual shows the reply as a JSON string inside a JSON string
    const wrapped = pra.classifyResponse(200, JSON.stringify('{"InvoiceNumber":"126983DJCN820607","Code":"100","Response":"ok"}'));
    assert.strictEqual(wrapped.outcome, 'FISCALIZED');
    assert.strictEqual(wrapped.invoiceNumber, '126983DJCN820607');
    assert.strictEqual(pra.classifyResponse(200, { InvoiceNumber: 'X1', Code: 100 }).outcome, 'FISCALIZED'); // numeric code
});

test('PRA reply: an answer that is not success is never treated as success', () => {
    const no = pra.classifyResponse(200, '{"InvoiceNumber":"","Code":"101","Response":"Invalid POS ID","Errors":["POSID not registered"]}');
    assert.strictEqual(no.outcome, 'REJECTED');
    assert.match(no.message, /Invalid POS ID/);
    assert.deepStrictEqual(no.errors, ['POSID not registered']);
    assert.strictEqual(pra.classifyResponse(200, '{"Code":"100","InvoiceNumber":"0"}').outcome, 'UNKNOWN'); // success code, no real number
    assert.strictEqual(pra.classifyResponse(200, '{"Code":"100"}').outcome, 'UNKNOWN');
    assert.strictEqual(pra.classifyResponse(200, 'not json at all').outcome, 'UNKNOWN');
    assert.strictEqual(pra.classifyResponse(200, '').outcome, 'UNKNOWN');
    assert.strictEqual(pra.classifyResponse(401, '').outcome, 'REJECTED'); // a bare 401 is how a token is refused
    assert.strictEqual(pra.classifyResponse(403, '{"Message":"Forbidden"}').outcome, 'REJECTED');
    // a 403 / 407 that is not PRA's JSON came from the proxy or a firewall: PRA never saw the sale
    for (const status of [403, 407]) {
        const blocked = pra.classifyResponse(status, '<html>The requested URL is not allowed</html>');
        assert.strictEqual(blocked.outcome, 'NOT_SENT', String(status));
        assert.strictEqual(blocked.reason, 'BLOCKED');
        assert.match(blocked.message, /whitelisted/);
    }
    assert.strictEqual(pra.classifyResponse(400, '{"Message":"bad"}').outcome, 'REJECTED');
    assert.strictEqual(pra.classifyResponse(503, '').outcome, 'NOT_SENT');
    assert.strictEqual(pra.classifyResponse(500, '').outcome, 'UNKNOWN');
    assert.strictEqual(pra.classifyResponse(502, '').outcome, 'UNKNOWN');
    assert.strictEqual(pra.classifyResponse(504, '').outcome, 'UNKNOWN');
});

test('PRA connection: no connection = not sent; a timeout or broken connection = outcome unknown', () => {
    for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'CERT_HAS_EXPIRED']) {
        assert.strictEqual(pra.classifyError(Object.assign(new Error('x'), { code })).outcome, 'NOT_SENT', code);
    }
    assert.strictEqual(pra.classifyError(Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' })).outcome, 'UNKNOWN');
    assert.strictEqual(pra.classifyError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })).outcome, 'UNKNOWN');
    assert.strictEqual(pra.classifyError(Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' })).outcome, 'UNKNOWN');
    assert.strictEqual(pra.classifyError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).outcome, 'UNKNOWN');
    assert.strictEqual(pra.classifyError(new Error('who knows')).outcome, 'UNKNOWN');
});

test('PRA submit: test mode is the default and sends nothing; MOCK- buyer names rehearse the failures', async () => {
    const was = process.env.PRA_MOCK;
    try {
        delete process.env.PRA_MOCK;
        assert.strictEqual(pra.isMock(), true);
        const never = () => { throw new Error('the network must not be touched in test mode'); };
        const ok = await pra.submit({ env: 'SANDBOX', token: 't', payload: { BuyerName: 'Ali' } }, { post: never });
        assert.strictEqual(ok.outcome, 'FISCALIZED');
        assert.match(ok.invoiceNumber, /^MOCK-\d{14}-\d{6}$/);
        assert.strictEqual(ok.mock, true);
        for (const [name, outcome] of [['mock-reject', 'REJECTED'], ['MOCK-TIMEOUT', 'UNKNOWN'], ['Mock-Offline', 'NOT_SENT']]) {
            const r = await pra.submit({ env: 'SANDBOX', token: 't', payload: { BuyerName: name } }, { post: never });
            assert.strictEqual(r.outcome, outcome, name);
            assert.strictEqual(r.mock, true, `${name}: every answer in test mode is marked as a test`);
        }
    } finally { if (was === undefined) delete process.env.PRA_MOCK; else process.env.PRA_MOCK = was; }
});

test('PRA submit: live mode posts to the right address with the Bearer token and reads the reply', async () => {
    const was = process.env.PRA_MOCK;
    process.env.PRA_MOCK = 'false';
    try {
        const calls = [];
        const post = async (url, body, o) => { calls.push({ url, body, token: o.token, timeout: o.timeout }); return { status: 200, data: '{"InvoiceNumber":"123","Code":"100","Response":"ok"}' }; };
        const r = await pra.submit({ env: 'PRODUCTION', token: 'tok-1234567890abcdef', payload: { USIN: 'u1' } }, { post });
        assert.strictEqual(r.outcome, 'FISCALIZED');
        assert.strictEqual(r.mock, false);
        assert.deepStrictEqual(calls.map(c => [c.url, c.token, c.timeout]), [['https://ims.pral.com.pk/ims/production/api/Live/PostData', 'tok-1234567890abcdef', 8000]]);
        const sb = await pra.submit({ env: 'SANDBOX', token: 'tok-1234567890abcdef', payload: {} }, { post });
        assert.strictEqual(calls[1].url, 'https://ims.pral.com.pk/ims/sandbox/api/Live/PostData');
        assert.strictEqual(sb.outcome, 'FISCALIZED');
        // no token: nothing is sent
        const nt = await pra.submit({ env: 'SANDBOX', token: null, payload: {} }, { post });
        assert.strictEqual(nt.outcome, 'NOT_SENT');
        assert.strictEqual(calls.length, 2);
        // a network error from the HTTP call
        const down = await pra.submit({ env: 'SANDBOX', token: 'tok-1234567890abcdef', payload: {} }, { post: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); } });
        assert.strictEqual(down.outcome, 'NOT_SENT');
        // the hard timeout is configurable within sensible limits
        process.env.POS_PRA_TIMEOUT_MS = '6000';
        assert.strictEqual(pra.timeoutMs(), 6000);
        process.env.POS_PRA_TIMEOUT_MS = '5';
        assert.strictEqual(pra.timeoutMs(), 8000);
    } finally { delete process.env.POS_PRA_TIMEOUT_MS; if (was === undefined) delete process.env.PRA_MOCK; else process.env.PRA_MOCK = was; }
});

test('PRA test mode: MOCK-SLOW is an accepted sale that takes three seconds', () => {
    const r = pra.mockSubmit({ BuyerName: 'mock-slow' });
    assert.strictEqual(r.outcome, 'FISCALIZED');
    assert.strictEqual(r.delayMs, 3000);
    assert.match(r.invoiceNumber, /^MOCK-/);
    assert.strictEqual(pra.mockSubmit({ BuyerName: 'Ali' }).delayMs, undefined);
});

test('PRA receipt QR: PRA\'s verification page with the fiscal number', () => {
    assert.strictEqual(pra.verifyUrl('126983DJCN820607'), 'https://reg.pra.punjab.gov.pk/IMSFiscalReport/SearchPOSInvoice_Report.aspx?PRAInvNo=126983DJCN820607');
});

test('POS circuit breaker: rests after repeated failures, lets one attempt through afterwards', () => {
    let t = 0;
    const b = createBreaker({ threshold: 3, coolDownMs: 30000, now: () => t });
    assert.strictEqual(b.allow('c1'), true);
    b.record('c1', false); b.record('c1', false);
    assert.strictEqual(b.allow('c1'), true);
    b.record('c1', false);
    assert.strictEqual(b.allow('c1'), false);
    assert.deepStrictEqual(b.state('c1'), { open: true, fails: 3, retryInMs: 30000 });
    assert.strictEqual(b.allow('c2'), true); // another counter is unaffected
    t = 29999; assert.strictEqual(b.allow('c1'), false);
    t = 30000; assert.strictEqual(b.allow('c1'), true); // the test attempt
    b.record('c1', false);                                // fails again: rests again at once
    assert.strictEqual(b.allow('c1'), false);
    t = 61000; assert.strictEqual(b.allow('c1'), true);
    b.record('c1', true);                                 // success closes it
    assert.deepStrictEqual(b.state('c1'), { open: false, fails: 0, retryInMs: 0 });
});

test('POS sale states follow the SRS table, plus cancelling a sale that was never delivered', () => {
    assert.deepStrictEqual(STATES, ['DRAFT', 'AWAITING_FISCALIZATION', 'OUTCOME_UNKNOWN', 'FISCALIZED', 'REJECTED', 'CANCELLED']);
    assert.ok(canMove('DRAFT', 'AWAITING_FISCALIZATION'));
    for (const to of ['FISCALIZED', 'OUTCOME_UNKNOWN', 'REJECTED', 'CANCELLED']) assert.ok(canMove('AWAITING_FISCALIZATION', to), to);
    assert.ok(canMove('OUTCOME_UNKNOWN', 'FISCALIZED') && canMove('OUTCOME_UNKNOWN', 'REJECTED'));
    assert.ok(!canMove('OUTCOME_UNKNOWN', 'AWAITING_FISCALIZATION'), 'an unknown outcome is never sent again by itself');
    assert.ok(!canMove('OUTCOME_UNKNOWN', 'CANCELLED'), 'an unknown outcome has to be resolved first');
    assert.ok(canMove('REJECTED', 'AWAITING_FISCALIZATION') && canMove('REJECTED', 'CANCELLED'));
    for (const to of STATES) { assert.ok(!canMove('FISCALIZED', to)); assert.ok(!canMove('CANCELLED', to)); }
    assert.throws(() => assertMove('FISCALIZED', 'CANCELLED'), /cannot become/);
});

test('POS circuit breaker: after the rest exactly one caller is let through; the others wait for its answer', () => {
    let t = 0;
    const b = createBreaker({ threshold: 1, coolDownMs: 15000, probeMs: 10000, now: () => t });
    assert.strictEqual(b.allow('c'), true);
    b.record('c', false);                      // the first failure opens it (as on the server: 1 failure, 15 s rest)
    assert.strictEqual(b.allow('c'), false);
    t = 14999; assert.strictEqual(b.allow('c'), false);
    t = 15000;
    assert.strictEqual(b.state('c').open, false, 'looking does not use up the trial');
    assert.strictEqual(b.allow('c'), true, 'the trial');
    assert.strictEqual(b.allow('c'), false, 'everyone else waits for its answer');
    assert.strictEqual(b.allow('c'), false);
    assert.strictEqual(b.state('c').open, true);
    t = 25000; assert.strictEqual(b.allow('c'), true, 'a trial that never reported back is replaced after probeMs');
    b.record('c', false);                      // the trial failed: the rest starts again
    assert.strictEqual(b.allow('c'), false);
    t = 40000; assert.strictEqual(b.allow('c'), true);
    b.record('c', true);                       // answered: closed for everybody
    assert.deepStrictEqual([b.allow('c'), b.allow('c'), b.state('c').open], [true, true, false]);
});

test('PRA submit: a proxy address that cannot be read means nothing was sent (not "outcome unknown")', async () => {
    const saved = { mock: process.env.PRA_MOCK, pra: process.env.PRA_PROXY_URL, fbr: process.env.FBR_PROXY_URL };
    process.env.PRA_MOCK = 'false'; process.env.PRA_PROXY_URL = '203.0.113.7:3128'; // no http://
    try {
        let called = false;
        const r = await pra.submit({ env: 'SANDBOX', token: 'x'.repeat(24), payload: {} }, { post: async () => { called = true; return { status: 200, data: '' }; } });
        assert.strictEqual(r.outcome, 'NOT_SENT');
        assert.strictEqual(r.reason, 'BAD_PROXY');
        assert.match(r.message, /proxy address/);
        assert.strictEqual(called, false, 'nothing was posted');
    } finally {
        for (const [k, v] of [['PRA_MOCK', saved.mock], ['PRA_PROXY_URL', saved.pra], ['FBR_PROXY_URL', saved.fbr]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
});
