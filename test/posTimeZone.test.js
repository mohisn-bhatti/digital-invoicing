// A Pakistan day is the same day to the list and to the reports, whatever time zone the database session is set to. (createdAt is a
// timestamp without a zone that holds UTC; the reports' SQL used to bind the day's bounds as timestamps WITH a zone.)
const test = require('node:test');
const assert = require('node:assert');
const { Prisma } = require('@prisma/client');
const R = require('../src/pos/reports');
const { createWorld } = require('../test-helpers/posWorld');

const W = createWorld('tz');
const run = W.run;
test('time zones: set up a business', async t => { await W.setup(t); });
test.after(() => W.teardown());

// the first and the last second of the 19th in Pakistan (UTC+5), and the seconds either side of them
const SALES = { before: '2026-10-18T18:59:59Z', first: '2026-10-18T19:00:00Z', last: '2026-10-19T18:59:59Z', after: '2026-10-19T19:00:00Z' };

run('time zones: sales at the edges of the 19th', async () => {
    for (const at of Object.values(SALES)) { W.clock = Date.parse(at); await W.sellOne(); }
});

const countInSql = (tx, f) => tx.$queryRaw(Prisma.sql`SELECT count(DISTINCT s."id")::int AS n FROM "PosSaleLine" l JOIN "PosSale" s ON s."id" = l."saleId" WHERE ${R.sqlConditions(W.tenantId, f, 'SANDBOX')}`).then(r => r[0].n);

run('time zones: the reports\' day holds the same sales as the list\'s day, in every session time zone', async () => {
    const days = { '2026-10-18': 1, '2026-10-19': 2, '2026-10-20': 1 }; // before | first and last | after
    for (const [day, expected] of Object.entries(days)) {
        const listed = (await W.svc.listSales(W.ctx, { from: day, to: day, limit: 50 })).total;
        assert.strictEqual(listed, expected, `the list, ${day}`);
        for (const tz of ['UTC', 'Asia/Karachi', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Australia/Lord_Howe']) {
            const n = await W.prisma.$transaction(async tx => { await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${tz}'`); return countInSql(tx, { from: day, to: day }); });
            assert.strictEqual(n, expected, `the reports' SQL, ${day}, session in ${tz}`);
        }
    }
    // a range, and one with only one end
    for (const tz of ['UTC', 'Asia/Karachi', 'America/New_York']) {
        const [wide, fromOnly, toOnly] = await W.prisma.$transaction(async tx => {
            await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${tz}'`);
            return [await countInSql(tx, { from: '2026-10-18', to: '2026-10-20' }), await countInSql(tx, { from: '2026-10-19' }), await countInSql(tx, { to: '2026-10-18' })];
        });
        assert.deepStrictEqual([wide, fromOnly, toOnly], [4, 3, 1], tz);
    }
});

run('time zones: the whole report and the closing sheet agree with the list for the same day', async () => {
    W.pra.mock = true; // (the figures cover the sandbox counter's sales while the server is in test mode)
    try {
        const rep = await W.svc.reportBy(W.ctx, 'day', { from: '2026-10-18', to: '2026-10-20' });
        assert.deepStrictEqual(rep.rows.map(r => [r.key, r.sales]), [['2026-10-18', 1], ['2026-10-19', 2], ['2026-10-20', 1]]);
        const sheet = await W.svc.reportClosing(W.ctx, { date: '2026-10-19' });
        assert.strictEqual(sheet.totals.sales, 2);
    } finally { W.pra.mock = false; }
});
