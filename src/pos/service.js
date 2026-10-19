// Point of Sale: what happens to a sale, from the cashier's "finalize" to PRA's fiscal number (SRS v1.7).
// Everything here is scoped by tenantId. Nothing is ever deleted: a sale is a tax record.
//
// The rules that matter most:
//  - a sale is a fiscal invoice only when PRA answers Code "100" with an invoice number (FISCALIZED)
//  - the USIN is handed out once, when the sale is finalized, and never reused (unique per business)
//  - if PRA's answer is lost (timeout, broken connection, server error) the sale goes to OUTCOME_UNKNOWN and is NEVER sent again
//    by itself: a person checks PRA's report and records what they found
//  - a send is claimed atomically, so a double click or two screens cannot send the same sale twice
const C = require('./calc');
const V = require('./validate');
const Scan = require('./scan');
const { buildPayload, reconcile, praDateTime } = require('./payload');
const { assertMove } = require('./states');

const { PosError } = require('./errors');
const R = require('./reports');
const { csvText, csvNum } = require('./csv');

const num = d => (d === null || d === undefined ? null : Number(d));
const MIN_RETRY_GAP_MS = 3000; // SRS FR-6.6: operator retries are rate limited
const PENDING = ['AWAITING_FISCALIZATION', 'OUTCOME_UNKNOWN'];
const PKT_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' });
const pktDay = date => PKT_DAY.format(date); // YYYY-MM-DD
const pad = (n, w) => String(n).padStart(w, '0');

// "In flight" = a send has started and PRA has not answered yet. Whoever ends a send sets respondedAt: the answer itself, or the
// sweep of a send that was cut off. A sale in flight is left alone by everything except that sweep.
const inFlight = s => s.state === 'AWAITING_FISCALIZATION' && Boolean(s.submittedAt) && !s.respondedAt;
const NOT_IN_FLIGHT = { OR: [{ submittedAt: null }, { respondedAt: { not: null } }] }; // the same test, as a database condition
// NOT_SENT answers that mean the connection to PRA is not working (as opposed to "no token yet"): with every UNKNOWN they count as a failed connection
const DOWN = new Set(['NO_CONNECTION', 'SERVICE_UNAVAILABLE', 'BLOCKED', 'BAD_PROXY']);
const CHANGED = 'This sale was just changed by someone else. Look at it again.';
const BUSY = 'This sale is being sent right now. Wait a moment and look again.';
const pausedText = ms => `PRA could not be reached a moment ago, so sending is being given a rest. Try again in ${Math.max(1, Math.ceil(ms / 1000))} seconds.`;
const lineFields = l => ({ itemId: l.itemId, itemCode: l.itemCode, itemName: l.itemName, category: l.category || '', pctCode: l.pctCode, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount, taxRate: l.taxRate, saleValue: l.saleValue, taxCharged: l.taxCharged, totalAmount: l.totalAmount, refLineId: l.refLineId });
// a whole number from the query string, kept inside limits (anything else gives the default)
const whole = (v, dflt, min, max) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt; };

