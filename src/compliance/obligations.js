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
const remText = rs => (rs.length ? rs.map(r => `${R.offsetLabel(r.offsetDays).toLowerCase()} (${r.templateName || (r.body ? 'own message' : 'template')})`).join(', ') : 'none');
const OWN = 'Own message';

function createObligations({ prisma, audit, common, now }) {
    const log = (ctx, action, entityType, entityId, summary, details) => audit(ctx.req, { tenantId: ctx.tenantId, action, entityType, entityId, summary, details });

    // reminder id → when it was last sent, for each year (messages marked "not sent" do not count); m.counts: how many times (the CA:
    // "sent twice")
    async function sentMap(occurrenceIds) {
        const m = new Map();
        m.counts = new Map();
        if (!occurrenceIds.length) return m;
        const msgs = await prisma.cmpMessage.findMany({ where: { occurrenceId: { in: occurrenceIds }, reminderId: { not: null }, voidedAt: null }, select: { occurrenceId: true, reminderId: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
        for (const x of msgs) {
            if (!m.has(x.occurrenceId)) { m.set(x.occurrenceId, new Map()); m.counts.set(x.occurrenceId, new Map()); }
            m.get(x.occurrenceId).set(x.reminderId, x.createdAt);
            const c = m.counts.get(x.occurrenceId); c.set(x.reminderId, (c.get(x.reminderId) || 0) + 1);
        }
        return m;
    }
    const reminderList = rs => [...rs].sort((a, b) => a.offsetDays - b.offsetDays).map(r => ({ id: r.id, offsetDays: r.offsetDays, templateId: r.templateId, body: r.body || null,
        templateName: r.template ? r.template.name : r.body ? OWN : '', templateActive: r.template ? r.template.active : Boolean(r.body) }));
    // One year as the screens need it, with its status, colour and reminders worked out on the client's clock. amberDays: the
    // obligation's own (the CA). (A client with no WhatsApp still has reminders to give: by phone or email, marked by hand.)
    function present(occ, { reminders, tz, settings, sent, at, amberDays }) {
        const v = R.occurrenceView(occ, { tz, hour: settings.reminderHour, amberDays: amberDays ?? settings.amberDays, now: at, reminders, sent: sent.get(occ.id) || new Map() });
        const counts = (sent.counts && sent.counts.get(occ.id)) || new Map(), completed = occ.stage === 'COMPLETED';
        return {
            id: occ.id, seq: occ.seq, periodStart: ymd(occ.periodStart), periodEnd: ymd(occ.periodEnd), dueDate: ymd(occ.dueDate), stage: occ.stage,
            datesConfirmed: occ.datesConfirmed, overridden: occ.overridden, closedAt: occ.closedAt, closedBy: occ.closedBy, closeKind: occ.closeKind, notes: occ.notes,
            dataCollectedOn: occ.dataCollectedOn ? ymd(occ.dataCollectedOn) : null, dataCollectedBy: occ.dataCollectedBy || null, completedOn: occ.completedOn ? ymd(occ.completedOn) : null, dataNote: occ.dataNote || '', taskNote: occ.taskNote || '',
            view: {
                status: v.status, colour: v.colour, overdue: v.overdue, daysLeft: v.daysLeft, periodEndAt: v.periodEndAt, dueAt: v.dueAt, actionable: v.actionable, inWindow: v.inWindow,
                reminders: v.reminders.map(r => {
                    const x = { id: r.id, offsetDays: r.offsetDays, templateId: r.templateId, templateName: r.templateName, fireAt: new Date(r.fireAt), date: R.dayIn(tz, r.fireAt), state: r.state, sentAt: r.sentAt, sentCount: counts.get(r.id) || 0 };
                    x.button = R.reminderButton(x, { tz, now: at, completed });
                    return x;
                }),
            },
        };
    }
    const clientBrief = c => ({ id: c.id, code: c.code, name: c.name, country: c.country, timeZone: c.timeZone, noWhatsApp: c.noWhatsApp, archivedAt: c.archivedAt, assignedToId: c.assignedToId });
    const seriesView = ob => ({ id: ob.id, clientId: ob.clientId, name: ob.name, portalUrl: ob.portalUrl, frequency: ob.frequency, yearsTotal: ob.yearsTotal, notes: ob.notes, assignedToId: ob.assignedToId, amberDays: ob.amberDays, autoNext: ob.autoNext, locked: ob.locked,
        basePeriodStart: ymd(ob.basePeriodStart), basePeriodEnd: ymd(ob.basePeriodEnd), baseDueDate: ymd(ob.baseDueDate), baseSeq: ob.baseSeq, archivedAt: ob.archivedAt, archivedBy: ob.archivedBy, createdAt: ob.createdAt });

    const INCLUDE = { client: true, reminders: { include: { template: { select: { id: true, name: true, active: true } } } }, occurrences: { orderBy: { seq: 'asc' } } };
    async function presentSeries(tenantId, list) {
        const settings = await common.settings(tenantId), at = now();
        const sent = await sentMap(list.flatMap(ob => ob.occurrences.map(o => o.id)));
        return list.map(ob => {
            const reminders = reminderList(ob.reminders);
            return { ...seriesView(ob), client: clientBrief(ob.client), reminders, occurrences: ob.occurrences.map(o => present(o, { reminders, tz: ob.client.timeZone, settings, sent, at, amberDays: ob.amberDays, noWhatsApp: ob.client.noWhatsApp })) };
        });
    }
    async function get(ctx, id) {
        await common.findObligation(ctx.tenantId, id);
        const ob = await prisma.cmpObligation.findUnique({ where: { id }, include: INCLUDE });
        const out = (await presentSeries(ctx.tenantId, [ob]))[0];
        // what deleting it would touch (the CA: once a message was sent, it is deleted only with a warning and a note)
        const ids = ob.occurrences.map(o => o.id);
        const [messages, invoices] = ids.length ? await Promise.all([
            prisma.cmpMessage.count({ where: { occurrenceId: { in: ids }, voidedAt: null } }),
            prisma.cmpInvoice.count({ where: { occurrenceId: { in: ids }, status: { notIn: ['DRAFT', 'CANCELLED'] } } }),
        ]) : [0, 0];
        out.usage = { messages, invoices };
        return out;
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
        const dates = R.periodDates({ periodStart: ob.basePeriodStart, periodEnd: ob.basePeriodEnd, dueDate: ob.baseDueDate }, seq - ob.baseSeq + 1, ob.frequency);
        if (!manual && R.instants(dates, ob.client.timeZone).dueAt <= now()) return null;
        try {
            const occ = await prisma.cmpOccurrence.create({ data: { tenantId: ob.tenantId, clientId: ob.clientId, obligationId: ob.id, seq, ...occData(dates, ob.client.timeZone), datesConfirmed: false } });
            await audit(req, { tenantId: ob.tenantId, action: 'cmp.occurrence.generate', entityType: 'CmpOccurrence', entityId: occ.id,
                summary: `${ob.name} for ${common.clientLabel(ob.client)}: ${which(ob, { seq, ...dates })} prepared (${datesText(dates)}), dates to confirm${manual ? '' : ' (made when the period before ended)'}`,
                details: { clientId: ob.clientId, obligationId: ob.id } });
            return occ;
        } catch (e) { if (e.code === 'P2002') return null; throw e; }
    }

    // The same obligation twice for one client (the CA: "created double"): its name is already one of the client's obligations that are
    // not archived. Checked in turn with every other add for this client, so two clicks (or two people) cannot both pass.
    const inTurn = (key, work) => prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
        return work(tx);
    }, { maxWait: 10000, timeout: 20000 });
    async function sameName(db, tenantId, clientId, name, exceptId = null) {
        const rows = await db.cmpObligation.findMany({ where: { tenantId, clientId, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true, name: true } });
        return rows.find(r => R.keyOf(r.name) === R.keyOf(name)) || null;
    }
    // Locked by the user (the CA: once everything about an obligation is entered, nothing changes by a wrong touch): no change, archive or
    // delete until it is unlocked
    const isLocked = ob => { if (ob.locked) throw new CmpError(409, `"${ob.name}" is locked. Unlock it (🔒 in the obligations window) to change it.`); };
    const twice = (client, name) => new CmpError(409, `${client.name} already has "${name}". Open it to change it (Edit), or give this one another name (e.g. with the quarter or the year).`);

    async function create(ctx, clientId, b) {
        const client = await common.findClient(ctx.tenantId, clientId, { live: true });
        const o = V.cleanObligation(b || {});
        const rems = V.cleanReminders(b.reminders);
        await common.checkTemplates(ctx.tenantId, rems);
        const assignedToId = (await common.assignee(ctx.tenantId, b.assignedToId)) || null;
        const ob = await inTurn(`${ctx.tenantId}:cmp-obligation:${client.id}`, async tx => {
            if (await sameName(tx, ctx.tenantId, client.id, o.name)) throw twice(client, o.name);
            const row = await tx.cmpObligation.create({ data: { tenantId: ctx.tenantId, clientId: client.id, name: o.name, portalUrl: o.portalUrl, frequency: o.frequency, yearsTotal: o.yearsTotal, notes: o.notes, assignedToId, amberDays: o.amberDays, autoNext: o.autoNext, locked: b.locked === true,
                basePeriodStart: dateOf(o.periodStart), basePeriodEnd: dateOf(o.periodEnd), baseDueDate: dateOf(o.dueDate), createdBy: ctx.email } });
            await tx.cmpOccurrence.create({ data: { tenantId: ctx.tenantId, clientId: client.id, obligationId: row.id, seq: 1, ...occData(o, client.timeZone) } });
            if (rems.length) await tx.cmpReminder.createMany({ data: rems.map(r => ({ tenantId: ctx.tenantId, obligationId: row.id, offsetDays: r.offsetDays, templateId: r.templateId, body: r.body })) });
            return row;
        });
        const names = new Map((await prisma.cmpTemplate.findMany({ where: { id: { in: rems.map(r => r.templateId).filter(Boolean) } }, select: { id: true, name: true } })).map(t => [t.id, t.name]));
        await log(ctx, 'cmp.obligation.create', 'CmpObligation', ob.id, `${o.name} added for ${common.clientLabel(client)}: ${datesText(o)}; ${R.repeatsLabel(o.frequency, o.yearsTotal).toLowerCase()}; reminders: ${remText(rems.map(r => ({ ...r, templateName: names.get(r.templateId) })))}`, { clientId: client.id, obligationId: ob.id });
        // a period that is already over: next year's copy straight away (otherwise the background job makes it when the period ends)
        if (o.autoNext && R.instants(o, client.timeZone).periodEndAt <= now()) await ensureNext(ob.id, { req: ctx.req });
        return get(ctx, ob.id);
    }
    // Several obligations at once (the CA: e.g. the four quarterly VAT returns, each with its own dates typed by hand), with the same
    // years, reminders and the rest. Every one is checked before any is added, so a mistake in the third adds none.
    async function createMany(ctx, clientId, b) {
        const items = Array.isArray(b.items) ? b.items : [];
        if (!items.length) throw bad('Add at least one obligation.');
        if (items.length > 50) throw bad('At most 50 obligations at once.');
        const client = await common.findClient(ctx.tenantId, clientId, { live: true });
        // each obligation may have its own reminders (the CA: 1st, 2nd and 3rd reminder, each a date and a message, per obligation)
        const all = items.map((it, i) => {
            const label = `Obligation ${i + 1}${it && it.name ? ` (${String(it.name).slice(0, 60)})` : ''}`;
            try { const reminders = it && Array.isArray(it.reminders) ? it.reminders : b.reminders; V.cleanReminders(reminders); return { ...b, ...it, ...V.cleanObligation({ ...b, ...it }), reminders }; }
            catch (e) { throw bad(`${label}: ${e.message}`); }
        });
        const names = all.map(o => R.keyOf(o.name));
        if (new Set(names).size !== names.length) throw bad('Two of the obligations have the same name: give each its own (e.g. VAT Return Q1, VAT Return Q2).');
        for (const o of all) if (await sameName(prisma, ctx.tenantId, client.id, o.name)) throw twice(client, o.name);
        for (const o of all) await common.checkTemplates(ctx.tenantId, V.cleanReminders(o.reminders));
        const out = [];
        for (const o of all) out.push(await create(ctx, clientId, { ...o, periodStart: o.periodStart, periodEnd: o.periodEnd, dueDate: o.dueDate }));
        return { obligations: out };
    }

    async function update(ctx, id, b) {
        const ob = await common.findObligation(ctx.tenantId, id, { live: true });
        // unlocked first (then changed in the same request), or changed then locked; a locked one changes nothing else
        const lockTo = b.locked === undefined ? undefined : b.locked === true;
        if (ob.locked && lockTo !== false) { const others = Object.keys(b).filter(k => k !== 'locked'); if (others.length) isLocked(ob); }
        const o = V.cleanObligation(b || {}, { partial: true });
        delete o.periodStart; delete o.periodEnd; delete o.dueDate; // the dates are changed period by period (updateOccurrence)
        if (o.name !== undefined && R.keyOf(o.name) !== R.keyOf(ob.name) && await sameName(prisma, ctx.tenantId, ob.clientId, o.name, ob.id)) throw twice(ob.client, o.name);
        const who = await common.assignee(ctx.tenantId, b.assignedToId);
        if (who !== undefined) o.assignedToId = who;
        if (o.yearsTotal) {
            const top = (await prisma.cmpOccurrence.aggregate({ where: { obligationId: ob.id }, _max: { seq: true } }))._max.seq || 0;
            const perYear = R.freqOf(ob.frequency).perYear;
            if (top > R.periodsAllowed(o.yearsTotal, ob.frequency)) throw bad(`${top} ${perYear === 1 ? 'years are' : 'periods are'} already there: the limit cannot be less than ${Math.ceil(top / perYear)} year(s).`);
        }
        if (lockTo !== undefined) o.locked = lockTo;
        await prisma.cmpObligation.update({ where: { id: ob.id }, data: o });
        const what = [o.locked !== undefined && o.locked !== ob.locked && (o.locked ? 'locked' : 'unlocked'),o.name !== undefined && o.name !== ob.name && `renamed "${ob.name}" → "${o.name}"`, o.portalUrl !== undefined && o.portalUrl !== ob.portalUrl && 'portal link',
            o.yearsTotal !== undefined && o.yearsTotal !== ob.yearsTotal && `repeats: ${R.repeatsLabel(ob.frequency, ob.yearsTotal).toLowerCase()} → ${R.repeatsLabel(ob.frequency, o.yearsTotal).toLowerCase()}`, o.notes !== undefined && o.notes !== ob.notes && 'notes', o.assignedToId !== undefined && o.assignedToId !== ob.assignedToId && 'assigned to someone else',
            o.amberDays !== undefined && o.amberDays !== ob.amberDays && `turns amber ${ob.amberDays} → ${o.amberDays} days before`, o.autoNext !== undefined && o.autoNext !== ob.autoNext && (o.autoNext ? 'next period prepared by itself' : 'next period added by hand')].filter(Boolean);
        if (what.length) await log(ctx, 'cmp.obligation.update', 'CmpObligation', ob.id, `${o.name || ob.name} for ${common.clientLabel(ob.client)}: ${what.join(', ')}`, { clientId: ob.clientId, obligationId: ob.id });
        // more years allowed than before (or "by itself" switched on), and the last one's period is over: the next one can come now
        if ((o.yearsTotal !== undefined || o.autoNext === true) && (o.autoNext ?? ob.autoNext)) {
            const last = await prisma.cmpOccurrence.findFirst({ where: { obligationId: ob.id }, orderBy: { seq: 'desc' } });
            if (last && last.periodEndAt <= now()) await ensureNext(ob.id, { req: ctx.req });
        }
        return get(ctx, ob.id);
    }

    async function setReminders(ctx, id, list) {
        const ob = await common.findObligation(ctx.tenantId, id, { live: true });
        isLocked(ob);
        const rems = V.cleanReminders(list);
        await common.checkTemplates(ctx.tenantId, rems);
        const before = await prisma.cmpReminder.findMany({ where: { obligationId: ob.id }, include: { template: { select: { name: true } } }, orderBy: { offsetDays: 'asc' } });
        await prisma.$transaction(async tx => {
            const keep = new Set(rems.map(r => r.offsetDays));
            await tx.cmpReminder.deleteMany({ where: { obligationId: ob.id, offsetDays: { notIn: [...keep] } } });
            for (const r of rems) {
                const old = before.find(x => x.offsetDays === r.offsetDays);
                if (!old) await tx.cmpReminder.create({ data: { tenantId: ctx.tenantId, obligationId: ob.id, offsetDays: r.offsetDays, templateId: r.templateId, body: r.body } });
                else if (old.templateId !== r.templateId || (old.body || null) !== r.body) await tx.cmpReminder.update({ where: { id: old.id }, data: { templateId: r.templateId, body: r.body } });
            }
        });
        const after = await prisma.cmpReminder.findMany({ where: { obligationId: ob.id }, include: { template: { select: { name: true } } }, orderBy: { offsetDays: 'asc' } });
        const t = rs => remText(rs.map(r => ({ offsetDays: r.offsetDays, templateName: r.template ? r.template.name : '', body: r.body })));
        const changed = t(before) !== t(after) || before.map(r => r.body || '').join('\u0000') !== after.map(r => r.body || '').join('\u0000');
        if (changed) await log(ctx, 'cmp.reminder.update', 'CmpObligation', ob.id, `Reminders of ${ob.name} for ${common.clientLabel(ob.client)}: ${t(before)} → ${t(after)}${t(before) === t(after) ? ' (messages changed)' : ''}`, { clientId: ob.clientId, obligationId: ob.id });
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
        if (b.periodStart !== undefined || b.periodEnd !== undefined || b.dueDate !== undefined || b.applyFuture === true) isLocked(ob);
        const old = { periodStart: ymd(occ.periodStart), periodEnd: ymd(occ.periodEnd), dueDate: ymd(occ.dueDate) };
        const data = {}, what = [];
        let futureBase = null; // these dates, as the pattern from this period on
        if (b.periodStart !== undefined || b.periodEnd !== undefined || b.dueDate !== undefined || b.applyFuture === true) {
            const d = V.cleanDates({ periodStart: b.periodStart ?? old.periodStart, periodEnd: b.periodEnd ?? old.periodEnd, dueDate: b.dueDate ?? old.dueDate });
            const changed = d.periodStart !== old.periodStart || d.periodEnd !== old.periodEnd || d.dueDate !== old.dueDate;
            if (changed) { Object.assign(data, occData(d, client.timeZone), { datesConfirmed: true }); what.push(`${datesText(old)} → ${datesText(d)}`); }
            if (b.applyFuture === true) {
                futureBase = d;
                data.overridden = false;
                what.push('the periods after follow these dates');
            } else if (changed) data.overridden = true;
        }
        if (b.confirm === true && !occ.datesConfirmed && !data.datesConfirmed) { data.datesConfirmed = true; what.push('dates confirmed'); }
        if (b.notes !== undefined) { const n = V.multiline(b.notes, 1000, 'Notes'); if (n !== occ.notes) { data.notes = n; what.push('notes'); } }
        // the notes with the data collection and the task (the CA: if there are any)
        if (b.dataNote !== undefined) { const n = V.multiline(b.dataNote, 1000, 'Note'); if (n !== occ.dataNote) { data.dataNote = n; what.push(`data collection note: ${n || '(removed)'}`); } }
        if (b.taskNote !== undefined) { const n = V.multiline(b.taskNote, 1000, 'Note'); if (n !== occ.taskNote) { data.taskNote = n; what.push(`task note: ${n || '(removed)'}`); } }
        await prisma.$transaction(async tx => {
            await tx.cmpOccurrence.update({ where: { id: occ.id }, data });
            if (futureBase) {
                await tx.cmpObligation.update({ where: { id: ob.id }, data: { basePeriodStart: dateOf(futureBase.periodStart), basePeriodEnd: dateOf(futureBase.periodEnd), baseDueDate: dateOf(futureBase.dueDate), baseSeq: occ.seq } });
                // later periods nobody has confirmed or changed yet take the new pattern
                const later = await tx.cmpOccurrence.findMany({ where: { obligationId: ob.id, seq: { gt: occ.seq }, datesConfirmed: false, overridden: false, stage: { not: 'COMPLETED' } } });
                for (const l of later) await tx.cmpOccurrence.update({ where: { id: l.id }, data: occData(R.periodDates(futureBase, l.seq - occ.seq + 1, ob.frequency), client.timeZone) });
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
            // a step past "Open" means the data was collected (the tracker's Data Collection); back to "Open": not collected
            const data = { stage, ...(stage === 'OPEN' ? { dataCollectedOn: null, dataCollectedBy: null } : occ.dataCollectedOn ? {} : { dataCollectedOn: dateOf(R.dayIn(occ.obligation.client.timeZone, now())), dataCollectedBy: ctx.email }) };
            await prisma.cmpOccurrence.update({ where: { id: occ.id }, data });
            await log(ctx, 'cmp.occurrence.stage', 'CmpOccurrence', occ.id, `${occ.obligation.name} ${period(occ)} for ${common.clientLabel(occ.obligation.client)}: ${STEP_NAMES[occ.stage]} → ${STEP_NAMES[stage]}`, { clientId: occ.clientId, obligationId: occ.obligationId, from: occ.stage, to: stage });
        }
        return get(ctx, occ.obligationId);
    }
    // The data collection of a period (the CA's tracker): the day the client's data came in (on = 'YYYY-MM-DD'), or not yet (on = null)
    async function setDataCollected(ctx, id, on, note) {
        const occ = await common.findOccurrence(ctx.tenantId, id, { live: true });
        if (on === null || on === '') {
            if (occ.stage === 'COMPLETED') throw new CmpError(409, 'The task is completed: reopen it first.');
            if (!occ.dataCollectedOn) return get(ctx, occ.obligationId);
            await prisma.cmpOccurrence.update({ where: { id: occ.id }, data: { dataCollectedOn: null, dataCollectedBy: null, stage: 'OPEN' } });
            await log(ctx, 'cmp.occurrence.data', 'CmpOccurrence', occ.id, `${occ.obligation.name} ${period(occ)} for ${common.clientLabel(occ.obligation.client)}: data collection undone (pending again)`, { clientId: occ.clientId, obligationId: occ.obligationId });
            return get(ctx, occ.obligationId);
        }
        const day = V.day(on, 'The data collection date');
        if (day > R.dayIn(occ.obligation.client.timeZone, now())) throw bad('The data collection date cannot be in the future.');
        const dataNote = note === undefined || note === null ? occ.dataNote : V.multiline(note, 1000, 'Note');
        await prisma.cmpOccurrence.update({ where: { id: occ.id }, data: { dataCollectedOn: dateOf(day), dataCollectedBy: ctx.email, dataNote, ...(occ.stage === 'OPEN' ? { stage: 'DATA_COLLECTED' } : {}) } });
        await log(ctx, 'cmp.occurrence.data', 'CmpOccurrence', occ.id, `${occ.obligation.name} ${period(occ)} for ${common.clientLabel(occ.obligation.client)}: data collected on ${R.fmtDay(day)}${dataNote ? ` (${dataNote})` : ''}`, { clientId: occ.clientId, obligationId: occ.obligationId });
        return get(ctx, occ.obligationId);
    }
    // The task completed (SRS 9, and the CA's tracker: only once the data is collected), on the day chosen (on, else today on the client's
    // clock). mode TASK: the invoice comes next (the tracker shows it pending); INVOICE: an invoice is made for it now (the route makes the
    // draft); FREE: closed without one (free work for family, friends, goodwill). The next period is prepared if it is not there yet.
    // makeInvoice(tx): run in the same transaction as the step (so a period is never "completed with an invoice" without one); returns its id
    async function complete(ctx, id, mode = 'TASK', { makeInvoice, on, note } = {}) {
        if (!['TASK', 'INVOICE', 'FREE'].includes(mode)) throw bad('Choose: generate an invoice, or close without one.');
        const occ = await common.findOccurrence(ctx.tenantId, id, { live: true });
        if (occ.stage === 'COMPLETED') throw new CmpError(409, 'This period is already completed.');
        if (!occ.dataCollectedOn) throw new CmpError(409, 'Mark the data collection first: the task is completed only once the data is collected.');
        const today = R.dayIn(occ.obligation.client.timeZone, now());
        const day = on ? V.day(on, 'The completion date') : today;
        if (day > today) throw bad('The completion date cannot be in the future.');
        if (day < R.ymdOf(occ.dataCollectedOn)) throw bad(`The task cannot be completed before the data was collected (${R.fmtDay(occ.dataCollectedOn)}).`);
        const invoiceId = await prisma.$transaction(async tx => {
            const done = await tx.cmpOccurrence.updateMany({ where: { id: occ.id, stage: { not: 'COMPLETED' } }, data: { stage: 'COMPLETED', closedAt: now(), closedBy: ctx.email, completedOn: dateOf(day), closeKind: mode === 'TASK' ? null : mode,
                ...(note !== undefined && note !== null ? { taskNote: V.multiline(note, 1000, 'Note') } : {}) } });
            if (!done.count) throw new CmpError(409, 'This period is already completed.');
            return mode === 'INVOICE' && makeInvoice ? makeInvoice(tx) : null;
        });
        await log(ctx, 'cmp.occurrence.complete', 'CmpOccurrence', occ.id, `${occ.obligation.name} ${period(occ)} for ${common.clientLabel(occ.obligation.client)}: ${STEP_NAMES[occ.stage]} → Completed on ${R.fmtDay(day)}${mode === 'TASK' ? '' : ` (${mode === 'INVOICE' ? 'with an invoice' : 'closed without an invoice'})`}`, { clientId: occ.clientId, obligationId: occ.obligationId, from: occ.stage, to: 'COMPLETED', closeKind: mode === 'TASK' ? null : mode });
        if (occ.obligation.autoNext) {
            const last = await prisma.cmpOccurrence.findFirst({ where: { obligationId: occ.obligationId }, orderBy: { seq: 'desc' } });
            if (last.id === occ.id) await ensureNext(occ.obligationId, { req: ctx.req });
        }
        const out = await get(ctx, occ.obligationId);
        if (invoiceId) out.invoiceId = invoiceId;
        return out;
    }
    async function reopen(ctx, id) {
        const occ = await common.findOccurrence(ctx.tenantId, id, { live: true });
        if (occ.stage !== 'COMPLETED') throw new CmpError(409, 'This period is not completed.');
        const to = occ.dataCollectedOn ? 'DATA_COLLECTED' : 'OPEN';
        await prisma.cmpOccurrence.update({ where: { id: occ.id }, data: { stage: to, closedAt: null, closedBy: null, closeKind: null, completedOn: null } });
        await log(ctx, 'cmp.occurrence.reopen', 'CmpOccurrence', occ.id, `${occ.obligation.name} ${period(occ)} for ${common.clientLabel(occ.obligation.client)}: reopened (Completed → ${STEP_NAMES[to]})`, { clientId: occ.clientId, obligationId: occ.obligationId, from: 'COMPLETED', to });
        return get(ctx, occ.obligationId);
    }
    // A completed task's billing (the tracker's Invoice Created): FREE = no invoice for it (family, friends, goodwill), '' = an invoice is
    // still to come (pending)
    async function setBilling(ctx, id, mode) {
        const occ = await common.findOccurrence(ctx.tenantId, id, { live: true });
        if (occ.stage !== 'COMPLETED') throw new CmpError(409, 'Complete the task first.');
        const free = String(mode || '').toUpperCase() === 'FREE';
        if (free) {
            const billed = await prisma.cmpInvoice.count({ where: { tenantId: ctx.tenantId, status: { not: 'CANCELLED' }, OR: [{ occurrenceId: occ.id }, { lines: { some: { occurrenceId: occ.id } } }] } });
            if (billed) throw new CmpError(409, 'There is an invoice for this period. Delete the draft (or cancel the invoice) first.');
        }
        const to = free ? 'FREE' : null;
        if (occ.closeKind !== to) {
            await prisma.cmpOccurrence.update({ where: { id: occ.id }, data: { closeKind: to } });
            await log(ctx, 'cmp.occurrence.billing', 'CmpOccurrence', occ.id, `${occ.obligation.name} ${period(occ)} for ${common.clientLabel(occ.obligation.client)}: ${free ? 'no invoice (closed without one)' : 'an invoice is to be made'}`, { clientId: occ.clientId, obligationId: occ.obligationId });
        }
        return get(ctx, occ.obligationId);
    }
    // The dates of a period still to come (Planned, not made yet), from the edit window (the CA: a future period opens the same window):
    // they become the pattern of that period and the ones after it
    async function setPattern(ctx, id, b) {
        const ob = await common.findObligation(ctx.tenantId, id, { live: true });
        isLocked(ob);
        const fromSeq = V.int(b.fromSeq, 1, 100000, 'The period');
        const last = await prisma.cmpOccurrence.findFirst({ where: { obligationId: ob.id }, orderBy: { seq: 'desc' } });
        if (last && fromSeq <= last.seq) throw new CmpError(409, 'That period is already there: change its own dates.');
        const limit = R.periodsAllowed(ob.yearsTotal, ob.frequency);
        if (limit && fromSeq > limit) throw new CmpError(409, 'That period is past the number of years of this obligation.');
        const d = V.cleanDates(b);
        const old = R.periodDates({ periodStart: ob.basePeriodStart, periodEnd: ob.basePeriodEnd, dueDate: ob.baseDueDate }, fromSeq - ob.baseSeq + 1, ob.frequency);
        await prisma.cmpObligation.update({ where: { id: ob.id }, data: { basePeriodStart: dateOf(d.periodStart), basePeriodEnd: dateOf(d.periodEnd), baseDueDate: dateOf(d.dueDate), baseSeq: fromSeq } });
        await log(ctx, 'cmp.obligation.pattern', 'CmpObligation', ob.id, `${ob.name} for ${common.clientLabel(ob.client)}: from the period ${datesText(old)} on, ${datesText(d)}`, { clientId: ob.clientId, obligationId: ob.id });
        return get(ctx, ob.id);
    }
    async function setArchived(ctx, id, archive) {
        const ob = await common.findObligation(ctx.tenantId, id);
        if (archive) isLocked(ob);
        if (Boolean(ob.archivedAt) === archive) throw new CmpError(409, archive ? 'This obligation is already archived.' : 'This obligation is not archived.');
        if (!archive && ob.client.archivedAt) throw new CmpError(409, 'The client is archived. Restore the client first.');
        await prisma.cmpObligation.update({ where: { id: ob.id }, data: archive ? { archivedAt: now(), archivedBy: ctx.email } : { archivedAt: null, archivedBy: null } });
        await log(ctx, archive ? 'cmp.obligation.archive' : 'cmp.obligation.restore', 'CmpObligation', ob.id, `${ob.name} for ${common.clientLabel(ob.client)} ${archive ? 'archived' : 'restored'}`, { clientId: ob.clientId, obligationId: ob.id });
        return get(ctx, ob.id);
    }
    // Deleted for good (the CA). Its periods and reminders go; WhatsApp messages and invoices already made stay in their logs and lists,
    // no longer tied to it. Once a message was sent or an invoice issued for it, a note saying why is required (and kept in the activity log).
    async function remove(ctx, id, b = {}) {
        const ob = await common.findObligation(ctx.tenantId, id);
        isLocked(ob);
        const occs = await prisma.cmpOccurrence.findMany({ where: { obligationId: ob.id }, select: { id: true } }), ids = occs.map(o => o.id);
        const [messages, invoices] = ids.length ? await Promise.all([
            prisma.cmpMessage.count({ where: { occurrenceId: { in: ids }, voidedAt: null } }),
            prisma.cmpInvoice.count({ where: { occurrenceId: { in: ids }, status: { notIn: ['DRAFT', 'CANCELLED'] } } }),
        ]) : [0, 0];
        const note = V.multiline(b.note, 500, 'Note');
        if ((messages || invoices) && !note) throw new CmpError(409, `${[messages && `${messages} WhatsApp message${messages === 1 ? ' was' : 's were'} sent`, invoices && `${invoices} invoice${invoices === 1 ? ' was' : 's were'} issued`].filter(Boolean).join(' and ')} for this obligation. Write a note saying why it is deleted.`);
        await prisma.$transaction(async tx => {
            if (ids.length) {
                await tx.cmpMessage.updateMany({ where: { occurrenceId: { in: ids } }, data: { occurrenceId: null, reminderId: null } });
                await tx.cmpInvoice.updateMany({ where: { occurrenceId: { in: ids } }, data: { occurrenceId: null } });
            }
            await tx.cmpReminder.deleteMany({ where: { obligationId: ob.id } });
            await tx.cmpOccurrence.deleteMany({ where: { obligationId: ob.id } });
            await tx.cmpObligation.delete({ where: { id: ob.id } });
        });
        await log(ctx, 'cmp.obligation.delete', 'CmpObligation', ob.id, `${ob.name} for ${common.clientLabel(ob.client)} deleted (${ids.length} period${ids.length === 1 ? '' : 's'}${messages ? `, ${messages} message${messages === 1 ? '' : 's'} sent` : ''}${invoices ? `, ${invoices} invoice${invoices === 1 ? '' : 's'}` : ''})${note ? `. Note: ${note}` : ''}`,
            { clientId: ob.clientId, obligationId: ob.id, periods: ids.length, messages, invoices, note });
        return { ok: true };
    }

    // What the tracker shows of a period's money (the CA, 16 Nov 2026): its invoice (the latest that is not cancelled, made for the period or
    // with a line for it) with how many times it was sent on WhatsApp, its receipts with theirs, and the advance payments taken for it
    async function billingOf(tenantId, occIds) {
        const out = new Map();
        if (!occIds.length) return out;
        const sel = { id: true, number: true, status: true, currency: true, total: true, received: true, advanceAdjusted: true, advanceUse: true, sentAt: true, occurrenceId: true, createdAt: true,
            lines: { where: { occurrenceId: { in: occIds } }, select: { occurrenceId: true } },
            receipts: { where: { voidedAt: null, settlement: '' }, orderBy: { createdAt: 'asc' }, select: { id: true, number: true, amount: true, receivedOn: true } } };
        const [invs, advs] = await Promise.all([
            prisma.cmpInvoice.findMany({ where: { tenantId, status: { not: 'CANCELLED' }, OR: [{ occurrenceId: { in: occIds } }, { lines: { some: { occurrenceId: { in: occIds } } } }] }, orderBy: { createdAt: 'asc' }, select: sel }),
            prisma.cmpAdvance.findMany({ where: { tenantId, occurrenceId: { in: occIds }, voidedAt: null }, orderBy: { receivedOn: 'asc' } }),
        ]);
        const msgs = invs.length ? await prisma.cmpMessage.findMany({ where: { tenantId, voidedAt: null, OR: [{ invoiceId: { in: invs.map(i => i.id) }, kind: 'INVOICE' }, { receiptId: { in: invs.flatMap(i => i.receipts.map(r => r.id)) } }] }, select: { invoiceId: true, receiptId: true, kind: true } }) : [];
        const sentInv = new Map(), sentRc = new Map();
        for (const m of msgs) { if (m.receiptId) sentRc.set(m.receiptId, (sentRc.get(m.receiptId) || 0) + 1); else if (m.invoiceId) sentInv.set(m.invoiceId, (sentInv.get(m.invoiceId) || 0) + 1); }
        const ensure = id => { if (!out.has(id)) out.set(id, { invoice: null, advances: [] }); return out.get(id); };
        for (const i of invs) {
            const ids = new Set([i.occurrenceId, ...i.lines.map(l => l.occurrenceId)].filter(x => x && occIds.includes(x)));
            const v = { id: i.id, number: i.number, status: i.status, currency: i.currency, total: Number(i.total), received: Number(i.received), advanceAdjusted: Number(i.advanceAdjusted),
                outstanding: Number(i.total) - Number(i.advanceAdjusted) - Number(i.received), sentAt: i.sentAt, sentCount: sentInv.get(i.id) || 0,
                receipts: i.receipts.map(r => ({ id: r.id, number: r.number, amount: Number(r.amount), receivedOn: ymd(r.receivedOn), sentCount: sentRc.get(r.id) || 0 })) };
            for (const id of ids) ensure(id).invoice = v; // (the latest wins: they come oldest first)
        }
        const advView = a => ({ id: a.id, receivedOn: ymd(a.receivedOn), description: a.description, currency: a.currency, amount: Number(a.amount), used: Number(a.used), occurrenceId: a.occurrenceId });
        for (const a of advs) ensure(a.occurrenceId).advances.push(advView(a));
        // and the advances taken off the period's invoice, wherever they were recorded (e.g. from the invoice itself)
        const viaInvoice = invs.flatMap(i => (Array.isArray(i.advanceUse) ? i.advanceUse : []).map(u => u.advanceId)).filter(id => !advs.some(a => a.id === id));
        const more = viaInvoice.length ? await prisma.cmpAdvance.findMany({ where: { tenantId, id: { in: viaInvoice }, voidedAt: null } }) : [];
        for (const x of out.values()) {
            const inv = x.invoice && invs.find(i => i.id === x.invoice.id); if (!inv) continue;
            for (const u of Array.isArray(inv.advanceUse) ? inv.advanceUse : []) { const a = more.find(m => m.id === u.advanceId); if (a && !x.advances.some(y => y.id === a.id)) x.advances.push(advView(a)); }
        }
        return out;
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
            CONFIRM: { datesConfirmed: false, stage: { not: 'COMPLETED' } }, PLANNED: {},
        };
        if (!byStatus[status]) throw bad('Unknown status.');
        AND.push(byStatus[status]);
        if (q.country) AND.push({ obligation: { client: { country: V.country(q.country).code } } });
        const clientIds = q.clientId ? String(q.clientId).split(',').map(x => x.trim()).filter(Boolean).slice(0, 500) : [];
        if (clientIds.length) AND.push({ clientId: { in: clientIds } });
        // the obligation's person, or (when it has none) the client's person
        if (q.assignee) {
            const who = common.assigneeFilter(q.assignee, ctx.userId);
            AND.push(who === null ? { obligation: { assignedToId: null, client: { assignedToId: null } } } : { OR: [{ obligation: { assignedToId: who } }, { obligation: { assignedToId: null, client: { assignedToId: who } } }] });
        }
        const from = q.from ? V.day(q.from, 'From') : null, to = q.to ? V.day(q.to, 'To') : null;
        if (from) AND.push({ dueDate: { gte: dateOf(from) } });
        if (to) AND.push({ dueDate: { lte: dateOf(to) } });
        // a smart search (the CA): every word must match the obligation, the client or its code; words like "overdue", "completed",
        // "upcoming", "pending", "planned" or "locked" choose those periods instead
        const WORDS = { overdue: byStatus.OVERDUE, completed: byStatus.COMPLETED, done: byStatus.COMPLETED, upcoming: byStatus.UPCOMING, pending: byStatus.OPEN, open: byStatus.OPEN, locked: { obligation: { locked: true } } };
        const words = String(q.q || '').trim().slice(0, 100).split(/\s+/).filter(Boolean);
        const wantPlanned = words.some(w => /^planned$/i.test(w)), texts = words.filter(w => !WORDS[w.toLowerCase()] && !/^planned$/i.test(w));
        for (const w of words) if (WORDS[w.toLowerCase()]) AND.push(WORDS[w.toLowerCase()]);
        const searchOf = w => [{ name: ciContains(w) }, { client: { name: ciContains(w) } }, { client: { code: ciContains(w) } }];
        for (const w of texts) AND.push({ OR: searchOf(w).map(x => ({ obligation: x })) });
        const search = texts.length ? texts : null;
        if (wantPlanned && !words.some(w => WORDS[w.toLowerCase()])) AND.push({ id: '-' }); // ("planned": only the periods still to come)
        where.AND = AND;
        // one page at a time (the CA: 25, 50, 75, 100 or all): offset, limit
        const limit = Math.min(Number(q.limit) || 500, 20000), offset = Math.max(0, Math.min(Math.floor(Number(q.offset) || 0), 20000));
        // by due date, then the client's name, then the obligation's (the CA: same date → alphabetically)
        const [rows, total] = status === 'PLANNED' ? [[], 0] : await Promise.all([
            prisma.cmpOccurrence.findMany({ where, orderBy: [{ dueDate: status === 'COMPLETED' ? 'desc' : 'asc' }, { obligation: { client: { name: 'asc' } } }, { obligation: { name: 'asc' } }, { id: 'asc' }], take: Math.min(offset + limit, 20000),
                include: { obligation: { include: { client: true, reminders: { include: { template: { select: { id: true, name: true, active: true } } } } } } } }),
            prisma.cmpOccurrence.count({ where }),
        ]);
        const settings = await common.settings(ctx.tenantId), sent = await sentMap(rows.map(r => r.id));
        const out = rows.map(o => ({
            ...present(o, { reminders: reminderList(o.obligation.reminders), tz: o.obligation.client.timeZone, settings, sent, at, amberDays: o.obligation.amberDays, noWhatsApp: o.obligation.client.noWhatsApp }),
            obligation: { id: o.obligation.id, name: o.obligation.name, frequency: o.obligation.frequency, yearsTotal: o.obligation.yearsTotal, portalUrl: o.obligation.portalUrl, archivedAt: o.obligation.archivedAt, assignedToId: o.obligation.assignedToId, locked: o.obligation.locked },
            client: clientBrief(o.obligation.client),
            assignedToId: o.obligation.assignedToId || o.obligation.client.assignedToId || null,
            invoice: null, advances: [],
        }));
        // The periods still to come (the CA: the calendar and the year show the future, unlimited when it has no end): not stored, only
        // shown as "Planned" until their turn comes (or someone prepares them). Only for a stretch of dates, never for archived ones.
        let planned = [];
        if (q.projected === '1' && from && to && q.archived !== '1' && ['ALL', 'OPEN', 'UPCOMING', 'PLANNED'].includes(status) && R.daysBetween(from, to) <= 20 * 366) {
            const obWhere = { tenantId: ctx.tenantId, archivedAt: null, client: { archivedAt: null } };
            const obAND = [];
            if (q.country) obAND.push({ client: { country: V.country(q.country).code } });
            if (clientIds.length) obAND.push({ clientId: { in: clientIds } });
            if (q.assignee) {
                const who = common.assigneeFilter(q.assignee, ctx.userId);
                obAND.push(who === null ? { assignedToId: null, client: { assignedToId: null } } : { OR: [{ assignedToId: who }, { assignedToId: null, client: { assignedToId: who } }] });
            }
            if (search) for (const w of search) obAND.push({ OR: searchOf(w) });
            if (words.some(w => WORDS[w.toLowerCase()] && w.toLowerCase() !== 'locked')) obAND.push({ id: '-' }); // (a status word: no planned period has one)
            if (words.some(w => w.toLowerCase() === 'locked')) obAND.push({ locked: true });
            obWhere.AND = obAND;
            const obs = await prisma.cmpObligation.findMany({ where: obWhere, take: 5000, include: { client: true, reminders: { select: { id: true, offsetDays: true } }, occurrences: { orderBy: { seq: 'desc' }, take: 1, select: { seq: true } } } });
            const today = R.dayIn(settings.timeZone, at);
            for (const ob of obs) {
                const series = { basePeriodStart: ymd(ob.basePeriodStart), basePeriodEnd: ymd(ob.basePeriodEnd), baseDueDate: ymd(ob.baseDueDate), baseSeq: ob.baseSeq, frequency: ob.frequency, yearsTotal: ob.yearsTotal };
                for (const d of R.projectPeriods(series, (ob.occurrences[0] ? ob.occurrences[0].seq : 0) + 1, to)) {
                    if (d.dueDate < from) continue;
                    planned.push({ id: `plan:${ob.id}:${d.seq}`, seq: d.seq, periodStart: d.periodStart, periodEnd: d.periodEnd, dueDate: d.dueDate, stage: 'OPEN', datesConfirmed: false, overridden: false, notes: '', projected: true,
                        view: { status: 'PLANNED', colour: 'planned', overdue: false, daysLeft: R.daysBetween(today, d.dueDate), actionable: false, inWindow: false, reminders: [] },
                        obligation: { id: ob.id, name: ob.name, frequency: ob.frequency, yearsTotal: ob.yearsTotal, portalUrl: ob.portalUrl, archivedAt: null, assignedToId: ob.assignedToId, locked: ob.locked },
                        client: clientBrief(ob.client), assignedToId: ob.assignedToId || ob.client.assignedToId || null, invoice: null, advances: [],
                        reminderPlan: [...ob.reminders].sort((a, b) => a.offsetDays - b.offsetDays).map(r => ({ id: r.id, offsetDays: r.offsetDays, date: R.addDays(d.dueDate, r.offsetDays) })) });
                    if (planned.length >= 5000) break;
                }
            }
        }
        const all = planned.length ? [...out, ...planned].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0) || a.client.name.localeCompare(b.client.name) || a.obligation.name.localeCompare(b.obligation.name)) : out;
        const page = all.slice(offset, offset + limit);
        // (the money is the invoice permission's; the reports and downloads, which never show it, do not ask for it: money=0)
        const money = q.money === '0' || (ctx.perms && !ctx.perms.has('INVOICE')) ? new Map() : await billingOf(ctx.tenantId, page.filter(r => !r.projected).map(r => r.id));
        for (const r of page) {
            if (r.projected) continue;
            Object.assign(r, money.get(r.id) || {});
            r.progress = R.progress({ ...r, reminders: r.view.reminders });
        }
        return { total: total + planned.length, planned: planned.length, offset, limit, rows: page };
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
                    reminders: ob.reminders.filter(r => r.body || (r.template && r.template.active)).map(r => ({ offsetDays: r.offsetDays, templateId: r.body ? null : r.templateId, body: r.body || null, templateName: r.template ? r.template.name : OWN })), clients: new Set() });
            }
            if (byName.has(k)) byName.get(k).clients.add(ob.clientId);
        }
        const same = [...byName.values()].map(x => ({ ...x, clients: x.clients.size })).sort((a, b) => b.clients - a.clients || a.name.localeCompare(b.name));
        // then every other name the firm has used (the CA: suggestions from what was added before), name only
        const others = await prisma.cmpObligation.findMany({ where: { tenantId: ctx.tenantId }, distinct: ['name'], select: { name: true }, orderBy: { name: 'asc' }, take: 2000 });
        const seen = new Set(same.map(x => R.keyOf(x.name)));
        for (const o of others) { const k = R.keyOf(o.name); if (!seen.has(k)) { seen.add(k); same.push({ name: o.name, otherCountry: true, reminders: [], clients: 0 }); } }
        return same;
    }

    return { sentMap, present, reminderList, get, forClient, ensureNext, create, createMany, update, setReminders, next, updateOccurrence, setStage, setDataCollected, complete, reopen, setBilling, setPattern, setArchived, remove, listOccurrences, suggest, billingOf };
}

module.exports = { createObligations, occData };
