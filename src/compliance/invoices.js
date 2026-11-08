// Fee invoices and receipts (SRS 9), and the taxes on them (the CA: as many as needed, e.g. VAT 5%, kept for the client's country and
// suggested on that country's next invoices).
// A draft can change and has no number; issuing gives the next number (never twice: the counter moves inside the same transaction, one
// firm at a time) and fixes the amounts. Money is worked out in whole minor units of the currency (fils, cents...) so 3-decimal
// currencies stay exact.
const R = require('../../public/cmp-rules');
const C = require('../../public/cmp-countries');
const V = require('./validate');
const { CmpError, bad, ciContains } = require('./common');

const dateOf = ymd => (ymd ? new Date(ymd + 'T00:00:00Z') : null);
const ymd = v => (v ? R.ymdOf(v) : '');
const pad = (n, w) => String(n).padStart(w, '0');
const METHODS = { BANK: 'Bank transfer', CASH: 'Cash', CHEQUE: 'Cheque', CARD: 'Card', ONLINE: 'Online payment', OTHER: 'Other' };
const STATUSES = ['DRAFT', 'ISSUED', 'SENT', 'PARTIAL', 'RECEIVED', 'CANCELLED'];
const MAX_AMOUNT = 999999999;

const decimalsOf = cur => C.currencyDecimals(cur);
const toMinor = (n, d) => Math.round(Number(n) * 10 ** d);
const fromMinor = (m, d) => m / 10 ** d;
// "AED 1,500.00": what [Invoice Amount] says
const amountText = (n, cur) => `${cur} ${Number(n).toLocaleString('en-US', { minimumFractionDigits: decimalsOf(cur), maximumFractionDigits: decimalsOf(cur) })}`;
// INV-{YYYY}-{NNNN} → INV-2027-0042
const formatNo = (fmt, seq, day) => String(fmt).replace(/\{YYYY\}/g, day.slice(0, 4)).replace(/\{YY\}/g, day.slice(2, 4)).replace(/\{MM\}/g, day.slice(5, 7)).replace(/\{(N+)\}/g, (_, n) => pad(seq, n.length));

// A sum of money in a currency: not negative, not absurd, no more decimals than the currency has
function money(v, cur, what, { positive = false } = {}) {
    const d = decimalsOf(cur), s = String(v === undefined || v === null ? '' : v).replace(/[,\s]/g, '');
    if (!/^\d+(\.\d+)?$/.test(s)) throw bad(`${what}: enter an amount.`);
    const n = Number(s);
    if (n > MAX_AMOUNT) throw bad(`${what} is too large.`);
    if ((s.split('.')[1] || '').length > d) throw bad(`${what}: ${cur} has ${d === 0 ? 'no decimals' : `${d} decimal${d === 1 ? '' : 's'}`}.`);
    if (positive && n <= 0) throw bad(`${what} must be more than zero.`);
    return n;
}
function rateOf(v, what) {
    const s = String(v === undefined || v === null ? '' : v).replace(/[%\s]/g, '');
    if (!/^\d+(\.\d{1,3})?$/.test(s) || Number(s) > 100) throw bad(`${what}: enter a rate from 0 to 100 (up to 3 decimals).`);
    return Number(s);
}
// The invoice's lines and taxes, checked, with the totals in minor units: each tax on the subtotal, rounded to the currency's unit
function cleanBody(b, currency) {
    const lines = (Array.isArray(b.lines) ? b.lines : []).map((l, i) => ({ description: V.line(l && l.description, 300, `Line ${i + 1}: description`, { required: true }), amount: money(l && l.amount, currency, `Line ${i + 1}: amount`), sortOrder: i }));
    if (!lines.length) throw bad('Add at least one line (what the fee is for).');
    if (lines.length > 50) throw bad('At most 50 lines.');
    const taxes = (Array.isArray(b.taxes) ? b.taxes : []).map((t, i) => ({ name: V.line(t && t.name, 60, `Tax ${i + 1}: name`, { required: true }), rate: rateOf(t && t.rate, `Tax ${i + 1}`), save: Boolean(t && t.save), sortOrder: i }));
    if (taxes.length > 10) throw bad('At most 10 taxes on one invoice.');
    const d = decimalsOf(currency);
    const sub = lines.reduce((m, l) => m + toMinor(l.amount, d), 0);
    for (const t of taxes) t.minor = Math.round(sub * t.rate / 100);
    const tax = taxes.reduce((m, t) => m + t.minor, 0);
    return { lines, taxes, d, subMinor: sub, taxMinor: tax, totalMinor: sub + tax };
}

