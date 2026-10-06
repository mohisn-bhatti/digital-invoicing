require('dotenv').config();
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const { authenticateToken, requireRole, requireTenant, signToken, signWorkspaceToken } = require('./src/auth');
const { encrypt, decrypt, mask } = require('./src/crypto');
const { calcInvoice } = require('./src/tax');
const fbr = require('./src/fbr');
const hs = require('./src/hscodes');
const annexC = require('./src/annexc');
const onboarding = require('./src/onboarding');
const importer = require('./src/importer');
const { createAudit } = require('./src/audit');
const { BUSINESS_ACTIVITIES, SECTORS } = require('./src/activityScenarios');
const { SCENARIOS, PROVINCES, UOMS, RATES } = require('./src/scenarios');

for (const k of ['DATABASE_URL', 'JWT_SECRET', 'ENCRYPTION_KEY']) {
    if (!process.env[k]) {
        console.error(`Missing ${k} in .env (see .env.example)`);
        process.exit(1);
    }
}

const app = express();
const prisma = new PrismaClient();
const audit = createAudit(prisma);

// Proxies in front of the app: Render = 1; Vercel rewrite → Render = 2. Needed so req.ip is the visitor's IP.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.use('/api/import', express.json({ limit: '10mb' })); // spreadsheet rows
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

// What a client (and its receipts) may see: no token, no IRIS profile
function clientTenant(t) {
    return {
        companyName: t.companyName,
        sellerNtnCnic: t.sellerNtnCnic,
        sellerBusinessName: t.sellerBusinessName,
        sellerProvince: t.sellerProvince,
        sellerAddress: t.sellerAddress,
        sellerStrn: t.sellerStrn,
        softwareRegNo: t.softwareRegNo,
        fbrEnv: t.fbrEnv,
        furtherTaxRate: Number(t.furtherTaxRate),
        cnicRequiredAbove: CNIC_REQUIRED_ABOVE,
        // Ready = the client may file (same rule as assertCanInvoice, minus the sandbox check)
        ready: Boolean(sellerReady(t) && (t.fbrTokenEnc || process.env.FBR_MOCK === 'true')),
    };
}

// Full view for the super admin
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
        businessActivities: t.businessActivities,
        sector: t.sector,
        invoiceNumberFormat: t.invoiceNumberFormat,
        softwareRegNo: t.softwareRegNo,
        authLetterRef: t.authLetterRef,
        authLetterAt: t.authLetterAt,
        furtherTaxRate: Number(t.furtherTaxRate),
        fbrTokenMasked: t.fbrTokenEnc ? mask(decrypt(t.fbrTokenEnc)) : '',
    };
}

// Clients can't file in SANDBOX: test invoices are the admin's job (via Open workspace)
function assertCanInvoice(req, tenant) {
    if (!sellerReady(tenant) || !tenant.fbrTokenEnc && process.env.FBR_MOCK !== 'true') {
        throw new HttpError(403, 'Your FBR setup is not complete yet. Please contact your administrator.');
    }
    if (tenant.fbrEnv === 'SANDBOX' && !req.user.impersonatedBy) {
        throw new HttpError(403, 'Your account is still being tested with FBR. Invoicing opens when your administrator switches it live.');
    }
}

function sellerReady(t) {
    return t.sellerNtnCnic && t.sellerBusinessName && t.sellerProvince && t.sellerAddress;
}

// ---------- Website pages ----------
// "/" is the Raseed landing page (public/index.html); the app itself lives at /app
const page = file => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/app', page('app.html'));
app.get('/contact', page('contact.html'));

// ---------- Public website API (no login) ----------
app.get('/api/public/site', (req, res) => {
    res.json({
        name: 'Raseed',
        whatsapp: (process.env.CONTACT_WHATSAPP || '').replace(/\D/g, ''), // e.g. 923001234567
        phone: process.env.CONTACT_PHONE || '',
        email: process.env.CONTACT_EMAIL || '',
        city: process.env.CONTACT_CITY || '',
    });
});

// Contact form → Lead. Simple per-IP limit + a hidden "website" field that only bots fill in.
const contactHits = new Map();
const BUSINESS_TYPES = ['Wholesale / Distribution', 'Manufacturer', 'Retail', 'Pharmacy', 'Restaurant', 'Service provider', 'Importer / Exporter', 'Other'];
const INTERESTS = ['Single invoices', 'Bulk import from Excel', 'Both', 'Not sure'];
app.post('/api/public/contact', async (req, res) => {
    const b = req.body || {};
    const now = Date.now(), recent = (contactHits.get(req.ip) || []).filter(t => now - t < 3600000);
    if (contactHits.size > 5000) for (const [ip, ts] of contactHits) if (!ts.some(t => now - t < 3600000)) contactHits.delete(ip);
    if (recent.length >= 5) throw new HttpError(429, 'Too many messages from this connection. Please try again in an hour, or WhatsApp us.');
    contactHits.set(req.ip, [...recent, now]);
    if (b.website) return res.json({ ok: true }); // honeypot: pretend success
    const clean = (v, n) => String(v ?? '').trim().slice(0, n);
    const lead = {
        name: clean(b.name, 100), phone: clean(b.phone, 30), email: clean(b.email, 120).toLowerCase(),
        businessName: clean(b.businessName, 150), city: clean(b.city, 60),
        businessType: BUSINESS_TYPES.includes(b.businessType) ? b.businessType : '',
        interest: INTERESTS.includes(b.interest) ? b.interest : '',
        message: clean(b.message, 2000), ip: req.ip,
    };
    if (lead.name.length < 2) throw new HttpError(400, 'Please enter your name.');
    if (lead.phone.replace(/\D/g, '').length < 10) throw new HttpError(400, 'Please enter a valid phone number.');
    if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) throw new HttpError(400, 'Please enter a valid email, or leave it empty.');
    const saved = await prisma.lead.create({ data: lead });
    await audit({ ip: req.ip }, { tenantId: null, userEmail: lead.email || lead.phone, action: 'lead.create', entityType: 'Lead', entityId: saved.id, summary: `Website enquiry from ${lead.name}${lead.businessName ? ` (${lead.businessName})` : ''}` });
    res.json({ ok: true });
});

// ---------- Auth ----------
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) throw new HttpError(400, 'Email and password are required.');
    const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase().trim() }, include: { tenant: true } });
    if (!user || !(await bcrypt.compare(String(password), user.password))) {
        await audit({ ip: req.ip }, {
            tenantId: user?.tenantId ?? null, userEmail: String(email).toLowerCase().trim(),
            action: 'auth.login_failed', summary: user ? 'Wrong password' : 'Unknown email',
        });
        throw new HttpError(400, 'Invalid email or password.');
    }
    await audit({ ip: req.ip, user }, { action: 'auth.login', summary: 'Logged in' });
    res.json({
        token: signToken(user),
        role: user.role,
        companyName: user.tenant ? user.tenant.companyName : 'Super Admin',
    });
});

