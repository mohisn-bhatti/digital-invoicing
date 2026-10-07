// Load HS tax rules from a JSON file (e.g. data/tax-rules/sales-tax-act-2026.json, extracted from the Sales Tax Act)
// into HsTaxRule. Upserts by (prefix, condition) and never touches a rule the admin already marked as checked.
// The CA Document 1 example rules for the 3rd/5th/6th/8th Schedules are replaced; the special regimes stay.
//   node scripts/import-tax-rules.js data/tax-rules/sales-tax-act-2026.json            (local DB)
//   node scripts/import-tax-rules.js <file> --supabase                                 (Supabase; only when asked)
require('dotenv').config({ quiet: true });
const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/import-tax-rules.js <rules.json> [--supabase]'); process.exit(1); }
const url = process.argv.includes('--supabase') ? process.env.SUPABASE_DATABASE_URL : process.env.DATABASE_URL;
const prisma = new PrismaClient({ datasources: { db: { url } } });
// Ninth / Thirteenth Schedule and petroleum: not part of the extract, keep the Document 1 rules
const SPECIAL = ['851712', '851713', '7206', '7207', '7214', '2710'];

(async () => {
    const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
    const removed = await prisma.hsTaxRule.deleteMany({
        where: { source: { in: ['CA Document 1 (examples)', 'own assumption — not in Document 1'] }, prefix: { notIn: SPECIAL }, reviewed: false },
    });
    await prisma.hsTaxRule.updateMany({ where: { prefix: { in: SPECIAL }, source: 'CA Document 1 (examples)' }, data: { source: 'CA Document 1 (special regime)' } });
    // Unchecked rules from an earlier run of the same extract that are no longer in the file
    const sources = [...new Set(rules.map(r => r.source))];
    const keys = new Set(rules.map(r => r.prefix + '|' + r.condition));
    const stale = (await prisma.hsTaxRule.findMany({ where: { source: { in: sources }, reviewed: false } })).filter(r => !keys.has(r.prefix + '|' + r.condition));
    await prisma.hsTaxRule.deleteMany({ where: { id: { in: stale.map(r => r.id) } } });
    let created = 0, updated = 0, kept = 0;
    for (const r of rules) {
        const existing = await prisma.hsTaxRule.findUnique({ where: { prefix_condition: { prefix: r.prefix, condition: r.condition } } });
        if (existing?.reviewed) { kept++; continue; } // the CA's checked version wins
        const data = { saleType: r.saleType, rate: r.rate, sroScheduleNo: r.sroScheduleNo, sroItemSerialNo: r.sroItemSerialNo, note: r.note, source: r.source, updatedBy: 'import' };
        if (existing) { await prisma.hsTaxRule.update({ where: { id: existing.id }, data }); updated++; }
        else { await prisma.hsTaxRule.create({ data: { prefix: r.prefix, condition: r.condition, ...data } }); created++; }
    }
    console.log(`Removed ${removed.count} Document 1 example rules and ${stale.length} outdated ones; ${created} created, ${updated} updated, ${kept} kept (checked by the CA). Total now ${await prisma.hsTaxRule.count()}.`);
    await prisma.$disconnect();
})().catch(async err => { console.error(err.message); await prisma.$disconnect(); process.exit(1); });