function createInvoices({ prisma, audit, common, now }) {
    const log = (ctx, action, entityType, entityId, summary, details) => audit(ctx.req, { tenantId: ctx.tenantId, action, entityType, entityId, summary, details });
    const inTurn = (tenantId, what, work) => prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${what}`}))`;
        return work(tx);
    }, { maxWait: 10000, timeout: 20000 });
    const today = async tenantId => R.dayIn((await common.settings(tenantId)).timeZone, now());

    /* ---------- tax rates (country sensitive) ---------- */
    const rateView = r => ({ id: r.id, name: r.name, rate: Number(r.rate), allCountries: r.allCountries, countries: r.countries, active: r.active });
    async function listTaxRates(ctx, q = {}) {
        const rows = await prisma.cmpTaxRate.findMany({ where: { tenantId: ctx.tenantId, ...(q.all === '1' ? {} : { active: true }) }, orderBy: [{ name: 'asc' }, { rate: 'asc' }] });
        const country = q.country ? V.country(q.country).code : null;
        return rows.filter(r => !country || r.allCountries || r.countries.includes(country)).map(rateView);
    }
    // Saved from an invoice: the same name and rate is one tax; it gains the client's country if it did not have it
    async function rememberTax(tx, ctx, name, rate, country) {
        const found = await tx.cmpTaxRate.findFirst({ where: { tenantId: ctx.tenantId, name: { equals: name, mode: 'insensitive' }, rate } });
        if (!found) return tx.cmpTaxRate.create({ data: { tenantId: ctx.tenantId, name, rate, countries: [country], createdBy: ctx.email } });
        if (!found.allCountries && !found.countries.includes(country)) return tx.cmpTaxRate.update({ where: { id: found.id }, data: { countries: [...found.countries, country], active: true } });
        if (!found.active) return tx.cmpTaxRate.update({ where: { id: found.id }, data: { active: true } });
        return found;
    }
    function cleanRate(b) {
        const out = { name: V.line(b.name, 60, 'Tax name', { required: true }), rate: rateOf(b.rate, 'Rate') };
        out.allCountries = b.allCountries === true;
        out.countries = out.allCountries ? [] : [...new Set((Array.isArray(b.countries) ? b.countries : []).map(c => V.country(c).code))];
        if (!out.allCountries && !out.countries.length) throw bad('Choose the countries this tax is for (or all countries).');
        return out;
    }
    async function createTaxRate(ctx, b) {
        const d = cleanRate(b || {});
        const r = await prisma.cmpTaxRate.create({ data: { tenantId: ctx.tenantId, ...d, createdBy: ctx.email } }).catch(e => { if (e.code === 'P2002') throw new CmpError(409, 'That tax with that rate is already there.'); throw e; });
        await log(ctx, 'cmp.tax.create', 'CmpTaxRate', r.id, `Tax "${r.name} ${Number(r.rate)}%" added for ${r.allCountries ? 'all countries' : r.countries.join(', ')}`);
        return rateView(r);
    }
    async function updateTaxRate(ctx, id, b) {
        const r = await prisma.cmpTaxRate.findFirst({ where: { id: String(id || ''), tenantId: ctx.tenantId } });
        if (!r) throw new CmpError(404, 'Tax not found.');
        const data = {};
        if (b.name !== undefined || b.rate !== undefined || b.allCountries !== undefined || b.countries !== undefined) Object.assign(data, cleanRate({ name: b.name ?? r.name, rate: b.rate ?? Number(r.rate), allCountries: b.allCountries ?? r.allCountries, countries: b.countries ?? r.countries }));
        if (b.active !== undefined) data.active = b.active === true;
        const u = await prisma.cmpTaxRate.update({ where: { id: r.id }, data }).catch(e => { if (e.code === 'P2002') throw new CmpError(409, 'That tax with that rate is already there.'); throw e; });
        await log(ctx, 'cmp.tax.update', 'CmpTaxRate', r.id, `Tax "${r.name} ${Number(r.rate)}%" → "${u.name} ${Number(u.rate)}%" for ${u.allCountries ? 'all countries' : u.countries.join(', ')}${u.active ? '' : ' (not suggested any more)'}`);
        return rateView(u);
    }

    /* ---------- invoices ---------- */
    const INCLUDE = { client: true, lines: { orderBy: { sortOrder: 'asc' } }, taxes: { orderBy: { sortOrder: 'asc' } }, receipts: { orderBy: { createdAt: 'asc' } },
        occurrence: { select: { id: true, seq: true, periodStart: true, periodEnd: true, dueDate: true, obligation: { select: { id: true, name: true } } } } };
    const view = inv => ({
        id: inv.id, number: inv.number, status: inv.status, currency: inv.currency, issueDate: ymd(inv.issueDate), dueDate: ymd(inv.dueDate),
        subtotal: Number(inv.subtotal), taxTotal: Number(inv.taxTotal), total: Number(inv.total), received: Number(inv.received), outstanding: Number(inv.total) - Number(inv.received),
        notes: inv.notes, issuedAt: inv.issuedAt, issuedBy: inv.issuedBy, sentAt: inv.sentAt, cancelledAt: inv.cancelledAt, cancelledBy: inv.cancelledBy, cancelReason: inv.cancelReason, createdBy: inv.createdBy, createdAt: inv.createdAt,
        client: inv.client ? { id: inv.client.id, code: inv.client.code, name: inv.client.name, country: inv.client.country, address: inv.client.address, email: inv.client.email, contactNumber: inv.client.contactNumber, registrationNo: inv.client.registrationNo } : undefined,
        obligation: inv.occurrence ? { id: inv.occurrence.obligation.id, name: inv.occurrence.obligation.name, occurrenceId: inv.occurrence.id, periodStart: ymd(inv.occurrence.periodStart), periodEnd: ymd(inv.occurrence.periodEnd) } : null,
        lines: inv.lines ? inv.lines.map(l => ({ description: l.description, amount: Number(l.amount) })) : undefined,
        taxes: inv.taxes ? inv.taxes.map(t => ({ name: t.name, rate: Number(t.rate), amount: Number(t.amount) })) : undefined,
        receipts: inv.receipts ? inv.receipts.map(r => ({ id: r.id, number: r.number, amount: Number(r.amount), receivedOn: ymd(r.receivedOn), method: r.method, reference: r.reference, notes: r.notes, createdBy: r.createdBy, createdAt: r.createdAt, voidedAt: r.voidedAt, voidedBy: r.voidedBy, voidReason: r.voidReason })) : undefined,
    });
    async function find(ctx, id, db = prisma) {
        const inv = await db.cmpInvoice.findFirst({ where: { id: String(id || ''), tenantId: ctx.tenantId }, include: INCLUDE });
        if (!inv) throw new CmpError(404, 'Invoice not found.');
        return inv;
    }
    const get = async (ctx, id) => view(await find(ctx, id));
    // The status after any change of money or of "sent": issued → sent → partially received → received (cancelled and drafts stay)
    const statusOf = inv => {
        if (inv.status === 'DRAFT' || inv.status === 'CANCELLED') return inv.status;
        const total = Number(inv.total), received = Number(inv.received);
        if (received > 0 && received >= total) return 'RECEIVED';
        if (received > 0) return 'PARTIAL';
        return inv.sentAt ? 'SENT' : 'ISSUED';
    };
    const label = inv => (inv.number ? `Invoice ${inv.number}` : 'Draft invoice');

    async function list(ctx, q = {}) {
        const where = { tenantId: ctx.tenantId };
        const st = String(q.status || '').toUpperCase();
        if (st === 'UNPAID') where.status = { in: ['ISSUED', 'SENT', 'PARTIAL'] };
        else if (st) { if (!STATUSES.includes(st)) throw bad('Unknown status.'); where.status = st; }
        if (q.clientId) where.clientId = String(q.clientId);
        if (q.currency) where.currency = String(q.currency).toUpperCase();
        if (q.from) where.issueDate = { ...(where.issueDate || {}), gte: dateOf(V.day(q.from, 'From')) };
        if (q.to) where.issueDate = { ...(where.issueDate || {}), lte: dateOf(V.day(q.to, 'To')) };
        const s = String(q.q || '').trim().slice(0, 100);
        if (s) where.OR = [{ number: ciContains(s) }, { client: { name: ciContains(s) } }, { client: { code: ciContains(s) } }];
        const take = Math.min(Number(q.limit) || 500, 20000);
        const [rows, total] = await Promise.all([
            prisma.cmpInvoice.findMany({ where, orderBy: [{ createdAt: 'desc' }], take, include: { client: true, occurrence: INCLUDE.occurrence } }),
            prisma.cmpInvoice.count({ where }),
        ]);
        return { total, invoices: rows.map(view) };
    }

    // A draft for a client (and the obligation period it bills): the currency of the client's country, the period as the first line
    // with the fee left for the person to type, and the taxes kept for that country
    async function draftFor(ctx, { clientId, occurrenceId } = {}, db = prisma) {
        let client, occ = null;
        if (occurrenceId) { occ = await common.findOccurrence(ctx.tenantId, occurrenceId, { db }); client = occ.obligation.client; }
        else client = await common.findClient(ctx.tenantId, clientId, { live: true, db });
        const currency = (C.get(client.country) || {}).currency || 'USD';
        const taxes = (await db.cmpTaxRate.findMany({ where: { tenantId: ctx.tenantId, active: true, OR: [{ allCountries: true }, { countries: { has: client.country } }] }, orderBy: { name: 'asc' } }));
        const inv = await db.cmpInvoice.create({ data: {
            tenantId: ctx.tenantId, clientId: client.id, occurrenceId: occ ? occ.id : null, currency, createdBy: ctx.email,
            lines: { create: [{ description: occ ? `${occ.obligation.name} — ${R.periodName(occ)}` : 'Professional fee', amount: 0, sortOrder: 0 }] },
            taxes: { create: taxes.map((t, i) => ({ name: t.name, rate: t.rate, amount: 0, sortOrder: i })) },
        } });
        await log(ctx, 'cmp.invoice.create', 'CmpInvoice', inv.id, `Draft invoice for ${common.clientLabel(client)}${occ ? ` (${occ.obligation.name} ${R.periodName(occ)})` : ''}`, { clientId: client.id });
        return inv;
    }
    // A new invoice: what was sent is checked first, so a refused one leaves no empty draft behind
    async function create(ctx, b) {
        if (b.lines || b.taxes || b.currency) {
            const currency = String(b.currency || 'USD').toUpperCase();
            if (b.currency && !C.currencyOk(currency)) throw bad('Choose a currency from the list.');
            if (b.lines || b.taxes) cleanBody({ lines: b.lines || [{ description: 'Fee', amount: 0 }], taxes: b.taxes || [] }, b.currency ? currency : 'USD');
            if (!b.occurrenceId) await common.findClient(ctx.tenantId, b.clientId, { live: true });
        }
        const inv = await draftFor(ctx, { clientId: b.clientId, occurrenceId: b.occurrenceId });
        if (b.lines || b.taxes || b.currency) return update(ctx, inv.id, b);
        return get(ctx, inv.id);
    }
    // Only a draft changes. Taxes ticked "save" are kept for the client's country (suggested on its next invoices).
    async function update(ctx, id, b) {
        const inv = await find(ctx, id);
        if (inv.status !== 'DRAFT') throw new CmpError(409, 'Only a draft invoice can be changed. Cancel this one and make a new one if it is wrong.');
        const currency = String(b.currency || inv.currency).toUpperCase();
        if (!C.currencyOk(currency)) throw bad('Choose a currency from the list.');
        const body = cleanBody({ lines: b.lines ?? inv.lines.map(l => ({ description: l.description, amount: Number(l.amount) })), taxes: b.taxes ?? inv.taxes.map(t => ({ name: t.name, rate: Number(t.rate) })) }, currency);
        const issueDate = b.issueDate !== undefined ? (b.issueDate ? V.day(b.issueDate, 'Invoice date') : null) : ymd(inv.issueDate) || null;
        const dueDate = b.dueDate !== undefined ? (b.dueDate ? V.day(b.dueDate, 'Payment due') : null) : ymd(inv.dueDate) || null;
        if (issueDate && dueDate && dueDate < issueDate) throw bad('The payment due date cannot be before the invoice date.');
        const notes = b.notes !== undefined ? V.multiline(b.notes, 1000, 'Notes') : inv.notes;
        // in turn with issuing (the same lock): an edit can never land on an invoice that was issued a moment ago
        await inTurn(ctx.tenantId, 'cmp-invoice-no', async tx => {
            if ((await tx.cmpInvoice.findUnique({ where: { id: inv.id }, select: { status: true } })).status !== 'DRAFT') throw new CmpError(409, 'This invoice was issued a moment ago: it can no longer be changed.');
            await tx.cmpInvoiceLine.deleteMany({ where: { invoiceId: inv.id } });
            await tx.cmpInvoiceTax.deleteMany({ where: { invoiceId: inv.id } });
            await tx.cmpInvoice.update({ where: { id: inv.id }, data: {
                currency, issueDate: dateOf(issueDate), dueDate: dateOf(dueDate), notes,
                subtotal: fromMinor(body.subMinor, body.d), taxTotal: fromMinor(body.taxMinor, body.d), total: fromMinor(body.totalMinor, body.d),
                lines: { create: body.lines.map(l => ({ description: l.description, amount: l.amount, sortOrder: l.sortOrder })) },
                taxes: { create: body.taxes.map(t => ({ name: t.name, rate: t.rate, amount: fromMinor(t.minor, body.d), sortOrder: t.sortOrder })) },
            } });
            for (const t of body.taxes.filter(x => x.save)) await rememberTax(tx, ctx, t.name, t.rate, inv.client.country);
        });
        const saved = body.taxes.filter(x => x.save);
        if (saved.length) await log(ctx, 'cmp.tax.remember', 'CmpInvoice', inv.id, `Kept for ${inv.client.country} clients: ${saved.map(t => `${t.name} ${t.rate}%`).join(', ')}`, { clientId: inv.clientId });
        return get(ctx, inv.id);
    }
    async function remove(ctx, id) {
        const inv = await find(ctx, id);
        if (inv.status !== 'DRAFT') throw new CmpError(409, 'Only a draft can be deleted. An issued invoice is cancelled instead (it keeps its number).');
        await prisma.cmpInvoice.delete({ where: { id: inv.id } });
        await log(ctx, 'cmp.invoice.delete', 'CmpInvoice', inv.id, `Draft invoice for ${common.clientLabel(inv.client)} deleted`, { clientId: inv.clientId });
        return { ok: true };
    }
    async function issue(ctx, id) {
        const inv = await find(ctx, id);
        if (inv.status !== 'DRAFT') throw new CmpError(409, 'This invoice is already issued.');
        if (Number(inv.total) <= 0) throw bad('Enter the fee first: the invoice total is zero.');
        const day = ymd(inv.issueDate) || await today(ctx.tenantId);
        const done = await inTurn(ctx.tenantId, 'cmp-invoice-no', async tx => {
            const fresh = await tx.cmpInvoice.findUnique({ where: { id: inv.id } });
            if (fresh.status !== 'DRAFT') throw new CmpError(409, 'This invoice is already issued.');
            const s = await tx.cmpSettings.upsert({ where: { tenantId: ctx.tenantId }, create: { tenantId: ctx.tenantId, invoiceSeq: 1 }, update: { invoiceSeq: { increment: 1 } } });
            const number = formatNo(s.invoiceFormat, s.invoiceSeq, day);
            return tx.cmpInvoice.update({ where: { id: inv.id }, data: { status: 'ISSUED', seqNo: s.invoiceSeq, number, issueDate: dateOf(day), issuedAt: now(), issuedBy: ctx.email } });
        });
        await log(ctx, 'cmp.invoice.issue', 'CmpInvoice', inv.id, `Invoice ${done.number} issued to ${common.clientLabel(inv.client)}: ${amountText(inv.total, inv.currency)}`, { clientId: inv.clientId });
        return get(ctx, inv.id);
    }
    async function markSent(ctx, id, how = 'marked by hand') {
        const inv = await find(ctx, id);
        if (['DRAFT', 'CANCELLED'].includes(inv.status)) throw new CmpError(409, inv.status === 'DRAFT' ? 'Issue the invoice first.' : 'This invoice is cancelled.');
        if (inv.sentAt) return get(ctx, inv.id);
        const sentAt = now();
        await prisma.cmpInvoice.update({ where: { id: inv.id }, data: { sentAt, status: statusOf({ ...inv, sentAt }) } });
        await log(ctx, 'cmp.invoice.sent', 'CmpInvoice', inv.id, `Invoice ${inv.number} sent to ${common.clientLabel(inv.client)} (${how})`, { clientId: inv.clientId });
        return get(ctx, inv.id);
    }
    async function cancel(ctx, id, reason) {
        const inv = await find(ctx, id);
        if (inv.status === 'DRAFT') throw new CmpError(409, 'A draft is deleted, not cancelled.');
        if (inv.status === 'CANCELLED') throw new CmpError(409, 'This invoice is already cancelled.');
        if (inv.receipts.some(r => !r.voidedAt)) throw new CmpError(409, 'Money has been received against this invoice. Void its receipts first.');
        const why = V.line(reason, 300, 'Reason', { required: true });
        // in turn with receipts (the same lock): no payment can arrive between the check and the cancelling
        await inTurn(ctx.tenantId, 'cmp-receipt-no', async tx => {
            if (await tx.cmpReceipt.count({ where: { invoiceId: inv.id, voidedAt: null } })) throw new CmpError(409, 'Money has been received against this invoice. Void its receipts first.');
            await tx.cmpInvoice.update({ where: { id: inv.id }, data: { status: 'CANCELLED', cancelledAt: now(), cancelledBy: ctx.email, cancelReason: why } });
        });
        await log(ctx, 'cmp.invoice.cancel', 'CmpInvoice', inv.id, `Invoice ${inv.number} to ${common.clientLabel(inv.client)} cancelled: ${why}`, { clientId: inv.clientId });
        return get(ctx, inv.id);
    }

    /* ---------- receipts ---------- */
    async function recompute(tx, invoiceId) {
        const inv = await tx.cmpInvoice.findUnique({ where: { id: invoiceId }, include: { receipts: true } });
        const d = decimalsOf(inv.currency);
        const received = fromMinor(inv.receipts.filter(r => !r.voidedAt).reduce((m, r) => m + toMinor(r.amount, d), 0), d);
        await tx.cmpInvoice.update({ where: { id: inv.id }, data: { received, status: statusOf({ ...inv, received }) } });
    }
    async function addReceipt(ctx, invoiceId, b) {
        const inv = await find(ctx, invoiceId);
        if (!['ISSUED', 'SENT', 'PARTIAL'].includes(inv.status)) throw new CmpError(409, inv.status === 'RECEIVED' ? 'This invoice is already paid in full.' : inv.status === 'DRAFT' ? 'Issue the invoice first.' : 'This invoice is cancelled.');
        const amount = money(b.amount, inv.currency, 'Amount received', { positive: true });
        const d = decimalsOf(inv.currency), outstanding = toMinor(inv.total, d) - toMinor(inv.received, d);
        if (toMinor(amount, d) > outstanding) throw bad(`That is more than is still owed (${amountText(fromMinor(outstanding, d), inv.currency)}).`);
        const receivedOn = b.receivedOn ? V.day(b.receivedOn, 'Date received') : await today(ctx.tenantId);
        const method = String(b.method || 'BANK').toUpperCase();
        if (!METHODS[method]) throw bad('Choose how it was paid.');
        const reference = V.line(b.reference, 120, 'Reference'), notes = V.multiline(b.notes, 500, 'Notes');
        const r = await inTurn(ctx.tenantId, 'cmp-receipt-no', async tx => {
            // checked again inside the lock: two payments entered at once cannot both fit in what is owed, nor land on a cancelled invoice
            const now2 = await tx.cmpInvoice.findUnique({ where: { id: inv.id }, include: { receipts: true } });
            if (!['ISSUED', 'SENT', 'PARTIAL'].includes(now2.status)) throw new CmpError(409, now2.status === 'RECEIVED' ? 'This invoice is already paid in full.' : 'This invoice is cancelled.');
            const owed = toMinor(now2.total, d) - now2.receipts.filter(x => !x.voidedAt).reduce((m, x) => m + toMinor(x.amount, d), 0);
            if (toMinor(amount, d) > owed) throw bad(`That is more than is still owed (${amountText(fromMinor(owed, d), inv.currency)}).`);
            const s = await tx.cmpSettings.upsert({ where: { tenantId: ctx.tenantId }, create: { tenantId: ctx.tenantId, receiptSeq: 1 }, update: { receiptSeq: { increment: 1 } } });
            const row = await tx.cmpReceipt.create({ data: { tenantId: ctx.tenantId, invoiceId: inv.id, clientId: inv.clientId, seqNo: s.receiptSeq, number: formatNo(s.receiptFormat, s.receiptSeq, receivedOn), amount, receivedOn: dateOf(receivedOn), method, reference, notes, createdBy: ctx.email } });
            await recompute(tx, inv.id);
            return row;
        });
        await log(ctx, 'cmp.receipt.create', 'CmpReceipt', r.id, `Receipt ${r.number}: ${amountText(amount, inv.currency)} received for invoice ${inv.number} from ${common.clientLabel(inv.client)} (${METHODS[method].toLowerCase()})`, { clientId: inv.clientId, invoiceId: inv.id });
        return { invoice: await get(ctx, inv.id), receiptId: r.id };
    }
    async function voidReceipt(ctx, id, reason) {
        const r = await prisma.cmpReceipt.findFirst({ where: { id: String(id || ''), tenantId: ctx.tenantId }, include: { invoice: { include: { client: true } } } });
        if (!r) throw new CmpError(404, 'Receipt not found.');
        if (r.voidedAt) throw new CmpError(409, 'This receipt is already void.');
        const why = V.line(reason, 300, 'Reason', { required: true });
        await prisma.$transaction(async tx => {
            await tx.cmpReceipt.update({ where: { id: r.id }, data: { voidedAt: now(), voidedBy: ctx.email, voidReason: why } });
            await recompute(tx, r.invoiceId);
        });
        await log(ctx, 'cmp.receipt.void', 'CmpReceipt', r.id, `Receipt ${r.number} (${amountText(r.amount, r.invoice.currency)}) for invoice ${r.invoice.number} voided: ${why}`, { clientId: r.clientId, invoiceId: r.invoiceId });
        return get(ctx, r.invoiceId);
    }
    async function listReceipts(ctx, q = {}) {
        const where = { tenantId: ctx.tenantId };
        if (q.clientId) where.clientId = String(q.clientId);
        if (q.from) where.receivedOn = { ...(where.receivedOn || {}), gte: dateOf(V.day(q.from, 'From')) };
        if (q.to) where.receivedOn = { ...(where.receivedOn || {}), lte: dateOf(V.day(q.to, 'To')) };
        const rows = await prisma.cmpReceipt.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(Number(q.limit) || 500, 20000), include: { invoice: { include: { client: true } } } });
        return rows.map(r => ({ id: r.id, number: r.number, amount: Number(r.amount), currency: r.invoice.currency, receivedOn: ymd(r.receivedOn), method: r.method, reference: r.reference, voidedAt: r.voidedAt, voidReason: r.voidReason,
            invoice: { id: r.invoiceId, number: r.invoice.number }, client: { id: r.invoice.client.id, code: r.invoice.client.code, name: r.invoice.client.name, country: r.invoice.client.country }, createdBy: r.createdBy }));
    }
    // What a message about an invoice or receipt can say ([Invoice Number], [Invoice Amount], [Receipt Number])
    async function messageContext(ctx, { invoiceId, receiptId }) {
        let inv = null, receipt = null;
        if (receiptId) {
            receipt = await prisma.cmpReceipt.findFirst({ where: { id: String(receiptId), tenantId: ctx.tenantId } });
            if (!receipt) throw new CmpError(404, 'Receipt not found.');
            invoiceId = receipt.invoiceId;
        }
        if (invoiceId) inv = await find(ctx, invoiceId);
        if (inv && inv.status === 'DRAFT') throw new CmpError(409, 'Issue the invoice before sending it.');
        return { inv, receipt, ctx: inv ? { invoice: { number: inv.number, amountText: amountText(inv.total, inv.currency) }, receipt: receipt ? { number: receipt.number } : null } : {} };
    }

    return { METHODS, STATUSES, amountText, listTaxRates, createTaxRate, updateTaxRate, list, get, draftFor, create, update, remove, issue, markSent, cancel, addReceipt, voidReceipt, listReceipts, messageContext, statusOf };
}

module.exports = { createInvoices, formatNo, amountText, METHODS };