app.post('/api/auth/logout', authenticateToken, async (req, res) => {
    await audit(req, { action: 'auth.logout', summary: 'Logged out' });
    res.json({ ok: true });
});

// Static lists the UI needs (scenarios, fallback dropdown values)
app.get('/api/meta', authenticateToken, (req, res) => {
    res.json({
        scenarios: SCENARIOS, provinces: PROVINCES, uoms: UOMS, rates: RATES, mock: process.env.FBR_MOCK === 'true',
        debitReasons: DEBIT_REASONS, editWindowHours: IRIS_EDIT_WINDOW_HOURS, debitNoteMaxDays: DEBIT_NOTE_MAX_DAYS,
        businessActivities: BUSINESS_ACTIVITIES, sectors: SECTORS,
    });
});

// ---------- Super admin (minimal: list + create tenants) ----------
app.get('/api/admin/clients', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const tenants = await prisma.tenant.findMany({
        orderBy: { createdAt: 'desc' },
        include: { users: { select: { email: true } }, _count: { select: { invoices: true } } },
    });
    const month = todayPKT().slice(0, 7);
    const out = await Promise.all(tenants.map(async t => {
        const [ob, monthAgg, last, attention] = await Promise.all([
            onboarding.checklist(prisma, t),
            prisma.invoice.aggregate({
                where: { tenantId: t.id, status: 'SUBMITTED', fbrEnv: t.fbrEnv, invoiceDate: { startsWith: month } },
                _count: { _all: true }, _sum: { totalAmount: true, totalST: true },
            }),
            prisma.invoice.findFirst({ where: { tenantId: t.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
            prisma.invoice.count({ where: { tenantId: t.id, status: { in: ['FAILED', 'UNCERTAIN'] } } }),
        ]);
        return {
            ...publicTenant(t),
            emails: t.users.map(u => u.email),
            invoiceCount: t._count.invoices,
            createdAt: t.createdAt,
            onboarding: { done: ob.done, total: ob.total, scenariosPassed: ob.scenariosPassed, scenariosAssigned: ob.scenariosAssigned },
            thisMonth: { month, invoices: monthAgg._count._all, total: Number(monthAgg._sum.totalAmount || 0), salesTax: Number(monthAgg._sum.totalST || 0) },
            needsAttention: attention,
            lastInvoiceAt: last?.createdAt || null,
        };
    }));
    res.json(out);
});

app.get('/api/admin/clients/:id/onboarding', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!t) throw new HttpError(404, 'Client not found.');
    res.json(await onboarding.checklist(prisma, t));
});

app.get('/api/admin/clients/:id/annex-c', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    await sendAnnexC(req.params.id, req.query, res, req);
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
    await audit(req, { tenantId: tenant.id, action: 'admin.client_create', entityType: 'Tenant', entityId: tenant.id, summary: `Client "${tenant.companyName}" created with login ${email}` });
    res.json({ success: true, tenantId: tenant.id });
});

// Open a client's workspace (e.g. to run the sandbox scenarios). Returns a 2-hour client token for the admin.
app.post('/api/admin/clients/:id/workspace', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!t) throw new HttpError(404, 'Client not found.');
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id } });
    await audit(req, { tenantId: t.id, action: 'admin.workspace_open', entityType: 'Tenant', entityId: t.id, summary: `Admin opened the workspace of "${t.companyName}"` });
    res.json({ token: signWorkspaceToken(admin, t.id), companyName: t.companyName });
});

// Website enquiries
app.get('/api/admin/leads', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const status = String(req.query.status || '');
    res.json(await prisma.lead.findMany({ where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 200 }));
});
app.patch('/api/admin/leads/:id', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const data = {};
    if (req.body?.status !== undefined) {
        if (!['NEW', 'CONTACTED', 'CLIENT', 'CLOSED'].includes(req.body.status)) throw new HttpError(400, 'Unknown status.');
        data.status = req.body.status;
    }
    if (req.body?.notes !== undefined) data.notes = String(req.body.notes).slice(0, 2000);
    const lead = await prisma.lead.update({ where: { id: req.params.id }, data }).catch(() => null);
    if (!lead) throw new HttpError(404, 'Lead not found.');
    await audit(req, { tenantId: null, action: 'lead.update', entityType: 'Lead', entityId: lead.id, summary: `Lead "${lead.name}" → ${lead.status}` });
    res.json(lead);
});

app.get('/api/admin/egress-ip', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    res.json(await fbr.egressIp());
});

// ---------- Client settings ----------
// Read-only for clients; only the super admin changes FBR settings
app.get('/api/client/settings', authenticateToken, requireTenant, async (req, res) => {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    res.json({ ...clientTenant(t), workspace: Boolean(req.user.impersonatedBy) });
});

app.get('/api/admin/clients/:id/settings', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!t) throw new HttpError(404, 'Client not found.');
    res.json(publicTenant(t));
});

