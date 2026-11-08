// The module's background job (server.js runs it at start-up and every ten minutes, like the access-period check):
//   1. a year that has passed its due date without being completed is noted in the activity log as overdue, once (SRS 6). The screens
//      do not depend on this: they work out "overdue" from the dates themselves.
//   2. a recurring obligation whose last year's period has ended gets next year's copy (SRS 4), dates to confirm.
// Safe to run twice at once: each year is noted once (a guarded update) and the database refuses a second copy of the same year.
const R = require('../../public/cmp-rules');

function createSweep({ prisma, audit, obligations, now }) {
    // tenantId: only that firm (the tests); otherwise every firm
    async function sweep({ limit = 500, tenantId = null } = {}) {
        const at = now();
        const due = await prisma.cmpOccurrence.findMany({
            where: { ...(tenantId ? { tenantId } : {}), stage: { not: 'COMPLETED' }, dueAt: { lte: at }, overdueNotedAt: null, obligation: { archivedAt: null, client: { archivedAt: null } } },
            take: limit, include: { obligation: { include: { client: true } } },
        });
        let overdue = 0;
        for (const o of due) {
            const r = await prisma.cmpOccurrence.updateMany({ where: { id: o.id, overdueNotedAt: null }, data: { overdueNotedAt: at } });
            if (!r.count) continue;
            overdue++;
            await audit(null, { tenantId: o.tenantId, action: 'cmp.occurrence.overdue', entityType: 'CmpOccurrence', entityId: o.id,
                summary: `${o.obligation.name} ${R.fmtDay(o.periodStart)} – ${R.fmtDay(o.periodEnd)} for ${o.obligation.client.name} (${o.obligation.client.code}): overdue, due ${R.fmtDay(o.dueDate)} and not completed`,
                details: { clientId: o.clientId, obligationId: o.obligationId } });
        }
        // series whose last year's period is over, that may still repeat, for active firms that use the module and want the copies made
        // (the last year's due date + 13 months is a cheap first look; ensureNext checks the exact dates)
        const rows = await prisma.$queryRaw`
            SELECT o.id FROM "CmpObligation" o
            JOIN "CmpClient" c ON c.id = o."clientId"
            JOIN "Tenant" t ON t.id = o."tenantId"
            LEFT JOIN "CmpSettings" s ON s."tenantId" = o."tenantId"
            JOIN LATERAL (SELECT x.seq, x."periodEndAt", x."dueAt" FROM "CmpOccurrence" x WHERE x."obligationId" = o.id ORDER BY x.seq DESC LIMIT 1) last ON true
            WHERE o."archivedAt" IS NULL AND c."archivedAt" IS NULL AND t.active = true AND 'COMPLIANCE' = ANY(t.modules)
              AND COALESCE(s."autoNextYear", true) AND last."periodEndAt" <= ${at} AND last."dueAt" + interval '13 months' > ${at}
              AND (o."yearsTotal" IS NULL OR last.seq < o."yearsTotal")
              AND (${tenantId}::text IS NULL OR o."tenantId" = ${tenantId})
            LIMIT ${limit}`;
        let made = 0;
        for (const r of rows) if (await obligations.ensureNext(r.id)) made++;
        return { overdue, made };
    }
    return { sweep };
}

module.exports = { createSweep };
