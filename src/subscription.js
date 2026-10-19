// The access period of a client (how long it may use the application): the rules are in public/access.js, which the Manage screen
// also loads, so the preview there and the server never disagree. This file adds the one thing that writes to the database.
const A = require('../public/access.js');

// Clients whose period and grace are over are made inactive. Run when the server starts and every few minutes; the login and every
// request also check, so nothing depends on this having run.
async function expireDueClients({ prisma, audit, now = new Date() }) {
    const due = await prisma.tenant.findMany({ where: { active: true, accessEndsAt: { not: null, lt: now } }, select: { id: true, companyName: true, accessEndsAt: true, accessUnit: true } });
    const expired = [];
    for (const t of due) {
        const a = A.access(t, now);
        if (a.status !== 'EXPIRED') continue;
        const r = await prisma.tenant.updateMany({ where: { id: t.id, active: true }, data: { active: false, inactiveReason: 'EXPIRED' } });
        if (!r.count) continue;
        expired.push(t.id);
        if (audit) await audit(null, { tenantId: t.id, action: 'client.expired', entityType: 'Tenant', entityId: t.id, summary: `Access period ended on ${a.endsOn} (grace until ${a.graceUntil}): client made inactive automatically`, userEmail: 'system' });
    }
    return expired;
}

module.exports = { ...A, expireDueClients };
