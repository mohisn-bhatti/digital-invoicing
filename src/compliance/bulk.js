// Bulk actions (SRS 10): several clients or obligations at once. Each item is done on its own and the answer says what was done and what
// was skipped, with the reason (an item that cannot be done never stops the others). One activity-log line per action.
const R = require('../../public/cmp-rules');
const { CmpError, bad } = require('./common');

const MAX = 500;
const ids = (list, what) => {
    if (!Array.isArray(list) || !list.length) throw bad(`Choose at least one ${what}.`);
    if (list.length > MAX) throw bad(`At most ${MAX} at a time.`);
    return [...new Set(list.map(String))];
};

function createBulk({ prisma, audit, common, obligations, now }) {
    const log = (ctx, action, summary, details) => audit(ctx.req, { tenantId: ctx.tenantId, action, entityType: 'Bulk', summary, details });
    const nameOf = async (tenantId, id) => (id ? ((await prisma.user.findFirst({ where: { id, tenantId }, select: { name: true, email: true } })) || {}) : null);

    // SRS 10: "generate next year's recurring obligations for multiple selected clients of the same country in one operation"
    async function nextPeriod(ctx, obligationIds) {
        const list = ids(obligationIds, 'obligation');
        const obs = await prisma.cmpObligation.findMany({ where: { tenantId: ctx.tenantId, id: { in: list } }, include: { client: true, occurrences: { orderBy: { seq: 'desc' }, take: 1 } } });
        if (obs.length !== list.length) throw new CmpError(404, 'Some of those obligations were not found. Reload the page and try again.');
        const countries = [...new Set(obs.map(o => o.client.country))];
        if (countries.length > 1) throw bad(`Choose clients of one country at a time (these are from ${countries.join(', ')}).`);
        const done = [], skipped = [];
        for (const ob of obs) {
            const last = ob.occurrences[0], limit = R.periodsAllowed(ob.yearsTotal, ob.frequency), who = `${ob.client.name} — ${ob.name}`;
            if (ob.archivedAt || ob.client.archivedAt) { skipped.push({ id: ob.id, name: who, reason: 'archived' }); continue; }
            if (last && !last.datesConfirmed) { skipped.push({ id: ob.id, name: who, reason: 'the last period\'s dates are not confirmed yet' }); continue; }
            if (limit && last && last.seq >= limit) { skipped.push({ id: ob.id, name: who, reason: `it is set to ${R.yearsLabel(ob.yearsTotal)} and all of its periods are there` }); continue; }
            const occ = await obligations.ensureNext(ob.id, { req: ctx.req, manual: true });
            if (occ) done.push({ id: ob.id, name: who, periodName: R.periodName(occ), dueDate: R.ymdOf(occ.dueDate) }); else skipped.push({ id: ob.id, name: who, reason: 'could not be added just now' });
        }
        await log(ctx, 'cmp.bulk.next_period', `Next period prepared for ${done.length} obligation(s) of ${countries[0]} clients${skipped.length ? `, ${skipped.length} skipped` : ''}`, { done: done.map(d => d.id), skipped });
        return { done, skipped };
    }

    async function assign(ctx, { clientIds, obligationIds, userId }) {
        const who = await common.assignee(ctx.tenantId, userId === undefined ? null : userId);
        const person = who ? await nameOf(ctx.tenantId, who) : null, to = person ? (person.name || person.email) : 'nobody';
        let n = 0;
        if (clientIds) n += (await prisma.cmpClient.updateMany({ where: { tenantId: ctx.tenantId, id: { in: ids(clientIds, 'client') }, archivedAt: null }, data: { assignedToId: who } })).count;
        if (obligationIds) n += (await prisma.cmpObligation.updateMany({ where: { tenantId: ctx.tenantId, id: { in: ids(obligationIds, 'obligation') }, archivedAt: null }, data: { assignedToId: who } })).count;
        if (!clientIds && !obligationIds) throw bad('Choose clients or obligations to assign.');
        await log(ctx, 'cmp.bulk.assign', `${n} ${clientIds ? 'client(s)' : 'obligation(s)'} assigned to ${to}`, { clientIds, obligationIds, userId: who });
        return { done: n };
    }

    async function stage(ctx, { occurrenceIds, stage: to }) {
        if (!['OPEN', 'DATA_COLLECTED', 'FILED', 'PAID'].includes(to)) throw bad('Choose a step: open, data collected, filed or paid.');
        const list = ids(occurrenceIds, 'period');
        const rows = await prisma.cmpOccurrence.findMany({ where: { tenantId: ctx.tenantId, id: { in: list } }, include: { obligation: { include: { client: true } } } });
        const done = [], skipped = [];
        for (const o of rows) {
            const who = `${o.obligation.client.name} — ${o.obligation.name} ${R.periodName(o)}`;
            if (o.obligation.archivedAt || o.obligation.client.archivedAt) skipped.push({ id: o.id, name: who, reason: 'archived' });
            else if (o.stage === 'COMPLETED') skipped.push({ id: o.id, name: who, reason: 'already completed' });
            else if (o.stage !== to) { await prisma.cmpOccurrence.update({ where: { id: o.id }, data: { stage: to } }); done.push({ id: o.id, name: who, from: o.stage }); }
        }
        await log(ctx, 'cmp.bulk.stage', `${done.length} period(s) set to ${R.STATUS[to] || 'Open'}${skipped.length ? `, ${skipped.length} skipped` : ''}`, { done, skipped, to });
        return { done, skipped };
    }

    // one activity-log line per client or obligation (SRS 12: archive actions), so each shows in that client's history
    async function archive(ctx, { clientIds, obligationIds }) {
        const at = now();
        if (!clientIds && !obligationIds) throw bad('Choose clients or obligations to archive.');
        let n = 0;
        if (clientIds) {
            const rows = await prisma.cmpClient.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids(clientIds, 'client') }, archivedAt: null } });
            await prisma.cmpClient.updateMany({ where: { id: { in: rows.map(r => r.id) } }, data: { archivedAt: at, archivedBy: ctx.email } });
            for (const c of rows) await audit(ctx.req, { tenantId: ctx.tenantId, action: 'cmp.client.archive', entityType: 'CmpClient', entityId: c.id, summary: `Client ${common.clientLabel(c)} archived (bulk)`, details: { clientId: c.id } });
            n += rows.length;
        }
        if (obligationIds) {
            const rows = await prisma.cmpObligation.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids(obligationIds, 'obligation') }, archivedAt: null }, include: { client: true } });
            await prisma.cmpObligation.updateMany({ where: { id: { in: rows.map(r => r.id) } }, data: { archivedAt: at, archivedBy: ctx.email } });
            for (const o of rows) await audit(ctx.req, { tenantId: ctx.tenantId, action: 'cmp.obligation.archive', entityType: 'CmpObligation', entityId: o.id, summary: `${o.name} for ${common.clientLabel(o.client)} archived (bulk)`, details: { clientId: o.clientId, obligationId: o.id } });
            n += rows.length;
        }
        return { done: n };
    }

    return { nextPeriod, assign, stage, archive };
}

module.exports = { createBulk };