const SETTING_LABELS = {
    sellerNtnCnic: 'Seller NTN', sellerStrn: 'STRN', sellerBusinessName: 'Business name', sellerProvince: 'Province',
    sellerAddress: 'Address', fbrEnv: 'Environment', furtherTaxRate: 'Further tax %', businessActivities: 'Business nature', sector: 'Sector',
    invoiceNumberFormat: 'Invoice number format', softwareRegNo: 'Software reg. no.', authLetterRef: 'Authorization letter ref', authLetterAt: 'Authorization letter date',
};
app.put('/api/admin/clients/:id/settings', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const tenantId = req.params.id;
    if (!(await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) throw new HttpError(404, 'Client not found.');
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
    if (b.invoiceNumberFormat !== undefined) {
        const f = String(b.invoiceNumberFormat).trim();
        if (!/\{N+\}/.test(f) || f.length > 40) throw new HttpError(400, 'Invoice number format must contain {NNNN} (the running number), e.g. INV-{YYYY}-{NNNN}.');
        data.invoiceNumberFormat = f;
    }
    if (b.softwareRegNo !== undefined) data.softwareRegNo = String(b.softwareRegNo).trim().slice(0, 60);
    if (b.authLetterRef !== undefined) data.authLetterRef = String(b.authLetterRef).trim().slice(0, 100);
    if (b.authLetterAt !== undefined) {
        if (b.authLetterAt && !/^\d{4}-\d{2}-\d{2}$/.test(b.authLetterAt)) throw new HttpError(400, 'Authorization letter date must be YYYY-MM-DD.');
        data.authLetterAt = b.authLetterAt ? new Date(b.authLetterAt + 'T00:00:00+05:00') : null;
    }
    if (b.businessActivities !== undefined) {
        const list = Array.isArray(b.businessActivities) ? [...new Set(b.businessActivities.map(String))] : [];
        if (list.some(a => !BUSINESS_ACTIVITIES.includes(a))) throw new HttpError(400, 'Unknown business nature.');
        data.businessActivities = list;
    }
    if (b.sector !== undefined) {
        if (b.sector && !SECTORS.includes(b.sector)) throw new HttpError(400, 'Unknown sector.');
        data.sector = String(b.sector);
    }
    // Empty token field = keep existing token
    if (b.fbrToken) data.fbrTokenEnc = encrypt(String(b.fbrToken).trim());

    const before = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const t = await prisma.tenant.update({ where: { id: tenantId }, data });
    const show = v => Array.isArray(v) ? v.join(', ') : v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '');
    const changed = {};
    for (const [k, label] of Object.entries(SETTING_LABELS)) {
        if (k in data && show(before[k]) !== show(t[k])) changed[label] = [show(before[k]), show(t[k])];
    }
    if (data.fbrTokenEnc) changed['PRAL token'] = ['(hidden)', '(replaced)']; // never log the token itself
    if (Object.keys(changed).length) {
        await audit(req, {
            tenantId, action: 'settings.update', entityType: 'Tenant', entityId: t.id,
            summary: `Settings changed: ${Object.keys(changed).join(', ')}${changed.Environment ? ` (now ${t.fbrEnv})` : ''}`,
            details: changed,
        });
    }
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

app.post('/api/admin/clients/:id/hs-sync', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!t) throw new HttpError(404, 'Client not found.');
    if (!t.fbrTokenEnc) throw new HttpError(400, 'Save your PRAL token first.');
    if (process.env.FBR_MOCK === 'true') throw new HttpError(400, 'FBR_MOCK is on; turn it off to sync from FBR.');
    const n = await hs.syncFromFbr(prisma, tenantToken(t));
    if (n === null) throw new HttpError(502, 'Could not get the HS code list from FBR. Check the token and IP whitelisting.');
    await audit(req, { tenantId: null, action: 'hs.sync', summary: `Synced ${n} HS codes from FBR (token of ${t.companyName})` });
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
// Same wording and order as the IRIS drop-down (CA Q&A #2)
const DEBIT_REASONS = ['Cancellation of supply', 'Goods returned', 'Change in price', 'Change in quantity', 'Others'];
// Buyer CNIC/NTN is mandatory for B2B and for consumer invoices above this value (STA s.23(1)(b), SRO 1006(I)/2021)
const CNIC_REQUIRED_ABOVE = 100000;
const FBR_NO = /^\d{7,13}DI\d{8,20}$/;
const ACTIVE_STATUSES = ['QUEUED', 'SUBMITTING', 'SUBMITTED', 'UNCERTAIN']; // count towards the original invoice's limits
// Automatic retries while FBR is down: 30s, 2m, 10m, 30m, then hourly. Rule 150XC: offline invoices must reach FBR
// within 24 hours, so after 24h of failed tries the invoice is FAILED and needs attention.
const RETRY_BACKOFF_SEC = [30, 120, 600, 1800];
const RETRY_EVERY_SEC = 3600;
const OFFLINE_LIMIT_MS = 24 * 3600 * 1000;
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
// actor: the request that triggered this attempt, or null for the background sender
async function submitInvoice(invoiceId, tenant, actor = null) {
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

    // FBR down before anything was recorded: "Offline Mode" (Rule 150XC) — queue and retry for up to 24 hours
    let data;
    if (result.ok) {
        data = { status: 'SUBMITTED', fbrInvoiceNumber: result.invoiceNumber, submittedAt: new Date(), fbrRequest: payload, fbrResponse: result.raw, errorMessage: null, nextAttemptAt: null };
    } else if (result.transient) {
        const since = inv.offlineSince || new Date();
        const expired = Date.now() - since.getTime() >= OFFLINE_LIMIT_MS;
        const backoff = RETRY_BACKOFF_SEC[inv.submitAttempts - 1] ?? RETRY_EVERY_SEC;
        const next = new Date(Math.min(Date.now() + backoff * 1000, since.getTime() + OFFLINE_LIMIT_MS));
        data = expired
            ? { status: 'FAILED', offlineMode: true, offlineSince: since, nextAttemptAt: null, fbrRequest: payload, fbrResponse: result.raw ?? undefined,
                errorMessage: `${result.error} Not filed within 24 hours of going offline (Rule 150XC) — check FBR/IRIS and use Retry.` }
            : { status: 'QUEUED', offlineMode: true, offlineSince: since, nextAttemptAt: next, fbrRequest: payload, fbrResponse: result.raw ?? undefined,
                errorMessage: `Offline mode: ${result.error} Retrying automatically (next at ${next.toLocaleTimeString('en-PK', { timeZone: 'Asia/Karachi' })}).` };
    } else {
        data = { status: result.uncertain ? 'UNCERTAIN' : 'FAILED', nextAttemptAt: null, fbrRequest: payload, fbrResponse: result.raw ?? undefined, errorMessage: result.error };
    }
    const updated = await prisma.invoice.update({ where: { id: inv.id }, data, include: ITEMS });
    const outcome = { SUBMITTED: 'filed with FBR', QUEUED: 'queued for retry (FBR unreachable)', FAILED: 'rejected / failed', UNCERTAIN: 'uncertain — check IRIS' }[updated.status];
    await audit(actor, {
        tenantId: tenant.id, action: `invoice.${updated.status.toLowerCase()}`, entityType: 'Invoice', entityId: updated.id,
        summary: `Invoice ${updated.invoiceNo || '#' + updated.localNo} ${outcome}${updated.offlineMode && updated.status === 'SUBMITTED' ? ' (offline-mode invoice)' : ''}${updated.fbrInvoiceNumber ? ` — ${updated.fbrInvoiceNumber}` : ''} (attempt ${updated.submitAttempts})`,
        details: updated.status === 'SUBMITTED' ? { fbrInvoiceNumber: updated.fbrInvoiceNumber } : { error: updated.errorMessage },
    });
    if (result.ok) await rememberBuyer(tenant.id, updated).catch(err => console.error('save buyer failed:', err.message));
    return updated;
}

// Take the SUBMITTING lock atomically; returns false if another submission holds it or the state doesn't allow it
async function acquireSubmitLock(id, tenantId, allowUncertain) {
    const or = [{ status: { in: ['DRAFT', 'FAILED', 'QUEUED'] } }];
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
            nextAttemptAt: true, importRef: true, batchId: true, invoiceNo: true, offlineMode: true,
            cancelledAt: true, cancelNote: true,
        },
    });
    res.json(invoices.map(withStatus));
});

