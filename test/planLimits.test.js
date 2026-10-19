// The limits of a client's plan (users, branches, terminals, products), through the real server and the local database: what is
// refused, who is told what, how places are given back, and that a client with no plan (or Enterprise) is never held back.
// It makes its own businesses and removes them.
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
const W = { tenants: [], emails: [] };

const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const call = async (url, { token, method = 'GET', body } = {}) => {
    const r = await fetch(`http://127.0.0.1:${W.port}${url}`, { method, headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, text, json };
};
const login = async (email, password) => (await call('/api/auth/login', { method: 'POST', body: { email, password } })).json.token;
const strong = tag => 'Plan!Pass#1' + tag;
const setPlan = (id, plan) => call(`/api/admin/clients/${id}/plan`, { token: W.adminToken, method: 'PUT', body: { plan } });

async function business(name, { plan = null, modules = ['INVOICING', 'POS'] } = {}) {
    const t = await prisma.tenant.create({ data: { companyName: `TEST LIMITS ${name} ${W.tag}`, modules, plan } });
    const email = `limits-${name}-${W.tag}@example.com`;
    await prisma.user.create({ data: { email, password: W.hash, role: 'CLIENT_USER', tenantRole: 'OWNER', tenantId: t.id, name: 'Owner ' + name } });
    W.tenants.push(t.id); W.emails.push(email);
    return { id: t.id, email, token: await login(email, W.password) };
}
let seq = 0;
const newUser = (b, over = {}) => call('/api/client/users', { token: b.token, method: 'POST', body: { email: `staff-${++seq}-${W.tag}@example.com`, name: 'Staff', tenantRole: 'CASHIER', password: strong(W.tag), ...over } });

test('plan limits: set up an administrator and the businesses, start the server', { timeout: 90000 }, async t => {
    if (!local) return t.skip('this test only runs against a database on this computer');
    try { await Promise.race([prisma.$queryRaw`SELECT 1`, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]); } catch { return t.skip('no local database'); }
    W.tag = crypto.randomBytes(4).toString('hex');
    W.password = strong(W.tag); W.hash = await bcrypt.hash(W.password, 10);
    const adminEmail = `limits-admin-${W.tag}@example.com`;
    await prisma.user.create({ data: { email: adminEmail, password: W.hash, role: 'SUPER_ADMIN', name: 'Limits Admin' } });
    W.emails.push(adminEmail);
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
    W.adminToken = await login(adminEmail, W.password);
    assert.ok(W.adminToken);
});

const run = (name, fn) => test(name, async t => { if (!W.child) return t.skip('no local database'); await fn(); });

run('plan limits: the administrator sets a plan, and sees what is used against it', async () => {
    const b = await business('plan', { plan: null });
    let r = await call(`/api/admin/clients/${b.id}/plan`, { token: W.adminToken });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.plan, null);
    assert.deepStrictEqual(r.json.rows.map(x => [x.kind, x.used, x.limit]), [['users', 1, null], ['products', 0, null], ['branches', 0, null], ['terminals', 0, null], ['items', 0, null]]);
    r = await setPlan(b.id, 'starter');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.plan, 'starter');
    r = await call(`/api/admin/clients/${b.id}/plan`, { token: W.adminToken });
    assert.deepStrictEqual(r.json.plan, { id: 'starter', name: 'Starter' });
    assert.deepStrictEqual(r.json.rows.map(x => [x.kind, x.limit]), [['users', 3], ['products', 1000], ['branches', 1], ['terminals', 2], ['items', 1000]]);
    // the client sees the same about itself
    r = await call('/api/client/plan', { token: b.token });
    assert.deepStrictEqual(r.json.rows.find(x => x.kind === 'users'), { kind: 'users', label: 'Users', noun: 'users', one: 'user', used: 1, limit: 3 });
    // what is not valid, and who may
    assert.strictEqual((await setPlan(b.id, 'platinum')).status, 400);
    assert.strictEqual((await call(`/api/admin/clients/${b.id}/plan`, { token: b.token, method: 'PUT', body: { plan: 'enterprise' } })).status, 403, 'a client cannot give itself a bigger plan');
    assert.strictEqual((await setPlan(b.id, '')).json.plan, null, 'no plan again');
    assert.strictEqual((await setPlan('does-not-exist', 'pro')).status, 404);
    const note = await prisma.auditLog.findFirst({ where: { tenantId: b.id, action: 'client.plan' }, orderBy: { createdAt: 'desc' } });
    assert.match(note.summary, /Plan changed: Starter → no plan/);
});

