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
const METHODS = { BANK: 'Bank transfer', CASH: 'Cash', CHEQUE: 'Cheque', CARD: 'Card', ONLINE: 'Online payment', OTHER: 'Other', CREDIT: 'Client credit' };
// what becomes of money received against an invoice that is cancelled (the CA)
const SETTLE = { VOID: 'voided', REFUND: 'refunded', CREDIT: 'kept as credit' };
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
// The invoice's lines and taxes, checked, with the totals in minor units: the subtotal, less the discount, plus the additional charges (the
// CA's invoice, 24 Nov 2026) is what each tax is on, rounded to the currency's unit
function cleanBody(b, currency) {
    const lines = (Array.isArray(b.lines) ? b.lines : []).map((l, i) => ({ description: V.line(l && l.description, 300, `Line ${i + 1}: description`, { required: true }), amount: money(l && l.amount, currency, `Line ${i + 1}: amount`), save: Boolean(l && l.save), sortOrder: i,
        occurrenceId: l && l.occurrenceId ? V.line(l.occurrenceId, 64, 'Obligation') : null, bankName: V.line(l && l.bankName, 300, `Line ${i + 1}: name`) }));
    if (!lines.length) throw bad('Add at least one line (what the fee is for).');
    if (lines.length > 50) throw bad('At most 50 lines.');
    const taxes = (Array.isArray(b.taxes) ? b.taxes : []).map((t, i) => ({ name: V.line(t && t.name, 60, `Tax ${i + 1}: name`, { required: true }), rate: rateOf(t && t.rate, `Tax ${i + 1}`), save: Boolean(t && t.save), sortOrder: i }));
    if (taxes.length > 10) throw bad('At most 10 taxes on one invoice.');
    const d = decimalsOf(currency);
    const sub = lines.reduce((m, l) => m + toMinor(l.amount, d), 0);
    const opt = (v, what) => (v === undefined || v === null || v === '' ? 0 : money(v, currency, what));
    const discount = toMinor(opt(b.discount, 'Discount'), d), charges = toMinor(opt(b.charges, 'Additional charges'), d);
    if (discount > sub + charges) throw bad('The discount is more than the subtotal (and the additional charges).');
    const base = sub - discount + charges;
    for (const t of taxes) t.minor = Math.round(base * t.rate / 100);
    const tax = taxes.reduce((m, t) => m + t.minor, 0);
    return { lines, taxes, d, subMinor: sub, discountMinor: discount, chargesMinor: charges, taxMinor: tax, totalMinor: base + tax };
}