// Sales invoices with filters: from/to (invoice date, YYYY-MM-DD), status, q (internal no., FBR no., buyer), page
app.get('/api/invoices/search', authenticateToken, requireTenant, async (req, res) => {
    const q = req.query, where = { tenantId: req.user.tenantId };
    const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    if (isDate(q.from) || isDate(q.to)) where.invoiceDate = { ...(isDate(q.from) && { gte: q.from }), ...(isDate(q.to) && { lte: q.to }) };
    if (q.status === 'ATTENTION') where.status = { in: ['FAILED', 'UNCERTAIN'] };
    else if (q.status) where.status = String(q.status);
    if (q.type) where.invoiceType = String(q.type);
    const text = String(q.q || '').trim();
    if (text) where.OR = [
        { invoiceNo: { contains: text, mode: 'insensitive' } },
        { fbrInvoiceNumber: { contains: text, mode: 'insensitive' } },
        { buyerBusinessName: { contains: text, mode: 'insensitive' } },
        { buyerNtnCnic: { startsWith: text.replace(/\D/g, '') || text } },
        { importRef: { contains: text, mode: 'insensitive' } },
    ];
    const limit = Math.min(Math.max(Number(q.limit) || 25, 5), 100);
    const page = Math.max(Number(q.page) || 1, 1);
    const { fbrEnv } = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId }, select: { fbrEnv: true } });
    const [total, rows, filed] = await Promise.all([
        prisma.invoice.count({ where }),
        prisma.invoice.findMany({
            where, orderBy: [{ invoiceDate: 'desc' }, { localNo: 'desc' }], skip: (page - 1) * limit, take: limit,
            select: {
                id: true, localNo: true, invoiceNo: true, fbrInvoiceNumber: true, status: true, fbrEnv: true, invoiceDate: true,
                scenarioId: true, buyerBusinessName: true, buyerNtnCnic: true, totalExclST: true, totalST: true, totalAmount: true,
                errorMessage: true, createdAt: true, lastAttemptAt: true, submitAttempts: true, invoiceType: true, invoiceRefNo: true,
                submittedAt: true, nextAttemptAt: true, importRef: true, offlineMode: true, cancelNote: true,
            },
        }),
        // totals of what was actually filed with FBR in this filter
        prisma.invoice.aggregate({ where: { ...where, status: 'SUBMITTED', fbrEnv }, _count: { _all: true }, _sum: { totalExclST: true, totalST: true, totalFurtherTax: true, totalAmount: true } }),
    ]);
    res.json({
        rows: rows.map(withStatus), total, page, pages: Math.max(1, Math.ceil(total / limit)),
        filed: { fbrEnv, count: filed._count._all, totalExclST: Number(filed._sum.totalExclST || 0), totalST: Number(filed._sum.totalST || 0),
            totalFurtherTax: Number(filed._sum.totalFurtherTax || 0), totalAmount: Number(filed._sum.totalAmount || 0) },
    });
});

// Client dashboard: today / this month, and what needs attention
app.get('/api/client/dashboard', authenticateToken, requireTenant, async (req, res) => {
    const tenantId = req.user.tenantId, today = todayPKT(), month = today.slice(0, 7);
    const { fbrEnv } = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { fbrEnv: true } });
    // Only the current environment: sandbox test invoices are not sales
    const sum = where => prisma.invoice.aggregate({ where: { tenantId, status: 'SUBMITTED', fbrEnv, ...where }, _count: { _all: true }, _sum: { totalAmount: true, totalST: true } });
    const [d, m, counts, recent] = await Promise.all([
        sum({ invoiceDate: today }),
        sum({ invoiceDate: { startsWith: month } }),
        prisma.invoice.groupBy({ by: ['status'], where: { tenantId }, _count: { _all: true } }),
        prisma.invoice.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 6,
            select: { id: true, invoiceNo: true, localNo: true, buyerBusinessName: true, totalAmount: true, status: true, invoiceDate: true, lastAttemptAt: true } }),
    ]);
    const n = Object.fromEntries(counts.map(c => [c.status, c._count._all]));
    const pack = a => ({ invoices: a._count._all, total: Number(a._sum.totalAmount || 0), salesTax: Number(a._sum.totalST || 0) });
    res.json({ fbrEnv, today: pack(d), month: { ...pack(m), month }, attention: (n.FAILED || 0) + (n.UNCERTAIN || 0), queued: (n.QUEUED || 0) + (n.SUBMITTING || 0), recent: recent.map(withStatus) });
});

app.get('/api/invoices/:id', authenticateToken, requireTenant, async (req, res) => {
    const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, include: ITEMS });
    if (!inv) throw new HttpError(404, 'Invoice not found.');
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    res.json({ invoice: withStatus(inv), seller: clientTenant(t) });
});

class InvoiceInputError extends HttpError {
    constructor(message) { super(400, message); }
}

