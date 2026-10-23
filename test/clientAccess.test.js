// How long a client may use the application, through the real server and the local database: the administrator sets the period and
// renews it, a client whose period (and grace) is over is switched off and cannot log in, renewing brings it back, and the list shows
// the integration date and the countdown. It makes its own businesses and removes them.
require('dotenv').config({ quiet: true });
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const sub = require('../src/subscription');
const { createAudit } = require('../src/audit');

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '');
const prisma = new PrismaClient();
const W = { tenants: [] };
const today = () => sub.dayOf(new Date());
const plusDays = n => sub.addDays(today(), n);

const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = async (url, { token, method = 'GET', body } = {}) => {
    const r = await fetch(`http://127.0.0.1:${W.port}${url}`, { method, headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, text, json };
};
const login = async (who, password) => call('/api/auth/login', { method: 'POST', body: { email: who.email, password } });
const admin = (url, opts = {}) => call(url, { token: W.adminToken, ...opts });
const setAccess = (id, body) => admin(`/api/admin/clients/${id}/access`, { method: 'PUT', body });
const stored = id => prisma.tenant.findUnique({ where: { id } });

test('client access: set up an administrator, two clients, and start the server', { timeout: 60000 }, async t => {
    if (!local) return t.skip('this test only runs against a database on this computer');
    try { await Promise.race([prisma.$queryRaw`SELECT 1`, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]); } catch { return t.skip('no local database'); }
    const tag = crypto.randomBytes(4).toString('hex');
    W.password = 'Access!Pass#' + tag;
    const hash = await bcrypt.hash(W.password, 10);
    W.admin = { email: `access-admin-${tag}@example.com` };
    await prisma.user.create({ data: { email: W.admin.email, password: hash, role: 'SUPER_ADMIN', name: 'Access Admin' } });
    for (const key of ['a', 'b']) {
        const tenant = await prisma.tenant.create({ data: { companyName: `TEST ACCESS ${key} ${tag}`, modules: key === 'a' ? ['POS'] : ['INVOICING', 'POS'] } });
        W[key] = { id: tenant.id, email: `access-${key}-${tag}@example.com` };
        await prisma.user.create({ data: { email: W[key].email, password: hash, role: 'CLIENT_USER', tenantRole: 'OWNER', tenantId: tenant.id, name: 'Owner ' + key } });
        W.tenants.push(tenant.id);
    }
    W.port = await freePort();
    W.child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(W.port), FBR_MOCK: 'true', PRA_MOCK: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const up = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 30000);
        W.child.stdout.on('data', d => { out += d; if (/FBR billing app on/.test(out)) { clearTimeout(timer); resolve(true); } });
        W.child.stderr.on('data', d => { out += d; });
        W.child.on('exit', () => resolve(false));
    });
    assert.ok(up, 'server did not start:\n' + out.slice(-800));
    const r = await login(W.admin, W.password);
    assert.strictEqual(r.status, 200, r.text);
    W.adminToken = r.json.token;
});

const run = (name, fn) => test(name, async t => { if (!W.child) return t.skip('no local database'); await fn(); });

run('client access: a new client has no time limit and the integration day is the day it was made', async () => {
    const t = (await admin('/api/admin/clients')).json.find(c => c.id === W.a.id);
    assert.strictEqual(t.access.status, 'UNLIMITED');
    assert.strictEqual(t.accessEndsAt, null);
    assert.strictEqual(sub.dayOf(t.integratedAt), today());
    assert.strictEqual(t.active, true);
});

run('client access: the administrator sets the period; the end date, countdown and grace follow', async () => {
    const start = plusDays(-100);
    const r = await setAccess(W.a.id, { integratedAt: start, unit: 'YEAR', count: 1 });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(sub.dayOf(r.json.accessEndsAt), sub.addMonths(start, 12));
    assert.strictEqual(sub.dayOf(r.json.integratedAt), start);
    assert.deepStrictEqual([r.json.accessUnit, r.json.accessCount], ['YEAR', 1]);
    assert.strictEqual(r.json.access.status, 'RUNNING');
    assert.strictEqual(r.json.access.graceDays, 7);
    // the list carries the same figures, for the date and the countdown columns
    const row = (await admin('/api/admin/clients')).json.find(c => c.id === W.a.id);
    assert.strictEqual(sub.dayOf(row.integratedAt), start);
    assert.strictEqual(typeof row.access.daysLeft, 'number');
    const span = (new Date(sub.addMonths(start, 12)) - new Date(start)) / 86400000; // 365 or 366 days
    assert.strictEqual(row.access.daysLeft, span - 100, 'a year given 100 days ago has the rest of the year left');
    // a monthly plan has 3 grace days
    assert.strictEqual((await setAccess(W.a.id, { integratedAt: plusDays(-10), unit: 'MONTH', count: 6 })).json.access.graceDays, 3);
    // no time limit again
    const free = await setAccess(W.a.id, { unlimited: true });
    assert.strictEqual(free.json.access.status, 'UNLIMITED');
    assert.strictEqual(free.json.accessEndsAt, null);
});

