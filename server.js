require('dotenv').config();
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const { PrismaClient, Prisma } = require('@prisma/client');

const { createAuth, requireRole, requireTenant, requireTenantRole, signToken, signWorkspaceToken } = require('./src/auth');
const { encrypt, decrypt, mask } = require('./src/crypto');
const itemImport = require('./src/itemImport');
const importMerge = require('./src/importMerge');
const { mobileProblem } = require('./src/phone');
const squashName = v => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const { calcInvoice, cleanExtraTaxes, WHOLE_NUMBER_UOMS, SRO_REQUIRED_SALE_TYPES } = require('./src/tax');
const taxRules = require('./src/hsTaxRules');
const fbrRefs = require('./src/fbrRefs');
const fbr = require('./src/fbr');
const hs = require('./src/hscodes');
const annexC = require('./src/annexc');
const onboarding = require('./src/onboarding');
const sandbox = require('./src/sandboxRecipes');
const importer = require('./src/importer');
const stock = require('./src/stock');
const { createAudit } = require('./src/audit');
const { BUSINESS_ACTIVITIES, SECTORS } = require('./src/activityScenarios');
const { MODULES, tenantModules, cleanModules } = require('./src/modules');
const sub = require('./src/subscription');
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
const { authenticateToken } = createAuth(prisma);
const OWNER_OR_ACCOUNTANT = requireTenantRole('OWNER', 'ACCOUNTANT');

// Proxies in front of the app: Render = 1; Vercel rewrite → Render = 2. Needed so req.ip is the visitor's IP.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.use('/api/import', express.json({ limit: '10mb' })); // spreadsheet rows
app.use(['/api/products/import', '/api/buyers/import'], express.json({ limit: '10mb' })); // items / buyers from Excel
app.use(express.json({ limit: '1mb' }));

// Basic security headers (CSP is left out: the pages use the Tailwind CDN, which injects styles at runtime)
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.set({
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'same-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

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

// Contact mobile: a leading + and digits only; 10 to 15 digits
function cleanMobile(v) {
    const m = String(v ?? '').trim().replace(/(?!^\+)[^\d]/g, '');
    const n = m.replace(/\D/g, '').length;
    if (m && (n < 10 || n > 15)) throw new HttpError(400, 'Mobile number must be 10 to 15 digits (e.g. 03001234567).');
    const problem = mobileProblem(m); // per country: length and how mobile numbers start
    if (problem) throw new HttpError(400, problem);
    return m;
}
// PRAL's security token is a UUID; text copied from IRIS ("Token: 3c43…-…") is reduced to the token itself
function cleanToken(v) {
    const t = String(v || '').trim();
    const m = t.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return m ? m[0] : t;
}
function tenantToken(tenant) {
    return tenant.fbrTokenEnc ? decrypt(tenant.fbrTokenEnc) : null;
}

// Business nature and sector as chosen in IRIS, e.g. "Retailer · Wholesale / Retails"
const industryOf = t => [t.businessActivities.join(', '), t.sectors.join(', ')].filter(Boolean).join(' · ');

// What a client (and its receipts) may see: no token, no IRIS profile
function clientTenant(t) {
    return {
        companyName: t.companyName,
        mobile: t.mobile,
        sellerNtnCnic: t.sellerNtnCnic, sellerNtn: t.sellerNtn, sellerCnic: t.sellerCnic,
        sellerBusinessName: t.sellerBusinessName,
        sellerProvince: t.sellerProvince,
        sellerAddress: t.sellerAddress,
        sellerStrn: t.sellerStrn,
        softwareRegNo: t.softwareRegNo,
        fbrEnv: t.fbrEnv,
        furtherTaxRate: Number(t.furtherTaxRate),
        cnicRequiredAbove: CNIC_REQUIRED_ABOVE,
        industry: industryOf(t), // shown on the Items with Tax Rules page
        // Ready = the client may file (same rule as assertCanInvoice, minus the sandbox check)
        ready: Boolean(sellerReady(t) && (t.fbrTokenEnc || process.env.FBR_MOCK === 'true')),
    };
}

// Full view for the super admin
function publicTenant(t) {
    return {
        id: t.id,
        companyName: t.companyName,
        mobile: t.mobile, active: t.active, inactiveReason: t.inactiveReason,
        // how long the client may use the application (src/subscription.js)
        integratedAt: t.integratedAt, accessUnit: t.accessUnit, accessCount: t.accessCount, accessEndsAt: t.accessEndsAt, access: sub.access(t),
        sellerNtnCnic: t.sellerNtnCnic, sellerNtn: t.sellerNtn, sellerCnic: t.sellerCnic,
        sellerBusinessName: t.sellerBusinessName,
        sellerProvince: t.sellerProvince,
        sellerAddress: t.sellerAddress,
        sellerStrn: t.sellerStrn,
        fbrEnv: t.fbrEnv,
        // FBR token: valid 5 years from issue (spec §3.1); "expiring" 60 days before
        tokenIssuedAt: t.tokenIssuedAt,
        tokenExpiresAt: t.tokenIssuedAt ? new Date(new Date(t.tokenIssuedAt).setFullYear(new Date(t.tokenIssuedAt).getFullYear() + 5)) : null,
        tokenExpiring: Boolean(t.tokenIssuedAt && Date.now() > new Date(t.tokenIssuedAt).setFullYear(new Date(t.tokenIssuedAt).getFullYear() + 5) - 60 * 86400000),
        businessActivities: t.businessActivities,
        sectors: t.sectors,
        modules: tenantModules(t),
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
    if (!tenantModules(tenant).includes('INVOICING')) {
        throw new HttpError(403, 'FBR Digital Invoicing is not switched on for this business. Please contact your administrator.');
    }
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
// "/" is the ETAX landing page (public/index.html); the app itself lives at /app
const page = file => (req, res) => res.sendFile(path.join(__dirname, 'public', file));
app.get('/app', page('app.html'));
app.get('/contact', page('contact.html'));

// ---------- Public website API (no login) ----------
app.get('/api/public/site', (req, res) => {
    res.json({
        name: 'ETAX',
        whatsapp: (process.env.CONTACT_WHATSAPP || '923334351102').replace(/\D/g, ''), // e.g. 923001234567
        phone: process.env.CONTACT_PHONE || '',
        email: process.env.CONTACT_EMAIL || 'e.tax.di@gmail.com',
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
// Brute-force protection: an account locks for 15 min after 5 wrong passwords; one IP may fail 20 times per 15 min
const LOCK_AFTER = 5, LOCK_MINUTES = 15, IP_FAIL_LIMIT = 20;
const ipFails = new Map();
function ipFailCount(ip) {
    const now = Date.now(), list = (ipFails.get(ip) || []).filter(t => now - t < LOCK_MINUTES * 60000);
    ipFails.set(ip, list);
    if (ipFails.size > 5000) for (const [k, v] of ipFails) if (!v.some(t => now - t < LOCK_MINUTES * 60000)) ipFails.delete(k);
    return list;
}
const minutesLeft = d => Math.max(1, Math.ceil((d.getTime() - Date.now()) / 60000));

function loginPayload(user) {
    return {
        token: signToken(user),
        role: user.role,
        tenantRole: user.role === 'CLIENT_USER' ? user.tenantRole : null,
        name: user.name || user.email,
        mustChangePassword: user.mustChangePassword,
        companyName: user.tenant ? user.tenant.companyName : 'Super Admin',
        modules: user.role === 'CLIENT_USER' ? tenantModules(user.tenant) : [], // the user picks one after logging in when there are several
    };
}

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) throw new HttpError(400, 'Email and password are required.');
    const mail = String(email).toLowerCase().trim();
    if (ipFailCount(req.ip).length >= IP_FAIL_LIMIT) throw new HttpError(429, `Too many failed logins from this connection. Try again in ${LOCK_MINUTES} minutes.`);
    const user = await prisma.user.findUnique({ where: { email: mail }, include: { tenant: true } });
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
        throw new HttpError(423, `This account is locked after too many wrong passwords. Try again in ${minutesLeft(user.lockedUntil)} minute(s), or ask your administrator to reset the password.`);
    }
    if (!user || !(await bcrypt.compare(String(password), user.password))) {
        ipFails.get(req.ip).push(Date.now());
        let summary = user ? 'Wrong password' : 'Unknown email';
        if (user) {
            const fails = user.failedLogins + 1;
            const lock = fails >= LOCK_AFTER;
            await prisma.user.update({ where: { id: user.id }, data: lock ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60000) } : { failedLogins: fails } });
            if (lock) summary = `Wrong password — account locked for ${LOCK_MINUTES} minutes after ${LOCK_AFTER} attempts`;
        }
        await audit({ ip: req.ip }, { tenantId: user?.tenantId ?? null, userEmail: mail, action: summary.includes('locked') ? 'auth.locked' : 'auth.login_failed', summary });
        throw new HttpError(400, 'Invalid email or password.');
    }
    if (user.pendingApproval) throw new HttpError(403, 'This user is waiting for the administrator\'s approval. You will be able to log in once it is approved.');
    if (!user.active) throw new HttpError(403, 'This account has been disabled. Contact your account owner or administrator.');
    const blocked = user.tenant ? sub.blockedMessage(user.tenant) : null; // switched off, or the access period (and grace) is over
    if (blocked) throw new HttpError(403, blocked);
    const fresh = await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() }, include: { tenant: true } });
    await audit({ ip: req.ip, user }, { action: 'auth.login', summary: 'Logged in' });
    res.json(loginPayload(fresh));
});

// Change own password (logs out every other session; returns a fresh token for this one)
// Password rules (same list as the screen's checklist): upper- and lowercase letter, number, special character, 8+
const PASSWORD_RULES = [[/[A-Z]/, 'one uppercase letter (A–Z)'], [/[a-z]/, 'one lowercase letter (a–z)'], [/\d/, 'one number (0–9)'],
    [/[^A-Za-z0-9]/, 'one special character'], [/^[\s\S]{8,}$/, 'minimum 8 characters']];
function checkNewPassword(pw, email) {
    const p = String(pw || '');
    if (p.length > 100) throw new HttpError(400, 'Password is too long.');
    const missing = PASSWORD_RULES.filter(([re]) => !re.test(p)).map(([, l]) => l);
    if (missing.length) throw new HttpError(400, `Password must contain at least: ${missing.join(', ')}.`);
    if (email && p.toLowerCase().includes(String(email).split('@')[0].toLowerCase())) throw new HttpError(400, "Password can't contain your email name.");
    return p;
}
app.post('/api/auth/password', authenticateToken, async (req, res) => {
    if (req.user.impersonatedBy) throw new HttpError(400, 'Change your own password from the admin account, not inside a workspace.');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, include: { tenant: true } });
    if (!(await bcrypt.compare(String(req.body?.currentPassword || ''), user.password))) throw new HttpError(400, 'Current password is not correct.');
    const pw = checkNewPassword(req.body?.newPassword, user.email);
    if (await bcrypt.compare(pw, user.password)) throw new HttpError(400, 'The new password must be different from the current one.');
    const updated = await prisma.user.update({
        where: { id: user.id },
        data: { password: await bcrypt.hash(pw, 10), tokenVersion: { increment: 1 }, mustChangePassword: false },
        include: { tenant: true },
    });
    await audit(req, { action: 'auth.password_change', summary: 'Changed own password (other sessions logged out)' });
    res.json(loginPayload(updated));
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { email: true, name: true, role: true, tenantRole: true, mustChangePassword: true } });
    res.json({ ...u, tenantRole: req.user.impersonatedBy ? 'OWNER' : u.tenantRole, workspace: Boolean(req.user.impersonatedBy) });
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
        businessActivities: BUSINESS_ACTIVITIES, sectors: SECTORS, modules: MODULES, wholeNumberUoms: [...WHOLE_NUMBER_UOMS],
    });
});

