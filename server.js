require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const { authenticateToken, requireRole, requireTenant, signToken } = require('./src/auth');
const { encrypt, decrypt, mask } = require('./src/crypto');
const { calcInvoice } = require('./src/tax');
const fbr = require('./src/fbr');
const hs = require('./src/hscodes');
const annexC = require('./src/annexc');
const { SCENARIOS, PROVINCES, UOMS, RATES } = require('./src/scenarios');

for (const k of ['DATABASE_URL', 'JWT_SECRET', 'ENCRYPTION_KEY']) {
    if (!process.env[k]) {
        console.error(`Missing ${k} in .env (see .env.example)`);
        process.exit(1);
    }
}

const app = express();
const prisma = new PrismaClient();

app.set('trust proxy', 1); // behind Render / Vercel proxies
app.use(express.json({ limit: '1mb' }));

// Render health check; /api/health is the same, reachable through the Vercel /api rewrite (used to wake a sleeping free instance)
async function health(req, res) {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
}
app.get('/healthz', health);
app.get('/api/health', health);
app.use(express.static('public'));

class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function todayPKT() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
}

function tenantToken(tenant) {
    return tenant.fbrTokenEnc ? decrypt(tenant.fbrTokenEnc) : null;
}

function publicTenant(t) {
    return {
        id: t.id,
        companyName: t.companyName,
        sellerNtnCnic: t.sellerNtnCnic,
        sellerBusinessName: t.sellerBusinessName,
        sellerProvince: t.sellerProvince,
        sellerAddress: t.sellerAddress,
        sellerStrn: t.sellerStrn,
        fbrEnv: t.fbrEnv,
        furtherTaxRate: Number(t.furtherTaxRate),
        fbrTokenMasked: t.fbrTokenEnc ? mask(decrypt(t.fbrTokenEnc)) : '',
    };
}

function sellerReady(t) {
    return t.sellerNtnCnic && t.sellerBusinessName && t.sellerProvince && t.sellerAddress;
}

// ---------- Auth ----------
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) throw new HttpError(400, 'Email and password are required.');
    const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase().trim() }, include: { tenant: true } });
    if (!user || !(await bcrypt.compare(String(password), user.password))) {
        throw new HttpError(400, 'Invalid email or password.');
    }
    res.json({
        token: signToken(user),
        role: user.role,
        companyName: user.tenant ? user.tenant.companyName : 'Super Admin',
    });
});

// Static lists the UI needs (scenarios, fallback dropdown values)
app.get('/api/meta', authenticateToken, (req, res) => {
    res.json({
        scenarios: SCENARIOS, provinces: PROVINCES, uoms: UOMS, rates: RATES, mock: process.env.FBR_MOCK === 'true',
        debitReasons: DEBIT_REASONS, editWindowHours: IRIS_EDIT_WINDOW_HOURS, debitNoteMaxDays: DEBIT_NOTE_MAX_DAYS,
    });
});

// ---------- Super admin (minimal: list + create tenants) ----------
app.get('/api/admin/clients', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const tenants = await prisma.tenant.findMany({
        orderBy: { createdAt: 'desc' },
        include: { users: { select: { email: true } }, _count: { select: { invoices: true } } },
    });
    res.json(tenants.map(t => ({
        ...publicTenant(t),
        emails: t.users.map(u => u.email),
        invoiceCount: t._count.invoices,
        createdAt: t.createdAt,
    })));
});

app.post('/api/admin/clients', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const { companyName, clientEmail, clientPassword } = req.body || {};
    if (!companyName || !clientEmail || !clientPassword) throw new HttpError(400, 'Company name, email and password are required.');
    if (String(clientPassword).length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
    const email = String(clientEmail).toLowerCase().trim();
    if (await prisma.user.findUnique({ where: { email } })) throw new HttpError(400, 'That email is already registered.');

    const tenant = await prisma.tenant.create({
        data: {
            companyName: String(companyName).trim(),
            users: { create: { email, password: await bcrypt.hash(String(clientPassword), 10), role: 'CLIENT_USER' } },
        },
    });
    res.json({ success: true, tenantId: tenant.id });
});

