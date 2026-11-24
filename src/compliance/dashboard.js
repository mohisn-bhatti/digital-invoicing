// The Dashboard (the CA's "Comprehensive Dashboard" SRS, 24 Nov 2026): the deadlines, reminders, data collection, tasks, money and
// activity of the firm in one place, with filters that apply to every part. Everything is worked out from the records as they are:
// nothing is written — no table, no column, no row, not even an activity-log line (the user: "without creating any new data in the DB").
//   - "Tasks" are each obligation's Task step: open once its data is collected, until it is completed.
//   - Reminder statuses are what the firm can know without the WhatsApp Business service: Sent (handed to WhatsApp and confirmed by the
//     user, who marks it "not sent" if it did not go), given another way (phone, email), marked not sent, due, not sent after its day,
//     scheduled. Delivered and read are never claimed (the CA's BR-004 and BR-005).
//   - A period's data collection is late once its last reminder's day (else its due date) has passed without the data.
//   - Missing client information: the client has an additional-information field of its country with no value (the Clients page's
//     "Missing details only").
//   - Money is per currency, never added across currencies; outstanding and unallocated are as of now, the rest for the dates chosen.
const R = require('../../public/cmp-rules');
const C = require('../../public/cmp-countries');
const V = require('./validate');
const { bad } = require('./common');

const PRESETS = ['today', 'week', 'month', 'quarter', 'year', 'lastyear', 'custom'];
const pad = n => String(n).padStart(2, '0');
const dateOf = d => new Date(d + 'T00:00:00Z');
const ymd = R.ymdOf;
const LIMIT = 500; // rows of a table sent at once (each table says how many there are in all)

// The activity timeline: which actions of the log it shows, and how each is called (the CA's FR-065 to FR-080)
const ACTIVITY = {
    'cmp.client.create': ['Client', 'Client created'], 'cmp.client.update': ['Client', 'Client updated'],
    'cmp.obligation.create': ['Obligation', 'Obligation created'], 'cmp.obligation.update': ['Obligation', 'Obligation updated'], 'cmp.obligation.pattern': ['Obligation', 'Obligation dates changed'],
    'cmp.occurrence.update': ['Obligation', 'Obligation period changed'], 'cmp.obligation.archive': ['Obligation', 'Obligation archived'], 'cmp.obligation.restore': ['Obligation', 'Obligation restored'],
    'cmp.obligation.delete': ['Obligation', 'Obligation deleted'], 'cmp.obligation.template': ['Obligation', 'Template update accepted or rejected'],
    'cmp.reminder.update': ['Reminder', 'Reminders scheduled'], 'cmp.message.manual': ['Reminder', 'Reminder given another way'], 'cmp.message.void': ['Reminder', 'Message marked not sent'],
    'cmp.occurrence.data': ['Data collection', 'Data collection updated'], 'cmp.occurrence.complete': ['Task', 'Task completed'], 'cmp.occurrence.reopen': ['Task', 'Task reopened'],
    'cmp.advance.create': ['Advance', 'Advance received'], 'cmp.advance.update': ['Advance', 'Advance changed'], 'cmp.advance.void': ['Advance', 'Advance undone'],
    'cmp.invoice.create': ['Invoice', 'Invoice created'], 'cmp.invoice.issue': ['Invoice', 'Invoice issued'], 'cmp.invoice.sent': ['Invoice', 'Invoice sent'], 'cmp.invoice.cancel': ['Invoice', 'Invoice cancelled'],
    'cmp.receipt.create': ['Receipt', 'Receipt booked'], 'cmp.receipt.void': ['Receipt', 'Receipt undone'],
};