// ---------- Super admin (minimal: list + create tenants) ----------
const posAdmin = { service: null }; // set where the Point of Sale is built (below): the admin screens read its figures
app.get('/api/admin/clients', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const tenants = await prisma.tenant.findMany({
        orderBy: { createdAt: 'desc' },
        include: { users: { select: { email: true } }, _count: { select: { invoices: true } } },
    });
    const month = todayPKT().slice(0, 7);
    const out = await Promise.all(tenants.map(async t => {
        const [ob, monthAgg, last, attention, pos] = await Promise.all([
            onboarding.checklist(prisma, t),
            prisma.invoice.aggregate({
                where: { tenantId: t.id, status: 'SUBMITTED', fbrEnv: t.fbrEnv, invoiceDate: { startsWith: month } },
                _count: { _all: true }, _sum: { totalAmount: true, totalST: true },
            }),
            prisma.invoice.findFirst({ where: { tenantId: t.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
            prisma.invoice.count({ where: { tenantId: t.id, status: { in: ['FAILED', 'UNCERTAIN'] } } }),
            tenantModules(t).includes('POS') && posAdmin.service ? posAdmin.service.adminFigures(t.id) : null, // Point of Sale: this month's sales and what needs attention
        ]);
        return {
            ...publicTenant(t),
            pos,
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

// The client's owner keeps the business contact mobile up to date (the admin can change it too)
app.put('/api/client/contact', authenticateToken, requireTenant, async (req, res) => {
    if (req.user.tenantRole !== 'OWNER') throw new HttpError(403, 'Only the account owner can change the business contact.');
    const before = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    const mobile = cleanMobile(req.body?.mobile);
    const t = await prisma.tenant.update({ where: { id: before.id }, data: { mobile } });
    if (before.mobile !== mobile) await audit(req, { action: 'settings.update', entityType: 'Tenant', entityId: t.id,
        summary: `Settings changed: Mobile number (by the client)`, details: { 'Mobile number': [before.mobile, mobile] } });
    res.json({ mobile: t.mobile });
});
// ---------- Help & feedback: a client sends a query; the admin answers and resolves it ----------
const TICKET_CATEGORIES = ['Question', 'Problem', 'Suggestion', 'FBR / invoice', 'Other'];
const ticketText = (v, max, what) => {
    const t = String(v ?? '').trim();
    if (!t) throw new HttpError(400, `${what} is required.`);
    if (t.length > max) throw new HttpError(400, `${what} can be at most ${max} characters.`);
    return t;
};
const ticketView = t => ({ id: t.id, category: t.category, subject: t.subject, status: t.status, userEmail: t.userEmail, createdAt: t.createdAt, updatedAt: t.updatedAt,
    company: t.tenant?.companyName, tenantId: t.tenantId,
    messages: (t.messages || []).map(m => ({ id: m.id, fromAdmin: m.fromAdmin, author: m.author, body: m.body, createdAt: m.createdAt })) });
const withMessages = { messages: { orderBy: { createdAt: 'asc' } } };
app.get('/api/client/tickets', authenticateToken, requireTenant, async (req, res) => {
    const rows = await prisma.supportTicket.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { updatedAt: 'desc' }, include: withMessages, take: 200 });
    res.json(rows.map(ticketView));
});
app.post('/api/client/tickets', authenticateToken, requireTenant, async (req, res) => {
    const b = req.body || {};
    const category = TICKET_CATEGORIES.includes(b.category) ? b.category : 'Other';
    const subject = ticketText(b.subject, 150, 'Subject'), body = ticketText(b.message, 5000, 'Message');
    const t = await prisma.supportTicket.create({ data: { tenantId: req.user.tenantId, userEmail: req.user.email, category, subject,
        messages: { create: { fromAdmin: false, author: req.user.email, body } } }, include: withMessages });
    await audit(req, { action: 'support.ticket', entityType: 'SupportTicket', entityId: t.id, summary: `Query sent: [${category}] ${subject}` });
    res.json(ticketView(t));
});
// The client replies (also reopens a resolved query)
app.post('/api/client/tickets/:id/messages', authenticateToken, requireTenant, async (req, res) => {
    const t = await prisma.supportTicket.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!t) throw new HttpError(404, 'Query not found.');
    const body = ticketText(req.body?.message, 5000, 'Message');
    await prisma.supportMessage.create({ data: { ticketId: t.id, fromAdmin: false, author: req.user.email, body } });
    const u = await prisma.supportTicket.update({ where: { id: t.id }, data: { status: 'OPEN' }, include: withMessages });
    await audit(req, { action: 'support.reply', entityType: 'SupportTicket', entityId: t.id, summary: `Client replied on "${t.subject}"` });
    res.json(ticketView(u));
});
app.get('/api/admin/tickets', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const status = ['OPEN', 'ANSWERED', 'RESOLVED'].includes(req.query.status) ? req.query.status : undefined;
    const rows = await prisma.supportTicket.findMany({ where: { ...(status && { status }), ...(req.query.tenantId && { tenantId: String(req.query.tenantId) }) },
        orderBy: { updatedAt: 'desc' }, include: { ...withMessages, tenant: { select: { companyName: true } } }, take: 500 });
    const open = await prisma.supportTicket.count({ where: { status: 'OPEN' } });
    res.json({ open, tickets: rows.map(ticketView) });
});
// The admin replies (the query then waits for the client) and/or marks it resolved; or reopens it
app.post('/api/admin/tickets/:id', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const t = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
    if (!t) throw new HttpError(404, 'Query not found.');
    const b = req.body || {};
    const msg = String(b.message ?? '').trim();
    if (msg.length > 5000) throw new HttpError(400, 'Reply can be at most 5000 characters.');
    if (msg) await prisma.supportMessage.create({ data: { ticketId: t.id, fromAdmin: true, author: req.user.email || 'ETAX', body: msg } });
    const status = b.status === 'RESOLVED' ? 'RESOLVED' : b.status === 'OPEN' ? 'OPEN' : msg ? 'ANSWERED' : t.status;
    const u = await prisma.supportTicket.update({ where: { id: t.id }, data: { status }, include: { ...withMessages, tenant: { select: { companyName: true } } } });
    await audit(req, { tenantId: t.tenantId, action: 'support.answer', entityType: 'SupportTicket', entityId: t.id,
        summary: `Query "${t.subject}": ${[msg && 'replied', status !== t.status && `now ${status.toLowerCase()}`].filter(Boolean).join(', ') || 'no change'}` });
    res.json(ticketView(u));
});

// History of one client's record: who changed what, when (from the activity log)
app.get('/api/admin/clients/:id/history', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const rows = await prisma.auditLog.findMany({ where: { entityType: 'Tenant', entityId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 300 });
    res.json(rows.map(x => {
        const d = x.details && typeof x.details === 'object' && !Array.isArray(x.details) ? x.details : {};
        // settings changes are kept as { label: [before, after] }
        const changes = Object.entries(d).filter(([, v]) => Array.isArray(v) && v.length === 2).map(([label, [from, to]]) => ({ label, from: String(from ?? ''), to: String(to ?? '') }));
        return { at: x.createdAt, by: x.userEmail, action: x.action, summary: x.summary, changes, created: x.action === 'admin.client_create', file: '' };
    }));
});

app.get('/api/admin/clients/:id/onboarding', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!t) throw new HttpError(404, 'Client not found.');
    res.json(await onboarding.checklist(prisma, t));
});

// Admin records what IRIS shows for the client's sandbox scenarios (assigned / Successful) — the checklist follows IRIS
app.put('/api/admin/clients/:id/iris-scenarios', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!t) throw new HttpError(404, 'Client not found.');
    const ids = v => [...new Set((Array.isArray(v) ? v : []).map(String).filter(x => /^SN\d{3}$/.test(x)))].sort();
    const assigned = ids(req.body?.assigned), passed = ids(req.body?.passed).filter(x => assigned.includes(x));
    const value = assigned.length ? { assigned, passed, at: new Date().toISOString(), by: req.user.email || 'admin' } : null;
    await prisma.tenant.update({ where: { id: t.id }, data: { irisScenarios: value ?? Prisma.DbNull } });
    await audit(req, { tenantId: t.id, action: 'onboarding.iris_scenarios', entityType: 'Tenant', entityId: t.id,
        summary: value ? `IRIS scenarios recorded: ${passed.length} of ${assigned.length} Successful (${passed.join(', ') || 'none'})` : 'IRIS scenarios cleared — back to the spec table' });
    res.json(await onboarding.checklist(prisma, await prisma.tenant.findUnique({ where: { id: t.id } })));
});

// ---------- Run sandbox scenarios (admin) ----------
// One test invoice per scenario from src/sandboxRecipes.js, adapted to FBR's live lists (sale type spelling, rates,
// SRO / serial, unit), validated and — only when FBR says Valid — posted to FBR's sandbox. Kept in SandboxTest (not the
// client's invoices); the go-live checklist counts accepted ones. One scenario per call, so the screen shows progress.
async function sandboxTenant(id) {
    const t = await prisma.tenant.findUnique({ where: { id } });
    if (!t) throw new HttpError(404, 'Client not found.');
    return t;
}
app.get('/api/admin/clients/:id/sandbox-plan', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const t = await sandboxTenant(req.params.id);
    const ob = await onboarding.checklist(prisma, t);
    const buyers = await prisma.buyer.findMany({ where: { tenantId: t.id, registrationType: 'Registered' }, orderBy: { businessName: 'asc' },
        select: { id: true, businessName: true, ntn: true, cnic: true, province: true, address: true } });
    res.json({
        env: t.fbrEnv, hasToken: Boolean(t.fbrTokenEnc), mock: process.env.FBR_MOCK === 'true',
        scenarios: ob.scenarios.map(sc => {
            const r = sandbox.RECIPES[sc.id];
            return { ...sc, known: Boolean(r), confirmed: Boolean(r) && r.confirmed !== false, note: r?.note || '', registeredBuyer: r?.buyer === 'REG' };
        }),
        buyers,
    });
});
// Is this NTN / CNIC on FBR's Active Taxpayers List? (SN001 needs a real, active registered buyer)
app.get('/api/admin/clients/:id/check-buyer', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const t = await sandboxTenant(req.params.id);
    const reg = String(req.query.ntn || '').replace(/\D/g, '');
    if (![7, 9, 13].includes(reg.length)) throw new HttpError(400, 'Enter a 7-digit NTN or 13-digit CNIC.');
    res.json(await fbr.checkBuyer(reg, todayPKT(), tenantToken(t)));
});
app.post('/api/admin/clients/:id/sandbox-run/:sid', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const t = await sandboxTenant(req.params.id), sid = String(req.params.sid);
    const recipe = sandbox.RECIPES[sid];
    if (!recipe) throw new HttpError(400, `ETAX has no test invoice for ${sid} yet.`);
    if (t.fbrEnv !== 'SANDBOX') throw new HttpError(400, 'The client is on Production — sandbox scenarios need the Sandbox environment and the sandbox token.');
    const token = tenantToken(t);
    if (!token) throw new HttpError(400, 'Save the client\'s sandbox token first.');
    if (process.env.FBR_MOCK === 'true') throw new HttpError(400, 'Mock mode is on (FBR_MOCK=true) — the test invoices would not reach FBR. Turn it off first.');
    const done = await prisma.sandboxTest.findFirst({ where: { tenantId: t.id, scenarioId: sid, ok: true, stage: 'post' } });
    if (done && !req.body?.again) return res.json({ id: sid, ok: true, skipped: true, invoiceNumber: done.fbrInvoiceNumber, notes: ['Already accepted earlier'] });

    // Adapt the test invoice to FBR's live lists
    const item = { ...recipe.item }, notes = [];
    const fail = (msg, stage = 'build') => res.json({ id: sid, ok: false, stage, error: msg, notes });
    const { provinceCode } = await fbrChainContext(t.id);
    const live = await fbr.reference('transtypecode', token).catch(() => null);
    let transTypeId = null;
    if (Array.isArray(live) && live.length) {
        const name = sandbox.pickSaleType(item.saleType, live.map(x => String(x.transactioN_DESC || '').trim()));
        if (!name) return fail(`FBR's list has no sale type "${item.saleType}".`);
        if (name !== item.saleType) notes.push(`sale type as FBR spells it: ${name}`);
        item.saleType = name;
        transTypeId = live.find(x => String(x.transactioN_DESC || '').trim() === name)?.transactioN_TYPE_ID ?? null;
    }
    if (transTypeId != null && provinceCode != null) {
        const rates = await fbr.saleTypeRates(token, { transTypeId, provinceCode }).catch(() => null);
        if (rates?.length) {
            const r = sandbox.pickRate(item.rate, rates);
            if (r.desc !== item.rate) notes.push(`rate from FBR's list: ${r.desc}`);
            item.rate = r.desc;
            const sros = await fbr.sroSchedules(token, { rateId: r.id, provinceCode }).catch(() => null);
            if (sros?.length) {
                const sro = sandbox.pickSro(item.sroScheduleNo, sros);
                if (sro.desc !== item.sroScheduleNo) notes.push(`SRO / Schedule from FBR's list: ${sro.desc}`);
                item.sroScheduleNo = sro.desc;
                const serials = await fbr.sroItems(token, { sroId: sro.id }).catch(() => null);
                if (serials?.length) {
                    const it = sandbox.pickSerial(item.sroItemSerialNo, serials);
                    if (it.desc !== item.sroItemSerialNo) notes.push(`item serial from FBR's list: ${it.desc}`);
                    item.sroItemSerialNo = it.desc;
                }
            } else if (Array.isArray(sros) && !SRO_REQUIRED_SALE_TYPES.has(item.saleType)) { item.sroScheduleNo = ''; item.sroItemSerialNo = ''; }
        }
    }
    const uoms = await fbr.hsUom(item.hsCode, token).catch(() => null);
    const uoM = sandbox.pickUom(item.uoM, uoms);
    if (uoM !== item.uoM) notes.push(`unit FBR allows for ${item.hsCode}: ${uoM}`);
    item.uoM = uoM;

    // Buyer: a real, active registered one for SN001 (checked with FBR); otherwise a walk-in customer
    let buyer;
    if (recipe.buyer === 'REG') {
        const b = req.body?.buyer || {};
        const reg = String(b.ntn || '').replace(/\D/g, '');
        if (![7, 9, 13].includes(reg.length) || !String(b.name || '').trim()) return fail('This scenario needs a registered buyer — choose one, or enter their NTN and name.');
        const chk = await fbr.checkBuyer(reg, todayPKT(), token).catch(() => null);
        if (chk?.live && chk.active === false) return fail(`FBR's Active Taxpayers List says ${reg} is not active — use an active registered buyer.`);
        buyer = { buyerRegistrationType: 'Registered', buyerNtnCnic: reg, buyerBusinessName: String(b.name).trim().slice(0, 200),
            buyerProvince: String(b.province || t.sellerProvince || '').trim(), buyerAddress: String(b.address || t.sellerAddress || '').trim() };
    } else {
        buyer = { buyerRegistrationType: 'Unregistered', buyerNtnCnic: '', buyerBusinessName: 'Walk-in Customer', buyerProvince: t.sellerProvince, buyerAddress: t.sellerAddress };
    }
    let lines;
    try { lines = calcInvoice([item], { buyerRegistrationType: buyer.buyerRegistrationType, furtherTaxRate: Number(t.furtherTaxRate ?? 4), endConsumer: Boolean(recipe.endConsumer) }).lines; }
    catch (err) { return fail(`ETAX could not build the invoice: ${err.message}`); }
    const payload = fbr.buildPayload(t, { invoiceType: 'Sale Invoice', invoiceDate: todayPKT(), ...buyer, invoiceRefNo: '', fbrEnv: 'SANDBOX', scenarioId: sid }, lines);

    const r = await fbr.submit(token, 'SANDBOX', payload); // validate first; posted only when FBR says Valid
    const stage = r.raw?.stage || 'validate';
    await prisma.sandboxTest.create({ data: { tenantId: t.id, scenarioId: sid, ok: Boolean(r.ok), stage, fbrInvoiceNumber: r.invoiceNumber || null,
        error: r.ok ? null : String(r.error || '').slice(0, 2000), request: payload, response: r.raw?.response ?? undefined, createdBy: req.user.email || 'admin' } });
    await audit(req, { tenantId: t.id, action: 'onboarding.sandbox_test', entityType: 'Tenant', entityId: t.id,
        summary: `Sandbox ${sid}: ${r.ok ? `accepted by FBR — ${r.invoiceNumber}` : `not accepted (${stage}) — ${String(r.error || '').slice(0, 300)}`}` });
    const l = payload.items[0];
    res.json({ id: sid, ok: Boolean(r.ok), stage, invoiceNumber: r.invoiceNumber || null, error: r.ok ? null : r.error, notes,
        item: { description: l.productDescription, hsCode: l.hsCode, saleType: l.saleType, rate: l.rate, sro: l.sroScheduleNo, serial: l.sroItemSerialNo, value: l.valueSalesExcludingST, salesTax: l.salesTaxApplicable, total: l.totalValues } });
});

