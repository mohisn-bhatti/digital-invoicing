// The real server, a business with only the Point of Sale and one with only Digital Invoicing: each product is closed to the
// business that does not have it, on the server (not just hidden in the menu). Needs the local database; it makes its own
// businesses and removes them.
require('dotenv').config({ quiet: true });
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '');
const prisma = new PrismaClient();
const W = {};

const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = async (path, { token, method = 'GET', body } = {}) => {
    const r = await fetch(`http://127.0.0.1:${W.port}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
};
const json = r => JSON.parse(r.text);

test('module guards: set up two businesses and start the server', { timeout: 60000 }, async t => {
    if (!local) return t.skip('this test only runs against a database on this computer');
    try { await Promise.race([prisma.$queryRaw`SELECT 1`, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]); } catch { return t.skip('no local database'); }
    const tag = crypto.randomBytes(4).toString('hex'), password = 'Guard!Pass#' + tag, hash = await bcrypt.hash(password, 10);
    W.ids = [];
    for (const [key, modules] of [['pos', ['POS']], ['inv', ['INVOICING']]]) {
        const tenant = await prisma.tenant.create({ data: { companyName: `TEST GUARD ${key} ${tag}`, modules } });
        const email = `guard-${key}-${tag}@example.com`;
        await prisma.user.create({ data: { email, password: hash, role: 'CLIENT_USER', tenantRole: 'OWNER', tenantId: tenant.id, name: 'Guard' } });
        W[key] = { tenantId: tenant.id, email, password };
        W.ids.push(tenant.id);
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
    for (const key of ['pos', 'inv']) {
        const r = await call('/api/auth/login', { method: 'POST', body: { email: W[key].email, password: W[key].password } });
        assert.strictEqual(r.status, 200, r.text);
        W[key].token = json(r).token;
        W[key].modules = json(r).modules;
    }
    assert.deepStrictEqual(W.pos.modules, ['POS']);
    assert.deepStrictEqual(W.inv.modules, ['INVOICING']);
});

const run = (name, fn) => test(name, async t => { if (!W.child) return t.skip('no local database'); await fn(); });

run('module guards: a business with only the Point of Sale cannot file invoices', async () => {
    const r = await call('/api/invoices', { token: W.pos.token, method: 'POST', body: {} });
    assert.strictEqual(r.status, 403);
    assert.match(json(r).error, /Digital Invoicing is not switched on/);
});

run('module guards: a business with only Digital Invoicing cannot use the Point of Sale', async () => {
    for (const p of ['/api/pos/setup', '/api/pos/alerts', '/api/pos/overview', '/api/pos/sales']) {
        const r = await call(p, { token: W.inv.token });
        assert.strictEqual(r.status, 403, p);
        assert.match(json(r).error, /Point of Sale is not switched on/);
    }
    const r = await call('/api/invoices', { token: W.inv.token, method: 'POST', body: {} });
    assert.ok(!/not switched on/.test(r.text), 'invoicing is not refused for the module (only for what it is still missing)');
});

run('module guards: the Point of Sale answers its own business, and the light alert counts have the three numbers', async () => {
    const setup = await call('/api/pos/setup', { token: W.pos.token });
    assert.strictEqual(setup.status, 200, setup.text);
    assert.strictEqual(json(setup).testMode, true);
    const alerts = await call('/api/pos/alerts', { token: W.pos.token });
    assert.strictEqual(alerts.status, 200);
    assert.deepStrictEqual(json(alerts), { awaiting: 0, rejected: 0, outcomeUnknown: 0 });
    assert.strictEqual((await call('/api/pos/alerts')).status, 401, 'and nobody is let in without logging in');
});

run('module guards: the cashier maths is a plain file any static host can serve', async () => {
    const r = await call('/pos-calc.js');
    assert.strictEqual(r.status, 200);
    assert.match(r.type, /javascript/);
    assert.match(r.text, /PosCalc/);
    assert.match(r.text, /buyerProblem/);
    assert.strictEqual((await call('/pos.js')).status, 200);
});

run('module guards: bad dates and paging in the sales queries are a 400, not a crash', async () => {
    for (const q of ['from=2026-13-01', 'to=2026-01-32', 'from=2026-02-31']) {
        const r = await call('/api/pos/sales?' + q, { token: W.pos.token });
        assert.strictEqual(r.status, 400, q);
        assert.match(json(r).error, /real date/);
    }
    assert.strictEqual((await call('/api/pos/sales?offset=1e21&limit=1.5', { token: W.pos.token })).status, 200);
});

test.after(async () => {
    if (W.child) W.child.kill();
    for (const id of W.ids || []) {
        await prisma.user.deleteMany({ where: { tenantId: id } });
        await prisma.tenant.delete({ where: { id } }).catch(() => {});
    }
    await prisma.$disconnect();
});