app.get('/api/admin/egress-ip', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    res.json(await fbr.egressIp());
});

// ---------- Client settings ----------
app.get('/api/client/settings', authenticateToken, requireTenant, async (req, res) => {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    res.json(publicTenant(t));
});

app.put('/api/client/settings', authenticateToken, requireTenant, async (req, res) => {
    const b = req.body || {};
    const data = {};
    for (const f of ['sellerBusinessName', 'sellerProvince', 'sellerAddress']) {
        if (b[f] !== undefined) data[f] = String(b[f]).trim();
    }
    if (b.sellerNtnCnic !== undefined) {
        const v = String(b.sellerNtnCnic).replace(/\D/g, '');
        if (v && ![7, 9, 13].includes(v.length)) throw new HttpError(400, 'Seller NTN must be 7 or 9 digits, or CNIC 13 digits.');
        data.sellerNtnCnic = v;
    }
    if (b.sellerStrn !== undefined) {
        const v = String(b.sellerStrn).replace(/\D/g, '');
        if (v && ![7, 9, 13].includes(v.length)) throw new HttpError(400, 'STRN must be 13 digits (or 7/9-digit NTN if FBR issued that as your registration no.).');
        data.sellerStrn = v;
    }
    if (b.fbrEnv !== undefined) {
        if (!['SANDBOX', 'PRODUCTION'].includes(b.fbrEnv)) throw new HttpError(400, 'Invalid environment.');
        data.fbrEnv = b.fbrEnv;
    }
    if (b.furtherTaxRate !== undefined) {
        const r = Number(b.furtherTaxRate);
        if (!Number.isFinite(r) || r < 0 || r > 100) throw new HttpError(400, 'Further tax rate must be 0–100.');
        data.furtherTaxRate = r;
    }
    // Empty token field = keep existing token
    if (b.fbrToken) data.fbrTokenEnc = encrypt(String(b.fbrToken).trim());

    const t = await prisma.tenant.update({ where: { id: req.user.tenantId }, data });
    // New token: refresh the HS code list from FBR in the background
    if (b.fbrToken) hs.syncFromFbr(prisma, String(b.fbrToken).trim()).catch(err => console.error('HS sync failed:', err.message));
    res.json(publicTenant(t));
});

// FBR reference lists (provinces, uom, ...) via the tenant's token, with static fallbacks
app.get('/api/ref/:name', authenticateToken, requireTenant, async (req, res) => {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    let data = null;
    try { data = await fbr.reference(req.params.name, tenantToken(t)); } catch { data = null; }
    res.json({ live: Boolean(data), data });
});

// ---------- HS codes ----------
app.get('/api/hs', authenticateToken, async (req, res) => {
    res.json(await hs.search(prisma, req.query.q));
});

app.get('/api/hs/stats', authenticateToken, async (req, res) => {
    res.json(await hs.stats(prisma));
});

// Valid UOMs FBR accepts for this HS code (needs a working token)
app.get('/api/hs/:code/uom', authenticateToken, requireTenant, async (req, res) => {
    const code = hs.normalizeCode(req.params.code);
    if (!hs.HS_FORMAT.test(code)) throw new HttpError(400, 'HS code must look like 0101.2100');
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    let data = null;
    try { data = await fbr.hsUom(code, tenantToken(t)); } catch { data = null; }
    res.json({ live: Boolean(data), data });
});

app.post('/api/hs/sync', authenticateToken, requireTenant, async (req, res) => {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    if (!t.fbrTokenEnc) throw new HttpError(400, 'Save your PRAL token first.');
    if (process.env.FBR_MOCK === 'true') throw new HttpError(400, 'FBR_MOCK is on; turn it off to sync from FBR.');
    const n = await hs.syncFromFbr(prisma, tenantToken(t));
    if (n === null) throw new HttpError(502, 'Could not get the HS code list from FBR. Check the token and IP whitelisting.');
    res.json({ synced: n });
});