app.get('/api/admin/clients/:id/annex-c', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    await sendAnnexC(req.params.id, req.query, res, req);
});

app.post('/api/admin/clients', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const { companyName, clientEmail, clientPassword } = req.body || {};
    const mobile = cleanMobile(req.body?.mobile);
    if (!companyName || !clientEmail || !clientPassword) throw new HttpError(400, 'Company name, email and password are required.');
    const email = String(clientEmail).toLowerCase().trim();
    checkNewPassword(clientPassword, email);
    if (await prisma.user.findUnique({ where: { email } })) throw new HttpError(400, 'That email is already registered.');
    // optionally, how long the client may use the application (no period given = no time limit); checked before anything is created
    let period = {};
    if (req.body?.accessUnit) {
        try { period = sub.setPeriod({ unit: req.body.accessUnit, count: req.body.accessCount }, {}); } catch (e) { if (e instanceof sub.AccessError) throw new HttpError(400, e.message); throw e; }
    }

    const tenant = await prisma.tenant.create({
        data: {
            companyName: String(companyName).trim(),
            mobile,
            ...period,
            users: { create: { email, password: await bcrypt.hash(String(clientPassword), 10), role: 'CLIENT_USER', tenantRole: 'OWNER', mustChangePassword: true } },
        },
    });
    await audit(req, { tenantId: tenant.id, action: 'admin.client_create', entityType: 'Tenant', entityId: tenant.id, summary: `Client "${tenant.companyName}" created with login ${email}${mobile ? `, mobile ${mobile}` : ''}; access: ${accessText(tenant)}` });
    res.json({ success: true, tenantId: tenant.id });
});

// ---------- Users inside a client (Owner manages own staff; super admin manages any client) ----------
const TENANT_ROLES = ['OWNER', 'ACCOUNTANT', 'CASHIER'];
const userView = u => ({ id: u.id, email: u.email, name: u.name, tenantRole: u.tenantRole, active: u.active, pendingApproval: u.pendingApproval, requestedBy: u.requestedBy,
    locked: Boolean(u.lockedUntil && u.lockedUntil > new Date()), mustChangePassword: u.mustChangePassword, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt });

async function tenantUsers(tenantId) {
    const list = await prisma.user.findMany({ where: { tenantId, role: 'CLIENT_USER' }, orderBy: { createdAt: 'asc' } });
    return list.map(userView);
}
async function addTenantUser(req, tenantId, b) {
    const email = String(b.email || '').toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email.');
    if (!TENANT_ROLES.includes(b.tenantRole)) throw new HttpError(400, 'Choose a role: Owner, Accountant or Cashier.');
    const pw = checkNewPassword(b.password, email);
    if (await prisma.user.findUnique({ where: { email } })) throw new HttpError(400, 'That email is already registered.');
    // an owner's new user waits for the administrator; the administrator's own additions are live at once
    const request = req.user.role !== 'SUPER_ADMIN';
    const u = await prisma.user.create({ data: {
        email, name: String(b.name || '').trim().slice(0, 100), password: await bcrypt.hash(pw, 10),
        role: 'CLIENT_USER', tenantRole: b.tenantRole, tenantId, mustChangePassword: true, // first login asks for their own password
        ...(request ? { active: false, pendingApproval: true, requestedBy: req.user.email } : {}),
    } });
    await audit(req, { tenantId, action: request ? 'user.request' : 'user.create', entityType: 'User', entityId: u.id,
        summary: request ? `User ${email} requested as ${b.tenantRole.toLowerCase()} — waiting for administrator approval` : `User ${email} added as ${b.tenantRole.toLowerCase()}` });
    return userView(u);
}
async function findTenantUser(tenantId, id) {
    const u = await prisma.user.findFirst({ where: { id, tenantId, role: 'CLIENT_USER' } });
    if (!u) throw new HttpError(404, 'User not found.');
    return u;
}
async function activeOwners(tenantId, exceptId) {
    return prisma.user.count({ where: { tenantId, role: 'CLIENT_USER', tenantRole: 'OWNER', active: true, id: { not: exceptId } } });
}
async function updateTenantUser(req, tenantId, id, b) {
    const u = await findTenantUser(tenantId, id);
    const data = {};
    if (u.pendingApproval && req.user.role !== 'SUPER_ADMIN') throw new HttpError(403, 'This user is waiting for the administrator\'s approval.');
    if (b.name !== undefined) data.name = String(b.name).trim().slice(0, 100);
    if (b.tenantRole !== undefined) {
        if (!TENANT_ROLES.includes(b.tenantRole)) throw new HttpError(400, 'Unknown role.');
        data.tenantRole = b.tenantRole;
    }
    if (b.active !== undefined) data.active = Boolean(b.active);
    // Correcting a mistyped login email: administrator only (owners can never change it, even by calling the API)
    if (b.email !== undefined && String(b.email).toLowerCase().trim() !== u.email) {
        if (req.user.role !== 'SUPER_ADMIN') throw new HttpError(403, 'Only the administrator can change a login email.');
        const email = String(b.email).toLowerCase().trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email.');
        if (await prisma.user.findUnique({ where: { email } })) throw new HttpError(400, 'That email is already registered.');
        data.email = email;
    }
    const losesOwner = u.tenantRole === 'OWNER' && u.active && (data.tenantRole && data.tenantRole !== 'OWNER' || data.active === false);
    if (losesOwner && !(await activeOwners(tenantId, u.id))) throw new HttpError(400, 'Keep at least one active owner on the account.');
    if (data.email || data.active === false || (data.tenantRole && data.tenantRole !== u.tenantRole)) data.tokenVersion = { increment: 1 }; // sign them out
    const upd = await prisma.user.update({ where: { id: u.id }, data });
    const what = [data.email && `login email ${u.email} → ${data.email} (signed out)`, data.tenantRole && `role → ${data.tenantRole.toLowerCase()}`, data.active === false && 'disabled', data.active === true && !u.active && 'enabled', data.name !== undefined && data.name !== u.name && 'name changed'].filter(Boolean);
    if (what.length) await audit(req, { tenantId, action: 'user.update', entityType: 'User', entityId: u.id, summary: `User ${u.email}: ${what.join(', ')}` });
    return userView(upd);
}
async function resetTenantUserPassword(req, tenantId, id, password) {
    const u = await findTenantUser(tenantId, id);
    if (u.pendingApproval && req.user.role !== 'SUPER_ADMIN') throw new HttpError(403, 'This user is waiting for the administrator\'s approval.');
    const pw = checkNewPassword(password, u.email);
    const upd = await prisma.user.update({ where: { id: u.id }, data: {
        password: await bcrypt.hash(pw, 10), mustChangePassword: true, tokenVersion: { increment: 1 }, failedLogins: 0, lockedUntil: null,
    } });
    await audit(req, { tenantId, action: 'user.password_reset', entityType: 'User', entityId: u.id, summary: `Password reset for ${u.email} (must change at next login; account unlocked)` });
    return userView(upd);
}
// Administrator decides on a user an owner asked for
async function decideUserRequest(req, tenantId, id, approve) {
    const u = await findTenantUser(tenantId, id);
    if (!u.pendingApproval) throw new HttpError(400, 'This user is not waiting for approval.');
    if (approve) {
        await prisma.user.update({ where: { id: u.id }, data: { pendingApproval: false, active: true } });
        await audit(req, { tenantId, action: 'user.approve', entityType: 'User', entityId: u.id, summary: `User ${u.email} approved (requested by ${u.requestedBy || 'owner'}) — can log in now` });
    } else {
        await prisma.user.delete({ where: { id: u.id } }); // never logged in: nothing else points at it
        await audit(req, { tenantId, action: 'user.reject', entityType: 'User', entityId: u.id, summary: `User request for ${u.email} rejected (requested by ${u.requestedBy || 'owner'})` });
    }
    return { ok: true };
}
const OWNER_ONLY = requireTenantRole('OWNER');
app.get('/api/client/users', authenticateToken, requireTenant, OWNER_ONLY, async (req, res) => res.json(await tenantUsers(req.user.tenantId)));
app.post('/api/client/users', authenticateToken, requireTenant, OWNER_ONLY, async (req, res) => res.json(await addTenantUser(req, req.user.tenantId, req.body || {})));
app.patch('/api/client/users/:uid', authenticateToken, requireTenant, OWNER_ONLY, async (req, res) => res.json(await updateTenantUser(req, req.user.tenantId, req.params.uid, req.body || {})));
app.post('/api/client/users/:uid/reset-password', authenticateToken, requireTenant, OWNER_ONLY, async (req, res) => res.json(await resetTenantUserPassword(req, req.user.tenantId, req.params.uid, req.body?.password)));
const ADMIN = requireRole('SUPER_ADMIN');
app.get('/api/admin/clients/:id/users', authenticateToken, ADMIN, async (req, res) => res.json(await tenantUsers(req.params.id)));
app.post('/api/admin/clients/:id/users', authenticateToken, ADMIN, async (req, res) => {
    if (!(await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { id: true } }))) throw new HttpError(404, 'Client not found.');
    res.json(await addTenantUser(req, req.params.id, req.body || {}));
});
app.patch('/api/admin/clients/:id/users/:uid', authenticateToken, ADMIN, async (req, res) => res.json(await updateTenantUser(req, req.params.id, req.params.uid, req.body || {})));
app.post('/api/admin/clients/:id/users/:uid/approve', authenticateToken, ADMIN, async (req, res) => res.json(await decideUserRequest(req, req.params.id, req.params.uid, true)));
app.post('/api/admin/clients/:id/users/:uid/reject', authenticateToken, ADMIN, async (req, res) => res.json(await decideUserRequest(req, req.params.id, req.params.uid, false)));
app.get('/api/admin/user-requests', authenticateToken, ADMIN, async (req, res) => {
    const list = await prisma.user.findMany({ where: { role: 'CLIENT_USER', pendingApproval: true }, include: { tenant: { select: { id: true, companyName: true } } }, orderBy: { createdAt: 'asc' } });
    res.json(list.map(u => ({ ...userView(u), tenantId: u.tenantId, companyName: u.tenant?.companyName })));
});
app.post('/api/admin/clients/:id/users/:uid/reset-password', authenticateToken, ADMIN, async (req, res) => res.json(await resetTenantUserPassword(req, req.params.id, req.params.uid, req.body?.password)));

// Open a client's workspace (e.g. to run the sandbox scenarios). Returns a 2-hour client token for the admin.
app.post('/api/admin/clients/:id/workspace', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!t) throw new HttpError(404, 'Client not found.');
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id } });
    await audit(req, { tenantId: t.id, action: 'admin.workspace_open', entityType: 'Tenant', entityId: t.id, summary: `Admin opened the workspace of "${t.companyName}"` });
    res.json({ token: signWorkspaceToken(admin, t.id), companyName: t.companyName, modules: tenantModules(t) });
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

app.post('/api/admin/clients/:id/fbr-test', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!t) throw new HttpError(404, 'Client not found.');
    if (process.env.FBR_MOCK === 'true') res.set('X-Note', 'mock'); // the test always calls the real FBR
    // the token typed on the screen (not saved yet) if sent, else the saved one
    const typed = cleanToken(req.body?.token);
    const r = await fbr.testConnection(typed || tenantToken(t));
    if (typed) r.verdict += r.ok ? ' (Typed token — click Save to keep it.)' : ' (This was the typed token, not saved yet.)';
    await audit(req, { tenantId: t.id, action: 'fbr.test', entityType: 'Tenant', entityId: t.id, summary: `FBR connection test: ${r.ok ? 'OK' : 'failed'} — ${r.verdict}`.slice(0, 480) });
    res.json(r);
});
app.get('/api/admin/egress-ip', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    res.json(await fbr.egressIp());
});

// ---------- Client settings ----------
// Read-only for clients; only the super admin changes FBR settings
app.get('/api/client/settings', authenticateToken, requireTenant, async (req, res) => {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    res.json({ ...clientTenant(t), modules: tenantModules(t), workspace: Boolean(req.user.impersonatedBy), tenantRole: req.user.tenantRole,
        nextInvoiceNo: formatInvoiceNo(t.invoiceNumberFormat, t.invoiceSeq + 1, todayPKT()) }); // shown on the form; taken only when the invoice is created
});

app.get('/api/admin/clients/:id/settings', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!t) throw new HttpError(404, 'Client not found.');
    res.json(publicTenant(t));
});