run('client access: what the administrator cannot enter is refused in plain words', async () => {
    for (const body of [{ unit: 'WEEK', count: 1 }, { unit: 'YEAR', count: 0 }, { unit: 'MONTH', count: 'abc' }, { unit: 'YEAR', count: 99 }, { integratedAt: '2026-13-40', unit: 'YEAR', count: 1 }, {}]) {
        const r = await setAccess(W.a.id, body);
        assert.strictEqual(r.status, 400, JSON.stringify(body));
        assert.ok(r.json.error && !/[{}]/.test(r.json.error), r.text);
    }
    assert.strictEqual((await admin('/api/admin/clients/does-not-exist/access', { method: 'PUT', body: { unlimited: true } })).status, 404);
    assert.strictEqual((await call(`/api/admin/clients/${W.a.id}/access`, { method: 'PUT', body: { unlimited: true } })).status, 401, 'nobody without a login');
});

run('client access: a client in its grace period uses everything; when the grace is over it is made inactive and can only look', async () => {
    const owner = await login(W.a, W.password);
    assert.strictEqual(owner.status, 200, owner.text);
    const ownerToken = owner.json.token;
    // ended 2 days ago on a yearly plan (7 grace days): still allowed, still active
    let r = await setAccess(W.a.id, { integratedAt: sub.addMonths(plusDays(-2), -12), unit: 'YEAR', count: 1 });
    assert.strictEqual(r.json.access.status, 'GRACE');
    assert.strictEqual(r.json.active, true);
    assert.strictEqual((await login(W.a, W.password)).status, 200);
    assert.strictEqual((await call('/api/pos/alerts', { token: ownerToken })).status, 200);
    // ended 8 days ago: the grace is over
    r = await setAccess(W.a.id, { integratedAt: sub.addMonths(plusDays(-8), -12), unit: 'YEAR', count: 1 });
    assert.strictEqual(r.json.access.status, 'EXPIRED');
    assert.strictEqual(r.json.active, false, 'made inactive at once');
    assert.strictEqual(r.json.inactiveReason, 'EXPIRED');
    // it can still log in, to look at its records: a new login, and a session that was already open
    assert.strictEqual((await login(W.a, W.password)).status, 200, 'the owner can still log in');
    const open = await call('/api/pos/alerts', { token: ownerToken });
    assert.strictEqual(open.status, 200, 'and read');
    // but it cannot change anything
    const write = await call('/api/pos/branches', { token: ownerToken, method: 'POST', body: { name: 'Should not be made' } });
    assert.strictEqual(write.status, 403);
    assert.match(write.json.error, /access period ended on .* but you cannot make changes/);
    assert.strictEqual(write.json.readOnly, true);
    // the administrator cannot just switch it on again
    const on = await admin(`/api/admin/clients/${W.a.id}/settings`, { method: 'PUT', body: { active: true } });
    assert.strictEqual(on.status, 400);
    assert.match(on.json.error, /Renew it first/);
    assert.strictEqual((await stored(W.a.id)).active, false);
});