// Validate an invoice request and compute taxes. Returns the Invoice fields (no ids/locks).
// pendingDebit: { [fbrInvoiceNo]: { value, st } } — debit notes earlier in the same import batch.
async function prepareInvoice(tenant, b, pendingDebit = null) {
    const fail = msg => { throw new InvoiceInputError(msg); };
    const invoiceType = b.invoiceType === 'Debit Note' ? 'Debit Note' : 'Sale Invoice';
    const buyerRegistrationType = b.buyerRegistrationType === 'Registered' ? 'Registered' : 'Unregistered';
    const buyerNtnCnic = String(b.buyerNtnCnic || '').replace(/\D/g, '');
    const endConsumer = buyerRegistrationType === 'Unregistered' && b.endConsumer === true;
    const buyerNonAtl = buyerRegistrationType === 'Registered' && b.buyerNonAtl === true;
    if (buyerRegistrationType === 'Registered' && !NTN_LENGTHS.includes(buyerNtnCnic.length)) {
        fail('Registered buyer needs NTN (7 or 9 digits) or CNIC (13 digits).');
    }
    if (buyerNtnCnic && !NTN_LENGTHS.includes(buyerNtnCnic.length)) fail('Buyer NTN must be 7 or 9 digits, or CNIC 13 digits.');
    const isDebit = invoiceType === 'Debit Note';
    const invoiceRefNo = isDebit ? String(b.invoiceRefNo || '').trim().toUpperCase() : '';
    if (b.invoiceDate && !/^\d{4}-\d{2}-\d{2}$/.test(b.invoiceDate)) fail('Invoice date must be YYYY-MM-DD.');
    const invoiceDate = b.invoiceDate || todayPKT();
    const [yy, mm, dd] = invoiceDate.split('-').map(Number), dt = new Date(Date.UTC(yy, mm - 1, dd));
    if (dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) fail('Invoice date is not a real date.');
    const reason = isDebit ? String(b.reason || '').trim() : '';
    const reasonRemarks = isDebit ? String(b.reasonRemarks || '').trim().slice(0, 500) : '';
    if (isDebit) {
        if (!invoiceRefNo) fail('Debit note needs the original FBR invoice number.');
        if (!FBR_NO.test(invoiceRefNo)) fail('Original FBR invoice number looks wrong (e.g. 7000007DI1747119701593).');
        if (!DEBIT_REASONS.includes(reason)) fail('Choose a reason for the debit note.');
        if (reason === 'Others' && !reasonRemarks) fail('Write remarks when the reason is "Others".');
    }

    const scenarioId = tenant.fbrEnv === 'SANDBOX' ? String(b.scenarioId || '') : null;
    if (tenant.fbrEnv === 'SANDBOX' && !SCENARIOS.some(s => s.id === scenarioId)) fail('Select a sandbox scenario (SN001…SN028).');

    let calc;
    try {
        calc = calcInvoice(b.items, { buyerRegistrationType, endConsumer, buyerNonAtl, furtherTaxRate: Number(tenant.furtherTaxRate) });
    } catch (err) {
        fail(err.message);
    }
    // DI Rules #24 / Q&A #16: CNIC/NTN mandatory for B2B, and for consumer sales above Rs 100,000
    if (!buyerNtnCnic && buyerRegistrationType === 'Unregistered' && !endConsumer) {
        fail('An unregistered business buyer (B2B) needs a CNIC or NTN.');
    }
    if (!buyerNtnCnic && calc.totals.totalAmount > CNIC_REQUIRED_ABOVE) {
        fail(`Invoices above Rs ${CNIC_REQUIRED_ABOVE.toLocaleString('en-PK')} need the buyer's CNIC or NTN.`);
    }

    if (isDebit) {
        // When the original was filed from this app, apply FBR's debit-note rules up front (else FBR checks them)
        const refInvoice = await prisma.invoice.findFirst({ where: { tenantId: tenant.id, fbrInvoiceNumber: invoiceRefNo } });
        if (refInvoice) {
            if (refInvoice.invoiceType !== 'Sale Invoice') fail('A debit note must refer to a sale invoice.');
            if (refInvoice.status === 'CANCELLED') fail('The original invoice was cancelled; a debit note against it is not allowed.');
            const age = daysBetween(refInvoice.invoiceDate, invoiceDate);
            if (age < 0) fail(`Debit note date can't be before the original invoice date (${refInvoice.invoiceDate}).`);
            if (age > DEBIT_NOTE_MAX_DAYS) fail(`A debit note is only allowed within ${DEBIT_NOTE_MAX_DAYS} days of the original invoice (${refInvoice.invoiceDate}).`);
            if (refInvoice.buyerNtnCnic && refInvoice.buyerNtnCnic !== buyerNtnCnic) {
                fail(`Buyer must be the same as on the original invoice (NTN/CNIC ${refInvoice.buyerNtnCnic}).`);
            }
            const prior = await prisma.invoice.aggregate({
                where: { tenantId: tenant.id, invoiceType: 'Debit Note', invoiceRefNo, status: { in: ACTIVE_STATUSES } },
                _sum: { totalExclST: true, totalST: true },
            });
            const pending = pendingDebit?.[invoiceRefNo] || { value: 0, st: 0 };
            const usedValue = Number(prior._sum.totalExclST || 0) + pending.value + calc.totals.totalExclST;
            const usedST = Number(prior._sum.totalST || 0) + pending.st + calc.totals.totalST;
            if (usedValue > Number(refInvoice.totalExclST) + 0.005) {
                fail(`Debit notes would total ${usedValue.toFixed(2)} (value excl. ST), more than the original ${Number(refInvoice.totalExclST).toFixed(2)}.`);
            }
            if (usedST > Number(refInvoice.totalST) + 0.005) {
                fail(`Debit notes would total ${usedST.toFixed(2)} sales tax, more than the original ${Number(refInvoice.totalST).toFixed(2)}.`);
            }
        }
        if (pendingDebit) {
            const p = (pendingDebit[invoiceRefNo] ||= { value: 0, st: 0 });
            p.value += calc.totals.totalExclST; p.st += calc.totals.totalST;
        }
    }

    return {
        fbrEnv: tenant.fbrEnv,
        invoiceType, invoiceDate, invoiceRefNo, reason, reasonRemarks, scenarioId,
        buyerNtnCnic,
        buyerBusinessName: String(b.buyerBusinessName || '').trim().slice(0, 200) || 'Walk-in Customer',
        buyerProvince: String(b.buyerProvince || '').trim() || tenant.sellerProvince,
        buyerAddress: String(b.buyerAddress || '').trim().slice(0, 300) || tenant.sellerAddress,
        buyerRegistrationType, endConsumer, buyerNonAtl,
        ...calc.totals,
        items: { create: calc.lines },
    };
}

// "INV-{YYYY}-{NNNN}" + 42 on 2026-10-06 → "INV-2026-0042" ({YY}, {MM} also allowed)
function formatInvoiceNo(format, seq, invoiceDate) {
    const [y, m] = invoiceDate.split('-');
    return format.replace(/\{YYYY\}/g, y).replace(/\{YY\}/g, y.slice(2)).replace(/\{MM\}/g, m)
        .replace(/\{(N+)\}/g, (_, n) => String(seq).padStart(n.length, '0'));
}

// Insert with the next per-tenant number. extra: clientRequestId, status, batchId, importRef, attempts…
function createInvoice(tenant, data, extra) {
    return prisma.$transaction(async tx => {
        const { invoiceSeq, invoiceNumberFormat } = await tx.tenant.update({
            where: { id: tenant.id },
            data: { invoiceSeq: { increment: 1 } },
            select: { invoiceSeq: true, invoiceNumberFormat: true },
        });
        const invoiceNo = formatInvoiceNo(invoiceNumberFormat, invoiceSeq, data.invoiceDate);
        return tx.invoice.create({ data: { tenantId: tenant.id, localNo: invoiceSeq, invoiceNo, ...data, ...extra } });
    });
}

