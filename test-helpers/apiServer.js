// A real server on a free port, in test mode (nothing is sent to FBR or PRA), plus a business with its three kinds of user, for the tests
// that go through the HTTP API. It only runs against a database on this computer and removes what it made.
require('dotenv').config({ quiet: true });
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '');
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

function createApi(label) {
    const prisma = new PrismaClient();
    const A = { ok: false, prisma, tenants: [], emails: [] };
    A.call = async (url, { token, method = 'GET', body, raw } = {}) => {
        const r = await fetch(`http://127.0.0.1:${A.port}${url}`, { method, headers: { 'content-type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = Buffer.from(await r.arrayBuffer()).toString('utf8'); // (r.text() would drop the byte-order mark of a spreadsheet)
        let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: r.status, headers: r.headers, text, json };
    };
    A.login = async (email, password) => (await A.call('/api/auth/login', { method: 'POST', body: { email, password } })).json.token;
    A.strong = tag => `Api!Pass#1${tag}`;

    // Starts the server and makes a business with an owner, a manager (ACCOUNTANT) and a cashier. Skips the file when there is no database.
    A.setup = async (t, { modules = ['POS'], extraEnv = {} } = {}) => {
        if (!local) { t.skip('this test only runs against a database on this computer'); return false; }
        try { await Promise.race([prisma.$queryRaw`SELECT 1`, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]); } catch { t.skip('no local database'); return false; }
        A.tag = crypto.randomBytes(4).toString('hex');
        A.password = A.strong(A.tag);
        A.hash = await bcrypt.hash(A.password, 10);
        const tenant = await prisma.tenant.create({ data: { companyName: `TEST ${label} ${A.tag}`, modules } });
        A.tenantId = tenant.id; A.tenants.push(tenant.id);
        for (const [key, tenantRole] of [['owner', 'OWNER'], ['manager', 'ACCOUNTANT'], ['cashier', 'CASHIER']]) {
            const email = `${label}-${key}-${A.tag}@example.com`;
            await prisma.user.create({ data: { email, password: A.hash, role: 'CLIENT_USER', tenantRole, tenantId: tenant.id, name: key } });
            A.emails.push(email);
            A[key] = { email };
        }
        A.port = await freePort();
        A.child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(A.port), FBR_MOCK: 'true', PRA_MOCK: 'true', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        const up = await new Promise(resolve => {
            const timer = setTimeout(() => resolve(false), 30000);
            A.child.stdout.on('data', d => { out += d; if (/FBR billing app on/.test(out)) { clearTimeout(timer); resolve(true); } });
            A.child.stderr.on('data', d => { out += d; });
            A.child.on('exit', () => resolve(false));
        });
        if (!up) throw new Error('the server did not start:\n' + out.slice(-800));
        for (const key of ['owner', 'manager', 'cashier']) A[key].token = await A.login(A[key].email, A.password);
        A.ok = true;
        return true;
    };
    A.run = (name, fn) => require('node:test')(name, async t => { if (!A.ok) return t.skip('no local database'); await fn(t); });
    A.teardown = async () => {
        if (A.child) A.child.kill();
        if (A.ok) {
            for (const id of A.tenants) {
                await prisma.posSale.deleteMany({ where: { tenantId: id } });
                for (const model of A.models || ['posImportBatch', 'posManualInvoice', 'posCashEntry', 'posPurchase', 'posVendor', 'posCounter', 'posBranch', 'posItem', 'posCustomer', 'posProfile']) { try { await prisma[model].deleteMany({ where: { tenantId: id } }); } catch { /* a table this test never used */ } }
                await prisma.user.deleteMany({ where: { tenantId: id } });
                await prisma.auditLog.deleteMany({ where: { tenantId: id } }).catch(() => {});
                await prisma.tenant.delete({ where: { id } }).catch(e => console.log('cleanup:', e.message));
            }
        }
        await prisma.$disconnect();
    };
    return A;
}

module.exports = { createApi };