function createInvoices({ prisma, audit, common, now }) {
    const log = (ctx, action, entityType, entityId, summary, details) => audit(ctx.req, { tenantId: ctx.tenantId, action, entityType, entityId, summary, details });
    const inTurn = (tenantId, what, work) => prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${what}`}))`;
        return work(tx);
    }, { maxWait: 10000, timeout: 20000 });
    const today = async tenantId => R.dayIn((await common.settings(tenantId)).timeZone, now());

    /* ---------- tax rates (country sensitive) ---------- */
    const rateView = r => ({ id: r.id, name: r.name, rate: Number(r.rate), allCountries: r.allCountries, countries: r.countries, active: r.active, type: r.type || '', effectiveFrom: r.effectiveFrom ? ymd(r.effectiveFrom) : '', createdAt: r.createdAt });
    // the tax's type and the day it applies from (the CA's Tax Configuration report), when given
    const rateExtra = b => ({ ...(b.type !== undefined ? { type: V.line(b.type, 60, 'Tax type') } : {}), ...(b.effectiveFrom !== undefined ? { effectiveFrom: b.effectiveFrom ? dateOf(V.day(b.effectiveFrom, 'Effective from')) : null } : {}) });
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
        const d = { ...cleanRate(b || {}), ...rateExtra(b || {}) };
        const r = await prisma.cmpTaxRate.create({ data: { tenantId: ctx.tenantId, ...d, createdBy: ctx.email } }).catch(e => { if (e.code === 'P2002') throw new CmpError(409, 'That tax with that rate is already there.'); throw e; });
        await log(ctx, 'cmp.tax.create', 'CmpTaxRate', r.id, `Tax "${r.name} ${Number(r.rate)}%" added for ${r.allCountries ? 'all countries' : r.countries.join(', ')}`);
        return rateView(r);
    }
    /* ---------- items and services (the CA: typed once, then suggested with their price for that country's clients) ---------- */
    const itemKey = name => R.keyOf(name);
    // every price it was billed at, newest first, with the first and last day it was used (the CA: the price bank)
    const itemView = r => ({ id: r.id, name: r.name, code: r.code || '', category: r.category || '', unit: r.unit || '', currency: r.currency, amount: Number(r.amount), allCountries: r.allCountries, countries: r.countries, active: r.active, updatedAt: r.updatedAt, createdAt: r.createdAt,
        prices: (r.prices || []).map(p => ({ amount: Number(p.amount), firstOn: ymd(p.firstOn), lastOn: ymd(p.lastOn), uses: p.uses })) });
    const PRICES = { prices: { orderBy: [{ lastOn: 'desc' }, { amount: 'desc' }], take: 20 } };
    async function listItems(ctx, q = {}) {
        const rows = await prisma.cmpItem.findMany({ where: { tenantId: ctx.tenantId, ...(q.all === '1' ? {} : { active: true }) }, orderBy: [{ name: 'asc' }, { currency: 'asc' }], include: PRICES });
        const country = q.country ? V.country(q.country).code : null;
        return rows.filter(r => !country || r.allCountries || r.countries.includes(country)).map(itemView);
    }
    // Saved from an invoice line: one per name and currency; its price is the latest one, and every price is kept with its dates (a price
    // used again only moves its last day on); it gains the client's country
    async function rememberItem(tx, ctx, name, amount, currency, country, day) {
        const key = itemKey(name);
        let item = await tx.cmpItem.findUnique({ where: { tenantId_key_currency: { tenantId: ctx.tenantId, key, currency } } });
        if (!item) item = await tx.cmpItem.create({ data: { tenantId: ctx.tenantId, name, key, currency, amount, countries: [country], createdBy: ctx.email } });
        else item = await tx.cmpItem.update({ where: { id: item.id }, data: { name, amount, active: true, ...(item.allCountries || item.countries.includes(country) ? {} : { countries: [...item.countries, country] }) } });
        const on = dateOf(day), found = await tx.cmpItemPrice.findUnique({ where: { itemId_amount: { itemId: item.id, amount } } });
        if (found) await tx.cmpItemPrice.update({ where: { id: found.id }, data: { lastOn: on, uses: { increment: 1 } } });
        else await tx.cmpItemPrice.create({ data: { tenantId: ctx.tenantId, itemId: item.id, amount, firstOn: on, lastOn: on, createdBy: ctx.email } });
        return item;
    }
    function cleanItem(b, currencyDefault) {
        const name = V.line(b.name, 300, 'Item name', { required: true }), currency = String(b.currency || currencyDefault || '').toUpperCase();
        if (!C.currencyOk(currency)) throw bad('Choose a currency from the list.');
        const out = { name, key: itemKey(name), currency, amount: money(b.amount, currency, 'Price'), allCountries: b.allCountries === true };
        out.countries = out.allCountries ? [] : [...new Set((Array.isArray(b.countries) ? b.countries : []).map(c => V.country(c).code))];
        if (!out.allCountries && !out.countries.length) throw bad('Choose the countries this item is for (or all countries).');
        // the firm's own code, a category and a unit (the CA's Item Register), when given
        for (const [k, max, label] of [['code', 40, 'Item code'], ['category', 60, 'Category'], ['unit', 40, 'Unit']]) if (b[k] !== undefined) out[k] = V.line(b[k], max, label);
        return out;
    }
    const itemTaken = e => { if (e && e.code === 'P2002') throw new CmpError(409, 'That item is already there in that currency.'); throw e; };
    async function createItem(ctx, b) {
        const d = cleanItem(b || {});
        const day = await today(ctx.tenantId);
        const known = await prisma.cmpItem.findUnique({ where: { tenantId_key_currency: { tenantId: ctx.tenantId, key: d.key, currency: d.currency } }, include: PRICES });
        if (known && b.addPrice === true) {
            // (the screen warned: "already there at …; keep this price too?")
            const it = await prisma.$transaction(tx => rememberItem(tx, ctx, d.name, d.amount, d.currency, (d.countries[0] || known.countries[0] || 'AE'), day));
            if (d.allCountries || d.countries.some(c => !known.countries.includes(c))) await prisma.cmpItem.update({ where: { id: it.id }, data: d.allCountries ? { allCountries: true } : { countries: [...new Set([...known.countries, ...d.countries])] } });
            await log(ctx, 'cmp.item.price', 'CmpItem', it.id, `Item "${it.name}": another price kept, ${amountText(d.amount, d.currency)} (the earlier prices stay)`);
            return itemView(await prisma.cmpItem.findUnique({ where: { id: it.id }, include: PRICES }));
        }
        if (known) throw new CmpError(409, `"${known.name}" is already there in ${known.currency} (${known.prices.map(p => amountText(p.amount, known.currency)).join(', ') || amountText(known.amount, known.currency)}).`);
        const r = await prisma.cmpItem.create({ data: { tenantId: ctx.tenantId, ...d, createdBy: ctx.email, prices: { create: [{ tenantId: ctx.tenantId, amount: d.amount, firstOn: dateOf(day), lastOn: dateOf(day), createdBy: ctx.email }] } } }).catch(itemTaken);
        await log(ctx, 'cmp.item.create', 'CmpItem', r.id, `Item "${r.name}" (${amountText(r.amount, r.currency)}) added for ${r.allCountries ? 'all countries' : r.countries.join(', ')}`);
        return itemView(r);
    }
    async function updateItem(ctx, id, b) {
        const r = await prisma.cmpItem.findFirst({ where: { id: String(id || ''), tenantId: ctx.tenantId } });
        if (!r) throw new CmpError(404, 'Item not found.');
        const data = {};
        if (['name', 'amount', 'currency', 'allCountries', 'countries', 'code', 'category', 'unit'].some(k => b[k] !== undefined)) Object.assign(data, cleanItem({ name: b.name ?? r.name, amount: b.amount ?? Number(r.amount), currency: b.currency ?? r.currency, allCountries: b.allCountries ?? r.allCountries, countries: b.countries ?? r.countries, code: b.code ?? r.code, category: b.category ?? r.category, unit: b.unit ?? r.unit }));
        if (b.active !== undefined) data.active = b.active === true;
        const u = await prisma.cmpItem.update({ where: { id: r.id }, data }).catch(itemTaken);
        // a price changed here joins the bank too
        if (data.amount !== undefined && Number(u.amount) !== Number(r.amount)) {
            const day = dateOf(await today(ctx.tenantId));
            await prisma.cmpItemPrice.upsert({ where: { itemId_amount: { itemId: u.id, amount: u.amount } }, create: { tenantId: ctx.tenantId, itemId: u.id, amount: u.amount, firstOn: day, lastOn: day, createdBy: ctx.email }, update: { lastOn: day } });
        }
        await log(ctx, 'cmp.item.update', 'CmpItem', r.id, `Item "${r.name}" → "${u.name}" ${amountText(u.amount, u.currency)} for ${u.allCountries ? 'all countries' : u.countries.join(', ')}${u.active ? '' : ' (not suggested any more)'}`,
            { changes: common.changes({ ...r, amount: Number(r.amount) }, { ...u, amount: Number(u.amount) }, { name: 'Name', code: 'Code', category: 'Category', unit: 'Unit', currency: 'Currency', amount: 'Price', countries: 'Countries', allCountries: 'All countries', active: 'In use' }) });
        return itemView(u);
    }

    async function updateTaxRate(ctx, id, b) {
        const r = await prisma.cmpTaxRate.findFirst({ where: { id: String(id || ''), tenantId: ctx.tenantId } });
        if (!r) throw new CmpError(404, 'Tax not found.');
        const data = {};
        if (b.name !== undefined || b.rate !== undefined || b.allCountries !== undefined || b.countries !== undefined) Object.assign(data, cleanRate({ name: b.name ?? r.name, rate: b.rate ?? Number(r.rate), allCountries: b.allCountries ?? r.allCountries, countries: b.countries ?? r.countries }));
        if (b.active !== undefined) data.active = b.active === true;
        Object.assign(data, rateExtra(b));
        // a new rate (the CA: a tax can have as many rates as it has; warned first, then both kept): the new rate is a tax of its own
        if (data.rate !== undefined && data.rate !== Number(r.rate) && b.keepOld === true) {
            const n = await prisma.cmpTaxRate.create({ data: { tenantId: ctx.tenantId, name: data.name, rate: data.rate, allCountries: data.allCountries, countries: data.countries, type: data.type ?? r.type, effectiveFrom: data.effectiveFrom ?? null, createdBy: ctx.email } }).catch(e => { if (e.code === 'P2002') throw new CmpError(409, 'That tax with that rate is already there.'); throw e; });
            await log(ctx, 'cmp.tax.create', 'CmpTaxRate', n.id, `Tax "${n.name}": another rate ${Number(n.rate)}% kept beside ${Number(r.rate)}%`);
            return rateView(n);
        }
        const u = await prisma.cmpTaxRate.update({ where: { id: r.id }, data }).catch(e => { if (e.code === 'P2002') throw new CmpError(409, 'That tax with that rate is already there.'); throw e; });
        await log(ctx, 'cmp.tax.update', 'CmpTaxRate', r.id, `Tax "${r.name} ${Number(r.rate)}%" → "${u.name} ${Number(u.rate)}%" for ${u.allCountries ? 'all countries' : u.countries.join(', ')}${u.active ? '' : ' (not suggested any more)'}`);
        return rateView(u);
    }

    /* ---------- advance payments (the CA's tracker: money received before the invoice, taken off it later) ---------- */
    // An advance payment, with its numbered receipt (the CA, 24 Nov 2026: "it should have a receipt number"), how it was paid, whether
    // its receipt was sent, and its status: Active (nothing taken off an invoice yet), Partly adjusted, Fully adjusted or Void
    const advStatus = a => (a.voidedAt ? 'VOID' : Number(a.used) <= 0 ? 'ACTIVE' : toMinor(a.used, decimalsOf(a.currency)) >= toMinor(a.amount, decimalsOf(a.currency)) ? 'ADJUSTED' : 'PARTLY');
    const advView = a => ({ id: a.id, clientId: a.clientId, occurrenceId: a.occurrenceId, number: a.number || '', receivedOn: ymd(a.receivedOn), description: a.description, currency: a.currency, amount: Number(a.amount), used: Number(a.used),
        available: fromMinor(toMinor(a.amount, decimalsOf(a.currency)) - toMinor(a.used, decimalsOf(a.currency)), decimalsOf(a.currency)), method: a.method || 'BANK', reference: a.reference || '', sentAt: a.sentAt || null,
        typeId: a.typeId || null, typeSnapshot: a.typeSnapshot || null, status: advStatus(a), createdBy: a.createdBy, createdAt: a.createdAt, voidedAt: a.voidedAt, voidedBy: a.voidedBy || null, voidReason: a.voidReason,
        ...(a.client ? { client: { id: a.client.id, code: a.client.code, name: a.client.name, country: a.client.country, noWhatsApp: a.client.noWhatsApp } } : {}),
        ...(a.occurrence ? { obligation: { id: a.occurrence.obligation.id, name: a.occurrence.obligation.name, occurrenceId: a.occurrence.id, periodStart: ymd(a.occurrence.periodStart), periodEnd: ymd(a.occurrence.periodEnd) } } : {}),
        ...(a._count ? { sentCount: a._count.messages } : {}) });
    const ADV_INCLUDE = { client: true, occurrence: { select: { id: true, periodStart: true, periodEnd: true, obligation: { select: { id: true, name: true } } } }, _count: { select: { messages: { where: { voidedAt: null, kind: 'ADVANCE' } } } } };
    // ?clientId, ?occurrenceId, ?available=1 (something left to take off), ?status=all (the undone ones too), ?from/?to (day received), ?q
    async function listAdvances(ctx, q = {}) {
        const where = { tenantId: ctx.tenantId };
        if (q.clientId) where.clientId = String(q.clientId);
        if (q.occurrenceId) where.occurrenceId = String(q.occurrenceId);
        if (q.status !== 'all') where.voidedAt = null;
        if (q.from || q.to) where.receivedOn = { ...(q.from ? { gte: dateOf(V.day(q.from, 'From')) } : {}), ...(q.to ? { lte: dateOf(V.day(q.to, 'To')) } : {}) };
        const s = String(q.q || '').trim().slice(0, 100);
        if (s) where.OR = [{ number: ciContains(s) }, { description: ciContains(s) }, { reference: ciContains(s) }, { client: { name: ciContains(s) } }, { client: { code: ciContains(s) } }];
        const rows = await prisma.cmpAdvance.findMany({ where, orderBy: [{ receivedOn: 'desc' }, { createdAt: 'desc' }], take: Math.min(Number(q.limit) || 2000, 20000), include: ADV_INCLUDE });
        return rows.map(advView).filter(a => q.available !== '1' || a.available > 0);
    }
    // One advance with what its receipt says (the CA's automatic fields: document number, date, status, total advance amount, amount
    // received, outstanding advance balance, created date and time) and the invoices it was taken off
    async function getAdvance(ctx, id) {
        const a = await prisma.cmpAdvance.findFirst({ where: { id: String(id || ''), tenantId: ctx.tenantId }, include: ADV_INCLUDE });
        if (!a) throw new CmpError(404, 'Advance payment not found.');
        const d = decimalsOf(a.currency);
        // the client's advances in this currency up to this one (not undone): their total, and what of them is not taken off an invoice yet
        const mine = await prisma.cmpAdvance.findMany({ where: { tenantId: ctx.tenantId, clientId: a.clientId, currency: a.currency, voidedAt: null, OR: [{ receivedOn: { lt: a.receivedOn } }, { receivedOn: a.receivedOn, createdAt: { lte: a.createdAt } }] } });
        const totalMinor = mine.reduce((m, x) => m + toMinor(x.amount, d), 0), leftMinor = mine.reduce((m, x) => m + toMinor(x.amount, d) - toMinor(x.used, d), 0);
        const invs = await prisma.cmpInvoice.findMany({ where: { tenantId: ctx.tenantId, clientId: a.clientId, status: { notIn: ['DRAFT', 'CANCELLED'] } }, select: { id: true, number: true, issueDate: true, advanceUse: true } });
        const adjustments = invs.flatMap(i => (Array.isArray(i.advanceUse) ? i.advanceUse : []).filter(u => u.advanceId === a.id).map(u => ({ invoiceId: i.id, number: i.number, issueDate: ymd(i.issueDate), amount: Number(u.amount) })));
        return { ...advView(a), clientTotal: fromMinor(totalMinor, d), clientOutstanding: fromMinor(leftMinor, d), adjustments, clientFields: await clientFieldValues(ctx.tenantId, a.clientId),
            client: { ...advView(a).client, address: a.client.address, email: a.client.email, contactNumber: a.client.contactNumber, registrationNo: a.client.registrationNo, reference: a.client.reference } };
    }
    // the descriptions typed before, most used first (the CA: suggested again)
    async function advanceDescriptions(ctx) {
        const rows = await prisma.cmpAdvance.groupBy({ by: ['description'], where: { tenantId: ctx.tenantId }, _count: { description: true }, orderBy: { _count: { description: 'desc' } }, take: 100 });
        return rows.map(r => r.description);
    }
    async function addAdvance(ctx, b = {}) {
        let client, occ = null;
        if (b.occurrenceId) { occ = await common.findOccurrence(ctx.tenantId, b.occurrenceId, { live: true }); client = occ.obligation.client; }
        else client = await common.findClient(ctx.tenantId, b.clientId, { live: true });
        if (b.clientId && b.clientId !== client.id) throw bad('That obligation is not this client\'s.');
        const currency = String(b.currency || (C.get(client.country) || {}).currency || 'USD').toUpperCase();
        if (!C.currencyOk(currency)) throw bad('Choose a currency from the list.');
        const amount = money(b.amount, currency, 'Advance amount', { positive: true });
        const description = V.line(b.description, 200, 'Description', { required: true });
        const day = b.receivedOn ? V.day(b.receivedOn, 'Date received') : await today(ctx.tenantId);
        const method = String(b.method || 'BANK').toUpperCase();
        if (!METHODS[method] || method === 'CREDIT') throw bad('Choose how the advance was paid.');
        const reference = V.line(b.reference, 120, 'Reference');
        // its format: the one chosen, else the country's default advance payment format; frozen on it as it is now (like a receipt's)
        const type = b.typeId ? await findType(ctx, b.typeId, client.country, 'ADVANCE')
            : await prisma.cmpInvoiceType.findFirst({ where: { tenantId: ctx.tenantId, country: client.country, kind: 'ADVANCE', active: true }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
        // its number, in turn with every other advance of the firm (never twice); past the highest one already given, whatever the counter says
        const a = await inTurn(ctx.tenantId, 'cmp-advance-no', async tx => {
            const s = await tx.cmpSettings.upsert({ where: { tenantId: ctx.tenantId }, create: { tenantId: ctx.tenantId, advanceSeq: 1 }, update: { advanceSeq: { increment: 1 } } });
            const top = (await tx.cmpAdvance.aggregate({ where: { tenantId: ctx.tenantId }, _max: { seqNo: true } }))._max.seqNo || 0;
            const seq = Math.max(s.advanceSeq, top + 1);
            if (seq !== s.advanceSeq) await tx.cmpSettings.update({ where: { tenantId: ctx.tenantId }, data: { advanceSeq: seq } });
            return tx.cmpAdvance.create({ data: { tenantId: ctx.tenantId, clientId: client.id, occurrenceId: occ ? occ.id : null, receivedOn: dateOf(day), description, currency, amount, method, reference,
                seqNo: seq, number: formatNo(s.advanceFormat || 'ADV-{YYYY}-{NNNN}', seq, day), typeId: type ? type.id : null, typeSnapshot: type ? { id: type.id, name: type.name, country: type.country, layout: type.layout } : undefined, createdBy: ctx.email } });
        });
        await log(ctx, 'cmp.advance.create', 'CmpAdvance', a.id, `Advance payment ${a.number} from ${common.clientLabel(client)}: ${amountText(amount, currency)} on ${R.fmtDay(day)} by ${METHODS[method].toLowerCase()} (${description})${occ ? ` for ${occ.obligation.name} ${R.periodName(occ)}` : ''}`, { clientId: client.id, ...(occ ? { obligationId: occ.obligationId } : {}) });
        return advView(a);
    }
    // changed (the CA: an advance must be editable): its date, description and amount; never less than what is already taken off
    async function updateAdvance(ctx, id, b = {}) {
        const a = await inTurn(ctx.tenantId, 'cmp-advance', async tx => {
            const row = await tx.cmpAdvance.findFirst({ where: { id: String(id || ''), tenantId: ctx.tenantId }, include: { client: true } });
            if (!row) throw new CmpError(404, 'Advance payment not found.');
            if (row.voidedAt) throw new CmpError(409, 'This advance payment is undone.');
            const data = {};
            if (b.description !== undefined) data.description = V.line(b.description, 200, 'Description', { required: true });
            if (b.receivedOn !== undefined) data.receivedOn = dateOf(V.day(b.receivedOn, 'Date received'));
            if (b.method !== undefined) { data.method = String(b.method || 'BANK').toUpperCase(); if (!METHODS[data.method] || data.method === 'CREDIT') throw bad('Choose how the advance was paid.'); }
            if (b.reference !== undefined) data.reference = V.line(b.reference, 120, 'Reference');
            if (b.currency !== undefined && String(b.currency).toUpperCase() !== row.currency) {
                if (Number(row.used) > 0) throw new CmpError(409, 'Part of it is taken off an invoice: its currency cannot change.');
                data.currency = String(b.currency).toUpperCase();
                if (!C.currencyOk(data.currency)) throw bad('Choose a currency from the list.');
            }
            const cur = data.currency || row.currency;
            if (b.amount !== undefined) {
                data.amount = money(b.amount, cur, 'Advance amount', { positive: true });
                const d = decimalsOf(cur);
                if (toMinor(data.amount, d) < toMinor(row.used, d)) throw bad(`${amountText(row.used, cur)} of it is already taken off an invoice: the amount cannot be less.`);
            }
            const upd = await tx.cmpAdvance.update({ where: { id: row.id }, data });
            return { row, upd };
        });
        const { row, upd } = a, what = [];
        if (Number(upd.amount) !== Number(row.amount) || upd.currency !== row.currency) what.push(`${amountText(row.amount, row.currency)} → ${amountText(upd.amount, upd.currency)}`);
        if (upd.description !== row.description) what.push(`"${row.description}" → "${upd.description}"`);
        if (+upd.receivedOn !== +row.receivedOn) what.push(`${R.fmtDay(row.receivedOn)} → ${R.fmtDay(upd.receivedOn)}`);
        if (upd.method !== row.method) what.push(`paid by ${METHODS[row.method] || row.method} → ${METHODS[upd.method] || upd.method}`);
        if (upd.reference !== row.reference) what.push('reference');
        if (what.length) await log(ctx, 'cmp.advance.update', 'CmpAdvance', row.id, `Advance payment ${row.number || ''} from ${common.clientLabel(row.client)} changed: ${what.join(', ')}`.replace('  ', ' '),
            { clientId: row.clientId, changes: common.changes(row, upd, { receivedOn: 'Date received', description: 'Description', currency: 'Currency', amount: 'Amount', method: 'Paid by', reference: 'Reference' }) });
        return advView(upd);
    }
    // undone (a mistake): only while none of it is taken off an issued invoice
    async function voidAdvance(ctx, id, reason) {
        const why = V.line(reason, 300, 'Reason', { required: true });
        const a = await inTurn(ctx.tenantId, 'cmp-advance', async tx => {
            const row = await tx.cmpAdvance.findFirst({ where: { id: String(id || ''), tenantId: ctx.tenantId }, include: { client: true } });
            if (!row) throw new CmpError(404, 'Advance payment not found.');
            if (row.voidedAt) throw new CmpError(409, 'This advance payment is already undone.');
            if (Number(row.used) > 0) throw new CmpError(409, `${amountText(row.used, row.currency)} of it is taken off an invoice. Cancel that invoice first.`);
            await tx.cmpAdvance.update({ where: { id: row.id }, data: { voidedAt: now(), voidedBy: ctx.email, voidReason: why } });
            return row;
        });
        await log(ctx, 'cmp.advance.void', 'CmpAdvance', a.id, `Advance payment from ${common.clientLabel(a.client)} of ${amountText(a.amount, a.currency)} (${R.fmtDay(a.receivedOn)}) undone: ${why}`, { clientId: a.clientId });
        return { ok: true };
    }
    // The advances asked for on a draft: the client's, in the invoice's currency, each at most what is left of it, all together at most the
    // invoice's gross amount. Returns [{ advanceId, amount }] and their sum in minor units.
    async function cleanAdvanceUse(tenantId, inv, list, currency, grossMinor, db = prisma) {
        const given = (Array.isArray(list) ? list : []).filter(x => x && x.advanceId && Number(x.amount) > 0);
        if (given.length > 30) throw bad('At most 30 advance payments on one invoice.');
        const d = decimalsOf(currency), ids = [...new Set(given.map(x => String(x.advanceId)))];
        if (ids.length !== given.length) throw bad('An advance payment is there twice.');
        const rows = ids.length ? await db.cmpAdvance.findMany({ where: { tenantId, id: { in: ids }, clientId: inv.clientId, voidedAt: null } }) : [];
        let sum = 0;
        const out = given.map(x => {
            const a = rows.find(r => r.id === String(x.advanceId));
            if (!a) throw bad('One of the advance payments is not this client\'s (or was undone). Reload the page.');
            if (a.currency !== currency) throw bad(`The advance of ${R.fmtDay(a.receivedOn)} is in ${a.currency}; this invoice is in ${currency}.`);
            const amount = money(x.amount, currency, 'Advance adjustment', { positive: true }), m = toMinor(amount, d);
            if (m > toMinor(a.amount, d) - toMinor(a.used, d)) throw bad(`Only ${amountText(fromMinor(toMinor(a.amount, d) - toMinor(a.used, d), d), currency)} is left of the advance of ${R.fmtDay(a.receivedOn)} (${a.description}).`);
            sum += m;
            return { advanceId: a.id, amount };
        });
        if (sum > grossMinor) throw bad(`The advance taken off (${amountText(fromMinor(sum, d), currency)}) is more than the invoice's gross amount (${amountText(fromMinor(grossMinor, d), currency)}).`);
        return { use: out, minor: sum };
    }

    /* ---------- invoice types (the CA: country sensitive, several per country, chosen when the invoice is made) ---------- */
    const typeView = t => ({ id: t.id, name: t.name, kind: t.kind || 'INVOICE', country: t.country, isDefault: t.isDefault, layout: t.layout || {}, active: t.active, updatedAt: t.updatedAt });
    const ALIGN = ['left', 'center', 'right'];
    const num = (v, min, max, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 10) / 10)) : dflt; };
    function cleanLayout(l = {}) {
        const out = {
            invoiceTitle: V.line(l.invoiceTitle, 40, 'The invoice title') || 'INVOICE', receiptTitle: V.line(l.receiptTitle, 40, 'The receipt title') || 'RECEIPT',
            headerStyle: ['DEFAULT', 'LOGO', 'LETTERHEAD', 'NONE'].includes(l.headerStyle) ? l.headerStyle : 'DEFAULT',
            firmName: V.line(l.firmName, 200, 'Firm name'), firmAddress: V.multiline(l.firmAddress, 500, 'Address'), taxLabel: V.line(l.taxLabel, 40, 'The tax number\'s label'), taxNo: V.line(l.taxNo, 60, 'Tax registration number'),
            bankDetails: V.multiline(l.bankDetails, 800, 'Bank details'), footer: V.multiline(l.footer, 500, 'Footer'), receiptNote: V.multiline(l.receiptNote, 500, 'Receipt note'),
            showBank: l.showBank !== false, showClientTaxNo: l.showClientTaxNo !== false,
            advanceTitle: V.line(l.advanceTitle, 40, 'The advance receipt title') || 'ADVANCE PAYMENT RECEIPT', advanceNote: V.multiline(l.advanceNote, 500, 'Advance receipt note'),
        };
        // the client's details and the automatic information ticked to show on this format (the CA, 24 Nov 2026: a tick against each);
        // absent = as before (the standard choice). Client details are keys (name, code, …) or "f:<field id>" for an additional field.
        const keys = (v, max) => (Array.isArray(v) ? [...new Set(v.map(x => String(x || '').slice(0, 60)).filter(x => /^[a-zA-Z]+$|^f:[0-9a-f-]{36}$/.test(x)))].slice(0, max) : undefined);
        if (l.clientFields !== undefined) out.clientFields = keys(l.clientFields, 80);
        if (l.autoFields !== undefined) out.autoFields = keys(l.autoFields, 40);
        const blocks = Array.isArray(l.blocks) ? l.blocks : [];
        if (blocks.length > 40) throw bad('At most 40 pieces of information on one format.');
        out.blocks = blocks.map((b, i) => ({
            id: b && typeof b.id === 'string' && /^[a-z0-9]{4,16}$/i.test(b.id) && !blocks.slice(0, i).some(x => x && x.id === b.id) ? b.id : `b${i}${Math.random().toString(36).slice(2, 7)}`,
            doc: b && b.doc === 'RECEIPT' ? 'RECEIPT' : 'INVOICE',
            text: V.multiline(b && b.text, 500, `Information ${i + 1}`, { required: true }),
            x: num(b && b.x, 0, 100, 5), y: num(b && b.y, 0, 100, 5), w: num(b && b.w, 5, 100, 40), size: num(b && b.size, 6, 32, 11),
            bold: Boolean(b && b.bold), align: ALIGN.includes(b && b.align) ? b.align : 'left', border: Boolean(b && b.border),
        }));
        return out;
    }
    async function listTypes(ctx, q = {}) {
        const where = { tenantId: ctx.tenantId, ...(q.all === '1' ? {} : { active: true }) };
        if (q.country) where.country = V.country(q.country).code;
        if (q.kind) where.kind = kindOf(q.kind);
        return (await prisma.cmpInvoiceType.findMany({ where, orderBy: [{ kind: 'asc' }, { country: 'asc' }, { isDefault: 'desc' }, { name: 'asc' }] })).map(typeView);
    }
    const typeTaken = e => { if (e && e.code === 'P2002') throw new CmpError(409, 'There is already a format with that name.'); throw e; };
    const kindOf = k => (['RECEIPT', 'ADVANCE'].includes(String(k || '').toUpperCase()) ? String(k).toUpperCase() : 'INVOICE');
    const KIND_NAME = { INVOICE: 'Invoice', RECEIPT: 'Receipt', ADVANCE: 'Advance payment' };
    async function saveType(ctx, id, b = {}) {
        const old = id ? await prisma.cmpInvoiceType.findFirst({ where: { id: String(id), tenantId: ctx.tenantId } }) : null;
        if (id && !old) throw new CmpError(404, 'Invoice type not found.');
        const data = {};
        if (!old || b.name !== undefined) data.name = V.line(b.name, 60, 'Name', { required: true });
        if (!old || b.country !== undefined) data.country = V.country(b.country).code;
        if (!old) data.kind = kindOf(b.kind);
        if (!old || b.layout !== undefined) data.layout = cleanLayout(b.layout || {});
        if (b.isDefault !== undefined) data.isDefault = b.isDefault === true;
        if (b.active !== undefined) data.active = b.active === true;
        const t = await prisma.$transaction(async tx => {
            const row = old ? await tx.cmpInvoiceType.update({ where: { id: old.id }, data }) : await tx.cmpInvoiceType.create({ data: { tenantId: ctx.tenantId, ...data, createdBy: ctx.email } });
            // one default per country and kind (the one an invoice, or a receipt, of that country starts with)
            if (row.isDefault) await tx.cmpInvoiceType.updateMany({ where: { tenantId: ctx.tenantId, country: row.country, kind: row.kind, id: { not: row.id } }, data: { isDefault: false } });
            return row;
        }).catch(typeTaken);
        await log(ctx, old ? 'cmp.invtype.update' : 'cmp.invtype.create', 'CmpInvoiceType', t.id, `${KIND_NAME[t.kind] || 'Invoice'} format "${t.name}" (${common.countryName(t.country)}) ${old ? (data.active === false ? 'retired' : data.active === true ? 'back in use' : 'changed') : 'added'}${t.isDefault ? ', the default for its country' : ''}`,
            old ? { changes: common.changes({ ...old, layout: JSON.stringify(old.layout) }, { ...old, ...t, layout: JSON.stringify(t.layout) }, { name: 'Name', country: 'Country', isDefault: 'Default', active: 'In use', layout: 'Layout' }) } : undefined);
        return typeView(t);
    }
    // Deleted (the CA: "there should be an option to delete"): the documents already made keep the format as it was (frozen on each); a
    // draft invoice that had it takes its country's default when it is issued
    async function deleteType(ctx, id) {
        const t = await prisma.cmpInvoiceType.findFirst({ where: { id: String(id || ''), tenantId: ctx.tenantId } });
        if (!t) throw new CmpError(404, 'Format not found.');
        await prisma.$transaction([
            prisma.cmpInvoice.updateMany({ where: { tenantId: ctx.tenantId, typeId: t.id, status: 'DRAFT' }, data: { typeId: null } }),
            prisma.cmpInvoiceType.delete({ where: { id: t.id } }),
        ]);
        await log(ctx, 'cmp.invtype.delete', 'CmpInvoiceType', t.id, `${KIND_NAME[t.kind] || 'Invoice'} format "${t.name}" (${common.countryName(t.country)}) deleted`);
        return { ok: true };
    }
    async function findType(ctx, id, country, kind = 'INVOICE') {
        if (!id) return null;
        const t = await prisma.cmpInvoiceType.findFirst({ where: { id: String(id), tenantId: ctx.tenantId } });
        if (!t) throw bad('That format is not one of yours any more. Reload the page.');
        if ((t.kind || 'INVOICE') !== kind) throw bad(`"${t.name}" is not a${kind === 'INVOICE' ? 'n invoice' : kind === 'RECEIPT' ? ' receipt' : 'n advance payment'} format.`);
        if (country && t.country !== country) throw bad(`"${t.name}" is for ${common.countryName(t.country)} clients.`);
        return t;
    }

    /* ---------- a client's completed obligations, to bill (the CA: they show on the invoice, and once added are not offered again) ---------- */
    async function billable(ctx, clientId, q = {}) {
        const client = await common.findClient(ctx.tenantId, clientId);
        const currency = String(q.currency || (C.get(client.country) || {}).currency || 'USD').toUpperCase();
        const except = q.invoiceId ? String(q.invoiceId) : '';
        const occs = await prisma.cmpOccurrence.findMany({ where: { tenantId: ctx.tenantId, clientId: client.id, stage: 'COMPLETED', OR: [{ closeKind: null }, { closeKind: { not: 'FREE' } }] },
            orderBy: { dueDate: 'desc' }, take: 300, include: { obligation: { select: { id: true, name: true } } } });
        const ids = occs.map(o => o.id);
        const used = ids.length ? await prisma.cmpInvoiceLine.findMany({ where: { occurrenceId: { in: ids }, invoice: { status: { not: 'CANCELLED' }, ...(except ? { id: { not: except } } : {}) } }, select: { occurrenceId: true, invoice: { select: { number: true } } } }) : [];
        const legacy = ids.length ? await prisma.cmpInvoice.findMany({ where: { occurrenceId: { in: ids }, status: { not: 'CANCELLED' }, ...(except ? { id: { not: except } } : {}) }, select: { occurrenceId: true } }) : [];
        const billed = new Set([...used.map(u => u.occurrenceId), ...legacy.map(l => l.occurrenceId)]);
        const items = await prisma.cmpItem.findMany({ where: { tenantId: ctx.tenantId, currency, key: { in: [...new Set(occs.map(o => itemKey(o.obligation.name)))] } }, include: PRICES });
        return occs.filter(o => !billed.has(o.id)).map(o => {
            const it = items.find(x => x.key === itemKey(o.obligation.name));
            return { occurrenceId: o.id, obligationId: o.obligation.id, name: o.obligation.name, period: R.periodName(o), periodStart: ymd(o.periodStart), periodEnd: ymd(o.periodEnd), dueDate: ymd(o.dueDate), completedOn: o.completedOn ? ymd(o.completedOn) : null,
                currency, price: it ? Number(it.amount) : null, prices: it ? itemView(it).prices : [] };
        });
    }

    /* ---------- invoices ---------- */
    const INCLUDE = { client: true, lines: { orderBy: { sortOrder: 'asc' } }, taxes: { orderBy: { sortOrder: 'asc' } }, receipts: { orderBy: { createdAt: 'asc' } },
        occurrence: { select: { id: true, seq: true, periodStart: true, periodEnd: true, dueDate: true, obligation: { select: { id: true, name: true } } } } };
    const view = inv => ({
        id: inv.id, number: inv.number, status: inv.status, currency: inv.currency, issueDate: ymd(inv.issueDate), dueDate: ymd(inv.dueDate),
        subtotal: Number(inv.subtotal), discount: Number(inv.discount || 0), charges: Number(inv.charges || 0), taxTotal: Number(inv.taxTotal), total: Number(inv.total), received: Number(inv.received),
        advanceAdjusted: Number(inv.advanceAdjusted || 0), advanceUse: Array.isArray(inv.advanceUse) ? inv.advanceUse : [], net: Number(inv.total) - Number(inv.advanceAdjusted || 0),
        outstanding: fromMinor(owedMinor(inv), decimalsOf(inv.currency)), typeId: inv.typeId || null, typeSnapshot: inv.typeSnapshot || null,
        notes: inv.notes, issuedAt: inv.issuedAt, issuedBy: inv.issuedBy, sentAt: inv.sentAt, cancelledAt: inv.cancelledAt, cancelledBy: inv.cancelledBy, cancelReason: inv.cancelReason, createdBy: inv.createdBy, createdAt: inv.createdAt,
        client: inv.client ? { id: inv.client.id, code: inv.client.code, name: inv.client.name, country: inv.client.country, address: inv.client.address, email: inv.client.email, contactNumber: inv.client.contactNumber, registrationNo: inv.client.registrationNo, reference: inv.client.reference, noWhatsApp: inv.client.noWhatsApp } : undefined,
        obligation: inv.occurrence ? { id: inv.occurrence.obligation.id, name: inv.occurrence.obligation.name, occurrenceId: inv.occurrence.id, periodStart: ymd(inv.occurrence.periodStart), periodEnd: ymd(inv.occurrence.periodEnd) } : null,
        lines: inv.lines ? inv.lines.map(l => ({ description: l.description, amount: Number(l.amount), occurrenceId: l.occurrenceId || null, bankName: l.bankName || '' })) : undefined,
        taxes: inv.taxes ? inv.taxes.map(t => ({ name: t.name, rate: Number(t.rate), amount: Number(t.amount) })) : undefined,
        receipts: inv.receipts ? inv.receipts.map(r => ({ id: r.id, number: r.number, amount: Number(r.amount), receivedOn: ymd(r.receivedOn), method: r.method, reference: r.reference, notes: r.notes, createdBy: r.createdBy, createdAt: r.createdAt, voidedAt: r.voidedAt, voidedBy: r.voidedBy, voidReason: r.voidReason,
            settlement: r.settlement, settledAt: r.settledAt, settlementNote: r.settlementNote, typeId: r.typeId || null, typeSnapshot: r.typeSnapshot || null })) : undefined,
        cancelSettlement: inv.cancelSettlement,
    });
    async function find(ctx, id, db = prisma) {
        const inv = await db.cmpInvoice.findFirst({ where: { id: String(id || ''), tenantId: ctx.tenantId }, include: INCLUDE });
        if (!inv) throw new CmpError(404, 'Invoice not found.');
        return inv;
    }
    // The client's credit still to use, per currency (money kept when an invoice was cancelled: the CA)
    async function creditOf(tenantId, clientId, db = prisma) {
        const rows = await db.cmpCredit.findMany({ where: { tenantId, clientId }, orderBy: { createdAt: 'asc' } });
        const m = new Map();
        for (const c of rows) { const d = decimalsOf(c.currency), left = toMinor(c.amount, d) - toMinor(c.used, d); if (left > 0) m.set(c.currency, (m.get(c.currency) || 0) + left); }
        return [...m.entries()].map(([currency, minor]) => ({ currency, remaining: fromMinor(minor, decimalsOf(currency)) }));
    }
    // The client's additional information with its values (a format can show any of them: the CA, 24 Nov 2026)
    async function clientFieldValues(tenantId, clientId) {
        const rows = await prisma.cmpFieldValue.findMany({ where: { tenantId, clientId, field: { active: true } }, include: { field: { select: { id: true, name: true, type: true } } } });
        return rows.filter(r => r.value !== '').map(r => ({ id: r.field.id, name: r.field.name, value: r.field.type === 'DATE' ? R.fmtDay(r.value) : r.value }));
    }
    // (and the advances taken off it, each with its whole amount: the CA wants both, "100 received, 50 adjusted here"); each receipt with what
    // its automatic fields say (the CA: payment status, the client's balance after the payment, the invoice it is for)
    const get = async (ctx, id) => {
        const inv = await find(ctx, id), use = Array.isArray(inv.advanceUse) ? inv.advanceUse : [];
        const advs = use.length ? await prisma.cmpAdvance.findMany({ where: { id: { in: use.map(u => u.advanceId) }, tenantId: ctx.tenantId } }) : [];
        const advanceDetails = use.map(u => { const a = advs.find(x => x.id === u.advanceId); return a ? { advanceId: a.id, adjusted: Number(u.amount), amount: Number(a.amount), used: Number(a.used), receivedOn: ymd(a.receivedOn), description: a.description } : null; }).filter(Boolean);
        const out = { ...view(inv), advanceDetails, clientCredit: await creditOf(ctx.tenantId, inv.clientId), clientFields: await clientFieldValues(ctx.tenantId, inv.clientId) };
        if (out.receipts && out.receipts.length) {
            const d = decimalsOf(inv.currency);
            const [invs, rcs] = await Promise.all([
                prisma.cmpInvoice.findMany({ where: { tenantId: ctx.tenantId, clientId: inv.clientId, currency: inv.currency, status: { notIn: ['DRAFT', 'CANCELLED'] } }, select: { total: true, advanceAdjusted: true, issuedAt: true } }),
                prisma.cmpReceipt.findMany({ where: { tenantId: ctx.tenantId, clientId: inv.clientId, voidedAt: null, settlement: '', invoice: { currency: inv.currency, status: { not: 'CANCELLED' } } }, select: { id: true, amount: true, createdAt: true, invoiceId: true } }),
            ]);
            const netOf = x => toMinor(x.total, d) - toMinor(x.advanceAdjusted || 0, d);
            for (const r of out.receipts) {
                const at = +new Date(r.createdAt), live = rcs.filter(x => +x.createdAt <= at);
                const billed = invs.filter(x => x.issuedAt && +x.issuedAt <= at).reduce((m, x) => m + netOf(x), 0);
                const paidHere = live.filter(x => x.invoiceId === inv.id).reduce((m, x) => m + toMinor(x.amount, d), 0);
                r.paidToDate = fromMinor(paidHere, d);
                r.paymentStatus = r.voidedAt ? 'VOID' : paidHere >= netOf(inv) ? 'PAID' : 'PARTLY';
                r.clientBalanceAfter = fromMinor(Math.max(0, billed - live.reduce((m, x) => m + toMinor(x.amount, d), 0)), d);
            }
        }
        return out;
    };
    // The status after any change of money or of "sent": issued → sent → partially received → received (cancelled and drafts stay)
    // (an advance taken off the invoice counts as paid: Gross − Advance = Net, and only the net is still owed)
    const statusOf = inv => {
        if (inv.status === 'DRAFT' || inv.status === 'CANCELLED') return inv.status;
        const d = decimalsOf(inv.currency), total = toMinor(inv.total, d), received = toMinor(inv.received, d), paid = received + toMinor(inv.advanceAdjusted || 0, d);
        if (paid > 0 && paid >= total) return 'RECEIVED';
        if (received > 0) return 'PARTIAL';
        return inv.sentAt ? 'SENT' : 'ISSUED';
    };
    const owedMinor = inv => { const d = decimalsOf(inv.currency); return toMinor(inv.total, d) - toMinor(inv.advanceAdjusted || 0, d) - toMinor(inv.received, d); };
    const label = inv => (inv.number ? `Invoice ${inv.number}` : 'Draft invoice');

    async function list(ctx, q = {}) {
        const where = { tenantId: ctx.tenantId };
        const st = String(q.status || '').toUpperCase();
        if (st === 'UNPAID') where.status = { in: ['ISSUED', 'SENT', 'PARTIAL'] };
        else if (st) { if (!STATUSES.includes(st)) throw bad('Unknown status.'); where.status = st; }
        if (q.clientId) where.clientId = String(q.clientId);
        if (q.currency) where.currency = String(q.currency).toUpperCase();
        // the invoice date in the dates chosen (a draft has none yet: it shows whatever the dates)
        const issued = {};
        if (q.from) issued.gte = dateOf(V.day(q.from, 'From'));
        if (q.to) issued.lte = dateOf(V.day(q.to, 'To'));
        const AND = [];
        // the CA's menu: "Invoices Created" (made, not yet given to the client) and "Invoices Issued" (sent to the client, or paid)
        const ISSUED = { OR: [{ sentAt: { not: null } }, { status: { in: ['PARTIAL', 'RECEIVED'] } }] };
        if (q.stage === 'issued') AND.push(ISSUED);
        else if (q.stage === 'created') AND.push({ NOT: ISSUED });
        if (q.from || q.to) AND.push({ OR: [{ issueDate: issued }, { status: 'DRAFT' }] });
        const s = String(q.q || '').trim().slice(0, 100);
        if (s) AND.push({ OR: [{ number: ciContains(s) }, { client: { name: ciContains(s) } }, { client: { code: ciContains(s) } }] });
        if (AND.length) where.AND = AND;
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
        // the country's default invoice type, if it has one (the CA)
        const type = await db.cmpInvoiceType.findFirst({ where: { tenantId: ctx.tenantId, country: client.country, kind: 'INVOICE', active: true }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
        // the obligation's last price from the bank (the CA: the price billed before comes back)
        let price = 0;
        if (occ) { const it = await db.cmpItem.findUnique({ where: { tenantId_key_currency: { tenantId: ctx.tenantId, key: itemKey(occ.obligation.name), currency } } }); if (it) price = Number(it.amount); }
        const inv = await db.cmpInvoice.create({ data: {
            tenantId: ctx.tenantId, clientId: client.id, occurrenceId: occ ? occ.id : null, currency, createdBy: ctx.email, typeId: type ? type.id : null,
            lines: { create: [occ ? { description: `${occ.obligation.name} — ${R.periodName(occ)}`, amount: price, sortOrder: 0, occurrenceId: occ.id, bankName: occ.obligation.name } : { description: 'Professional fee', amount: 0, sortOrder: 0 }] },
            taxes: { create: taxes.map((t, i) => ({ name: t.name, rate: t.rate, amount: 0, sortOrder: i })) },
        } });
        if (price > 0) { // (the totals of the price that came from the bank)
            const body = cleanBody({ lines: [{ description: 'x', amount: price }], taxes: taxes.map(t => ({ name: t.name, rate: Number(t.rate) })) }, currency);
            await db.cmpInvoice.update({ where: { id: inv.id }, data: { subtotal: fromMinor(body.subMinor, body.d), taxTotal: fromMinor(body.taxMinor, body.d), total: fromMinor(body.totalMinor, body.d) } });
            for (const [i, t] of body.taxes.entries()) await db.cmpInvoiceTax.updateMany({ where: { invoiceId: inv.id, sortOrder: i }, data: { amount: fromMinor(t.minor, body.d) } });
        }
        await log(ctx, 'cmp.invoice.create', 'CmpInvoice', inv.id, `Draft invoice for ${common.clientLabel(client)}${occ ? ` (${occ.obligation.name} ${R.periodName(occ)})` : ''}`, { clientId: client.id });
        if (db === prisma) common.notify(ctx, 'INVOICE_CREATED', { invoiceId: inv.id }); // (inside a transaction: the caller's, once it is done)
        return inv;
    }
    // A new invoice: what was sent is checked first, so a refused one leaves no empty draft behind
    async function create(ctx, b) {
        if (b.lines || b.taxes || b.currency) {
            const currency = String(b.currency || 'USD').toUpperCase();
            if (b.currency && !C.currencyOk(currency)) throw bad('Choose a currency from the list.');
            if (b.lines || b.taxes) cleanBody({ lines: b.lines || [{ description: 'Fee', amount: 0 }], taxes: b.taxes || [], discount: b.discount, charges: b.charges }, b.currency ? currency : 'USD');
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
        const body = cleanBody({ lines: b.lines ?? inv.lines.map(l => ({ description: l.description, amount: Number(l.amount) })), taxes: b.taxes ?? inv.taxes.map(t => ({ name: t.name, rate: Number(t.rate) })),
            discount: b.discount !== undefined ? b.discount : Number(inv.discount || 0), charges: b.charges !== undefined ? b.charges : Number(inv.charges || 0) }, currency);
        const issueDate = b.issueDate !== undefined ? (b.issueDate ? V.day(b.issueDate, 'Invoice date') : null) : ymd(inv.issueDate) || null;
        const dueDate = b.dueDate !== undefined ? (b.dueDate ? V.day(b.dueDate, 'Payment due') : null) : ymd(inv.dueDate) || null;
        if (issueDate && dueDate && dueDate < issueDate) throw bad('The payment due date cannot be before the invoice date.');
        const notes = b.notes !== undefined ? V.multiline(b.notes, 1000, 'Notes') : inv.notes;
        // the completed obligations billed on its lines (the CA: several at once): this client's, completed, and on no other invoice
        if (b.lines) {
            const occIds = body.lines.map(l => l.occurrenceId).filter(Boolean);
            if (new Set(occIds).size !== occIds.length) throw bad('An obligation period is on the invoice twice.');
            if (occIds.length) {
                const occs = await prisma.cmpOccurrence.findMany({ where: { id: { in: occIds }, tenantId: ctx.tenantId, clientId: inv.clientId }, include: { obligation: { select: { name: true } } } });
                if (occs.length !== occIds.length) throw bad('One of the obligations is not this client\'s. Reload the page.');
                const other = await prisma.cmpInvoiceLine.findFirst({ where: { occurrenceId: { in: occIds }, invoiceId: { not: inv.id }, invoice: { status: { not: 'CANCELLED' } } }, include: { invoice: { select: { number: true } } } });
                const legacy = await prisma.cmpInvoice.findFirst({ where: { occurrenceId: { in: occIds }, id: { not: inv.id }, status: { not: 'CANCELLED' } }, select: { number: true } });
                if (other || legacy) throw new CmpError(409, `One of these obligation periods is already on ${(other ? other.invoice.number : legacy.number) || 'another draft invoice'}.`);
                for (const l of body.lines) { const o = l.occurrenceId && occs.find(x => x.id === l.occurrenceId); if (o && !l.bankName) l.bankName = o.obligation.name; }
            }
        } else body.lines = body.lines.map((l, i) => ({ ...l, occurrenceId: inv.lines[i] ? inv.lines[i].occurrenceId : null, bankName: inv.lines[i] ? inv.lines[i].bankName : '' }));
        // the invoice type (country sensitive) and the advance payments taken off it (the CA: Gross − Advance = Net)
        const typeId = b.typeId !== undefined ? ((await findType(ctx, b.typeId || null, inv.client.country)) || {}).id || null : inv.typeId;
        const adv = await cleanAdvanceUse(ctx.tenantId, inv, b.advances !== undefined ? b.advances : inv.advanceUse, currency, body.totalMinor);
        const day = await today(ctx.tenantId);
        // in turn with issuing (the same lock): an edit can never land on an invoice that was issued a moment ago
        await inTurn(ctx.tenantId, 'cmp-invoice-no', async tx => {
            if ((await tx.cmpInvoice.findUnique({ where: { id: inv.id }, select: { status: true } })).status !== 'DRAFT') throw new CmpError(409, 'This invoice was issued a moment ago: it can no longer be changed.');
            await tx.cmpInvoiceLine.deleteMany({ where: { invoiceId: inv.id } });
            await tx.cmpInvoiceTax.deleteMany({ where: { invoiceId: inv.id } });
            const firstOcc = body.lines.find(l => l.occurrenceId);
            await tx.cmpInvoice.update({ where: { id: inv.id }, data: {
                currency, issueDate: dateOf(issueDate), dueDate: dateOf(dueDate), notes, typeId,
                subtotal: fromMinor(body.subMinor, body.d), discount: fromMinor(body.discountMinor, body.d), charges: fromMinor(body.chargesMinor, body.d), taxTotal: fromMinor(body.taxMinor, body.d), total: fromMinor(body.totalMinor, body.d),
                advanceAdjusted: fromMinor(adv.minor, body.d), advanceUse: adv.use,
                ...(b.lines ? { occurrenceId: firstOcc ? firstOcc.occurrenceId : null } : {}),
                lines: { create: body.lines.map(l => ({ description: l.description, amount: l.amount, sortOrder: l.sortOrder, occurrenceId: l.occurrenceId || null, bankName: l.bankName || '' })) },
                taxes: { create: body.taxes.map(t => ({ name: t.name, rate: t.rate, amount: fromMinor(t.minor, body.d), sortOrder: t.sortOrder })) },
            } });
            for (const t of body.taxes.filter(x => x.save)) await rememberTax(tx, ctx, t.name, t.rate, inv.client.country);
            // kept in the price bank under the item's name, or the obligation's name for an obligation's line
            for (const l of body.lines.filter(x => x.save && x.amount > 0)) await rememberItem(tx, ctx, l.bankName || l.description, l.amount, currency, inv.client.country, issueDate || day);
        });
        // what changed on the draft, field by field (the CA's Invoice History report)
        const fresh = await prisma.cmpInvoice.findUnique({ where: { id: inv.id }, include: { lines: { orderBy: { sortOrder: 'asc' } }, taxes: { orderBy: { sortOrder: 'asc' } } } });
        const flat = x => ({ currency: x.currency, issueDate: x.issueDate, dueDate: x.dueDate, notes: x.notes, typeId: x.typeId || '', discount: Number(x.discount || 0), charges: Number(x.charges || 0), total: Number(x.total), advanceAdjusted: Number(x.advanceAdjusted || 0),
            lines: x.lines.map(l => `${l.description} ${Number(l.amount)}`).join('; '), taxes: x.taxes.map(t => `${t.name} ${Number(t.rate)}%`).join('; ') });
        const changes = common.changes(flat(inv), flat(fresh), { currency: 'Currency', issueDate: 'Invoice date', dueDate: 'Payment due', lines: 'Lines', taxes: 'Taxes', discount: 'Discount', charges: 'Additional charges', total: 'Total', advanceAdjusted: 'Advance adjusted', typeId: 'Format', notes: 'Notes' });
        if (changes.length) await log(ctx, 'cmp.invoice.update', 'CmpInvoice', inv.id, `Draft invoice for ${common.clientLabel(inv.client)} changed: ${changes.map(c => c.field.toLowerCase()).join(', ')}`, { clientId: inv.clientId, changes });
        const saved = body.taxes.filter(x => x.save), items = body.lines.filter(x => x.save && x.amount > 0);
        if (saved.length) await log(ctx, 'cmp.tax.remember', 'CmpInvoice', inv.id, `Kept for ${inv.client.country} clients: ${saved.map(t => `${t.name} ${t.rate}%`).join(', ')}`, { clientId: inv.clientId });
        if (items.length) await log(ctx, 'cmp.item.remember', 'CmpInvoice', inv.id, `Kept for ${inv.client.country} clients: ${items.map(l => `${l.bankName || l.description} ${amountText(l.amount, currency)}`).join(', ')}`, { clientId: inv.clientId });
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
            // the advances taken off it are used now (in turn with every other use of an advance: never more than there is)
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${ctx.tenantId}:cmp-advance`}))`;
            const d = decimalsOf(fresh.currency);
            for (const u of Array.isArray(fresh.advanceUse) ? fresh.advanceUse : []) {
                const a = await tx.cmpAdvance.findUnique({ where: { id: u.advanceId } });
                if (!a || a.voidedAt || a.clientId !== fresh.clientId) throw new CmpError(409, 'One of the advance payments on this invoice was undone. Open the draft and save it again.');
                const left = toMinor(a.amount, d) - toMinor(a.used, d);
                if (toMinor(u.amount, d) > left) throw new CmpError(409, `Only ${amountText(fromMinor(left, d), a.currency)} is left of the advance of ${R.fmtDay(a.receivedOn)} (it was taken off another invoice). Open the draft and change the adjustment.`);
                await tx.cmpAdvance.update({ where: { id: a.id }, data: { used: fromMinor(toMinor(a.used, d) + toMinor(u.amount, d), d) } });
            }
            // the format it is printed with is frozen as it is now
            const type = fresh.typeId ? await tx.cmpInvoiceType.findUnique({ where: { id: fresh.typeId } }) : null;
            const s = await tx.cmpSettings.upsert({ where: { tenantId: ctx.tenantId }, create: { tenantId: ctx.tenantId, invoiceSeq: 1 }, update: { invoiceSeq: { increment: 1 } } });
            const number = formatNo(s.invoiceFormat, s.invoiceSeq, day);
            return tx.cmpInvoice.update({ where: { id: inv.id }, data: { status: statusOf({ ...fresh, status: 'ISSUED' }), seqNo: s.invoiceSeq, number, issueDate: dateOf(day), issuedAt: now(), issuedBy: ctx.email,
                typeSnapshot: type ? { id: type.id, name: type.name, country: type.country, layout: type.layout } : undefined } });
        });
        const adv = Number(inv.advanceAdjusted || 0);
        await log(ctx, 'cmp.invoice.issue', 'CmpInvoice', inv.id, `Invoice ${done.number} issued to ${common.clientLabel(inv.client)}: ${amountText(inv.total, inv.currency)}${adv ? ` less advance ${amountText(adv, inv.currency)} = ${amountText(Number(inv.total) - adv, inv.currency)}` : ''}`, { clientId: inv.clientId });
        common.notify(ctx, 'INVOICE_ISSUED', { invoiceId: inv.id });
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
    // Cancelled at any stage (the CA). Money already received against it is settled as the person chooses, having been told how much
    // and which receipts: VOID (the receipts were a mistake: voided), REFUND (paid back to the client: when, how, reference) or CREDIT
    // (kept as the client's credit, to pay its next invoices in this currency). voidReceipts: true is the same as settle VOID.
    async function cancel(ctx, id, reason, { voidReceipts = false, settle, refund } = {}) {
        const inv = await find(ctx, id);
        if (inv.status === 'DRAFT') throw new CmpError(409, 'A draft is deleted, not cancelled.');
        if (inv.status === 'CANCELLED') throw new CmpError(409, 'This invoice is already cancelled.');
        const why = V.line(reason, 300, 'Reason', { required: true });
        const mode = settle ? String(settle).toUpperCase() : voidReceipts ? 'VOID' : '';
        if (mode && !SETTLE[mode]) throw bad('Choose what becomes of the money received: refund, credit or void.');
        let refundText = '';
        if (mode === 'REFUND') {
            const r = refund || {}, on = r.date ? V.day(r.date, 'Refund date') : await today(ctx.tenantId), how = String(r.method || 'BANK').toUpperCase();
            if (!METHODS[how] || how === 'CREDIT') throw bad('Choose how the money was paid back.');
            const ref = V.line(r.reference, 120, 'Refund reference');
            refundText = `Refunded on ${R.fmtDay(on)} by ${METHODS[how].toLowerCase()}${ref ? ` (ref. ${ref})` : ''}`;
        }
        const paid = live => `${amountText(live.reduce((m, r) => m + Number(r.amount), 0), inv.currency)} was received against this invoice (${live.map(r => r.number).join(', ')}). Choose what becomes of it: refund it, keep it as the client's credit, or void the receipts.`;
        const liveOf = list => list.filter(r => !r.voidedAt && !r.settlement);
        if (liveOf(inv.receipts).length && !mode) throw new CmpError(409, paid(liveOf(inv.receipts)));
        // in turn with receipts (the same lock): no payment can arrive between the check and the cancelling
        const done = await inTurn(ctx.tenantId, 'cmp-receipt-no', async tx => {
            const live = liveOf(await tx.cmpReceipt.findMany({ where: { invoiceId: inv.id } }));
            if (live.length && !mode) throw new CmpError(409, paid(live));
            const d = decimalsOf(inv.currency), sum = fromMinor(live.reduce((m, r) => m + toMinor(r.amount, d), 0), d);
            let credit = null;
            if (live.length && mode === 'VOID') {
                await tx.cmpReceipt.updateMany({ where: { id: { in: live.map(r => r.id) } }, data: { voidedAt: now(), voidedBy: ctx.email, voidReason: `Invoice cancelled: ${why}`.slice(0, 300) } });
                for (const r of live) await giveBackCredit(tx, r, d);
            } else if (live.length) {
                if (mode === 'CREDIT') credit = await tx.cmpCredit.create({ data: { tenantId: ctx.tenantId, clientId: inv.clientId, currency: inv.currency, amount: sum, fromInvoiceId: inv.id, note: `Invoice ${inv.number} cancelled: ${why}`.slice(0, 300), createdBy: ctx.email } });
                await tx.cmpReceipt.updateMany({ where: { id: { in: live.map(r => r.id) } }, data: { settlement: mode === 'REFUND' ? 'REFUNDED' : 'CREDITED', settledAt: now(), settledBy: ctx.email,
                    settlementNote: (mode === 'REFUND' ? refundText : `Kept as ${inv.client.name}'s credit (${amountText(sum, inv.currency)})`).slice(0, 300) } });
            }
            await tx.cmpInvoice.update({ where: { id: inv.id }, data: { status: 'CANCELLED', received: 0, cancelledAt: now(), cancelledBy: ctx.email, cancelReason: why, cancelSettlement: live.length ? mode : '' } });
            // the advances taken off it can be taken off another invoice again
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${ctx.tenantId}:cmp-advance`}))`;
            for (const u of Array.isArray(inv.advanceUse) ? inv.advanceUse : []) {
                const a = await tx.cmpAdvance.findUnique({ where: { id: u.advanceId } });
                if (a) await tx.cmpAdvance.update({ where: { id: a.id }, data: { used: fromMinor(Math.max(0, toMinor(a.used, d) - toMinor(u.amount, d)), d) } });
            }
            return { live, sum, credit };
        });
        const money = done.live.length ? ` (${amountText(done.sum, inv.currency)} received, receipt${done.live.length === 1 ? '' : 's'} ${done.live.map(r => r.number).join(', ')}: ${mode === 'REFUND' ? refundText.charAt(0).toLowerCase() + refundText.slice(1) : SETTLE[mode]})` : '';
        await log(ctx, 'cmp.invoice.cancel', 'CmpInvoice', inv.id, `Invoice ${inv.number} to ${common.clientLabel(inv.client)} cancelled: ${why}${money}`, { clientId: inv.clientId, receipts: done.live.map(r => r.number), settlement: mode || null });
        return get(ctx, inv.id);
    }
    // A receipt paid from the client's credit gives that credit back when it is voided
    async function giveBackCredit(tx, r, d) {
        for (const u of Array.isArray(r.creditUsed) ? r.creditUsed : []) {
            const c = await tx.cmpCredit.findUnique({ where: { id: u.creditId } });
            if (c) await tx.cmpCredit.update({ where: { id: c.id }, data: { used: fromMinor(Math.max(0, toMinor(c.used, d) - toMinor(u.amount, d)), d) } });
        }
    }
    // "Sent" undone (the CA: an undo for every mark)
    async function unmarkSent(ctx, id) {
        const inv = await find(ctx, id);
        if (!inv.sentAt) return get(ctx, inv.id);
        if (inv.status === 'CANCELLED') throw new CmpError(409, 'This invoice is cancelled.');
        await prisma.cmpInvoice.update({ where: { id: inv.id }, data: { sentAt: null, status: statusOf({ ...inv, sentAt: null }) } });
        await log(ctx, 'cmp.invoice.unsent', 'CmpInvoice', inv.id, `Invoice ${inv.number} to ${common.clientLabel(inv.client)}: marked as not sent`, { clientId: inv.clientId });
        return get(ctx, inv.id);
    }

    /* ---------- receipts ---------- */
    async function recompute(tx, invoiceId) {
        const inv = await tx.cmpInvoice.findUnique({ where: { id: invoiceId }, include: { receipts: true } });
        const d = decimalsOf(inv.currency);
        const received = fromMinor(inv.receipts.filter(r => !r.voidedAt && !r.settlement).reduce((m, r) => m + toMinor(r.amount, d), 0), d);
        await tx.cmpInvoice.update({ where: { id: inv.id }, data: { received, status: statusOf({ ...inv, received }) } });
    }
    async function addReceipt(ctx, invoiceId, b) {
        const inv = await find(ctx, invoiceId);
        if (!['ISSUED', 'SENT', 'PARTIAL'].includes(inv.status)) throw new CmpError(409, inv.status === 'RECEIVED' ? 'This invoice is already paid in full.' : inv.status === 'DRAFT' ? 'Issue the invoice first.' : 'This invoice is cancelled.');
        const amount = money(b.amount, inv.currency, 'Amount received', { positive: true });
        const d = decimalsOf(inv.currency), outstanding = owedMinor(inv);
        if (toMinor(amount, d) > outstanding) throw bad(`That is more than is still owed (${amountText(fromMinor(outstanding, d), inv.currency)}).`);
        const receivedOn = b.receivedOn ? V.day(b.receivedOn, 'Date received') : await today(ctx.tenantId);
        const method = String(b.method || 'BANK').toUpperCase();
        if (!METHODS[method]) throw bad('Choose how it was paid.');
        const reference = V.line(b.reference, 120, 'Reference'), notes = V.multiline(b.notes, 500, 'Notes');
        const rtype = b.typeId ? await findType(ctx, b.typeId, inv.client.country, 'RECEIPT')
            : await prisma.cmpInvoiceType.findFirst({ where: { tenantId: ctx.tenantId, country: inv.client.country, kind: 'RECEIPT', active: true }, orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
        const rsnap = rtype ? { id: rtype.id, name: rtype.name, country: rtype.country, layout: rtype.layout } : undefined;
        const r = await inTurn(ctx.tenantId, 'cmp-receipt-no', async tx => {
            // checked again inside the lock: two payments entered at once cannot both fit in what is owed, nor land on a cancelled invoice
            const now2 = await tx.cmpInvoice.findUnique({ where: { id: inv.id }, include: { receipts: true } });
            if (!['ISSUED', 'SENT', 'PARTIAL'].includes(now2.status)) throw new CmpError(409, now2.status === 'RECEIVED' ? 'This invoice is already paid in full.' : 'This invoice is cancelled.');
            const owed = toMinor(now2.total, d) - toMinor(now2.advanceAdjusted, d) - now2.receipts.filter(x => !x.voidedAt && !x.settlement).reduce((m, x) => m + toMinor(x.amount, d), 0);
            if (toMinor(amount, d) > owed) throw bad(`That is more than is still owed (${amountText(fromMinor(owed, d), inv.currency)}).`);
            // paid from the client's credit (the CA): the oldest credit in this currency first; never more than there is
            const creditUsed = [];
            if (method === 'CREDIT') {
                let need = toMinor(amount, d);
                const credits = await tx.cmpCredit.findMany({ where: { tenantId: ctx.tenantId, clientId: inv.clientId, currency: inv.currency }, orderBy: { createdAt: 'asc' } });
                const have = credits.reduce((m, c) => m + Math.max(0, toMinor(c.amount, d) - toMinor(c.used, d)), 0);
                if (have < need) throw bad(have ? `The client's credit is only ${amountText(fromMinor(have, d), inv.currency)}.` : `The client has no credit in ${inv.currency}.`);
                for (const c of credits) {
                    const left = toMinor(c.amount, d) - toMinor(c.used, d);
                    if (left <= 0 || !need) continue;
                    const take = Math.min(left, need);
                    await tx.cmpCredit.update({ where: { id: c.id }, data: { used: fromMinor(toMinor(c.used, d) + take, d) } });
                    creditUsed.push({ creditId: c.id, amount: fromMinor(take, d) });
                    need -= take;
                }
            }
            const s = await tx.cmpSettings.upsert({ where: { tenantId: ctx.tenantId }, create: { tenantId: ctx.tenantId, receiptSeq: 1 }, update: { receiptSeq: { increment: 1 } } });
            const row = await tx.cmpReceipt.create({ data: { tenantId: ctx.tenantId, invoiceId: inv.id, clientId: inv.clientId, seqNo: s.receiptSeq, number: formatNo(s.receiptFormat, s.receiptSeq, receivedOn), amount, receivedOn: dateOf(receivedOn), method, reference, notes, creditUsed, createdBy: ctx.email,
                typeId: rtype ? rtype.id : null, typeSnapshot: rsnap } });
            await recompute(tx, inv.id);
            return row;
        });
        await log(ctx, 'cmp.receipt.create', 'CmpReceipt', r.id, `Receipt ${r.number}: ${amountText(amount, inv.currency)} received for invoice ${inv.number} from ${common.clientLabel(inv.client)} (${METHODS[method].toLowerCase()})`, { clientId: inv.clientId, invoiceId: inv.id });
        common.notify(ctx, 'RECEIPT', { receiptId: r.id, invoiceId: inv.id });
        return { invoice: await get(ctx, inv.id), receiptId: r.id };
    }
    async function voidReceipt(ctx, id, reason) {
        const r = await prisma.cmpReceipt.findFirst({ where: { id: String(id || ''), tenantId: ctx.tenantId }, include: { invoice: { include: { client: true } } } });
        if (!r) throw new CmpError(404, 'Receipt not found.');
        if (r.voidedAt) throw new CmpError(409, 'This receipt is already void.');
        if (r.settlement) throw new CmpError(409, `This money was ${r.settlement === 'REFUNDED' ? 'refunded' : 'kept as the client\'s credit'} when invoice ${r.invoice.number} was cancelled: the receipt stays.`);
        const why = V.line(reason, 300, 'Reason', { required: true });
        await inTurn(ctx.tenantId, 'cmp-receipt-no', async tx => {
            const fresh = await tx.cmpReceipt.findUnique({ where: { id: r.id } });
            if (fresh.voidedAt) throw new CmpError(409, 'This receipt is already void.');
            await tx.cmpReceipt.update({ where: { id: r.id }, data: { voidedAt: now(), voidedBy: ctx.email, voidReason: why } });
            await giveBackCredit(tx, fresh, decimalsOf(r.invoice.currency));
            await recompute(tx, r.invoiceId);
        });
        await log(ctx, 'cmp.receipt.void', 'CmpReceipt', r.id, `Receipt ${r.number} (${amountText(r.amount, r.invoice.currency)}) for invoice ${r.invoice.number} voided: ${why}`, { clientId: r.clientId, invoiceId: r.invoiceId });
        return get(ctx, r.invoiceId);
    }
    async function listReceipts(ctx, q = {}) {
        const where = { tenantId: ctx.tenantId };
        if (q.clientId) where.clientId = String(q.clientId);
        if (q.status === 'VALID') where.voidedAt = null; else if (q.status === 'VOID') where.voidedAt = { not: null };
        const s = String(q.q || '').trim().slice(0, 100);
        if (s) where.OR = [{ number: ciContains(s) }, { reference: ciContains(s) }, { invoice: { number: ciContains(s) } }, { invoice: { client: { name: ciContains(s) } } }, { invoice: { client: { code: ciContains(s) } } }];
        if (q.from) where.receivedOn = { ...(where.receivedOn || {}), gte: dateOf(V.day(q.from, 'From')) };
        if (q.to) where.receivedOn = { ...(where.receivedOn || {}), lte: dateOf(V.day(q.to, 'To')) };
        const rows = await prisma.cmpReceipt.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(Number(q.limit) || 500, 20000), include: { invoice: { include: { client: true } } } });
        return rows.map(r => ({ id: r.id, number: r.number, amount: Number(r.amount), currency: r.invoice.currency, receivedOn: ymd(r.receivedOn), method: r.method, reference: r.reference, voidedAt: r.voidedAt, voidReason: r.voidReason,
            settlement: r.settlement, settlementNote: r.settlementNote,
            invoice: { id: r.invoiceId, number: r.invoice.number, status: r.invoice.status }, client: { id: r.invoice.client.id, code: r.invoice.client.code, name: r.invoice.client.name, country: r.invoice.client.country }, createdBy: r.createdBy }));
    }
    // What a message about an invoice, a receipt or an advance payment can say ([Invoice Number], [Receipt Number], [Advance Number] …), and
    // the client and obligation period it is about
    async function messageContext(ctx, { invoiceId, receiptId, advanceId }) {
        if (advanceId) {
            const a = await getAdvance(ctx, advanceId);
            if (a.voidedAt) throw new CmpError(409, 'This advance payment is undone.');
            return { advance: a, clientId: a.clientId, occurrenceId: a.occurrenceId || null, ctx: { advance: { number: a.number, date: a.receivedOn, amountText: amountText(a.amount, a.currency), description: a.description, balanceText: amountText(a.available, a.currency) } } };
        }
        let inv = null, receipt = null;
        if (receiptId) {
            receipt = await prisma.cmpReceipt.findFirst({ where: { id: String(receiptId), tenantId: ctx.tenantId } });
            if (!receipt) throw new CmpError(404, 'Receipt not found.');
            invoiceId = receipt.invoiceId;
        }
        if (invoiceId) inv = await find(ctx, invoiceId);
        if (inv && inv.status === 'DRAFT') throw new CmpError(409, 'Issue the invoice before sending it.');
        return { inv, receipt, clientId: inv ? inv.clientId : null, occurrenceId: inv ? inv.occurrenceId || (inv.lines.find(l => l.occurrenceId) || {}).occurrenceId || null : null, ctx: inv ? {
            invoice: { number: inv.number, amountText: amountText(Number(inv.total) - Number(inv.advanceAdjusted || 0), inv.currency), date: ymd(inv.issueDate), dueDate: ymd(inv.dueDate), outstandingText: amountText(fromMinor(owedMinor(inv), decimalsOf(inv.currency)), inv.currency) },
            receipt: receipt ? { number: receipt.number, date: ymd(receipt.receivedOn), amountText: amountText(receipt.amount, inv.currency) } : null } : {} };
    }

    return { METHODS, STATUSES, amountText, creditOf, listTaxRates, createTaxRate, updateTaxRate, listItems, createItem, updateItem, list, get, draftFor, create, update, remove, issue, markSent, unmarkSent, cancel, addReceipt, voidReceipt, listReceipts, messageContext, statusOf,
        listAdvances, getAdvance, advanceDescriptions, addAdvance, updateAdvance, voidAdvance, listTypes, saveType, deleteType, billable };
}

module.exports = { createInvoices, formatNo, amountText, METHODS };