// ---------- Invoices ----------
// A SUBMITTING invoice whose attempt started this long ago lost its process mid-flight: treat it as UNCERTAIN.
const STALE_SUBMIT_MS = 3 * 60 * 1000;
// Filed invoices can be changed/cancelled in IRIS within this window (STGO 1 of 2026 — confirm with the CA);
// after it, cancellation needs Commissioner approval.
const IRIS_EDIT_WINDOW_HOURS = 72;
// DI error 0034: a debit note must be within 180 days of the original invoice date
const DEBIT_NOTE_MAX_DAYS = 180;
const DEBIT_REASONS = ['Goods returned', 'Change in price', 'Cancellation of supply', 'Change in quantity', 'Others'];
const FBR_NO = /^\d{7,13}DI\d{8,20}$/;
const ACTIVE_STATUSES = ['SUBMITTING', 'SUBMITTED', 'UNCERTAIN']; // count towards the original invoice's limits
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const NTN_LENGTHS = [7, 9, 13];
const ITEMS = { items: { orderBy: { sNo: 'asc' } } };

function effectiveStatus(inv) {
    if (inv.status === 'SUBMITTING' && inv.lastAttemptAt && Date.now() - new Date(inv.lastAttemptAt).getTime() > STALE_SUBMIT_MS) {
        return 'UNCERTAIN';
    }
    return inv.status;
}
const withStatus = inv => ({ ...inv, status: effectiveStatus(inv) });

// Call only while holding the SUBMITTING lock
async function submitInvoice(invoiceId, tenant) {
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: ITEMS });
    const payload = fbr.buildPayload(tenant, inv, inv.items);
    let result;
    try {
        result = await fbr.submit(tenantToken(tenant), inv.fbrEnv, payload);
    } catch (err) {
        // A bug after the request may have left — be conservative
        console.error('submit crashed:', err);
        result = { ok: false, uncertain: true, error: 'Unexpected error while sending to FBR. Check IRIS before resubmitting.', raw: null };
    }

    const updated = await prisma.invoice.update({
        where: { id: inv.id },
        data: result.ok
            ? { status: 'SUBMITTED', fbrInvoiceNumber: result.invoiceNumber, submittedAt: new Date(), fbrRequest: payload, fbrResponse: result.raw, errorMessage: null }
            : { status: result.uncertain ? 'UNCERTAIN' : 'FAILED', fbrRequest: payload, fbrResponse: result.raw ?? undefined, errorMessage: result.error },
        include: ITEMS,
    });
    if (result.ok) await rememberBuyer(tenant.id, updated).catch(err => console.error('save buyer failed:', err.message));
    return updated;
}

// Take the SUBMITTING lock atomically; returns false if another submission holds it or the state doesn't allow it
async function acquireSubmitLock(id, tenantId, allowUncertain) {
    const or = [{ status: { in: ['DRAFT', 'FAILED'] } }];
    if (allowUncertain) {
        or.push({ status: 'UNCERTAIN' }, { status: 'SUBMITTING', lastAttemptAt: { lt: new Date(Date.now() - STALE_SUBMIT_MS) } });
    }
    const { count } = await prisma.invoice.updateMany({
        where: { id, tenantId, OR: or },
        data: { status: 'SUBMITTING', submitAttempts: { increment: 1 }, lastAttemptAt: new Date() },
    });
    return count === 1;
}

app.get('/api/invoices', authenticateToken, requireTenant, async (req, res) => {
    const invoices = await prisma.invoice.findMany({
        where: { tenantId: req.user.tenantId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
            id: true, localNo: true, fbrInvoiceNumber: true, status: true, fbrEnv: true, invoiceDate: true,
            scenarioId: true, buyerBusinessName: true, totalAmount: true, errorMessage: true, createdAt: true,
            lastAttemptAt: true, submitAttempts: true, invoiceType: true, invoiceRefNo: true, submittedAt: true,
            cancelledAt: true, cancelNote: true,
        },
    });
    res.json(invoices.map(withStatus));
});

