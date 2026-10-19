// Requests that arrive at the same moment: one PNTN or CNIC is one customer, one code or barcode leads to one item, and the automatic
// codes never repeat. (The checks and the writes are taken in turn per business: src/pos/service.js, inTurn.)
const test = require('node:test');
const assert = require('node:assert');
const { createWorld } = require('../test-helpers/posWorld');

const W = createWorld('races');
const run = W.run;
test('races: set up a business', async t => { await W.setup(t); });
test.after(() => W.teardown());

const settle = list => Promise.allSettled(list).then(rs => ({ made: rs.filter(r => r.status === 'fulfilled').map(r => r.value), refused: rs.filter(r => r.status === 'rejected').map(r => r.reason) }));
const eight = fn => Array.from({ length: 8 }, (_, i) => fn(i));
const item = body => W.svc.createItem(W.ctx, { pctCode: '9801.2000', taxRate: 16, unitPrice: 10, ...body });

run('races: eight customers added at once with one PNTN make one customer, and the others are told why', async () => {
    const { made, refused } = await settle(eight(i => W.svc.createCustomer(W.ctx, { name: `Twin ${i}`, pntn: '1234567-8' })));
    assert.strictEqual(made.length, 1);
    assert.strictEqual(refused.length, 7);
    for (const e of refused) { assert.strictEqual(e.status, 409, String(e)); assert.match(e.message, /A customer with this PNTN already exists: Twin \d \(CUS0001\)/); }
    assert.strictEqual(await W.prisma.posCustomer.count({ where: { tenantId: W.tenantId, pntn: '1234567-8' } }), 1);
});

run('races: the same for a CNIC, with a change of CNIC in the middle of the adds', async () => {
    const base = await W.svc.createCustomer(W.ctx, { name: 'Base' });
    const { made } = await settle([
        W.svc.updateCustomer(W.ctx, base.id, { cnic: '3520112345671' }),
        ...Array.from({ length: 5 }, (_, i) => W.svc.createCustomer(W.ctx, { name: `Same CNIC ${i}`, cnic: '35201-1234567-1' })),
    ]);
    assert.strictEqual(made.length, 1, 'one holder of that CNIC');
    assert.strictEqual(await W.prisma.posCustomer.count({ where: { tenantId: W.tenantId, cnic: '3520112345671' } }), 1);
});

run('races: customers added at once with nothing in common each get a code of their own', async () => {
    const { made, refused } = await settle(eight(i => W.svc.createCustomer(W.ctx, { name: `Walk-in ${i}` })));
    assert.strictEqual(refused.length, 0, refused.map(String).join(' | '));
    const codes = made.map(c => c.code);
    assert.strictEqual(new Set(codes).size, 8, codes.join(','));
    assert.ok(codes.every(c => /^CUS\d{4}$/.test(c)));
});

run('races: eight items added at once with one code (in different capitals) make one item', async () => {
    const caps = ['SAMECODE', 'SameCode', 'samecode', 'sAmEcOdE', 'SAMEcode', 'sameCODE', 'Samecode', 'SAMECOde'];
    const { made, refused } = await settle(caps.map((code, i) => item({ name: `Same ${i}`, code })));
    assert.strictEqual(made.length, 1);
    for (const e of refused) { assert.strictEqual(e.status, 409, String(e)); assert.match(e.message, /is already the code or barcode of "Same \d"/); }
    assert.strictEqual(await W.prisma.posItem.count({ where: { tenantId: W.tenantId, code: { in: caps } } }), 1);
});

run('races: one item\'s code and another\'s barcode being the same text, added at once, leaves one of them', async () => {
    const { made } = await settle(eight(i => (i % 2 ? item({ name: `As barcode ${i}`, barcode: 'XYZ100' }) : item({ name: `As code ${i}`, code: 'XYZ100' }))));
    assert.strictEqual(made.length, 1);
    const hits = await W.prisma.posItem.findMany({ where: { tenantId: W.tenantId, OR: [{ code: 'XYZ100' }, { barcode: 'XYZ100' }] } });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual((await W.svc.lookup(W.ctx, 'xyz100')).item.id, hits[0].id, 'and a scan of it finds that one');
});

run('races: items added at once with automatic codes never share one', async () => {
    const { made, refused } = await settle(Array.from({ length: 10 }, (_, i) => item({ name: `Auto ${i}` })));
    assert.strictEqual(refused.length, 0, refused.map(String).join(' | '));
    const codes = made.map(i => i.code);
    assert.strictEqual(new Set(codes).size, 10);
    const numbers = codes.map(c => Number(c.slice(3))).sort((a, b) => a - b);
    assert.strictEqual(numbers[9] - numbers[0], 9, 'in a row, none skipped');
});

run('races: a barcode changed on two items at once ends on one of them', async () => {
    const a = await item({ name: 'Left' }), b = await item({ name: 'Right' });
    const { made, refused } = await settle([W.svc.updateItem(W.ctx, a.id, { barcode: 'RACE-BARCODE' }), W.svc.updateItem(W.ctx, b.id, { barcode: 'race-barcode' })]);
    assert.strictEqual(made.length, 1);
    assert.strictEqual(refused.length, 1);
    assert.strictEqual(refused[0].status, 409);
});

run('races: other businesses do not wait for each other (the lock is per business)', async () => {
    const started = Date.now();
    const { made } = await settle([
        W.svc.createCustomer(W.ctx, { name: 'Mine', pntn: '7654321-0' }),
        W.svc.createCustomer(W.ctxOther, { name: 'Theirs', pntn: '7654321-0' }),
    ]);
    assert.strictEqual(made.length, 2, 'the same PNTN is a customer of each business');
    assert.ok(Date.now() - started < 5000);
});
