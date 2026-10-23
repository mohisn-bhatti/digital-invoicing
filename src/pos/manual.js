// A register of invoices written by hand while the connection to PRA was down, entered afterwards. It exists so that nothing written on paper is
// lost or forgotten: each slip is on record, shows up as "not reported yet" until someone says it has been dealt with, and can be voided.
//
// What it is NOT: a fiscal invoice. Nothing here is sent to PRA, no fiscal number is made up, and the figures do not appear in the sales
// reports (they would be sales PRA does not know about). Selling by hand is not allowed by any rule the CA found for an integrated POS, so
// the register records what happened; whether and how it is reported to PRA is for the owner and the CA. Never deleted: voided with who and why.
const V = require('./validate');
const { PosError } = require('./errors');
const { ciContains } = require('./like');

const PKT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' });
const whole = (v, dflt, min, max) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt; };
const paisa = v => Math.round(Number(v || 0) * 100);
const rupees = p => Number(p) / 100;
const MAX_AGE_DAYS = 400;

// "2026-10-19T14:30" typed as Pakistan time (what a datetime box gives), not in the future, not more than 400 days old
function cleanWhen(v, now) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(v === undefined || v === null ? '' : v).trim());
    if (!m) throw new V.PosValidationError('Enter the date and time the slip was written.');
    const at = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+05:00`);
    if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) < '2000-01-01') throw new V.PosValidationError('That is not a real date and time.');
    if (at.getTime() > now.getTime() + 5 * 60000) throw new V.PosValidationError('A slip cannot be written in the future.');
    if (now.getTime() - at.getTime() > MAX_AGE_DAYS * 86400000) throw new V.PosValidationError(`A slip older than ${MAX_AGE_DAYS} days cannot be entered here.`);
    return at;
}
const money = n => Number(n).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function cleanManual(b, now) {
    b = V.isObject(b) ? b : {};
    const bookNumber = V.text(b.bookNumber, 40, 'The slip number');
    if (!bookNumber) throw new V.PosValidationError('Enter the number on the paper slip.');
    const description = V.text(b.description, 300, 'What was sold');
    if (!description) throw new V.PosValidationError('Write what was sold.');
    const sale = V.num(b.saleValue, 'The amount before tax', { min: 0, max: 99999999.99, decimals: 2 });
    if (sale <= 0) throw new V.PosValidationError('The amount before tax must be more than zero.');
    const tax = b.tax === undefined || b.tax === null || String(b.tax).trim() === '' ? 0 : V.num(b.tax, 'The sales tax', { min: 0, max: 99999999.99, decimals: 2 });
    if (tax > sale) throw new V.PosValidationError('The sales tax cannot be more than the amount it is charged on.');
    return {
        bookNumber, writtenAt: cleanWhen(b.writtenAt, now), description, buyer: V.cleanBuyer(b.buyer || {}), paymentMode: V.cleanPaymentMode(b.paymentMode === undefined ? 1 : b.paymentMode),
        saleValue: paisa(sale), tax: paisa(tax), total: paisa(sale) + paisa(tax), reason: V.text(b.reason, 300, 'The reason') || 'PRA could not be reached',
    };
}

function createManualService({ prisma, audit, now = () => new Date() }) {
    const emailOf = ctx => (ctx.req && ctx.req.user && ctx.req.user.email) || ctx.email || 'user';
    const log = (ctx, action, id, summary) => audit(ctx.req, { tenantId: ctx.tenantId, action, entityType: 'PosManualInvoice', entityId: id, summary: String(summary).slice(0, 480) });
    const view = m => ({
        id: m.id, bookNumber: m.bookNumber, writtenAt: m.writtenAt, buyer: { name: m.buyerName, pntn: m.buyerPntn, cnic: m.buyerCnic, phone: m.buyerPhone }, description: m.description, paymentMode: m.paymentMode,
        saleValue: rupees(paisa(m.saleValue)), tax: rupees(paisa(m.tax)), total: rupees(paisa(m.total)), reason: m.reason, createdBy: m.createdBy, createdAt: m.createdAt,
        status: m.voidedAt ? 'VOID' : m.reportedAt ? 'REPORTED' : 'OPEN', reportedAt: m.reportedAt, reportedBy: m.reportedBy, reportNote: m.reportNote, voidedAt: m.voidedAt, voidedBy: m.voidedBy, voidReason: m.voidReason,
    });
    async function create(ctx, body) {
        const d = cleanManual(body, now());
        try {
            const m = await prisma.posManualInvoice.create({
                data: {
                    tenantId: ctx.tenantId, bookNumber: d.bookNumber, writtenAt: d.writtenAt, description: d.description, paymentMode: d.paymentMode, saleValue: rupees(d.saleValue), tax: rupees(d.tax), total: rupees(d.total), reason: d.reason,
                    buyerName: d.buyer.name, buyerPntn: d.buyer.pntn, buyerCnic: d.buyer.cnic, buyerPhone: d.buyer.phone, createdBy: emailOf(ctx),
                },
            });
            await log(ctx, 'pos.manual.create', m.id, `Hand-written slip ${m.bookNumber} recorded: ${money(rupees(d.total))}, ${d.reason}`);
            return view(m);
        } catch (e) {
            if (e && e.code === 'P2002') throw new PosError(409, `A slip numbered "${d.bookNumber}" is already recorded.`);
            throw e;
        }
    }
    async function list(ctx, { status, q, from, to, limit = 100, offset = 0 } = {}) {
        const where = { tenantId: ctx.tenantId };
        if (status === 'VOID') where.voidedAt = { not: null };
        else if (status === 'REPORTED') Object.assign(where, { voidedAt: null, reportedAt: { not: null } });
        else if (status === 'OPEN') Object.assign(where, { voidedAt: null, reportedAt: null });
        const range = {};
        if (from) range.gte = new Date(`${String(from).slice(0, 10)}T00:00:00+05:00`);
        if (to) range.lte = new Date(`${String(to).slice(0, 10)}T23:59:59.999+05:00`);
        if ((range.gte && Number.isNaN(range.gte.getTime())) || (range.lte && Number.isNaN(range.lte.getTime()))) throw new V.PosValidationError('Those dates are not valid.');
        if (range.gte || range.lte) where.writtenAt = range;
        const s = V.text(q, 60, 'Search');
        if (s) where.OR = [{ bookNumber: ciContains(s) }, { buyerName: ciContains(s) }, { description: ciContains(s) }];
        const take = whole(limit, 100, 1, 500), skip = whole(offset, 0, 0, 1000000);
        const [rows, total, open] = await Promise.all([
            prisma.posManualInvoice.findMany({ where, orderBy: [{ writtenAt: 'desc' }, { createdAt: 'desc' }], take, skip }),
            prisma.posManualInvoice.count({ where }),
            prisma.posManualInvoice.aggregate({ where: { tenantId: ctx.tenantId, voidedAt: null, reportedAt: null }, _count: { _all: true }, _sum: { total: true } }),
        ]);
        return { total, open: { count: open._count._all, total: rupees(paisa(open._sum.total)) }, invoices: rows.map(view) };
    }
    async function mine(ctx, id) {
        const m = await prisma.posManualInvoice.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!m) throw new PosError(404, 'Slip not found.');
        return m;
    }
    // Says the slip has been dealt with (told to PRA by whatever way PRA allows). Written down with who and what; nothing is sent from here.
    async function markReported(ctx, id, noteText) {
        const m = await mine(ctx, id);
        const text = V.text(noteText, 300, 'The note');
        if (text.length < 3) throw new V.PosValidationError('Write how it was reported (PRA\'s reference, or what was done).');
        const r = await prisma.posManualInvoice.updateMany({ where: { id, tenantId: ctx.tenantId, voidedAt: null, reportedAt: null }, data: { reportedAt: now(), reportedBy: emailOf(ctx), reportNote: text } });
        if (r.count !== 1) throw new PosError(409, m.voidedAt ? 'This slip is voided.' : 'This slip is already marked as reported.');
        await log(ctx, 'pos.manual.report', id, `Hand-written slip ${m.bookNumber} marked as reported: ${text}`);
        return view(await mine(ctx, id));
    }
    async function voidSlip(ctx, id, reason) {
        const m = await mine(ctx, id);
        const why = V.text(reason, 300, 'The reason');
        if (why.length < 3) throw new V.PosValidationError('Say why (a few words).');
        const r = await prisma.posManualInvoice.updateMany({ where: { id, tenantId: ctx.tenantId, voidedAt: null }, data: { voidedAt: now(), voidedBy: emailOf(ctx), voidReason: why } });
        if (r.count !== 1) throw new PosError(409, 'This slip is already voided.');
        await log(ctx, 'pos.manual.void', id, `Hand-written slip ${m.bookNumber} voided: ${why}`);
        return view(await mine(ctx, id));
    }
    return { create, list, markReported, voidSlip };
}

module.exports = { createManualService };