app.get('/api/invoices/:id', authenticateToken, requireTenant, async (req, res) => {
    const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include: ITEMS });
    if (!inv) throw new HttpError(404, 'Invoice not found.');
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    res.json({ invoice: withStatus(inv), seller: publicTenant(t) });
});

app.post('/api/invoices', authenticateToken, requireTenant, async (req, res) => {
    const b = req.body || {};
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    if (!sellerReady(tenant)) throw new HttpError(400, 'Complete seller details in FBR Settings first.');

    // Idempotency: the browser sends one id per form; a resent request returns the first result
    const clientRequestId = b.clientRequestId ? String(b.clientRequestId) : null;
    if (clientRequestId && !/^[A-Za-z0-9-]{8,64}$/.test(clientRequestId)) throw new HttpError(400, 'Invalid clientRequestId.');
    const findExisting = () => clientRequestId
        ? prisma.invoice.findUnique({ where: { tenantId_clientRequestId: { tenantId: tenant.id, clientRequestId } }, include: ITEMS })
        : null;
    const existing = await findExisting();
    if (existing) return res.json({ invoice: withStatus(existing), seller: publicTenant(tenant), duplicate: true });

    const invoiceType = b.invoiceType === 'Debit Note' ? 'Debit Note' : 'Sale Invoice';
    const buyerRegistrationType = b.buyerRegistrationType === 'Registered' ? 'Registered' : 'Unregistered';
    const buyerNtnCnic = String(b.buyerNtnCnic || '').replace(/\D/g, '');
    const endConsumer = buyerRegistrationType === 'Unregistered' && b.endConsumer === true;
    if (buyerRegistrationType === 'Registered' && !NTN_LENGTHS.includes(buyerNtnCnic.length)) {
        throw new HttpError(400, 'Registered buyer needs NTN (7 or 9 digits) or CNIC (13 digits).');
    }
    if (buyerNtnCnic && !NTN_LENGTHS.includes(buyerNtnCnic.length)) {
        throw new HttpError(400, 'Buyer NTN must be 7 or 9 digits, or CNIC 13 digits.');
    }
    const isDebit = invoiceType === 'Debit Note';
    const invoiceRefNo = isDebit ? String(b.invoiceRefNo || '').trim().toUpperCase() : '';
    const invoiceDate = /^\d{4}-\d{2}-\d{2}$/.test(b.invoiceDate || '') ? b.invoiceDate : todayPKT();
    const reason = isDebit ? String(b.reason || '').trim() : '';
    const reasonRemarks = isDebit ? String(b.reasonRemarks || '').trim().slice(0, 500) : '';
    if (isDebit) {
        if (!invoiceRefNo) throw new HttpError(400, 'Debit note needs the original FBR invoice number.');
        if (!FBR_NO.test(invoiceRefNo)) throw new HttpError(400, 'Original FBR invoice number looks wrong (e.g. 7000007DI1747119701593).');
        if (!DEBIT_REASONS.includes(reason)) throw new HttpError(400, 'Choose a reason for the debit note.');
        if (reason === 'Others' && !reasonRemarks) throw new HttpError(400, 'Write remarks when the reason is "Others".');
    }

    const scenarioId = tenant.fbrEnv === 'SANDBOX' ? String(b.scenarioId || '') : null;
    if (tenant.fbrEnv === 'SANDBOX' && !SCENARIOS.some(s => s.id === scenarioId)) {
        throw new HttpError(400, 'Select a sandbox scenario (SN001…SN028).');
    }

    let calc;
    try {
        calc = calcInvoice(b.items, { buyerRegistrationType, endConsumer, furtherTaxRate: Number(tenant.furtherTaxRate) });
    } catch (err) {
        throw new HttpError(400, err.message);
    }

    let refInvoice = null;
    if (isDebit) {
        // When the original was filed from this app, apply FBR's debit-note rules up front (else FBR checks them)
        refInvoice = await prisma.invoice.findFirst({ where: { tenantId: tenant.id, fbrInvoiceNumber: invoiceRefNo } });
        if (refInvoice) {
            if (refInvoice.invoiceType !== 'Sale Invoice') throw new HttpError(400, 'A debit note must refer to a sale invoice.');
            if (refInvoice.status === 'CANCELLED') throw new HttpError(400, 'The original invoice was cancelled; a debit note against it is not allowed.');
            const age = daysBetween(refInvoice.invoiceDate, invoiceDate);
            if (age < 0) throw new HttpError(400, `Debit note date can't be before the original invoice date (${refInvoice.invoiceDate}).`);
            if (age > DEBIT_NOTE_MAX_DAYS) throw new HttpError(400, `A debit note is only allowed within ${DEBIT_NOTE_MAX_DAYS} days of the original invoice (${refInvoice.invoiceDate}).`);
            if (refInvoice.buyerNtnCnic && refInvoice.buyerNtnCnic !== buyerNtnCnic) {
                throw new HttpError(400, `Buyer must be the same as on the original invoice (NTN/CNIC ${refInvoice.buyerNtnCnic}).`);
            }
            const prior = await prisma.invoice.aggregate({
                where: { tenantId: tenant.id, invoiceType: 'Debit Note', invoiceRefNo, status: { in: ACTIVE_STATUSES } },
                _sum: { totalExclST: true, totalST: true },
            });
            const usedValue = Number(prior._sum.totalExclST || 0) + calc.totals.totalExclST;
            const usedST = Number(prior._sum.totalST || 0) + calc.totals.totalST;
            if (usedValue > Number(refInvoice.totalExclST) + 0.005) {
                throw new HttpError(400, `Debit notes would total ${usedValue.toFixed(2)} (value excl. ST), more than the original ${Number(refInvoice.totalExclST).toFixed(2)}.`);
            }
            if (usedST > Number(refInvoice.totalST) + 0.005) {
                throw new HttpError(400, `Debit notes would total ${usedST.toFixed(2)} sales tax, more than the original ${Number(refInvoice.totalST).toFixed(2)}.`);
            }
        }
    }

    let created;
    try {
        created = await prisma.$transaction(async tx => {
            const { invoiceSeq } = await tx.tenant.update({
                where: { id: tenant.id },
                data: { invoiceSeq: { increment: 1 } },
                select: { invoiceSeq: true },
            });
            return tx.invoice.create({
                data: {
                    tenantId: tenant.id,
                    localNo: invoiceSeq,
                    clientRequestId,
                    status: 'SUBMITTING', // created already holding the lock
                    submitAttempts: 1,
                    lastAttemptAt: new Date(),
                    fbrEnv: tenant.fbrEnv,
                    invoiceType,
                    invoiceDate,
                    invoiceRefNo,
                    reason,
                    reasonRemarks,
                    scenarioId,
                    buyerNtnCnic,
                    buyerBusinessName: String(b.buyerBusinessName || '').trim() || 'Walk-in Customer',
                    buyerProvince: String(b.buyerProvince || '').trim() || tenant.sellerProvince,
                    buyerAddress: String(b.buyerAddress || '').trim() || tenant.sellerAddress,
                    buyerRegistrationType,
                    endConsumer,
                    ...calc.totals,
                    items: { create: calc.lines },
                },
            });
        });
    } catch (err) {
        // Same clientRequestId arrived twice at the same moment: return the one that won
        if (err.code === 'P2002' && clientRequestId) {
            const winner = await findExisting();
            if (winner) return res.json({ invoice: withStatus(winner), seller: publicTenant(tenant), duplicate: true });
        }
        throw err;
    }

    const invoice = await submitInvoice(created.id, tenant);
    res.json({ invoice, seller: publicTenant(tenant) });
});

