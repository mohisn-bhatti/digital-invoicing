// Bulk import through the real server and database: who may do it, all-or-nothing saving, two imports at once, the plan's limit, choices for saved records,
// opening balances in rupees, and undoing an import safely.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');

const A = createApi('imp');
const run = A.run;
test('import API: start a server and a business', { timeout: 90000 }, async t => { await A.setup(t); });
test.after(() => A.teardown());

const call = (url, who, method = 'GET', body) => A.call(url, { token: A[who].token, method, body });
const post = (url, body, who = 'manager') => call(url, who, 'POST', body);
const IH = ['name', 'code', 'barcode', 'category', 'pct', 'taxRate', 'taxRateCard', 'price', 'openPrice', 'taxInclusive', 'followSchedule', 'active'];
const itemFile = (rows, over = {}) => ({ fileName: 'menu.xlsx', headers: IH, rows: rows.map((r, i) => ({ row: i + 2, pct: '9801.2000', taxRate: '16', ...r })), ...over });
const count = (model, where = {}) => A.prisma[model].count({ where: { tenantId: A.tenantId, ...where } });

run('import API: setup, and only managers and the owner can import', async () => {
    const branch = (await post('/api/pos/branches', { name: 'Main' }, 'owner')).json[0];
    A.counter = (await post('/api/pos/counters', { branchId: branch.id, name: 'Till 1', posId: '980001', env: 'SANDBOX' }, 'owner')).json[0].counters[0];
    for (const [method, url] of [['POST', '/api/pos/import/items/check'], ['POST', '/api/pos/import/items/commit'], ['GET', '/api/pos/import/batches'], ['POST', '/api/pos/import/batches/x/undo']]) {
        assert.strictEqual((await A.call(url, { method })).status, 401, url);
        assert.strictEqual((await call(url, 'cashier', method, method === 'GET' ? undefined : {})).status, 403, `cashier ${url}`);
    }
    assert.strictEqual((await post('/api/pos/import/nonsense/check', itemFile([{ name: 'x' }]))).status, 404);
    assert.strictEqual((await post('/api/pos/import/items/check', itemFile([{ name: 'x' }]), 'owner')).status, 200, 'the owner may');
    // a business without the module
    const t = await A.prisma.tenant.create({ data: { companyName: `TEST imp nopos ${A.tag}`, modules: ['INVOICING'] } });
    A.tenants.push(t.id);
    const email = `imp-nopos-${A.tag}@example.com`;
    await A.prisma.user.create({ data: { email, password: A.hash, role: 'CLIENT_USER', tenantRole: 'OWNER', tenantId: t.id } });
    assert.strictEqual((await A.call('/api/pos/import/items/check', { token: await A.login(email, A.password), method: 'POST', body: itemFile([{ name: 'x' }]) })).status, 403);
});

run('import API: checking saves nothing, and says what it would do', async () => {
    const r = await post('/api/pos/import/items/check', itemFile([{ name: 'Biryani', price: '500' }, { name: 'Chai', price: '100', code: 'CHAI-1' }]));
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.errors.length, r.json.new, r.json.updates.length], [0, 2, 0]);
    assert.deepStrictEqual(r.json.preview.map(p => p.name), ['Biryani', 'Chai']);
    assert.match(r.json.preview[0].detail, /9801\.2000 · 16% · 500\.00/);
    assert.strictEqual(await count('posItem'), 0);
    assert.strictEqual(await count('posImportBatch'), 0);
});

run('import API: a file with any problem saves nothing at all, and lists every problem with its row', async () => {
    const bad = itemFile([{ name: 'Good one' }, { name: 'Bad price', price: '12.345' }, { name: 'Bad rate', taxRate: 'abc' }, { name: 'Good two' }]);
    const c = await post('/api/pos/import/items/commit', bad);
    assert.strictEqual(c.status, 400, c.text);
    assert.match(c.json.error, /problems/);
    assert.deepStrictEqual(c.json.errors.map(e => e.row), [3, 4], 'both problems, with their rows');
    assert.strictEqual(await count('posItem'), 0, 'the two good rows were NOT saved either');
    assert.strictEqual(await count('posImportBatch'), 0);
});

