// Message templates (SRS 7), WhatsApp messages and their log (SRS 8), and the notifications dashboard (SRS 6, 11).
// A WhatsApp message is opened in WhatsApp (Web or the app) with the text filled in; the person presses Send there. The log keeps what
// was handed to WhatsApp; the user can mark a message "not sent" if they did not send it after all.
const R = require('../../public/cmp-rules');
const C = require('../../public/cmp-countries');
const V = require('./validate');
const { CmpError, bad, ciContains } = require('./common');
const { csvText } = require('../pos/csv');

function createComms({ prisma, audit, common, clients, obligations, invoices, now }) {
    const log = (ctx, action, entityType, entityId, summary, details) => audit(ctx.req, { tenantId: ctx.tenantId, action, entityType, entityId, summary, details });

    /* ---------- templates ---------- */
    async function listTemplates(ctx, q = {}) {
        const rows = await prisma.cmpTemplate.findMany({ where: { tenantId: ctx.tenantId, ...(q.all === '1' ? {} : { active: true }) }, orderBy: [{ active: 'desc' }, { name: 'asc' }], include: { _count: { select: { reminders: true } } } });
        return rows.map(t => ({ id: t.id, name: t.name, purpose: t.purpose, body: t.body, active: t.active, reminders: t._count.reminders, updatedBy: t.updatedBy || t.createdBy, updatedAt: t.updatedAt }));
    }
    const taken = e => { if (e && e.code === 'P2002') throw new CmpError(409, 'There is already a template with that name.'); throw e; };
    async function createTemplate(ctx, b) {
        const d = V.cleanTemplate(b || {});
        const t = await prisma.cmpTemplate.create({ data: { tenantId: ctx.tenantId, ...d, createdBy: ctx.email, updatedBy: ctx.email } }).catch(taken);
        await log(ctx, 'cmp.template.create', 'CmpTemplate', t.id, `Template "${t.name}" added (${R.TEMPLATE_PURPOSES[t.purpose].toLowerCase()})`);
        return t;
    }
    async function findTemplate(ctx, id) {
        const t = await prisma.cmpTemplate.findFirst({ where: { id: String(id || ''), tenantId: ctx.tenantId }, include: { _count: { select: { reminders: true } } } });
        if (!t) throw new CmpError(404, 'Template not found.');
        return t;
    }
    async function updateTemplate(ctx, id, b) {
        const t = await findTemplate(ctx, id);
        const d = V.cleanTemplate(b || {}, { partial: true });
        if (d.active === false && t._count.reminders) throw new CmpError(409, `"${t.name}" is used by ${t._count.reminders} reminder(s). Choose another template for them first.`);
        const upd = await prisma.cmpTemplate.update({ where: { id: t.id }, data: { ...d, updatedBy: ctx.email } }).catch(taken);
        const what = [d.name !== undefined && d.name !== t.name && `renamed "${t.name}" → "${d.name}"`, d.purpose !== undefined && d.purpose !== t.purpose && `for ${R.TEMPLATE_PURPOSES[d.purpose].toLowerCase()}`,
            d.body !== undefined && d.body !== t.body && 'message changed', d.active !== undefined && d.active !== t.active && (d.active ? 'back in use' : 'retired')].filter(Boolean);
        if (what.length) await log(ctx, 'cmp.template.update', 'CmpTemplate', t.id, `Template "${upd.name}": ${what.join(', ')}`);
        return upd;
    }
    async function deleteTemplate(ctx, id) {
        const t = await findTemplate(ctx, id);
        if (t._count.reminders) throw new CmpError(409, `"${t.name}" is used by ${t._count.reminders} reminder(s). Choose another template for them first.`);
        await prisma.cmpTemplate.delete({ where: { id: t.id } }); // the messages already sent keep its name (CmpMessage.templateName)
        await log(ctx, 'cmp.template.delete', 'CmpTemplate', t.id, `Template "${t.name}" deleted`);
        return { ok: true };
    }

    /* ---------- one message ---------- */
    // Everything a message can say about the client, the obligation year and the firm (never the portal password or PIN)
    async function contextFor(ctx, client, occ) {
        const fields = {};
        for (const f of await clients.fieldsOf(ctx.tenantId, client)) if (!f.missing) fields[f.name] = f.type === 'DATE' ? R.fmtDay(f.value) : f.value;
        const settings = await common.settings(ctx.tenantId), wa = phoneFor(client, fields);
        return { client, countryName: common.countryName(client.country), whatsapp: wa ? '+' + wa : '', obligationName: occ ? occ.obligation.name : '', portalUrl: occ ? occ.obligation.portalUrl : '',
            daysLeft: occ ? R.daysBetween(R.dayIn(client.timeZone, now()), R.ymdOf(occ.dueDate)) : null, occurrence: occ || {}, fields,
            firm: { name: settings.firmName, phone: settings.firmPhone, email: settings.firmEmail } };
    }
    // The number WhatsApp gets: the client's "WhatsApp Number" field if it has one, else its contact number (SRS 8)
    function phoneFor(client, fields) {
        const dial = (C.get(client.country) || {}).dial;
        const wa = Object.entries(fields).find(([name]) => R.keyOf(name) === 'whatsapp number');
        return (wa && R.waPhone(wa[1], dial)) || R.waPhone(client.contactNumber, dial) || '';
    }
    // What a message is about, checked: the client, optionally a year of one of its obligations and one of that obligation's reminders.
    // A reminder can only be sent once its time has come (SRS 6: a bleak reminder has no WhatsApp button).
    async function resolve(ctx, b) {
        const kind = String(b.kind || (b.reminderId ? 'REMINDER' : b.receiptId ? 'RECEIPT' : b.invoiceId ? 'INVOICE' : 'OTHER')).toUpperCase();
        if (!R.MESSAGE_KINDS[kind]) throw bad('Unknown kind of message.');
        let occ = null, reminder = null, money = null;
        // an invoice or receipt (SRS 9: WhatsApp on both): the client is the invoice's
        if (b.invoiceId || b.receiptId) {
            money = await invoices.messageContext(ctx, { invoiceId: b.invoiceId, receiptId: b.receiptId });
            if (!b.clientId) b = { ...b, clientId: money.inv.clientId };
            else if (b.clientId !== money.inv.clientId) throw bad('That invoice is not this client\'s.');
        }
        if (b.occurrenceId) {
            occ = await common.findOccurrence(ctx.tenantId, b.occurrenceId, { live: true });
            if (b.clientId && b.clientId !== occ.clientId) throw bad('That obligation is not this client\'s.');
        }
        const client = occ ? occ.obligation.client : await common.findClient(ctx.tenantId, b.clientId, { live: true });
        if (client.noWhatsApp) throw new CmpError(409, `${client.name} has no WhatsApp (ticked on the client's details). Untick it there to send WhatsApp messages.`);
        if (b.reminderId) {
            if (!occ) throw bad('A reminder message needs the obligation year it is for.');
            reminder = occ.obligation.reminders.find(r => r.id === b.reminderId);
            if (!reminder) throw bad('That reminder is not one of this obligation\'s.');
            const settings = await common.settings(ctx.tenantId);
            const sent = await obligations.sentMap([occ.id]);
            const state = R.reminderStates(occ, obligations.reminderList([reminder]), { tz: client.timeZone, hour: settings.reminderHour, now: now(), sent: sent.get(occ.id) || new Map() })[0];
            if (state.state === 'BLEAK') throw new CmpError(409, `This reminder is not due yet: it becomes active on ${R.fmtAt(state.fireAt, client.timeZone)} (${C.zoneCity(client.timeZone)} time).`);
            if (state.state === 'CLOSED') throw new CmpError(409, 'This period is completed: its reminders are closed.');
        }
        let template = null;
        const templateId = b.templateId || (reminder && reminder.templateId);
        if (templateId) {
            template = await prisma.cmpTemplate.findFirst({ where: { id: String(templateId), tenantId: ctx.tenantId } });
            if (!template) throw bad('Template not found.');
        }
        return { kind, occ, client, reminder, template, money };
    }
    // The text and the number, ready for the person to read and change before it goes to WhatsApp
    async function prepare(ctx, b) {
        const { kind, occ, client, template, money } = await resolve(ctx, b || {});
        const c = { ...(await contextFor(ctx, client, occ)), ...(money ? money.ctx : {}) };
        const r = template ? R.render(template.body, c) : { text: '', missing: [], empty: [] };
        return { kind, body: r.text, missing: r.missing, empty: r.empty, phone: phoneFor(client, c.fields), templateId: template ? template.id : null, templateName: template ? template.name : '',
            client: { id: client.id, code: client.code, name: client.name, country: client.country } };
    }
    // Logs the message and gives back the WhatsApp link to open
    async function send(ctx, b) {
        const { kind, occ, client, reminder, template, money } = await resolve(ctx, b || {});
        const body = V.multiline(b.body, 4000, 'Message', { required: true });
        const phone = R.waPhone(b.phone, (C.get(client.country) || {}).dial);
        if (!phone) throw bad('Enter the WhatsApp number with its country code (8 to 15 digits).');
        // the firm's number it goes from (chosen in the window; the default one if not said)
        const senders = (await common.settings(ctx.tenantId)).waSenders || [];
        const from = b.fromId ? senders.find(s => s.id === b.fromId) : senders.find(s => s.isDefault);
        if (b.fromId && !from) throw bad('That WhatsApp number is not one of the firm\'s any more. Reload the page.');
        const m = await prisma.cmpMessage.create({ data: { tenantId: ctx.tenantId, clientId: client.id, occurrenceId: occ ? occ.id : null, reminderId: reminder ? reminder.id : null,
            templateId: template ? template.id : null, templateName: template ? template.name : '', kind, phone, fromPhone: from ? from.phone : '', fromLabel: from ? from.label : '', body, userId: ctx.userId || null, userEmail: ctx.email,
            invoiceId: money && money.inv ? money.inv.id : null, receiptId: money && money.receipt ? money.receipt.id : null } });
        // an issued invoice handed to WhatsApp counts as sent (SRS 9: Draft, Issued, Sent ...)
        if (money && money.inv && kind === 'INVOICE' && !money.inv.sentAt) await invoices.markSent(ctx, money.inv.id, 'on WhatsApp');
        return { url: R.waUrl(phone, body), to: phone, text: body, open: from ? from.open : 'ANY', from: from ? { label: from.label, phone: from.phone } : null, message: { id: m.id, createdAt: m.createdAt } };
    }
    async function voidMessage(ctx, id) {
        const m = await prisma.cmpMessage.findFirst({ where: { id: String(id || ''), tenantId: ctx.tenantId }, include: { client: true } });
        if (!m) throw new CmpError(404, 'Message not found.');
        if (m.voidedAt) throw new CmpError(409, 'This message is already marked as not sent.');
        await prisma.cmpMessage.update({ where: { id: m.id }, data: { voidedAt: now(), voidedBy: ctx.email } });
        await log(ctx, 'cmp.message.void', 'CmpMessage', m.id, `WhatsApp message to ${common.clientLabel(m.client)} of ${m.createdAt.toISOString().slice(0, 10)} marked as not sent`, { clientId: m.clientId });
        return { ok: true };
    }

    /* ---------- the log ---------- */
    async function listMessages(ctx, q = {}, res) {
        const settings = await common.settings(ctx.tenantId);
        const where = { tenantId: ctx.tenantId };
        if (q.clientId) where.clientId = String(q.clientId);
        if (q.kind) { const k = String(q.kind).toUpperCase(); if (!R.MESSAGE_KINDS[k]) throw bad('Unknown kind of message.'); where.kind = k; }
        const createdAt = {};
        if (q.from) createdAt.gte = R.zoned(V.day(q.from, 'From'), 0, 0, settings.timeZone);
        if (q.to) createdAt.lt = R.zoned(R.addDays(V.day(q.to, 'To'), 1), 0, 0, settings.timeZone);
        if (q.before) { const d = new Date(String(q.before)); if (!Number.isNaN(d.getTime())) createdAt.lt = createdAt.lt && createdAt.lt < d ? createdAt.lt : d; }
        if (Object.keys(createdAt).length) where.createdAt = createdAt;
        const s = String(q.q || '').trim().slice(0, 100);
        if (s) where.OR = [{ client: { name: ciContains(s) } }, { client: { code: ciContains(s) } }, { body: ciContains(s) }, { templateName: ciContains(s) }];
        const include = { invoice: { select: { number: true } }, receipt: { select: { number: true } }, client: { select: { id: true, code: true, name: true, country: true } }, occurrence: { select: { id: true, seq: true, periodStart: true, periodEnd: true, dueDate: true, obligation: { select: { id: true, name: true } } } }, reminder: { select: { offsetDays: true } } };
        const view = m => ({ id: m.id, createdAt: m.createdAt, kind: m.kind, client: m.client, templateName: m.templateName, phone: m.phone, fromPhone: m.fromPhone, fromLabel: m.fromLabel, body: m.body, userEmail: m.userEmail, voidedAt: m.voidedAt, voidedBy: m.voidedBy,
            obligation: m.occurrence ? { id: m.occurrence.obligation.id, name: m.occurrence.obligation.name, seq: m.occurrence.seq, periodStart: R.ymdOf(m.occurrence.periodStart), periodEnd: R.ymdOf(m.occurrence.periodEnd), dueDate: R.ymdOf(m.occurrence.dueDate) } : null,
            reminder: m.reminder ? R.offsetLabel(m.reminder.offsetDays) : '', invoiceNumber: m.invoice ? m.invoice.number : '', receiptNumber: m.receipt ? m.receipt.number : '' });
        if (q.format === 'csv') {
            const rows = await prisma.cmpMessage.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: 20000 });
            const head = [`Time (${C.zoneCity(settings.timeZone)})`, 'Client code', 'Client', 'Country', 'About', 'Obligation', 'Period', 'Due date', 'Reminder / document', 'Template', 'To', 'From', 'Message', 'Sent by', 'Marked not sent'];
            const lines = [head.join(',')].concat(rows.map(view).map(m => [R.fmtAt(m.createdAt, settings.timeZone), m.client.code, m.client.name, m.client.country, R.MESSAGE_KINDS[m.kind],
                m.obligation ? m.obligation.name : '', m.obligation ? `${R.fmtDay(m.obligation.periodStart)} – ${R.fmtDay(m.obligation.periodEnd)}` : '', m.obligation ? R.fmtDay(m.obligation.dueDate) : '',
                [m.reminder, m.invoiceNumber && `invoice ${m.invoiceNumber}`, m.receiptNumber && `receipt ${m.receiptNumber}`].filter(Boolean).join(', '), m.templateName, '+' + m.phone, m.fromPhone ? `${m.fromLabel} ${m.fromPhone}` : '', m.body, m.userEmail, m.voidedAt ? `${R.fmtAt(m.voidedAt, settings.timeZone)} by ${m.voidedBy}` : ''].map(csvText).join(',')));
            await log(ctx, 'cmp.log.export', null, null, `WhatsApp log downloaded (${rows.length} messages)`);
            res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="whatsapp-log.csv"' });
            return res.send('﻿' + lines.join('\r\n') + '\r\n');
        }
        const limit = Math.min(Number(q.limit) || 100, 300);
        const rows = await prisma.cmpMessage.findMany({ where, include, orderBy: { createdAt: 'desc' }, take: limit + 1 });
        return res.json({ messages: rows.slice(0, limit).map(view), more: rows.length > limit, timeZone: settings.timeZone });
    }

    /* ---------- notifications (SRS 6, 11) ---------- */
    // Every open year that is in its notification window (from the end of its period, or its first reminder, until it is closed),
    // with each reminder's state; overdue ones first, then those with a reminder to send, then by due date.
    async function notifications(ctx, q = {}) {
        const at = now(), settings = await common.settings(ctx.tenantId);
        const where = { tenantId: ctx.tenantId, stage: { not: 'COMPLETED' }, periodEndAt: { lte: new Date(+at + 400 * R.DAY) }, obligation: { archivedAt: null, client: { archivedAt: null } } };
        if (q.country) where.obligation.client.country = V.country(q.country).code;
        const s = String(q.q || '').trim().slice(0, 100);
        if (s) where.OR = [{ obligation: { name: ciContains(s) } }, { obligation: { client: { name: ciContains(s) } } }, { obligation: { client: { code: ciContains(s) } } }];
        const rows = await prisma.cmpOccurrence.findMany({ where, take: 3000, orderBy: { dueDate: 'asc' },
            include: { obligation: { include: { client: true, reminders: { include: { template: { select: { id: true, name: true, active: true } } } } } } } });
        const sent = await obligations.sentMap(rows.map(r => r.id));
        const items = rows.map(o => ({
            ...obligations.present(o, { reminders: obligations.reminderList(o.obligation.reminders), tz: o.obligation.client.timeZone, settings, sent, at, amberDays: o.obligation.amberDays, noWhatsApp: o.obligation.client.noWhatsApp }),
            obligation: { id: o.obligation.id, name: o.obligation.name, portalUrl: o.obligation.portalUrl, yearsTotal: o.obligation.yearsTotal },
            client: { id: o.obligation.client.id, code: o.obligation.client.code, name: o.obligation.client.name, country: o.obligation.client.country, timeZone: o.obligation.client.timeZone, noWhatsApp: o.obligation.client.noWhatsApp },
        })).filter(x => x.view.inWindow || x.view.overdue);
        const summary = {
            overdue: items.filter(x => x.view.overdue).length,
            ready: items.filter(x => x.view.actionable).length,
            waiting: items.filter(x => !x.view.overdue && !x.view.actionable).length,
            confirm: await prisma.cmpOccurrence.count({ where: { tenantId: ctx.tenantId, datesConfirmed: false, stage: { not: 'COMPLETED' }, obligation: { archivedAt: null, client: { archivedAt: null } } } }),
        };
        const show = String(q.show || 'all');
        const shown = items.filter(x => show === 'overdue' ? x.view.overdue : show === 'ready' ? x.view.actionable : show === 'waiting' ? !x.view.overdue && !x.view.actionable : true);
        const firstActive = x => Math.min(...x.view.reminders.filter(r => r.state === 'HIGHLIGHTED' || r.state === 'MISSED').map(r => +r.fireAt), Infinity);
        shown.sort((a, b) => (b.view.overdue - a.view.overdue) || (a.view.overdue && b.view.overdue ? a.view.daysLeft - b.view.daysLeft : 0)
            || (b.view.actionable - a.view.actionable) || (firstActive(a) - firstActive(b)) || (+a.view.dueAt - +b.view.dueAt));
        return { summary, items: shown, settings };
    }
    // The counts for the bell and the pop-up: overdue and dates-to-confirm are counted by the database; "ready" needs each reminder's
    // state, worked out from the few columns it depends on (a reminder is at most 366 days from its due date)
    async function alerts(ctx) {
        const at = now(), settings = await common.settings(ctx.tenantId);
        const live = { archivedAt: null, client: { archivedAt: null } };
        const [overdue, confirm, rows] = await Promise.all([
            prisma.cmpOccurrence.count({ where: { tenantId: ctx.tenantId, stage: { not: 'COMPLETED' }, dueAt: { lte: at }, obligation: live } }),
            prisma.cmpOccurrence.count({ where: { tenantId: ctx.tenantId, datesConfirmed: false, stage: { not: 'COMPLETED' }, obligation: live } }),
            prisma.cmpOccurrence.findMany({ where: { tenantId: ctx.tenantId, stage: { not: 'COMPLETED' }, obligation: { ...live, client: { archivedAt: null, noWhatsApp: false }, reminders: { some: {} } }, dueAt: { gte: new Date(+at - 367 * R.DAY), lte: new Date(+at + 367 * R.DAY) } },
                select: { id: true, periodEnd: true, dueDate: true, stage: true, obligation: { select: { client: { select: { timeZone: true } }, reminders: { select: { id: true, offsetDays: true } } } } } }),
        ]);
        const sent = await obligations.sentMap(rows.map(r => r.id));
        const ready = rows.filter(o => R.reminderStates(o, o.obligation.reminders, { tz: o.obligation.client.timeZone, hour: settings.reminderHour, now: at, sent: sent.get(o.id) || new Map() })
            .some(r => r.state === 'HIGHLIGHTED' || r.state === 'MISSED')).length;
        return { overdue, ready, confirm };
    }

    // The templates page (the CA): pick a client and see every placeholder with that client's real value, in groups, to write a
    // template with. The obligation is the one asked for, else the client's next open one; the invoice and receipt its latest ones.
    async function templateContext(ctx, q = {}) {
        const client = await common.findClient(ctx.tenantId, q.clientId);
        let occ = null;
        if (q.occurrenceId) { occ = await common.findOccurrence(ctx.tenantId, q.occurrenceId); if (occ.clientId !== client.id) throw bad('That obligation is not this client\'s.'); }
        else occ = await prisma.cmpOccurrence.findFirst({ where: { clientId: client.id, stage: { not: 'COMPLETED' }, obligation: { archivedAt: null } }, orderBy: { dueDate: 'asc' }, include: { obligation: true } })
            || await prisma.cmpOccurrence.findFirst({ where: { clientId: client.id }, orderBy: { dueDate: 'desc' }, include: { obligation: true } });
        const c = await contextFor(ctx, client, occ);
        const inv = ctx.perms.has('INVOICE') ? await prisma.cmpInvoice.findFirst({ where: { clientId: client.id, status: { notIn: ['DRAFT', 'CANCELLED'] } }, orderBy: { issuedAt: 'desc' }, select: { id: true } }) : null;
        const rc = ctx.perms.has('INVOICE') ? await prisma.cmpReceipt.findFirst({ where: { clientId: client.id, voidedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true } }) : null;
        if (inv) Object.assign(c, (await invoices.messageContext(ctx, { invoiceId: inv.id })).ctx);
        if (rc) c.receipt = (await invoices.messageContext(ctx, { receiptId: rc.id })).ctx.receipt;
        const fieldNames = (await clients.fieldsOf(ctx.tenantId, client)).map(f => f.name);
        const value = name => { const r = R.render(`[${name}]`, c); return r.missing.length ? '' : r.text; };
        const groups = R.PLACEHOLDER_GROUPS.map(([title, names]) => ({ title, items: names.map(name => ({ name, value: value(name) })) }));
        groups.splice(1, 0, { title: 'Additional information', items: fieldNames.map(name => ({ name, value: value(name) })) });
        const obligationsList = await prisma.cmpOccurrence.findMany({ where: { clientId: client.id, obligation: { archivedAt: null } }, orderBy: { dueDate: 'desc' }, take: 50, include: { obligation: { select: { name: true } } } });
        // (the context goes to the browser: the client's plain details only, never its stored password or PIN, even encrypted)
        const safe = { ...c, client: Object.fromEntries(['name', 'code', 'registrationNo', 'email', 'contactNumber', 'address', 'reference', 'country'].map(k => [k, client[k]])),
            occurrence: occ ? { periodStart: R.ymdOf(occ.periodStart), periodEnd: R.ymdOf(occ.periodEnd), dueDate: R.ymdOf(occ.dueDate) } : {} };
        return { client: { id: client.id, code: client.code, name: client.name, country: client.country }, occurrenceId: occ ? occ.id : null, ctx: safe, groups,
            periods: obligationsList.map(o => ({ id: o.id, name: o.obligation.name, period: R.periodName(o), dueDate: R.ymdOf(o.dueDate) })) };
    }

    return { listTemplates, createTemplate, updateTemplate, deleteTemplate, prepare, send, voidMessage, listMessages, notifications, alerts, templateContext };
}

module.exports = { createComms };