app.post('/api/invoices/:id/retry', authenticateToken, requireTenant, async (req, res) => {
    const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!inv) throw new HttpError(404, 'Invoice not found.');
    const status = effectiveStatus(inv);
    if (status === 'SUBMITTED') throw new HttpError(400, 'Invoice is already submitted to FBR.');
    if (status === 'SUBMITTING') throw new HttpError(409, 'This invoice is being sent to FBR right now. Wait a moment and refresh.');
    const confirmed = req.body?.confirmUncertain === true;
    if (status === 'UNCERTAIN' && !confirmed) {
        throw new HttpError(409, 'FBR may already have this invoice. Check IRIS first; resubmit only if it is not there.');
    }
    if (!(await acquireSubmitLock(inv.id, inv.tenantId, confirmed))) {
        throw new HttpError(409, 'Another submission of this invoice is already running.');
    }
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    const invoice = await submitInvoice(inv.id, tenant);
    res.json({ invoice, seller: publicTenant(tenant) });
});

// UNCERTAIN invoice found in IRIS: record the FBR number shown there instead of resubmitting
app.post('/api/invoices/:id/resolve', authenticateToken, requireTenant, async (req, res) => {
    const fbrInvoiceNumber = String(req.body?.fbrInvoiceNumber || '').trim().toUpperCase();
    if (!/^\d{7,13}DI\d{8,20}$/.test(fbrInvoiceNumber)) {
        throw new HttpError(400, 'Enter the FBR invoice number exactly as shown in IRIS (e.g. 7000007DI1747119701593).');
    }
    const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!inv) throw new HttpError(404, 'Invoice not found.');
    if (effectiveStatus(inv) !== 'UNCERTAIN') throw new HttpError(400, 'Only invoices marked UNCERTAIN can be resolved this way.');
    try {
        await prisma.invoice.update({
            where: { id: inv.id },
            data: { status: 'SUBMITTED', fbrInvoiceNumber, submittedAt: new Date(), errorMessage: null },
        });
    } catch (err) {
        if (err.code === 'P2002') throw new HttpError(400, 'That FBR invoice number is already linked to another invoice.');
        throw err;
    }
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: ITEMS });
    await rememberBuyer(tenant.id, invoice).catch(() => {});
    res.json({ invoice: withStatus(invoice), seller: publicTenant(tenant) });
});