const SETTING_LABELS = {
    mobile: 'Mobile number', active: 'Status', sellerNtn: 'Seller NTN', sellerCnic: 'Seller CNIC', sellerNtnCnic: 'Seller number sent to FBR', sellerStrn: 'STRN', sellerBusinessName: 'Business name', sellerProvince: 'Province',
    sellerAddress: 'Address', fbrEnv: 'Environment', furtherTaxRate: 'Further tax %', businessActivities: 'Business nature', sectors: 'Sector', modules: 'Modules',
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
    // Seller NTN and CNIC in separate boxes (older screens / API: one "sellerNtnCnic" box, split by length)
    if (b.sellerNtn === undefined && b.sellerCnic === undefined && b.sellerNtnCnic !== undefined) {
        const v = String(b.sellerNtnCnic).replace(/\D/g, '');
        b.sellerNtn = v.length === 13 ? '' : v; b.sellerCnic = v.length === 13 ? v : '';
    }
    if (b.sellerNtn !== undefined) {
        const v = String(b.sellerNtn).replace(/\D/g, '');
        if (v && ![7, 9].includes(v.length)) throw new HttpError(400, 'Seller NTN must be 7 digits.');
        data.sellerNtn = v;
    }
    if (b.sellerCnic !== undefined) {
        const v = String(b.sellerCnic).replace(/\D/g, '');
        if (v && v.length !== 13) throw new HttpError(400, 'Seller CNIC must be 13 digits.');
        data.sellerCnic = v;
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
    if (b.modules !== undefined) {
        const list = cleanModules(b.modules);
        if (!list.length) throw new HttpError(400, 'Switch on at least one module for the client.');
        data.modules = list;
    }
    if (b.sectors !== undefined) {
        const list = Array.isArray(b.sectors) ? [...new Set(b.sectors.map(String))] : [];
        if (list.some(s => !SECTORS.includes(s))) throw new HttpError(400, 'Unknown sector.');
        data.sectors = list;
    }
    // Empty token field = keep existing token
    if (b.mobile !== undefined) data.mobile = cleanMobile(b.mobile);
    if (b.active !== undefined) data.active = b.active === true || b.active === 'true';
    // Remove this client's saved token (e.g. a wrong one) — only this client's record changes
    if (b.removeToken === true) { data.fbrTokenEnc = null; data.tokenIssuedAt = null; }
    else if (b.fbrToken) {
        // PRAL's security token is a long code from IRIS (Digital Invoicing → API Integration); a short value is a
        // placeholder or something else (e.g. the DI-CRM password) and FBR answers "Invalid Credentials"
        const tok = cleanToken(b.fbrToken);
        if (tok.length < 20 || /\s/.test(tok)) throw new HttpError(400, 'This does not look like an FBR security token — copy the "Sandbox Security Token" (or production token) from IRIS → Digital Invoicing → API Integration.');
        data.fbrTokenEnc = encrypt(tok);
    }
    // FBR tokens are valid for 5 years (spec §3.1): the issue date is kept for a reminder
    if (b.tokenIssuedAt !== undefined && b.tokenIssuedAt !== '') {
        const d = new Date(String(b.tokenIssuedAt));
        if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Token issue date is not a valid date.');
        data.tokenIssuedAt = d;
    }

    const before = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (data.active === true && !before.active && sub.access(before).status === 'EXPIRED') {
        throw new HttpError(400, 'This client\'s access period has ended. Renew it first (Manage → Overview → Access period): renewing makes it active again.');
    }
    if ('active' in data) data.inactiveReason = data.active ? null : 'ADMIN'; // switched off by hand, or on again
    // a new token starts a new 5-year period, unless the admin typed a different issue date
    const sameDay = (a, c) => a && c && new Date(a).toISOString().slice(0, 10) === new Date(c).toISOString().slice(0, 10);
    if (b.fbrToken && (!data.tokenIssuedAt || sameDay(data.tokenIssuedAt, before.tokenIssuedAt))) data.tokenIssuedAt = new Date();
    // FBR's invoice has one seller number (sellerNTNCNIC): the NTN if there is one, else the CNIC
    if ('sellerNtn' in data || 'sellerCnic' in data) data.sellerNtnCnic = (data.sellerNtn ?? before.sellerNtn) || (data.sellerCnic ?? before.sellerCnic);
    const t = await prisma.tenant.update({ where: { id: tenantId }, data });
    const show = v => Array.isArray(v) ? v.join(', ') : v instanceof Date ? v.toISOString().slice(0, 10) : v === true ? 'Active' : v === false ? 'Inactive' : String(v ?? '');
    const changed = {};
    for (const [k, label] of Object.entries(SETTING_LABELS)) {
        if (k in data && show(before[k]) !== show(t[k])) changed[label] = [show(before[k]), show(t[k])];
    }
    if (data.fbrTokenEnc) changed['PRAL token'] = ['(hidden)', '(replaced)']; // never log the token itself
    if (b.removeToken === true) changed['PRAL token'] = ['(hidden)', '(removed)'];
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

// ---------- How long a client may use the application (src/subscription.js) ----------
const accessText = t => (t.accessEndsAt ? `${t.accessCount} ${String(t.accessUnit || '').toLowerCase()}${t.accessCount === 1 ? '' : 's'}, ends ${sub.dayOf(t.accessEndsAt)}` : 'no time limit');
async function changeAccess(req, res, compute, verb) {
    const tenantId = req.params.id;
    const before = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!before) throw new HttpError(404, 'Client not found.');
    let data;
    try { data = compute(before); } catch (e) { if (e instanceof sub.AccessError) throw new HttpError(400, e.message); throw e; }
    const status = sub.access({ ...before, ...data }).status;
    // the client's state follows the new dates: a lapsed one is switched off, and one the period had switched off comes back
    if (status === 'EXPIRED' && before.active) Object.assign(data, { active: false, inactiveReason: 'EXPIRED' });
    else if (status !== 'EXPIRED' && !before.active && before.inactiveReason === 'EXPIRED') Object.assign(data, { active: true, inactiveReason: null });
    const t = await prisma.tenant.update({ where: { id: tenantId }, data });
    const day = d => sub.dayOf(d);
    await audit(req, {
        tenantId, action: 'client.access', entityType: 'Tenant', entityId: tenantId,
        summary: `Access period ${verb}: ${accessText(before)} → ${accessText(t)}${before.active !== t.active ? (t.active ? '; client made active' : '; client made inactive (period over)') : ''}`,
        details: { 'Integration date': [day(before.integratedAt), day(t.integratedAt)], 'Access period': [accessText(before), accessText(t)] },
    });
    res.json(publicTenant(t));
}
app.put('/api/admin/clients/:id/access', authenticateToken, requireRole('SUPER_ADMIN'), (req, res) => changeAccess(req, res, before => sub.setPeriod(req.body, before), 'set'));
app.post('/api/admin/clients/:id/access/renew', authenticateToken, requireRole('SUPER_ADMIN'), (req, res) => changeAccess(req, res, before => sub.renew(req.body, before), 'renewed'));
// The Point of Sale side of a client, read-only, for the Manage screen (counters, this month, what needs attention)
app.get('/api/admin/clients/:id/pos-summary', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const t = await prisma.tenant.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!t) throw new HttpError(404, 'Client not found.');
    res.json(await posAdmin.service.adminSummary(t.id));
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

// Every HS code, for the HS codes sheet of the items Excel template
app.get('/api/hs/all', authenticateToken, async (req, res) => {
    res.json(await prisma.hsCode.findMany({ select: { code: true, description: true, source: true }, orderBy: { code: 'asc' } }));
});

app.get('/api/hs/stats', authenticateToken, async (req, res) => {
    res.json(await hs.stats(prisma));
});

// HS codes this client already filed invoices with, newest first, with what they used last time.
// q narrows it like the HS search (code prefix, or words in the description).
app.get('/api/hs/recent', authenticateToken, requireTenant, async (req, res) => {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId }, select: { fbrEnv: true } });
    const q = String(req.query.q || '').trim();
    const code = /^[\d.\s]+$/.test(q) ? hs.normalizeCode(q) : '';
    const like = q && !code ? `%${q}%` : null;
    const rows = await prisma.$queryRaw`
        WITH used AS (
            SELECT DISTINCT ON (ii."hsCode") ii."hsCode", ii."productDescription", ii."saleType", ii."rate", ii."uoM",
                   ii."sroScheduleNo", ii."sroItemSerialNo", i."invoiceDate", i."createdAt"
            FROM "InvoiceItem" ii JOIN "Invoice" i ON i."id" = ii."invoiceId"
            WHERE i."tenantId" = ${req.user.tenantId} AND i."status" = 'SUBMITTED' AND i."fbrEnv"::text = ${t.fbrEnv}
            ORDER BY ii."hsCode", i."createdAt" DESC
        ), counts AS (
            SELECT ii."hsCode", count(*)::int AS "times"
            FROM "InvoiceItem" ii JOIN "Invoice" i ON i."id" = ii."invoiceId"
            WHERE i."tenantId" = ${req.user.tenantId} AND i."status" = 'SUBMITTED' AND i."fbrEnv"::text = ${t.fbrEnv}
            GROUP BY ii."hsCode"
        )
        SELECT used.*, counts."times" FROM used JOIN counts USING ("hsCode")
        WHERE (${code} = '' OR used."hsCode" LIKE ${code + '%'})
          AND (${like}::text IS NULL OR used."productDescription" ILIKE ${like})
        ORDER BY used."createdAt" DESC LIMIT 15`;
    res.json(rows.map(({ createdAt, ...r }) => r));
});