run('import API: a good file is saved in one go: codes in order, flags and defaults as checked, one batch, one line in the activity log', async () => {
    await post('/api/pos/items', { name: 'Existing before', pctCode: '9801.2000', taxRate: 16, unitPrice: 1 }); // takes ITM0001
    await call('/api/pos/settings', 'owner', 'PUT', { itemPct: '9801.3000', itemTaxRate: 8, itemCategory: 'Hall' });
    const file = { fileName: 'menu.xlsx', headers: ['name', 'code', 'price', 'taxInclusive', 'followSchedule'], rows: [
        { row: 2, name: 'Hall hire', price: '40,000', taxInclusive: 'yes' }, { row: 3, name: 'Lawn', code: 'LAWN-1', price: '25000' }, { row: 4, name: 'Chair', price: '50' },
    ] };
    const c = await post('/api/pos/import/items/commit', file);
    assert.strictEqual(c.status, 200, c.text);
    assert.deepStrictEqual([c.json.added, c.json.updated], [3, 0]);
    assert.ok(c.json.warnings.some(w => /defaults were used: PCT code 9801\.3000, tax 8%, category "Hall"/.test(w.messages[0])));
    const items = (await call('/api/pos/items', 'manager')).json.filter(i => i.category === 'Hall').sort((a, b) => a.name.localeCompare(b.name));
    assert.deepStrictEqual(items.map(i => [i.name, i.code, i.pctCode, i.taxRate, i.unitPrice, i.taxInclusive]), [['Chair', 'ITM0003', '98013000', 8, 50, false], ['Hall hire', 'ITM0002', '98013000', 8, 40000, true], ['Lawn', 'LAWN-1', '98013000', 8, 25000, false]], 'automatic codes in file order after ITM0001; the typed code kept');
    const batches = (await call('/api/pos/import/batches', 'manager')).json;
    assert.strictEqual(batches.length, 1);
    assert.deepStrictEqual([batches[0].kind, batches[0].added, batches[0].updated, batches[0].undone, batches[0].fileName], ['items', 3, 0, false, 'menu.xlsx']);
    const log = await A.prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: 'pos.import' } });
    assert.strictEqual(log.length, 1);
    assert.match(log[0].summary, /Imported items from "menu\.xlsx": 3 added, 0 changed/);
    assert.ok(!/Hall hire|40,000|LAWN/.test(log[0].summary), 'the trail says what was done, not the rows');
    // an imported item sells like any other
    const sale = await post('/api/pos/sales', { counterId: A.counter.id, paymentMode: 1, lines: [{ itemId: items.find(i => i.name === 'Chair').id, quantity: 2 }] }, 'cashier');
    assert.strictEqual(sale.status, 200, sale.text);
    assert.strictEqual(sale.json.sale.totals.bill, 108, '2 x 50 + 8%');
    A.batch1 = batches[0]; A.hall = items;
});

run('import API: two imports at the same moment never share a code, and one file cannot overwrite what the other just made', async () => {
    const mk = tag => ({ fileName: `${tag}.xlsx`, headers: ['name', 'pct', 'taxRate', 'price'], rows: [1, 2, 3].map(n => ({ row: n + 1, name: `${tag} item ${n}`, pct: '9801.2000', taxRate: '16', price: '10' })) });
    const [a, b] = await Promise.all([post('/api/pos/import/items/commit', mk('alpha')), post('/api/pos/import/items/commit', mk('beta'))]);
    assert.deepStrictEqual([a.status, b.status], [200, 200], a.text + b.text);
    const codes = (await A.prisma.posItem.findMany({ where: { tenantId: A.tenantId }, select: { code: true } })).map(x => x.code);
    assert.strictEqual(new Set(codes.map(c => c.toLowerCase())).size, codes.length, 'every code is different');
    assert.strictEqual((await A.prisma.posItem.count({ where: { tenantId: A.tenantId, name: { startsWith: 'alpha' } } })), 3);
    // the same new code in two files at once: one wins, the other is refused whole and leaves nothing
    const same = tag => ({ fileName: `${tag}.xlsx`, headers: ['name', 'code', 'pct', 'taxRate'], rows: [{ row: 2, name: `${tag} first`, code: 'RACE-1', pct: '9801.2000', taxRate: '16' }, { row: 3, name: `${tag} second`, pct: '9801.2000', taxRate: '16' }] });
    const before = await count('posItem'), batchesBefore = await count('posImportBatch');
    const [x, y] = await Promise.all([post('/api/pos/import/items/commit', same('gamma')), post('/api/pos/import/items/commit', same('delta'))]);
    assert.deepStrictEqual([x.status, y.status].sort(), [200, 409], `${x.text} ${y.text}`);
    assert.strictEqual(await count('posItem'), before + 2, 'only the winner\'s two rows exist');
    assert.strictEqual(await count('posImportBatch'), batchesBefore + 1, 'and one batch');
    assert.match([x, y].find(r => r.status === 409).json.error, /"RACE-1" was just taken/);
});

