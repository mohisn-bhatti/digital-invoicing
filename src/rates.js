// The rate schedule: what a tax authority charges on a service heading, from a date (PRA's Second Schedule now; other authorities can be added).
//
// The rules that matter most:
//  - a rate is never edited or deleted. A rate that changes is a NEW row with its own effective-from date; the rate in force on a day is the latest
//    live row on or before it. So an invoice is always worked out with the rate of its own day, whatever is entered later.
//  - a row put in by mistake is voided (who, when, why) and then no longer counts; the history keeps it.
//  - every row says where it comes from (the document, the clause or page, a link), so a rate can be checked against its source.
//  - only the super admin changes the schedule; every change is in the activity log.
const AUTHORITIES = { PRA: 'Punjab Revenue Authority', SRB: 'Sindh Revenue Board', KPRA: 'Khyber Pakhtunkhwa Revenue Authority', BRA: 'Balochistan Revenue Authority' };
const IN_USE = ['PRA']; // the point of sale uses PRA's schedule; the others are kept ready
const PKT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' });
const MAX_IMPORT = 500;

class RateError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }

const clean = (v, max, what) => {
    const s = String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
    if (s.length > max) throw new RateError(`${what} is too long (${max} characters at most).`);
    return s;
};
const percent = (v, what) => {
    const s = String(v === undefined || v === null ? '' : v).trim().replace(/%$/, '').trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new RateError(`${what} must be a number like 16 or 8.5 (two decimals at most).`);
    const n = Number(s);
    if (n > 100) throw new RateError(`${what} cannot be more than 100.`);
    return n;
};
const dayOf = d => (d ? new Date(d).toISOString().slice(0, 10) : null);
function cleanDay(v, what, { max } = {}) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new RateError(`${what} must be a date like 2026-07-01.`);
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new RateError(`${what} is not a real date.`);
    if (s < '2000-01-01') throw new RateError(`${what} cannot be before 2000.`);
    if (max && s > max) throw new RateError(`${what} cannot be more than two years ahead.`);
    return d;
}
// PRA headings are 8 digits written 9801.2000 or 98012000
function cleanCode(authority, v) {
    const d = String(v === undefined || v === null ? '' : v).replace(/\D/g, '');
    if (authority === 'PRA' && d.length !== 8) throw new RateError('A PRA heading is 8 digits, like 9801.2000.');
    if (!d || d.length > 12) throw new RateError('Enter the service heading (its digits only).');
    return d;
}
const cleanUrl = v => {
    const s = clean(v, 300, 'The link');
    if (s && !/^https?:\/\/[^\s]+$/i.test(s)) throw new RateError('The link must start with http:// or https://.');
    return s;
};

// What one row says, checked: the same checks for one rate typed in and for every row of an import
function cleanRate(b, today) {
    b = b && typeof b === 'object' && !Array.isArray(b) ? b : {};
    const authority = String(b.authority || 'PRA').trim().toUpperCase();
    if (!AUTHORITIES[authority]) throw new RateError(`Choose the authority: ${Object.keys(AUTHORITIES).join(', ')}.`);
    const code = cleanCode(authority, b.code);
    const label = clean(b.label, 200, 'The description');
    if (!label) throw new RateError('Write what the heading is (its description).');
    const hasCard = b.cardRate !== undefined && b.cardRate !== null && String(b.cardRate).trim() !== '';
    const horizon = new Date(`${today}T00:00:00Z`); horizon.setUTCFullYear(horizon.getUTCFullYear() + 2);
    const sourceName = clean(b.sourceName, 200, 'The source document'), sourceRef = clean(b.sourceRef, 200, 'The clause or page');
    if (!sourceName && !sourceRef) throw new RateError('Say where the rate comes from (the document, and the clause or page).');
    return {
        authority, code, label, rate: percent(b.rate, 'The rate'), cardRate: hasCard ? percent(b.cardRate, 'The card rate') : null,
        conditions: clean(b.conditions, 400, 'The conditions'), effectiveFrom: cleanDay(b.effectiveFrom, 'The effective-from date', { max: horizon.toISOString().slice(0, 10) }),
        sourceName, sourceRef, sourceUrl: cleanUrl(b.sourceUrl), note: clean(b.note, 400, 'The note'),
    };
}

