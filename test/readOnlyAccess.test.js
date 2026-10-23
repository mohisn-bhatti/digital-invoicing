// A client whose access period is over can LOOK (log in, view, print, download) but changes nothing; one switched off by hand cannot even log in; renewing
// makes everything work again at once. Through the real server and database.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');

const A = createApi('ro');
const run = A.run;
test('read-only: start a server and a business with both products', { timeout: 90000 }, async t => { await A.setup(t, { modules: ['INVOICING', 'POS'] }); });
test.after(async () => {
    if (A.ok) { await A.prisma.supportTicket.deleteMany({ where: { tenantId: A.tenantId } }); if (A.admin) await A.prisma.user.deleteMany({ where: { email: A.admin.email } }); }
    await A.teardown();
});

const PKT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' });
const dayPlus = n => { const d = new Date(`${PKT.format(new Date())}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const at = day => new Date(`${day}T00:00:00+05:00`);
const call = (url, who, method = 'GET', body) => A.call(url, { token: typeof who === 'string' && A[who] ? A[who].token : who, method, body });
const setPeriod = (data) => A.prisma.tenant.update({ where: { id: A.tenantId }, data });
const LAPSED = { active: false, inactiveReason: 'EXPIRED', accessUnit: 'YEAR', accessCount: 1, accessEndsAt: at(dayPlus(-30)) };
const counts = async () => Object.fromEntries(await Promise.all(['posItem', 'posCustomer', 'posVendor', 'posSale', 'posPurchase', 'posCashEntry', 'posManualInvoice', 'posBranch', 'posImportBatch', 'product', 'invoice'].map(async m => [m, await A.prisma[m].count({ where: { tenantId: A.tenantId } })])));

run('read-only: setup: a business with records, made while it was in good standing', async () => {
    const branch = (await call('/api/pos/branches', 'owner', 'POST', { name: 'Main' })).json[0];
    A.counter = (await call('/api/pos/counters', 'owner', 'POST', { branchId: branch.id, name: 'Till 1', posId: '990001', env: 'SANDBOX' })).json[0].counters[0];
    A.item = (await call('/api/pos/items', 'manager', 'POST', { name: 'Lunch', pctCode: '9801.2000', taxRate: 16, unitPrice: 500 })).json;
    A.sale = (await call('/api/pos/sales', 'cashier', 'POST', { counterId: A.counter.id, paymentMode: 1, lines: [{ itemId: A.item.id, quantity: 2 }] })).json.sale;
    A.cust = (await call('/api/pos/customers', 'manager', 'POST', { name: 'Regular Customer' })).json;
    A.vend = (await call('/api/pos/vendors', 'manager', 'POST', { name: 'Regular Vendor' })).json;
    A.bill = (await call('/api/pos/purchases', 'manager', 'POST', { vendorId: A.vend.id, lines: [{ itemName: 'x', quantity: 1, unitCost: 100 }] })).json;
    assert.ok(A.sale.id && A.cust.id && A.bill.id);
    A.admin = { email: `ro-admin-${A.tag}@example.com` };
    await A.prisma.user.create({ data: { email: A.admin.email, password: A.hash, role: 'SUPER_ADMIN', name: 'RO Admin' } });
    A.admin.token = await A.login(A.admin.email, A.password);
    // tokens issued while all was well
    A.tokens = { owner: A.owner.token, manager: A.manager.token, cashier: A.cashier.token };
    assert.strictEqual((await call('/api/client/settings', 'owner')).json.readOnly, false);
});

run('read-only: a client in its grace period still uses everything', async () => {
    await setPeriod({ active: true, inactiveReason: null, accessUnit: 'YEAR', accessCount: 1, accessEndsAt: at(dayPlus(-2)) }); // ended 2 days ago, 7 days of grace
    const r = await call('/api/pos/branches', 'owner', 'POST', { name: 'Grace branch' });
    assert.strictEqual(r.status, 200, r.text);
    const s = (await call('/api/client/settings', 'owner')).json;
    assert.deepStrictEqual([s.readOnly, s.readOnlyMessage], [false, null]);
    await A.prisma.posBranch.deleteMany({ where: { tenantId: A.tenantId, name: 'Grace branch' } });
});

run('read-only: once the period is over it is told so, whether or not the nightly job has noted it', async () => {
    for (const state of [{ ...LAPSED, active: true, inactiveReason: null } /* job has not run */, LAPSED /* job has run */]) {
        await setPeriod(state);
        const s = (await call('/api/client/settings', 'owner')).json;
        assert.strictEqual(s.readOnly, true, JSON.stringify(state));
        assert.match(s.readOnlyMessage, /^Your access period ended on \d+ \w+ 20\d\d\. You can look at, print and download your records, but you cannot make changes\. Contact ETAX to renew it\.$/);
    }
});

run('read-only: it can log in, and sessions that were already open keep working for reading', async () => {
    const login = await A.call('/api/auth/login', { method: 'POST', body: { email: A.owner.email, password: A.password } });
    assert.strictEqual(login.status, 200, login.text);
    for (const who of ['owner', 'manager', 'cashier']) assert.strictEqual((await call('/api/client/settings', A.tokens[who])).status, 200, `${who} with an old token`);
});

run('read-only: everything it needs to look at, print and download is there, for each person who could before', async () => {
    const reads = [
        ['/api/pos/sales?limit=5', ['owner', 'manager', 'cashier']], [`/api/pos/sales/${A.sale.id}`, ['owner', 'manager', 'cashier']], [`/api/pos/sales/${A.sale.id}/receipt`, ['owner', 'manager', 'cashier']],
        ['/api/pos/items', ['owner', 'manager', 'cashier']], ['/api/pos/customers', ['owner', 'manager']], [`/api/pos/customers/${A.cust.id}`, ['owner', 'manager']], [`/api/pos/customers/${A.cust.id}/ledger`, ['owner', 'manager']],
        ['/api/pos/vendors', ['owner', 'manager']], ['/api/pos/purchases', ['owner', 'manager']], [`/api/pos/purchases/${A.bill.id}`, ['owner', 'manager']], ['/api/pos/cash', ['owner', 'manager']], ['/api/pos/cashbook', ['owner', 'manager']],
        ['/api/pos/overview', ['owner', 'manager', 'cashier']], ['/api/pos/alerts', ['owner', 'manager', 'cashier']], ['/api/pos/setup', ['owner', 'manager', 'cashier']], ['/api/pos/settings', ['owner', 'manager', 'cashier']],
        [`/api/pos/reports/by/day?from=${dayPlus(-60)}&to=${dayPlus(0)}`, ['owner', 'manager']], [`/api/pos/reports/closing?date=${dayPlus(0)}`, ['owner', 'manager']], ['/api/pos/import/batches', ['owner', 'manager']],
        ['/api/pos/export/sales', ['owner', 'manager']], ['/api/pos/export/customers', ['owner', 'manager']], ['/api/pos/export/vendors', ['owner', 'manager']], ['/api/pos/export/cashbook', ['owner', 'manager']],
        ['/api/pos/retention', ['owner']], ['/api/pos/branches', ['owner', 'manager']], ['/api/pos/logo', ['owner', 'manager', 'cashier']],
        ['/api/invoices', ['owner', 'manager', 'cashier']], ['/api/client/dashboard', ['owner', 'manager', 'cashier']], ['/api/client/tickets', ['owner', 'manager', 'cashier']], ['/api/client/plan', ['owner', 'manager', 'cashier']],
    ];
    for (const [url, who] of reads) for (const w of who) { const r = await call(url, A.tokens[w]); assert.strictEqual(r.status, 200, `${w} GET ${url}: ${r.status} ${r.text.slice(0, 150)}`); }
    const csv = await call('/api/pos/export/sales', A.tokens.manager);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.ok(csv.text.includes(A.sale.usin), 'the download has the records');
});

run('read-only: it can change NOTHING: every kind of write is refused with the reason, and nothing in the database moves', async () => {
    const before = await counts();
    const writes = [
        ['POST', '/api/pos/sales', 'cashier', { counterId: A.counter.id, paymentMode: 1, lines: [{ itemId: A.item.id, quantity: 1 }] }],
        ['POST', `/api/pos/sales/${A.sale.id}/credit-note`, 'manager', { reason: 'return', lines: [{ lineId: A.sale.lines[0].id, quantity: 1 }] }],
        ['POST', `/api/pos/sales/${A.sale.id}/debit-note`, 'manager', { reason: 'more', lines: [{ lineId: A.sale.lines[0].id, quantity: 1 }] }],
        ['POST', `/api/pos/sales/${A.sale.id}/retry`, 'cashier', {}], ['POST', `/api/pos/sales/${A.sale.id}/cancel`, 'manager', { reason: 'no' }],
        ['PATCH', `/api/pos/sales/${A.sale.id}`, 'cashier', { buyer: { name: 'x' } }],
        ['POST', '/api/pos/items', 'manager', { name: 'New', pctCode: '9801.2000', taxRate: 16, unitPrice: 1 }], ['PUT', `/api/pos/items/${A.item.id}`, 'manager', { unitPrice: 1 }],
        ['POST', '/api/pos/customers', 'cashier', { name: 'New customer' }], ['PUT', `/api/pos/customers/${A.cust.id}`, 'manager', { name: 'Renamed' }], ['PUT', `/api/pos/customers/${A.cust.id}/opening-balance`, 'manager', { openingBalance: '5000' }],
        ['POST', '/api/pos/vendors', 'manager', { name: 'New vendor' }], ['PUT', `/api/pos/vendors/${A.vend.id}`, 'manager', { name: 'Renamed' }],
        ['POST', '/api/pos/purchases', 'manager', { vendorId: A.vend.id, lines: [{ itemName: 'x', quantity: 1, unitCost: 1 }] }], ['POST', `/api/pos/purchases/${A.bill.id}/void`, 'manager', { reason: 'no' }],
        ['POST', '/api/pos/cash/pay', 'manager', { vendorId: A.vend.id, amount: '1' }], ['POST', '/api/pos/cash/receive', 'manager', { customerId: A.cust.id, amount: '1' }],
        ['POST', '/api/pos/manual', 'cashier', { bookNumber: 'X1', writtenAt: `${dayPlus(-1)}T10:00`, description: 'x', saleValue: '10' }],
        ['POST', '/api/pos/import/items/check', 'manager', { fileName: 'x', headers: ['name'], rows: [{ row: 2, name: 'x' }] }], ['POST', '/api/pos/import/items/commit', 'manager', { fileName: 'x', headers: ['name'], rows: [{ row: 2, name: 'x' }] }],
        ['POST', '/api/pos/import/batches/x/undo', 'manager', {}],
        ['PUT', '/api/pos/settings', 'owner', { receiptHeader: 'changed' }], ['PUT', '/api/pos/profile', 'owner', { businessName: 'Changed' }], ['PUT', '/api/pos/logo', 'owner', { logo: 'data:image/png;base64,AAAA' }], ['DELETE', '/api/pos/logo', 'owner'],
        ['POST', '/api/pos/branches', 'owner', { name: 'Another' }], ['POST', `/api/pos/counters/${A.counter.id}/token`, 'owner', { token: 'x' }], ['POST', `/api/pos/counters/${A.counter.id}/decommission`, 'owner', {}],
        ['POST', '/api/invoices', 'manager', {}], ['POST', '/api/drafts', 'manager', {}], ['PUT', '/api/client/contact', 'owner', {}],
        ['POST', '/api/products/import/commit', 'manager', {}], ['POST', '/api/buyers/import', 'manager', {}], ['POST', '/api/client/users', 'owner', { email: 'new@example.com' }],
    ];
    for (const [method, url, who, body] of writes) {
        const r = await call(url, A.tokens[who], method, body);
        assert.strictEqual(r.status, 403, `${method} ${url} as ${who}: ${r.status} ${r.text.slice(0, 160)}`);
        assert.strictEqual(r.json.readOnly, true, `${method} ${url} says why`);
        assert.match(r.json.error, /access period ended on .*you cannot make changes\. Contact ETAX to renew/);
    }
    assert.deepStrictEqual(await counts(), before, 'not one record was added, changed or removed');
    assert.strictEqual((await A.prisma.posItem.findFirst({ where: { id: A.item.id } })).name, 'Lunch');
    assert.strictEqual((await A.prisma.posVendor.findFirst({ where: { id: A.vend.id } })).name, 'Regular Vendor');
});

run('read-only: it can still leave, change its own password, and write to ETAX to ask for a renewal', async () => {
    const ticket = await call('/api/client/tickets', A.tokens.owner, 'POST', { category: 'Other', subject: 'Please renew us', message: 'We would like to renew our access.' });
    assert.strictEqual(ticket.status, 200, ticket.text);
    const reply = await call(`/api/client/tickets/${ticket.json.id}/messages`, A.tokens.owner, 'POST', { message: 'Any news?' });
    assert.strictEqual(reply.status, 200, reply.text);
    assert.strictEqual((await call('/api/client/tickets', A.tokens.owner)).json.length, 1);
    assert.strictEqual((await A.call('/api/auth/logout?from=app', { token: A.tokens.cashier, method: 'POST', body: {} })).status, 200, 'a query string does not matter');
    // the exact paths only: a look-alike is a write like any other
    for (const [method, url] of [['POST', `/api/client/tickets/${ticket.json.id}/delete`], ['POST', '/api/client/tickets/x/messages/y'], ['DELETE', '/api/client/tickets'], ['PUT', '/api/client/tickets'], ['DELETE', `/api/client/tickets/${ticket.json.id}`]]) {
        const r = await A.call(url, { token: A.tokens.owner, method, body: {} });
        assert.ok([403, 404].includes(r.status), `${method} ${url} must not succeed: ${r.status}`); // (a route that does not exist is a 404)
    }
    assert.strictEqual((await A.call('/api/client/contact', { token: A.tokens.owner, method: 'PUT', body: { mobile: '03001234567' } })).status, 403, 'a real write next door to the allowed ones is still refused');
    // its own password
    const newPass = `New!Pass#9${A.tag}`;
    const pw = await A.call('/api/auth/password', { token: A.tokens.manager, method: 'POST', body: { currentPassword: A.password, newPassword: newPass } });
    assert.strictEqual(pw.status, 200, pw.text);
    const again = await A.call('/api/auth/login', { method: 'POST', body: { email: A.manager.email, password: newPass } });
    assert.strictEqual(again.status, 200, 'and the new password works');
});