run('plan limits: users: the plan\'s number, a waiting request takes a place, and each person is told what to do', async () => {
    const b = await business('users', { plan: 'starter' }); // 3 users, the owner is one
    assert.strictEqual((await newUser(b)).status, 200);
    assert.strictEqual((await newUser(b)).status, 200);
    const third = await newUser(b);
    assert.strictEqual(third.status, 403);
    assert.strictEqual(third.json.error, 'The Starter plan allows 3 users and all 3 are in use. Ask ETAX to move you to a bigger plan.');
    // the administrator is stopped too, and told where the plan is changed
    const adm = await call(`/api/admin/clients/${b.id}/users`, { token: W.adminToken, method: 'POST', body: { email: `adm-${W.tag}@example.com`, name: 'X', tenantRole: 'CASHIER', password: strong(W.tag) } });
    assert.strictEqual(adm.status, 403);
    assert.match(adm.json.error, /Change the client's plan under Manage → Overview/);
    // rejecting a waiting request gives its place back
    const list = (await call(`/api/admin/clients/${b.id}/users`, { token: W.adminToken })).json;
    const waiting = list.find(u => u.pendingApproval);
    assert.strictEqual((await call(`/api/admin/clients/${b.id}/users/${waiting.id}/reject`, { token: W.adminToken, method: 'POST' })).status, 200);
    assert.strictEqual((await newUser(b)).status, 200, 'a place is free again');
    assert.strictEqual((await newUser(b)).status, 403);
    // approving does not change the count; disabling frees a place; enabling takes it again and is checked
    const pending = (await call(`/api/admin/clients/${b.id}/users`, { token: W.adminToken })).json.filter(u => u.pendingApproval);
    for (const u of pending) assert.strictEqual((await call(`/api/admin/clients/${b.id}/users/${u.id}/approve`, { token: W.adminToken, method: 'POST' })).status, 200);
    const [one, two] = (await call(`/api/admin/clients/${b.id}/users`, { token: W.adminToken })).json.filter(u => u.tenantRole === 'CASHIER');
    const patch = (u, active) => call(`/api/admin/clients/${b.id}/users/${u.id}`, { token: W.adminToken, method: 'PATCH', body: { active } });
    assert.strictEqual((await patch(one, false)).status, 200);
    assert.strictEqual((await newUser(b)).status, 200, 'the disabled user\'s place was used');
    const back = await patch(one, true);
    assert.strictEqual(back.status, 403, 'so enabling the first one again needs a place');
    assert.match(back.json.error, /allows 3 users/);
    assert.strictEqual((await patch(two, false)).status, 200);
    assert.strictEqual((await patch(one, true)).status, 200, 'with a place free it works');
});

run('plan limits: a bigger plan opens room at once; a smaller one keeps what is there but adds nothing', async () => {
    const b = await business('resize', { plan: 'starter' });
    for (let i = 0; i < 2; i++) assert.strictEqual((await newUser(b)).status, 200);
    assert.strictEqual((await newUser(b)).status, 403);
    assert.strictEqual((await setPlan(b.id, 'pro')).status, 200); // 15 users
    for (let i = 0; i < 5; i++) assert.strictEqual((await newUser(b)).status, 200, 'room on Pro');
    assert.strictEqual((await setPlan(b.id, 'starter')).status, 200); // 8 users on a plan of 3
    const users = (await call('/api/client/users', { token: b.token })).json;
    assert.strictEqual(users.length, 8, 'nobody was removed');
    const refused = await newUser(b);
    assert.strictEqual(refused.status, 403);
    assert.strictEqual(refused.json.error, 'The Starter plan allows 3 users and you have 8. Ask ETAX to move you to a bigger plan.', 'over the limit: it says how many there are, not "all 3 are in use"');
    const usage = (await call('/api/client/plan', { token: b.token })).json.rows.find(x => x.kind === 'users');
    assert.deepStrictEqual([usage.used, usage.limit], [8, 3], 'the screen shows it is over');
});

run('plan limits: no plan and Enterprise have no limits', async () => {
    for (const plan of [null, 'enterprise']) {
        const b = await business('free' + (plan || 'none'), { plan });
        for (let i = 0; i < 6; i++) assert.strictEqual((await newUser(b)).status, 200, `${plan}: user ${i + 2}`);
        for (let i = 0; i < 4; i++) assert.strictEqual((await call('/api/pos/branches', { token: b.token, method: 'POST', body: { name: `B${i}`, city: 'Lahore' } })).status, 200);
    }
});

run('plan limits: Point of Sale branches and counters (terminals), and a place comes back when one is switched off', async () => {
    const b = await business('pos', { plan: 'starter' }); // 1 branch, 2 terminals
    const post = (url, body) => call(url, { token: b.token, method: 'POST', body });
    const put = (url, body) => call(url, { token: b.token, method: 'PUT', body });
    let r = await post('/api/pos/branches', { name: 'Main', city: 'Lahore' });
    assert.strictEqual(r.status, 200, r.text);
    const branch = r.json[0];
    r = await post('/api/pos/branches', { name: 'Second', city: 'Lahore' });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.error, 'The Starter plan allows 1 branch and it is in use. Ask ETAX to move you to a bigger plan.');
    const counter = n => post('/api/pos/counters', { branchId: branch.id, name: n, posId: String(900000 + seq++), env: 'SANDBOX' });
    assert.strictEqual((await counter('Till 1')).status, 200);
    assert.strictEqual((await counter('Till 2')).status, 200);
    r = await counter('Till 3');
    assert.strictEqual(r.status, 403);
    assert.match(r.json.error, /allows 2 terminals \(counters\) and all 2 are in use/);
    // decommissioning a counter frees its place; switching it on again takes it back
    const counters = (await call('/api/pos/branches', { token: b.token })).json[0].counters;
    assert.strictEqual((await post(`/api/pos/counters/${counters[0].id}/decommission`, {})).status, 200);
    assert.strictEqual((await counter('Till 3')).status, 200, 'the place is free');
    const again = await put(`/api/pos/counters/${counters[0].id}`, { name: counters[0].name, posId: counters[0].posId, env: 'SANDBOX', active: true });
    assert.strictEqual(again.status, 403, 'and switching the old one on needs a place');
    // a branch that is closed gives its place back; opening it again is checked
    assert.strictEqual((await put(`/api/pos/branches/${branch.id}`, { name: 'Main', active: false })).status, 200);
    assert.strictEqual((await post('/api/pos/branches', { name: 'Second', city: 'Lahore' })).status, 200, 'the closed branch gave its place');
    assert.strictEqual((await put(`/api/pos/branches/${branch.id}`, { name: 'Main', active: true })).status, 403);
});

