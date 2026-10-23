// The demo-data script for one client (scripts/seed-demo-client.js): run for real against the local database, on a client made for the
// test, next to a second client that must come out untouched.
require('dotenv').config({ quiet: true });
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '');
const prisma = new PrismaClient();
const tag = crypto.randomBytes(3).toString('hex');
const PASSWORD = `Demo#Test${tag}1`;
const T = {}; // the clients made for this test
let ok = false;

const script = (args, env = {}) => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed-demo-client.js'), ...args], { env: { ...process.env, DEMO_PASSWORD: PASSWORD, ...env }, encoding: 'utf8', timeout: 120000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const posCount = async tenantId => ({
    profile: await prisma.posProfile.count({ where: { tenantId } }), branches: await prisma.posBranch.count({ where: { tenantId } }), counters: await prisma.posCounter.count({ where: { tenantId } }),
    items: await prisma.posItem.count({ where: { tenantId } }), customers: await prisma.posCustomer.count({ where: { tenantId } }), sales: await prisma.posSale.count({ where: { tenantId } }),
});

test('demo client script: make the clients', async t => {
    if (!local) return t.skip('this test only runs against a database on this computer');
    try { await Promise.race([prisma.$queryRaw`SELECT 1`, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]); } catch { return t.skip('no local database'); }
    const hash = await bcrypt.hash('x', 4);
    for (const [key, modules] of [['demo', ['INVOICING', 'POS']], ['bystander', ['INVOICING', 'POS']], ['noPos', ['INVOICING']]]) {
        const name = `TEST Demo ${key} ${tag}`;
        const tenant = await prisma.tenant.create({ data: { companyName: name, modules } });
        const email = `owner-${key}-${tag}@example.com`;
        await prisma.user.create({ data: { email, password: hash, role: 'CLIENT_USER', tenantRole: 'OWNER', tenantId: tenant.id } });
        T[key] = { id: tenant.id, email, name, domain: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}-demo.example.com` };
    }
    ok = true;
});
const run = (name, fn) => test(name, async t => { if (!ok) return t.skip('no local database'); await fn(t); });
test.after(async () => {
    for (const c of Object.values(T)) {
        await prisma.posSale.deleteMany({ where: { tenantId: c.id } });
        for (const m of ['posManualInvoice', 'posCashEntry', 'posPurchase', 'posVendor', 'posCustomer', 'posCounter', 'posBranch', 'posItem', 'posProfile', 'auditLog']) await prisma[m].deleteMany({ where: { tenantId: c.id } }).catch(() => {});
        await prisma.user.deleteMany({ where: { tenantId: c.id } });
        await prisma.tenant.delete({ where: { id: c.id } }).catch(e => console.log('cleanup:', e.message));
    }
    await prisma.$disconnect();
});

run('demo client script: it says what it would do and writes nothing without --yes', async () => {
    const r = script(['--owner', T.demo.email]);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /DRY RUN: nothing will be written/);
    assert.match(r.out, new RegExp(`Client   : "${T.demo.name}"`));
    assert.match(r.out, /Nothing was changed/);
    assert.deepStrictEqual(Object.values(await posCount(T.demo.id)), [0, 0, 0, 0, 0, 0]);
    assert.strictEqual(await prisma.user.count({ where: { tenantId: T.demo.id } }), 1, 'no logins either');
});

run('demo client script: what it refuses', async () => {
    const stop = (r, re) => { assert.strictEqual(r.code, 1, r.out); assert.match(r.out, re); };
    stop(script([]), /say whose client this is/);
    stop(script(['--owner', 'not-an-address']), /say whose client this is/);
    stop(script(['--owner', `nobody-${tag}@example.com`, '--yes']), /no client owner has the e-mail/);
    stop(script(['--owner', T.noPos.email, '--yes']), /does not have the Point of Sale module/);
    stop(script(['--owner', T.demo.email, '--yes'], { PRA_MOCK: 'false' }), /demo data is made in test mode only/);
    stop(script(['--owner', T.demo.email, '--yes'], { DEMO_PASSWORD: '' }), /DEMO_PASSWORD/);
    stop(script(['--owner', T.demo.email, '--yes'], { DEMO_PASSWORD: 'short' }), /DEMO_PASSWORD/);
    assert.deepStrictEqual(Object.values(await posCount(T.demo.id)), [0, 0, 0, 0, 0, 0], 'a refusal writes nothing');
});

run('demo client script: it makes a fortnight of every kind of Point of Sale data, in date order, for that client only', async () => {
    const r = script(['--owner', T.demo.email, '--yes']);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Done\./);
    const id = T.demo.id;
    const count = await posCount(id);
    assert.deepStrictEqual([count.profile, count.branches, count.counters, count.items, count.customers], [1, 2, 3, 23, 5]);
    assert.ok(count.sales >= 60 && count.sales <= 130, `a fortnight of sales and returns (${count.sales})`);
    // the logins: a manager and a cashier who can sign in with the password
    const people = await prisma.user.findMany({ where: { tenantId: id }, orderBy: { email: 'asc' } });
    assert.deepStrictEqual(people.map(u => [u.email.split('@')[0], u.tenantRole, u.active, u.pendingApproval, u.mustChangePassword]), [['cashier', 'CASHIER', true, false, false], [T.demo.email.split('@')[0], 'OWNER', true, false, false], ['manager', 'ACCOUNTANT', true, false, false]].sort((a, b) => a[0].localeCompare(b[0])));
    for (const u of people.filter(u => u.tenantRole !== 'OWNER')) { assert.ok(u.email.endsWith(`@${T.demo.domain}`)); assert.ok(await bcrypt.compare(PASSWORD, u.password), `${u.email} signs in with the password`); assert.ok(!u.password.includes(PASSWORD)); }
    // every way of paying, sales and returns, the two sales PRA refused, test mode throughout
    const sales = await prisma.posSale.findMany({ where: { tenantId: id }, orderBy: { usin: 'asc' }, include: { lines: true } });
    const modes = new Set(sales.filter(s => s.state === 'FISCALIZED' && s.invoiceType === 1).map(s => s.paymentMode));
    assert.deepStrictEqual([...modes].sort(), [1, 2, 3, 4, 5, 6], 'cash, card, voucher, loyalty, mixed and cheque');
    assert.ok(sales.filter(s => s.invoiceType === 3 && s.state === 'FISCALIZED').length >= 3, 'returns');
    assert.deepStrictEqual([sales.filter(s => s.state === 'REJECTED').length, sales.filter(s => s.state === 'CANCELLED').length], [1, 1], 'one refused by PRA, one cancelled');
    assert.ok(sales.every(s => s.env === 'SANDBOX') && sales.filter(s => s.state === 'FISCALIZED').every(s => s.mock), 'test mode throughout: nothing was ever sent to PRA');
    assert.ok(sales.filter(s => s.state === 'FISCALIZED').every(s => /^MOCK-/.test(s.fiscalNumber)));
    // invoice numbers run in the order of the dates, and the returns come after the sales they return
    for (let i = 1; i < sales.length; i++) assert.ok(sales[i].createdAt >= sales[i - 1].createdAt, `invoice ${sales[i].usin} is not older than ${sales[i - 1].usin}`);
    const byId = new Map(sales.map(s => [s.id, s]));
    for (const s of sales.filter(s => s.invoiceType === 3)) assert.ok(s.createdAt > byId.get(s.refSaleId).createdAt, 'a return is after its sale');
    // a fortnight: every day but possibly today (which has only what has already happened)
    const days = new Set(sales.map(s => s.createdAt.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })));
    assert.ok(days.size >= 13 && days.size <= 14, `${days.size} days`);
    const first = Math.min(...sales.map(s => +s.createdAt)), last = Math.max(...sales.map(s => +s.createdAt));
    assert.ok(last <= Date.now(), 'nothing in the future');
    assert.ok(Date.now() - first <= 15 * 86400e3 && Date.now() - first >= 11 * 86400e3, 'it starts about two weeks ago');
    // the big banquet bills carry the buyer's details (the rule above Rs 50,000), and the events are in the hall's branch
    const big = sales.filter(s => Number(s.totalSaleValue) > 50000 && s.invoiceType === 1);
    assert.ok(big.length >= 2 && big.every(s => s.buyerName && (s.buyerPntn || s.buyerCnic)), 'a bill above Rs 50,000 names its buyer');
    // sales by three people (cashier, manager, owner) on more than one counter
    assert.deepStrictEqual([...new Set(sales.map(s => s.createdBy.split('@')[0]))].sort(), ['cashier', T.demo.email.split('@')[0], 'manager'].sort());
    assert.ok(new Set(sales.map(s => s.counterId)).size === 3, 'all three counters were used');
    // the menu: categories on every sold line, barcodes, one item switched off, open-price items, one customer switched off
    assert.ok(sales.flatMap(s => s.lines).every(l => l.category), 'every line carries its category');
    const items = await prisma.posItem.findMany({ where: { tenantId: id } });
    assert.ok(items.filter(i => i.barcode).length >= 4 && items.filter(i => !i.active).length === 1 && items.filter(i => i.openPrice).length === 2);
    assert.deepStrictEqual([...new Set(items.map(i => i.category))].sort(), ['Dining', 'Drinks', 'Events & catering', 'Shop']);
    assert.strictEqual((await prisma.posCustomer.findMany({ where: { tenantId: id } })).filter(c => !c.active).length, 1);
    const profile = await prisma.posProfile.findUnique({ where: { tenantId: id } });
    assert.ok(profile.businessName && profile.pntn && profile.receiptHeader && profile.receiptWidth === 80);
    // one line in the activity trail says what was done, and the individual actions are not faked into it
    const trail = await prisma.auditLog.findMany({ where: { tenantId: id } });
    assert.deepStrictEqual(trail.map(a => a.action), ['admin.demo_data']);
    assert.match(trail[0].summary, /Demo Point of Sale data added/);
    // the other client, and the one without Point of Sale, did not change at all
    assert.deepStrictEqual(Object.values(await posCount(T.bystander.id)), [0, 0, 0, 0, 0, 0]);
    assert.strictEqual(await prisma.user.count({ where: { tenantId: T.bystander.id } }), 1);
    assert.strictEqual(await prisma.auditLog.count({ where: { tenantId: T.bystander.id } }), 0);
    assert.strictEqual((await prisma.tenant.findUnique({ where: { id: T.bystander.id } })).posSeq, 0);
});

run('demo client script: it adds to nothing that is already there, and --wipe takes exactly what it made', async () => {
    const again = script(['--owner', T.demo.email, '--yes']);
    assert.strictEqual(again.code, 1, again.out);
    assert.match(again.out, /already has Point of Sale data/);
    const dry = script(['--owner', T.demo.email, '--wipe']);
    assert.strictEqual(dry.code, 0, dry.out);
    assert.match(dry.out, /WOULD REMOVE/);
    assert.ok((await posCount(T.demo.id)).sales > 0, 'a dry wipe removes nothing');
    const wipe = script(['--owner', T.demo.email, '--wipe', '--yes']);
    assert.strictEqual(wipe.code, 0, wipe.out);
    assert.deepStrictEqual(Object.values(await posCount(T.demo.id)), [0, 0, 0, 0, 0, 0]);
    assert.strictEqual(await prisma.user.count({ where: { tenantId: T.demo.id } }), 1, 'only the owner is left');
    assert.strictEqual((await prisma.tenant.findUnique({ where: { id: T.demo.id } })).posSeq, 0, 'invoice numbers start again');
    assert.strictEqual(await prisma.auditLog.count({ where: { tenantId: T.demo.id, action: 'admin.demo_data' } }), 1, 'the activity trail keeps its line');
    // and it can be made again (the way to bring the fortnight up to date before a demo)
    const second = script(['--owner', T.demo.email, '--yes']);
    assert.strictEqual(second.code, 0, second.out);
    assert.ok((await posCount(T.demo.id)).sales >= 60);
    // a demo login address that belongs to another client is never taken over
    const other = await prisma.user.findFirst({ where: { tenantId: T.demo.id, tenantRole: 'CASHIER' } });
    await prisma.user.update({ where: { id: other.id }, data: { tenantId: T.bystander.id } });
    const wipeOther = script(['--owner', T.demo.email, '--wipe', '--yes']);
    assert.strictEqual(wipeOther.code, 1, wipeOther.out);
    assert.match(wipeOther.out, /belongs to another client/);
    await prisma.user.update({ where: { id: other.id }, data: { tenantId: T.demo.id } });
    assert.strictEqual(script(['--owner', T.demo.email, '--wipe', '--yes']).code, 0);
});
