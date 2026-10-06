// HS / PCT code lookup: import the PCT-2017 list, sync FBR's live list, search.
const path = require('path');
const { Prisma } = require('@prisma/client');
const fbr = require('./fbr');

const HS_FORMAT = /^\d{4}\.\d{4}$/;

// "01012100" / "0101.21" / "0101 2100" -> digits + dot after 4 digits
function normalizeCode(q) {
    const digits = String(q).replace(/\D/g, '');
    return digits.length > 4 ? `${digits.slice(0, 4)}.${digits.slice(4, 8)}` : digits;
}

// INSERT ... ON CONFLICT in chunks. FBR rows replace anything; PCT rows only replace other PCT rows,
// so re-importing the PCT list never overwrites codes already synced from FBR.
async function upsert(prisma, rows, source) {
    const onlyPct = source === 'FBR' ? Prisma.empty : Prisma.sql`WHERE "HsCode"."source" = 'PCT-2017'`;
    let n = 0;
    for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        const values = Prisma.join(chunk.map(r => Prisma.sql`(${r.code}, ${r.description}, ${source}, now())`));
        n += await prisma.$executeRaw`
            INSERT INTO "HsCode" ("code", "description", "source", "updatedAt") VALUES ${values}
            ON CONFLICT ("code") DO UPDATE SET "description" = EXCLUDED."description", "source" = EXCLUDED."source", "updatedAt" = now()
            ${onlyPct}`;
    }
    return n;
}

async function importPct(prisma) {
    const rows = require(path.join(__dirname, '..', 'data', 'hs-codes-pct-2017.json'));
    const n = await upsert(prisma, rows, 'PCT-2017');
    // drop PCT rows that are no longer in the file (FBR rows are kept)
    const removed = await prisma.hsCode.deleteMany({ where: { source: 'PCT-2017', code: { notIn: rows.map(r => r.code) } } });
    return { upserted: n, removed: removed.count };
}

// Pull FBR's itemdesccode list with a tenant token; returns number of codes synced, or null if FBR was unreachable
async function syncFromFbr(prisma, token) {
    const list = await fbr.reference('itemdesccode', token, { fresh: true });
    if (!list) return null;
    const rows = list
        .map(r => ({ code: String(r.hS_CODE || '').trim(), description: String(r.description || '').replace(/\s+/g, ' ').trim() }))
        .filter(r => HS_FORMAT.test(r.code) && r.description);
    if (!rows.length) return null;
    await upsert(prisma, rows, 'FBR');
    return rows.length;
}

async function search(prisma, q, limit = 20) {
    const query = String(q || '').trim();
    if (query.length < 2) return [];
    const select = { code: true, description: true, source: true };
    const orderBy = [{ source: 'asc' }, { code: 'asc' }]; // 'FBR' sorts before 'PCT-2017'

    if (/^[\d.\s]+$/.test(query)) {
        return prisma.hsCode.findMany({ where: { code: { startsWith: normalizeCode(query) } }, select, orderBy, take: limit });
    }
    const words = query.split(/\s+/).filter(w => w.length > 1).slice(0, 5);
    return prisma.hsCode.findMany({
        where: { AND: words.map(w => ({ description: { contains: w, mode: 'insensitive' } })) },
        select, orderBy, take: limit,
    });
}

async function stats(prisma) {
    const rows = await prisma.hsCode.groupBy({ by: ['source'], _count: { _all: true }, _max: { updatedAt: true } });
    return Object.fromEntries(rows.map(r => [r.source, { count: r._count._all, updatedAt: r._max.updatedAt }]));
}

module.exports = { importPct, syncFromFbr, search, stats, normalizeCode, HS_FORMAT };
