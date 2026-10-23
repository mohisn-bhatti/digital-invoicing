// Point of Sale filters and reports.
//
// One set of filters (dates, counter, branch, cashier, how it was paid, sale or return, customer, item, category, tax rate, bill size)
// is used by the sales list, the spreadsheet and the reports. It is applied in two ways: as a Prisma condition (the list, the
// spreadsheet) and as SQL (the reports, which add things up). They sit side by side in this file so they cannot drift apart, and a test
// checks that a report's invoice count equals the list's total for the same filters.
//
// Figures cover one kind of sale at a time: the test sales while the server is in test mode, the real ones once it is live
// (`env`). Money is added up in the database as exact numbers and rounded to the paisa here.
const { Prisma } = require('@prisma/client');
const { PosError } = require('./errors');
const C = require('./calc');
const { ciEquals, ciContains, contains } = require('./like');

const STATES = ['DRAFT', 'AWAITING_FISCALIZATION', 'OUTCOME_UNKNOWN', 'FISCALIZED', 'REJECTED', 'CANCELLED'];
const TYPE_OF = { sale: [1, 2], return: [3] }; // a debit note is money in, like a sale: the report counts it with the sales, so the list's "sales" does too
const MAX_REPORT_DAYS = 400; // a report adds up every line in the range: a year and a bit is the most it takes in one go
const money2 = n => Math.round(Number(n || 0) * 100) / 100;
const qty4 = n => Math.round(Number(n || 0) * 10000) / 10000;
const text = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

// "from"/"to" are Pakistan calendar days (YYYY-MM-DD), both included. A day that does not exist (2026-02-31, month 13) is refused.
const realDay = (value, what) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
    const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new PosError(400, `${what} must be a real date, written like 2026-10-19.`);
    return m[0];
};
const dayStart = day => new Date(`${day}T00:00:00+05:00`);
const dayEnd = day => new Date(`${day}T23:59:59.999+05:00`);
// createdAt is a timestamp without a zone that holds UTC. In SQL the bounds are written as the same kind of value (UTC, no zone) so the two
// are compared as they are: a Date bound as a parameter is a timestamp WITH a zone, and the database would then read the column in its own
// session's time zone, which moves the day by hours wherever that is not UTC.
const utcText = date => date.toISOString().replace('T', ' ').replace('Z', '');
const daysBetween = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);

// What the person asked for, checked. Anything not given is left out (no filter). Returns only what was given.
function cleanFilters(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const given = k => r[k] !== undefined && r[k] !== null && String(r[k]).trim() !== '';
    const f = {};
    if (given('from')) f.from = realDay(r.from, 'The "from" date');
    if (given('to')) f.to = realDay(r.to, 'The "to" date');
    if (f.from && f.to && f.from > f.to) throw new PosError(400, 'The "from" date is after the "to" date.');
    for (const k of ['counterId', 'branchId', 'customerId', 'itemId']) if (given(k)) f[k] = text(r[k], 64);
    if (given('itemCode')) f.itemCode = text(r.itemCode, 50); // what a report row is keyed by (an item's code is on every sale line)
    if (given('env')) { // test (sandbox) or real (production) sales: what a report row counted is only one of the two
        const e = String(r.env).trim().toUpperCase();
        if (e !== 'SANDBOX' && e !== 'PRODUCTION') throw new PosError(400, 'Choose test (sandbox) or real (production) sales.');
        f.env = e;
    }
    if (given('cashier')) f.cashier = text(r.cashier, 120);
    if (given('category')) f.category = text(r.category, 60); // '__none' = items with no category
    if (given('paymentMode')) {
        const n = Number(String(r.paymentMode).trim());
        if (!Number.isInteger(n) || n < 1 || n > 6) throw new PosError(400, 'Choose how the sale was paid.');
        f.paymentMode = n;
    }
    if (given('invoiceType')) {
        const t = String(r.invoiceType).trim().toLowerCase();
        if (!TYPE_OF[t]) throw new PosError(400, 'Choose sales or returns.');
        f.invoiceType = t;
    }
    if (given('taxRate')) {
        const s = String(r.taxRate).trim();
        if (!/^\d{1,3}(\.\d{1,2})?$/.test(s) || Number(s) > 100) throw new PosError(400, 'The tax rate must be a number between 0 and 100.');
        f.taxRate = Number(s);
    }
    for (const [k, what] of [['minAmount', 'The smallest bill'], ['maxAmount', 'The largest bill']]) {
        if (!given(k)) continue;
        const s = String(r[k]).trim();
        if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) throw new PosError(400, `${what} must be an amount in rupees.`);
        f[k] = Number(s);
    }
    if (f.minAmount !== undefined && f.maxAmount !== undefined && f.minAmount > f.maxAmount) throw new PosError(400, 'The smallest bill is more than the largest.');
    if (given('state')) { if (!STATES.includes(String(r.state))) throw new PosError(400, 'Choose a status from the list.'); f.state = String(r.state); }
    if (given('q')) f.q = text(r.q, 60);
    return f;
}