run('client access: renewing makes the client active again, from today when the period was long over', async () => {
    const r = await admin(`/api/admin/clients/${W.a.id}/access/renew`, { method: 'POST', body: { unit: 'MONTH', count: 3 } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(sub.dayOf(r.json.accessEndsAt), sub.addMonths(today(), 3));
    assert.strictEqual(r.json.active, true);
    assert.strictEqual(r.json.inactiveReason, null);
    assert.deepStrictEqual([r.json.accessUnit, r.json.accessCount, r.json.access.graceDays], ['MONTH', 3, 3]);
    assert.strictEqual((await login(W.a, W.password)).status, 200, 'and the owner can log in again');
    // renewing before the end adds to the end date, so nothing is lost
    const again = await admin(`/api/admin/clients/${W.a.id}/access/renew`, { method: 'POST', body: {} });
    assert.strictEqual(sub.dayOf(again.json.accessEndsAt), sub.addMonths(sub.addMonths(today(), 3), 3));
    assert.strictEqual((await admin(`/api/admin/clients/${W.a.id}/access/renew`, { method: 'POST', body: { unit: 'YEAR', count: 0 } })).status, 400);
});

run('client access: switching a client off by hand is a different thing from an ended period', async () => {
    await setAccess(W.b.id, { unlimited: true });
    let r = await admin(`/api/admin/clients/${W.b.id}/settings`, { method: 'PUT', body: { active: false } });
    assert.strictEqual(r.json.active, false);
    assert.strictEqual(r.json.inactiveReason, 'ADMIN');
    const blocked = await login(W.b, W.password);
    assert.strictEqual(blocked.status, 403);
    assert.match(blocked.json.error, /inactive/);
    assert.ok(!/access period/.test(blocked.json.error));
    r = await admin(`/api/admin/clients/${W.b.id}/settings`, { method: 'PUT', body: { active: true } });
    assert.strictEqual(r.json.active, true);
    assert.strictEqual(r.json.inactiveReason, null);
    assert.strictEqual((await login(W.b, W.password)).status, 200);
});

run('client access: the job that switches off lapsed clients works against the real database, once', async () => {
    const audit = createAudit(prisma);
    await prisma.tenant.update({ where: { id: W.b.id }, data: { active: true, inactiveReason: null, accessUnit: 'MONTH', accessCount: 1, accessEndsAt: sub.atMidnight(plusDays(-20)) } });
    const ids = await sub.expireDueClients({ prisma, audit });
    assert.ok(ids.includes(W.b.id), 'the lapsed client is switched off');
    assert.ok(!ids.includes(W.a.id), 'a running one is not');
    const t = await stored(W.b.id);
    assert.deepStrictEqual([t.active, t.inactiveReason], [false, 'EXPIRED']);
    assert.ok(!(await sub.expireDueClients({ prisma, audit })).includes(W.b.id), 'a second run leaves it alone');
    const note = await prisma.auditLog.findFirst({ where: { tenantId: W.b.id, action: 'client.expired' } });
    assert.ok(note && /made inactive automatically/.test(note.summary), 'and it is in the activity log');
    const changed = await prisma.auditLog.findFirst({ where: { tenantId: W.a.id, action: 'client.access' } });
    assert.ok(changed && /Access period (set|renewed)/.test(changed.summary), 'setting the period is logged too');
});

run('client access: the administrator sees the Point of Sale side of a client, and nobody else does', async () => {
    const r = await admin(`/api/admin/clients/${W.a.id}/pos-summary`);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['counters', 'items', 'lastSaleAt', 'month', 'needsAttention', 'pntn', 'profileComplete', 'businessName', 'sales', 'testMode', 'unknown'].sort());
    assert.deepStrictEqual(r.json.sales, { count: 0, total: 0 });
    assert.strictEqual(r.json.testMode, true);
    const owner = await login(W.a, W.password);
    assert.strictEqual((await call(`/api/admin/clients/${W.a.id}/pos-summary`, { token: owner.json.token })).status, 403);
    const row = (await admin('/api/admin/clients')).json.find(c => c.id === W.a.id);
    assert.strictEqual(row.pos.sales.count, 0, 'the list carries the figures for the clients that have the Point of Sale');
    assert.strictEqual((await admin(`/api/admin/clients`)).json.find(c => c.id === W.b.id).pos.counters, 0);
});

run('client access: a client can be registered with its period, or with none, and a bad period creates nothing', async () => {
    const tag = crypto.randomBytes(3).toString('hex');
    const register = (n, extra) => admin('/api/admin/clients', { method: 'POST', body: { companyName: `TEST ACCESS reg ${n} ${tag}`, clientEmail: `reg-${n}-${tag}@example.com`, clientPassword: 'Reg!Pass#9' + tag, ...extra } });
    const find = n => prisma.tenant.findFirst({ where: { companyName: `TEST ACCESS reg ${n} ${tag}` } });
    const withPeriod = await register('period', { accessUnit: 'MONTH', accessCount: 3 });
    assert.strictEqual(withPeriod.status, 200, withPeriod.text);
    const t = await find('period');
    W.tenants.push(t.id);
    assert.deepStrictEqual([t.accessUnit, t.accessCount, sub.dayOf(t.accessEndsAt), sub.dayOf(t.integratedAt)], ['MONTH', 3, sub.addMonths(today(), 3), today()]);
    assert.strictEqual(t.active, true);
    const none = await register('none', {});
    assert.strictEqual(none.status, 200, none.text);
    const u = await find('none');
    W.tenants.push(u.id);
    assert.deepStrictEqual([u.accessUnit, u.accessEndsAt], [null, null], 'no period given: no time limit');
    for (const [n, extra] of [['bad1', { accessUnit: 'WEEK', accessCount: 1 }], ['bad2', { accessUnit: 'YEAR', accessCount: 0 }], ['bad3', { accessUnit: 'YEAR' }]]) {
        const r = await register(n, extra);
        assert.strictEqual(r.status, 400, n + ': ' + r.text);
        assert.strictEqual(await find(n), null, `${n}: nothing was created`);
        assert.strictEqual(await prisma.user.findUnique({ where: { email: `reg-${n}-${tag}@example.com` } }), null);
    }
    const note = await prisma.auditLog.findFirst({ where: { tenantId: t.id, action: 'admin.client_create' } });
    assert.match(note.summary, /access: 3 months, ends/);
});

test.after(async () => {
    if (W.child) W.child.kill();
    for (const id of W.tenants) {
        await prisma.user.deleteMany({ where: { tenantId: id } });
        await prisma.tenant.delete({ where: { id } }).catch(() => {});
    }
    if (W.admin) await prisma.user.deleteMany({ where: { email: W.admin.email } });
    await prisma.$disconnect();
});