app.post('/api/invoices', authenticateToken, requireTenant, async (req, res) => {
    const b = req.body || {};
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    assertCanInvoice(req, tenant);

    // Idempotency: the browser sends one id per form; a resent request returns the first result
    const clientRequestId = b.clientRequestId ? String(b.clientRequestId) : null;
    if (clientRequestId && !/^[A-Za-z0-9-]{8,64}$/.test(clientRequestId)) throw new HttpError(400, 'Invalid clientRequestId.');
    const findExisting = () => clientRequestId
        ? prisma.invoice.findUnique({ where: { tenantId_clientRequestId: { tenantId: tenant.id, clientRequestId } }, include: ITEMS })
        : null;
    const existing = await findExisting();
    if (existing) return res.json({ invoice: withStatus(existing), seller: clientTenant(tenant), duplicate: true });

    const data = await prepareInvoice(tenant, b);

    let created;
    try {
        // created already holding the SUBMITTING lock
        created = await createInvoice(tenant, data, { clientRequestId, status: 'SUBMITTING', submitAttempts: 1, lastAttemptAt: new Date() });
    } catch (err) {
        // Same clientRequestId arrived twice at the same moment: return the one that won
        if (err.code === 'P2002' && clientRequestId) {
            const winner = await findExisting();
            if (winner) return res.json({ invoice: withStatus(winner), seller: clientTenant(tenant), duplicate: true });
        }
        throw err;
    }

    await audit(req, {
        action: 'invoice.create', entityType: 'Invoice', entityId: created.id,
        summary: `${created.invoiceType} #${created.localNo} created — ${created.buyerBusinessName}, Rs ${Number(created.totalAmount).toFixed(2)}${created.invoiceRefNo ? `, against ${created.invoiceRefNo}` : ''}`,
    });
    const invoice = await submitInvoice(created.id, tenant, req);
    res.json({ invoice, seller: clientTenant(tenant) });
});

app.post('/api/invoices/:id/retry', authenticateToken, requireTenant, async (req, res) => {
    const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!inv) throw new HttpError(404, 'Invoice not found.');
    assertCanInvoice(req, await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } }));
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
    await audit(req, {
        action: 'invoice.retry', entityType: 'Invoice', entityId: inv.id,
        summary: `Invoice #${inv.localNo}: ${status === 'QUEUED' ? 'sent now' : status === 'UNCERTAIN' ? 'resubmitted after confirming it is not in IRIS' : 'retried'}`,
    });
    const invoice = await submitInvoice(inv.id, tenant, req);
    res.json({ invoice, seller: clientTenant(tenant) });
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
    await audit(req, { action: 'invoice.resolve', entityType: 'Invoice', entityId: inv.id, summary: `Invoice #${inv.localNo} marked filed (found in IRIS as ${fbrInvoiceNumber})` });
    await rememberBuyer(tenant.id, invoice).catch(() => {});
    res.json({ invoice: withStatus(invoice), seller: clientTenant(tenant) });
});

// Stop a queued invoice from being sent automatically
app.post('/api/invoices/:id/unqueue', authenticateToken, requireTenant, async (req, res) => {
    const { count } = await prisma.invoice.updateMany({
        where: { id: req.params.id, tenantId: req.user.tenantId, status: 'QUEUED' },
        data: { status: 'FAILED', nextAttemptAt: null, errorMessage: 'Stopped by user before sending to FBR.' },
    });
    if (!count) throw new HttpError(400, 'Only queued invoices can be stopped.');
    const inv = await prisma.invoice.findUnique({ where: { id: req.params.id }, select: { localNo: true } });
    await audit(req, { action: 'invoice.unqueue', entityType: 'Invoice', entityId: req.params.id, summary: `Invoice #${inv.localNo}: stopped before sending to FBR` });
    res.json({ stopped: true });
});

// ---------- Background sender ----------
// Sends QUEUED invoices (bulk imports, and retries while FBR is down) one at a time, oldest first.
// On Render free the process sleeps when idle; the queue resumes on the next request.
let queueBusy = false;
async function processQueue(max = 25) {
    if (queueBusy) return 0;
    queueBusy = true;
    let sent = 0;
    try {
        while (sent < max) {
            const next = await prisma.invoice.findFirst({
                where: { status: 'QUEUED', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
                orderBy: { createdAt: 'asc' },
                select: { id: true, tenantId: true },
            });
            if (!next) break;
            if (!(await acquireSubmitLock(next.id, next.tenantId, false))) continue; // another process took it
            let tenant;
            try {
                tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: next.tenantId } });
            } catch (err) { // nothing sent yet: put it back in the queue
                console.error('queue: tenant lookup failed:', err.message);
                await prisma.invoice.update({ where: { id: next.id }, data: { status: 'QUEUED', nextAttemptAt: new Date(Date.now() + 60000) } }).catch(() => {});
                continue;
            }
            try {
                await submitInvoice(next.id, tenant, null);
            } catch (err) {
                // FBR may have been called: leave it SUBMITTING so it turns UNCERTAIN (check IRIS) instead of resending
                console.error('queue: submit failed for', next.id, err.message);
            }
            sent++;
        }
    } catch (err) {
        console.error('queue error:', err.message);
    } finally {
        queueBusy = false;
    }
    return sent;
}
// Weekly HS/PCT code refresh from FBR (CA Q&A #13), using the first client token that works
async function weeklyHsSync() {
    if (process.env.FBR_MOCK === 'true') return;
    try {
        const last = (await hs.stats(prisma)).FBR?.updatedAt;
        if (last && Date.now() - new Date(last).getTime() < 7 * 86400000) return;
        const tenants = await prisma.tenant.findMany({ where: { fbrTokenEnc: { not: null } }, select: { fbrTokenEnc: true, companyName: true } });
        for (const t of tenants) {
            const n = await hs.syncFromFbr(prisma, tenantToken(t)).catch(() => null);
            if (n) { await audit(null, { tenantId: null, action: 'hs.sync', summary: `Weekly HS code sync: ${n} codes from FBR (token of ${t.companyName})` }); return; }
        }
    } catch (err) {
        console.error('weekly HS sync failed:', err.message);
    }
}
if (process.env.QUEUE_DISABLED !== 'true') {
    setTimeout(weeklyHsSync, 60000).unref();
    setInterval(weeklyHsSync, 6 * 3600 * 1000).unref();
}

const QUEUE_INTERVAL_MS = Number(process.env.QUEUE_INTERVAL_MS || 5000);
if (process.env.QUEUE_DISABLED !== 'true') setInterval(processQueue, QUEUE_INTERVAL_MS).unref();

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
    await audit(req, {
        action: 'invoice.cancel', entityType: 'Invoice', entityId: inv.id,
        summary: `Invoice #${inv.localNo} (${inv.fbrInvoiceNumber}) marked cancelled in IRIS${hours > IRIS_EDIT_WINDOW_HOURS ? ' — after the 72h window' : ''}${note ? `: ${note}` : ''}`,
    });
    res.json({ invoice: withStatus(await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id }, include: ITEMS })) });
});