// ---------- the filters as a Prisma condition (the sales list and the spreadsheet) ----------
function saleWhere(tenantId, f) {
    const where = { tenantId };
    const range = {};
    if (f.from) range.gte = dayStart(f.from);
    if (f.to) range.lte = dayEnd(f.to);
    if (Object.keys(range).length) where.createdAt = range;
    if (f.state) where.state = f.state;
    if (f.env) where.env = f.env;
    if (f.counterId) where.counterId = f.counterId;
    if (f.branchId) where.counter = { branchId: f.branchId };
    if (f.cashier) where.createdBy = ciEquals(f.cashier);
    if (f.paymentMode) where.paymentMode = f.paymentMode;
    if (f.invoiceType) where.invoiceType = { in: TYPE_OF[f.invoiceType] };
    if (f.customerId) where.customerId = f.customerId === 'none' ? null : f.customerId;
    if (f.minAmount !== undefined || f.maxAmount !== undefined) where.totalBill = { ...(f.minAmount !== undefined ? { gte: f.minAmount } : {}), ...(f.maxAmount !== undefined ? { lte: f.maxAmount } : {}) };
    const line = {};
    if (f.itemId) line.itemId = f.itemId;
    if (f.itemCode) line.itemCode = f.itemCode;
    if (f.category !== undefined) line.category = f.category === '__none' ? '' : f.category;
    if (f.taxRate !== undefined) line.taxRate = f.taxRate;
    if (Object.keys(line).length) where.lines = { some: line };
    if (f.q) where.OR = [{ usin: contains(f.q) }, { fiscalNumber: ciContains(f.q) }, { buyerName: ciContains(f.q) }];
    return where;
}

// ---------- the same filters as SQL (the reports), over PosSaleLine l joined to PosSale s ----------
function sqlConditions(tenantId, f, env) {
    const c = [Prisma.sql`s."tenantId" = ${tenantId}`, Prisma.sql`s."state" = 'FISCALIZED'::"PosSaleState"`, Prisma.sql`s."env" = ${env}::"PosEnv"`];
    if (f.env) c.push(Prisma.sql`s."env" = ${f.env}::"PosEnv"`); // (and the report's own, above: asking for the other kind gives nothing)
    if (f.from) c.push(Prisma.sql`s."createdAt" >= ${utcText(dayStart(f.from))}::timestamp`);
    if (f.to) c.push(Prisma.sql`s."createdAt" <= ${utcText(dayEnd(f.to))}::timestamp`);
    if (f.counterId) c.push(Prisma.sql`s."counterId" = ${f.counterId}`);
    if (f.branchId) c.push(Prisma.sql`s."counterId" IN (SELECT "id" FROM "PosCounter" WHERE "tenantId" = ${tenantId} AND "branchId" = ${f.branchId})`);
    if (f.cashier) c.push(Prisma.sql`lower(s."createdBy") = ${f.cashier.toLowerCase()}`);
    if (f.paymentMode) c.push(Prisma.sql`s."paymentMode" = ${f.paymentMode}`);
    if (f.invoiceType) c.push(Prisma.sql`s."invoiceType" IN (${Prisma.join(TYPE_OF[f.invoiceType])})`);
    if (f.customerId) c.push(f.customerId === 'none' ? Prisma.sql`s."customerId" IS NULL` : Prisma.sql`s."customerId" = ${f.customerId}`);
    if (f.minAmount !== undefined) c.push(Prisma.sql`s."totalBill" >= ${f.minAmount}`);
    if (f.maxAmount !== undefined) c.push(Prisma.sql`s."totalBill" <= ${f.maxAmount}`);
    if (f.itemId) c.push(Prisma.sql`l."itemId" = ${f.itemId}`);
    if (f.itemCode) c.push(Prisma.sql`l."itemCode" = ${f.itemCode}`);
    if (f.category !== undefined) c.push(Prisma.sql`l."category" = ${f.category === '__none' ? '' : f.category}`);
    if (f.taxRate !== undefined) c.push(Prisma.sql`l."taxRate" = ${f.taxRate}`);
    return Prisma.join(c, ' AND ');
}