function createPosService({ prisma, audit, encrypt, decrypt, mask, pra, breaker, now = () => new Date(), limits = { assertRoom: async () => {} } }) {
    const userOf = ctx => ctx.req && ctx.req.user;
    const room = (ctx, kind) => limits.assertRoom(ctx.tenantId, kind, { user: userOf(ctx) }); // the plan's number of branches, counters and items
    const emailOf = ctx => (ctx.req && ctx.req.user && ctx.req.user.email) || ctx.email || 'user';
    const note = (text, max = 300) => String(text === undefined || text === null ? '' : text).trim().slice(0, max);
    const taken = (e, what) => {
        if (e && e.code === 'P2002') throw new PosError(409, /barcode/.test(String(e.meta && e.meta.target)) ? 'That barcode is already used by another item.' : `That ${what} is already in use.`);
        throw e;
    };

    // ---------- business profile (what the receipt says about the business) ----------
    async function getProfile(tenantId) {
        const [p, t] = await Promise.all([
            prisma.posProfile.findUnique({ where: { tenantId } }),
            prisma.tenant.findUnique({ where: { id: tenantId }, select: { companyName: true } }),
        ]);
        const view = {
            businessName: (p && p.businessName) || (t && t.companyName) || '', pntn: (p && p.pntn) || '', address: (p && p.address) || '',
            phone: (p && p.phone) || '', receiptFooter: (p && p.receiptFooter) || '',
        };
        return { ...view, complete: Boolean(view.businessName && view.pntn && view.address) };
    }
    async function saveProfile(ctx, data) {
        const d = V.cleanProfile(data);
        await prisma.posProfile.upsert({ where: { tenantId: ctx.tenantId }, create: { tenantId: ctx.tenantId, ...d }, update: d });
        await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.profile.update', entityType: 'PosProfile', entityId: ctx.tenantId, summary: 'Point of Sale business details changed' });
        return getProfile(ctx.tenantId);
    }

    // ---------- settings: how a new sale starts, how the receipt looks, what a new item starts with ----------
    const SETTINGS_FIELDS = ['defaultPaymentMode', 'receiptHeader', 'receiptWidth', 'showCashier', 'itemPct', 'itemTaxRate', 'itemTaxRateCard', 'itemCategory'];
    const settingsView = p => ({
        defaultPaymentMode: (p && p.defaultPaymentMode) || 1, receiptHeader: (p && p.receiptHeader) || '', receiptWidth: (p && p.receiptWidth) || 80,
        showCashier: p ? p.showCashier : true, itemPct: (p && p.itemPct) || '', itemTaxRate: p ? num(p.itemTaxRate) : null, itemTaxRateCard: p ? num(p.itemTaxRateCard) : null,
        itemCategory: (p && p.itemCategory) || '',
    });
    async function getSettings(tenantId) {
        return settingsView(await prisma.posProfile.findUnique({ where: { tenantId } }));
    }
    async function saveSettings(ctx, data) {
        const was = await getSettings(ctx.tenantId);
        const d = V.cleanSettings(data, was);
        await prisma.posProfile.upsert({ where: { tenantId: ctx.tenantId }, create: { tenantId: ctx.tenantId, ...d }, update: d });
        const changed = SETTINGS_FIELDS.filter(k => was[k] !== d[k]).map(k => `${k}: ${was[k] === '' || was[k] === null ? 'none' : was[k]} → ${d[k] === '' || d[k] === null ? 'none' : d[k]}`);
        if (changed.length) await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.settings.update', entityType: 'PosProfile', entityId: ctx.tenantId, summary: `Point of Sale settings changed: ${changed.join(', ')}`.slice(0, 480) });
        return getSettings(ctx.tenantId);
    }

    // ---------- branches and counters ----------
    function counterView(c, pending) {
        let masked = '';
        if (c.tokenEnc) { try { masked = mask(decrypt(c.tokenEnc)); } catch { masked = '(unreadable)'; } }
        return {
            id: c.id, branchId: c.branchId, name: c.name, posId: c.posId, env: c.env, active: c.active, hasToken: Boolean(c.tokenEnc),
            tokenMasked: masked, tokenSetAt: c.tokenSetAt, pending: pending.get(c.id) || 0, breaker: breaker.state(c.id),
        };
    }
    async function pendingByCounter(tenantId) {
        const rows = await prisma.posSale.groupBy({ by: ['counterId'], where: { tenantId, state: { in: PENDING } }, _count: { _all: true } });
        return new Map(rows.map(r => [r.counterId, r._count._all]));
    }
    async function listBranches(tenantId) {
        const [branches, pending] = await Promise.all([
            prisma.posBranch.findMany({ where: { tenantId }, orderBy: { name: 'asc' }, include: { counters: { orderBy: { name: 'asc' } } } }),
            pendingByCounter(tenantId),
        ]);
        return branches.map(b => ({ id: b.id, name: b.name, address: b.address, city: b.city, phone: b.phone, active: b.active, counters: b.counters.map(c => counterView(c, pending)) }));
    }
    async function createBranch(ctx, body) {
        const d = V.cleanBranch(body);
        await room(ctx, 'branches');
        try {
            const b = await prisma.posBranch.create({ data: { tenantId: ctx.tenantId, ...d } });
            await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.branch.create', entityType: 'PosBranch', entityId: b.id, summary: `Branch "${b.name}" added` });
            return b;
        } catch (e) { return taken(e, 'branch name'); }
    }
    async function updateBranch(ctx, id, body) {
        const b = await prisma.posBranch.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!b) throw new PosError(404, 'Branch not found.');
        const d = V.cleanBranch({ ...b, ...body });
        const active = body.active === undefined ? b.active : body.active === true || body.active === 'true';
        if (active && !b.active) await room(ctx, 'branches'); // opening a branch again takes its place back
        try {
            await prisma.posBranch.update({ where: { id }, data: { ...d, active } });
            await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.branch.update', entityType: 'PosBranch', entityId: id, summary: `Branch "${d.name}" changed${active === b.active ? '' : active ? ' (switched on)' : ' (switched off)'}` });
        } catch (e) { return taken(e, 'branch name'); }
    }
    async function findCounter(ctx, id) {
        const c = await prisma.posCounter.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!c) throw new PosError(404, 'Counter not found.');
        return c;
    }
    async function createCounter(ctx, body) {
        const branch = await prisma.posBranch.findFirst({ where: { id: String(body.branchId || ''), tenantId: ctx.tenantId } });
        if (!branch) throw new PosError(400, 'Choose the branch this counter belongs to.');
        const d = V.cleanCounter(body);
        const token = body.token ? V.cleanToken(body.token) : null;
        await room(ctx, 'terminals');
        try {
            const c = await prisma.posCounter.create({ data: { tenantId: ctx.tenantId, branchId: branch.id, ...d, tokenEnc: token ? encrypt(token) : null, tokenSetAt: token ? now() : null } });
            await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.counter.create', entityType: 'PosCounter', entityId: c.id, summary: `Counter "${c.name}" added (POS ID ${c.posId}, ${c.env.toLowerCase()})${token ? ', token saved' : ''}` });
            return c;
        } catch (e) { return taken(e, 'counter name or POS ID'); }
    }
    async function updateCounter(ctx, id, body) {
        const c = await findCounter(ctx, id);
        const d = V.cleanCounter({ name: c.name, posId: c.posId, env: c.env, ...body });
        const active = body.active === undefined ? c.active : body.active === true || body.active === 'true';
        if (active && !c.active) await room(ctx, 'terminals'); // switching a counter on again takes its place back
        const moved = d.posId !== c.posId || d.env !== c.env;
        if (moved && (await prisma.posSale.count({ where: { counterId: id, state: { in: PENDING } } }))) {
            throw new PosError(409, 'This counter has sales waiting for PRA. Finish or resolve them before changing its POS ID or environment.');
        }
        try {
            await prisma.posCounter.update({ where: { id }, data: { ...d, active } });
            const what = [d.name !== c.name && 'name', d.posId !== c.posId && `POS ID ${c.posId} → ${d.posId}`, d.env !== c.env && `environment ${c.env.toLowerCase()} → ${d.env.toLowerCase()}`, active !== c.active && (active ? 'switched on' : 'switched off')].filter(Boolean);
            if (what.length) await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.counter.update', entityType: 'PosCounter', entityId: id, summary: `Counter "${d.name}": ${what.join(', ')}` });
        } catch (e) { return taken(e, 'counter name or POS ID'); }
    }
    // A sale in flight keeps the token it started with; the new one is used from the next send (SRS FR-1.3)
    async function setToken(ctx, id, token) {
        const c = await findCounter(ctx, id);
        const t = V.cleanToken(token);
        await prisma.posCounter.update({ where: { id }, data: { tokenEnc: encrypt(t), tokenSetAt: now() } });
        breaker.record(id, true); // a new token is a fresh start
        await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.counter.token', entityType: 'PosCounter', entityId: id, summary: `PRA token ${c.tokenEnc ? 'replaced' : 'saved'} for counter "${c.name}"` }); // never the token itself
    }
    // Switch the counter off and remove its token (SRS FR-1.4). Its sales stay.
    async function decommission(ctx, id) {
        const c = await findCounter(ctx, id);
        const pending = await prisma.posSale.count({ where: { counterId: id, state: { in: PENDING } } });
        await prisma.posCounter.update({ where: { id }, data: { tokenEnc: null, tokenSetAt: null, active: false } });
        await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.counter.decommission', entityType: 'PosCounter', entityId: id, summary: `Counter "${c.name}" (POS ID ${c.posId}) decommissioned, token removed${pending ? `; ${pending} sale(s) still waiting for PRA` : ''}` });
        return { pending };
    }

    // ---------- items ----------
    const itemView = i => ({ id: i.id, code: i.code, barcode: i.barcode || null, name: i.name, category: i.category, pctCode: i.pctCode, taxRate: num(i.taxRate), taxRateCard: num(i.taxRateCard), unitPrice: num(i.unitPrice), openPrice: i.openPrice, active: i.active });
    async function listItems(tenantId, { q, activeOnly } = {}) {
        const where = { tenantId, ...(activeOnly ? { active: true } : {}) };
        const s = note(q, 60);
        if (s) where.OR = [{ name: { contains: s, mode: 'insensitive' } }, { code: { contains: s, mode: 'insensitive' } }, { barcode: { contains: s, mode: 'insensitive' } }, { category: { contains: s, mode: 'insensitive' } }];
        return (await prisma.posItem.findMany({ where, orderBy: [{ category: 'asc' }, { name: 'asc' }], take: 5000 })).map(itemView);
    }
    async function nextItemCode(tenantId) {
        const rows = await prisma.posItem.findMany({ where: { tenantId, code: { startsWith: 'ITM' } }, select: { code: true } });
        const top = rows.reduce((m, r) => Math.max(m, /^ITM(\d+)$/.test(r.code) ? Number(r.code.slice(3)) : 0), 0);
        return 'ITM' + pad(top + 1, 4);
    }
    // A scan must lead to one item: a code or barcode cannot be the code or barcode of another item (capitals do not matter)
    async function assertScanFree(tenantId, { code, barcode }, exceptId) {
        const names = [code, barcode].filter(Boolean);
        if (!names.length) return;
        const clash = await prisma.posItem.findFirst({
            where: { tenantId, ...(exceptId ? { id: { not: exceptId } } : {}), OR: names.flatMap(n => [{ code: { equals: n, mode: 'insensitive' } }, { barcode: { equals: n, mode: 'insensitive' } }]) },
            select: { name: true, code: true, barcode: true },
        });
        if (clash) {
            const used = names.find(n => [clash.code, clash.barcode].some(x => x && x.toLowerCase() === n.toLowerCase()));
            throw new PosError(409, `"${used}" is already the code or barcode of "${clash.name}" (${clash.code}). A scan has to lead to one item.`);
        }
    }
    async function createItem(ctx, body) {
        const d = V.cleanItem(body);
        if (d.active) await room(ctx, 'items');
        if (!d.code) d.code = await nextItemCode(ctx.tenantId);
        await assertScanFree(ctx.tenantId, d);
        try {
            const i = await prisma.posItem.create({ data: { tenantId: ctx.tenantId, ...d } });
            await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.item.create', entityType: 'PosItem', entityId: i.id, summary: `Item "${i.name}" (${i.code}) added: PCT ${i.pctCode}, tax ${num(i.taxRate)}%${i.taxRateCard !== null ? `, card ${num(i.taxRateCard)}%` : ''}` });
            return itemView(i);
        } catch (e) { return taken(e, 'item code'); }
    }
    async function updateItem(ctx, id, body) {
        const i = await prisma.posItem.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!i) throw new PosError(404, 'Item not found.');
        const d = V.cleanItem({ ...itemView(i), ...body, code: i.code }); // the code never changes: it is on past sales
        if (d.active && !i.active) await room(ctx, 'items'); // putting an item back on sale takes its place back
        await assertScanFree(ctx.tenantId, { code: i.code, barcode: d.barcode }, id);
        try {
            const u = await prisma.posItem.update({ where: { id }, data: { ...d, code: i.code } });
            const was = itemView(i), now_ = itemView(u);
            const changed = ['name', 'barcode', 'category', 'pctCode', 'taxRate', 'taxRateCard', 'unitPrice', 'openPrice', 'active'].filter(k => was[k] !== now_[k]).map(k => `${k}: ${was[k]} → ${now_[k]}`);
            if (changed.length) await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.item.update', entityType: 'PosItem', entityId: id, summary: `Item "${u.name}" (${u.code}) changed: ${changed.join(', ')}`.slice(0, 480) });
            return now_;
        } catch (e) { return taken(e, 'item code'); }
    }
    // Service headings (chapter 98) for the PCT code box; PRA's code is these 8 digits without the dot
    async function searchPct(q) {
        const s = note(q, 60);
        if (s.length < 2) return [];
        // codes are stored as 9801.2000 (a dot after the 4th digit), so typed digits get the dot back before they are matched
        const digits = '98' + s.replace(/\D/g, '').replace(/^98/, '');
        const where = /^[\d.\s]+$/.test(s)
            ? { code: { startsWith: digits.length > 4 ? `${digits.slice(0, 4)}.${digits.slice(4)}` : digits } }
            : { code: { startsWith: '98' }, AND: s.split(/\s+/).filter(w => w.length > 1).slice(0, 5).map(w => ({ description: { contains: w, mode: 'insensitive' } })) };
        const rows = await prisma.hsCode.findMany({ where, select: { code: true, description: true }, orderBy: { code: 'asc' }, take: 30 });
        return rows.map(r => ({ code: r.code, pctCode: r.code.replace(/\D/g, ''), description: r.description.replace(/^[\s-]+/, '') }));
    }

    // ---------- customers (saved buyers) ----------
    const customerView = c => ({ id: c.id, code: c.code, name: c.name, pntn: c.pntn, cnic: c.cnic, phone: c.phone, address: c.address, notes: c.notes, active: c.active, createdAt: c.createdAt });
    // What each customer has bought: fiscalized sales and credit notes of the kind the figures cover (test or real), and the last purchase
    async function customerStats(tenantId, ids) {
        if (!ids.length) return new Map();
        const rows = await prisma.posSale.groupBy({ by: ['customerId', 'invoiceType'], where: { tenantId, customerId: { in: ids }, state: 'FISCALIZED', env: figuresEnv() }, _count: { _all: true }, _sum: { totalBill: true }, _max: { createdAt: true } });
        const m = new Map(ids.map(id => [id, { sales: 0, salesTotal: 0, returns: 0, returnsTotal: 0, lastSaleAt: null }]));
        for (const r of rows) {
            const t = m.get(r.customerId); if (!t) continue;
            if (r.invoiceType === 3) { t.returns += r._count._all; t.returnsTotal += num(r._sum.totalBill) || 0; } else { t.sales += r._count._all; t.salesTotal += num(r._sum.totalBill) || 0; if (!t.lastSaleAt || r._max.createdAt > t.lastSaleAt) t.lastSaleAt = r._max.createdAt; }
        }
        for (const t of m.values()) { t.salesTotal = money2(t.salesTotal); t.returnsTotal = money2(t.returnsTotal); t.net = money2(t.salesTotal - t.returnsTotal); }
        return m;
    }
    // Words typed in the search box: a name or code, or digits of a phone, CNIC or PNTN
    const customerSearch = q => {
        const s = note(q, 60); if (!s) return null;
        const digits = s.replace(/\D/g, '');
        const or = [{ name: { contains: s, mode: 'insensitive' } }, { code: { contains: s, mode: 'insensitive' } }, { address: { contains: s, mode: 'insensitive' } }];
        if (digits.length >= 3) or.push({ phone: { contains: digits } }, { cnic: { contains: digits } }, { pntn: { contains: digits.length === 8 ? `${digits.slice(0, 7)}-${digits[7]}` : digits } });
        return or;
    };
    async function listCustomers(ctx, { q, active, limit = 100, offset = 0 } = {}) {
        const where = { tenantId: ctx.tenantId };
        if (active === '1' || active === 1 || active === true) where.active = true; else if (active === '0' || active === 0 || active === false) where.active = false;
        const or = customerSearch(q); if (or) where.OR = or;
        const take = whole(limit, 100, 1, 500), skip = whole(offset, 0, 0, 1000000);
        const [rows, total] = await Promise.all([prisma.posCustomer.findMany({ where, orderBy: [{ name: 'asc' }, { code: 'asc' }], take, skip }), prisma.posCustomer.count({ where })]);
        const stats = await customerStats(ctx.tenantId, rows.map(c => c.id));
        return { total, customers: rows.map(c => ({ ...customerView(c), ...stats.get(c.id) })) };
    }
    async function nextCustomerCode(tenantId) {
        const rows = await prisma.posCustomer.findMany({ where: { tenantId, code: { startsWith: 'CUS' } }, select: { code: true } });
        const top = rows.reduce((m, r) => Math.max(m, /^CUS(\d+)$/.test(r.code) ? Number(r.code.slice(3)) : 0), 0);
        return 'CUS' + pad(top + 1, 4);
    }
    // The same PNTN or CNIC is the same customer: two profiles for one buyer would split their history
    async function assertCustomerFree(tenantId, d, exceptId) {
        for (const [field, label] of [['pntn', 'PNTN'], ['cnic', 'CNIC']]) {
            if (!d[field]) continue;
            const clash = await prisma.posCustomer.findFirst({ where: { tenantId, [field]: d[field], ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { name: true, code: true } });
            if (clash) throw new PosError(409, `A customer with this ${label} already exists: ${clash.name} (${clash.code}).`);
        }
    }
    async function createCustomer(ctx, body) {
        const d = V.cleanCustomer(body);
        await assertCustomerFree(ctx.tenantId, d);
        for (let attempt = 0; attempt < 5; attempt++) {
            const code = await nextCustomerCode(ctx.tenantId);
            try {
                const c = await prisma.posCustomer.create({ data: { tenantId: ctx.tenantId, code, ...d } });
                await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.customer.create', entityType: 'PosCustomer', entityId: c.id, summary: `Customer "${c.name}" (${c.code}) added` });
                return customerView(c);
            } catch (e) { if (!(e && e.code === 'P2002' && /code/.test(String(e.meta && e.meta.target)))) throw e; } // two customers added at once took the same code: take the next
        }
        throw new PosError(409, 'The customer could not be given a code just now. Try again.');
    }
    async function updateCustomer(ctx, id, body) {
        const c = await prisma.posCustomer.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!c) throw new PosError(404, 'Customer not found.');
        const d = V.cleanCustomer({ ...customerView(c), ...body });
        await assertCustomerFree(ctx.tenantId, d, id);
        const u = await prisma.posCustomer.update({ where: { id }, data: d });
        const changed = ['name', 'pntn', 'cnic', 'phone', 'address', 'notes', 'active'].filter(k => c[k] !== u[k]);
        if (changed.length) await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.customer.update', entityType: 'PosCustomer', entityId: id, summary: `Customer "${u.name}" (${u.code}) changed: ${changed.map(k => (k === 'active' ? (u.active ? 'switched on' : 'switched off') : k)).join(', ')}` });
        return customerView(u);
    }
    async function customerDetail(ctx, id) {
        const c = await prisma.posCustomer.findFirst({ where: { id, tenantId: ctx.tenantId } });
        if (!c) throw new PosError(404, 'Customer not found.');
        const [stats, recent] = await Promise.all([customerStats(ctx.tenantId, [id]), prisma.posSale.findMany({ where: { tenantId: ctx.tenantId, customerId: id }, orderBy: { createdAt: 'desc' }, take: 10, include: BRIEF })]);
        return { ...customerView(c), ...stats.get(id), recent: recent.map(saleRow) };
    }

    // ---------- sales ----------
    const lineView = l => ({
        id: l.id, itemId: l.itemId, itemCode: l.itemCode, itemName: l.itemName, pctCode: l.pctCode, quantity: num(l.quantity), unitPrice: num(l.unitPrice), discount: num(l.discount),
        taxRate: num(l.taxRate), saleValue: num(l.saleValue), taxCharged: num(l.taxCharged), totalAmount: num(l.totalAmount), refLineId: l.refLineId,
    });
    const saleRow = s => ({
        id: s.id, usin: s.usin, invoiceType: s.invoiceType, state: s.state, env: s.env, mock: s.mock, paymentMode: s.paymentMode, counterId: s.counterId,
        counterName: s.counter ? s.counter.name : undefined, buyerName: s.buyerName, totalBill: num(s.totalBill), totalTax: num(s.totalTax), fiscalNumber: s.fiscalNumber,
        refUsin: s.refUsin, lastError: s.lastError, attempts: s.attempts, createdBy: s.createdBy, createdAt: s.createdAt, finalizedAt: s.finalizedAt, fiscalizedAt: s.fiscalizedAt,
    });
    const BRIEF = { counter: { select: { name: true, posId: true } } };

    async function loadSale(ctx, id, extra = {}) {
        const s = await prisma.posSale.findFirst({ where: { id, tenantId: ctx.tenantId }, include: { counter: true, customer: { select: { id: true, code: true, name: true } }, lines: { orderBy: { sort: 'asc' } }, ...extra } });
        if (!s) throw new PosError(404, 'Sale not found.');
        return s;
    }
    async function saleDetail(ctx, id) {
        await sweepInterrupted(ctx);
        const s = await loadSale(ctx, id, { events: { orderBy: { at: 'asc' } }, tries: { orderBy: { at: 'asc' } } });
        const canBeReturned = s.invoiceType === 1 && s.state === 'FISCALIZED'; // only a fiscalized sale has credit notes
        const [credits, returned] = canBeReturned
            ? await Promise.all([
                prisma.posSale.findMany({ where: { tenantId: ctx.tenantId, refSaleId: s.id }, select: { id: true, usin: true, state: true, totalBill: true, fiscalNumber: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
                returnedByLine(ctx.tenantId, s.id),
            ])
            : [[], new Map()];
        return {
            ...saleRow(s), counterPosId: s.counter.posId, buyer: { name: s.buyerName, pntn: s.buyerPntn, cnic: s.buyerCnic, phone: s.buyerPhone }, customer: s.customer || null,
            totals: { quantity: num(s.totalQuantity), saleValue: num(s.totalSaleValue), discount: num(s.totalDiscount), tax: num(s.totalTax), bill: num(s.totalBill) },
            lines: s.lines.map(l => ({ ...lineView(l), returned: returned.get(l.id) || 0 })), lastCode: s.lastCode, note: s.note, payload: s.payload, response: s.response,
            submittedAt: s.submittedAt, respondedAt: s.respondedAt, resolvedBy: s.resolvedBy, resolvedAt: s.resolvedAt, refSaleId: s.refSaleId,
            events: s.events.map(e => ({ at: e.at, from: e.fromState, to: e.toState, by: e.by, note: e.note })),
            tries: s.tries.map(t => ({ at: t.at, durationMs: t.durationMs, outcome: t.outcome, httpStatus: t.httpStatus, code: t.code, message: t.message })),
            creditNotes: credits.map(c => ({ id: c.id, usin: c.usin, state: c.state, totalBill: num(c.totalBill), fiscalNumber: c.fiscalNumber, createdAt: c.createdAt })),
        };
    }
    // How much of each sold line credit notes have already returned (a note that was rejected or cancelled returned nothing)
    async function returnedByLine(tenantId, saleId, db = prisma) {
        const rows = await db.posSaleLine.findMany({
            where: { sale: { tenantId, refSaleId: saleId, state: { in: ['AWAITING_FISCALIZATION', 'OUTCOME_UNKNOWN', 'FISCALIZED'] } }, refLineId: { not: null } },
            select: { refLineId: true, quantity: true, discount: true, saleValue: true, taxCharged: true },
        });
        const m = new Map();
        for (const r of rows) {
            const t = m.get(r.refLineId) || { quantity: 0, discount: 0, saleValue: 0, taxCharged: 0 };
            m.set(r.refLineId, { quantity: t.quantity + Number(r.quantity), discount: Math.round((t.discount + Number(r.discount)) * 100) / 100, saleValue: Math.round((t.saleValue + Number(r.saleValue)) * 100) / 100, taxCharged: Math.round((t.taxCharged + Number(r.taxCharged)) * 100) / 100 });
        }
        for (const [k, v] of m) m.set(k, { ...v, quantity: Math.round(v.quantity * 10000) / 10000 });
        return m;
    }

    // The one place a sale changes state. The update names the state it expects (and, in `guard`, anything else that must still be
    // true, such as "not being sent"), so of two people acting at the same moment only one succeeds and the other gets a 409; the
    // history line is written in the same transaction. to = the current state records a change that is not a move (a correction).
    async function moveSale(ctx, sale, to, { data = {}, text = '', by, guard = {}, tx } = {}) {
        if (to !== sale.state) assertMove(sale.state, to);
        const run = async db => {
            const r = await db.posSale.updateMany({ where: { id: sale.id, tenantId: ctx.tenantId, state: sale.state, ...guard }, data: { ...data, state: to } });
            if (r.count !== 1) return false;
            await db.posSaleEvent.create({ data: { saleId: sale.id, fromState: sale.state, toState: to, by: by || emailOf(ctx), note: note(text, 500) } });
            return true;
        };
        if (!(tx ? await run(tx) : await prisma.$transaction(run))) throw new PosError(409, CHANGED);
    }
    // A return can only be checked fairly while no other return is being made: the business's USIN counter row is the lock
    // (making a sale or a credit note takes it first thing), so two returns of the same line cannot both pass the check
    const lockUsins = (tx, tenantId) => tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;

    // A send that started but never ended (the server stopped while waiting): PRA may have recorded it
    async function sweepInterrupted(ctx) {
        const cutoff = new Date(now().getTime() - (pra.timeoutMs() + 15000));
        const stuck = await prisma.posSale.findMany({ where: { tenantId: ctx.tenantId, state: 'AWAITING_FISCALIZATION', respondedAt: null, submittedAt: { not: null, lt: cutoff } }, select: { id: true, usin: true } });
        for (const s of stuck) {
            try {
                // the send is over (nobody is waiting for PRA any more), so respondedAt is set: the sale can be sent again once it is sorted out
                await moveSale(ctx, { id: s.id, state: 'AWAITING_FISCALIZATION' }, 'OUTCOME_UNKNOWN', {
                    by: 'system', text: 'The send was interrupted before PRA answered', guard: { respondedAt: null, submittedAt: { not: null, lt: cutoff } },
                    data: { respondedAt: now(), lastError: 'The server stopped while waiting for PRA, so it is not known whether the sale was recorded.' },
                });
            } catch (e) { if (e instanceof PosError && e.status === 409) continue; throw e; } // someone else got there first
            await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.sale.unknown', entityType: 'PosSale', entityId: s.id, summary: `Sale ${s.usin}: the send to PRA was interrupted, outcome unknown: check PRA before doing anything` });
        }
    }

    // The tenant's own checks before a sale or credit note may be sent
    async function checkReady(ctx, counter) {
        if (!counter.active) throw new PosError(400, 'This counter is switched off.');
        if (pra.isMock() && counter.env === 'PRODUCTION') {
            throw new PosError(400, 'This counter is set to Production, but this server is in test mode and sends nothing to PRA. Production sales can only be made once the server is set live.');
        }
        if (counter.env === 'PRODUCTION') {
            const p = await getProfile(ctx.tenantId);
            if (!p.complete) throw new PosError(400, 'Add the business name, address and PNTN in Settings before making production sales: they are printed on every receipt.');
        }
    }

    async function allocateUsin(tx, tenantId) {
        const t = await tx.tenant.update({ where: { id: tenantId }, data: { posSeq: { increment: 1 } }, select: { posSeq: true } });
        return pad(t.posSeq, 6);
    }

    // The screen sends a key with each new sale. If the answer is lost (a phone on a poor connection) and the cashier presses
    // again, the same key gives back the sale that was already made: never a second one.
    const cleanRef = v => {
        const r = String(v === undefined || v === null ? '' : v).trim();
        if (!r) return null;
        if (!/^[A-Za-z0-9_-]{8,64}$/.test(r)) throw new PosError(400, 'The sale key is not valid. Reload the page and try again.');
        return r;
    };
    async function sameSale(ctx, ref) {
        if (!ref) return null;
        const found = await prisma.posSale.findFirst({ where: { tenantId: ctx.tenantId, clientRef: ref }, select: { id: true } });
        if (!found) return null;
        const sale = await saleDetail(ctx, found.id);
        const outcome = { FISCALIZED: 'FISCALIZED', REJECTED: 'REJECTED', OUTCOME_UNKNOWN: 'UNKNOWN', CANCELLED: 'CANCELLED' }[sale.state] || (inFlight(sale) ? 'IN_PROGRESS' : 'NOT_SENT');
        const message = outcome === 'FISCALIZED' ? 'This sale was already made and fiscalized.' : outcome === 'IN_PROGRESS' ? 'This sale is being sent to PRA right now.' : sale.lastError || 'This sale was already made.';
        return { sale, result: { outcome, message, fiscalNumber: sale.fiscalNumber, mock: sale.mock, duplicate: true } };
    }
    // SRS 2.1 / FR-6.1: when PRA cannot be reached, new sales are blocked (no sale is made) with a clear message. After a rest the
    // first caller is let through to try the connection, so this is asked once per sale, right before it is written.
    function assertConnected(counter) {
        if (breaker.allow(counter.id)) return;
        const secs = Math.max(1, Math.ceil(breaker.state(counter.id).retryInMs / 1000));
        throw new PosError(503, `Sales on this counter are paused: PRA could not be reached a moment ago, and a fiscal sale cannot be made without it. Check the internet connection and try again in ${secs} seconds.`);
    }
    // Why this sale cannot go to PRA from this counter (null: it can). A sale keeps the environment and POS ID it was made with.
    function refusal(sale, counter) {
        if (!counter.active) return { reason: 'COUNTER_OFF', message: 'This counter is switched off, so the sale cannot be sent.' };
        if (pra.isMock() && sale.env === 'PRODUCTION') return { reason: 'MOCK_PRODUCTION', message: 'This sale is for a Production counter, but the server is in test mode and sends nothing to PRA.' };
        const madeWith = sale.payload && sale.payload.POSID;
        if (sale.env !== counter.env || String(madeWith) !== String(counter.posId)) {
            return { reason: 'COUNTER_CHANGED', message: `This sale was made when the counter was ${sale.env.toLowerCase()} with POS ID ${madeWith}, and the counter has been changed since, so nothing can be sent for it from here.` };
        }
        return null;
    }

    // Hands out the USIN and writes one invoice (state AWAITING_FISCALIZATION) with its lines and its first history line, all or
    // nothing. `make` builds the invoice inside the transaction, once the USIN is known (and the business's USIN counter is locked).
    // Two requests with the same key at the same moment: the second gets the first one's sale back ({ duplicate }).
    async function insertSale(ctx, ref, make) {
        try {
            const sale = await prisma.$transaction(async tx => {
                const usin = await allocateUsin(tx, ctx.tenantId);
                const m = await make(tx, usin);
                const problems = reconcile(m.payload);
                if (problems.length) throw new PosError(500, `This ${m.what} does not add up (${problems[0]}) and was not saved.`);
                return tx.posSale.create({
                    data: {
                        ...m.data, tenantId: ctx.tenantId, usin, clientRef: ref, state: 'AWAITING_FISCALIZATION', payload: m.payload, createdBy: emailOf(ctx), createdAt: m.at, finalizedAt: m.at,
                        lines: { create: m.lines.map((l, i) => ({ sort: i, ...lineFields(l) })) },
                        events: { create: [{ fromState: null, toState: 'AWAITING_FISCALIZATION', by: emailOf(ctx), note: m.event }] },
                    },
                });
            });
            return { sale };
        } catch (e) {
            if (e && e.code === 'P2002' && ref) { const duplicate = await sameSale(ctx, ref); if (duplicate) return { duplicate }; }
            throw e;
        }
    }

    // Writes the sale and sends it. input: { counterId, paymentMode, buyer, lines:[{itemId, quantity, unitPrice?, discount?, discountPercent?}] }
    async function createSale(ctx, input) {
        const ref = cleanRef(input.clientRef);
        const again = await sameSale(ctx, ref);
        if (again) return again;
        const paymentMode = V.cleanPaymentMode(input.paymentMode);
        const hasCustomer = input.customerId !== undefined && input.customerId !== null && String(input.customerId).trim() !== '';
        const typedBuyer = hasCustomer ? null : V.cleanBuyer(input.buyer || {}); // a saved customer's own details are used instead of anything typed
        const wanted = Array.isArray(input.lines) ? input.lines : [];
        if (!wanted.length) throw new PosError(400, 'Add at least one item.');
        if (wanted.length > 200) throw new PosError(400, 'A sale can have 200 lines at most.');
        if (wanted.some(l => !l || typeof l !== 'object' || Array.isArray(l))) throw new PosError(400, 'A line in the sale is not valid.');
        const [counter, found, customer] = await Promise.all([
            prisma.posCounter.findFirst({ where: { id: String(input.counterId || ''), tenantId: ctx.tenantId } }),
            prisma.posItem.findMany({ where: { tenantId: ctx.tenantId, id: { in: wanted.map(l => String(l.itemId || '')) } } }),
            hasCustomer ? prisma.posCustomer.findFirst({ where: { id: String(input.customerId), tenantId: ctx.tenantId } }) : null,
        ]);
        if (!counter) throw new PosError(400, 'Choose the counter this sale is made on.');
        if (hasCustomer && (!customer || !customer.active)) throw new PosError(400, 'This customer is not available any more. Choose another, or type the buyer\'s details.');
        const buyer = customer ? V.cleanBuyer(customer) : typedBuyer;
        await checkReady(ctx, counter);
        const items = new Map(found.map(i => [i.id, i]));
        const named = [], calcInput = [];
        for (const l of wanted) {
            const item = items.get(String(l.itemId || ''));
            if (!item || !item.active) throw new PosError(400, 'An item in the sale is no longer available. Remove it and try again.');
            let price = num(item.unitPrice);
            if (item.openPrice) {
                if (l.unitPrice === undefined || l.unitPrice === null || String(l.unitPrice).trim() === '') throw new PosError(400, `Enter the price for "${item.name}".`);
                price = l.unitPrice;
            }
            const base = { quantity: l.quantity, unitPrice: price };
            let discount = l.discount;
            if ((discount === undefined || discount === null || discount === '') && l.discountPercent !== undefined && l.discountPercent !== null && l.discountPercent !== '') discount = C.discountFromPercent(base, l.discountPercent);
            calcInput.push({ ...base, discount, taxRate: C.rateFor({ taxRate: num(item.taxRate), taxRateCard: num(item.taxRateCard) }, paymentMode) });
            named.push({ itemId: item.id, itemCode: item.code, itemName: item.name, category: item.category, pctCode: item.pctCode });
        }
        const calc = C.calcSale(calcInput);
        const lines = calc.lines.map((l, i) => ({ ...named[i], ...l }));
        const needBuyer = C.buyerProblem(calc.totals.saleValue, buyer);
        if (needBuyer) throw new PosError(400, needBuyer);
        const at = now();
        assertConnected(counter); // last, so a sale refused for any other reason never uses up the connection's one trial after a rest
        const made = await insertSale(ctx, ref, async (tx, usin) => ({
            what: 'sale', at, lines, event: 'Sale finalized',
            payload: buildPayload({ posId: counter.posId, usin, dateTime: at, buyer, paymentMode, invoiceType: C.INVOICE_TYPES.NEW, lines, totals: calc.totals }),
            data: {
                counterId: counter.id, customerId: customer ? customer.id : null, invoiceType: C.INVOICE_TYPES.NEW, env: counter.env, paymentMode, buyerName: buyer.name, buyerPntn: buyer.pntn, buyerCnic: buyer.cnic, buyerPhone: buyer.phone,
                totalQuantity: calc.totals.quantity, totalSaleValue: calc.totals.saleValue, totalDiscount: calc.totals.discount, totalTax: calc.totals.tax, totalBill: calc.totals.bill,
            },
        }));
        if (made.duplicate) return made.duplicate;
        return send(ctx, made.sale.id, { gated: true });
    }

    // Sends one AWAITING sale to PRA and records how it ended. Never throws for a PRA problem: the outcome says what happened.
    // gated: the caller has already been through the connection check (it holds the one trial given after a rest).
    async function send(ctx, saleId, { gated = false } = {}) {
        const sale = await loadSale(ctx, saleId);
        const counter = sale.counter;
        const stop = async (message, reason) => {
            await prisma.posSale.update({ where: { id: sale.id }, data: { lastError: message } });
            return { sale: await saleDetail(ctx, sale.id), result: { outcome: 'NOT_SENT', reason, message, breaker: breaker.state(counter.id) } };
        };
        if (sale.state !== 'AWAITING_FISCALIZATION') throw new PosError(409, 'This sale is not waiting to be sent.');
        const refused = refusal(sale, counter);
        if (refused) return stop(refused.message, refused.reason);
        if (!gated && !breaker.allow(counter.id)) return stop(pausedText(breaker.state(counter.id).retryInMs), 'BREAKER_OPEN');
        const startedAt = now();
        // Claim the send. Only a sale that is not in flight can be claimed, and the claim itself marks it in flight, so of two
        // requests at the same moment exactly one wins.
        const claim = await prisma.posSale.updateMany({
            where: { id: sale.id, state: 'AWAITING_FISCALIZATION', ...NOT_IN_FLIGHT },
            data: { attempts: { increment: 1 }, submittedAt: startedAt, respondedAt: null },
        });
        if (claim.count !== 1) throw new PosError(409, BUSY);

        let token = null;
        if (counter.tokenEnc) { try { token = decrypt(counter.tokenEnc); } catch { token = null; } }
        const r = await pra.submit({ env: sale.env, token, payload: sale.payload });
        const endedAt = now();

        const connected = r.outcome === 'FISCALIZED' || r.outcome === 'REJECTED';
        const failed = r.outcome === 'UNKNOWN' || (r.outcome === 'NOT_SENT' && DOWN.has(r.reason));
        if (connected) breaker.record(counter.id, true); else if (failed) breaker.record(counter.id, false);

        const by = emailOf(ctx);
        await prisma.$transaction(async tx => {
            await tx.posAttempt.create({ data: { saleId: sale.id, at: startedAt, durationMs: r.durationMs ?? endedAt - startedAt, outcome: r.outcome, httpStatus: r.httpStatus ?? null, code: r.code ?? null, message: note(r.message, 500), mock: Boolean(r.mock) } });
            const common = { respondedAt: endedAt, lastCode: r.code ?? null, response: r.raw ?? undefined };
            const finish = async (to, data, text) => {
                try { await moveSale(ctx, sale, to, { tx, by, text, data: { ...common, ...data } }); } catch (e) {
                    if (!(e instanceof PosError && e.status === 409)) throw e;
                    // nothing else touches a sale while PRA is answering, so this should not happen: if it does, PRA's answer is kept
                    await tx.posSaleEvent.create({ data: { saleId: sale.id, fromState: null, toState: to, by, note: note(`PRA answered (${text}) but the sale had been changed meanwhile: check it.`, 500) } });
                }
            };
            if (r.outcome === 'FISCALIZED') await finish('FISCALIZED', { fiscalNumber: r.invoiceNumber, fiscalizedAt: endedAt, lastError: null, mock: Boolean(r.mock) }, `PRA invoice no. ${r.invoiceNumber}${r.mock ? ' (test mode)' : ''}`);
            else if (r.outcome === 'REJECTED') await finish('REJECTED', { lastError: note(r.message, 500) }, r.message);
            else if (r.outcome === 'UNKNOWN') await finish('OUTCOME_UNKNOWN', { lastError: note(r.message, 500) }, r.message);
            else await tx.posSale.updateMany({ where: { id: sale.id, state: 'AWAITING_FISCALIZATION' }, data: { ...common, lastError: note(r.message, 500) } });
        });
        if (r.outcome === 'UNKNOWN') {
            await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.sale.unknown', entityType: 'PosSale', entityId: sale.id, summary: `Sale ${sale.usin}: PRA did not answer, outcome unknown: check PRA's report before doing anything` });
        }
        return { sale: await saleDetail(ctx, sale.id), result: { outcome: r.outcome, message: r.message, fiscalNumber: r.invoiceNumber || null, mock: Boolean(r.mock), breaker: breaker.state(counter.id) } }; // breaker: so the screen need not reload everything to learn it
    }

    // A credit note PRA refused can be sent again only while the quantity it returns is still free: a newer note may have used it
    async function assertReturnFits(db, tenantId, credit) {
        const [orig, done] = await Promise.all([
            db.posSaleLine.findMany({ where: { saleId: credit.refSaleId }, select: { id: true, quantity: true } }),
            returnedByLine(tenantId, credit.refSaleId, db),
        ]);
        const sold = new Map(orig.map(l => [l.id, Math.round(Number(l.quantity) * 10000)]));
        for (const l of credit.lines) {
            const used = Math.round(((done.get(l.refLineId) || {}).quantity || 0) * 10000);
            if (used + Math.round(Number(l.quantity) * 10000) > (sold.get(l.refLineId) || 0)) {
                throw new PosError(409, `Part of what this note returns ("${l.itemName}") has been returned by another credit note since. Cancel this note and make a new return.`);
            }
        }
    }

    // Send again: for a sale that was never delivered, or one PRA rejected (after the buyer details were corrected). Never for OUTCOME_UNKNOWN.
    async function retry(ctx, id) {
        await sweepInterrupted(ctx);
        const s = await loadSale(ctx, id);
        if (s.state === 'OUTCOME_UNKNOWN') throw new PosError(409, 'It is not known whether PRA recorded this sale. It is never sent again by itself: check PRA\'s report, then record what you found.');
        if (!['AWAITING_FISCALIZATION', 'REJECTED'].includes(s.state)) throw new PosError(409, 'This sale cannot be sent again.');
        if (inFlight(s)) throw new PosError(409, BUSY);
        if (s.respondedAt && now().getTime() - s.respondedAt.getTime() < MIN_RETRY_GAP_MS) throw new PosError(429, 'Wait a few seconds before sending again.');
        await checkReady(ctx, s.counter);
        if (s.state === 'REJECTED') {
            // everything that could refuse the send is looked at first, so a refused "send again" changes nothing
            const refused = refusal(s, s.counter);
            if (refused) throw new PosError(409, refused.message);
            const rest = breaker.state(s.counter.id);
            if (rest.open) throw new PosError(503, pausedText(rest.retryInMs));
            await prisma.$transaction(async tx => {
                if (s.invoiceType === C.INVOICE_TYPES.CREDIT) { await lockUsins(tx, ctx.tenantId); await assertReturnFits(tx, ctx.tenantId, s); }
                await moveSale(ctx, s, 'AWAITING_FISCALIZATION', { tx, guard: NOT_IN_FLIGHT, text: 'Sent again after correction' });
            });
        }
        return send(ctx, id);
    }

    // The buyer's details are the usual reason PRA says no: they can be corrected before the sale is sent again
    async function updateBuyer(ctx, id, body) {
        const s = await loadSale(ctx, id);
        if (!['AWAITING_FISCALIZATION', 'REJECTED'].includes(s.state)) throw new PosError(409, 'Only a sale that has not been fiscalized can be corrected.');
        if (inFlight(s)) throw new PosError(409, 'This sale is being sent right now.');
        const b = V.cleanBuyer(body || {});
        const payload = { ...s.payload, BuyerName: b.name, BuyerPNTN: b.pntn, BuyerCNIC: b.cnic, BuyerPhoneNumber: b.phone };
        await moveSale(ctx, s, s.state, { guard: NOT_IN_FLIGHT, text: 'Buyer details corrected', data: { buyerName: b.name, buyerPntn: b.pntn, buyerCnic: b.cnic, buyerPhone: b.phone, payload } });
        await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.sale.correct', entityType: 'PosSale', entityId: id, summary: `Sale ${s.usin}: buyer details corrected before sending again` });
    }

    // Cancel a sale PRA does not have (SRS 5.3). The record stays.
    async function cancel(ctx, id, reason) {
        await sweepInterrupted(ctx);
        const s = await loadSale(ctx, id);
        const why = note(reason, 300);
        if (why.length < 3) throw new PosError(400, 'Write why the sale is being cancelled.');
        if (s.state === 'OUTCOME_UNKNOWN') throw new PosError(409, 'It is not known whether PRA recorded this sale. Check PRA\'s report and record the result first.');
        if (s.state === 'FISCALIZED') throw new PosError(409, 'A fiscalized sale cannot be cancelled: make a credit note instead.');
        if (inFlight(s)) throw new PosError(409, 'This sale is being sent right now.');
        await moveSale(ctx, s, 'CANCELLED', { guard: NOT_IN_FLIGHT, text: why, data: { note: why } });
        await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.sale.cancel', entityType: 'PosSale', entityId: id, summary: `Sale ${s.usin} cancelled before fiscalization: ${why}` });
    }

    // After checking PRA's own report (IRIS → IMS Fiscal Report) for this USIN: record what was found (SRS FR-2.6)
    async function resolve(ctx, id, { result, fiscalNumber, note: text }) {
        const s = await loadSale(ctx, id);
        if (s.state !== 'OUTCOME_UNKNOWN') throw new PosError(409, 'This sale is not waiting for a manual check.');
        const why = note(text, 300);
        if (why.length < 5) throw new PosError(400, 'Write how you checked (for example: "found in the IMS Fiscal Report on 19 Oct").');
        const by = emailOf(ctx), at = now();
        if (result === 'FISCALIZED') {
            const n = note(fiscalNumber, 40);
            if (!/^[A-Za-z0-9-]{6,30}$/.test(n)) throw new PosError(400, 'Enter the invoice number exactly as PRA\'s report shows it (letters and numbers, up to 30).');
            if (await prisma.posSale.count({ where: { tenantId: ctx.tenantId, fiscalNumber: n, id: { not: id } } })) throw new PosError(409, 'That PRA invoice number belongs to another sale.');
            await moveSale(ctx, s, 'FISCALIZED', { by, text: `Confirmed by hand: PRA invoice no. ${n}. ${why}`, data: { fiscalNumber: n, fiscalizedAt: at, respondedAt: at, lastError: null, resolvedBy: by, resolvedAt: at, note: why } });
            await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.sale.resolve', entityType: 'PosSale', entityId: id, summary: `Sale ${s.usin} confirmed with PRA by hand as ${n}: ${why}` });
        } else if (result === 'NOT_FOUND') {
            await moveSale(ctx, s, 'REJECTED', { by, text: `Not found at PRA. ${why}`, data: { respondedAt: at, lastError: 'Checked with PRA by hand: this sale was not recorded.', resolvedBy: by, resolvedAt: at, note: why } });
            await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.sale.resolve', entityType: 'PosSale', entityId: id, summary: `Sale ${s.usin} not found at PRA: it can be sent again or cancelled. ${why}` });
        } else if (result === 'STILL_UNKNOWN') {
            await moveSale(ctx, s, s.state, { by, text: `Checked, still unknown. ${why}`, data: { note: why } });
        } else {
            throw new PosError(400, 'Choose what the check showed.');
        }
    }

    // A credit note (InvoiceType 3, RefUSIN = the sale's USIN) returns part or all of a fiscalized sale
    async function creditNote(ctx, id, { lines, reason, clientRef }) {
        const ref = cleanRef(clientRef);
        const again = await sameSale(ctx, ref);
        if (again) return again;
        const s = await loadSale(ctx, id);
        if (s.state !== 'FISCALIZED' || s.invoiceType !== 1) throw new PosError(409, 'Only a fiscalized sale can be returned.');
        await checkReady(ctx, s.counter);
        const moved = refusal(s, s.counter);
        if (moved) throw new PosError(409, moved.message);
        const why = note(reason, 300);
        if (why.length < 3) throw new PosError(400, 'Write the reason for the return.');
        // a line with no quantity (or 0) is "not returned"; anything else must be a proper quantity
        const wanted = (Array.isArray(lines) ? lines : []).filter(l => l && typeof l === 'object' && String(l.quantity === undefined || l.quantity === null ? '' : l.quantity).trim() !== '' && Number(l.quantity) !== 0);
        if (!wanted.length) throw new PosError(400, 'Choose what is being returned.');
        const byId = new Map(s.lines.map(l => [l.id, l]));
        if (new Set(wanted.map(w => String(w.lineId || ''))).size !== wanted.length) throw new PosError(400, 'A line is listed twice.');
        const none = { quantity: 0, discount: 0, saleValue: 0, taxCharged: 0 };
        const creditLines = done => wanted.map(w => {
            const orig = byId.get(String(w.lineId || ''));
            if (!orig) throw new PosError(400, 'A returned line does not belong to this sale.');
            const credit = C.creditLine(lineView(orig), w.quantity, done.get(orig.id) || none);
            return { ...credit, refLineId: orig.id, itemId: orig.itemId, itemCode: orig.itemCode, itemName: orig.itemName, category: orig.category, pctCode: orig.pctCode };
        });
        creditLines(await returnedByLine(ctx.tenantId, s.id)); // mistakes are reported before the connection's one trial is used up
        assertConnected(s.counter);
        const at = now();
        const made = await insertSale(ctx, ref, async (tx, usin) => {
            const credit = creditLines(await returnedByLine(ctx.tenantId, s.id, tx)); // read again under the lock: two returns at once cannot take the same quantity
            const totals = C.totalsOf(credit);
            return {
                what: 'credit note', at, lines: credit, event: `Credit note for sale ${s.usin}: ${why}`,
                payload: buildPayload({
                    posId: s.counter.posId, usin, refUsin: s.usin, dateTime: at, buyer: { name: s.buyerName, pntn: s.buyerPntn, cnic: s.buyerCnic, phone: s.buyerPhone },
                    paymentMode: s.paymentMode, invoiceType: C.INVOICE_TYPES.CREDIT, lines: credit, totals,
                }),
                data: {
                    counterId: s.counterId, customerId: s.customerId, invoiceType: C.INVOICE_TYPES.CREDIT, refUsin: s.usin, refSaleId: s.id, env: s.env, paymentMode: s.paymentMode, note: why,
                    buyerName: s.buyerName, buyerPntn: s.buyerPntn, buyerCnic: s.buyerCnic, buyerPhone: s.buyerPhone,
                    totalQuantity: totals.quantity, totalSaleValue: totals.saleValue, totalDiscount: totals.discount, totalTax: totals.tax, totalBill: totals.bill,
                },
            };
        });
        if (made.duplicate) return made.duplicate;
        await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.sale.credit', entityType: 'PosSale', entityId: made.sale.id, summary: `Credit note ${made.sale.usin} for sale ${s.usin}: ${why}` });
        return send(ctx, made.sale.id, { gated: true });
    }

    // ---------- lists, receipts, monitoring ----------
    // The filters (public/pos-scan.js is for scans; these are in src/pos/reports.js): dates, status, counter, branch, cashier, how paid,
    // sale or return, customer, item, category, tax rate, bill size, and a word (invoice number, PRA number or buyer)
    async function listSales(ctx, query = {}) {
        await sweepInterrupted(ctx);
        const where = R.saleWhere(ctx.tenantId, R.cleanFilters(query));
        const take = whole(query.limit, 100, 1, 500), skip = whole(query.offset, 0, 0, 1000000);
        const [rows, total] = await Promise.all([
            prisma.posSale.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip, include: BRIEF }),
            prisma.posSale.count({ where }),
        ]);
        return { total, sales: rows.map(saleRow) };
    }

    // The data for the printed receipt (SRS 4.1). Read-only: printing again never sends anything to PRA (FR-4.4).
    async function receipt(ctx, id) {
        const s = await loadSale(ctx, id, { events: false });
        if (s.state !== 'FISCALIZED') throw new PosError(409, 'A receipt can be printed once PRA has given the fiscal invoice number.');
        const [profile, branch, settings] = await Promise.all([getProfile(ctx.tenantId), prisma.posBranch.findUnique({ where: { id: s.counter.branchId } }), getSettings(ctx.tenantId)]);
        return {
            business: { name: profile.businessName, pntn: profile.pntn, address: profile.address, phone: profile.phone, footer: profile.receiptFooter },
            look: { header: settings.receiptHeader, width: settings.receiptWidth, showCashier: settings.showCashier }, // the owner's choices for the paper
            branch: branch ? { name: branch.name, address: branch.address, city: branch.city, phone: branch.phone } : null,
            counter: { name: s.counter.name, posId: s.counter.posId },
            sale: {
                usin: s.usin, fiscalNumber: s.fiscalNumber, verifyUrl: pra.verifyUrl(s.fiscalNumber), invoiceType: s.invoiceType, refUsin: s.refUsin, paymentMode: s.paymentMode,
                mock: s.mock, env: s.env, at: s.finalizedAt || s.createdAt, cashier: settings.showCashier ? String(s.createdBy || '').split('@')[0].slice(0, 24) : '', buyer: { name: s.buyerName, pntn: s.buyerPntn, cnic: s.buyerCnic, phone: s.buyerPhone },
                totals: { quantity: num(s.totalQuantity), saleValue: num(s.totalSaleValue), discount: num(s.totalDiscount), tax: num(s.totalTax), bill: num(s.totalBill) },
                lines: s.lines.map(lineView),
            },
        };
    }

    // Figures cover one kind of sale at a time, so test sales never mix with real ones: the test (Sandbox) sales while the server
    // is in test mode, the real (Production) sales once it is live. Everything stays in the sales list and the CSV.
    const figuresEnv = () => (pra.isMock() ? 'SANDBOX' : 'PRODUCTION');

    // What needs a person (one query, cheap enough for the alert strip to ask every minute)
    async function attention(ctx) {
        await sweepInterrupted(ctx);
        const rows = await prisma.posSale.groupBy({ by: ['state'], where: { tenantId: ctx.tenantId, state: { in: ['AWAITING_FISCALIZATION', 'REJECTED', 'OUTCOME_UNKNOWN'] } }, _count: { _all: true } });
        const count = st => (rows.find(r => r.state === st) || { _count: { _all: 0 } })._count._all;
        return { awaiting: count('AWAITING_FISCALIZATION'), rejected: count('REJECTED'), outcomeUnknown: count('OUTCOME_UNKNOWN') };
    }

    // SRS 4.7: pending items, outcome-unknown count, last fiscalization, connection state
    async function overview(ctx) {
        const today = pktDay(now());
        const dayStart = new Date(`${today}T00:00:00+05:00`);
        const env = figuresEnv();
        const [needs, todayOk, last, branches, profile, answered] = await Promise.all([
            attention(ctx),
            prisma.posSale.groupBy({ by: ['invoiceType'], where: { tenantId: ctx.tenantId, state: 'FISCALIZED', env, fiscalizedAt: { gte: dayStart } }, _count: { _all: true }, _sum: { totalBill: true, totalTax: true } }),
            prisma.posSale.findFirst({ where: { tenantId: ctx.tenantId, state: 'FISCALIZED', env }, orderBy: { fiscalizedAt: 'desc' }, select: { fiscalizedAt: true, fiscalNumber: true } }),
            listBranches(ctx.tenantId),
            getProfile(ctx.tenantId),
            // how fast PRA answers means nothing in test mode (nothing is sent), so it is not even looked up there
            pra.isMock() ? [] : prisma.posAttempt.findMany({ where: { sale: { tenantId: ctx.tenantId }, mock: false, outcome: { in: ['FISCALIZED', 'REJECTED'] } }, orderBy: { at: 'desc' }, take: 100, select: { durationMs: true } }),
        ]);
        const ms = answered.map(a => a.durationMs).sort((a, b) => a - b);
        const t1 = todayOk.find(r => r.invoiceType === 1), t3 = todayOk.find(r => r.invoiceType === 3);
        return {
            testMode: pra.isMock(), today, ...needs,
            todaySales: { count: t1 ? t1._count._all : 0, total: t1 ? num(t1._sum.totalBill) : 0, tax: t1 ? num(t1._sum.totalTax) : 0 },
            todayReturns: { count: t3 ? t3._count._all : 0, total: t3 ? num(t3._sum.totalBill) : 0 },
            lastFiscalizedAt: last ? last.fiscalizedAt : null,
            responseTimes: ms.length ? { calls: ms.length, avgMs: Math.round(ms.reduce((t, x) => t + x, 0) / ms.length), p95Ms: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))], maxMs: ms[ms.length - 1] } : null,
            profileComplete: profile.complete,
            counters: branches.flatMap(b => b.counters.map(c => ({ id: c.id, name: c.name, branch: b.name, env: c.env, active: c.active, hasToken: c.hasToken, pending: c.pending, breaker: c.breaker }))),
        };
    }

    // For the administrator's client list: this month's fiscalized sales, the last one, and what needs attention (cheap: no tokens read)
    async function adminFigures(tenantId) {
        const month = pktDay(now()).slice(0, 7), env = figuresEnv();
        const [sold, last, needs, counters] = await Promise.all([
            prisma.posSale.aggregate({ where: { tenantId, state: 'FISCALIZED', invoiceType: 1, env, fiscalizedAt: { gte: new Date(`${month}-01T00:00:00+05:00`) } }, _count: { _all: true }, _sum: { totalBill: true } }),
            prisma.posSale.findFirst({ where: { tenantId, state: 'FISCALIZED', env }, orderBy: { fiscalizedAt: 'desc' }, select: { fiscalizedAt: true } }),
            prisma.posSale.groupBy({ by: ['state'], where: { tenantId, state: { in: ['AWAITING_FISCALIZATION', 'REJECTED', 'OUTCOME_UNKNOWN'] } }, _count: { _all: true } }),
            prisma.posCounter.count({ where: { tenantId, active: true } }),
        ]);
        const n = st => (needs.find(r => r.state === st) || { _count: { _all: 0 } })._count._all;
        return {
            testMode: pra.isMock(), month, counters, sales: { count: sold._count._all, total: num(sold._sum.totalBill) || 0 }, lastSaleAt: last ? last.fiscalizedAt : null,
            needsAttention: n('AWAITING_FISCALIZATION') + n('REJECTED') + n('OUTCOME_UNKNOWN'), unknown: n('OUTCOME_UNKNOWN'),
        };
    }
    // The same for one client's Manage screen, with its counters and business details (the token is only ever shown masked)
    async function adminSummary(tenantId) {
        const [figures, branches, profile, items] = await Promise.all([adminFigures(tenantId), listBranches(tenantId), getProfile(tenantId), prisma.posItem.count({ where: { tenantId, active: true } })]);
        return {
            ...figures, items, profileComplete: profile.complete, businessName: profile.businessName, pntn: profile.pntn,
            counters: branches.flatMap(b => b.counters.map(c => ({ id: c.id, name: c.name, branch: b.name, posId: c.posId, env: c.env, active: c.active, hasToken: c.hasToken, tokenMasked: c.tokenMasked, pending: c.pending, breaker: c.breaker }))),
        };
    }

    // Totals for a date range (managers): fiscalized sales and returns, by payment mode and by item, and what is not fiscalized
    const money2 = n => Math.round(Number(n || 0) * 100) / 100;
    async function salesReport(ctx, filters = {}) {
        const inRange = R.saleWhere(ctx.tenantId, { ...R.cleanFilters(filters), state: undefined });
        const where = { ...inRange, env: figuresEnv() };
        const [fis, other, sold, back, left] = await Promise.all([
            prisma.posSale.groupBy({ by: ['invoiceType', 'paymentMode'], where: { ...where, state: 'FISCALIZED' }, _count: { _all: true }, _sum: { totalSaleValue: true, totalDiscount: true, totalTax: true, totalBill: true } }),
            prisma.posSale.groupBy({ by: ['state'], where: { ...where, state: { not: 'FISCALIZED' } }, _count: { _all: true } }),
            prisma.posSaleLine.groupBy({ by: ['itemCode', 'itemName'], where: { sale: { ...where, state: 'FISCALIZED', invoiceType: 1 } }, _sum: { quantity: true, totalAmount: true } }),
            prisma.posSaleLine.groupBy({ by: ['itemCode', 'itemName'], where: { sale: { ...where, state: 'FISCALIZED', invoiceType: 3 } }, _sum: { quantity: true, totalAmount: true } }),
            prisma.posSale.count({ where: { ...inRange, state: 'FISCALIZED', env: { not: figuresEnv() } } }), // fiscalized, but of the other kind: not in these figures
        ]);
        const blank = () => ({ count: 0, saleValue: 0, discount: 0, tax: 0, bill: 0 });
        const sales = blank(), returns = blank(), byPay = new Map();
        for (const r of fis) {
            const t = r.invoiceType === 3 ? returns : sales;
            t.count += r._count._all; t.saleValue += num(r._sum.totalSaleValue); t.discount += num(r._sum.totalDiscount); t.tax += num(r._sum.totalTax); t.bill += num(r._sum.totalBill);
            const row = byPay.get(r.paymentMode) || { mode: r.paymentMode, label: (C.PAYMENT_MODES.find(m => m.id === r.paymentMode) || {}).label || String(r.paymentMode), sales: 0, returns: 0 };
            if (r.invoiceType === 3) row.returns += num(r._sum.totalBill); else row.sales += num(r._sum.totalBill);
            byPay.set(r.paymentMode, row);
        }
        const items = new Map();
        for (const [rows, sign] of [[sold, 1], [back, -1]]) {
            for (const r of rows) {
                const it = items.get(r.itemCode) || { itemCode: r.itemCode, itemName: r.itemName, quantity: 0, bill: 0 };
                it.quantity += sign * num(r._sum.quantity); it.bill += sign * num(r._sum.totalAmount);
                items.set(r.itemCode, it);
            }
        }
        const fix = t => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, k === 'count' ? v : money2(v)]));
        const notFis = st => (other.find(o => o.state === st) || { _count: { _all: 0 } })._count._all;
        return {
            from: filters.from || null, to: filters.to || null, testMode: pra.isMock(), scope: pra.isMock() ? 'TEST' : 'LIVE', leftOut: left,
            sales: fix(sales), returns: fix(returns),
            net: { saleValue: money2(sales.saleValue - returns.saleValue), tax: money2(sales.tax - returns.tax), bill: money2(sales.bill - returns.bill) },
            byPayment: [...byPay.values()].sort((a, b) => a.mode - b.mode).map(r => ({ ...r, sales: money2(r.sales), returns: money2(r.returns), net: money2(r.sales - r.returns) })),
            items: [...items.values()].map(i => ({ ...i, quantity: Math.round(i.quantity * 10000) / 10000, bill: money2(i.bill) })).sort((a, b) => b.bill - a.bill).slice(0, 30),
            notFiscalized: { waiting: notFis('AWAITING_FISCALIZATION'), refused: notFis('REJECTED'), unknown: notFis('OUTCOME_UNKNOWN'), cancelled: notFis('CANCELLED') },
        };
    }

    // The sales of a date range as a spreadsheet (PRA's own POS component exports its invoices too). One row per sale, or per line.
    // Text that could be read as a formula by Excel is defused with a leading quote.
    async function salesCsv(ctx, query = {}) {
        const where = R.saleWhere(ctx.tenantId, R.cleanFilters(query));
        const { from, to, state } = query;
        const perLine = query.detail === 'lines';
        const rows = await prisma.posSale.findMany({
            where, orderBy: { createdAt: 'asc' }, take: 20000,
            select: {
                finalizedAt: true, createdAt: true, usin: true, invoiceType: true, state: true, env: true, fiscalNumber: true, refUsin: true, createdBy: true, paymentMode: true,
                buyerName: true, buyerPntn: true, buyerCnic: true, buyerPhone: true, totalSaleValue: true, totalDiscount: true, totalTax: true, totalBill: true, mock: true, note: true,
                counter: { select: { name: true, posId: true } },
                ...(perLine ? { lines: { orderBy: { sort: 'asc' }, select: { itemCode: true, itemName: true, category: true, pctCode: true, quantity: true, unitPrice: true, discount: true, taxRate: true, saleValue: true, taxCharged: true, totalAmount: true } } } : {}),
            },
        });
        const head = ['Date and time (Pakistan)', 'Invoice no. (USIN)', 'Type', 'Status', 'Environment', 'PRA invoice no.', 'Returns invoice (RefUSIN)', 'Counter', 'POS ID', 'Cashier', 'Paid by', 'Buyer name', 'Buyer PNTN', 'Buyer CNIC', 'Buyer phone'];
        const lineHead = ['Item code', 'Item', 'Category', 'PCT code', 'Quantity', 'Unit price', 'Discount', 'Tax %', 'Value', 'Tax', 'Line total'];
        const totalHead = ['Sale value', 'Discount', 'Sales tax', 'Total', 'Test mode', 'Note'];
        const out = [(perLine ? [...head, ...lineHead] : [...head, ...totalHead]).map(csvText).join(',')];
        const mode = id => (C.PAYMENT_MODES.find(m => m.id === id) || {}).label || id;
        for (const r of rows) {
            const base = [praDateTime(r.finalizedAt || r.createdAt), r.usin, r.invoiceType === 3 ? 'Credit note' : r.invoiceType === 2 ? 'Debit note' : 'Sale', r.state, r.env === 'PRODUCTION' ? 'Production' : 'Sandbox / test', r.fiscalNumber, r.refUsin, r.counter.name, r.counter.posId, r.createdBy, mode(r.paymentMode), r.buyerName, r.buyerPntn, r.buyerCnic, r.buyerPhone].map(csvText);
            if (!perLine) out.push([...base, csvNum(r.totalSaleValue), csvNum(r.totalDiscount), csvNum(r.totalTax), csvNum(r.totalBill), r.mock ? 'yes' : '', csvText(r.note)].join(','));
            else for (const l of r.lines) out.push([...base, csvText(l.itemCode), csvText(l.itemName), csvText(l.category), l.pctCode, Number(l.quantity), csvNum(l.unitPrice), csvNum(l.discount), Number(l.taxRate), csvNum(l.saleValue), csvNum(l.taxCharged), csvNum(l.totalAmount)].join(','));
        }
        const name = `pos-${perLine ? 'lines' : 'sales'}-${from || 'start'}-to-${to || 'today'}.csv`.replace(/[^A-Za-z0-9._-]/g, '');
        await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.export', entityType: 'PosSale', entityId: null, summary: `Exported ${rows.length} ${perLine ? 'sale lines' : 'sales'} to CSV (${from || 'start'} to ${to || 'today'}${state ? ', ' + state.toLowerCase() : ''})` });
        return { filename: name, csv: out.join('\r\n') + '\r\n', rows: rows.length };
    }

    // The customers as a spreadsheet (managers)
    async function customersCsv(ctx, { q, active } = {}) {
        const where = { tenantId: ctx.tenantId };
        if (active === '1') where.active = true; else if (active === '0') where.active = false;
        const or = customerSearch(q); if (or) where.OR = or;
        const rows = await prisma.posCustomer.findMany({ where, orderBy: [{ name: 'asc' }, { code: 'asc' }], take: 20000 });
        const stats = await customerStats(ctx.tenantId, rows.map(c => c.id));
        const out = [['Code', 'Name', 'PNTN', 'CNIC', 'Phone', 'Address', 'Notes', 'Active', 'Sales', 'Sales total', 'Returns', 'Returns total', 'Net', 'Last sale'].map(csvText).join(',')];
        for (const c of rows) {
            const t = stats.get(c.id);
            out.push([csvText(c.code), csvText(c.name), csvText(c.pntn), csvText(c.cnic), csvText(c.phone), csvText(c.address), csvText(c.notes), c.active ? 'yes' : 'no', t.sales, csvNum(t.salesTotal), t.returns, csvNum(t.returnsTotal), csvNum(t.net), t.lastSaleAt ? praDateTime(t.lastSaleAt) : ''].join(','));
        }
        await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.export', entityType: 'PosCustomer', entityId: null, summary: `Exported ${rows.length} customers to CSV` });
        return { filename: 'pos-customers.csv', csv: out.join('\r\n') + '\r\n', rows: rows.length };
    }

    // What a scan (or a code typed in) is: an item, with the price and the tax rate it is set to, and/or a sale (by its number, the PRA
    // invoice number, or the address on a receipt's QR). Both are looked for; the screen takes the one it wants.
    async function lookup(ctx, input) {
        const p = Scan.parse(input);
        const out = { code: p.raw, item: null, sale: null };
        if (!p.raw || p.tooLong) return out;
        if (p.codes.length) {
            const found = await prisma.posItem.findMany({ where: { tenantId: ctx.tenantId, OR: p.codes.flatMap(c => [{ barcode: { equals: c, mode: 'insensitive' } }, { code: { equals: c, mode: 'insensitive' } }]) }, take: 10 });
            out.item = Scan.findItem(found.map(itemView), p); // the same rule the cashier screen uses: the barcode first, then the code
        }
        const numbers = [...new Set([p.invoice, p.usin, ...p.codes].filter(Boolean))];
        if (numbers.length) {
            const sale = await prisma.posSale.findFirst({
                where: { tenantId: ctx.tenantId, OR: numbers.flatMap(n => [{ usin: n }, { fiscalNumber: { equals: n, mode: 'insensitive' } }]) },
                orderBy: { createdAt: 'desc' }, include: BRIEF,
            });
            out.sale = sale ? saleRow(sale) : null;
        }
        return out;
    }

    // What the cashier screen needs to start: usable counters (no tokens) and the items
    async function cashierSetup(ctx) {
        const [branches, items, profile, settings] = await Promise.all([listBranches(ctx.tenantId), listItems(ctx.tenantId, { activeOnly: true }), getProfile(ctx.tenantId), getSettings(ctx.tenantId)]);
        const counters = branches.filter(b => b.active).flatMap(b => b.counters.filter(c => c.active).map(c => ({ id: c.id, name: c.name, branch: b.name, env: c.env, hasToken: c.hasToken, breaker: c.breaker })));
        return { testMode: pra.isMock(), counters, items, profileComplete: profile.complete, paymentModes: C.PAYMENT_MODES, settings };
    }

    const reports = R.createReports({ prisma, pra, getProfile, listBranches });
    // a report as a spreadsheet, with a note in the activity trail that it was taken
    async function reportCsv(ctx, groupBy, query) {
        const r = await reports.byReport(ctx, groupBy, query);
        const out = [[r.title, 'Invoices', 'Quantity', 'Value before tax', 'Discount', 'Sales tax', 'Total', 'Returns', 'Returned total', 'Net quantity', 'Net value', 'Net sales tax', 'Net total', 'Share %'].map(csvText).join(',')];
        const row = (label, x, share) => out.push([csvText(label), x.sales, x.quantity, csvNum(x.saleValue), csvNum(x.discount), csvNum(x.tax), csvNum(x.bill), x.returns, csvNum(x.returnBill), x.netQuantity, csvNum(x.netValue), csvNum(x.netTax), csvNum(x.netBill), share === undefined ? '' : Number(share).toFixed(1)].join(','));
        for (const x of r.rows) row(['day', 'month'].includes(groupBy) ? x.key : x.label, x, x.share); // dates stay as 2026-10-19 in a spreadsheet, so they sort and filter there
        row('Total', r.totals, 100);
        const name = `pos-report-${groupBy}-${r.filters.from}-to-${r.filters.to}${r.scope === 'TEST' ? '-test' : ''}.csv`.replace(/[^A-Za-z0-9._-]/g, '');
        await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.export', entityType: 'PosSale', entityId: null, summary: `Exported the report by ${groupBy} (${r.filters.from} to ${r.filters.to}) to CSV` });
        return { filename: name, csv: out.join('\r\n') + '\r\n', rows: r.rows.length };
    }

    return {
        reportBy: reports.byReport, reportClosing: reports.closing, reportOptions: reports.options, reportCsv,
        getProfile, saveProfile, getSettings, saveSettings, listBranches, createBranch, updateBranch, createCounter, updateCounter, setToken, decommission,
        listItems, createItem, updateItem, searchPct, createSale, retry, updateBuyer, cancel, resolve, creditNote,
        listCustomers, createCustomer, updateCustomer, customerDetail, customersCsv, lookup,
        listSales, saleDetail, receipt, overview, attention, cashierSetup, sweepInterrupted, salesReport, salesCsv, adminFigures, adminSummary,
    };
}

module.exports = { createPosService, PosError };