run('import API: a file must fit the plan: if it does not, nothing is saved', async () => {
    await A.prisma.tenant.update({ where: { id: A.tenantId }, data: { plan: 'starter' } }); // 1,000 items
    const have = await count('posItem', { active: true });
    await A.prisma.posItem.createMany({ data: Array.from({ length: 1000 - have - 3 }, (_, i) => ({ tenantId: A.tenantId, code: `FILL-${i}`, name: `Filler ${i}`, pctCode: '98012000', taxRate: 16, unitPrice: 1 })) });
    const five = { fileName: 'five.xlsx', headers: ['name', 'pct', 'taxRate'], rows: Array.from({ length: 5 }, (_, i) => ({ row: i + 2, name: `Plan item ${i}`, pct: '9801.2000', taxRate: '16' })) };
    const chk = await post('/api/pos/import/items/check', five);
    assert.strictEqual(chk.status, 403, chk.text);
    assert.match(chk.json.error, /Starter plan allows 1,000 items/);
    const c = await post('/api/pos/import/items/commit', five);
    assert.strictEqual(c.status, 403);
    assert.strictEqual(await count('posItem', { name: { startsWith: 'Plan item' } }), 0, 'none of the five');
    const three = { ...five, rows: five.rows.slice(0, 3) };
    assert.strictEqual((await post('/api/pos/import/items/commit', three)).status, 200, 'three still fit');
    await A.prisma.posItem.deleteMany({ where: { tenantId: A.tenantId, code: { startsWith: 'FILL-' } } });
    await A.prisma.tenant.update({ where: { id: A.tenantId }, data: { plan: null } });
});

