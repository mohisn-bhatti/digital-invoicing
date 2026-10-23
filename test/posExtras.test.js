// Tax-inclusive prices, debit notes, the receipt logo, the record-keeping rule and the register of hand-written slips, through the real server.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');

const A = createApi('extras');
const run = A.run;
test('extras: start a server and a business', { timeout: 90000 }, async t => { await A.setup(t); });
test.after(() => A.teardown());

const T = who => ({ token: A[who].token });
const post = (url, body, who = 'manager') => A.call(url, { ...T(who), method: 'POST', body });
const put = (url, body, who = 'owner') => A.call(url, { ...T(who), method: 'PUT', body });
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());

run('extras: a business with a counter and two items, one of them priced with the tax inside', async () => {
    const branch = (await post('/api/pos/branches', { name: 'Main' }, 'owner')).json[0];
    A.counter = (await post('/api/pos/counters', { branchId: branch.id, name: 'Till 1', posId: '940001', env: 'SANDBOX' }, 'owner')).json[0].counters[0];
    const mk = async body => { const r = await post('/api/pos/items', { pctCode: '9801.2000', taxRate: 16, ...body }); assert.strictEqual(r.status, 200, r.text); return r.json; };
    A.plain = await mk({ name: 'Chai (tax extra)', unitPrice: 1000 });
    A.shelf = await mk({ name: 'Shelf price item', unitPrice: 1000, taxInclusive: true });
    assert.strictEqual(A.shelf.taxInclusive, true);
    assert.strictEqual(A.plain.taxInclusive, false);
});

run('extras: a price that contains the tax is paid as written, and the tax is taken out of it', async () => {
    const sell = lines => post('/api/pos/sales', { counterId: A.counter.id, paymentMode: 1, lines }, 'cashier');
    const a = await sell([{ itemId: A.plain.id, quantity: 1 }]);
    assert.strictEqual(a.json.sale.totals.bill, 1160, 'tax added on top');
    const b = await sell([{ itemId: A.shelf.id, quantity: 1 }]);
    assert.strictEqual(b.status, 200, b.text);
    const t = b.json.sale.totals;
    assert.deepStrictEqual([t.bill, t.saleValue, t.tax], [1000, 862.07, 137.93], 'the customer pays 1,000: 862.07 of it is the sale, 137.93 the tax');
    assert.strictEqual(b.json.sale.lines[0].taxInclusive, true);
    // what PRA is sent adds up: value + tax = total
    const p = b.json.sale.payload;
    assert.strictEqual(p.TotalBillAmount, 1000);
    assert.strictEqual(p.Items[0].SaleValue + p.Items[0].TaxCharged, p.Items[0].TotalAmount);
    // a discount is taken from what the customer pays, and PRA is told the discount without its tax
    const d = await sell([{ itemId: A.shelf.id, quantity: 3, discount: '99.99' }]);
    assert.strictEqual(d.json.sale.totals.bill, 2900.01);
    assert.strictEqual(d.json.sale.totals.saleValue + d.json.sale.totals.tax, 2900.01);
    // a return of part of an inclusive sale still adds up to the sale
    const credit = await post(`/api/pos/sales/${b.json.sale.id}/credit-note`, { reason: 'half back', lines: [{ lineId: b.json.sale.lines[0].id, quantity: 1 }] });
    assert.strictEqual(credit.status, 200, credit.text);
    assert.deepStrictEqual([credit.json.sale.totals.bill, credit.json.sale.totals.saleValue, credit.json.sale.totals.tax], [1000, 862.07, 137.93]);
    A.sold = b.json.sale;
    A.soldPlain = a.json.sale;
    // the flag can be switched off again and the change is in the trail
    const off = await put(`/api/pos/items/${A.shelf.id}`, { taxInclusive: false }, 'manager');
    assert.strictEqual(off.json.taxInclusive, false);
    const log = await A.prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: 'pos.item.update' } });
    assert.ok(log.some(x => /taxInclusive: true → false/.test(x.summary)));
    await put(`/api/pos/items/${A.shelf.id}`, { taxInclusive: true }, 'manager');
});

