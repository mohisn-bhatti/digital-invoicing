// Dashboard, calendar, reports and exports (SRS 11, 13). Everything is read from the same functions as the screens, so a report or a
// download always matches what the lists show with the same filters.
const R = require('../../public/cmp-rules');
const C = require('../../public/cmp-countries');
const V = require('./validate');
const { bad } = require('./common');
const { csvText } = require('../pos/csv');

const DAY = R.DAY;
const BUCKETS = [['0-30', 0, 30], ['31-60', 31, 60], ['61-90', 61, 90], ['90+', 91, Infinity]];

function createReports({ prisma, audit, common, clients, obligations, comms, invoices, now }) {
    const live = { archivedAt: null, client: { archivedAt: null } };
    const windowDays = v => { const n = Number(v) || 30; if (!Number.isInteger(n) || n < 1 || n > 366) throw bad('Choose a window of 1 to 366 days.'); return n; };
    const team = async tenantId => new Map((await prisma.user.findMany({ where: { tenantId }, select: { id: true, name: true, email: true } })).map(u => [u.id, u.name || u.email]));

    // SRS 11: upcoming (in a 7, 30 or 60-day window) and overdue, with flags; plus the numbers at a glance
    async function dashboard(ctx, q = {}) {
        const days = windowDays(q.days), at = now(), settings = await common.settings(ctx.tenantId), tz = settings.timeZone;
        const [items, open, summary, completedThisMonth, clientCount] = await Promise.all([
            obligations.listOccurrences(ctx, { status: 'OPEN', to: R.addDays(R.dayIn(tz, at), days), limit: 2000 }),
            prisma.cmpOccurrence.findMany({ where: { tenantId: ctx.tenantId, stage: { not: 'COMPLETED' }, obligation: live }, select: { dueAt: true, obligation: { select: { client: { select: { country: true } } } } } }),
            comms.alerts(ctx),
            prisma.cmpOccurrence.count({ where: { tenantId: ctx.tenantId, stage: 'COMPLETED', closedAt: { gte: R.zoned(R.dayIn(tz, at).slice(0, 8) + '01', 0, 0, tz) } } }),
            prisma.cmpClient.count({ where: { tenantId: ctx.tenantId, archivedAt: null } }),
        ]);
        const byCountry = new Map();
        for (const o of open) {
            const c = o.obligation.client.country, x = byCountry.get(c) || { country: c, open: 0, overdue: 0 };
            x.open++; if (o.dueAt <= at) x.overdue++;
            byCountry.set(c, x);
        }
        let unpaid = null;
        if (ctx.perms.has('INVOICE')) {
            const inv = await invoices.list(ctx, { status: 'UNPAID', limit: 20000 });
            const m = new Map();
            for (const i of inv.invoices) { const x = m.get(i.currency) || { currency: i.currency, count: 0, outstanding: 0 }; x.count++; x.outstanding += i.outstanding; m.set(i.currency, x); }
            unpaid = [...m.values()].sort((a, b) => b.outstanding - a.outstanding);
        }
        const overdue = items.rows.filter(r => r.view.overdue), upcoming = items.rows.filter(r => !r.view.overdue);
        return {
            days, summary: { ...summary, overdue: overdue.length, dueInWindow: upcoming.length, completedThisMonth, clients: clientCount, open: open.length },
            overdue, upcoming, byCountry: [...byCountry.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open), unpaid,
        };
    }

    // SRS 11: every due date of a stretch of days (a month on the screen), with its status and colour
    async function calendar(ctx, q = {}) {
        const from = V.day(q.from, 'From'), to = V.day(q.to, 'To');
        if (to < from || R.daysBetween(from, to) > 62) throw bad('Choose up to two months.');
        return obligations.listOccurrences(ctx, { ...q, status: 'ALL', from, to, limit: 3000 });
    }

    // Overdue list, upcoming deadlines (a window of days) and invoice aging (SRS 11)
    async function report(ctx, kind, q = {}) {
        const settings = await common.settings(ctx.tenantId), today = R.dayIn(settings.timeZone, now());
        if (kind === 'overdue') return { kind, rows: (await obligations.listOccurrences(ctx, { ...q, status: 'OVERDUE', limit: 5000 })).rows };
        if (kind === 'upcoming') {
            const days = windowDays(q.days);
            const rows = (await obligations.listOccurrences(ctx, { ...q, status: 'OPEN', from: today, to: R.addDays(today, days), limit: 5000 })).rows.filter(r => !r.view.overdue);
            return { kind, days, rows };
        }
        if (kind === 'aging') {
            const inv = (await invoices.list(ctx, { ...q, status: 'UNPAID', limit: 20000 })).invoices;
            const rows = inv.map(i => {
                const age = Math.max(0, R.daysBetween(i.issueDate, today));
                return { ...i, age, bucket: BUCKETS.find(([, a, b]) => age >= a && age <= b)[0] };
            }).sort((a, b) => b.age - a.age);
            const totals = new Map();
            for (const r of rows) {
                const t = totals.get(r.currency) || { currency: r.currency, ...Object.fromEntries(BUCKETS.map(([k]) => [k, 0])), total: 0, count: 0 };
                t[r.bucket] += r.outstanding; t.total += r.outstanding; t.count++;
                totals.set(r.currency, t);
            }
            return { kind, today, buckets: BUCKETS.map(([k]) => k), rows, totals: [...totals.values()] };
        }
        throw bad('Unknown report.');
    }

    // SRS 13: the lists and reports as a spreadsheet (CSV, opens in Excel), with the filters on the screen
    const KINDS = { clients: 'VIEW', obligations: 'VIEW', invoices: 'INVOICE', receipts: 'INVOICE', overdue: 'REPORTS', upcoming: 'REPORTS', aging: 'REPORTS' };
    async function exportCsv(ctx, kind, q, res) {
        if (!KINDS[kind]) throw bad('Unknown export.');
        const settings = await common.settings(ctx.tenantId), names = await team(ctx.tenantId);
        const who = id => (id ? names.get(id) || '' : '');
        const cur = (n, c) => Number(n).toFixed(C.currencyDecimals(c));
        let head, rows;
        const occRow = r => [r.client.code, r.client.name, r.client.country, r.obligation.name, R.freqOf(r.obligation.frequency).label, R.periodName(r), r.periodStart, r.periodEnd, r.dueDate,
            R.STATUS[r.view.status], r.view.daysLeft, r.datesConfirmed ? 'yes' : 'no', who(r.assignedToId)];
        const occHead = ['Client code', 'Client', 'Country', 'Obligation', 'Repeats', 'Period', 'Period start', 'Period end', 'Due date', 'Status', 'Days left (negative = overdue)', 'Dates confirmed', 'Assigned to'];
        if (kind === 'clients') {
            const d = await clients.list(ctx, q);
            head = ['Code', 'Client', 'Country', 'Time zone', 'Contact number', 'Email', 'Registration No.', 'Reference', 'Assigned to', 'Open obligations', 'Overdue', 'Missing details', 'Archived'];
            rows = d.clients.map(c => [c.code, c.name, c.country, c.timeZone, c.contactNumber, c.email, c.registrationNo, c.reference, who(c.assignedToId), c.openCount, c.overdueCount, c.missing.join('; '), c.archivedAt ? 'yes' : '']);
        } else if (kind === 'obligations') {
            head = occHead; rows = (await obligations.listOccurrences(ctx, { ...q, limit: 20000 })).rows.map(occRow);
        } else if (kind === 'overdue' || kind === 'upcoming') {
            head = occHead; rows = (await report(ctx, kind, q)).rows.map(occRow);
        } else if (kind === 'invoices') {
            head = ['Number', 'Status', 'Client code', 'Client', 'Country', 'For', 'Currency', 'Invoice date', 'Payment due', 'Subtotal', 'Tax', 'Total', 'Received', 'Outstanding', 'Made by'];
            rows = (await invoices.list(ctx, { ...q, limit: 20000 })).invoices.map(i => [i.number || '(draft)', i.status, i.client.code, i.client.name, i.client.country, i.obligation ? `${i.obligation.name} ${R.periodName(i.obligation)}` : '',
                i.currency, i.issueDate, i.dueDate, cur(i.subtotal, i.currency), cur(i.taxTotal, i.currency), cur(i.total, i.currency), cur(i.received, i.currency), cur(i.outstanding, i.currency), i.createdBy]);
        } else if (kind === 'receipts') {
            head = ['Number', 'Date received', 'Client code', 'Client', 'Invoice', 'Currency', 'Amount', 'Paid by', 'Reference', 'Void'];
            rows = (await invoices.listReceipts(ctx, { ...q, limit: 20000 })).map(r => [r.number, r.receivedOn, r.client.code, r.client.name, r.invoice.number, r.currency, cur(r.amount, r.currency), invoices.METHODS[r.method] || r.method, r.reference, r.voidedAt ? `void: ${r.voidReason}` : '']);
        } else {
            const a = await report(ctx, 'aging', q);
            head = ['Invoice', 'Client code', 'Client', 'Currency', 'Invoice date', 'Age (days)', 'Bucket', 'Total', 'Received', 'Outstanding'];
            rows = a.rows.map(i => [i.number, i.client.code, i.client.name, i.currency, i.issueDate, i.age, i.bucket, cur(i.total, i.currency), cur(i.received, i.currency), cur(i.outstanding, i.currency)]);
        }
        await audit(ctx.req, { tenantId: ctx.tenantId, action: `cmp.export.${kind}`, entityType: 'Export', summary: `${kind[0].toUpperCase() + kind.slice(1)} downloaded (${rows.length} rows)` });
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="compliance-${kind}-${R.dayIn(settings.timeZone, now())}.csv"` });
        return res.send('﻿' + [head, ...rows].map(r => r.map(csvText).join(',')).join('\r\n') + '\r\n');
    }

    return { dashboard, calendar, report, exportCsv, KINDS };
}

module.exports = { createReports };