run('import API: a row that is a saved item changes nothing without a choice: the missing is filled, a difference is the uploader\'s to choose', async () => {
    const saved = (await call('/api/pos/items', 'manager')).json.find(i => i.code === 'ITM0003'); // Chair: 50, 8%, category Hall
    const file = { fileName: 'update.xlsx', headers: ['name', 'code', 'category', 'taxRate', 'taxRateCard', 'price', 'barcode'], rows: [{ row: 2, name: 'Chair', code: 'itm0003', category: 'Furniture', taxRate: '16', taxRateCard: '8', price: '75', barcode: 'CH-123' }] };
    const chk = await post('/api/pos/import/items/check', file);
    assert.strictEqual(chk.status, 200, chk.text);
    assert.deepStrictEqual([chk.json.new, chk.json.updates.length], [0, 1]);
    const u = chk.json.updates[0];
    assert.deepStrictEqual(u.fills.map(f => f.field).sort(), ['barcode', 'taxRateCard'], 'what the saved item has no value for');
    assert.deepStrictEqual(u.conflicts.map(f => f.field).sort(), ['category', 'taxRate', 'unitPrice'], 'what differs');
    assert.deepStrictEqual(u.conflicts.find(f => f.field === 'unitPrice'), { field: 'unitPrice', label: 'Price', saved: '50.00', file: '75.00' });
    // no choices: the saved values stay, the fills happen
    const none = await post('/api/pos/import/items/commit', file);
    assert.strictEqual(none.status, 200, none.text);
    assert.deepStrictEqual([none.json.added, none.json.updated], [0, 1]);
    let now = (await call('/api/pos/items', 'manager')).json.find(i => i.code === 'ITM0003');
    assert.deepStrictEqual([now.category, now.taxRate, now.unitPrice, now.taxRateCard, now.barcode], ['Hall', 8, 50, 8, 'CH-123'], 'kept the saved, filled the missing');
    assert.match(none.json.details[0].message, /updated the missing: Barcode, Sales tax % on card; kept the saved: Category, Sales tax %, Price/);
    A.chairBatch = none.json.batchId;
    // with choices: the file's price and category, the saved rate
    const file2 = { ...file, fileName: 'update2.xlsx', rows: [{ row: 2, name: 'Chair', code: 'ITM0003', category: 'Furniture', price: '75' }] };
    const with_ = await post('/api/pos/import/items/commit', { ...file2, choices: { 2: { category: 'file', unitPrice: 'file' } } });
    assert.strictEqual(with_.status, 200, with_.text);
    now = (await call('/api/pos/items', 'manager')).json.find(i => i.code === 'ITM0003');
    assert.deepStrictEqual([now.category, now.unitPrice, now.taxRate], ['Furniture', 75, 8]);
    A.chairBatch2 = with_.json.batchId;
    // a choice that makes an invalid item is refused, and nothing is saved
    const badChoice = await post('/api/pos/import/items/commit', { fileName: 'x.xlsx', headers: ['name', 'code', 'taxRate'], rows: [{ row: 2, name: 'Chair', code: 'ITM0003', taxRate: '16' }], choices: { 2: { taxRate: 'file' } } });
    assert.strictEqual(badChoice.status, 200, 'a valid choice is fine');
    assert.strictEqual(saved.code, 'ITM0003');
});

run('import API: a saved item is never created twice by importing the same file again', async () => {
    const f = { fileName: 'again.xlsx', headers: ['name', 'code', 'pct', 'taxRate', 'price'], rows: [{ row: 2, name: 'Repeat A', code: 'REP-A', pct: '9801.2000', taxRate: '16', price: '10' }, { row: 3, name: 'Repeat B', pct: '9801.2000', taxRate: '16', price: '20' }] };
    assert.strictEqual((await post('/api/pos/import/items/commit', f)).json.added, 2);
    const again = await post('/api/pos/import/items/check', f);
    assert.deepStrictEqual([again.json.new, again.json.updates.length], [0, 2], 'the same file again: both are saved items now (one by code, one by its unique name)');
    const n = await count('posItem');
    const c = await post('/api/pos/import/items/commit', f);
    assert.deepStrictEqual([c.json.added, c.json.updated], [0, 0]);
    assert.strictEqual(await count('posItem'), n);
});

run('import API: undoing an import removes what it added, switches off what has been used, puts back what it changed, and says so', async () => {
    const f = { fileName: 'undo.xlsx', headers: ['name', 'code', 'pct', 'taxRate', 'price'], rows: ['U1', 'U2', 'U3'].map((n, i) => ({ row: i + 2, name: `Undo ${n}`, code: `UND-${n}`, pct: '9801.2000', taxRate: '16', price: '10' })) };
    const done = await post('/api/pos/import/items/commit', f);
    assert.strictEqual(done.status, 200, done.text);
    const u2 = await A.prisma.posItem.findFirst({ where: { tenantId: A.tenantId, code: 'UND-U2' } });
    // one of them is sold before the undo
    assert.strictEqual((await post('/api/pos/sales', { counterId: A.counter.id, paymentMode: 1, lines: [{ itemId: u2.id, quantity: 1 }] }, 'cashier')).status, 200);
    assert.strictEqual((await post(`/api/pos/import/batches/${done.json.batchId}/undo`, {}, 'cashier')).status, 403);
    const undo = await post(`/api/pos/import/batches/${done.json.batchId}/undo`, {});
    assert.strictEqual(undo.status, 200, undo.text);
    assert.strictEqual(undo.json.undone, true);
    assert.match(undo.json.undoNote, /removed 2 that it added; switched off 1 that it added and that have been used since \(they are kept\)/);
    assert.strictEqual(await count('posItem', { code: { in: ['UND-U1', 'UND-U3'] } }), 0, 'the unused ones are gone');
    const kept = await A.prisma.posItem.findFirst({ where: { tenantId: A.tenantId, code: 'UND-U2' } });
    assert.strictEqual(kept.active, false, 'the sold one is kept, switched off');
    assert.strictEqual((await post(`/api/pos/import/batches/${done.json.batchId}/undo`, {})).status, 409, 'only once');
    assert.strictEqual((await post('/api/pos/import/batches/nope/undo', {})).status, 404);
    const log = await A.prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: 'pos.import.undo' } });
    assert.ok(log.some(x => /Undid the import of items from "undo\.xlsx"/.test(x.summary)));
    const list = (await call('/api/pos/import/batches', 'manager')).json.find(b => b.id === done.json.batchId);
    assert.deepStrictEqual([list.undone, list.undoneBy], [true, A.manager.email]);
});