run('extras: a debit note adds to a fiscalized sale, is a sale in the figures, and is not a return', async () => {
    const line = A.soldPlain.lines[0];
    assert.strictEqual((await post(`/api/pos/sales/${A.soldPlain.id}/debit-note`, { reason: '', lines: [{ lineId: line.id, quantity: 1 }] })).status, 400, 'a reason is needed');
    assert.strictEqual((await post(`/api/pos/sales/${A.soldPlain.id}/debit-note`, { reason: 'extra', lines: [] })).status, 400);
    assert.strictEqual((await post(`/api/pos/sales/${A.soldPlain.id}/debit-note`, { reason: 'extra', lines: [{ lineId: 'nope', quantity: 1 }] })).status, 400);
    assert.strictEqual((await post(`/api/pos/sales/${A.soldPlain.id}/debit-note`, { reason: 'extra', lines: [{ lineId: line.id, quantity: 1 }, { lineId: line.id, quantity: 1 }] })).status, 400, 'listed twice');
    assert.strictEqual((await post(`/api/pos/sales/${A.soldPlain.id}/debit-note`, { reason: 'extra', lines: [{ lineId: line.id, quantity: 1 }] }, 'cashier')).status, 403, 'a manager does this');
    // 2 more at a raised price of 1,500: 3,000 + 16%
    const r = await post(`/api/pos/sales/${A.soldPlain.id}/debit-note`, { reason: 'price raised after the sale', lines: [{ lineId: line.id, quantity: 2, unitPrice: '1500' }] });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.result.outcome, 'FISCALIZED');
    const d = r.json.sale;
    assert.strictEqual(d.invoiceType, 2);
    assert.strictEqual(d.refUsin, A.soldPlain.usin);
    assert.deepStrictEqual([d.totals.saleValue, d.totals.tax, d.totals.bill], [3000, 480, 3480]);
    assert.strictEqual(d.payload.InvoiceType, 2);
    assert.strictEqual(d.payload.RefUSIN, A.soldPlain.usin);
    assert.ok(d.payload.Items.every(i => i.InvoiceType === 2 && i.RefUSIN === A.soldPlain.usin));
    // the sale lists it as a debit note, and it did not use up any of what can be returned
    const sale = (await A.call(`/api/pos/sales/${A.soldPlain.id}`, T('manager'))).json;
    assert.deepStrictEqual(sale.debitNotes.map(x => x.usin), [d.usin]);
    assert.deepStrictEqual(sale.creditNotes, []);
    assert.strictEqual(sale.lines[0].returned, 0, 'a debit note is not a return');
    const back = await post(`/api/pos/sales/${A.soldPlain.id}/credit-note`, { reason: 'all back', lines: [{ lineId: line.id, quantity: 1 }] });
    assert.strictEqual(back.status, 200, 'the whole quantity can still be returned');
    // a debit note is not itself a thing to debit or return
    assert.strictEqual((await post(`/api/pos/sales/${d.id}/debit-note`, { reason: 'x', lines: [{ lineId: d.lines[0].id, quantity: 1 }] })).status, 409);
    assert.strictEqual((await post(`/api/pos/sales/${d.id}/credit-note`, { reason: 'x', lines: [{ lineId: d.lines[0].id, quantity: 1 }] })).status, 409);
    // the report counts it with the sales
    const rep = await A.call(`/api/pos/reports/by/day?from=${today}&to=${today}`, T('manager'));
    const day = rep.json.rows.find(x => x.key === today);
    assert.ok(day.sales >= 4, 'the debit note is among the sales');
    assert.ok(day.bill >= 3480 + 1160 + 1000, 'and its money is in the day\'s total');
    A.debit = d;
});

run('extras: a debit note on a tax-inclusive line is worked out the same way', async () => {
    const line = A.sold.lines[0];
    const r = await post(`/api/pos/sales/${A.sold.id}/debit-note`, { reason: 'one more', lines: [{ lineId: line.id, quantity: 1 }] });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.sale.totals.bill, r.json.sale.totals.saleValue, r.json.sale.totals.tax], [1000, 862.07, 137.93]);
});

const png = (w = 4, h = 4) => {
    const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
    return 'data:image/png;base64,' + b.toString('base64');
};