run('plan limits: products and items: 1,000 on Starter, the last one fits, the next does not, and putting one back on sale is checked', async () => {
    const b = await business('items', { plan: 'starter' });
    // 999 of each already there
    await prisma.posItem.createMany({ data: Array.from({ length: 999 }, (_, i) => ({ tenantId: b.id, code: `BULK${i}`, name: `Bulk item ${i}`, pctCode: '98012000', taxRate: 16, unitPrice: 10 })) });
    await prisma.product.createMany({ data: Array.from({ length: 999 }, (_, i) => ({ tenantId: b.id, name: `Bulk product ${i}`, description: 'x', notes: 'x', hsCode: '0101.2100', uoM: 'Numbers, pieces, units' })) });
    const item = n => call('/api/pos/items', { token: b.token, method: 'POST', body: { name: n, pctCode: '9801.2000', taxRate: 16, unitPrice: 50 } });
    let r = await item('The 1000th');
    assert.strictEqual(r.status, 200, r.text);
    r = await item('The 1001st');
    assert.strictEqual(r.status, 403);
    assert.match(r.json.error, /allows 1,000 items and all 1,000 are in use/);
    // switching one off frees a place, switching it on again is checked
    const first = (await call('/api/pos/items', { token: b.token })).json.find(i => i.name === 'The 1000th');
    assert.strictEqual((await call(`/api/pos/items/${first.id}`, { token: b.token, method: 'PUT', body: { ...first, active: false } })).status, 200);
    assert.strictEqual((await item('Replacement')).status, 200);
    const back = await call(`/api/pos/items/${first.id}`, { token: b.token, method: 'PUT', body: { ...first, active: true } });
    assert.strictEqual(back.status, 403);
    // an item that is only edited is not "added"
    const edit = await call(`/api/pos/items/${(await call('/api/pos/items', { token: b.token })).json.find(i => i.name === 'Replacement').id}`, { token: b.token, method: 'PUT', body: { name: 'Replacement renamed', pctCode: '98012000', taxRate: 16, unitPrice: 55 } });
    assert.strictEqual(edit.status, 200, edit.text);
    // Digital Invoicing products: the same rule, counted apart from the Point of Sale items
    const product = n => call('/api/products', { token: b.token, method: 'POST', body: { name: n, description: 'd', notes: 'n', hsCode: '0101.2100', uoM: 'Numbers, pieces, units', unitPrice: 10 } });
    r = await product('The 1000th product');
    assert.strictEqual(r.status, 200, r.text);
    r = await product('The 1001st product');
    assert.strictEqual(r.status, 403, r.text);
    assert.match(r.json.error, /allows 1,000 products and all 1,000 are in use/);
    r = await product('The 1000th product'); // saving the same product again is an update, not an addition
    assert.strictEqual(r.status, 200, r.text);
});

test.after(async () => {
    if (W.child) W.child.kill();
    for (const id of W.tenants) {
        await prisma.posSale.deleteMany({ where: { tenantId: id } });
        await prisma.posCounter.deleteMany({ where: { tenantId: id } });
        await prisma.posBranch.deleteMany({ where: { tenantId: id } });
        await prisma.posItem.deleteMany({ where: { tenantId: id } });
        await prisma.productTaxRule.deleteMany({ where: { tenantId: id } }).catch(() => {});
        await prisma.product.deleteMany({ where: { tenantId: id } });
        await prisma.posProfile.deleteMany({ where: { tenantId: id } });
        await prisma.user.deleteMany({ where: { tenantId: id } });
        await prisma.tenant.delete({ where: { id } }).catch(e => console.log('cleanup:', e.message));
    }
    await prisma.user.deleteMany({ where: { email: { in: W.emails } } });
    await prisma.$disconnect();
});