// Suggested sale type / rate for an HS code: the admin's tax rules (Sales Tax Act schedules), else standard rate.
// options: every rule for the code (several when they depend on a condition, e.g. packaging); standard: the 18% fallback.
// `last` is what this client used for the same code last time, so the form can point out a difference.
app.get('/api/hs/:code/tax', authenticateToken, requireTenant, async (req, res) => {
    const code = hs.normalizeCode(req.params.code);
    if (!hs.HS_FORMAT.test(code)) throw new HttpError(400, 'HS code must look like 0101.2100');
    const rules = taxRules.matchRules(await taxRules.loadRules(prisma), code);
    const last = await prisma.invoiceItem.findFirst({
        where: { hsCode: code, invoice: { tenantId: req.user.tenantId, status: 'SUBMITTED' } },
        orderBy: { invoice: { createdAt: 'desc' } },
        select: { saleType: true, rate: true, sroScheduleNo: true, sroItemSerialNo: true, invoice: { select: { invoiceDate: true } } },
    });
    res.json({
        options: rules.map(r => ({ prefix: r.prefix, condition: r.condition, saleType: r.saleType, rate: r.rate, sroScheduleNo: r.sroScheduleNo,
            sroItemSerialNo: r.sroItemSerialNo, note: r.note, reviewed: r.reviewed })),
        auto: rules.indexOf(taxRules.autoRule(rules)), // index into options to fill in without asking, or -1
        standard: taxRules.STANDARD,
        last: last && { saleType: last.saleType, rate: last.rate, sroScheduleNo: last.sroScheduleNo, sroItemSerialNo: last.sroItemSerialNo, invoiceDate: last.invoice.invoiceDate },
    });
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

// ---------- Tax rules (HS code → sale type / rate), admin only ----------
const SALE_TYPES = [...new Set(SCENARIOS.map(s => s.saleType))];
app.get('/api/admin/tax-rules', authenticateToken, ADMIN, async (req, res) => {
    res.json(await prisma.hsTaxRule.findMany({ orderBy: { prefix: 'asc' } }));
});
app.post('/api/admin/tax-rules', authenticateToken, ADMIN, async (req, res) => {
    const b = req.body || {};
    const d = {
        prefix: taxRules.digitsOf(b.prefix),
        condition: String(b.condition || '').trim().slice(0, 300),
        saleType: String(b.saleType || '').trim(),
        rate: String(b.rate || '').trim().slice(0, 60),
        sroScheduleNo: String(b.sroScheduleNo || '').trim().slice(0, 100),
        sroItemSerialNo: String(b.sroItemSerialNo || '').trim().slice(0, 50),
        note: String(b.note || '').trim().slice(0, 300),
        reviewed: b.reviewed === true || b.reviewed === 'on' || b.reviewed === 'true',
        updatedBy: req.user.email,
    };
    if (d.prefix.length < 2 || d.prefix.length > 8) throw new HttpError(400, 'HS code (or its start) must be 2 to 8 digits, e.g. 3402 or 8471.3010.');
    if (!SALE_TYPES.includes(d.saleType)) throw new HttpError(400, 'Choose a sale type from the list.');
    try {
        const r = b.id
            ? await prisma.hsTaxRule.update({ where: { id: String(b.id) }, data: d })
            : await prisma.hsTaxRule.create({ data: d });
        taxRules.clearCache();
        await audit(req, { tenantId: null, action: 'taxrule.save', entityType: 'HsTaxRule', entityId: r.id,
            summary: `Tax rule ${r.prefix}${r.condition ? ` (${r.condition})` : ''} → ${r.saleType}${r.rate ? ', ' + r.rate : ''}${r.reviewed ? ' · checked' : ''}` });
        res.json(r);
    } catch (err) {
        if (err.code === 'P2002') throw new HttpError(400, `There is already a rule for ${d.prefix} with the same condition.`);
        if (err.code === 'P2025') throw new HttpError(404, 'Rule not found.');
        throw err;
    }
});
// Tax rules data bank: every client's current tax rule against each item, with the client's name and industry
// from their DI settings (the rest as the client defined it)
app.get('/api/admin/item-tax-rules', authenticateToken, ADMIN, async (req, res) => {
    const items = await prisma.product.findMany({
        where: { saleType: { not: '' } },
        include: { tenant: { select: { id: true, companyName: true, sellerBusinessName: true, businessActivities: true, sectors: true, sellerNtnCnic: true, sellerNtn: true, sellerCnic: true, sellerStrn: true } } },
        orderBy: [{ tenantId: 'asc' }, { name: 'asc' }],
        take: 10000,
    });
    res.json(items.map(({ tenant: t, ...p }) => ({
        id: p.id, tenantId: t.id, userName: t.sellerBusinessName || t.companyName, industry: industryOf(t),
        userNtn: t.sellerNtn, userCnic: t.sellerCnic, userStrn: t.sellerStrn,
        // the same item details the client sees on Items with Tax Rules
        name: p.name, description: p.description, notes: p.notes, hsCode: p.hsCode, source: p.source, uoM: p.uoM, prices: p.prices, unitPrice: p.unitPrice,
        saleType: p.saleType, rate: p.rate, lawRefs: p.lawRefs, sroScheduleNo: p.sroScheduleNo, taxComment: p.taxComment, extraTaxes: p.extraTaxes, taxRuleAt: p.taxRuleAt,
    })));
});
// Tax rule history of any client's item (Data Bank → Since → History)
app.get('/api/admin/products/:id/tax-rules', authenticateToken, ADMIN, async (req, res) => {
    res.json(await prisma.productTaxRule.findMany({ where: { productId: req.params.id }, orderBy: { createdAt: 'desc' } }));
});
app.delete('/api/admin/tax-rules/:id', authenticateToken, ADMIN, async (req, res) => {
    const r = await prisma.hsTaxRule.delete({ where: { id: req.params.id } }).catch(() => null);
    if (!r) throw new HttpError(404, 'Rule not found.');
    taxRules.clearCache();
    await audit(req, { tenantId: null, action: 'taxrule.delete', entityType: 'HsTaxRule', entityId: r.id, summary: `Tax rule ${r.prefix} (${r.saleType}) deleted` });
    res.json({ deleted: true });
});

// Check a seller NTN/CNIC/STRN with FBR (registered? active?) using that client's token
app.get('/api/admin/clients/:id/check-registration', authenticateToken, ADMIN, async (req, res) => {
    const reg = String(req.query.reg || '').replace(/\D/g, '');
    if (!NTN_LENGTHS.includes(reg.length)) throw new HttpError(400, 'Enter a 7/9-digit NTN, 13-digit CNIC or 13-digit STRN first.');
    const t = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!t) throw new HttpError(404, 'Client not found.');
    res.json(await fbr.checkBuyer(reg, todayPKT(), tenantToken(t)));
});

// ---------- Invoice drafts ----------
// Saved forms, not invoices: they use no invoice number and are never sent to FBR. Every role may keep drafts.
const MAX_DRAFTS = 200;
app.get('/api/drafts', authenticateToken, requireTenant, async (req, res) => {
    const list = await prisma.invoiceDraft.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { updatedAt: 'desc' } });
    res.json(list.map(d => ({ id: d.id, title: d.title, totalAmount: Number(d.totalAmount), items: Array.isArray(d.data?.items) ? d.data.items.length : 0,
        invoiceType: d.data?.invoiceType || 'Sale Invoice', createdBy: d.createdBy, updatedAt: d.updatedAt })));
});
app.get('/api/drafts/:id', authenticateToken, requireTenant, async (req, res) => {
    const d = await prisma.invoiceDraft.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!d) throw new HttpError(404, 'Draft not found — it may have been filed or deleted.');
    res.json(d);
});
app.post('/api/drafts', authenticateToken, requireTenant, async (req, res) => {
    const b = req.body || {}, tenantId = req.user.tenantId;
    if (!b.data || typeof b.data !== 'object' || !Array.isArray(b.data.items)) throw new HttpError(400, 'Nothing to save.');
    if (JSON.stringify(b.data).length > 200000) throw new HttpError(400, 'This draft is too large to save.');
    const total = Number(b.totalAmount);
    const d = { title: String(b.data.buyerBusinessName || '').trim().slice(0, 200) || 'Walk-in Customer', data: b.data,
        totalAmount: Number.isFinite(total) && total >= 0 && total < 1e12 ? Math.round(total * 100) / 100 : 0 };
    let draft;
    if (b.id) {
        const { count } = await prisma.invoiceDraft.updateMany({ where: { id: String(b.id), tenantId }, data: d });
        if (!count) throw new HttpError(404, 'Draft not found — it may have been filed or deleted. Save again to keep a new copy.');
        draft = await prisma.invoiceDraft.findUnique({ where: { id: String(b.id) } });
    } else {
        if (await prisma.invoiceDraft.count({ where: { tenantId } }) >= MAX_DRAFTS) throw new HttpError(400, `You have ${MAX_DRAFTS} drafts. File or delete some first.`);
        draft = await prisma.invoiceDraft.create({ data: { ...d, tenantId, createdBy: req.user.email } });
    }
    await audit(req, { action: 'invoice.draft_save', entityType: 'InvoiceDraft', entityId: draft.id, summary: `Draft saved — ${draft.title}, Rs ${Number(draft.totalAmount).toFixed(2)}` });
    res.json({ id: draft.id, updatedAt: draft.updatedAt });
});
app.delete('/api/drafts/:id', authenticateToken, requireTenant, async (req, res) => {
    const d = await prisma.invoiceDraft.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, select: { id: true, title: true } });
    if (!d) throw new HttpError(404, 'Draft not found.');
    await prisma.invoiceDraft.delete({ where: { id: d.id } });
    await audit(req, { action: 'invoice.draft_delete', entityType: 'InvoiceDraft', entityId: d.id, summary: `Draft deleted — ${d.title}` });
    res.json({ deleted: true });
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
    // NTN, CNIC and STRN come separately (like the Buyers page); FBR gets one number: the NTN, else the CNIC
    const digitsOf = v => String(v || '').replace(/\D/g, '');
    let buyerNtn = digitsOf(b.buyerNtn), buyerCnic = digitsOf(b.buyerCnic);
    const buyerStrn = digitsOf(b.buyerStrn), single = digitsOf(b.buyerNtnCnic); // single box: bulk import, older drafts
    if (!buyerNtn && !buyerCnic && single) { if (single.length === 13) buyerCnic = single; else buyerNtn = single; }
    const buyerNtnCnic = buyerNtn || buyerCnic;
    // FBR DI API v1.12 error 0058: the buyer can't be the seller itself
    const sellerNo = String(tenant.sellerNtnCnic || '').replace(/\D/g, '');
    if (sellerNo && [buyerNtn, buyerCnic].includes(sellerNo)) fail('Self-invoicing is not allowed — the buyer NTN / CNIC is your own (FBR rule 0058).');
    const endConsumer = buyerRegistrationType === 'Unregistered' && b.endConsumer === true;
    const buyerNonAtl = buyerRegistrationType === 'Registered' && b.buyerNonAtl === true;
    if (buyerRegistrationType === 'Registered' && !NTN_LENGTHS.includes(buyerNtnCnic.length)) {
        fail('Registered buyer needs NTN (7 or 9 digits) or CNIC (13 digits).');
    }
    if (buyerNtnCnic && !NTN_LENGTHS.includes(buyerNtnCnic.length)) fail('Buyer NTN must be 7 or 9 digits, or CNIC 13 digits.');
    if (buyerNtn && ![7, 9].includes(buyerNtn.length)) fail('Buyer NTN must be 7 or 9 digits.');
    if (buyerCnic && buyerCnic.length !== 13) fail('Buyer CNIC must be 13 digits.');
    if (buyerStrn && ![7, 9, 13].includes(buyerStrn.length)) fail('Buyer STRN must be 13 digits.');
    const buyerMobile = String(b.buyerMobile || '').trim().replace(/(?!^\+)[^\d]/g, '');
    if (buyerMobile && (buyerMobile.replace(/\D/g, '').length < 10 || buyerMobile.replace(/\D/g, '').length > 15)) fail('Buyer mobile number must be 10 to 15 digits (e.g. 03001234567).');
    const buyerEmail = String(b.buyerEmail || '').trim().toLowerCase();
    if (buyerEmail && (buyerEmail.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail))) fail('Buyer email address looks wrong.');
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
        calc = calcInvoice(b.items, { buyerRegistrationType, endConsumer, buyerNonAtl, furtherTaxRate: Number(tenant.furtherTaxRate) }, b.discount);
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
        buyerNtnCnic, buyerNtn, buyerCnic, buyerStrn, buyerMobile, buyerEmail,
        buyerNote: String(b.buyerNote || '').trim().slice(0, 500),
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

    if (b.invoiceType === 'Debit Note' && req.user.tenantRole === 'CASHIER') throw new HttpError(403, 'Only the owner or accountant can issue debit notes.');
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

    // Filed from a draft: the invoice now exists (filed or retryable), so the draft goes
    if (b.draftId) await prisma.invoiceDraft.deleteMany({ where: { id: String(b.draftId), tenantId: tenant.id } });
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
    if (confirmed && req.user.tenantRole === 'CASHIER') throw new HttpError(403, 'Only the owner or accountant can resubmit an invoice that may already be in IRIS.');
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
app.post('/api/invoices/:id/resolve', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
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
app.post('/api/invoices/:id/unqueue', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
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
app.post('/api/invoices/:id/cancel', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
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

app.get('/api/import/template', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="invoice-import-template.csv"' });
    res.send(importer.templateCsv(tenant.fbrEnv === 'SANDBOX'));
});

app.post('/api/import/preview', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const tenant = await importTenant(req);
    const { results, unknownHeaders } = await evaluateImport(tenant, req.body?.rows);
    res.json(importSummary(results, unknownHeaders));
});

// Save the valid invoices as QUEUED; the background sender files them with FBR one by one
app.post('/api/import/commit', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
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

app.get('/api/import/batches', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const batches = await prisma.importBatch.findMany({ where: { tenantId: req.user.tenantId }, orderBy: { createdAt: 'desc' }, take: 20 });
    const counts = await prisma.invoice.groupBy({
        by: ['batchId', 'status'], where: { batchId: { in: batches.map(b => b.id) } }, _count: { _all: true },
    });
    res.json(batches.map(b => ({
        ...b,
        counts: Object.fromEntries(counts.filter(c => c.batchId === b.id).map(c => [c.status, c._count._all])),
    })));
});

app.get('/api/import/batches/:id', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
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

// ---------- Stock (purchases, imports, opening, adjustments) → Annex-H1 ----------
const isYmd = v => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return false;
    const [y, m, d] = v.split('-').map(Number), dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
app.get('/api/stock/entries', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const q = req.query, where = { tenantId: req.user.tenantId };
    if (isYmd(q.from) || isYmd(q.to)) where.entryDate = { ...(isYmd(q.from) && { gte: q.from }), ...(isYmd(q.to) && { lte: q.to }) };
    const text = String(q.q || '').trim();
    if (text) where.OR = [{ hsCode: { startsWith: hs.normalizeCode(text) || text } }, { description: { contains: text, mode: 'insensitive' } },
        { reference: { contains: text, mode: 'insensitive' } }, { partyName: { contains: text, mode: 'insensitive' } }];
    res.json(await prisma.stockEntry.findMany({ where, orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }], take: 200 }));
});
app.post('/api/stock/entries', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const b = req.body || {};
    if (!stock.ENTRY_TYPES.includes(b.entryType)) throw new HttpError(400, 'Choose the entry type.');
    if (!isYmd(b.entryDate)) throw new HttpError(400, 'Enter a valid date.');
    const hsCode = hs.normalizeCode(b.hsCode || '');
    if (!hs.HS_FORMAT.test(hsCode)) throw new HttpError(400, 'HS code must look like 0101.2100');
    const uoM = String(b.uoM || '').trim();
    if (!uoM) throw new HttpError(400, 'UOM is required.');
    const quantity = Number(String(b.quantity ?? '').replace(/,/g, '')), value = Number(String(b.value ?? '0').replace(/,/g, '') || 0);
    if (!(quantity > 0)) throw new HttpError(400, 'Quantity must be more than 0.');
    if (!(value >= 0)) throw new HttpError(400, 'Value must be 0 or more.');
    const e = await prisma.stockEntry.create({ data: {
        tenantId: req.user.tenantId, entryType: b.entryType, entryDate: b.entryDate, hsCode, uoM, quantity, value,
        description: String(b.description || '').trim().slice(0, 200), reference: String(b.reference || '').trim().slice(0, 100),
        partyName: String(b.partyName || '').trim().slice(0, 150), notes: String(b.notes || '').trim().slice(0, 500), createdBy: req.user.email || '',
    } });
    await audit(req, { action: 'stock.create', entityType: 'StockEntry', entityId: e.id, summary: `Stock ${e.entryType.toLowerCase().replace('_', ' ')}: ${Number(e.quantity)} ${e.uoM} of ${e.hsCode}${e.description ? ' (' + e.description + ')' : ''}, Rs ${Number(e.value).toFixed(2)}, ${e.entryDate}${e.reference ? ', ref ' + e.reference : ''}` });
    res.json(e);
});
app.delete('/api/stock/entries/:id', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const e = await prisma.stockEntry.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!e) throw new HttpError(404, 'Entry not found.');
    await prisma.stockEntry.delete({ where: { id: e.id } });
    await audit(req, { action: 'stock.delete', entityType: 'StockEntry', entityId: e.id, summary: `Stock entry deleted: ${e.entryType.toLowerCase()} ${Number(e.quantity)} ${e.uoM} of ${e.hsCode} (${e.entryDate})`, details: { entry: { ...e, quantity: Number(e.quantity), value: Number(e.value) } } });
    res.json({ deleted: true });
});
// Current stock per HS code / UOM (up to today, current environment's filed sales)
app.get('/api/stock/summary', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId }, select: { fbrEnv: true } });
    const today = todayPKT();
    res.json(await stock.statement(prisma, req.user.tenantId, { from: today, to: today, fbrEnv: t.fbrEnv }));
});
// Annex-H1 stock statement for a month (admin, per client)
app.get('/api/admin/clients/:id/annex-h', authenticateToken, requireRole('SUPER_ADMIN'), async (req, res) => {
    const range = annexC.monthRange(String(req.query.month || ''));
    if (!range) throw new HttpError(400, 'Choose a month (YYYY-MM).');
    const fbrEnv = req.query.env === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION';
    const tenant = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!tenant) throw new HttpError(404, 'Client not found.');
    const rows = await stock.statement(prisma, tenant.id, { ...range, fbrEnv });
    if (req.query.format === 'csv') {
        const slug = tenant.companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'client';
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="annex-h1-${slug}-${req.query.month}-${fbrEnv.toLowerCase()}.csv"` });
        await audit(req, { tenantId: tenant.id, action: 'report.annex_h', summary: `Annex-H1 downloaded: ${req.query.month}, ${fbrEnv}, ${rows.length} lines` });
        return res.send(stock.toCsv(rows));
    }
    res.json({ month: req.query.month, fbrEnv, rows, negative: rows.filter(r => r.negative).length });
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

// Annexure-C for the client's sales tax return: every invoice filed with FBR (issued) in a date range — one row per
// item, as IRIS lays out Annex-C (Domestic Sales Invoices). The browser writes the Excel file.
app.get('/api/client/annex-c', authenticateToken, requireTenant, async (req, res) => {
    const q = req.query, isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    const where = { tenantId: tenant.id, status: 'SUBMITTED', fbrEnv: tenant.fbrEnv };
    if (isDate(q.from) || isDate(q.to)) where.invoiceDate = { ...(isDate(q.from) && { gte: q.from }), ...(isDate(q.to) && { lte: q.to }) };
    if (q.type) where.invoiceType = String(q.type);
    const invoices = await prisma.invoice.findMany({ where, orderBy: [{ invoiceDate: 'asc' }, { localNo: 'asc' }], include: ITEMS, take: 20000 });
    const rows = annexC.rows(invoices, tenant.sellerProvince);
    const dates = invoices.map(i => i.invoiceDate);
    await audit(req, { action: 'report.annex_c', summary: `Annexure-C downloaded: ${q.from || dates[0] || '…'} to ${q.to || dates[dates.length - 1] || '…'}, ${invoices.length} invoices, ${rows.length} lines` });
    res.json({ seller: { ntn: tenant.sellerNtn || tenant.sellerNtnCnic, cnic: tenant.sellerCnic, name: tenant.sellerBusinessName || tenant.companyName },
        env: tenant.fbrEnv, from: isDate(q.from) ? q.from : dates[0] || '', to: isDate(q.to) ? q.to : dates[dates.length - 1] || '',
        invoices: invoices.length, rows, totals: annexC.totals(rows) });
});

// ---------- Buyer check with FBR (STATL + Get_Reg_Type) ----------
// DI Rules #26: decide Registered/Unregistered and active (ATL) status from FBR, which drives further tax
app.get('/api/buyers/check', authenticateToken, requireTenant, async (req, res) => {
    const reg = String(req.query.ntn || '').replace(/\D/g, '');
    if (!NTN_LENGTHS.includes(reg.length)) throw new HttpError(400, 'Enter a 7/9-digit NTN or 13-digit CNIC.');
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: req.user.tenantId } });
    const r = await fbr.checkBuyer(reg, todayPKT(), tenantToken(t));
    res.json(r);
});

// ---------- Sales Tax Act and Rules, SROs, circulars, general orders, notices from fbr.gov.pk (searchable on the Items with Tax Rules page) ----------
const LEGAL_SOURCES = ['ACT', 'RULES', 'SRO', 'CIRCULAR', 'GENERAL_ORDER', 'NOTICE'];
app.get('/api/legal-refs', authenticateToken, async (req, res) => {
    const words = String(req.query.q || '').trim().split(/\s+/).filter(w => w.length > 0).slice(0, 6);
    const where = {};
    if (LEGAL_SOURCES.includes(req.query.source)) where.source = req.query.source;
    if (words.length) where.AND = words.map(w => ({ OR: [{ refNo: { contains: w, mode: 'insensitive' } }, { title: { contains: w, mode: 'insensitive' } }] }));
    const orderBy = [{ issuedOn: { sort: 'desc', nulls: 'last' } }, { refNo: 'desc' }];
    // The Act and the Rules first (a few editions, newest first), then SROs, circulars … — 25 in all
    const law = where.source ? [] : await prisma.legalReference.findMany({ where: { ...where, source: { in: ['ACT', 'RULES'] } }, orderBy, take: 6 });
    const rest = await prisma.legalReference.findMany({ where: where.source ? where : { ...where, source: { notIn: ['ACT', 'RULES'] } }, orderBy, take: 25 - law.length });
    res.json([...law, ...rest].map(r => ({ ...r, reference: fbrRefs.referenceText(r) })));
});
async function legalStats() {
    const g = await prisma.legalReference.groupBy({ by: ['source'], _count: { _all: true }, _max: { fetchedAt: true } });
    return Object.fromEntries(g.map(x => [x.source, { count: x._count._all, fetchedAt: x._max.fetchedAt }]));
}
app.get('/api/admin/legal-refs/stats', authenticateToken, ADMIN, async (req, res) => res.json(await legalStats()));
let legalSyncRunning = null;
function syncLegalRefs() {
    if (!legalSyncRunning) legalSyncRunning = fbrRefs.sync(prisma).finally(() => { legalSyncRunning = null; });
    return legalSyncRunning;
}
app.post('/api/admin/legal-refs/sync', authenticateToken, ADMIN, async (req, res) => {
    const result = await syncLegalRefs();
    await audit(req, { tenantId: null, action: 'admin.legal_refs_sync', summary: `FBR references refreshed: ${Object.entries(result).map(([k, v]) => `${k} ${v}`).join(', ')}`, details: result });
    res.json({ result, stats: await legalStats() });
});
// Refresh once a day (checked every 6 hours, and at start-up — the free Render server sleeps)
async function legalSyncIfStale() {
    const last = await prisma.legalReference.aggregate({ _max: { fetchedAt: true } }).catch(() => null);
    const at = last?._max.fetchedAt;
    if (!at || Date.now() - at.getTime() > 24 * 3600 * 1000) {
        const r = await syncLegalRefs().catch(err => ({ error: err.message }));
        console.log('FBR references refreshed:', JSON.stringify(r));
    }
}
if (process.env.NODE_ENV !== 'test') {
    setTimeout(() => legalSyncIfStale().catch(() => {}), 15000);
    setInterval(() => legalSyncIfStale().catch(() => {}), 6 * 3600 * 1000);
}

// ---------- Guideline buttons on the client's Items with Tax Rules page (admin edits them) ----------
app.get('/api/guidelines', authenticateToken, async (req, res) => {
    const [links, note] = await Promise.all([
        prisma.guideLink.findMany({ orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] }),
        prisma.appSetting.findUnique({ where: { key: 'guidelinesNote' } }),
    ]);
    res.json({ links, note: note?.value || '' });
});
app.post('/api/admin/guidelines', authenticateToken, ADMIN, async (req, res) => {
    const b = req.body || {};
    const d = { label: String(b.label || '').trim().slice(0, 80), url: String(b.url || '').trim().slice(0, 1000),
        sortOrder: Number.isFinite(Number(b.sortOrder)) ? Math.round(Number(b.sortOrder)) : 0, updatedBy: req.user.email };
    if (!d.label) throw new HttpError(400, 'Enter the button text.');
    if (!/^https?:\/\/[^\s]+$/i.test(d.url)) throw new HttpError(400, 'The link must start with https:// (or http://).');
    const g = b.id
        ? await prisma.guideLink.update({ where: { id: String(b.id) }, data: d }).catch(() => { throw new HttpError(404, 'Guideline not found.'); })
        : await prisma.guideLink.create({ data: d });
    await audit(req, { tenantId: null, action: 'admin.guideline_save', entityType: 'GuideLink', entityId: g.id, summary: `Guideline "${g.label}" → ${g.url}` });
    res.json(g);
});
app.delete('/api/admin/guidelines/:id', authenticateToken, ADMIN, async (req, res) => {
    const g = await prisma.guideLink.delete({ where: { id: req.params.id } }).catch(() => null);
    if (!g) throw new HttpError(404, 'Guideline not found.');
    await audit(req, { tenantId: null, action: 'admin.guideline_delete', entityType: 'GuideLink', entityId: g.id, summary: `Guideline "${g.label}" deleted` });
    res.json({ deleted: true });
});
app.put('/api/admin/guidelines/note', authenticateToken, ADMIN, async (req, res) => {
    const value = String(req.body?.value || '').trim().slice(0, 1000);
    await prisma.appSetting.upsert({ where: { key: 'guidelinesNote' }, update: { value, updatedBy: req.user.email }, create: { key: 'guidelinesNote', value, updatedBy: req.user.email } });
    await audit(req, { tenantId: null, action: 'admin.guideline_note', summary: 'Guideline note changed', details: { note: value } });
    res.json({ value });
});

// ---------- Items and their tax rules ----------
// Phase 1: the client sets the tax on each item; ETAX doesn't decide it from the HS code. Only items with a tax rule
// are offered on the invoice form.
function itemData(b) {
    // An item can have several prices (e.g. retail / wholesale); the first is also its unitPrice
    // CA: every item field is required — each price needs a name and an amount, and an item needs at least one price
    let prices = Array.isArray(b.prices) ? b.prices : b.unitPrice !== '' && b.unitPrice != null ? [{ label: 'Price', price: b.unitPrice }] : [];
    prices = prices.filter(x => x && (String(x.label ?? '').trim() || (x.price !== '' && x.price != null)));
    if (prices.some(x => !String(x.label ?? '').trim() || x.price === '' || x.price == null)) throw new HttpError(400, 'Each price needs a name and an amount.');
    prices = prices.map(x => ({ label: String(x.label).trim().slice(0, 40), price: Number(x.price) }));
    if (!prices.length) throw new HttpError(400, 'Add at least one price (name and amount).');
    if (prices.length > 100) throw new HttpError(400, 'An item can have up to 100 prices.');
    if (prices.some(x => !Number.isFinite(x.price) || x.price < 0)) throw new HttpError(400, 'Prices must be numbers of 0 or more.');
    const d = {
        name: String(b.name || '').trim(),
        description: String(b.description ?? '').trim(),
        notes: String(b.notes ?? '').trim(),
        hsCode: hs.normalizeCode(b.hsCode || ''),
        hsDescription: String(b.hsDescription ?? '').trim().slice(0, 500),
        uoM: String(b.uoM || '').trim(),
        prices, unitPrice: prices.length ? prices[0].price : null,
    };
    if (!d.name || d.name.length > 200) throw new HttpError(400, 'Item name is required (max 200 characters).');
    if (!d.description || d.description.length > 500) throw new HttpError(400, 'Item description is required (max 500 characters).');
    if (!d.notes || d.notes.length > 1000) throw new HttpError(400, 'Item notes are required (max 1000 characters).');
    if (!hs.HS_FORMAT.test(d.hsCode)) throw new HttpError(400, 'HS code must look like 0101.2100');
    if (!d.uoM) throw new HttpError(400, 'UOM is required.');
    if (d.unitPrice !== null && (!Number.isFinite(d.unitPrice) || d.unitPrice < 0)) throw new HttpError(400, 'Unit price must be a non-negative number.');
    return d;
}
// notifiedRate: the notified price per unit (above or below the actual price). When set, the invoice uses it as the
// line's rate (CA: "invoice should show the notified rate if applicable, else the normal rate"). Empty = none.
// lawRefs: the documents the client read (Act, Rules, SROs, circulars …), each with their comment on the law.
// The first one is what FBR gets as the SRO / Schedule no.; older callers send just sroScheduleNo.
function lawRefsData(b) {
    const text = (v, n) => String(v ?? '').trim().slice(0, n);
    const list = Array.isArray(b.lawRefs) ? b.lawRefs : b.sroScheduleNo ? [{ reference: b.sroScheduleNo }] : [];
    if (list.length > 20) throw new HttpError(400, 'At most 20 references per item.');
    return list.map(x => ({
        reference: text(x?.reference, 200), url: /^https?:\/\//i.test(String(x?.url || '')) ? text(x.url, 1000) : '',
        source: text(x?.source, 20), comment: text(x?.comment, 2000),
    })).filter(x => x.reference);
}
// Postgres stores JSON keys in its own order, so compare the values
const refKey = list => JSON.stringify((Array.isArray(list) ? list : []).map(x => [x.reference, x.url, x.source, x.comment]));
const sameLawRefs = (a, b) => refKey(a) === refKey(b);
const taxKey = list => JSON.stringify((Array.isArray(list) ? list : []).map(x => [x.name, x.kind, Number(x.value), x.base, x.fbrField, refKey(x.refs), x.comment || '']));
const sameExtraTaxes = (a, b) => taxKey(a) === taxKey(b);
function taxRuleData(b, saleTypes) {
    const nr = b.notifiedRate === '' || b.notifiedRate == null ? null : Number(String(b.notifiedRate).replace(/,/g, ''));
    const lawRefs = lawRefsData(b);
    const r = {
        saleType: String(b.saleType || '').trim(),
        rate: String(b.rate || '').trim().slice(0, 60),
        // FBR's own SRO / Schedule (picked from SroSchedule, spec §5.7) when the list was available; else the one typed;
        // else (older screens / files) the first reference — references themselves are optional
        sroScheduleNo: String(b.fbrSroDesc || b.sroScheduleNo || lawRefs[0]?.reference || '').trim().slice(0, 100),
        fbrRateId: Number.isInteger(Number(b.fbrRateId)) && String(b.fbrRateId) !== '' ? Number(b.fbrRateId) : null,
        fbrSroId: Number.isInteger(Number(b.fbrSroId)) && String(b.fbrSroId) !== '' && b.fbrSroDesc ? Number(b.fbrSroId) : null,
        sroItemSerialNo: String(b.sroItemSerialNo || '').trim().slice(0, 50),
        notifiedRate: nr === null ? null : Math.round(nr * 100) / 100,
        lawRefs,
        taxComment: String(b.taxComment ?? '').trim().slice(0, 2000),
        extraTaxes: (() => { try { return cleanExtraTaxes(b.extraTaxes); } catch (err) { throw new HttpError(400, err.message); } })(),
    };
    if (!saleTypes.includes(r.saleType)) throw new HttpError(400, 'Choose a sale type from the list.');
    if (nr !== null && !(nr > 0 && nr < 1e10)) throw new HttpError(400, 'Notified rate must be an amount per unit, more than 0 (or leave it empty).');
    if (!r.rate) throw new HttpError(400, 'Enter the tax rate, e.g. 18%, 10% or Exempt.');
    // FBR DI API v1.12: exempt / reduced rate / SRO lines need the SRO no. and item serial (0077 / 0078);
    // 3rd schedule goods need the retail price (0090 / 0102) — kept as the item's retail price per unit (notifiedRate)
    if (SRO_REQUIRED_SALE_TYPES.has(r.saleType) && !r.sroScheduleNo) {
        throw new HttpError(400, `"${r.saleType}" needs the SRO / Schedule no. (FBR rule 0077).`);
    }
    if (SRO_REQUIRED_SALE_TYPES.has(r.saleType) && !r.sroItemSerialNo) {
        throw new HttpError(400, `"${r.saleType}" needs the item serial no. from the reference (FBR rule 0078).`);
    }
    if (r.saleType === '3rd Schedule Goods' && !(r.notifiedRate > 0)) {
        throw new HttpError(400, '3rd schedule goods need the retail price per unit (FBR rule 0090).');
    }
    return r;
}
// Sale types: FBR's own list (transtypecode) when the client's token works, else the DI spec's list
async function saleTypeList(tenantId) {
    const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
    let live = null;
    try { live = await fbr.reference('transtypecode', t && tenantToken(t)); } catch { live = null; }
    const names = (live || []).map(x => String(x.transactioN_DESC || x.transactionDesc || x.description || '').trim()).filter(Boolean);
    return { live: names.length > 0, list: names.length ? [...new Set(names)] : SALE_TYPES };
}
app.get('/api/sale-types', authenticateToken, requireTenant, async (req, res) => res.json(await saleTypeList(req.user.tenantId)));

// FBR DI API v1.12 chain for an item's tax: sale type → rates (§5.8) → SRO schedules (§5.7) → SRO item serials (§5.10).
// Each answers { live, list }; live:false (mock mode, no token, FBR error) means the screen lets the user type instead.
async function fbrChainContext(tenantId) {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const token = tenantToken(t);
    const provinces = await fbr.reference('provinces', token).catch(() => null);
    const prov = (provinces || []).find(p => String(p.stateProvinceDesc || '').toUpperCase() === String(t.sellerProvince || '').toUpperCase());
    return { token, provinceCode: prov?.stateProvinceCode ?? null };
}
const chainReply = (res, list) => res.json({ live: Array.isArray(list) && list.length > 0, list: list || [] });
app.get('/api/fbr/rates', authenticateToken, requireTenant, async (req, res) => {
    const { token, provinceCode } = await fbrChainContext(req.user.tenantId);
    const types = await fbr.reference('transtypecode', token).catch(() => null);
    const want = String(req.query.saleType || '').trim().toLowerCase();
    const type = (types || []).find(x => String(x.transactioN_DESC || '').trim().toLowerCase() === want);
    if (!type || provinceCode == null) return chainReply(res, null);
    chainReply(res, await fbr.saleTypeRates(token, { transTypeId: type.transactioN_TYPE_ID, provinceCode }).catch(() => null));
});
app.get('/api/fbr/sro', authenticateToken, requireTenant, async (req, res) => {
    const { token, provinceCode } = await fbrChainContext(req.user.tenantId);
    const rateId = Number(req.query.rateId);
    if (!Number.isInteger(rateId) || provinceCode == null) return chainReply(res, null);
    chainReply(res, await fbr.sroSchedules(token, { rateId, provinceCode }).catch(() => null));
});
app.get('/api/fbr/sro-items', authenticateToken, requireTenant, async (req, res) => {
    const { token } = await fbrChainContext(req.user.tenantId);
    const sroId = Number(req.query.sroId);
    if (!Number.isInteger(sroId)) return chainReply(res, null);
    chainReply(res, await fbr.sroItems(token, { sroId }).catch(() => null));
});

// Codes found in the FBR / PCT list are Official; anything else was made up by the client
async function hsSource(code) {
    return (await prisma.hsCode.findUnique({ where: { code }, select: { code: true } })) ? 'OFFICIAL' : 'CUSTOMER';
}
// New current rule for an item; the previous one stays in the history
// Field lists for the change history (item details / its tax rule)
const ITEM_DETAIL_FIELDS = importMerge.ITEM_FIELDS.filter(f => !importMerge.RULE_KEYS.has(f.key));
const ITEM_RULE_FIELDS = importMerge.ITEM_FIELDS.filter(f => importMerge.RULE_KEYS.has(f.key));
async function setTaxRule(req, product, r) {
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: product.tenantId }, select: { businessActivities: true, sectors: true } });
    const changes = importMerge.diffRecord(itemImport.savedItem(product), itemImport.savedItem(r), ITEM_RULE_FIELDS);
    const [rule, updated] = await prisma.$transaction([
        prisma.productTaxRule.create({ data: { ...r, tenantId: product.tenantId, productId: product.id, industry: industryOf(t), createdBy: req.user.email } }),
        prisma.product.update({ where: { id: product.id }, data: { ...r, taxRuleAt: new Date() } }),
    ]);
    await audit(req, { action: 'product.tax_rule', entityType: 'Product', entityId: product.id, details: { changes },
        summary: `Tax rule for "${product.name}": ${r.saleType}, ${r.rate}${r.extraTaxes?.length ? `, more taxes: ${r.extraTaxes.map(t => t.name).join(', ')}` : ''}${r.notifiedRate != null ? `, notified rate ${r.notifiedRate} per unit` : ''}${r.sroScheduleNo ? `, ${r.sroScheduleNo} S.No ${r.sroItemSerialNo}` : ''}` });
    return { rule, item: updated };
}

// q: name or HS code. withRule=1: only items that can go on an invoice. source=OFFICIAL|CUSTOMER
app.get('/api/products', authenticateToken, requireTenant, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const where = { tenantId: req.user.tenantId };
    if (q) where.OR = [{ name: { contains: q, mode: 'insensitive' } }, { hsCode: { startsWith: hs.normalizeCode(q) || q } }];
    if (req.query.withRule === '1') where.saleType = { not: '' };
    if (['OFFICIAL', 'CUSTOMER'].includes(req.query.source)) where.source = req.query.source;
    res.json(await prisma.product.findMany({ where, orderBy: { name: 'asc' }, take: q ? 20 : 1000 }));
});

// Save an item. With id: edit it. Without id: add it, or update the one with the same name.
// saleType + rate in the body (e.g. "Save as item" from an invoice row) also set its tax rule.
app.post('/api/products', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const b = req.body || {}, tenantId = req.user.tenantId;
    const d = itemData(b);
    const rule = b.saleType || b.rate ? taxRuleData(b, (await saleTypeList(tenantId)).list) : null;
    // FBR DI API v1.12 error 0099: the unit must be one FBR allows for the HS code (HS_UOM, §5.9) — checked when FBR answers
    {
        const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
        const allowed = await fbr.hsUom(d.hsCode, tenantToken(t)).catch(() => null);
        if (Array.isArray(allowed) && allowed.length && !allowed.some(u => u.toLowerCase() === d.uoM.toLowerCase())) {
            throw new HttpError(400, `FBR allows only ${allowed.join(' / ')} as the unit for HS code ${d.hsCode} (FBR rule 0099).`);
        }
    }
    // The same HS code may be used again only with another sale type (CA)
    if (rule) {
        const dup = await prisma.product.findFirst({ where: { tenantId, hsCode: d.hsCode, saleType: rule.saleType, NOT: b.id ? { id: String(b.id) } : { name: d.name } }, select: { name: true } });
        if (dup) throw new HttpError(409, `HS code ${d.hsCode} with sale type "${rule.saleType}" is already used by "${dup.name}".`);
    }
    d.source = await hsSource(d.hsCode);
    // an official code always carries FBR's own description; a code the client created keeps theirs
    if (d.source === 'OFFICIAL') d.hsDescription = (await prisma.hsCode.findUnique({ where: { code: d.hsCode }, select: { description: true } }))?.description || d.hsDescription;
    try {
        let p;
        const before = await prisma.product.findFirst({ where: b.id ? { id: String(b.id), tenantId } : { tenantId, name: d.name } });
        if (b.id) {
            const { count } = await prisma.product.updateMany({ where: { id: String(b.id), tenantId }, data: d });
            if (!count) throw new HttpError(404, 'Item not found.');
            p = await prisma.product.findUnique({ where: { id: String(b.id) } });
        } else {
            p = await prisma.product.upsert({ where: { tenantId_name: { tenantId, name: d.name } }, update: d, create: { ...d, tenantId } });
        }
        const changes = before ? importMerge.diffRecord(itemImport.savedItem(before), itemImport.savedItem(p), ITEM_DETAIL_FIELDS) : [];
        if (!before || changes.length) await audit(req, { action: 'product.save', entityType: 'Product', entityId: p.id, details: { changes, created: !before },
            summary: `Item "${p.name}" ${before ? 'updated' : 'added'} (${p.hsCode}, ${p.source === 'CUSTOMER' ? 'customer-created code' : 'official code'}${p.unitPrice != null ? `, Rs ${p.unitPrice}` : ''})` });
        const same = rule && p.saleType === rule.saleType && p.rate === rule.rate && p.sroScheduleNo === rule.sroScheduleNo
            && p.sroItemSerialNo === rule.sroItemSerialNo && (p.notifiedRate == null ? null : Number(p.notifiedRate)) === rule.notifiedRate
            && sameLawRefs(p.lawRefs, rule.lawRefs) && sameExtraTaxes(p.extraTaxes, rule.extraTaxes) && (p.taxComment || '') === rule.taxComment
            && (p.fbrRateId ?? null) === rule.fbrRateId && (p.fbrSroId ?? null) === rule.fbrSroId;
        if (rule && !same) p = (await setTaxRule(req, p, rule)).item;
        res.json(p);
    } catch (err) {
        if (err.code === 'P2002') throw new HttpError(400, `Another item is already named "${d.name}".`);
        throw err;
    }
});

// ---------- Items from the Excel template: check first, then import (all or nothing) ----------
async function checkItemImport(tenantId, body) {
    const [{ list: saleTypes }, existing, codes, refs] = await Promise.all([
        saleTypeList(tenantId),
        prisma.product.findMany({ where: { tenantId } }), // whole items: a row for a saved item is compared field by field
        prisma.hsCode.findMany({ select: { code: true } }),
        prisma.legalReference.findMany({ select: { source: true, refNo: true, title: true, url: true } }),
    ]);
    // A reference typed in Excel is matched to FBR's list (its number or title) to keep the PDF link
    const byText = new Map();
    for (const r of refs) {
        const ref = { reference: fbrRefs.referenceText(r).slice(0, 200), url: r.url, source: r.source };
        for (const k of [ref.reference, r.refNo, r.title]) if (k && !byText.has(k.toLowerCase())) byText.set(k.toLowerCase(), ref);
    }
    return itemImport.checkImport(body || {}, {
        saleTypes, existing, officialCodes: new Set(codes.map(c => c.code)),
        findRef: t => byText.get(t.toLowerCase()) || null,
    });
}
app.post('/api/products/import/check', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const r = await checkItemImport(req.user.tenantId, req.body);
    const updates = r.ready.filter(e => e.existing).map(({ row, item, existing, fills, conflicts }) => ({ row, name: item.name, existing, fills, conflicts }));
    res.json({ errors: r.errors, warnings: r.warnings, ready: r.ready.length - updates.length, updates });
});
app.post('/api/products/import/commit', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const tenantId = req.user.tenantId;
    const r = await checkItemImport(tenantId, req.body);
    if (r.errors.length) return res.status(400).json({ error: 'The file has problems — check it again.', errors: r.errors, warnings: r.warnings });
    const [t, { list: saleTypes }, codes] = await Promise.all([
        prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { businessActivities: true, sectors: true } }),
        saleTypeList(tenantId),
        prisma.hsCode.findMany({ select: { code: true, description: true } }),
    ]);
    const official = new Set(codes.map(c => c.code)), now = new Date(), industry = industryOf(t);
    const hsText = new Map(codes.map(c => [c.code, c.description]));
    const products = [], rules = [], updates = [], details = [], problems = [];
    const choices = req.body?.choices || {}; // { [row]: { [field]: 'file' | 'saved' } } from the uploader's pop-up
    const saved = new Map((await prisma.product.findMany({ where: { tenantId } })).map(p => [p.id, p]));
    for (const { row, item, rule, existing } of r.ready) {
        if (!existing) {
            const d = itemData(item), tr = taxRuleData(rule, saleTypes), id = crypto.randomUUID();
            if (hsText.has(d.hsCode)) d.hsDescription = hsText.get(d.hsCode);
            products.push({ id, tenantId, ...d, source: official.has(d.hsCode) ? 'OFFICIAL' : 'CUSTOMER', ...tr, taxRuleAt: now });
            rules.push({ ...tr, tenantId, productId: id, industry, createdBy: req.user.email, createdAt: now });
            continue;
        }
        // A saved item: fill what it is missing, and take the file's value only where the uploader chose it
        const p = saved.get(existing.id), base = itemImport.savedItem(p);
        const incoming = { ...item, ...rule };
        if (squashName(item.name) === squashName(p.name)) delete incoming.name;
        const m = importMerge.mergeRecord(base, incoming, importMerge.ITEM_FIELDS, choices[row]);
        try {
            const d = itemData({ ...base, ...m.patch });
            if (hsText.has(d.hsCode)) d.hsDescription = hsText.get(d.hsCode);
            const ruleChanged = Object.keys(m.patch).some(k => importMerge.RULE_KEYS.has(k));
            let tr = null;
            if (ruleChanged) {
                // FBR's rate / SRO ids stay only while the sale type and rate are unchanged
                const keepFbr = !('saleType' in m.patch) && !('rate' in m.patch);
                tr = taxRuleData({ ...base, ...m.patch, fbrRateId: keepFbr ? p.fbrRateId : null, fbrSroId: keepFbr ? p.fbrSroId : null,
                    fbrSroDesc: keepFbr && p.fbrSroId ? p.sroScheduleNo : '' }, saleTypes);
            }
            const pairTaken = [...saved.values()].find(x => x.id !== p.id && x.hsCode === d.hsCode && x.saleType && x.saleType === (tr ? tr.saleType : p.saleType));
            if (pairTaken) throw new HttpError(400, `HS code ${d.hsCode} with sale type "${pairTaken.saleType}" is already used by your item "${pairTaken.name}"`);
            if (Object.keys(m.patch).length) {
                updates.push(prisma.product.update({ where: { id: p.id }, data: { ...d, source: official.has(d.hsCode) ? 'OFFICIAL' : 'CUSTOMER', ...(tr && { ...tr, taxRuleAt: now }) } }));
                if (tr) rules.push({ ...tr, tenantId, productId: p.id, industry, createdBy: req.user.email, createdAt: now });
            }
            details.push({ row, name: p.name, message: importMerge.mergeMessage(m), changed: Object.keys(m.patch).length > 0, id: p.id,
                changes: importMerge.diffRecord(base, itemImport.savedItem({ ...base, ...d, ...(tr || {}) }), importMerge.ITEM_FIELDS) });
        } catch (err) {
            if (!(err instanceof HttpError)) throw err;
            problems.push({ sheet: 'Items', row, name: p.name, messages: [`with your choices: ${err.message}`] });
        }
    }
    if (problems.length) return res.status(400).json({ error: 'Some choices don\'t make a valid item — choose again.', errors: problems, warnings: r.warnings });
    try {
        // one transaction: every new item and its first tax rule, every update and its new tax rule entry, or nothing
        await prisma.$transaction([prisma.product.createMany({ data: products }), ...updates, prisma.productTaxRule.createMany({ data: rules })]);
    } catch (err) {
        if (err.code === 'P2002') throw new HttpError(409, 'An item with one of these names was added meanwhile — check the file again.');
        throw err;
    }
    // each item's own history: added from / updated by this file
    for (const x of products) await audit(req, { action: 'product.import', entityType: 'Product', entityId: x.id, details: { created: true, file: req.body?.fileName || '' },
        summary: `Item "${x.name}" added from Excel${req.body?.fileName ? ` (${String(req.body.fileName).slice(0, 100)})` : ''}` });
    for (const x of details.filter(x => x.changed)) await audit(req, { action: 'product.import', entityType: 'Product', entityId: x.id, details: { changes: x.changes, file: req.body?.fileName || '' },
        summary: `Item "${x.name}" updated from Excel${req.body?.fileName ? ` (${String(req.body.fileName).slice(0, 100)})` : ''}` });
    await audit(req, { action: 'product.import', entityType: 'Product', entityId: null,
        summary: `Items with tax rules imported from Excel: ${products.length} added, ${details.filter(x => x.changed).length} updated` });
    res.json({ imported: products.length, updated: details.filter(x => x.changed).length, details: details.map(({ changes, id, ...x }) => x), warnings: r.warnings.length });
});

app.post('/api/products/:id/tax-rule', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const p = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!p) throw new HttpError(404, 'Item not found.');
    res.json(await setTaxRule(req, p, taxRuleData(req.body || {}, (await saleTypeList(req.user.tenantId)).list)));
});
app.get('/api/products/:id/tax-rules', authenticateToken, requireTenant, async (req, res) => {
    const p = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, select: { id: true } });
    if (!p) throw new HttpError(404, 'Item not found.');
    res.json(await prisma.productTaxRule.findMany({ where: { productId: p.id }, orderBy: { createdAt: 'desc' } }));
});

app.delete('/api/products/:id', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const prod = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, select: { name: true } });
    if (!prod) throw new HttpError(404, 'Item not found.');
    await prisma.product.delete({ where: { id: req.params.id } });
    await audit(req, { action: 'product.delete', entityType: 'Product', entityId: req.params.id, summary: `Item "${prod.name}" deleted (with its tax rule history)` });
    res.json({ deleted: true });
});

// ---------- Saved buyers ----------
// NTN, CNIC and STRN are kept separately; FBR gets one number (buyerNTNCNIC): the NTN if there is one, else the CNIC.
function buyerData(b) {
    const digits = v => String(v ?? '').replace(/\D/g, '');
    let ntn = digits(b.ntn), cnic = digits(b.cnic);
    const legacy = digits(b.ntnCnic ?? b.buyerNtnCnic); // a single "NTN / CNIC" box (invoice form, import)
    if (legacy && !ntn && !cnic) { if (legacy.length === 13) cnic = legacy; else ntn = legacy; }
    const d = {
        businessName: String(b.businessName ?? b.buyerBusinessName ?? '').trim(),
        ntn, cnic, strn: digits(b.strn),
        registrationType: (b.registrationType ?? b.buyerRegistrationType) === 'Registered' ? 'Registered' : 'Unregistered',
        province: String(b.province ?? b.buyerProvince ?? '').trim(),
        address: String(b.address ?? b.buyerAddress ?? '').trim(),
        // Contact details: mobile keeps a leading + and digits only (0300-1234567 → 03001234567)
        mobile: String(b.mobile ?? '').trim().replace(/(?!^\+)[^\d]/g, ''),
        email: String(b.email ?? '').trim().toLowerCase(),
        note: String(b.note ?? '').trim(),
    };
    d.ntnCnic = d.ntn || d.cnic || null;
    if (!d.businessName || d.businessName.length > 200) throw new HttpError(400, 'Buyer name is required (max 200 characters).');
    if (d.ntn && ![7, 9].includes(d.ntn.length)) throw new HttpError(400, 'NTN must be 7 or 9 digits.');
    if (d.cnic && d.cnic.length !== 13) throw new HttpError(400, 'CNIC must be 13 digits.');
    if (d.strn && ![7, 9, 13].includes(d.strn.length)) throw new HttpError(400, 'STRN must be 13 digits.');
    if (d.registrationType === 'Registered' && !d.ntnCnic) throw new HttpError(400, 'Registered buyer needs an NTN or CNIC.');
    // per country (length, how mobile numbers start); Excel may have dropped the 0 of 03001234567
    if (/^3\d{9}$/.test(d.mobile)) d.mobile = '0' + d.mobile;
    const mobileIssue = mobileProblem(d.mobile);
    if (mobileIssue) throw new HttpError(400, mobileIssue);
    if (d.email && (d.email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email))) throw new HttpError(400, 'Email address looks wrong.');
    if (d.note.length > 500) throw new HttpError(400, 'Note can be at most 500 characters.');
    return d;
}

// Another saved buyer with the same NTN, CNIC or STRN (or, with no numbers at all, the same name)
function findDuplicateBuyer(tenantId, d, exceptId) {
    const or = [
        ...(d.ntn ? [{ ntn: d.ntn }, { ntnCnic: d.ntn }] : []),
        ...(d.cnic ? [{ cnic: d.cnic }, { ntnCnic: d.cnic }] : []),
        ...(d.strn ? [{ strn: d.strn }] : []),
    ];
    if (!or.length) or.push({ ntnCnic: null, ntn: '', cnic: '', strn: '', businessName: { equals: d.businessName, mode: 'insensitive' } });
    return prisma.buyer.findFirst({ where: { tenantId, OR: or, ...(exceptId && { id: { not: exceptId } }) } });
}
const duplicateError = dup => new HttpError(409, `"${dup.businessName}" is already saved with this ${dup.ntn || dup.cnic || dup.strn ? 'NTN / CNIC / STRN' : 'name'}. Open it from the Buyers list to change it.`);

// After a filed invoice: remember a new buyer that has an NTN/CNIC. An existing buyer is never changed.
async function rememberBuyer(tenantId, inv) {
    if (!inv.buyerNtnCnic) return;
    const d = buyerData({ ...inv, ntn: inv.buyerNtn, cnic: inv.buyerCnic, strn: inv.buyerStrn, mobile: inv.buyerMobile, email: inv.buyerEmail, note: inv.buyerNote });
    if (!(await findDuplicateBuyer(tenantId, d))) await prisma.buyer.create({ data: { ...d, tenantId } });
}

app.get('/api/buyers', authenticateToken, requireTenant, async (req, res) => {
    const q = String(req.query.q || '').trim();
    const digits = q.replace(/\D/g, '');
    res.json(await prisma.buyer.findMany({
        where: {
            tenantId: req.user.tenantId,
            ...(q && { OR: [{ businessName: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }, { note: { contains: q, mode: 'insensitive' } }, { address: { contains: q, mode: 'insensitive' } }, { province: { contains: q, mode: 'insensitive' } },
                ...(digits ? [{ ntnCnic: { startsWith: digits } }, { ntn: { startsWith: digits } }, { cnic: { startsWith: digits } }, { strn: { startsWith: digits } },
                    { mobile: { contains: digits.replace(/^(92|0)/, '') } }] : [])] }),
        },
        orderBy: { businessName: 'asc' },
        take: q ? 20 : 1000,
    }));
});

app.post('/api/buyers', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const d = buyerData(req.body || {});
    const tenantId = req.user.tenantId, id = req.body.id ? String(req.body.id) : null;
    const dup = await findDuplicateBuyer(tenantId, d, id);
    if (dup) throw duplicateError(dup);
    let b;
    const before = id ? await prisma.buyer.findFirst({ where: { id, tenantId } }) : null;
    try {
        if (id) {
            const { count } = await prisma.buyer.updateMany({ where: { id, tenantId }, data: d });
            if (!count) throw new HttpError(404, 'Buyer not found.');
            b = await prisma.buyer.findUnique({ where: { id } });
        } else {
            b = await prisma.buyer.create({ data: { ...d, tenantId } });
        }
    } catch (err) {
        if (err.code === 'P2002') throw new HttpError(409, `Another saved buyer already has NTN / CNIC ${d.ntnCnic}.`);
        throw err;
    }
    const changes = before ? importMerge.diffRecord(before, b, importMerge.BUYER_FIELDS) : [];
    if (!before || changes.length) await audit(req, { action: 'buyer.save', entityType: 'Buyer', entityId: b.id, details: { changes, created: !before },
        summary: `Buyer "${b.businessName}" ${id ? 'updated' : 'added'}${[b.ntn && 'NTN ' + b.ntn, b.cnic && 'CNIC ' + b.cnic, b.strn && 'STRN ' + b.strn].filter(Boolean).map(x => ' · ' + x).join('')}` });
    res.json(b);
});

// Bulk import from the Excel template. A row whose NTN / CNIC / STRN (or, with no numbers, name) matches a saved
// buyer updates that buyer — so an exported sheet can be edited and imported back. Each row is checked on its own.
const BUYER_IMPORT_MAX = 2000;
const buyerRows = rows => {
    if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'The file has no buyer rows.');
    if (rows.length > BUYER_IMPORT_MAX) throw new HttpError(400, `At most ${BUYER_IMPORT_MAX} buyers per file.`);
    return rows;
};
// The row as the file gives it: an empty Registered / Unregistered cell says nothing (not "Unregistered")
const buyerIncoming = (r, d) => { const x = { ...d }; delete x.ntnCnic; if (!String(r.registrationType || '').trim()) delete x.registrationType; return x; };
// Before importing: which rows are new, which match a saved buyer, what they fill in and where they differ
app.post('/api/buyers/import/check', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const rows = buyerRows(req.body?.rows), tenantId = req.user.tenantId, results = [];
    for (const [i, r] of rows.entries()) {
        const row = Number(r?.row) || i + 2;
        try {
            const d = buyerData(r || {});
            const dup = await findDuplicateBuyer(tenantId, d);
            if (!dup) { results.push({ row, name: d.businessName, status: 'new' }); continue; }
            const c = importMerge.compareRecord(dup, buyerIncoming(r, d), importMerge.BUYER_FIELDS);
            results.push({ row, name: d.businessName, status: 'existing', existing: { id: dup.id, name: dup.businessName }, ...c });
        } catch (err) {
            results.push({ row, name: String(r?.businessName || ''), status: 'error', message: err instanceof HttpError ? err.message : 'could not be read' });
        }
    }
    res.json({ results });
});
// A row whose NTN / CNIC / STRN (or, with no numbers, name) matches a saved buyer fills in that buyer's missing
// details; where both have a value and they differ, the uploader's choice (body.choices[row][field]) decides —
// without a choice the saved value stays.
app.post('/api/buyers/import', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const rows = buyerRows(req.body?.rows), choices = req.body?.choices || {};
    const tenantId = req.user.tenantId, results = [];
    for (const [i, r] of rows.entries()) {
        const row = Number(r?.row) || i + 2; // Excel row number (row 1 is the headings)
        try {
            const d = buyerData(r || {});
            const dup = await findDuplicateBuyer(tenantId, d);
            const file = String(req.body?.fileName || '').slice(0, 100), from = `from Excel${file ? ` (${file})` : ''}`;
            if (!dup) {
                const nb = await prisma.buyer.create({ data: { ...d, tenantId } });
                await audit(req, { action: 'buyer.import', entityType: 'Buyer', entityId: nb.id, details: { created: true, file }, summary: `Buyer "${nb.businessName}" added ${from}` });
                results.push({ row, name: d.businessName, status: 'added' });
                continue;
            }
            const m = importMerge.mergeRecord(dup, buyerIncoming(r, d), importMerge.BUYER_FIELDS, choices[row]);
            if (Object.keys(m.patch).length) {
                const nb = await prisma.buyer.update({ where: { id: dup.id }, data: buyerData({ ...dup, ...m.patch }) });
                await audit(req, { action: 'buyer.import', entityType: 'Buyer', entityId: dup.id, details: { changes: importMerge.diffRecord(dup, nb, importMerge.BUYER_FIELDS), file },
                    summary: `Buyer "${dup.businessName}" updated ${from}` });
            }
            results.push({ row, name: dup.businessName, status: Object.keys(m.patch).length ? 'updated' : 'unchanged', message: importMerge.mergeMessage(m) });
        } catch (err) {
            const msg = err.code === 'P2002' ? 'another saved buyer already has this NTN / CNIC' : err instanceof HttpError ? err.message : 'could not be saved';
            results.push({ row, name: String(r?.businessName || ''), status: 'error', message: msg });
        }
    }
    const count = s => results.filter(x => x.status === s).length;
    await audit(req, { action: 'buyer.import', entityType: 'Buyer', entityId: null,
        summary: `Buyers imported from Excel: ${count('added')} added, ${count('updated')} updated, ${count('unchanged')} already saved, ${count('error')} with errors` });
    res.json({ results, added: count('added'), updated: count('updated'), unchanged: count('unchanged'), errors: count('error') });
});

// Change history of one buyer or item: who changed what, when (from the activity log)
app.get('/api/history/:type/:id', authenticateToken, requireTenant, async (req, res) => {
    const entityType = { buyers: 'Buyer', products: 'Product' }[req.params.type];
    if (!entityType) throw new HttpError(404, 'Not found.');
    const rows = await prisma.auditLog.findMany({ where: { tenantId: req.user.tenantId, entityType, entityId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 200 });
    res.json(rows.map(x => ({ at: x.createdAt, by: x.userEmail, action: x.action, summary: x.summary, changes: x.details?.changes || [], created: Boolean(x.details?.created), file: x.details?.file || '' })));
});

app.delete('/api/buyers/:id', authenticateToken, requireTenant, OWNER_OR_ACCOUNTANT, async (req, res) => {
    const buyer = await prisma.buyer.findFirst({ where: { id: req.params.id, tenantId: req.user.tenantId }, select: { businessName: true } });
    const { count } = await prisma.buyer.deleteMany({ where: { id: req.params.id, tenantId: req.user.tenantId } });
    if (!count) throw new HttpError(404, 'Buyer not found.');
    await audit(req, { action: 'buyer.delete', entityType: 'Buyer', entityId: req.params.id, summary: `Buyer "${buyer.businessName}" deleted` });
    res.json({ deleted: true });
});

// Point of Sale (PRA): a separate product, its own routes and tables (src/pos)
{
    const pra = require('./src/pos/pra');
    const { createBreaker } = require('./src/pos/breaker');
    const { createPosService } = require('./src/pos/service');
    const { registerPosRoutes } = require('./src/pos/routes');
    // After this many failed calls in a row the counter's sales are paused for a short rest (SRS: new sales are blocked while PRA is unreachable)
    const breaker = createBreaker({ threshold: Number(process.env.POS_BREAKER_FAILS) || 1, coolDownMs: (Number(process.env.POS_BREAKER_REST_SECONDS) || 15) * 1000 });
    const posService = createPosService({ prisma, audit, encrypt, decrypt, mask, pra, breaker });
    posAdmin.service = posService;
    registerPosRoutes(app, { service: posService, pra, authenticateToken, requireTenant, requireTenantRole, tenantModules, prisma, HttpError });
}

// ---------- Errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 3000;
// Clients whose access period (and grace) is over are made inactive by themselves: when the server starts and every ten minutes.
// The login and every request check too, so nothing depends on this having run.
const runExpiry = () => sub.expireDueClients({ prisma, audit })
    .then(ids => { if (ids.length) console.log(`Access period over: ${ids.length} client(s) made inactive`); })
    .catch(err => console.error('access-period check failed:', err.message));
runExpiry();
setInterval(runExpiry, 10 * 60 * 1000).unref();

app.listen(PORT, () => {
    console.log(`FBR billing app on http://localhost:${PORT}${process.env.FBR_MOCK === 'true' ? '  (FBR_MOCK on — nothing is sent to FBR)' : ''}`);
});