// What each way of grouping is: the SQL that makes the group's key, how to word it, and its natural order
// (the column holds UTC without saying so: first say it is UTC, then ask what the clock in Pakistan showed)
const PKT = Prisma.sql`(s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi'`;
const DIMENSIONS = {
    day: { key: Prisma.sql`to_char(${PKT}, 'YYYY-MM-DD')`, order: 'key', title: 'Day' },
    month: { key: Prisma.sql`to_char(${PKT}, 'YYYY-MM')`, order: 'key', title: 'Month' },
    weekday: { key: Prisma.sql`to_char(${PKT}, 'ID')`, order: 'key', title: 'Day of the week' },
    hour: { key: Prisma.sql`to_char(${PKT}, 'HH24')`, order: 'key', title: 'Hour of the day' },
    item: { key: Prisma.sql`l."itemCode"`, label: Prisma.sql`max(l."itemName")`, order: 'bill', title: 'Item' },
    category: { key: Prisma.sql`l."category"`, order: 'bill', title: 'Category' },
    cashier: { key: Prisma.sql`lower(s."createdBy")`, order: 'bill', title: 'Cashier' },
    counter: { key: Prisma.sql`s."counterId"`, order: 'bill', title: 'Counter' },
    branch: { key: Prisma.sql`(SELECT "branchId" FROM "PosCounter" WHERE "id" = s."counterId")`, order: 'bill', title: 'Branch' },
    payment: { key: Prisma.sql`s."paymentMode"::text`, order: 'key', title: 'Paid by' },
    taxRate: { key: Prisma.sql`l."taxRate"::text`, order: 'key', title: 'Tax rate' },
    customer: { key: Prisma.sql`coalesce(s."customerId", '')`, order: 'bill', title: 'Customer' },
};
// (a name like "__proto__" is not a way of grouping)
const dimension = name => {
    if (!Object.prototype.hasOwnProperty.call(DIMENSIONS, name)) throw new PosError(400, 'Choose what to group the report by.');
    return DIMENSIONS[name];
};
const niceDay = key => new Date(`${key}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const niceMonth = key => new Date(`${key}-15T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const WEEKDAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// the figures of one group (or of everything): sales, returns (credit notes) and what is left
const FIGURES = Prisma.sql`
    count(DISTINCT s."id") FILTER (WHERE s."invoiceType" IN (1, 2)) AS sales,
    count(DISTINCT s."id") FILTER (WHERE s."invoiceType" = 3) AS returns,
    coalesce(sum(l."quantity") FILTER (WHERE s."invoiceType" IN (1, 2)), 0) AS qty,
    coalesce(sum(l."quantity") FILTER (WHERE s."invoiceType" = 3), 0) AS return_qty,
    coalesce(sum(l."saleValue") FILTER (WHERE s."invoiceType" IN (1, 2)), 0) AS value,
    coalesce(sum(l."saleValue") FILTER (WHERE s."invoiceType" = 3), 0) AS return_value,
    coalesce(sum(l."discount") FILTER (WHERE s."invoiceType" IN (1, 2)), 0) AS discount,
    coalesce(sum(l."taxCharged") FILTER (WHERE s."invoiceType" IN (1, 2)), 0) AS tax,
    coalesce(sum(l."taxCharged") FILTER (WHERE s."invoiceType" = 3), 0) AS return_tax,
    coalesce(sum(l."totalAmount") FILTER (WHERE s."invoiceType" IN (1, 2)), 0) AS bill,
    coalesce(sum(l."totalAmount") FILTER (WHERE s."invoiceType" = 3), 0) AS return_bill`;
const figures = r => {
    const bill = money2(r.bill), returnBill = money2(r.return_bill);
    return {
        sales: Number(r.sales), returns: Number(r.returns), quantity: qty4(r.qty), returnQuantity: qty4(r.return_qty),
        saleValue: money2(r.value), discount: money2(r.discount), tax: money2(r.tax), bill,
        returnValue: money2(r.return_value), returnTax: money2(r.return_tax), returnBill,
        netQuantity: qty4(Number(r.qty) - Number(r.return_qty)), netValue: money2(Number(r.value) - Number(r.return_value)), netTax: money2(Number(r.tax) - Number(r.return_tax)), netBill: money2(bill - returnBill),
    };
};

function createReports({ prisma, pra, getProfile, listBranches }) {
    const env = () => (pra.isMock() ? 'SANDBOX' : 'PRODUCTION');
    const reach = f => {
        if (f.from && f.to && daysBetween(f.from, f.to) > MAX_REPORT_DAYS) throw new PosError(400, `A report covers ${MAX_REPORT_DAYS} days at most. Choose a shorter range.`);
        if (!f.from || !f.to) throw new PosError(400, 'Choose the dates the report is for.');
    };

    // Everything the filters leave out because it is of the other kind (test sales in a live report, or the reverse): said, never added in
    async function leftOut(tenantId, f) {
        return prisma.posSale.count({ where: { ...saleWhere(tenantId, { ...f, state: undefined }), state: 'FISCALIZED', env: { not: env() } } });
    }

    // The figures for every group of one kind (item, day, cashier …), and for everything together
    async function aggregate(tenantId, f, groupBy) {
        const dim = dimension(groupBy);
        const where = sqlConditions(tenantId, f, env());
        const [groups, total] = await Promise.all([
            prisma.$queryRaw(Prisma.sql`SELECT ${dim.key} AS key, ${dim.label || Prisma.sql`NULL`} AS label, ${FIGURES}
                FROM "PosSaleLine" l JOIN "PosSale" s ON s."id" = l."saleId" WHERE ${where} GROUP BY 1`),
            prisma.$queryRaw(Prisma.sql`SELECT ${FIGURES} FROM "PosSaleLine" l JOIN "PosSale" s ON s."id" = l."saleId" WHERE ${where}`),
        ]);
        const names = await labelsFor(tenantId, groupBy, groups.map(g => g.key));
        const rows = groups.map(g => ({ key: g.key === null ? '' : String(g.key), label: names(g), ...figures(g) }));
        const totals = figures(total[0]);
        for (const r of rows) r.share = totals.netBill ? Math.round((r.netBill / totals.netBill) * 1000) / 10 : 0;
        const by = dim.order === 'bill' ? (a, b) => b.netBill - a.netBill || a.label.localeCompare(b.label) : (a, b) => (/^\d+(\.\d+)?$/.test(a.key) && /^\d+(\.\d+)?$/.test(b.key) ? Number(a.key) - Number(b.key) : a.key.localeCompare(b.key));
        return { rows: rows.sort(by), totals };
    }

    // The words for a group's key: names that live in other tables are fetched once, for the keys that are there
    async function labelsFor(tenantId, groupBy, keys) {
        const ids = keys.filter(Boolean).map(String);
        let map = new Map();
        if (groupBy === 'counter') map = new Map((await prisma.posCounter.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true, branch: { select: { name: true } } } })).map(c => [c.id, `${c.branch.name} · ${c.name}`]));
        else if (groupBy === 'branch') map = new Map((await prisma.posBranch.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } })).map(b => [b.id, b.name]));
        else if (groupBy === 'customer') map = new Map((await prisma.posCustomer.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, code: true, name: true } })).map(c => [c.id, `${c.name} (${c.code})`]));
        else if (groupBy === 'cashier') map = new Map((await prisma.user.findMany({ where: { tenantId, email: { in: ids, mode: 'insensitive' } }, select: { email: true, name: true } })).map(u => [u.email.toLowerCase(), u.name || u.email.split('@')[0]]));
        return g => {
            const k = g.key === null || g.key === undefined ? '' : String(g.key);
            switch (groupBy) {
                case 'item': return g.label || k;
                case 'category': return k || 'No category';
                case 'payment': return (C.PAYMENT_MODES.find(m => String(m.id) === k) || {}).label || k;
                case 'taxRate': return `${Number(k)}%`;
                case 'weekday': return WEEKDAYS[Number(k)] || k;
                case 'day': return niceDay(k);
                case 'month': return niceMonth(k);
                case 'hour': return `${k}:00 to ${k}:59`;
                case 'customer': return k ? (map.get(k) || 'A customer') : 'No saved customer';
                case 'cashier': return k ? (map.get(k) || k.split('@')[0]) : 'Unknown';
                case 'counter': case 'branch': return map.get(k) || 'Removed';
                default: return k;
            }
        };
    }

    // The report: figures by group, the totals, and what was left out
    async function byReport(ctx, groupBy, raw) {
        const f = cleanFilters(raw);
        reach(f);
        const { rows, totals } = await aggregate(ctx.tenantId, f, groupBy);
        return { groupBy, title: dimension(groupBy).title, filters: f, scope: pra.isMock() ? 'TEST' : 'LIVE', leftOut: await leftOut(ctx.tenantId, f), rows, totals };
    }

    // The daily closing sheet for a day (and a counter, or one cashier's till): what was sold, how it was paid, the tax, and what still needs sorting
    async function closing(ctx, raw) {
        const f = cleanFilters({ ...raw, to: raw && raw.date ? raw.date : raw && raw.to, from: raw && raw.date ? raw.date : raw && raw.from });
        if (!f.from || f.from !== f.to) throw new PosError(400, 'Choose the day to close.');
        for (const k of ['itemId', 'itemCode', 'category', 'taxRate', 'minAmount', 'maxAmount', 'state', 'q', 'invoiceType', 'env']) delete f[k]; // a closing sheet is the whole till for the day, never narrowed by what was sold
        const header = saleWhere(ctx.tenantId, f);
        const [pay, rate, cashier, counter] = await Promise.all(['payment', 'taxRate', 'cashier', 'counter'].map(d => aggregate(ctx.tenantId, f, d)));
        const totals = pay.totals;
        const fiscalized = { ...header, state: 'FISCALIZED', env: env() };
        const [first, last, others, returned, profile, counterRow] = await Promise.all([
            prisma.posSale.findFirst({ where: { ...fiscalized, invoiceType: { in: [1, 2] } }, orderBy: { createdAt: 'asc' }, select: { usin: true, fiscalNumber: true, createdAt: true } }),
            prisma.posSale.findFirst({ where: { ...fiscalized, invoiceType: { in: [1, 2] } }, orderBy: { createdAt: 'desc' }, select: { usin: true, fiscalNumber: true, createdAt: true } }),
            prisma.posSale.groupBy({ by: ['state'], where: { ...header, state: { not: 'FISCALIZED' }, env: env() }, _count: { _all: true } }),
            prisma.posSale.findMany({ where: { ...fiscalized, invoiceType: 3 }, orderBy: { createdAt: 'asc' }, take: 100, select: { usin: true, refUsin: true, totalBill: true, note: true, createdAt: true } }),
            getProfile(ctx.tenantId),
            f.counterId ? prisma.posCounter.findFirst({ where: { id: f.counterId, tenantId: ctx.tenantId }, select: { name: true, posId: true, branch: { select: { name: true } } } }) : null,
        ]);
        const n = st => (others.find(o => o.state === st) || { _count: { _all: 0 } })._count._all;
        const cash = pay.rows.find(r => r.key === '1');
        return {
            date: f.from, scope: pra.isMock() ? 'TEST' : 'LIVE', leftOut: await leftOut(ctx.tenantId, f),
            business: { name: profile.businessName, pntn: profile.pntn, address: profile.address },
            counter: counterRow ? { name: counterRow.name, posId: counterRow.posId, branch: counterRow.branch.name } : null,
            cashier: f.cashier || null,
            totals, byPayment: pay.rows, byTaxRate: rate.rows, byCashier: cashier.rows, byCounter: counter.rows,
            cashExpected: cash ? cash.netBill : 0,
            firstSale: first ? { usin: first.usin, fiscalNumber: first.fiscalNumber, at: first.createdAt } : null,
            lastSale: last ? { usin: last.usin, fiscalNumber: last.fiscalNumber, at: last.createdAt } : null,
            returned: returned.map(r => ({ usin: r.usin, refUsin: r.refUsin, bill: Number(r.totalBill), note: r.note, at: r.createdAt })),
            notFiscalized: { waiting: n('AWAITING_FISCALIZATION'), refused: n('REJECTED'), unknown: n('OUTCOME_UNKNOWN'), cancelled: n('CANCELLED') },
        };
    }

    // What the filter boxes offer: the counters and branches, who has made sales, the categories and tax rates in use
    async function options(ctx) {
        const [branches, cashiers, cats, lineCats, rates] = await Promise.all([
            listBranches(ctx.tenantId),
            prisma.$queryRaw`SELECT DISTINCT lower("createdBy") AS email FROM "PosSale" WHERE "tenantId" = ${ctx.tenantId} ORDER BY 1`,
            prisma.posItem.findMany({ where: { tenantId: ctx.tenantId }, select: { category: true }, distinct: ['category'] }),
            prisma.$queryRaw`SELECT DISTINCT l."category" AS category FROM "PosSaleLine" l JOIN "PosSale" s ON s."id" = l."saleId" WHERE s."tenantId" = ${ctx.tenantId}`,
            prisma.$queryRaw`SELECT DISTINCT l."taxRate" AS rate FROM "PosSaleLine" l JOIN "PosSale" s ON s."id" = l."saleId" WHERE s."tenantId" = ${ctx.tenantId} ORDER BY 1`,
        ]);
        const users = await prisma.user.findMany({ where: { tenantId: ctx.tenantId, email: { in: cashiers.map(c => c.email), mode: 'insensitive' } }, select: { email: true, name: true } });
        const nameOf = new Map(users.map(u => [u.email.toLowerCase(), u.name]));
        return {
            testMode: pra.isMock(),
            branches: branches.map(b => ({ id: b.id, name: b.name, active: b.active, counters: b.counters.map(c => ({ id: c.id, name: c.name, active: c.active })) })),
            cashiers: cashiers.map(c => ({ email: c.email, name: nameOf.get(c.email) || c.email.split('@')[0] })),
            categories: [...new Set([...cats.map(c => c.category), ...lineCats.map(c => c.category)])].filter(Boolean).sort((a, b) => a.localeCompare(b)),
            taxRates: rates.map(r => Number(r.rate)),
            paymentModes: C.PAYMENT_MODES,
            groupings: Object.entries(DIMENSIONS).map(([id, d]) => ({ id, title: d.title })),
        };
    }

    return { byReport, closing, options, cleanFilters, saleWhere };
}

module.exports = { createReports, cleanFilters, saleWhere, sqlConditions, DIMENSIONS, realDay, dayStart, dayEnd, STATES, MAX_REPORT_DAYS };