function createDashboard({ prisma, common, clients, obligations, now }) {
    // The dates the period-based figures are for, on the firm's calendar (the CA's FR-001; this month by default)
    function periodOf(q, today) {
        const preset = PRESETS.includes(q.preset) ? q.preset : 'month';
        const [y, m] = today.split('-').map(Number), last = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
        let from, to;
        if (preset === 'today') from = to = today;
        else if (preset === 'week') { from = R.addDays(today, -((new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7)); to = R.addDays(from, 6); }
        else if (preset === 'quarter') { const q0 = Math.floor((m - 1) / 3) * 3 + 1; from = `${y}-${pad(q0)}-01`; to = `${y}-${pad(q0 + 2)}-${pad(last(y, q0 + 2))}`; }
        else if (preset === 'year') { from = `${y}-01-01`; to = `${y}-12-31`; }
        else if (preset === 'lastyear') { from = `${y - 1}-01-01`; to = `${y - 1}-12-31`; }
        else if (preset === 'custom') {
            from = V.day(q.from, 'From'); to = V.day(q.to, 'To');
            if (to < from) throw bad('The end of the dates is before their start.');
            if (R.daysBetween(from, to) > 3700) throw bad('Choose at most ten years.');
        } else { from = `${y}-${pad(m)}-01`; to = `${y}-${pad(m)}-${pad(last(y, m))}`; }
        return { preset, from, to };
    }
    // The filters (the CA's FR-002 to FR-005), checked
    function filtersOf(q) {
        const f = {};
        if (q.country) f.country = V.country(q.country).code;
        if (q.clientId) f.clientId = V.line(q.clientId, 64, 'Client');
        if (q.obligation) f.obligation = V.line(q.obligation, 120, 'Obligation');
        if (q.assignee) f.assignee = V.line(q.assignee, 64, 'Assigned to');
        return f;
    }
    // where-clauses for the same filters, read straight from the tables
    const whoOf = (ctx, f) => (f.assignee ? common.assigneeFilter(f.assignee, ctx.userId) : undefined);
    function clientWhere(ctx, f, { live = true } = {}) {
        const who = whoOf(ctx, f);
        return { tenantId: ctx.tenantId, ...(live ? { archivedAt: null } : {}), ...(f.country ? { country: f.country } : {}), ...(f.clientId ? { id: f.clientId } : {}), ...(who !== undefined ? { assignedToId: who } : {}) };
    }
    function occWhere(ctx, f, extra = []) {
        const AND = [{ obligation: { archivedAt: null, client: { archivedAt: null } } }];
        if (f.country) AND.push({ obligation: { client: { country: f.country } } });
        if (f.clientId) AND.push({ clientId: f.clientId });
        const who = whoOf(ctx, f);
        if (who !== undefined) AND.push(who === null ? { obligation: { assignedToId: null, client: { assignedToId: null } } } : { OR: [{ obligation: { assignedToId: who } }, { obligation: { assignedToId: null, client: { assignedToId: who } } }] });
        if (f.obligation) AND.push({ obligation: { name: { equals: f.obligation, mode: 'insensitive' } } });
        return { tenantId: ctx.tenantId, AND: [...AND, ...extra] };
    }
    // the money of the clients the filters choose (archived clients' documents stay: they are the firm's records)
    function moneyClient(ctx, f) {
        const who = whoOf(ctx, f), c = { ...(f.country ? { country: f.country } : {}), ...(f.clientId ? { id: f.clientId } : {}), ...(who !== undefined ? { assignedToId: who } : {}) };
        return Object.keys(c).length ? { client: c } : {};
    }
    const listArgs = f => ({ money: '0', ...(f.country ? { country: f.country } : {}), ...(f.clientId ? { clientId: f.clientId } : {}), ...(f.assignee ? { assignee: f.assignee } : {}) });
    const sameName = f => r => !f.obligation || R.keyOf(r.obligation.name) === R.keyOf(f.obligation);
    // one period as the tables show it
    const occBrief = r => ({ id: r.id, seq: r.seq, projected: Boolean(r.projected), periodStart: r.periodStart, periodEnd: r.periodEnd, dueDate: r.dueDate, stage: r.stage, datesConfirmed: r.datesConfirmed,
        status: r.projected ? 'PLANNED' : r.view.status, colour: r.projected ? 'planned' : r.view.colour, daysLeft: r.view ? r.view.daysLeft : null, assignedToId: r.assignedToId || null,
        obligation: { id: r.obligation.id, name: r.obligation.name, locked: Boolean(r.obligation.locked) }, client: { id: r.client.id, code: r.client.code, name: r.client.name, country: r.client.country, timeZone: r.client.timeZone, noWhatsApp: r.client.noWhatsApp },
        dataCollectedOn: r.dataCollectedOn || null, completedOn: r.completedOn || null });

    async function overview(ctx, q = {}) {
        const settings = await common.settings(ctx.tenantId), tz = settings.timeZone, at = now(), today = R.dayIn(tz, at);
        const P = periodOf(q, today), f = filtersOf(q);
        const days = (() => { const n = Number(q.days || 30); if (!Number.isInteger(n) || n < 1 || n > 366) throw bad('Choose an upcoming window of 1 to 366 days.'); return n; })();
        const money = ctx.perms.has('INVOICE'), logs = ctx.perms.has('LOGS');
        const pFrom = R.zoned(P.from, 0, 0, tz), pTo = R.zoned(R.addDays(P.to, 1), 0, 0, tz); // (the period's moments, on the firm's clock)

        // every open period (not completed), with its reminders' states, as the tracker works them out; and those still to come in the window
        const [openList, plannedList, completed, team] = await Promise.all([
            obligations.listOccurrences(ctx, { ...listArgs(f), status: 'OPEN', limit: 20000 }),
            obligations.listOccurrences(ctx, { ...listArgs(f), status: 'PLANNED', projected: '1', from: today, to: R.addDays(today, days), limit: 20000 }),
            prisma.cmpOccurrence.findMany({ where: occWhere(ctx, f, [{ stage: 'COMPLETED' }, { OR: [{ completedOn: { gte: dateOf(P.from), lte: dateOf(P.to) } }, { completedOn: null, closedAt: { gte: pFrom, lt: pTo } }] }]),
                orderBy: [{ completedOn: 'desc' }, { closedAt: 'desc' }], take: 5000, select: { id: true, seq: true, periodStart: true, periodEnd: true, dueDate: true, completedOn: true, closedAt: true, closeKind: true, obligationId: true,
                    obligation: { select: { id: true, name: true, assignedToId: true, client: { select: { id: true, code: true, name: true, country: true, assignedToId: true } } } } } }),
            prisma.user.findMany({ where: { tenantId: ctx.tenantId, role: 'CLIENT_USER', active: true }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } }),
        ]);
        const open = openList.rows.filter(sameName(f)), planned = plannedList.rows.filter(sameName(f));
        const overdue = open.filter(r => r.view.overdue).sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
        const upcoming = open.filter(r => !r.view.overdue && r.view.daysLeft <= days);
        const dataPending = open.filter(r => r.stage === 'OPEN'), taskPending = open.filter(r => ['DATA_COLLECTED', 'FILED', 'PAID'].includes(r.stage));
        const lastReminderDay = r => r.view.reminders.reduce((m, x) => (x.date > m ? x.date : m), '') || r.dueDate;
        const clientToday = r => R.dayIn(r.client.timeZone, at);
        const dataLate = dataPending.filter(r => lastReminderDay(r) < clientToday(r));

        // the reminders, with what was sent for each: the valid sends by channel and those marked "not sent"
        const occIds = open.map(r => r.id);
        const msgs = occIds.length ? await prisma.cmpMessage.findMany({ where: { tenantId: ctx.tenantId, occurrenceId: { in: occIds }, reminderId: { not: null } }, orderBy: { createdAt: 'asc' },
            select: { id: true, occurrenceId: true, reminderId: true, channel: true, voidedAt: true, createdAt: true } }) : [];
        const sendsOf = new Map();
        for (const m of msgs) { const k = `${m.occurrenceId}:${m.reminderId}`; if (!sendsOf.has(k)) sendsOf.set(k, []); sendsOf.get(k).push(m); }
        const reminders = [];
        for (const r of open) r.view.reminders.forEach((x, i) => {
            const s = sendsOf.get(`${r.id}:${x.id}`) || [], valid = s.filter(m => !m.voidedAt), voided = s.filter(m => m.voidedAt), last = valid[valid.length - 1];
            const status = valid.length ? (last.channel === 'WHATSAPP' ? 'SENT' : 'OTHER_WAY') : x.state === 'CLOSED' ? 'NOT_NEEDED' : voided.length && x.state !== 'BLEAK' ? 'MARKED_NOT_SENT'
                : x.state === 'HIGHLIGHTED' ? 'DUE' : x.state === 'MISSED' ? 'MISSED' : 'SCHEDULED';
            reminders.push({ occurrence: occBrief(r), reminderId: x.id, n: i + 1, date: x.date, fireAt: x.fireAt, templateName: x.templateName || '', status, sends: valid.length, voided: voided.length,
                channel: last ? last.channel : '', lastSentAt: last ? last.createdAt : null });
        });
        const remCount = st => reminders.filter(x => x.status === st).length;
        // the reminders sent (or given another way, or marked not sent) in the dates chosen, whatever the period's state now
        const periodMsgs = await prisma.cmpMessage.findMany({ where: { tenantId: ctx.tenantId, kind: 'REMINDER', createdAt: { gte: pFrom, lt: pTo }, ...(Object.keys(moneyClient(ctx, f)).length ? moneyClient(ctx, f) : {}),
            ...(f.obligation ? { occurrence: { obligation: { name: { equals: f.obligation, mode: 'insensitive' } } } } : {}) }, select: { channel: true, voidedAt: true } });

        // the clients (the CA's FR-011, FR-012): not archived; with missing additional information as the Clients page counts it
        const [activeClients, newClients, missingList] = await Promise.all([
            prisma.cmpClient.count({ where: clientWhere(ctx, f) }),
            prisma.cmpClient.count({ where: { ...clientWhere(ctx, f, { live: false }), createdAt: { gte: pFrom, lt: pTo } } }), // (8.3: the date the client was added)
            clients.list(ctx, { missing: '1', ...(f.country ? { country: f.country } : {}), ...(f.assignee ? { assignee: f.assignee } : {}) }),
        ]);
        const missing = (missingList.clients || []).filter(c => !f.clientId || c.id === f.clientId);

        const kpis = {
            activeClients, newClients, missingInfo: missing.length, open: open.length, overdue: overdue.length, upcoming: upcoming.length, remindersDue: remCount('DUE') + remCount('MISSED') + remCount('MARKED_NOT_SENT'),
            dataPending: dataPending.length, taskPending: taskPending.length,
        };
        const workflow = {
            CONFIRM: open.filter(r => !r.datesConfirmed).length, PLANNED: planned.length, UPCOMING: open.filter(r => r.view.status === 'UPCOMING').length, OPEN: open.length, OVERDUE: overdue.length,
            PERIOD_CLOSED: open.filter(r => r.view.status === 'PERIOD_CLOSED').length, DATA_PENDING: dataPending.length, DATA_COLLECTED: open.filter(r => r.stage === 'DATA_COLLECTED').length,
            FILED: open.filter(r => r.stage === 'FILED').length, PAID: open.filter(r => r.stage === 'PAID').length, COMPLETED: completed.length,
        };
        const lastReminder = r => {
            const past = r.view.reminders.map((x, i) => ({ x, i })).filter(e => e.x.state !== 'BLEAK');
            if (!past.length) return null;
            const e = past[past.length - 1], s = (sendsOf.get(`${r.id}:${e.x.id}`) || []).filter(m => !m.voidedAt);
            return { n: e.i + 1, date: e.x.date, status: s.length ? (s[s.length - 1].channel === 'WHATSAPP' ? 'SENT' : 'OTHER_WAY') : e.x.state === 'CLOSED' ? 'NOT_NEEDED' : 'NOT_SENT', sends: s.length };
        };
        const withReminders = r => ({ ...occBrief(r), reminders: r.view.reminders.map((x, i) => ({ n: i + 1, id: x.id, date: x.date, button: x.button, sentCount: x.sentCount || 0 })), lastReminder: lastReminder(r) });

        const out = {
            generatedAt: at, today, timeZone: tz, period: P, days, filters: f, money, logs,
            team: team.map(u => ({ id: u.id, name: u.name || u.email })),
            obligationNames: [...new Set((await prisma.cmpObligation.findMany({ where: { tenantId: ctx.tenantId, archivedAt: null, client: { archivedAt: null, ...(f.country ? { country: f.country } : {}), ...(f.clientId ? { id: f.clientId } : {}) } },
                select: { name: true }, take: 3000 })).map(o => o.name.trim()))].sort((a, b) => a.localeCompare(b)).slice(0, 500),
            clientsList: (await prisma.cmpClient.findMany({ where: { tenantId: ctx.tenantId, archivedAt: null, ...(f.country ? { country: f.country } : {}) }, select: { id: true, code: true, name: true, country: true }, orderBy: { name: 'asc' }, take: 3000 })),
            kpis,
            upcoming: { total: upcoming.length, rows: upcoming.slice(0, LIMIT).map(withReminders) },
            overdue: { total: overdue.length, rows: overdue.slice(0, LIMIT).map(r => ({ ...withReminders(r), daysOverdue: -r.view.daysLeft })) },
            workflow,
            reminders: {
                counts: { DUE: remCount('DUE'), MISSED: remCount('MISSED'), MARKED_NOT_SENT: remCount('MARKED_NOT_SENT'), SCHEDULED: remCount('SCHEDULED'), SENT: remCount('SENT'), OTHER_WAY: remCount('OTHER_WAY'), NOT_NEEDED: remCount('NOT_NEEDED') },
                inPeriod: { sent: periodMsgs.filter(m => !m.voidedAt && m.channel === 'WHATSAPP').length, otherWay: periodMsgs.filter(m => !m.voidedAt && m.channel !== 'WHATSAPP').length, markedNotSent: periodMsgs.filter(m => m.voidedAt).length },
                // the ones to act on first, then those still to come (soonest first), then those sent
                rows: [...reminders.filter(x => ['DUE', 'MISSED', 'MARKED_NOT_SENT'].includes(x.status)).sort((a, b) => (a.date < b.date ? -1 : 1)),
                    ...reminders.filter(x => x.status === 'SCHEDULED').sort((a, b) => (a.date < b.date ? -1 : 1)),
                    ...reminders.filter(x => ['SENT', 'OTHER_WAY'].includes(x.status)).sort((a, b) => (+new Date(b.lastSentAt) - +new Date(a.lastSentAt)))].slice(0, LIMIT),
            },
            data: {
                pending: dataPending.length, late: dataLate.length,
                collected: open.filter(r => r.dataCollectedOn).length,
                collectedInPeriod: (await prisma.cmpOccurrence.count({ where: occWhere(ctx, f, [{ dataCollectedOn: { gte: dateOf(P.from), lte: dateOf(P.to) } }]) })),
                rows: dataPending.map(r => ({ ...occBrief(r), deadline: lastReminderDay(r), late: lastReminderDay(r) < clientToday(r) })).sort((a, b) => (a.deadline < b.deadline ? -1 : 1)).slice(0, LIMIT),
            },
            tasks: {
                pending: taskPending.length, dueToday: taskPending.filter(r => r.view.daysLeft === 0).length,
                upcoming: taskPending.filter(r => !r.view.overdue && r.view.daysLeft > 0 && r.view.daysLeft <= days).length, overdue: taskPending.filter(r => r.view.overdue).length, completed: completed.length,
                rows: taskPending.map(occBrief).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1)).slice(0, LIMIT),
                completedRows: completed.slice(0, LIMIT).map(o => ({ id: o.id, seq: o.seq, periodStart: ymd(o.periodStart), periodEnd: ymd(o.periodEnd), dueDate: ymd(o.dueDate), completedOn: o.completedOn ? ymd(o.completedOn) : R.dayIn(tz, o.closedAt),
                    noInvoice: o.closeKind === 'FREE', obligation: { id: o.obligation.id, name: o.obligation.name }, client: o.obligation.client, assignedToId: o.obligation.assignedToId || o.obligation.client.assignedToId || null })),
            },
        };

        // by country and by person (the CA's phase 3: country-wise and staff workload)
        const byCountry = new Map(), byPerson = new Map();
        const bump = (map, k, field) => { if (!map.has(k)) map.set(k, { key: k, clients: 0, open: 0, overdue: 0, upcoming: 0, dataPending: 0, taskPending: 0 }); map.get(k)[field]++; };
        for (const r of open) {
            for (const [map, k] of [[byCountry, r.client.country], [byPerson, r.assignedToId || '']]) {
                bump(map, k, 'open'); if (r.view.overdue) bump(map, k, 'overdue'); else if (r.view.daysLeft <= days) bump(map, k, 'upcoming');
                if (r.stage === 'OPEN') bump(map, k, 'dataPending'); else bump(map, k, 'taskPending');
            }
        }
        for (const c of await prisma.cmpClient.findMany({ where: clientWhere(ctx, f), select: { country: true, assignedToId: true }, take: 20000 })) { bump(byCountry, c.country, 'clients'); bump(byPerson, c.assignedToId || '', 'clients'); }
        out.byCountry = [...byCountry.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open);
        out.byPerson = [...byPerson.values()].map(x => ({ ...x, name: x.key ? ((team.find(u => u.id === x.key) || {}).name || (team.find(u => u.id === x.key) || {}).email || 'A former user') : 'Nobody' })).sort((a, b) => b.overdue - a.overdue || b.open - a.open);

        // money (the CA's FR-042 to FR-064): only for those who may see the invoices
        if (money) out.finance = await finance(ctx, f, P, today);

        // the activity timeline (FR-065 to FR-080): only for those who may see the logs
        if (logs) { out.activity = await activity(ctx, f, pFrom, pTo, tz); out.communication = await communication(ctx, f, pFrom, pTo); }

        // the alerts to act on (FR-081 to FR-087): worked out now, never stored
        const failed = ctx.perms.has('FULL') ? await prisma.cmpNotification.count({ where: { tenantId: ctx.tenantId, status: 'FAILED' } }) : 0;
        out.alerts = [
            ['MARKED_NOT_SENT', 'high', remCount('MARKED_NOT_SENT'), 'reminder(s) marked "not sent" and not sent again'],
            ['OVERDUE', 'critical', overdue.length, 'obligation(s) past the due date and not completed'],
            ['MISSED', 'high', remCount('MISSED'), 'reminder(s) not sent after their day'],
            ['DUE_SOON', 'high', open.filter(r => !r.view.overdue && r.view.daysLeft <= 7).length, 'obligation(s) due in the next 7 days'],
            ['CONFIRM', 'high', workflow.CONFIRM, 'obligation period(s) with dates to confirm'],
            ['DATA_LATE', 'medium', dataLate.length, 'data collection(s) late (past the last reminder)'],
            ['MISSING', 'medium', missing.length, 'client(s) with missing information'],
            ['FAILED_NOTIFICATIONS', 'high', failed, 'notification(s) that could not be made (tried again by themselves)'],
        ].filter(a => a[2] > 0).map(([key, level, count, text]) => ({ key, level, count, text }));
        return out;
    }

    async function finance(ctx, f, P, today) {
        const mc = moneyClient(ctx, f);
        const obl = f.obligation ? { occurrence: { obligation: { name: { equals: f.obligation, mode: 'insensitive' } } } } : {};
        const [advs, invs, rcs] = await Promise.all([
            prisma.cmpAdvance.findMany({ where: { tenantId: ctx.tenantId, voidedAt: null, ...mc, ...obl }, take: 20000, select: { id: true, number: true, receivedOn: true, currency: true, amount: true, used: true, client: { select: { id: true, code: true, name: true, country: true } } } }),
            prisma.cmpInvoice.findMany({ where: { tenantId: ctx.tenantId, ...mc, ...obl }, take: 20000, select: { id: true, number: true, status: true, currency: true, issueDate: true, total: true, advanceAdjusted: true, received: true, sentAt: true, createdAt: true,
                client: { select: { id: true, code: true, name: true, country: true } } } }),
            prisma.cmpReceipt.findMany({ where: { tenantId: ctx.tenantId, receivedOn: { gte: dateOf(P.from), lte: dateOf(P.to) }, ...(Object.keys(mc).length || f.obligation ? { invoice: { ...(mc.client ? { client: mc.client } : {}), ...obl } } : {}) },
                take: 20000, select: { amount: true, method: true, voidedAt: true, settlement: true, invoice: { select: { currency: true } } } }),
        ]);
        const per = new Map(), cur = c => { if (!per.has(c)) per.set(c, { currency: c, d: C.currencyDecimals(c), adv: { received: 0, receivedCount: 0, adjusted: 0, unallocated: 0, count: 0 }, inv: { invoiced: 0, net: 0, outstanding: 0, unpaid: 0 }, rc: { total: 0, count: 0, undone: 0, undoneCount: 0, methods: {} } }); return per.get(c); };
        const m = (x, n) => Math.round(Number(n) * 10 ** x.d);
        const inP = d => d && ymd(d) >= P.from && ymd(d) <= P.to;
        // advances: received in the dates chosen; adjusted = taken off the invoices issued in those dates; unallocated = what is left now
        const byClient = new Map();
        for (const a of advs) {
            const x = cur(a.currency), left = m(x, a.amount) - m(x, a.used);
            x.adv.unallocated += left; x.adv.count++;
            if (inP(a.receivedOn)) { x.adv.received += m(x, a.amount); x.adv.receivedCount++; }
            const k = `${a.client.id}:${a.currency}`;
            if (!byClient.has(k)) byClient.set(k, { client: a.client, currency: a.currency, received: 0, adjusted: 0, remaining: 0, lastOn: '', d: x.d });
            const b = byClient.get(k); b.received += m(x, a.amount); b.adjusted += m(x, a.used); b.remaining += left; if (ymd(a.receivedOn) > b.lastOn) b.lastOn = ymd(a.receivedOn);
        }
        // invoices: drafts now; those issued in the dates chosen by their status now; invoiced (gross) and net; outstanding now
        const counts = { DRAFT: 0, ISSUED: 0, SENT: 0, PARTIAL: 0, RECEIVED: 0, CANCELLED: 0 };
        const outstanding = [];
        // (8.3) invoices created in the dates chosen, by the day they were created, drafts included
        const pFrom = R.zoned(P.from, 0, 0, (await common.settings(ctx.tenantId)).timeZone), pTo = R.zoned(R.addDays(P.to, 1), 0, 0, (await common.settings(ctx.tenantId)).timeZone);
        const createdInPeriod = invs.filter(i => +i.createdAt >= +pFrom && +i.createdAt < +pTo);
        const created = { count: createdInPeriod.length, drafts: createdInPeriod.filter(i => i.status === 'DRAFT').length };
        for (const i of invs) {
            if (i.status === 'DRAFT') { counts.DRAFT++; continue; }
            const x = cur(i.currency), issued = inP(i.issueDate);
            if (issued) {
                counts[i.status] = (counts[i.status] || 0) + 1;
                if (i.status !== 'CANCELLED') { x.inv.invoiced += m(x, i.total); x.inv.net += m(x, i.total) - m(x, i.advanceAdjusted); x.adv.adjusted += m(x, i.advanceAdjusted); }
            }
            if (['ISSUED', 'SENT', 'PARTIAL'].includes(i.status)) {
                const owed = m(x, i.total) - m(x, i.advanceAdjusted) - m(x, i.received);
                if (owed > 0) { x.inv.outstanding += owed; x.inv.unpaid++; outstanding.push({ id: i.id, number: i.number, status: i.status, currency: i.currency, issueDate: ymd(i.issueDate), client: i.client,
                    gross: Number(i.total), advanceAdjusted: Number(i.advanceAdjusted), received: Number(i.received), outstanding: owed / 10 ** x.d, age: i.issueDate ? R.daysBetween(ymd(i.issueDate), today) : 0 }); }
            }
        }
        // receipts booked in the dates chosen: the valid ones (not undone, not refunded or kept as credit when an invoice was cancelled), by method
        for (const r of rcs) {
            const x = cur(r.invoice.currency);
            if (r.voidedAt) { x.rc.undone += m(x, r.amount); x.rc.undoneCount++; continue; }
            if (r.settlement) continue;
            x.rc.total += m(x, r.amount); x.rc.count++; x.rc.methods[r.method] = (x.rc.methods[r.method] || 0) + m(x, r.amount);
        }
        const fix = (x, n) => n / 10 ** x.d;
        return {
            counts, created,
            currencies: [...per.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map(x => ({ currency: x.currency,
                advances: { received: fix(x, x.adv.received), receivedCount: x.adv.receivedCount, adjusted: fix(x, x.adv.adjusted), unallocated: fix(x, x.adv.unallocated), count: x.adv.count },
                invoices: { invoiced: fix(x, x.inv.invoiced), net: fix(x, x.inv.net), outstanding: fix(x, x.inv.outstanding), unpaid: x.inv.unpaid },
                receipts: { total: fix(x, x.rc.total), count: x.rc.count, undone: fix(x, x.rc.undone), undoneCount: x.rc.undoneCount, methods: Object.fromEntries(Object.entries(x.rc.methods).map(([k, v]) => [k, fix(x, v)])) } })),
            advancesByClient: [...byClient.values()].filter(b => b.received > 0).sort((a, b) => b.remaining - a.remaining || a.client.name.localeCompare(b.client.name)).slice(0, LIMIT)
                .map(b => ({ client: b.client, currency: b.currency, received: b.received / 10 ** b.d, adjusted: b.adjusted / 10 ** b.d, remaining: b.remaining / 10 ** b.d, lastOn: b.lastOn })),
            outstanding: { total: outstanding.length, rows: outstanding.sort((a, b) => b.age - a.age).slice(0, LIMIT) },
        };
    }

    // The communication log (the CA's 3.4.3, COM-01 to COM-08): every message of the dates chosen — reminders, advance receipts,
    // invoices, receipts and others — with its template, how it went (WhatsApp, or another way), whether it was marked not sent, what it
    // is about and who sent it
    async function communication(ctx, f, pFrom, pTo) {
        const mc = moneyClient(ctx, f);
        const where = { tenantId: ctx.tenantId, createdAt: { gte: pFrom, lt: pTo }, ...mc };
        if (f.obligation) where.OR = [{ occurrence: { obligation: { name: { equals: f.obligation, mode: 'insensitive' } } } }, { invoice: { occurrence: { obligation: { name: { equals: f.obligation, mode: 'insensitive' } } } } }];
        const rows = await prisma.cmpMessage.findMany({ where, orderBy: { createdAt: 'desc' }, take: LIMIT,
            select: { id: true, createdAt: true, kind: true, channel: true, templateName: true, voidedAt: true, userEmail: true, clientId: true, occurrenceId: true, invoiceId: true, advanceId: true,
                client: { select: { id: true, code: true, name: true, country: true } }, occurrence: { select: { seq: true, periodStart: true, periodEnd: true, obligationId: true, obligation: { select: { name: true } } } },
                invoice: { select: { number: true } }, receipt: { select: { number: true, invoiceId: true } }, advance: { select: { number: true } } } });
        const total = await prisma.cmpMessage.count({ where });
        return { total, rows: rows.map(m => ({ id: m.id, at: m.createdAt, kind: m.kind, channel: m.channel, templateName: m.templateName, user: m.userEmail, client: m.client,
            status: m.voidedAt ? 'MARKED_NOT_SENT' : m.channel === 'WHATSAPP' ? 'SENT' : 'OTHER_WAY',
            related: m.receipt ? `Receipt ${m.receipt.number}` : m.invoice ? `Invoice ${m.invoice.number}` : m.advance ? `Advance ${m.advance.number}` : m.occurrence ? `${m.occurrence.obligation.name} · ${R.periodName(m.occurrence)}` : '',
            link: m.receipt ? { invoice: m.receipt.invoiceId } : m.invoiceId ? { invoice: m.invoiceId } : m.advanceId ? { advance: m.advanceId } : m.occurrence ? { period: [m.occurrence.obligationId, m.occurrenceId] } : { client: m.clientId } })) };
    }

    async function activity(ctx, f, pFrom, pTo, tz) {
        const filtered = f.country || f.clientId || f.assignee;
        const allowed = filtered ? new Set((await prisma.cmpClient.findMany({ where: clientWhere(ctx, f, { live: false }), select: { id: true }, take: 20000 })).map(c => c.id)) : null;
        // the Obligation filter (FR-010): the obligations of that name, and the invoices, receipts and advances of their periods
        let obIds = null, docIds = null;
        if (f.obligation) {
            const obs = await prisma.cmpObligation.findMany({ where: { tenantId: ctx.tenantId, name: { equals: f.obligation, mode: 'insensitive' } }, select: { id: true }, take: 5000 });
            obIds = new Set(obs.map(o => o.id));
            const occ = { occurrence: { obligationId: { in: [...obIds] } } };
            const [invs, advs] = await Promise.all([prisma.cmpInvoice.findMany({ where: { tenantId: ctx.tenantId, ...occ }, select: { id: true }, take: 5000 }), prisma.cmpAdvance.findMany({ where: { tenantId: ctx.tenantId, ...occ }, select: { id: true }, take: 5000 })]);
            docIds = new Set([...invs.map(i => i.id), ...advs.map(a => a.id)]);
        }
        const aboutOb = (r, d) => !obIds || (d.obligationId && obIds.has(d.obligationId)) || (r.entityType === 'CmpObligation' && obIds.has(r.entityId))
            || (['CmpInvoice', 'CmpAdvance'].includes(r.entityType) && docIds.has(r.entityId)) || (r.entityType === 'CmpReceipt' && d.invoiceId && docIds.has(d.invoiceId));
        const [rows, msgs] = await Promise.all([
            prisma.auditLog.findMany({ where: { tenantId: ctx.tenantId, action: { in: Object.keys(ACTIVITY) }, createdAt: { gte: pFrom, lt: pTo } }, orderBy: { createdAt: 'desc' }, take: 600,
                select: { id: true, createdAt: true, action: true, summary: true, userEmail: true, entityType: true, entityId: true, details: true } }),
            // (WhatsApp sends of reminders, advance receipts and receipts are in the WhatsApp log; an invoice sent is in the activity log already)
            prisma.cmpMessage.findMany({ where: { tenantId: ctx.tenantId, kind: { in: ['REMINDER', 'ADVANCE', 'RECEIPT'] }, channel: 'WHATSAPP', createdAt: { gte: pFrom, lt: pTo } }, orderBy: { createdAt: 'desc' }, take: 300,
                select: { id: true, createdAt: true, kind: true, userEmail: true, clientId: true, occurrenceId: true, receiptId: true, advanceId: true, invoiceId: true, voidedAt: true, templateName: true,
                    client: { select: { name: true, code: true } }, occurrence: { select: { obligationId: true, obligation: { select: { name: true } } } } } }),
        ]);
        const names = new Map((await prisma.cmpClient.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.map(r => r.details && r.details.clientId).filter(Boolean))] } }, select: { id: true, name: true, code: true } })).map(c => [c.id, c]));
        const items = [];
        for (const r of rows) {
            const d = r.details || {}, clientId = d.clientId || (r.entityType === 'CmpClient' ? r.entityId : null);
            if (allowed && !(clientId && allowed.has(clientId))) continue;
            if (!aboutOb(r, d)) continue;
            const [type, label] = ACTIVITY[r.action];
            const link = r.entityType === 'CmpInvoice' ? { invoice: r.entityId } : r.entityType === 'CmpReceipt' && d.invoiceId ? { invoice: d.invoiceId } : r.entityType === 'CmpAdvance' ? { advance: r.entityId }
                : r.entityType === 'CmpOccurrence' && d.obligationId ? { period: [d.obligationId, r.entityId] } : clientId ? { client: clientId } : null;
            const c = clientId ? names.get(clientId) : null;
            items.push({ at: r.createdAt, type, label, summary: r.summary, user: r.userEmail, client: c ? `${c.name} (${c.code})` : '', link });
            // an advance taken off an invoice when it was issued: the CA's "Advance adjusted" (FR-074)
            if (r.action === 'cmp.invoice.issue' && / less advance /.test(r.summary)) items.push({ at: r.createdAt, type: 'Advance', label: 'Advance adjusted', summary: r.summary, user: r.userEmail, client: c ? `${c.name} (${c.code})` : '', link });
        }
        for (const m of msgs) {
            if (allowed && !allowed.has(m.clientId)) continue;
            if (obIds && !(m.occurrence && obIds.has(m.occurrence.obligationId)) && !(m.advanceId && docIds.has(m.advanceId))) continue;
            const what = { REMINDER: ['Reminder', 'Reminder sent on WhatsApp'], ADVANCE: ['Advance', 'Advance receipt sent on WhatsApp'], RECEIPT: ['Receipt', 'Receipt sent on WhatsApp'] }[m.kind];
            items.push({ at: m.createdAt, type: what[0], label: what[1] + (m.voidedAt ? ' (later marked not sent)' : ''), summary: [m.occurrence ? m.occurrence.obligation.name : '', m.templateName].filter(Boolean).join(' · '),
                user: m.userEmail, client: `${m.client.name} (${m.client.code})`, link: m.occurrence ? { period: [m.occurrence.obligationId, m.occurrenceId] } : m.advanceId ? { advance: m.advanceId } : { client: m.clientId } });
        }
        items.sort((a, b) => +new Date(b.at) - +new Date(a.at));
        return { total: items.length, rows: items.slice(0, 200), timeZone: tz };
    }

    // The calendar (FR-019 to FR-026): due dates (with the periods still to come), reminder dates and task dates, for a month, a week or a
    // day, each on its client's own calendar day
    async function calendar(ctx, q = {}) {
        const from = V.day(q.from, 'From'), to = V.day(q.to, 'To');
        if (to < from || R.daysBetween(from, to) > 62) throw bad('Choose up to two months.');
        const f = filtersOf(q), keep = sameName(f);
        const rows = (await obligations.listOccurrences(ctx, { ...listArgs(f), status: 'ALL', from: R.addDays(from, -366), to: R.addDays(to, 366), projected: '1', limit: 20000 })).rows.filter(keep);
        const inR = d => d && d >= from && d <= to, out = [];
        for (const r of rows) {
            const b = occBrief(r);
            if (inR(r.dueDate)) out.push({ type: 'due', date: r.dueDate, occurrence: b });
            if (r.projected) { for (const [i, p] of (r.reminderPlan || []).entries()) if (inR(p.date)) out.push({ type: 'reminder', date: p.date, n: i + 1, planned: true, occurrence: b }); }
            else {
                r.view.reminders.forEach((x, i) => { if (inR(x.date)) out.push({ type: 'reminder', date: x.date, n: i + 1, state: x.state, button: x.button, sentCount: x.sentCount || 0, templateName: x.templateName || '', occurrence: b }); });
                if (r.completedOn && inR(r.completedOn)) out.push({ type: 'task', date: r.completedOn, occurrence: b });
            }
        }
        out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : ['due', 'reminder', 'task'].indexOf(a.type) - ['due', 'reminder', 'task'].indexOf(b.type)));
        return { from, to, entries: out.slice(0, 6000) };
    }

    function registerRoutes({ route, can }) {
        // the whole Dashboard for the filters chosen (the money and the activity only for those who may see them)
        route('get', '/api/cmp/overview', can('REPORTS'), (req, ctx) => overview(ctx, req.query));
        // its calendar: those who may only view see it too (as before)
        route('get', '/api/cmp/overview/calendar', can('VIEW'), (req, ctx) => calendar(ctx, req.query));
    }
    return { overview, calendar, registerRoutes };
}

// each route and the permission(s) it asks for (test/cmpRouteGuards.test.js checks them)
const ROUTE_PERMS = { 'GET /api/cmp/overview': ['REPORTS'], 'GET /api/cmp/overview/calendar': ['VIEW'] };

module.exports = { createDashboard, ROUTE_PERMS };
