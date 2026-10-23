// Point of Sale accounts: the optional side of the module that is not the fiscal invoice. Vendors (who the business buys from), purchase
// bills, cash paid to vendors, cash received from customers, and the cash book that lists the last two. None of it goes to PRA.
// Everything is scoped by tenantId. Nothing is ever deleted: a bill or a voucher is voided with who and why, and then stops counting.
//
// The rules that matter most:
//  - money is worked in whole paisa (integers), so a total is never a rounding away from the sum of its lines
//  - what the business owes a vendor = opening balance + live purchases - live payments; what a customer owes = opening balance - live receipts
//    (a negative customer balance is an advance the business is holding: a banquet booking, say)
//  - a payment set against a bill can never be more than what is still unpaid on it; a bill with live payments cannot be voided
//  - all writes of one business take turns (one advisory lock), so two screens cannot hand out one number twice or overpay one bill
const V = require('./validate');
const { PosError } = require('./errors');
const { ciContains } = require('./like');
const { csvText, csvNum } = require('./csv');

const PKT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' });
const METHODS = ['CASH', 'BANK', 'CHEQUE', 'WALLET'];
const METHOD_LABEL = { CASH: 'Cash', BANK: 'Bank transfer', CHEQUE: 'Cheque', WALLET: 'Wallet / QR' };
const MAX_MONEY = 99999999999n; // 999,999,999.99 in paisa
const MAX_LINE = 9999999999n; // 99,999,999.99
const MAX_BOOK_ROWS = 5000;

const paisa = v => Math.round(Number(v || 0) * 100);
const rupees = p => Number(p) / 100;
const pad = (n, w) => String(n).padStart(w, '0');
const whole = (v, dflt, min, max) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt; };
const dayOf = d => (d ? new Date(d).toISOString().slice(0, 10) : null);