// Record a cancellation done in IRIS (the DI API has no cancel call). Within the IRIS window it's a plain
// cancel; after it, FBR needs Commissioner approval, so an approval reference is required.
app.post('/api/invoices/:id/cancel', authenticateToken, requireTenant, async (req, res) => {
    const note = String(req.body?.note || '').trim().slice(0, 500);
    const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!inv) throw new HttpError(404, 'Invoice not found.');
    if (inv.status !== 'SUBMITTED') throw new HttpError(400, 'Only invoices filed with FBR can be marked cancelled.');
    const hours = (Date.now() - new Date(inv.submittedAt || inv.createdAt).getTime()) / 3600000;
    if (hours > IRIS_EDIT_WINDOW_HOURS && !note) {
        throw new HttpError(400, `More than ${IRIS_EDIT_WINDOW_HOURS} hours have passed: cancelling needs Commissioner approval. Enter the approval reference.`);
    }
    if (inv.invoiceType === 'Sale Invoice') {
        const notes = await prisma.invoice.count({ where: { tenantId: inv.tenantId, invoiceType: 'Debit Note', invoiceRefNo: inv.fbrInvoiceNumber || '-', status: { in: ACTIVE_STATUSES } } });
        if (notes) throw new HttpError(400, 'This invoice has debit notes; cancel those first.');
    }
    const { count } = await prisma.invoice.updateMany({
        where: { id: inv.id, status: 'SUBMITTED' },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelNote: note },
    });
    if (!count) throw new HttpError(409, 'Invoice changed meanwhile; refresh and try again.');
    res.json({ invoice: withStatus(await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: ITEMS })) });
});