function createRatesService({ prisma, audit, now = () => new Date() }) {
    const today = () => PKT_DAY.format(now());
    const emailOf = ctx => (ctx.req && ctx.req.user && ctx.req.user.email) || ctx.email || 'admin';
    const log = (ctx, action, id, summary) => audit(ctx.req, { tenantId: null, action, entityType: 'TaxRate', entityId: id, summary: String(summary).slice(0, 480) });
    const num = d => (d === null || d === undefined ? null : Number(d));
    const view = r => ({
        id: r.id, authority: r.authority, code: r.code, heading: r.code.length === 8 ? `${r.code.slice(0, 4)}.${r.code.slice(4)}` : r.code, label: r.label, rate: num(r.rate), cardRate: num(r.cardRate), conditions: r.conditions,
        effectiveFrom: dayOf(r.effectiveFrom), sourceName: r.sourceName, sourceRef: r.sourceRef, sourceUrl: r.sourceUrl, note: r.note, createdBy: r.createdBy, createdAt: r.createdAt,
        voided: Boolean(r.voidedAt), voidedBy: r.voidedBy, voidedAt: r.voidedAt, voidReason: r.voidReason,
    });
    const asOf = date => (date ? dayOf(cleanDay(date, 'The date')) : today());

    // The rate in force on a day for each code: the latest live row on or before it. Map code -> row view.
    async function effective(authority, codes, date) {
        const day = asOf(date), out = new Map();
        if (!codes.length) return out;
        const rows = await prisma.taxRate.findMany({ where: { authority, code: { in: [...new Set(codes)] }, voidedAt: null, effectiveFrom: { lte: new Date(`${day}T00:00:00Z`) } }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }] });
        for (const r of rows) if (!out.has(r.code)) out.set(r.code, view(r));
        return out;
    }
    // Every heading with the rate in force on a day (or the first one still to come), and the next change if one is already entered
    async function schedule({ authority = 'PRA', q, date, limit = 500, offset = 0 } = {}) {
        authority = String(authority).toUpperCase();
        if (!AUTHORITIES[authority]) throw new RateError('That authority is not known.');
        const day = asOf(date), cut = new Date(`${day}T00:00:00Z`);
        const where = { authority, voidedAt: null };
        const s = clean(q, 60, 'Search');
        if (s) { const digits = s.replace(/\D/g, ''); where.OR = [{ label: { contains: s, mode: 'insensitive' } }, ...(digits.length >= 2 ? [{ code: { startsWith: digits } }] : [])]; }
        const rows = await prisma.taxRate.findMany({ where, orderBy: [{ code: 'asc' }, { effectiveFrom: 'asc' }, { createdAt: 'asc' }] });
        const byCode = new Map();
        for (const r of rows) { const a = byCode.get(r.code) || []; a.push(r); byCode.set(r.code, a); }
        const list = [];
        for (const [code, versions] of byCode) {
            const inForce = [...versions].filter(v => v.effectiveFrom <= cut).pop() || null;
            const next = versions.find(v => v.effectiveFrom > cut) || null;
            const shown = inForce || next;
            list.push({ ...view(shown), inForce: Boolean(inForce), next: inForce && next ? { rate: num(next.rate), cardRate: num(next.cardRate), effectiveFrom: dayOf(next.effectiveFrom) } : null, versions: versions.length });
        }
        const take = Math.min(Math.max(Math.trunc(Number(limit)) || 500, 1), 1000), skip = Math.max(Math.trunc(Number(offset)) || 0, 0);
        return { authority, authorityName: AUTHORITIES[authority], date: day, total: list.length, rates: list.slice(skip, skip + take) };
    }
    async function history(authority, code) {
        authority = String(authority || 'PRA').toUpperCase();
        const c = cleanCode(authority, code);
        const rows = await prisma.taxRate.findMany({ where: { authority, code: c }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }] });
        const day = today();
        const live = rows.filter(r => !r.voidedAt && dayOf(r.effectiveFrom) <= day);
        const inForce = live.length ? live[0].id : null; // newest effective date first: the first live one on or before today
        return rows.map(r => ({ ...view(r), inForce: r.id === inForce, future: !r.voidedAt && dayOf(r.effectiveFrom) > day }));
    }
    // All live rows, as they would be written to a spreadsheet (the whole history, so nothing about a past rate is lost)
    async function exportRows({ authority = 'PRA' } = {}) {
        return (await prisma.taxRate.findMany({ where: { authority: String(authority).toUpperCase(), voidedAt: null }, orderBy: [{ code: 'asc' }, { effectiveFrom: 'asc' }] })).map(view);
    }

    async function clash(tx, d) {
        const same = await tx.taxRate.findFirst({ where: { authority: d.authority, code: d.code, effectiveFrom: d.effectiveFrom, voidedAt: null } });
        if (same) throw new RateError(`${d.authority} ${d.code} already has a rate from ${dayOf(d.effectiveFrom)} (${num(same.rate)}%). Pick another date, or void that one first.`, 409);
    }
    async function create(ctx, body) {
        const d = cleanRate(body, today());
        const r = await prisma.$transaction(async tx => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('taxrate'))`; await clash(tx, d); return tx.taxRate.create({ data: { ...d, createdBy: emailOf(ctx) } }); });
        await log(ctx, 'taxrate.create', r.id, `${d.authority} ${d.code} (${d.label}): ${d.rate}%${d.cardRate !== null ? `, ${d.cardRate}% on card` : ''} from ${dayOf(d.effectiveFrom)}; source: ${[d.sourceName, d.sourceRef].filter(Boolean).join(', ')}`);
        return view(r);
    }
    async function voidRate(ctx, id, reason) {
        const why = clean(reason, 300, 'The reason');
        if (why.length < 3) throw new RateError('Say why (a few words).');
        const r = await prisma.taxRate.findUnique({ where: { id } });
        if (!r) throw new RateError('Rate not found.', 404);
        const done = await prisma.taxRate.updateMany({ where: { id, voidedAt: null }, data: { voidedAt: now(), voidedBy: emailOf(ctx), voidReason: why } });
        if (done.count !== 1) throw new RateError('This rate is already voided.', 409);
        await log(ctx, 'taxrate.void', id, `${r.authority} ${r.code}: the ${num(r.rate)}% from ${dayOf(r.effectiveFrom)} voided: ${why}`);
        return view(await prisma.taxRate.findUnique({ where: { id } }));
    }
    // Many rows at once (a schedule typed into a spreadsheet). All or nothing: with any problem nothing is saved and every problem is listed with its row.
    async function importRows(ctx, rows, { dryRun = true } = {}) {
        if (!Array.isArray(rows) || !rows.length) throw new RateError('There are no rows to import.');
        if (rows.length > MAX_IMPORT) throw new RateError(`At most ${MAX_IMPORT} rows at a time.`);
        const t = today(), good = [], problems = [], seen = new Set();
        rows.forEach((row, i) => {
            try {
                const d = cleanRate(row, t), key = `${d.authority}|${d.code}|${dayOf(d.effectiveFrom)}`;
                if (seen.has(key)) throw new RateError(`${d.authority} ${d.code} from ${dayOf(d.effectiveFrom)} is in the file twice.`);
                seen.add(key); good.push(d);
            } catch (e) { if (!(e instanceof RateError)) throw e; problems.push({ row: i + 1, message: e.message }); }
        });
        if (!problems.length) {
            for (const d of good) {
                const same = await prisma.taxRate.findFirst({ where: { authority: d.authority, code: d.code, effectiveFrom: d.effectiveFrom, voidedAt: null } });
                if (same) problems.push({ row: good.indexOf(d) + 1, message: `${d.authority} ${d.code} already has a rate from ${dayOf(d.effectiveFrom)} (${num(same.rate)}%).` });
            }
        }
        const preview = good.slice(0, 20).map(d => ({ authority: d.authority, code: d.code, label: d.label, rate: d.rate, cardRate: d.cardRate, effectiveFrom: dayOf(d.effectiveFrom) }));
        if (problems.length || dryRun) return { ok: !problems.length, rows: rows.length, valid: good.length, problems, preview, saved: 0 };
        await prisma.$transaction(async tx => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('taxrate'))`;
            for (const d of good) { await clash(tx, d); await tx.taxRate.create({ data: { ...d, createdBy: emailOf(ctx) } }); }
        });
        await log(ctx, 'taxrate.import', null, `${good.length} rates imported (${[...new Set(good.map(d => d.authority))].join(', ')}), source: ${[...new Set(good.map(d => d.sourceName).filter(Boolean))].join('; ').slice(0, 200)}`);
        return { ok: true, rows: rows.length, valid: good.length, problems: [], preview, saved: good.length };
    }

    return { effective, schedule, history, exportRows, create, voidRate, importRows, AUTHORITIES, IN_USE };
}

module.exports = { createRatesService, RateError, cleanRate, AUTHORITIES };
