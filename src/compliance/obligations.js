// Obligations (SRS 4), their reminders (SRS 5) and their years. An obligation is the series (name, portal, how many years); each year is
// a CmpOccurrence with its own dates and step. Dates are always typed by a person: next year's are a copy a year on that waits for
// "confirm" (public/cmp-rules.js periodDates); one period can differ from the rest, or a change can carry on to the periods after.
const R = require('../../public/cmp-rules');
const V = require('./validate');
const { CmpError, bad, ciContains } = require('./common');

const dateOf = ymd => new Date(ymd + 'T00:00:00Z');
const ymd = R.ymdOf;
const period = o => `${R.fmtDay(o.periodStart)} – ${R.fmtDay(o.periodEnd)}`;
const datesText = o => `period ${period(o)}, due ${R.fmtDay(o.dueDate)}`;
// The stored form of one year's dates: the days, and the client's midnights after the period end and the due date
const occData = (d, tz) => ({ periodStart: dateOf(d.periodStart), periodEnd: dateOf(d.periodEnd), dueDate: dateOf(d.dueDate), ...R.instants(d, tz) });
// "year 2" for a yearly obligation, the period's own name for a monthly or quarterly one ("Mar 2027")
const which = (ob, o) => (!ob.frequency || ob.frequency === 'YEARLY' ? `year ${o.seq}` : R.periodName(o));
const remText = rs => (rs.length ? rs.map(r => `${R.offsetLabel(r.offsetDays).toLowerCase()} (${r.templateName || 'template'})`).join(', ') : 'none');