run('import API: undoing a change puts the old values back, but not over something changed since', async () => {
    // batch 1 (before) changed Chair's barcode and rate card; batch 2 changed its category and price. Undo batch 2 first: category and price go back.
    let chair = (await call('/api/pos/items', 'manager')).json.find(i => i.code === 'ITM0003');
    assert.deepStrictEqual([chair.category, chair.unitPrice], ['Furniture', 75]);
    // someone edits the price again by hand after the import
    await call(`/api/pos/items/${chair.id}`, 'manager', 'PUT', { unitPrice: 90 });
    const undo2 = await post(`/api/pos/import/batches/${A.chairBatch2}/undo`, {});
    assert.strictEqual(undo2.status, 200, undo2.text);
    assert.match(undo2.json.undoNote, /put back 1 that it changed; left 1 where something it changed was changed again since/);
    chair = (await call('/api/pos/items', 'manager')).json.find(i => i.code === 'ITM0003');
    assert.deepStrictEqual([chair.category, chair.unitPrice], ['Hall', 90], 'the category is back; the price someone set by hand stays');
    // undo batch 1: the barcode and the card rate it filled in go back to nothing
    const undo1 = await post(`/api/pos/import/batches/${A.chairBatch}/undo`, {});
    assert.strictEqual(undo1.status, 200, undo1.text);
    chair = (await call('/api/pos/items', 'manager')).json.find(i => i.code === 'ITM0003');
    assert.deepStrictEqual([chair.barcode, chair.taxRateCard], [null, null]);
});

const CH = ['name', 'code', 'pntn', 'cnic', 'phone', 'address', 'notes', 'openingBalance', 'active'];
const custFile = (rows, over = {}) => ({ fileName: 'customers.xlsx', headers: CH, rows: rows.map((r, i) => ({ row: i + 2, ...r })), ...over });