run('extras: the logo is checked as a picture, kept, put on the receipt, and can be taken away', async () => {
    assert.strictEqual((await put('/api/pos/logo', { logo: png() }, 'manager')).status, 403, 'only the owner');
    for (const bad of ['', 'hello', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/png;base64,AAAA', 'data:text/html;base64,PGI+', png(5000, 10), png(0, 10), 'data:image/jpeg;base64,' + Buffer.from('not a jpeg at all').toString('base64')]) {
        const r = await put('/api/pos/logo', { logo: bad });
        assert.strictEqual(r.status, 400, String(bad).slice(0, 40) + r.text);
        assert.ok(r.json.error);
    }
    const big = 'data:image/png;base64,' + Buffer.concat([Buffer.from(png().split(',')[1], 'base64'), Buffer.alloc(200 * 1024)]).toString('base64');
    assert.match((await put('/api/pos/logo', { logo: big })).json.error, /too big/);
    const ok = await put('/api/pos/logo', { logo: png(300, 120) });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual((await A.call('/api/pos/logo', T('cashier'))).json.logo, png(300, 120), 'the till can read it');
    assert.strictEqual((await A.call('/api/pos/settings', T('cashier'))).json.hasLogo, true);
    assert.ok(!JSON.stringify((await A.call('/api/pos/settings', T('cashier'))).json).includes('base64'), 'the settings every cashier reads do not carry the picture');
    const rc = await A.call(`/api/pos/sales/${A.sold.id}/receipt`, T('cashier'));
    assert.strictEqual(rc.json.business.logo, png(300, 120));
    assert.strictEqual((await A.call('/api/pos/logo', { method: 'DELETE', ...T('manager') })).status, 403);
    const gone = await A.call('/api/pos/logo', { method: 'DELETE', ...T('owner') });
    assert.strictEqual(gone.json.logo, '');
    assert.strictEqual((await A.call(`/api/pos/sales/${A.sold.id}/receipt`, T('cashier'))).json.business.logo, '');
    const log = await A.prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: { startsWith: 'pos.logo' } } });
    assert.ok(log.length >= 2 && !log.some(x => x.summary.includes('base64')), 'the trail says it was done, never carries the picture');
});

run('extras: the record-keeping rule says where the records stand, and nothing can be deleted', async () => {
    const r = await A.call('/api/pos/retention', T('owner'));
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.years, 6);
    assert.ok(r.json.sales >= 5 && r.json.salesOlder === 0);
    assert.match(r.json.rule, /never deleted/);
    assert.strictEqual((await A.call('/api/pos/retention', T('manager'))).status, 403);
    const s = await put('/api/pos/settings', { retentionYears: 10 });
    assert.strictEqual(s.json.retentionYears, 10);
    assert.strictEqual((await A.call('/api/pos/retention', T('owner'))).json.years, 10);
    for (const bad of [0, 31, 'six', 2.5, -1]) assert.strictEqual((await put('/api/pos/settings', { retentionYears: bad })).status, 400, String(bad));
    // no way to delete a sale, a voucher, a bill or a slip through the API
    for (const url of [`/api/pos/sales/${A.sold.id}`, `/api/pos/manual/x`, `/api/pos/purchases/x`, `/api/pos/cash/x`, `/api/pos/vendors/x`, `/api/pos/customers/x`]) {
        const d = await A.call(url, { method: 'DELETE', ...T('owner') });
        assert.ok([404, 405].includes(d.status), `${url} answered ${d.status}`);
    }
});

const when = '2026-10-20T14:30';
const slip = (over = {}) => ({ bookNumber: 'B-001', writtenAt: when, description: 'Lunch for 4', saleValue: '5000', tax: '800', paymentMode: 1, buyer: { name: 'Walk-in' }, ...over });