run('read-only: an administrator working inside the workspace is not held to it', async () => {
    const ws = await call(`/api/admin/clients/${A.tenantId}/workspace`, 'admin', 'POST', {});
    assert.strictEqual(ws.status, 200, ws.text);
    const r = await call('/api/pos/vendors', ws.json.token, 'POST', { name: 'Made by the administrator' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual((await call('/api/client/settings', ws.json.token)).json.readOnly, false, 'and the screens do not say read-only');
    await A.prisma.posVendor.deleteMany({ where: { tenantId: A.tenantId, name: 'Made by the administrator' } });
});

run('read-only: renewing makes everything work again at once, with the same session', async () => {
    const renew = await call(`/api/admin/clients/${A.tenantId}/access/renew`, 'admin', 'POST', { unit: 'MONTH', count: 3 });
    assert.strictEqual(renew.status, 200, renew.text);
    assert.strictEqual(renew.json.active, true);
    const r = await call('/api/pos/vendors', A.tokens.owner, 'POST', { name: 'After renewal' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual((await call('/api/client/settings', A.tokens.owner)).json.readOnly, false);
    await A.prisma.posVendor.deleteMany({ where: { tenantId: A.tenantId, name: 'After renewal' } });
});

run('read-only: a client switched off by hand is a different thing: it cannot log in, and open sessions end', async () => {
    const off = await call(`/api/admin/clients/${A.tenantId}/settings`, 'admin', 'PUT', { active: false });
    assert.strictEqual(off.status, 200, off.text);
    assert.strictEqual(off.json.inactiveReason, 'ADMIN');
    const login = await A.call('/api/auth/login', { method: 'POST', body: { email: A.owner.email, password: A.password } });
    assert.strictEqual(login.status, 403);
    assert.match(login.json.error, /inactive/);
    assert.strictEqual((await call('/api/pos/sales', A.tokens.owner)).status, 401, 'not even to look');
    // even if its period is over as well
    await setPeriod({ accessUnit: 'YEAR', accessCount: 1, accessEndsAt: at(dayPlus(-100)) });
    assert.strictEqual((await call('/api/pos/sales', A.tokens.owner)).status, 401);
    // switched on again by hand (after a renewal it is a client in good standing again)
    await call(`/api/admin/clients/${A.tenantId}/access/renew`, 'admin', 'POST', { unit: 'MONTH', count: 1 });
    await call(`/api/admin/clients/${A.tenantId}/settings`, 'admin', 'PUT', { active: true });
    assert.strictEqual((await call('/api/pos/sales', A.tokens.owner)).status, 200);
});

run('read-only: the nightly job moves a lapsed client to read-only, and what it says in the log is what happens', async () => {
    await setPeriod({ active: true, inactiveReason: null, accessUnit: 'MONTH', accessCount: 1, accessEndsAt: at(dayPlus(-20)) });
    const { expireDueClients } = require('../src/subscription');
    const { createAudit } = require('../src/audit');
    const ids = await expireDueClients({ prisma: A.prisma, audit: createAudit(A.prisma) });
    assert.ok(ids.includes(A.tenantId));
    const t = await A.prisma.tenant.findUnique({ where: { id: A.tenantId } });
    assert.deepStrictEqual([t.active, t.inactiveReason], [false, 'EXPIRED']);
    const log = await A.prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: 'client.expired' } });
    assert.ok(log.some(x => /made inactive automatically \(it can still log in to look at its records, read-only\)/.test(x.summary)));
    assert.strictEqual((await call('/api/pos/sales', A.tokens.owner)).status, 200, 'it can still look');
    assert.strictEqual((await call('/api/pos/vendors', A.tokens.owner, 'POST', { name: 'x' })).status, 403, 'and cannot change');
});