// ---------- Bulk import (Excel/CSV) ----------
// Check every invoice in the file without saving anything
async function evaluateImport(tenant, rows) {
    const grouped = importer.groupRows(rows);
    if (grouped.errors.length) throw new HttpError(400, grouped.errors.join(' '));
    const pendingDebit = {};
    const results = [];
    for (const inv of grouped.invoices) {
        const r = { ref: inv.ref, rows: inv.rowNumbers, clientRequestId: inv.clientRequestId, body: inv.body, errors: [...inv.errors] };
        if (!r.errors.length) {
            const existing = await prisma.invoice.findUnique({
                where: { tenantId_clientRequestId: { tenantId: tenant.id, clientRequestId: inv.clientRequestId } },
                select: { localNo: true, status: true },
            });
            if (existing) {
                r.status = 'duplicate';
                r.note = `Already imported as invoice #${existing.localNo} (${existing.status}).`;
            } else {
                try {
                    r.data = await prepareInvoice(tenant, inv.body, pendingDebit);
                    r.status = 'ok';
                } catch (err) {
                    if (!(err instanceof InvoiceInputError)) throw err;
                    r.errors.push(err.message);
                }
            }
        }
        if (r.errors.length) r.status = 'error';
        results.push(r);
    }
    return { results, unknownHeaders: grouped.unknownHeaders };
}

function importSummary(results, unknownHeaders) {
    const sum = f => Math.round(results.filter(r => r.status === 'ok').reduce((a, r) => a + r.data[f], 0) * 100) / 100;
    return {
        invoices: results.length,
        ok: results.filter(r => r.status === 'ok').length,
        errors: results.filter(r => r.status === 'error').length,
        duplicates: results.filter(r => r.status === 'duplicate').length,
        totals: { totalExclST: sum('totalExclST'), totalST: sum('totalST'), totalFurtherTax: sum('totalFurtherTax'), totalAmount: sum('totalAmount') },
        unknownHeaders,
        list: results.map(r => ({
            ref: r.ref, rows: r.rows, status: r.status, errors: r.errors, note: r.note,
            date: r.body.invoiceDate, buyer: r.body.buyerBusinessName || (r.body.endConsumer ? 'Walk-in Customer' : ''),
            lines: r.body.items.length, total: r.data?.totalAmount ?? null,
        })),
    };
}

async function importTenant(req) {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    assertCanInvoice(req, tenant);
    return tenant;
}

app.get('/api/import/template', authenticateToken, requireTenant, async (req, res) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="invoice-import-template.csv"' });
    res.send(importer.templateCsv(tenant.fbrEnv === 'SANDBOX'));
});

app.post('/api/import/preview', authenticateToken, requireTenant, async (req, res) => {
    const tenant = await importTenant(req);
    const { results, unknownHeaders } = await evaluateImport(tenant, req.body?.rows);
    res.json(importSummary(results, unknownHeaders));
});

// Save the valid invoices as QUEUED; the background sender files them with FBR one by one
app.post('/api/import/commit', authenticateToken, requireTenant, async (req, res) => {
    const tenant = await importTenant(req);
    const { results, unknownHeaders } = await evaluateImport(tenant, req.body?.rows);
    const summary = importSummary(results, unknownHeaders);
    if (summary.errors && req.body?.skipInvalid !== true) {
        return res.status(400).json({ error: `${summary.errors} invoice(s) have errors. Fix them, or choose to send only the valid ones.`, ...summary });
    }
    const valid = results.filter(r => r.status === 'ok');
    if (!valid.length) throw new HttpError(400, 'Nothing new to send: every invoice in the file has errors or was already imported.');

    const batch = await prisma.importBatch.create({
        data: { tenantId: tenant.id, fileName: String(req.body?.fileName || 'import').slice(0, 200), invoiceCount: valid.length, skipped: summary.duplicates },
    });
    // Reserve one block of numbers so the file order is kept, then insert 20 at a time
    const { invoiceSeq: last, invoiceNumberFormat } = await prisma.tenant.update({
        where: { id: tenant.id }, data: { invoiceSeq: { increment: valid.length } }, select: { invoiceSeq: true, invoiceNumberFormat: true },
    });
    let queued = 0, raced = 0;
    for (let i = 0; i < valid.length; i += 20) {
        await Promise.all(valid.slice(i, i + 20).map(async (r, k) => {
            const seq = last - valid.length + 1 + i + k;
            try {
                await prisma.invoice.create({ data: {
                    tenantId: tenant.id, localNo: seq, invoiceNo: formatInvoiceNo(invoiceNumberFormat, seq, r.data.invoiceDate), ...r.data,
                    clientRequestId: r.clientRequestId, status: 'QUEUED', batchId: batch.id, importRef: r.ref.slice(0, 100),
                } });
                queued++;
            } catch (err) {
                if (err.code === 'P2002') { raced++; return; } // same file committed twice at once (leaves a gap in numbers)
                throw err;
            }
        }));
    }
    if (queued !== valid.length) await prisma.importBatch.update({ where: { id: batch.id }, data: { invoiceCount: queued, skipped: summary.duplicates + raced } });
    await audit(req, {
        action: 'import.commit', entityType: 'ImportBatch', entityId: batch.id,
        summary: `Imported "${batch.fileName}": ${queued} invoice(s) queued${summary.duplicates + raced ? `, ${summary.duplicates + raced} already imported` : ''}${summary.errors ? `, ${summary.errors} with errors skipped` : ''}`,
        details: { queued, skipped: summary.duplicates + raced, errorsSkipped: summary.errors },
    });
    processQueue().catch(() => {}); // start now instead of waiting for the next tick
    res.json({ batchId: batch.id, queued, skipped: summary.duplicates + raced, errorsSkipped: summary.errors });
});

app.get('/api/import/batches', authenticateToken, requireTenant, async (req, res) => {
    const batches = await prisma.importBatch.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { createdAt: 'desc' }, take: 20 });
    const counts = await prisma.invoice.groupBy({
        by: ['batchId', 'status'], where: { batchId: { in: batches.map(b => b.id) } }, _count: { _all: true },
    });
    res.json(batches.map(b => ({
        ...b,
        counts: Object.fromEntries(counts.filter(c => c.batchId === b.id).map(c => [c.status, c._count._all])),
    })));
});

app.get('/api/import/batches/:id', authenticateToken, requireTenant, async (req, res) => {
    const batch = await prisma.importBatch.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!batch) throw new HttpError(404, 'Import not found.');
    const invoices = await prisma.invoice.findMany({
        where: { batchId: batch.id }, orderBy: { localNo: 'asc' },
        select: { id: true, localNo: true, invoiceNo: true, importRef: true, status: true, errorMessage: true, fbrInvoiceNumber: true, totalAmount: true, lastAttemptAt: true, nextAttemptAt: true },
    });
    res.json({ batch, invoices: invoices.map(withStatus) });
});