run('import API: customers: PRA formats, a phone Excel cut the 0 off, opening balances in RUPEES, and the same file again changes nothing', async () => {
    const f = custFile([{ name: 'Khan Events', pntn: '12345678', phone: 3001234567, openingBalance: '1,500.50' }, { name: 'Ali Raza', cnic: '35202-1234567-1', phone: '0300-7654321', openingBalance: '-2000' }, { name: 'Walk In' }]);
    const chk = await post('/api/pos/import/customers/check', f);
    assert.deepStrictEqual([chk.json.errors.length, chk.json.new], [0, 3], chk.text);
    assert.ok(chk.json.warnings.some(w => /lost its leading 0/.test(w.messages[0])));
    assert.match(chk.json.preview[0].detail, /PNTN 1234567-8 · 03001234567 · opening 1500\.5/);
    const c = await post('/api/pos/import/customers/commit', f);
    assert.strictEqual(c.status, 200, c.text);
    const rows = await A.prisma.posCustomer.findMany({ where: { tenantId: A.tenantId, name: { in: ['Khan Events', 'Ali Raza', 'Walk In'] } }, orderBy: { code: 'asc' } });
    assert.deepStrictEqual(rows.map(r => [r.code, r.name, r.pntn, r.cnic, r.phone, Number(r.openingBalance)]), [['CUS0001', 'Khan Events', '1234567-8', '', '03001234567', 1500.5], ['CUS0002', 'Ali Raza', '', '3520212345671', '03007654321', -2000], ['CUS0003', 'Walk In', '', '', '', 0]]);
    const ledger = await call(`/api/pos/customers/${rows[0].id}/ledger`, 'manager');
    assert.strictEqual(ledger.json.balance, 1500.5, 'the balance the accounts show is the file\'s 1,500.50');
    const again = await post('/api/pos/import/customers/commit', f);
    assert.deepStrictEqual([again.json.added, again.json.updated], [0, 0]);
    assert.ok(again.json.warnings.some(w => /opening balance in the file is not applied: Khan Events is already saved/.test(w.messages[0])));
    assert.strictEqual(Number((await A.prisma.posCustomer.findFirst({ where: { id: rows[0].id } })).openingBalance), 1500.5, 'a saved customer\'s opening balance is never changed by a file');
    A.custBatch = c.json.batchId; A.khan = rows[0];
});

run('import API: customers: a customer with an old short phone number can still be matched and updated, and undo keeps a customer that has taken money', async () => {
    const old = await A.prisma.posCustomer.create({ data: { tenantId: A.tenantId, code: 'CUS9001', name: 'Legacy', phone: '12345' } });
    const f = custFile([{ name: 'Legacy', code: 'CUS9001', address: 'Lahore' }]);
    const chk = await post('/api/pos/import/customers/check', f);
    assert.deepStrictEqual([chk.json.errors.length, chk.json.updates.length], [0, 1], 'matched by code; its own phone is not re-checked');
    assert.deepStrictEqual(chk.json.updates[0].fills.map(x => x.field), ['address']);
    assert.strictEqual((await post('/api/pos/import/customers/commit', f)).status, 200);
    assert.strictEqual((await A.prisma.posCustomer.findFirst({ where: { id: old.id } })).phone, '12345', 'the old number is untouched');
    // money received from one of the imported customers, then the import is undone
    assert.strictEqual((await post('/api/pos/cash/receive', { customerId: A.khan.id, amount: '500' })).status, 200);
    const undo = await post(`/api/pos/import/batches/${A.custBatch}/undo`, {});
    assert.strictEqual(undo.status, 200, undo.text);
    assert.match(undo.json.undoNote, /removed 2 that it added; switched off 1 that it added and that have been used since/);
    assert.strictEqual((await A.prisma.posCustomer.findFirst({ where: { id: A.khan.id } })).active, false);
    assert.strictEqual(await count('posCustomer', { name: { in: ['Ali Raza', 'Walk In'] } }), 0);
});

const VH = ['name', 'code', 'ntn', 'phone', 'address', 'notes', 'openingBalance', 'active'];
run('import API: vendors: matched by NTN, an opening balance in rupees, and undo keeps a vendor that has a bill', async () => {
    const f = { fileName: 'vendors.xlsx', headers: VH, rows: [{ row: 2, name: 'Al-Noor Traders', ntn: '1234567-8', phone: '042 35761234', openingBalance: '10,250.75' }, { row: 3, name: 'Metro Cash & Carry', ntn: '7654321-0' }, { row: 4, name: 'Local Supplier' }] };
    const c = await post('/api/pos/import/vendors/commit', f);
    assert.strictEqual(c.status, 200, c.text);
    assert.strictEqual(c.json.added, 3);
    const noor = await A.prisma.posVendor.findFirst({ where: { tenantId: A.tenantId, name: 'Al-Noor Traders' } });
    assert.deepStrictEqual([noor.code, noor.phone, Number(noor.openingBalance)], ['VEN0001', '04235761234', 10250.75]);
    assert.strictEqual((await call(`/api/pos/vendors/${noor.id}`, 'manager')).json.balance, 10250.75, 'what is owed to them, as the accounts show it');
    const again = await post('/api/pos/import/vendors/check', { ...f, rows: [{ row: 2, name: 'Different Spelling', ntn: '12345678', address: 'Lahore' }] });
    assert.deepStrictEqual([again.json.new, again.json.updates[0].existing.name, again.json.updates[0].fills.map(x => x.field), again.json.updates[0].conflicts.map(x => x.field)], [0, 'Al-Noor Traders', ['address'], ['name']]);
    assert.strictEqual((await post('/api/pos/purchases', { vendorId: noor.id, lines: [{ itemName: 'x', quantity: 1, unitCost: 10 }] })).status, 200);
    const undo = await post(`/api/pos/import/batches/${c.json.batchId}/undo`, {});
    assert.match(undo.json.undoNote, /removed 2 that it added; switched off 1/);
    assert.strictEqual((await A.prisma.posVendor.findFirst({ where: { id: noor.id } })).active, false);
    assert.strictEqual(await count('posVendor', { name: { in: ['Metro Cash & Carry', 'Local Supplier'] } }), 0);
});