run('extras: a hand-written slip is recorded, is not a fiscal invoice, and is tracked until reported', async () => {
    const r = await post('/api/pos/manual', slip(), 'cashier');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.status, r.json.total, r.json.reason], ['OPEN', 5800, 'PRA could not be reached']);
    assert.strictEqual(r.json.writtenAt, '2026-10-20T09:30:00.000Z', 'typed as Pakistan time');
    assert.strictEqual((await post('/api/pos/manual', slip(), 'cashier')).status, 409, 'one number once');
    const bad = async (over, re) => { const x = await post('/api/pos/manual', slip({ bookNumber: 'Z' + Math.random(), ...over }), 'cashier'); assert.strictEqual(x.status, 400, JSON.stringify(over) + x.text); assert.match(x.json.error, re); };
    await bad({ bookNumber: '' }, /number on the paper slip/);
    await bad({ description: '' }, /what was sold/i);
    await bad({ saleValue: '0' }, /more than zero/);
    await bad({ saleValue: 'abc' }, /number/);
    await bad({ tax: '9999' }, /cannot be more than the amount/);
    await bad({ writtenAt: '2999-01-01T10:00' }, /future/);
    await bad({ writtenAt: 'yesterday' }, /date and time/);
    await bad({ writtenAt: '2020-01-01T10:00' }, /400 days/);
    await bad({ buyer: { name: 'X', cnic: '123' } }, /CNIC/);
    // not in PRA's world: no sale was made, nothing was sent, and the sales reports do not include it
    const sales = (await A.call('/api/pos/sales?from=&to=', T('manager'))).json;
    assert.ok(!sales.sales.some(s => s.buyerName === 'Walk-in'), 'it is not in the sales list');
    const list = await A.call('/api/pos/manual?status=OPEN', T('cashier'));
    assert.strictEqual(list.json.open.count, 1);
    assert.strictEqual(list.json.open.total, 5800);
    A.slip = r.json;
});

run('extras: reporting and voiding a slip need a manager, a note and leave a record', async () => {
    assert.strictEqual((await post(`/api/pos/manual/${A.slip.id}/report`, { note: 'told PRA' }, 'cashier')).status, 403);
    assert.strictEqual((await post(`/api/pos/manual/${A.slip.id}/report`, { note: '' })).status, 400);
    const done = await post(`/api/pos/manual/${A.slip.id}/report`, { note: 'Reported to PRA helpline, ref 8841' });
    assert.strictEqual(done.status, 200, done.text);
    assert.deepStrictEqual([done.json.status, done.json.reportedBy], ['REPORTED', A.manager.email]);
    assert.strictEqual((await post(`/api/pos/manual/${A.slip.id}/report`, { note: 'again' })).status, 409);
    assert.strictEqual((await A.call('/api/pos/manual?status=OPEN', T('cashier'))).json.open.count, 0);
    const second = (await post('/api/pos/manual', slip({ bookNumber: 'B-002' }), 'cashier')).json;
    assert.strictEqual((await post(`/api/pos/manual/${second.id}/void`, { reason: '' })).status, 400);
    const v = await post(`/api/pos/manual/${second.id}/void`, { reason: 'written twice by mistake' });
    assert.strictEqual(v.json.status, 'VOID');
    assert.strictEqual((await post(`/api/pos/manual/${second.id}/void`, { reason: 'again' })).status, 409);
    assert.strictEqual((await post(`/api/pos/manual/${second.id}/report`, { note: 'too late' })).status, 409, 'a voided slip cannot be reported');
    assert.strictEqual((await A.call('/api/pos/manual?status=VOID', T('cashier'))).json.invoices.length, 1);
    const log = await A.prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: { startsWith: 'pos.manual' } } });
    assert.ok(log.some(x => /marked as reported: Reported to PRA helpline/.test(x.summary)));
    // another business sees none of it
    const t = await A.prisma.tenant.create({ data: { companyName: `TEST extras other ${A.tag}`, modules: ['POS'] } });
    A.tenants.push(t.id);
    const email = `extras-other-${A.tag}@example.com`;
    await A.prisma.user.create({ data: { email, password: A.hash, role: 'CLIENT_USER', tenantRole: 'OWNER', tenantId: t.id } });
    const token = await A.login(email, A.password);
    assert.strictEqual((await A.call('/api/pos/manual', { token })).json.total, 0);
    assert.strictEqual((await A.call(`/api/pos/manual/${A.slip.id}/void`, { token, method: 'POST', body: { reason: 'not mine' } })).status, 404);
    assert.strictEqual((await A.call(`/api/pos/sales/${A.sold.id}/debit-note`, { token, method: 'POST', body: { reason: 'not mine', lines: [] } })).status, 404);
});