// A date typed as YYYY-MM-DD: a real day, not in the future (Pakistan's today) and not before 2000
function cleanDay(v, what, today) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new V.PosValidationError(`${what} must be a date like 2026-10-23.`);
    const d = new Date(`${s}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new V.PosValidationError(`${what} is not a real date.`);
    if (s < '2000-01-01') throw new V.PosValidationError(`${what} cannot be before 2000.`);
    if (s > today) throw new V.PosValidationError(`${what} cannot be in the future.`);
    return d;
}
// An amount of money, in paisa: digits with up to two decimals, more than zero
function cleanAmount(v, what) {
    const n = V.num(v, what, { min: 0, decimals: 2 });
    const p = BigInt(Math.round(n * 100));
    if (p <= 0n) throw new V.PosValidationError(`${what} must be more than zero.`);
    if (p > MAX_MONEY) throw new V.PosValidationError(`${what} cannot be more than 999,999,999.99.`);
    return Number(p);
}
// A balance that may be negative (an advance already held, a payment already made): a minus sign and up to two decimals
function cleanBalance(v, what) {
    if (v === undefined || v === null || String(v).trim() === '') return 0;
    const s = String(v).trim();
    if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new V.PosValidationError(`${what} must be a number (a minus sign is allowed), with two decimals at most.`);
    const p = BigInt(Math.round(Math.abs(Number(s)) * 100));
    if (p > MAX_MONEY) throw new V.PosValidationError(`${what} cannot be more than 999,999,999.99.`);
    return Number(s) < 0 ? -Number(p) : Number(p);
}

function cleanVendor(v, { keepPhone = false } = {}) {
    v = V.isObject(v) ? v : {};
    const name = V.text(v.name, 150, 'Vendor name');
    if (!name) throw new V.PosValidationError('Enter the vendor name.');
    const phoneIssue = V.phoneProblem(v.phone);
    if (phoneIssue && !keepPhone) throw new V.PosValidationError(`Phone number: ${phoneIssue}.`);
    const phone = phoneIssue ? String(v.phone || '') : V.phoneDigits(v.phone); // (a number already saved that no longer passes is kept as it is)
    return {
        name, phone, ntn: V.text(v.ntn, 20, 'NTN'), address: V.text(v.address, 250, 'Address'), notes: V.text(v.notes, 300, 'Notes'),
        active: v.active === undefined ? true : v.active === true || v.active === 'true',
        openingBalance: cleanBalance(v.openingBalance, 'Opening balance'),
    };
}

function cleanPurchase(b, today) {
    b = V.isObject(b) ? b : {};
    const lines = Array.isArray(b.lines) ? b.lines : [];
    if (!lines.length) throw new V.PosValidationError('Add at least one line to the bill.');
    if (lines.length > 100) throw new V.PosValidationError('A bill can have 100 lines at most.');
    let subtotal = 0n;
    const clean = lines.map((l, i) => {
        l = V.isObject(l) ? l : {};
        const name = V.text(l.itemName, 150, `Line ${i + 1} item`);
        if (!name) throw new V.PosValidationError(`Line ${i + 1}: enter what was bought.`);
        const qty = V.num(l.quantity, `Line ${i + 1} quantity`, { min: 0, max: 1000000, decimals: 4 });
        if (qty <= 0) throw new V.PosValidationError(`Line ${i + 1}: quantity must be more than zero.`);
        const cost = V.num(l.unitCost, `Line ${i + 1} price`, { min: 0, max: 99999999.99, decimals: 2 });
        const q4 = BigInt(Math.round(qty * 10000)), c = BigInt(Math.round(cost * 100));
        const amount = (q4 * c + 5000n) / 10000n; // rounded to the nearest paisa
        if (amount > MAX_LINE) throw new V.PosValidationError(`Line ${i + 1} comes to too much: check the quantity and the price.`);
        subtotal += amount;
        return { sort: i, itemName: name, quantity: qty, unitCost: cost, amount: Number(amount) };
    });
    let tax = 0n;
    if (b.tax !== undefined && b.tax !== null && String(b.tax).trim() !== '') tax = BigInt(Math.round(V.num(b.tax, 'Tax', { min: 0, decimals: 2 }) * 100));
    if (tax > subtotal) throw new V.PosValidationError('The tax on a bill cannot be more than its items.');
    if (subtotal + tax > MAX_MONEY) throw new V.PosValidationError('This bill comes to too much.');
    return {
        vendorId: String(b.vendorId || ''), vendorRef: V.text(b.vendorRef, 60, "The vendor's bill number"), billDate: cleanDay(b.date || today, 'Bill date', today),
        note: V.text(b.note, 300, 'Note'), lines: clean, subtotal: Number(subtotal), tax: Number(tax), total: Number(subtotal + tax),
    };
}

function cleanVoucher(b, today) {
    b = V.isObject(b) ? b : {};
    const method = String(b.method || 'CASH').toUpperCase();
    if (!METHODS.includes(method)) throw new V.PosValidationError('Choose how it was paid: cash, bank transfer, cheque or wallet.');
    return {
        amount: cleanAmount(b.amount, 'Amount'), method, entryDate: cleanDay(b.date || today, 'Date', today),
        reference: V.text(b.reference, 60, 'Reference'), note: V.text(b.note, 300, 'Note'),
    };
}
const cleanReason = r => {
    const s = V.text(r, 300, 'The reason');
    if (s.length < 3) throw new V.PosValidationError('Say why (a few words).');
    return s;
};

function createAccountsService({ prisma, audit, now = () => new Date() }) {
    const emailOf = ctx => (ctx.req && ctx.req.user && ctx.req.user.email) || ctx.email || 'user';
    const today = () => PKT_DAY.format(now());
    const inTurn = (tenantId, work) => prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:accounts`}))`;
        return work(tx);
    }, { maxWait: 10000, timeout: 20000 });
    const log = (ctx, action, entityType, entityId, summary) => audit(ctx.req, { tenantId: ctx.tenantId, action, entityType, entityId, summary: String(summary).slice(0, 480) });
    const money = p => rupees(p).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // The next number of a kind (PUR000001): the highest so far plus one. Called inside the turn, so nobody else is adding one. (Not the newest row: the
    // time a row was made is when its transaction began, and two that overlapped can be stored out of order.)
    async function nextNumber(tx, model, tenantId, prefix, where = {}) {
        const last = await tx[model].findFirst({ where: { tenantId, number: { startsWith: prefix }, ...where }, orderBy: { number: 'desc' }, select: { number: true } }); // numbers are all the same width, so the highest sorts last
        const top = last && /^[A-Z]+\d+$/.test(last.number) ? Number(last.number.slice(prefix.length)) : 0;
        return prefix + pad(top + 1, 6);
    }
    async function nextVendorCode(tx, tenantId) {
        const rows = await tx.posVendor.findMany({ where: { tenantId, code: { startsWith: 'VEN' } }, select: { code: true } });
        const top = rows.reduce((m, r) => Math.max(m, /^VEN(\d+)$/.test(r.code) ? Number(r.code.slice(3)) : 0), 0);
        return 'VEN' + pad(top + 1, 4);
    }

    // ---------- balances ----------
    // Live (not voided) purchase totals and payments per vendor, in paisa
    async function vendorFigures(tenantId, ids) {
        const m = new Map(ids.map(id => [id, { purchased: 0, paid: 0, purchases: 0, lastBillAt: null }]));
        if (!ids.length) return m;
        const [bought, paid, last] = await Promise.all([
            prisma.posPurchase.groupBy({ by: ['vendorId'], where: { tenantId, vendorId: { in: ids }, voidedAt: null }, _sum: { total: true }, _count: { _all: true } }),
            prisma.posCashEntry.groupBy({ by: ['vendorId'], where: { tenantId, kind: 'PAYMENT', vendorId: { in: ids }, voidedAt: null }, _sum: { amount: true } }),
            prisma.posPurchase.groupBy({ by: ['vendorId'], where: { tenantId, vendorId: { in: ids }, voidedAt: null }, _max: { billDate: true } }),
        ]);
        for (const r of bought) { const t = m.get(r.vendorId); t.purchased = paisa(r._sum.total); t.purchases = r._count._all; }
        for (const r of paid) m.get(r.vendorId).paid = paisa(r._sum.amount);
        for (const r of last) m.get(r.vendorId).lastBillAt = dayOf(r._max.billDate);
        return m;
    }
    async function customerReceived(tenantId, ids) {
        const m = new Map(ids.map(id => [id, { received: 0, receipts: 0, lastReceiptAt: null }]));
        if (!ids.length) return m;
        const rows = await prisma.posCashEntry.groupBy({ by: ['customerId'], where: { tenantId, kind: 'RECEIPT', customerId: { in: ids }, voidedAt: null }, _sum: { amount: true }, _count: { _all: true }, _max: { entryDate: true } });
        for (const r of rows) { const t = m.get(r.customerId); t.received = paisa(r._sum.amount); t.receipts = r._count._all; t.lastReceiptAt = dayOf(r._max.entryDate); }
        return m;
    }

    // ---------- vendors ----------
    const vendorView = (v, f) => {
        const out = { id: v.id, code: v.code, name: v.name, ntn: v.ntn, phone: v.phone, address: v.address, notes: v.notes, active: v.active, openingBalance: rupees(paisa(v.openingBalance)), createdAt: v.createdAt };
        if (f) Object.assign(out, { purchases: f.purchases, purchased: rupees(f.purchased), paid: rupees(f.paid), balance: rupees(paisa(v.openingBalance) + f.purchased - f.paid), lastBillAt: f.lastBillAt });
        return out;
    };
    const vendorSearch = q => {
        const s = V.text(q, 60, 'Search'); if (!s) return null;
        const digits = s.replace(/\D/g, '');
        const or = [{ name: ciContains(s) }, { code: ciContains(s) }, { address: ciContains(s) }, { ntn: ciContains(s) }];
        if (digits.length >= 3) or.push({ phone: { contains: digits } });
        return or;
    };
    async function listVendors(ctx, { q, active, limit = 100, offset = 0, owing } = {}) {
        const where = { tenantId: ctx.tenantId };
        if (active === '1' || active === 1 || active === true) where.active = true; else if (active === '0' || active === 0 || active === false) where.active = false;
        const or = vendorSearch(q); if (or) where.OR = or;
        // "owing": only vendors the business still owes. That needs every balance, so it is worked out for all of them first.
        if (owing === '1' || owing === true) {
            const all = await prisma.posVendor.findMany({ where, orderBy: [{ name: 'asc' }] });
            const fig = await vendorFigures(ctx.tenantId, all.map(v => v.id));
            const rows = all.map(v => vendorView(v, fig.get(v.id))).filter(v => v.balance > 0);
            const take = whole(limit, 100, 1, 500), skip = whole(offset, 0, 0, 1000000);
            return { total: rows.length, totalOwed: rupees(rows.reduce((s, v) => s + paisa(v.balance), 0)), vendors: rows.slice(skip, skip + take) };
        }
        const take = whole(limit, 100, 1, 500), skip = whole(offset, 0, 0, 1000000);
        const [rows, total] = await Promise.all([prisma.posVendor.findMany({ where, orderBy: [{ name: 'asc' }, { code: 'asc' }], take, skip }), prisma.posVendor.count({ where })]);
        const fig = await vendorFigures(ctx.tenantId, rows.map(v => v.id));
        return { total, vendors: rows.map(v => vendorView(v, fig.get(v.id))) };
    }
    async function createVendor(ctx, body) {
        const d = cleanVendor(body);
        const v = await inTurn(ctx.tenantId, async tx => tx.posVendor.create({ data: { tenantId: ctx.tenantId, code: await nextVendorCode(tx, ctx.tenantId), ...d, openingBalance: rupees(d.openingBalance) } }));
        await log(ctx, 'pos.vendor.create', 'PosVendor', v.id, `Vendor "${v.name}" (${v.code}) added${d.openingBalance ? `, opening balance ${money(d.openingBalance)}` : ''}`);
        return vendorView(v, { purchases: 0, purchased: 0, paid: 0, lastBillAt: null });
    }
    async function updateVendor(ctx, id, body) {
        const v = await prisma.posVendor.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!v) throw new PosError(404, 'Vendor not found.');
        const d = cleanVendor({ ...vendorView(v), ...body }, { keepPhone: body.phone === undefined || String(body.phone) === v.phone });
        const u = await inTurn(ctx.tenantId, tx => tx.posVendor.update({ where: { id }, data: { ...d, openingBalance: rupees(d.openingBalance) } }));
        const changed = ['name', 'ntn', 'phone', 'address', 'notes', 'active'].filter(k => v[k] !== u[k]);
        const opened = paisa(v.openingBalance) !== paisa(u.openingBalance);
        if (changed.length || opened) await log(ctx, 'pos.vendor.update', 'PosVendor', id, `Vendor "${u.name}" (${u.code}) changed: ${[...changed.map(k => (k === 'active' ? (u.active ? 'switched on' : 'switched off') : k)), ...(opened ? [`opening balance ${money(paisa(v.openingBalance))} to ${money(paisa(u.openingBalance))}`] : [])].join(', ')}`);
        const f = (await vendorFigures(ctx.tenantId, [id])).get(id);
        return vendorView(u, f);
    }
    async function vendorDetail(ctx, id) {
        const v = await prisma.posVendor.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!v) throw new PosError(404, 'Vendor not found.');
        const f = (await vendorFigures(ctx.tenantId, [id])).get(id);
        const [bills, pays] = await Promise.all([
            prisma.posPurchase.findMany({ where: { tenantId: ctx.tenantId, vendorId: id }, orderBy: [{ billDate: 'desc' }, { createdAt: 'desc' }], take: 200, include: { payments: { where: { voidedAt: null }, select: { amount: true } } } }),
            prisma.posCashEntry.findMany({ where: { tenantId: ctx.tenantId, vendorId: id, kind: 'PAYMENT' }, orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }], take: 200 }),
        ]);
        return { ...vendorView(v, f), bills: bills.map(purchaseRow), payments: pays.map(entryRow) };
    }

    // ---------- purchases (bills from vendors) ----------
    const purchaseRow = p => {
        const paid = (p.payments || []).reduce((s, x) => s + paisa(x.amount), 0), total = paisa(p.total);
        return {
            id: p.id, number: p.number, vendorId: p.vendorId, vendorName: p.vendor ? p.vendor.name : undefined, vendorCode: p.vendor ? p.vendor.code : undefined, vendorRef: p.vendorRef, date: dayOf(p.billDate),
            subtotal: rupees(paisa(p.subtotal)), tax: rupees(paisa(p.tax)), total: rupees(total), paid: rupees(paid), due: p.voidedAt ? 0 : rupees(total - paid),
            status: p.voidedAt ? 'VOID' : paid >= total ? 'PAID' : paid > 0 ? 'PART' : 'UNPAID', note: p.note, createdBy: p.createdBy, createdAt: p.createdAt,
            voidedAt: p.voidedAt, voidedBy: p.voidedBy, voidReason: p.voidReason,
        };
    };
    const purchaseFull = async (tenantId, id) => {
        const p = await prisma.posPurchase.findFirst({ where: { id, tenantId }, include: { vendor: true, lines: { orderBy: { sort: 'asc' } }, payments: { orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }] } } });
        if (!p) throw new PosError(404, 'Bill not found.');
        const live = p.payments.filter(x => !x.voidedAt);
        return {
            ...purchaseRow({ ...p, payments: live }),
            lines: p.lines.map(l => ({ itemName: l.itemName, quantity: Number(l.quantity), unitCost: rupees(paisa(l.unitCost)), amount: rupees(paisa(l.amount)) })),
            payments: p.payments.map(x => entryRow({ ...x, vendor: p.vendor })),
        };
    };
    async function createPurchase(ctx, body) {
        const d = cleanPurchase(body, today());
        const made = await inTurn(ctx.tenantId, async tx => {
            const v = await tx.posVendor.findFirst({ where: { id: d.vendorId, tenantId: ctx.tenantId } });
            if (!v) throw new PosError(404, 'Choose the vendor this bill is from.');
            if (!v.active) throw new PosError(409, `${v.name} is switched off. Switch the vendor on first.`);
            const number = await nextNumber(tx, 'posPurchase', ctx.tenantId, 'PUR');
            const p = await tx.posPurchase.create({
                data: {
                    tenantId: ctx.tenantId, vendorId: v.id, number, vendorRef: d.vendorRef, billDate: d.billDate, subtotal: rupees(d.subtotal), tax: rupees(d.tax), total: rupees(d.total), note: d.note, createdBy: emailOf(ctx),
                    lines: { create: d.lines.map(l => ({ sort: l.sort, itemName: l.itemName, quantity: l.quantity, unitCost: l.unitCost, amount: rupees(l.amount) })) },
                },
            });
            return { p, v };
        });
        await log(ctx, 'pos.purchase.create', 'PosPurchase', made.p.id, `Purchase ${made.p.number} from ${made.v.name} (${made.v.code}): ${money(d.total)}${d.vendorRef ? `, their bill ${d.vendorRef}` : ''}`);
        return purchaseFull(ctx.tenantId, made.p.id);
    }
    async function listPurchases(ctx, { q, vendorId, from, to, status, limit = 100, offset = 0 } = {}) {
        const where = { tenantId: ctx.tenantId };
        if (vendorId) where.vendorId = String(vendorId);
        const range = {};
        if (from) range.gte = cleanDay(from, 'From', '9999-12-31');
        if (to) range.lte = cleanDay(to, 'To', '9999-12-31');
        if (range.gte || range.lte) where.billDate = range;
        const s = V.text(q, 60, 'Search');
        if (s) where.OR = [{ number: ciContains(s) }, { vendorRef: ciContains(s) }, { vendor: { name: ciContains(s) } }, { note: ciContains(s) }];
        if (status === 'VOID') where.voidedAt = { not: null }; else if (status) where.voidedAt = null;
        const take = whole(limit, 100, 1, 500), skip = whole(offset, 0, 0, 1000000);
        const rows = await prisma.posPurchase.findMany({ where, orderBy: [{ billDate: 'desc' }, { createdAt: 'desc' }], include: { vendor: { select: { name: true, code: true } }, payments: { where: { voidedAt: null }, select: { amount: true } } } });
        let list = rows.map(purchaseRow);
        if (status && status !== 'VOID') list = list.filter(r => (status === 'OPEN' ? r.status === 'UNPAID' || r.status === 'PART' : r.status === status));
        const live = list.filter(r => r.status !== 'VOID');
        return {
            total: list.length, totals: { bills: live.length, total: rupees(live.reduce((n, r) => n + paisa(r.total), 0)), tax: rupees(live.reduce((n, r) => n + paisa(r.tax), 0)), due: rupees(live.reduce((n, r) => n + paisa(r.due), 0)) },
            purchases: list.slice(skip, skip + take),
        };
    }
    async function purchaseDetail(ctx, id) { return purchaseFull(ctx.tenantId, id); }
    async function voidPurchase(ctx, id, reason) {
        const why = cleanReason(reason);
        const p = await inTurn(ctx.tenantId, async tx => {
            const x = await tx.posPurchase.findFirst({ where: { id, tenantId: ctx.tenantId } });
            if (!x) throw new PosError(404, 'Bill not found.');
            if (x.voidedAt) throw new PosError(409, 'This bill is already voided.');
            const live = await tx.posCashEntry.count({ where: { purchaseId: id, voidedAt: null } });
            if (live) throw new PosError(409, `${live === 1 ? 'A payment is' : live + ' payments are'} set against this bill. Void ${live === 1 ? 'it' : 'them'} first.`);
            return tx.posPurchase.update({ where: { id }, data: { voidedAt: now(), voidedBy: emailOf(ctx), voidReason: why } });
        });
        await log(ctx, 'pos.purchase.void', 'PosPurchase', id, `Purchase ${p.number} voided: ${why}`);
        return purchaseFull(ctx.tenantId, id);
    }

    // ---------- the cash book: money received from customers and paid to vendors ----------
    const entryRow = e => ({
        id: e.id, kind: e.kind, number: e.number, date: dayOf(e.entryDate), amount: rupees(paisa(e.amount)), method: e.method, methodLabel: METHOD_LABEL[e.method] || e.method, reference: e.reference, note: e.note,
        customerId: e.customerId, customerName: e.customer ? e.customer.name : undefined, customerCode: e.customer ? e.customer.code : undefined,
        vendorId: e.vendorId, vendorName: e.vendor ? e.vendor.name : undefined, vendorCode: e.vendor ? e.vendor.code : undefined,
        purchaseId: e.purchaseId, purchaseNumber: e.purchase ? e.purchase.number : undefined,
        createdBy: e.createdBy, createdAt: e.createdAt, voided: Boolean(e.voidedAt), voidedAt: e.voidedAt, voidedBy: e.voidedBy, voidReason: e.voidReason,
    });
    const WITH_PARTIES = { customer: { select: { name: true, code: true } }, vendor: { select: { name: true, code: true } }, purchase: { select: { number: true } } };

    async function receiveCash(ctx, body) {
        const d = cleanVoucher(body, today());
        const customerId = String((body && body.customerId) || '');
        const made = await inTurn(ctx.tenantId, async tx => {
            const c = await tx.posCustomer.findFirst({ where: { id: customerId, tenantId: ctx.tenantId } });
            if (!c) throw new PosError(404, 'Choose the customer the money is from.');
            const number = await nextNumber(tx, 'posCashEntry', ctx.tenantId, 'RCV', { kind: 'RECEIPT' });
            return { c, e: await tx.posCashEntry.create({ data: { tenantId: ctx.tenantId, kind: 'RECEIPT', number, entryDate: d.entryDate, amount: rupees(d.amount), method: d.method, reference: d.reference, note: d.note, customerId: c.id, createdBy: emailOf(ctx) }, include: WITH_PARTIES }) };
        });
        await log(ctx, 'pos.cash.receive', 'PosCashEntry', made.e.id, `Received ${money(d.amount)} (${METHOD_LABEL[d.method]}) from ${made.c.name} (${made.c.code}) as ${made.e.number}`);
        return entryRow(made.e);
    }
    async function payVendor(ctx, body) {
        const d = cleanVoucher(body, today());
        const vendorId = String((body && body.vendorId) || ''), purchaseId = (body && body.purchaseId) ? String(body.purchaseId) : null;
        const made = await inTurn(ctx.tenantId, async tx => {
            const v = await tx.posVendor.findFirst({ where: { id: vendorId, tenantId: ctx.tenantId } });
            if (!v) throw new PosError(404, 'Choose the vendor the money is for.');
            if (purchaseId) {
                const p = await tx.posPurchase.findFirst({ where: { id: purchaseId, tenantId: ctx.tenantId }, include: { payments: { where: { voidedAt: null }, select: { amount: true } } } });
                if (!p || p.vendorId !== v.id) throw new PosError(404, 'That bill is not one of this vendor\'s.');
                if (p.voidedAt) throw new PosError(409, 'That bill is voided.');
                const due = paisa(p.total) - p.payments.reduce((s, x) => s + paisa(x.amount), 0);
                if (d.amount > due) throw new PosError(409, `Only ${money(due)} is still unpaid on ${p.number}. Pay that, or leave the bill out and pay the vendor on account.`);
            }
            const number = await nextNumber(tx, 'posCashEntry', ctx.tenantId, 'PAY', { kind: 'PAYMENT' });
            return { v, e: await tx.posCashEntry.create({ data: { tenantId: ctx.tenantId, kind: 'PAYMENT', number, entryDate: d.entryDate, amount: rupees(d.amount), method: d.method, reference: d.reference, note: d.note, vendorId: v.id, purchaseId, createdBy: emailOf(ctx) }, include: WITH_PARTIES }) };
        });
        await log(ctx, 'pos.cash.pay', 'PosCashEntry', made.e.id, `Paid ${money(d.amount)} (${METHOD_LABEL[d.method]}) to ${made.v.name} (${made.v.code}) as ${made.e.number}${made.e.purchase ? `, for ${made.e.purchase.number}` : ''}`);
        return entryRow(made.e);
    }
    async function voidEntry(ctx, id, reason) {
        const why = cleanReason(reason);
        const e = await inTurn(ctx.tenantId, async tx => {
            const x = await tx.posCashEntry.findFirst({ where: { id, tenantId: ctx.tenantId } });
            if (!x) throw new PosError(404, 'Voucher not found.');
            if (x.voidedAt) throw new PosError(409, 'This voucher is already voided.');
            return tx.posCashEntry.update({ where: { id }, data: { voidedAt: now(), voidedBy: emailOf(ctx), voidReason: why }, include: WITH_PARTIES });
        });
        await log(ctx, 'pos.cash.void', 'PosCashEntry', id, `${e.kind === 'RECEIPT' ? 'Receipt' : 'Payment'} ${e.number} (${money(paisa(e.amount))}) voided: ${why}`);
        return entryRow(e);
    }
    async function entryDetail(ctx, id) {
        const e = await prisma.posCashEntry.findFirst({ where: { id, tenantId: ctx.tenantId }, include: WITH_PARTIES });
        if (!e) throw new PosError(404, 'Voucher not found.');
        return entryRow(e);
    }
    async function listEntries(ctx, { kind, q, customerId, vendorId, method, from, to, limit = 100, offset = 0, voided } = {}) {
        const where = { tenantId: ctx.tenantId };
        if (kind === 'RECEIPT' || kind === 'PAYMENT') where.kind = kind;
        if (customerId) where.customerId = String(customerId);
        if (vendorId) where.vendorId = String(vendorId);
        if (METHODS.includes(String(method || '').toUpperCase())) where.method = String(method).toUpperCase();
        const range = {};
        if (from) range.gte = cleanDay(from, 'From', '9999-12-31');
        if (to) range.lte = cleanDay(to, 'To', '9999-12-31');
        if (range.gte || range.lte) where.entryDate = range;
        if (voided === '1') where.voidedAt = { not: null }; else if (voided !== 'all') where.voidedAt = null;
        const s = V.text(q, 60, 'Search');
        if (s) where.OR = [{ number: ciContains(s) }, { reference: ciContains(s) }, { note: ciContains(s) }, { customer: { name: ciContains(s) } }, { vendor: { name: ciContains(s) } }];
        const take = whole(limit, 100, 1, 500), skip = whole(offset, 0, 0, 1000000);
        const [rows, total, sum] = await Promise.all([
            prisma.posCashEntry.findMany({ where, orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }], take, skip, include: WITH_PARTIES }),
            prisma.posCashEntry.count({ where }),
            prisma.posCashEntry.aggregate({ where: { ...where, voidedAt: null }, _sum: { amount: true } }),
        ]);
        return { total, sum: rupees(paisa(sum._sum.amount)), entries: rows.map(entryRow) };
    }

    // The cash book of a period: what was in before it, every live voucher in it with the running balance, and what was in at the end
    async function cashBook(ctx, { from, to, method } = {}) {
        const t = today();
        const end = to ? cleanDay(to, 'To', '9999-12-31') : new Date(`${t}T00:00:00Z`);
        const start = from ? cleanDay(from, 'From', '9999-12-31') : new Date(`${t.slice(0, 8)}01T00:00:00Z`);
        if (start > end) throw new V.PosValidationError('"From" cannot be after "To".');
        const m = METHODS.includes(String(method || '').toUpperCase()) ? { method: String(method).toUpperCase() } : {};
        const base = { tenantId: ctx.tenantId, voidedAt: null, ...m };
        const [before, rows, count] = await Promise.all([
            prisma.posCashEntry.groupBy({ by: ['kind'], where: { ...base, entryDate: { lt: start } }, _sum: { amount: true } }),
            prisma.posCashEntry.findMany({ where: { ...base, entryDate: { gte: start, lte: end } }, orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }], take: MAX_BOOK_ROWS, include: WITH_PARTIES }),
            prisma.posCashEntry.count({ where: { ...base, entryDate: { gte: start, lte: end } } }),
        ]);
        const sumOf = k => paisa((before.find(r => r.kind === k) || { _sum: {} })._sum.amount);
        const opening = sumOf('RECEIPT') - sumOf('PAYMENT');
        let run = opening, inn = 0, out = 0;
        const byMethod = Object.fromEntries(METHODS.map(k => [k, { in: 0, out: 0 }]));
        const entries = rows.map(e => {
            const a = paisa(e.amount);
            if (e.kind === 'RECEIPT') { run += a; inn += a; byMethod[e.method].in += a; } else { run -= a; out += a; byMethod[e.method].out += a; }
            return { ...entryRow(e), balance: rupees(run) };
        });
        return {
            from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10), method: m.method || '', opening: rupees(opening), received: rupees(inn), paid: rupees(out), closing: rupees(opening + inn - out),
            byMethod: Object.fromEntries(METHODS.map(k => [k, { label: METHOD_LABEL[k], in: rupees(byMethod[k].in), out: rupees(byMethod[k].out) }])),
            entries, truncated: count > rows.length, count,
        };
    }
    async function cashBookCsv(ctx, query) {
        const b = await cashBook(ctx, query);
        const head = ['Date', 'Number', 'Type', 'Party', 'How', 'Reference', 'Note', 'In', 'Out', 'Balance'];
        const lines = [head.join(','), ['', '', '', 'Opening balance', '', '', '', '', '', csvNum(b.opening)].map(csvText).join(',')];
        for (const e of b.entries) lines.push([e.date, e.number, e.kind === 'RECEIPT' ? 'Received' : 'Paid', e.customerName || e.vendorName || '', e.methodLabel, e.reference, e.note, e.kind === 'RECEIPT' ? csvNum(e.amount) : '', e.kind === 'PAYMENT' ? csvNum(e.amount) : '', csvNum(e.balance)].map(csvText).join(','));
        lines.push(['', '', '', 'Closing balance', '', '', '', csvNum(b.received), csvNum(b.paid), csvNum(b.closing)].map(csvText).join(','));
        await log(ctx, 'pos.export', 'PosCashEntry', null, `Exported the cash book (${b.from} to ${b.to}) to CSV`);
        return { filename: `pos-cash-book-${b.from}-to-${b.to}.csv`, csv: lines.join('\r\n') + '\r\n' };
    }
    async function vendorsCsv(ctx, query) {
        const { vendors } = await listVendors(ctx, { ...query, limit: 500, offset: 0 });
        const lines = [['Code', 'Vendor', 'NTN', 'Phone', 'Opening balance', 'Bought', 'Paid', 'We owe'].join(',')];
        for (const v of vendors) lines.push([v.code, v.name, v.ntn, v.phone, csvNum(v.openingBalance), csvNum(v.purchased), csvNum(v.paid), csvNum(v.balance)].map(csvText).join(','));
        await log(ctx, 'pos.export', 'PosVendor', null, `Exported ${vendors.length} vendors to CSV`);
        return { filename: 'pos-vendors.csv', csv: lines.join('\r\n') + '\r\n' };
    }

    // ---------- customers: what they have paid in, and what is owed or held ----------
    async function customerLedger(ctx, id) {
        const c = await prisma.posCustomer.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!c) throw new PosError(404, 'Customer not found.');
        const [f, rows] = await Promise.all([
            customerReceived(ctx.tenantId, [id]),
            prisma.posCashEntry.findMany({ where: { tenantId: ctx.tenantId, customerId: id, kind: 'RECEIPT' }, orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }], take: 200, include: WITH_PARTIES }),
        ]);
        const t = f.get(id), opening = paisa(c.openingBalance);
        return { openingBalance: rupees(opening), received: rupees(t.received), receipts: t.receipts, lastReceiptAt: t.lastReceiptAt, balance: rupees(opening - t.received), entries: rows.map(entryRow) };
    }
    async function setCustomerOpening(ctx, id, value) {
        const p = cleanBalance(value, 'Opening balance');
        const c = await inTurn(ctx.tenantId, async tx => {
            const x = await tx.posCustomer.findFirst({ where: { id, tenantId: ctx.tenantId } });
            if (!x) throw new PosError(404, 'Customer not found.');
            await tx.posCustomer.update({ where: { id }, data: { openingBalance: rupees(p) } });
            return x;
        });
        if (paisa(c.openingBalance) !== p) await log(ctx, 'pos.customer.opening', 'PosCustomer', id, `Customer "${c.name}" (${c.code}): opening balance ${money(paisa(c.openingBalance))} to ${money(p)}`);
        return customerLedger(ctx, id);
    }
    // For the customers list: the balance of each, in one query
    async function customerBalances(tenantId, customers) {
        const f = await customerReceived(tenantId, customers.map(c => c.id));
        return new Map(customers.map(c => [c.id, { received: rupees(f.get(c.id).received), balance: rupees(paisa(c.openingBalance) - f.get(c.id).received) }]));
    }

    return {
        listVendors, createVendor, updateVendor, vendorDetail, vendorsCsv,
        createPurchase, listPurchases, purchaseDetail, voidPurchase,
        receiveCash, payVendor, voidEntry, entryDetail, listEntries, cashBook, cashBookCsv,
        customerLedger, setCustomerOpening, customerBalances,
        internals: { inTurn, nextVendorCode }, // shared with the bulk import (same lock, same codes)
    };
}

module.exports = { createAccountsService, METHODS, METHOD_LABEL, cleanVendor, cleanBalance };