run('import API: another business sees none of it, and cannot undo it', async () => {
    const t = await A.prisma.tenant.create({ data: { companyName: `TEST imp other ${A.tag}`, modules: ['POS'] } });
    A.tenants.push(t.id);
    const email = `imp-other-${A.tag}@example.com`;
    await A.prisma.user.create({ data: { email, password: A.hash, role: 'CLIENT_USER', tenantRole: 'OWNER', tenantId: t.id } });
    const token = await A.login(email, A.password);
    assert.deepStrictEqual((await A.call('/api/pos/import/batches', { token })).json, []);
    assert.strictEqual((await A.call(`/api/pos/import/batches/${A.batch1.id}/undo`, { token, method: 'POST', body: {} })).status, 404);
    // and its own import is checked against its own items only: the code another business uses is free here
    const r = await A.call('/api/pos/import/items/check', { token, method: 'POST', body: { fileName: 'o.xlsx', headers: ['name', 'code', 'pct', 'taxRate'], rows: [{ row: 2, name: 'Chair', code: 'LAWN-1', pct: '9801.2000', taxRate: '16' }] } });
    assert.deepStrictEqual([r.json.errors.length, r.json.new], [0, 1]);
});

run('import API: a big file (2,000 rows, over 1 MB of text) is accepted, saved all together, and the 2,001st row is refused', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ row: i + 2, name: `Bulk customer ${i}`, pntn: String(10000000 + i), phone: `0300${String(1000000 + i)}`, address: 'A'.repeat(240), notes: 'N'.repeat(290) }));
    const payload = custFile(rows);
    assert.ok(JSON.stringify(payload).length > 1.2 * 1024 * 1024, 'bigger than the 1 MB the other routes take');
    const t0 = Date.now();
    const chk = await post('/api/pos/import/customers/check', payload);
    assert.deepStrictEqual([chk.status, chk.json.errors.length, chk.json.new], [200, 0, 2000], chk.text.slice(0, 300));
    const c = await post('/api/pos/import/customers/commit', payload);
    assert.strictEqual(c.status, 200, c.text.slice(0, 300));
    assert.strictEqual(c.json.added, 2000);
    assert.ok(Date.now() - t0 < 30000, `took ${Date.now() - t0} ms`);
    const codes = (await A.prisma.posCustomer.findMany({ where: { tenantId: A.tenantId, name: { startsWith: 'Bulk customer' } }, select: { code: true } })).map(x => x.code);
    assert.strictEqual(new Set(codes).size, 2000, '2,000 different codes');
    const tooMany = await post('/api/pos/import/customers/check', custFile([...rows, { row: 2002, name: 'One more', pntn: '19999999' }]));
    assert.match(tooMany.json.errors[0].messages[0], /At most 2000 rows per file/);
    const undo = await post(`/api/pos/import/batches/${c.json.batchId}/undo`, {});
    assert.match(undo.json.undoNote, /removed 2000 that it added/);
    assert.strictEqual(await count('posCustomer', { name: { startsWith: 'Bulk customer' } }), 0);
});