// ---------- Activity log ----------
// Newest first; page with ?before=<ISO time of the last row>. format=csv exports (max 50,000 rows).
async function listAudit(where, query, res, req) {
    const q = String(query.q || '').trim();
    const w = { ...where };
    if (query.action) w.action = { startsWith: String(query.action) };
    if (q) w.OR = [{ summary: { contains: q, mode: 'insensitive' } }, { userEmail: { contains: q, mode: 'insensitive' } }];
    const range = query.month ? annexC.monthRange(String(query.month)) : null;
    if (query.month && !range) throw new HttpError(400, 'Month must be YYYY-MM.');
    const createdAt = {};
    if (range) { createdAt.gte = new Date(range.from + 'T00:00:00+05:00'); createdAt.lte = new Date(range.to + 'T23:59:59.999+05:00'); }
    if (query.before) { const d = new Date(String(query.before)); if (!Number.isNaN(d.getTime())) createdAt.lt = d; }
    if (Object.keys(createdAt).length) w.createdAt = createdAt;

    if (query.format === 'csv') {
        const rows = await prisma.auditLog.findMany({ where: w, orderBy: { createdAt: 'desc' }, take: 50000 });
        const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
        const lines = ['Time (PKT),User,Action,Summary,IP,Details'].concat(rows.map(r => [
            new Date(r.createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Karachi' }), r.userEmail, r.action, r.summary, r.ip, r.details ? JSON.stringify(r.details) : '',
        ].map(cell).join(',')));
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="activity-log${query.month ? '-' + query.month : ''}.csv"` });
        await audit(req, { tenantId: where.tenantId ?? null, action: 'report.audit_export', summary: `Activity log exported (${rows.length} entries)` });
        return res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
    }
    const limit = Math.min(Number(query.limit) || 50, 200);
    const rows = await prisma.auditLog.findMany({ where: w, orderBy: { createdAt: 'desc' }, take: limit + 1 });
    res.json({ entries: rows.slice(0, limit), more: rows.length > limit });
}

// Super admin: all clients (tenantId=... for one, tenantId=platform for admin-level entries)
app.get('/api/admin/audit', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const t = String(req.query.tenantId || '');
    await listAudit(t === 'platform' ? { tenantId: null } : t ? { tenantId: t } : {}, req.query, res, req);
});

// ---------- Reports ----------
// Annex-C for a month: one row per item of every invoice filed with FBR (SUBMITTED)
async function sendAnnexC(tenantId, query, res, req) {
    const range = annexC.monthRange(String(query.month || ''));
    if (!range) throw new HttpError(400, 'Choose a month (YYYY-MM).');
    const fbrEnv = query.env === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION';
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new HttpError(404, 'Client not found.');
    const invoices = await prisma.invoice.findMany({
        where: { tenantId: tenant.id, fbrEnv, status: 'SUBMITTED', invoiceDate: { gte: range.from, lte: range.to } },
        orderBy: [{ invoiceDate: 'asc' }, { localNo: 'asc' }],
        include: ITEMS,
    });
    const list = annexC.rows(invoices, tenant.sellerProvince);
    const sum = annexC.totals(list);
    if (query.format === 'csv') {
        const slug = tenant.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'client';
        const name = `annex-c-${slug}-${query.month}-${fbrEnv.toLowerCase()}.csv`;
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
        await audit(req, { tenantId: tenant.id, action: 'report.annex_c', summary: `Annex-C downloaded: ${query.month}, ${fbrEnv}, ${list.length} lines` });
        return res.send(annexC.toCsv(list, sum));
    }
    res.json({ month: query.month, fbrEnv, invoices: invoices.length, lines: list.length, totals: sum, rows: list.slice(0, 50) });
}

// ---------- Buyer check with FBR (STATL + Get_Reg_Type) ----------
// DI Rules #26: decide Registered/Unregistered and active (ATL) status from FBR, which drives further tax
app.get('/api/buyers/check', authenticateToken, requireTenant, async (req, res) => {
    const reg = String(req.query.ntn || '').replace(/\D/g, '');
    if (!NTN_LENGTHS.includes(reg.length)) throw new HttpError(400, 'Enter a 7/9-digit NTN or 13-digit CNIC.');
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    const r = await fbr.checkBuyer(reg, todayPKT(), tenantToken(t));
    res.json(r);
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
        let p;
        if (req.body.id) {
            const { count } = await prisma.product.updateMany({ where: { id: String(req.body.id), tenantId }, data: d });
            if (!count) throw new HttpError(404, 'Product not found.');
            p = await prisma.product.findUnique({ where: { id: String(req.body.id) } });
        } else {
            p = await prisma.product.upsert({ where: { tenantId_name: { tenantId, name: d.name } }, update: d, create: { ...d, tenantId } });
        }
        await audit(req, { action: 'product.save', entityType: 'Product', entityId: p.id, summary: `Product "${p.name}" saved (${p.hsCode}, ${p.rate}${p.unitPrice != null ? `, Rs ${p.unitPrice}` : ''})` });
        res.json(p);
    } catch (err) {
        if (err.code === 'P2002') throw new HttpError(400, `Another product is already named "${d.name}".`);
        throw err;
    }
});

app.delete('/api/products/:id', authenticateToken, requireTenant, async (req, res) => {
    const prod = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, select: { name: true } });
    const { count } = await prisma.product.deleteMany({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!count) throw new HttpError(404, 'Product not found.');
    await audit(req, { action: 'product.delete', entityType: 'Product', entityId: req.params.id, summary: `Product "${prod.name}" deleted` });
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
        let b;
        if (req.body.id) {
            const { count } = await prisma.buyer.updateMany({ where: { id: String(req.body.id), tenantId }, data: d });
            if (!count) throw new HttpError(404, 'Buyer not found.');
            b = await prisma.buyer.findUnique({ where: { id: String(req.body.id) } });
        } else {
            b = await saveBuyer(tenantId, d);
        }
        await audit(req, { action: 'buyer.save', entityType: 'Buyer', entityId: b.id, summary: `Buyer "${b.businessName}" saved${b.ntnCnic ? ` (${b.ntnCnic})` : ''}` });
        res.json(b);
    } catch (err) {
        if (err.code === 'P2002') throw new HttpError(400, `Another saved buyer already has NTN/CNIC ${d.ntnCnic}.`);
        throw err;
    }
});

app.delete('/api/buyers/:id', authenticateToken, requireTenant, async (req, res) => {
    const buyer = await prisma.buyer.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, select: { businessName: true } });
    const { count } = await prisma.buyer.deleteMany({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!count) throw new HttpError(404, 'Buyer not found.');
    await audit(req, { action: 'buyer.delete', entityType: 'Buyer', entityId: req.params.id, summary: `Buyer "${buyer.businessName}" deleted` });
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