function createObligations({ prisma, audit, common, now }) {
    const log = (ctx, action, entityType, entityId, summary, details) => audit(ctx.req, { tenantId: ctx.tenantId, action, entityType, entityId, summary, details });

    // reminder id → when it was last sent, for each year (messages marked "not sent" do not count)
    async function sentMap(occurrenceIds) {
        const m = new Map();
        if (!occurrenceIds.length) return m;
        const msgs = await prisma.cmpMessage.findMany({ where: { occurrenceId: { in: occurrenceIds }, reminderId: { not: null }, voidedAt: null }, select: { occurrenceId: true, reminderId: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
        for (const x of msgs) { if (!m.has(x.occurrenceId)) m.set(x.occurrenceId, new Map()); m.get(x.occurrenceId).set(x.reminderId, x.createdAt); }
        return m;
    }
    const reminderList = rs => rs.map(r => ({ id: r.id, offsetDays: r.offsetDays, templateId: r.templateId, templateName: r.template ? r.template.name : '', templateActive: r.template ? r.template.active : false }));
    // One year as the screens need it, with its status, colour and reminders worked out on the client's clock
    function present(occ, { reminders, tz, settings, sent, at }) {
        const v = R.occurrenceView(occ, { tz, hour: settings.reminderHour, amberDays: settings.amberDays, now: at, reminders, sent: sent.get(occ.id) || new Map() });
        return {
            id: occ.id, seq: occ.seq, periodStart: ymd(occ.periodStart), periodEnd: ymd(occ.periodEnd), dueDate: ymd(occ.dueDate), stage: occ.stage,
            datesConfirmed: occ.datesConfirmed, overridden: occ.overridden, closedAt: occ.closedAt, closedBy: occ.closedBy, closeKind: occ.closeKind, notes: occ.notes,
            view: {
                status: v.status, colour: v.colour, overdue: v.overdue, daysLeft: v.daysLeft, periodEndAt: v.periodEndAt, dueAt: v.dueAt, actionable: v.actionable, inWindow: v.inWindow,
                reminders: v.reminders.map(r => ({ id: r.id, offsetDays: r.offsetDays, templateId: r.templateId, templateName: r.templateName, fireAt: new Date(r.fireAt), state: r.state, sentAt: r.sentAt })),
            },
        };
    }
    const clientBrief = c => ({ id: c.id, code: c.code, name: c.name, country: c.country, timeZone: c.timeZone, archivedAt: c.archivedAt, assignedToId: c.assignedToId });
    const seriesView = ob => ({ id: ob.id, clientId: ob.clientId, name: ob.name, portalUrl: ob.portalUrl, frequency: ob.frequency, yearsTotal: ob.yearsTotal, notes: ob.notes, assignedToId: ob.assignedToId,
        basePeriodStart: ymd(ob.basePeriodStart), basePeriodEnd: ymd(ob.basePeriodEnd), baseDueDate: ymd(ob.baseDueDate), archivedAt: ob.archivedAt, archivedBy: ob.archivedBy, createdAt: ob.createdAt });

    const INCLUDE = { client: true, reminders: { include: { template: { select: { id: true, name: true, active: true } } } }, occurrences: { orderBy: { seq: 'asc' } } };
    async function presentSeries(tenantId, list) {
        const settings = await common.settings(tenantId), at = now();
        const sent = await sentMap(list.flatMap(ob => ob.occurrences.map(o => o.id)));
        return list.map(ob => {
            const reminders = reminderList(ob.reminders);
            return { ...seriesView(ob), client: clientBrief(ob.client), reminders, occurrences: ob.occurrences.map(o => present(o, { reminders, tz: ob.client.timeZone, settings, sent, at })) };
        });
    }
    async function get(ctx, id) {
        await common.findObligation(ctx.tenantId, id);
        const ob = await prisma.cmpObligation.findUnique({ where: { id }, include: INCLUDE });
        return (await presentSeries(ctx.tenantId, [ob]))[0];
    }
    async function forClient(ctx, clientId) {
        const list = await prisma.cmpObligation.findMany({ where: { tenantId: ctx.tenantId, clientId }, orderBy: [{ archivedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }], include: INCLUDE });
        return presentSeries(ctx.tenantId, list);
    }

    // Next year's copy of a series (its dates a year on, to be confirmed). Never twice (the database refuses a second year n), never past
    // the number of years chosen, never for an archived obligation or client. Made by itself only for a year that is still ahead: an
    // obligation typed in with an old year does not fill up with past years that would all show as overdue (the button adds those).
    // Returns the new year, or null.
    async function ensureNext(obligationId, { req = null, manual = false } = {}) {
        const ob = await prisma.cmpObligation.findUnique({ where: { id: obligationId }, include: { client: true, occurrences: { orderBy: { seq: 'desc' }, take: 1 } } });
        if (!ob || ob.archivedAt || ob.client.archivedAt) return null;
        const seq = (ob.occurrences[0] ? ob.occurrences[0].seq : 0) + 1, limit = R.periodsAllowed(ob.yearsTotal, ob.frequency);
        if (limit && seq > limit) return null;
        const dates = R.periodDates({ periodStart: ob.basePeriodStart, periodEnd: ob.basePeriodEnd, dueDate: ob.baseDueDate }, seq, ob.frequency);
        if (!manual && R.instants(dates, ob.client.timeZone).dueAt <= now()) return null;
        try {
            const occ = await prisma.cmpOccurrence.create({ data: { tenantId: ob.tenantId, clientId: ob.clientId, obligationId: ob.id, seq, ...occData(dates, ob.client.timeZone), datesConfirmed: false } });
            await audit(req, { tenantId: ob.tenantId, action: 'cmp.occurrence.generate', entityType: 'CmpOccurrence', entityId: occ.id,
                summary: `${ob.name} for ${common.clientLabel(ob.client)}: ${which(ob, { seq, ...dates })} prepared (${datesText(dates)}), dates to confirm${manual ? '' : ' (made when the period before ended)'}`,
                details: { clientId: ob.clientId, obligationId: ob.id } });
            return occ;
        } catch (e) { if (e.code === 'P2002') return null; throw e; }
    }

    async function create(ctx, clientId, b) {
        const client = await common.findClient(ctx.tenantId, clientId, { live: true });
        const o = V.cleanObligation(b || {});
        const rems = V.cleanReminders(b.reminders);
        await common.checkTemplates(ctx.tenantId, rems);
        const assignedToId = (await common.assignee(ctx.tenantId, b.assignedToId)) || null;
        const ob = await prisma.$transaction(async tx => {
            const row = await tx.cmpObligation.create({ data: { tenantId: ctx.tenantId, clientId: client.id, name: o.name, portalUrl: o.portalUrl, frequency: o.frequency, yearsTotal: o.yearsTotal, notes: o.notes, assignedToId,
                basePeriodStart: dateOf(o.periodStart), basePeriodEnd: dateOf(o.periodEnd), baseDueDate: dateOf(o.dueDate), createdBy: ctx.email } });
            await tx.cmpOccurrence.create({ data: { tenantId: ctx.tenantId, clientId: client.id, obligationId: row.id, seq: 1, ...occData(o, client.timeZone) } });
            if (rems.length) await tx.cmpReminder.createMany({ data: rems.map(r => ({ tenantId: ctx.tenantId, obligationId: row.id, offsetDays: r.offsetDays, templateId: r.templateId })) });
            return row;
        });
        const names = new Map((await prisma.cmpTemplate.findMany({ where: { id: { in: rems.map(r => r.templateId) } }, select: { id: true, name: true } })).map(t => [t.id, t.name]));
        await log(ctx, 'cmp.obligation.create', 'CmpObligation', ob.id, `${o.name} added for ${common.clientLabel(client)}: ${datesText(o)}; ${R.repeatsLabel(o.frequency, o.yearsTotal).toLowerCase()}; reminders: ${remText(rems.map(r => ({ ...r, templateName: names.get(r.templateId) })))}`, { clientId: client.id, obligationId: ob.id });
        // a period that is already over: next year's copy straight away (otherwise the background job makes it when the period ends)
        const settings = await common.settings(ctx.tenantId);
        if (settings.autoNextYear && R.instants(o, client.timeZone).periodEndAt <= now()) await ensureNext(ob.id, { req: ctx.req });
        return get(ctx, ob.id);
    }

    async function update(ctx, id, b) {
        const ob = await common.findObligation(ctx.tenantId, id, { live: true });
        const o = V.cleanObligation(b || {}, { partial: true });
        delete o.periodStart; delete o.periodEnd; delete o.dueDate; // the dates are changed period by period (updateOccurrence)
        const who = await common.assignee(ctx.tenantId, b.assignedToId);
        if (who !== undefined) o.assignedToId = who;
        if (o.yearsTotal) {
            const top = (await prisma.cmpOccurrence.aggregate({ where: { obligationId: ob.id }, _max: { seq: true } }))._max.seq || 0;
            const perYear = R.freqOf(ob.frequency).perYear;
            if (top > R.periodsAllowed(o.yearsTotal, ob.frequency)) throw bad(`${top} ${perYear === 1 ? 'years are' : 'periods are'} already there: the limit cannot be less than ${Math.ceil(top / perYear)} year(s).`);
        }
        await prisma.cmpObligation.update({ where: { id: ob.id }, data: o });
        const what = [o.name !== undefined && o.name !== ob.name && `renamed "${ob.name}" → "${o.name}"`, o.portalUrl !== undefined && o.portalUrl !== ob.portalUrl && 'portal link',
            o.yearsTotal !== undefined && o.yearsTotal !== ob.yearsTotal && `repeats: ${R.repeatsLabel(ob.frequency, ob.yearsTotal).toLowerCase()} → ${R.repeatsLabel(ob.frequency, o.yearsTotal).toLowerCase()}`, o.notes !== undefined && o.notes !== ob.notes && 'notes', o.assignedToId !== undefined && o.assignedToId !== ob.assignedToId && 'assigned to someone else'].filter(Boolean);
        if (what.length) await log(ctx, 'cmp.obligation.update', 'CmpObligation', ob.id, `${o.name || ob.name} for ${common.clientLabel(ob.client)}: ${what.join(', ')}`, { clientId: ob.clientId, obligationId: ob.id });
        // more years allowed than before, and the last one's period is over: the next one can come now
        if (o.yearsTotal !== undefined && (await common.settings(ctx.tenantId)).autoNextYear) {
            const last = await prisma.cmpOccurrence.findFirst({ where: { obligationId: ob.id }, orderBy: { seq: 'desc' } });
            if (last && last.periodEndAt <= now()) await ensureNext(ob.id, { req: ctx.req });
        }
        return get(ctx, ob.id);
    }

    async function setReminders(ctx, id, list) {
        const ob = await common.findObligation(ctx.tenantId, id, { live: true });
        const rems = V.cleanReminders(list);
        await common.checkTemplates(ctx.tenantId, rems);
        const before = await prisma.cmpReminder.findMany({ where: { obligationId: ob.id }, include: { template: { select: { name: true } } }, orderBy: { offsetDays: 'asc' } });
        await prisma.$transaction(async tx => {
            const keep = new Set(rems.map(r => r.offsetDays));
            await tx.cmpReminder.deleteMany({ where: { obligationId: ob.id, offsetDays: { notIn: [...keep] } } });
            for (const r of rems) {
                const old = before.find(x => x.offsetDays === r.offsetDays);
                if (!old) await tx.cmpReminder.create({ data: { tenantId: ctx.tenantId, obligationId: ob.id, offsetDays: r.offsetDays, templateId: r.templateId } });
                else if (old.templateId !== r.templateId) await tx.cmpReminder.update({ where: { id: old.id }, data: { templateId: r.templateId } });
            }
        });
        const after = await prisma.cmpReminder.findMany({ where: { obligationId: ob.id }, include: { template: { select: { name: true } } }, orderBy: { offsetDays: 'asc' } });
        const t = rs => remText(rs.map(r => ({ offsetDays: r.offsetDays, templateName: r.template.name })));
        if (t(before) !== t(after)) await log(ctx, 'cmp.reminder.update', 'CmpObligation', ob.id, `Reminders of ${ob.name} for ${common.clientLabel(ob.client)}: ${t(before)} → ${t(after)}`, { clientId: ob.clientId, obligationId: ob.id });
        return get(ctx, ob.id);
    }

    // "Generate next" by hand: after the last period's dates are confirmed, and within the number of years chosen
    async function next(ctx, id) {
        const ob = await common.findObligation(ctx.tenantId, id, { live: true });
        const last = await prisma.cmpOccurrence.findFirst({ where: { obligationId: ob.id }, orderBy: { seq: 'desc' } });
        if (last && !last.datesConfirmed) throw new CmpError(409, `Confirm the dates of ${which(ob, last)} first.`);
        const limit = R.periodsAllowed(ob.yearsTotal, ob.frequency);
        if (limit && last && last.seq >= limit) throw new CmpError(409, `This obligation comes back ${R.repeatsLabel(ob.frequency, ob.yearsTotal).toLowerCase()}, and all of its periods are there. Change the number of years to add more.`);
        if (!(await ensureNext(ob.id, { req: ctx.req, manual: true }))) throw new CmpError(409, 'The next period could not be added just now. Reload the page and try again.');
        return get(ctx, ob.id);
    }

    // One year's dates, its confirmation and its notes. applyFuture: these dates become the pattern of the years after it too.
    async function updateOccurrence(ctx, id, b) {
        const occ = await common.findOccurrence(ctx.tenantId, id, { live: true });
        const ob = occ.obligation, client = ob.client;
        const old = { periodStart: ymd(occ.periodStart), periodEnd: ymd(occ.periodEnd), dueDate: ymd(occ.dueDate) };
        const data = {}, what = [];
        let futureBase = null;
        if (b.periodStart !== undefined || b.periodEnd !== undefined || b.dueDate !== undefined || b.applyFuture === true) {
            const d = V.cleanDates({ periodStart: b.periodStart ?? old.periodStart, periodEnd: b.periodEnd ?? old.periodEnd, dueDate: b.dueDate ?? old.dueDate });
            const changed = d.periodStart !== old.periodStart || d.periodEnd !== old.periodEnd || d.dueDate !== old.dueDate;
            if (changed) { Object.assign(data, occData(d, client.timeZone), { datesConfirmed: true }); what.push(`${datesText(old)} → ${datesText(d)}`); }
            if (b.applyFuture === true) {
                futureBase = R.periodDates(d, 2 - occ.seq, ob.frequency); // the period-1 pattern that gives these dates in this period
                data.overridden = false;
                what.push('the periods after follow these dates');
            } else if (changed) data.overridden = true;
        }
        if (b.confirm === true && !occ.datesConfirmed && !data.datesConfirmed) { data.datesConfirmed = true; what.push('dates confirmed'); }
        if (b.notes !== undefined) { const n = V.multiline(b.notes, 1000, 'Notes'); if (n !== occ.notes) { data.notes = n; what.push('notes'); } }
        await prisma.$transaction(async tx => {
            await tx.cmpOccurrence.update({ where: { id: occ.id }, data });
            if (futureBase) {
                await tx.cmpObligation.update({ where: { id: ob.id }, data: { basePeriodStart: dateOf(futureBase.periodStart), basePeriodEnd: dateOf(futureBase.periodEnd), baseDueDate: dateOf(futureBase.dueDate) } });
                // later periods nobody has confirmed or changed yet take the new pattern
                const later = await tx.cmpOccurrence.findMany({ where: { obligationId: ob.id, seq: { gt: occ.seq }, datesConfirmed: false, overridden: false, stage: { not: 'COMPLETED' } } });
                for (const l of later) await tx.cmpOccurrence.update({ where: { id: l.id }, data: occData(R.periodDates(futureBase, l.seq, ob.frequency), client.timeZone) });
            }
        });
        if (what.length) await log(ctx, 'cmp.occurrence.update', 'CmpOccurrence', occ.id, `${ob.name} for ${common.clientLabel(client)}, ${which(ob, occ)}: ${what.join('; ')}`, { clientId: client.id, obligationId: ob.id });
        return get(ctx, ob.id);
    }

    const STEP_NAMES = { OPEN: 'Open', DATA_COLLECTED: 'Data collected', FILED: 'Filed', PAID: 'Paid', COMPLETED: 'Completed' };
    async function setStage(ctx, id, stage) {
        const occ = await common.findOccurrence(ctx.tenantId, id, { live: true });
        if (!['OPEN', 'DATA_COLLECTED', 'FILED', 'PAID'].includes(stage)) throw bad('Choose a step: open, data collected, filed or paid.');
        if (occ.stage === 'COMPLETED') throw new CmpError(409, 'This period is completed. Reopen it first.');
        if (occ.stage !== stage) {
            await prisma.cmpOccurrence.update({ where: { id: occ.id }, data: { stage } });
            await log(ctx, 'cmp.occurrence.stage', 'CmpOccurrence', occ.id, `${occ.obligation.name} ${period(occ)} for ${common.clientLabel(occ.obligation.client)}: ${STEP_NAMES[occ.stage]} → ${STEP_NAMES[stage]}`, { clientId: occ.clientId, obligationId: occ.obligationId, from: occ.stage, to: stage });
        }
        return get(ctx, occ.obligationId);
    }
    // Completed and closed (SRS 9): mode INVOICE = an invoice is made for it (the route makes the draft), FREE = closed without one
    // (free work for family, friends, goodwill). The next period is prepared if it is not there yet.
    async function complete(ctx, id, mode = 'FREE') {
        if (!['INVOICE', 'FREE'].includes(mode)) throw bad('Choose: generate an invoice, or close without one.');
        const occ = await common.findOccurrence(ctx.tenantId, id, { live: true });
        if (occ.stage === 'COMPLETED') throw new CmpError(409, 'This period is already completed.');
        const done = await prisma.cmpOccurrence.updateMany({ where: { id: occ.id, stage: { not: 'COMPLETED' } }, data: { stage: 'COMPLETED', closedAt: now(), closedBy: ctx.email, closeKind: mode } });
        if (!done.count) throw new CmpError(409, 'This period is already completed.');
        await log(ctx, 'cmp.occurrence.complete', 'CmpOccurrence', occ.id, `${occ.obligation.name} ${period(occ)} for ${common.clientLabel(occ.obligation.client)}: ${STEP_NAMES[occ.stage]} → Completed (${mode === 'INVOICE' ? 'with an invoice' : 'closed without an invoice'})`, { clientId: occ.clientId, obligationId: occ.obligationId, from: occ.stage, to: 'COMPLETED', closeKind: mode });
        if ((await common.settings(ctx.tenantId)).autoNextYear) {
            const last = await prisma.cmpOccurrence.findFirst({ where: { obligationId: occ.obligationId }, orderBy: { seq: 'desc' } });
            if (last.id === occ.id) await ensureNext(occ.obligationId, { req: ctx.req });
        }
        return get(ctx, occ.obligationId);
    }
    async function reopen(ctx, id) {
        const occ = await common.findOccurrence(ctx.tenantId, id, { live: true });
        if (occ.stage !== 'COMPLETED') throw new CmpError(409, 'This period is not completed.');
        await prisma.cmpOccurrence.update({ where: { id: occ.id }, data: { stage: 'OPEN', closedAt: null, closedBy: null, closeKind: null } });
        await log(ctx, 'cmp.occurrence.reopen', 'CmpOccurrence', occ.id, `${occ.obligation.name} ${period(occ)} for ${common.clientLabel(occ.obligation.client)}: reopened (Completed → Open)`, { clientId: occ.clientId, obligationId: occ.obligationId, from: 'COMPLETED', to: 'OPEN' });
        return get(ctx, occ.obligationId);
    }
    async function setArchived(ctx, id, archive) {
        const ob = await common.findObligation(ctx.tenantId, id);
        if (Boolean(ob.archivedAt) === archive) throw new CmpError(409, archive ? 'This obligation is already archived.' : 'This obligation is not archived.');
        if (!archive && ob.client.archivedAt) throw new CmpError(409, 'The client is archived. Restore the client first.');
        await prisma.cmpObligation.update({ where: { id: ob.id }, data: archive ? { archivedAt: now(), archivedBy: ctx.email } : { archivedAt: null, archivedBy: null } });
        await log(ctx, archive ? 'cmp.obligation.archive' : 'cmp.obligation.restore', 'CmpObligation', ob.id, `${ob.name} for ${common.clientLabel(ob.client)} ${archive ? 'archived' : 'restored'}`, { clientId: ob.clientId, obligationId: ob.id });
        return get(ctx, ob.id);
    }

    // The obligations list: one row per year, with filters (SRS 10). status: UPCOMING, PERIOD_CLOSED, DATA_COLLECTED, FILED, PAID, COMPLETED,
    // OVERDUE, OPEN (everything not completed, the default), CONFIRM (dates to confirm) or ALL
    async function listOccurrences(ctx, q = {}) {
        const at = now(), status = String(q.status || 'OPEN').toUpperCase();
        const where = { tenantId: ctx.tenantId };
        const live = { archivedAt: null, client: { archivedAt: null } };
        if (q.archived === '1') where.OR = [{ obligation: { archivedAt: { not: null } } }, { obligation: { client: { archivedAt: { not: null } } } }];
        else where.obligation = live;
        const AND = [];
        const byStatus = {
            OPEN: { stage: { not: 'COMPLETED' } }, ALL: {}, COMPLETED: { stage: 'COMPLETED' },
            OVERDUE: { stage: { not: 'COMPLETED' }, dueAt: { lte: at } },
            DATA_COLLECTED: { stage: 'DATA_COLLECTED', dueAt: { gt: at } }, FILED: { stage: 'FILED', dueAt: { gt: at } }, PAID: { stage: 'PAID', dueAt: { gt: at } },
            PERIOD_CLOSED: { stage: 'OPEN', periodEndAt: { lte: at }, dueAt: { gt: at } }, UPCOMING: { stage: 'OPEN', periodEndAt: { gt: at } },
            CONFIRM: { datesConfirmed: false, stage: { not: 'COMPLETED' } },
        };
        if (!byStatus[status]) throw bad('Unknown status.');
        AND.push(byStatus[status]);
        if (q.country) AND.push({ obligation: { client: { country: V.country(q.country).code } } });
        if (q.clientId) AND.push({ clientId: String(q.clientId) });
        // the obligation's person, or (when it has none) the client's person
        if (q.assignee) {
            const who = common.assigneeFilter(q.assignee, ctx.userId);
            AND.push(who === null ? { obligation: { assignedToId: null, client: { assignedToId: null } } } : { OR: [{ obligation: { assignedToId: who } }, { obligation: { assignedToId: null, client: { assignedToId: who } } }] });
        }
        if (q.from) AND.push({ dueDate: { gte: dateOf(V.day(q.from, 'From')) } });
        if (q.to) AND.push({ dueDate: { lte: dateOf(V.day(q.to, 'To')) } });
        const s = String(q.q || '').trim().slice(0, 100);
        if (s) AND.push({ OR: [{ obligation: { name: ciContains(s) } }, { obligation: { client: { name: ciContains(s) } } }, { obligation: { client: { code: ciContains(s) } } }] });
        where.AND = AND;
        const [rows, total] = await Promise.all([
            prisma.cmpOccurrence.findMany({ where, orderBy: [{ dueDate: status === 'COMPLETED' ? 'desc' : 'asc' }, { id: 'asc' }], take: Math.min(Number(q.limit) || 500, 20000),
                include: { obligation: { include: { client: true, reminders: { include: { template: { select: { id: true, name: true, active: true } } } } } } } }),
            prisma.cmpOccurrence.count({ where }),
        ]);
        const settings = await common.settings(ctx.tenantId), sent = await sentMap(rows.map(r => r.id));
        return {
            total,
            rows: rows.map(o => ({
                ...present(o, { reminders: reminderList(o.obligation.reminders), tz: o.obligation.client.timeZone, settings, sent, at }),
                obligation: { id: o.obligation.id, name: o.obligation.name, frequency: o.obligation.frequency, yearsTotal: o.obligation.yearsTotal, portalUrl: o.obligation.portalUrl, archivedAt: o.obligation.archivedAt, assignedToId: o.obligation.assignedToId },
                client: clientBrief(o.obligation.client),
                assignedToId: o.obligation.assignedToId || o.obligation.client.assignedToId || null,
            })),
        };
    }

    // SRS 4: names, dates and reminders already used for other clients of the same country, most used first (never another country's).
    // The dates are the latest a person entered or confirmed (not a copy the system proposed).
    async function suggest(ctx, countryCode) {
        const country = V.country(countryCode).code;
        const obs = await prisma.cmpObligation.findMany({ where: { tenantId: ctx.tenantId, archivedAt: null, client: { country, archivedAt: null } }, orderBy: { createdAt: 'desc' }, take: 1000,
            include: { reminders: { include: { template: { select: { id: true, name: true, active: true } } }, orderBy: { offsetDays: 'asc' } }, occurrences: { where: { datesConfirmed: true }, orderBy: { seq: 'desc' }, take: 1 } } });
        const byName = new Map();
        for (const ob of obs) {
            const k = R.keyOf(ob.name);
            if (!byName.has(k) && ob.occurrences.length) {
                const last = ob.occurrences[0];
                byName.set(k, { name: ob.name, periodStart: ymd(last.periodStart), periodEnd: ymd(last.periodEnd), dueDate: ymd(last.dueDate), frequency: ob.frequency, yearsTotal: ob.yearsTotal, portalUrl: ob.portalUrl,
                    reminders: ob.reminders.filter(r => r.template.active).map(r => ({ offsetDays: r.offsetDays, templateId: r.templateId, templateName: r.template.name })), clients: new Set() });
            }
            if (byName.has(k)) byName.get(k).clients.add(ob.clientId);
        }
        return [...byName.values()].map(x => ({ ...x, clients: x.clients.size })).sort((a, b) => b.clients - a.clients || a.name.localeCompare(b.name));
    }

    return { sentMap, present, reminderList, get, forClient, ensureNext, create, update, setReminders, next, updateOccurrence, setStage, complete, reopen, setArchived, listOccurrences, suggest };
}

module.exports = { createObligations, occData };