// ---------- Reports ----------
// Annex-C for a month: one row per item of every invoice filed with FBR (SUBMITTED)
app.get('/api/reports/annex-c', authenticateToken, requireTenant, async (req, res) => {
    const range = annexC.monthRange(String(req.query.month || ''));
    if (!range) throw new HttpError(400, 'Choose a month (YYYY-MM).');
    const fbrEnv = req.query.env === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION';
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    const invoices = await prisma.invoice.findMany({
        where: { tenantId: tenant.id, fbrEnv, status: 'SUBMITTED', invoiceDate: { gte: range.from, lte: range.to } },
        orderBy: [{ invoiceDate: 'asc' }, { localNo: 'asc' }],
        include: ITEMS,
    });
    const list = annexC.rows(invoices, tenant.sellerProvince);
    const sum = annexC.totals(list);
    if (req.query.format === 'csv') {
        const name = `annex-c-${req.query.month}-${fbrEnv.toLowerCase()}.csv`;
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
        return res.send(annexC.toCsv(list, sum));
    }
    res.json({ month: req.query.month, fbrEnv, invoices: invoices.length, lines: list.length, totals: sum, rows: list.slice(0, 50) });
});

// ---------- Saved products ----------
function productData(b) {
    const d = {
        name: String(b.name || '').trim(),
        hsCode: hs.normalizeCode(b.hsCode || ''),
        uoM: String(b.uoM || '').trim(),
        rate: String(b.rate || '').trim(),
        saleType: String(b.saleType || '').trim(),
        sroScheduleNo: String(b.sroScheduleNo || '').trim(),
        sroItemSerialNo: String(b.sroItemSerialNo || '').trim(),
        unitPrice: b.unitPrice === '' || b.unitPrice == null ? null : Number(b.unitPrice),
    };
    if (!d.name || d.name.length > 200) throw new HttpError(400, 'Product name is required (max 200 characters).');
    if (!hs.HS_FORMAT.test(d.hsCode)) throw new HttpError(400, 'HS code must look like 0101.2100');
    for (const f of ['uoM', 'rate', 'saleType']) if (!d[f]) throw new HttpError(400, `${f} is required.`);
    if (d.unitPrice !== null && (!Number.isFinite(d.unitPrice) || d.unitPrice < 0)) throw new HttpError(400, 'Unit price must be a non-negative number.');
    return d;
}

app.get('/api/products', authenticateToken, requireTenant, async (req, res) => {
    const q = String(req.query.q || '').trim();
    res.json(await prisma.product.findMany({
        where: { tenantId: req.user.tenantId, ...(q && { OR: [{ name: { contains: q, mode: 'insensitive' } }, { hsCode: { startsWith: hs.normalizeCode(q) || q } }] }) },
        orderBy: { name: 'asc' },
        take: q ? 20 : 1000,
    }));
});

// With id: edit that product. Without id: upsert by name, so saving "Yogurt 500g" again updates it.
app.post('/api/products', authenticateToken, requireTenant, async (req, res) => {
    const d = productData(req.body || {});
    const tenantId = req.user.tenantId;
    try {
        if (req.body.id) {
            const { count } = await prisma.product.updateMany({ where: { id: String(req.body.id), tenantId }, data: d });
            if (!count) throw new HttpError(404, 'Product not found.');
            return res.json(await prisma.product.findUnique({ where: { id: String(req.body.id) } }));
        }
        res.json(await prisma.product.upsert({ where: { tenantId_name: { tenantId, name: d.name } }, update: d, create: { ...d, tenantId } }));
    } catch (err) {
        if (err.code === 'P2002') throw new HttpError(400, `Another product is already named "${d.name}".`);
        throw err;
    }
});

app.delete('/api/products/:id', authenticateToken, requireTenant, async (req, res) => {
    const { count } = await prisma.product.deleteMany({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!count) throw new HttpError(404, 'Product not found.');
    res.json({ deleted: true });
});

// ---------- Saved buyers ----------
function buyerData(b) {
    const ntn = String(b.ntnCnic ?? b.buyerNtnCnic ?? '').replace(/\D/g, '');
    const d = {
        businessName: String(b.businessName ?? b.buyerBusinessName ?? '').trim(),
        ntnCnic: ntn || null,
        registrationType: (b.registrationType ?? b.buyerRegistrationType) === 'Registered' ? 'Registered' : 'Unregistered',
        province: String(b.province ?? b.buyerProvince ?? '').trim(),
        address: String(b.address ?? b.buyerAddress ?? '').trim(),
    };
    if (!d.businessName || d.businessName.length > 200) throw new HttpError(400, 'Buyer name is required (max 200 characters).');
    if (d.ntnCnic && !NTN_LENGTHS.includes(d.ntnCnic.length)) throw new HttpError(400, 'Buyer NTN must be 7 or 9 digits, or CNIC 13 digits.');
    if (d.registrationType === 'Registered' && !d.ntnCnic) throw new HttpError(400, 'Registered buyer needs an NTN or CNIC.');
    return d;
}

async function saveBuyer(tenantId, d) {
    if (d.ntnCnic) {
        return prisma.buyer.upsert({ where: { tenantId_ntnCnic: { tenantId, ntnCnic: d.ntnCnic } }, update: d, create: { ...d, tenantId } });
    }
    const same = await prisma.buyer.findFirst({ where: { tenantId, ntnCnic: null, businessName: { equals: d.businessName, mode: 'insensitive' } } });
    return same ? prisma.buyer.update({ where: { id: same.id }, data: d }) : prisma.buyer.create({ data: { ...d, tenantId } });
}

// After a filed invoice: remember buyers that have an NTN/CNIC (walk-ins are not saved)
async function rememberBuyer(tenantId, inv) {
    if (!inv.buyerNtnCnic) return;
    await saveBuyer(tenantId, buyerData(inv));
}

app.get('/api/buyers', authenticateToken, requireTenant, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const digits = q.replace(/\D/g, '');
    res.json(await prisma.buyer.findMany({
        where: {
            tenantId: req.user.tenantId,
            ...(q && { OR: [{ businessName: { contains: q, mode: 'insensitive' } }, ...(digits ? [{ ntnCnic: { startsWith: digits } }] : [])] }),
        },
        orderBy: { businessName: 'asc' },
        take: q ? 20 : 1000,
    }));
});

app.post('/api/buyers', authenticateToken, requireTenant, async (req, res) => {
    const d = buyerData(req.body || {});
    const tenantId = req.user.tenantId;
    try {
        if (req.body.id) {
            const { count } = await prisma.buyer.updateMany({ where: { id: String(req.body.id), tenantId }, data: d });
            if (!count) throw new HttpError(404, 'Buyer not found.');
            return res.json(await prisma.buyer.findUnique({ where: { id: String(req.body.id) } }));
        }
        res.json(await saveBuyer(tenantId, d));
    } catch (err) {
        if (err.code === 'P2002') throw new HttpError(400, `Another saved buyer already has NTN/CNIC ${d.ntnCnic}.`);
        throw err;
    }
});

app.delete('/api/buyers/:id', authenticateToken, requireTenant, async (req, res) => {
    const { count } = await prisma.buyer.deleteMany({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!count) throw new HttpError(404, 'Buyer not found.');
    res.json({ deleted: true });
});

// ---------- Errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`FBR billing app on http://localhost:${PORT}${process.env.FBR_MOCK === 'true' ? '  (FBR_MOCK on — nothing is sent to FBR)' : ''}`);
});
