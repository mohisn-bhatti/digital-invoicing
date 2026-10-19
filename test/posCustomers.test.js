// Saved customers, item barcodes and what a scan finds: against the local database, with a stand-in for PRA.
const test = require('node:test');
const assert = require('node:assert');
const praReal = require('../src/pos/pra');
const { createWorld } = require('../test-helpers/posWorld');

const W = createWorld('customers');
const run = W.run;

test('customers: set up a business', async t => { await W.setup(t); });
test.after(() => W.teardown());

const khan = { name: '  Khan   Events (Pvt) Ltd ', pntn: '12345678', phone: '0300-1234567', address: 'Gulberg, Lahore', notes: 'Pays by cheque' };
const byName = async q => (await W.svc.listCustomers(W.ctx, { q })).customers;
const inTestMode = async fn => { W.pra.mock = true; try { return await fn(); } finally { W.pra.mock = false; } }; // the figures cover test sales while the server is in test mode

run('customers: a customer is saved in PRA\'s formats, and gets a code that never changes', async () => {
    const c = await W.svc.createCustomer(W.ctx, khan);
    assert.strictEqual(c.code, 'CUS0001');
    assert.strictEqual(c.name, 'Khan Events (Pvt) Ltd', 'spaces tidied');
    assert.strictEqual(c.pntn, '1234567-8');
    assert.strictEqual(c.phone, '03001234567');
    assert.strictEqual(c.active, true);
    assert.strictEqual((await W.svc.createCustomer(W.ctx, { name: 'Walk-in regular', cnic: '35202-1234567-1' })).code, 'CUS0002');
    const changed = await W.svc.updateCustomer(W.ctx, c.id, { name: 'Khan Events', code: 'HACK', phone: '' });
    assert.strictEqual(changed.code, 'CUS0001', 'the code is not for changing');
    assert.strictEqual(changed.name, 'Khan Events');
    assert.strictEqual(changed.phone, '');
    assert.strictEqual(changed.pntn, '1234567-8', 'what is not sent stays');
    assert.ok(W.audits.some(a => /pos\.customer\.update: Customer "Khan Events" \(CUS0001\) changed: name, phone/.test(a)), W.audits.join('\n'));
    assert.ok(!W.audits.some(a => /1234567-8|35202/.test(a)), 'the audit trail names the fields, not the numbers');
});

run('customers: what is refused', async () => {
    await W.rejects(W.svc.createCustomer(W.ctx, { name: '' }), 400, /customer name/);
    await W.rejects(W.svc.createCustomer(W.ctx, { name: 'X', pntn: '123' }), 400, /PNTN/);
    await W.rejects(W.svc.createCustomer(W.ctx, { name: 'X', cnic: '12345' }), 400, /CNIC/);
    await W.rejects(W.svc.createCustomer(W.ctx, { name: 'X', phone: 'call me' }), 400, /phone/);
    await W.rejects(W.svc.createCustomer(W.ctx, { name: 'X'.repeat(151) }), 400, /too long/);
    await W.rejects(W.svc.createCustomer(W.ctx, { name: 'X', notes: 'n'.repeat(301) }), 400, /too long/);
    // the same PNTN or CNIC is the same customer; the same phone is not (a family shares one)
    await W.rejects(W.svc.createCustomer(W.ctx, { name: 'Khan again', pntn: '1234567-8' }), 409, /PNTN already exists: Khan Events \(CUS0001\)/);
    await W.rejects(W.svc.createCustomer(W.ctx, { name: 'Other', cnic: '3520212345671' }), 409, /CNIC already exists: Walk-in regular \(CUS0002\)/);
    assert.strictEqual((await W.svc.createCustomer(W.ctx, { name: 'Same phone', phone: '+92 300 7654321' })).phone, '923007654321');
    assert.strictEqual((await W.svc.createCustomer(W.ctx, { name: 'Same phone too', phone: '0300-7654321' })).phone, '03007654321');
    const c4 = (await byName('Same phone too'))[0];
    await W.rejects(W.svc.updateCustomer(W.ctx, c4.id, { pntn: '1234567-8' }), 409, /PNTN already exists/);
    assert.strictEqual((await W.svc.updateCustomer(W.ctx, c4.id, { cnic: '' })).cnic, '', 'saving one\'s own number again is fine');
    await W.rejects(W.svc.updateCustomer(W.ctx, 'nope', { name: 'x' }), 404);
});

run('customers: found by name, code, phone, CNIC or PNTN', async () => {
    const codes = async q => (await byName(q)).map(c => c.code);
    assert.deepStrictEqual(await codes('khan'), ['CUS0001']);
    assert.deepStrictEqual(await codes('cus0002'), ['CUS0002']);
    assert.deepStrictEqual(await codes('7654321'), ['CUS0003', 'CUS0004'], 'by phone digits');
    assert.deepStrictEqual(await codes('35202'), ['CUS0002'], 'by CNIC');
    assert.deepStrictEqual(await codes('12345678'), ['CUS0001'], 'by PNTN, typed without its dash');
    assert.deepStrictEqual(await codes('gulberg'), ['CUS0001'], 'by address');
    assert.deepStrictEqual(await codes('nobody at all'), []);
    const all = await W.svc.listCustomers(W.ctx, {});
    assert.deepStrictEqual(all.customers.map(c => c.name), ['Khan Events', 'Same phone', 'Same phone too', 'Walk-in regular'], 'the list is by name');
    assert.strictEqual(all.total, 4);
    const page = await W.svc.listCustomers(W.ctx, { limit: 2, offset: 2 });
    assert.strictEqual(page.customers.length, 2);
    assert.strictEqual(page.total, 4);
    // switching one off hides it from the picker (active=1) but not from the full list
    const c2 = (await byName('Walk-in'))[0];
    await W.svc.updateCustomer(W.ctx, c2.id, { active: false });
    assert.strictEqual((await W.svc.listCustomers(W.ctx, { active: '1' })).total, 3);
    assert.strictEqual((await W.svc.listCustomers(W.ctx, { active: '0' })).total, 1);
    assert.strictEqual((await W.svc.listCustomers(W.ctx, {})).total, 4);
    await W.svc.updateCustomer(W.ctx, c2.id, { active: true });
    assert.ok(W.audits.some(a => /Walk-in regular" \(CUS0002\) changed: switched off/.test(a)));
});

run('customers: another business never sees them, and cannot sell to them', async () => {
    assert.strictEqual((await W.svc.listCustomers(W.ctxOther, {})).total, 0);
    const mine = (await byName('Khan'))[0];
    await W.rejects(W.svc.updateCustomer(W.ctxOther, mine.id, { name: 'stolen' }), 404);
    await W.rejects(W.svc.customerDetail(W.ctxOther, mine.id), 404);
    const branch = await W.svc.createBranch(W.ctxOther, { name: 'Other main' });
    await W.svc.createCounter(W.ctxOther, { branchId: branch.id, name: 'Other till', posId: '900777', env: 'SANDBOX', token: 'sandbox-token-0987654321' });
    const counter = (await W.svc.listBranches(W.otherTenantId))[0].counters[0];
    const item = await W.svc.createItem(W.ctxOther, { name: 'Other item', pctCode: '9801.2000', taxRate: 16, unitPrice: 100 });
    await W.rejects(W.svc.createSale(W.ctxOther, { counterId: counter.id, paymentMode: 1, customerId: mine.id, lines: [{ itemId: item.id, quantity: 1 }] }), 400, /customer is not available/);
});

run('customers: a sale to a saved customer carries the customer\'s details, whatever was typed', async () => {
    const khanNow = (await byName('Khan'))[0];
    W.pra.calls.length = 0;
    const r = await W.sellOne({ customerId: khanNow.id, buyer: { name: 'Someone typed', pntn: '9999999-9' } });
    assert.strictEqual(r.result.outcome, 'FISCALIZED');
    assert.deepStrictEqual(r.sale.customer, { id: khanNow.id, code: 'CUS0001', name: 'Khan Events' });
    assert.deepStrictEqual(r.sale.buyer, { name: 'Khan Events', pntn: '1234567-8', cnic: '', phone: '' });
    assert.strictEqual(W.pra.calls[0].payload.BuyerName, 'Khan Events');
    assert.strictEqual(W.pra.calls[0].payload.BuyerPNTN, '1234567-8');
    // the sale keeps its own copy: changing the customer later does not rewrite a tax invoice
    await W.svc.updateCustomer(W.ctx, khanNow.id, { name: 'Khan Events International', phone: '0321-1111111' });
    const again = await W.svc.saleDetail(W.ctx, r.sale.id);
    assert.strictEqual(again.buyer.name, 'Khan Events', 'the invoice still says what it said');
    assert.strictEqual(again.customer.name, 'Khan Events International', 'the link shows the customer as they are now');
    // nothing typed and no customer: a normal sale; an empty customerId means none
    const plain = await W.sellOne({ customerId: '', buyer: { name: 'Typed buyer' } });
    assert.strictEqual(plain.sale.customer, null);
    assert.strictEqual(plain.sale.buyer.name, 'Typed buyer');
    assert.strictEqual((await W.sellOne({ customerId: null })).sale.customer, null);
    // an unknown or switched-off customer is refused, and nothing is sent
    const sent = W.pra.calls.length;
    await W.rejects(W.sellOne({ customerId: 'does-not-exist' }), 400, /customer is not available/);
    await W.svc.updateCustomer(W.ctx, khanNow.id, { active: false });
    await W.rejects(W.sellOne({ customerId: khanNow.id }), 400, /customer is not available/);
    assert.strictEqual(W.pra.calls.length, sent);
    await W.svc.updateCustomer(W.ctx, khanNow.id, { active: true });
});

run('customers: the credit note keeps the customer, and the customer\'s figures net the return off', async () => {
    const khanNow = (await byName('Khan'))[0];
    const sold = (await W.svc.listSales(W.ctx, { customerId: khanNow.id })).sales;
    assert.strictEqual(sold.length, 1);
    const d = await W.svc.saleDetail(W.ctx, sold[0].id);
    W.advance(10000);
    const cn = await W.svc.creditNote(W.ctx, d.id, { lines: [{ lineId: d.lines[0].id, quantity: 1 }], reason: 'One buffet not used' });
    assert.strictEqual(cn.result.outcome, 'FISCALIZED');
    assert.strictEqual(cn.sale.customer.code, 'CUS0001');
    assert.strictEqual((await W.svc.listSales(W.ctx, { customerId: khanNow.id })).total, 2, 'the sale and its credit note');
    const detail = await inTestMode(() => W.svc.customerDetail(W.ctx, khanNow.id));
    assert.strictEqual(detail.sales, 1);
    assert.strictEqual(detail.salesTotal, 3480); // 2 × 1,500 at 16%
    assert.strictEqual(detail.returns, 1);
    assert.strictEqual(detail.returnsTotal, 1740);
    assert.strictEqual(detail.net, 1740);
    assert.ok(detail.lastSaleAt);
    assert.strictEqual(detail.recent.length, 2);
    // live figures do not include test sales
    const live = await W.svc.customerDetail(W.ctx, khanNow.id);
    assert.deepStrictEqual([live.sales, live.salesTotal, live.net], [0, 0, 0]);
    const list = await inTestMode(() => W.svc.listCustomers(W.ctx, { q: 'Khan' }));
    assert.strictEqual(list.customers[0].net, 1740);
});

run('customers: the spreadsheet', async () => {
    await W.svc.createCustomer(W.ctx, { name: '=HYPERLINK("http://x","click")', notes: 'a, "quoted" note' });
    const { filename, csv, rows } = await inTestMode(() => W.svc.customersCsv(W.ctx, {}));
    assert.strictEqual(filename, 'pos-customers.csv');
    assert.strictEqual(rows, 5);
    const lines = csv.trim().split('\r\n');
    assert.match(lines[0], /^Code,Name,PNTN,CNIC,Phone,Address,Notes,Active,Sales,Sales total,Returns,Returns total,Net,Last sale$/);
    assert.ok(lines.some(l => /^CUS0001,Khan Events International,1234567-8,,03211111111,/.test(l) && /,yes,1,3480\.00,1,1740\.00,1740\.00,/.test(l)), lines.join('\n'));
    assert.ok(csv.includes(`"'=HYPERLINK(""http://x"",""click"")"`), 'a name that Excel would run as a formula is defused');
    assert.ok(csv.includes('"a, ""quoted"" note"'));
    assert.ok(W.audits.some(a => /pos\.export: Exported 5 customers/.test(a)));
});

// ---------- item barcodes ----------
run('barcodes: an item can carry the maker\'s barcode, apart from the code PRA gets', async () => {
    const tea = await W.svc.createItem(W.ctx, { name: 'Packed tea', pctCode: '9801.2000', taxRate: 16, unitPrice: 90, category: 'Shop', barcode: ' 8964000123456 ' });
    assert.strictEqual(tea.barcode, '8964000123456');
    assert.match(tea.code, /^ITM\d{4}$/, 'the code is still handed out for PRA');
    assert.strictEqual(W.items.lunch.barcode, null, 'no barcode typed = none');
    assert.strictEqual((await W.svc.listItems(W.tenantId, { q: '89640001' })).map(i => i.name).join(), 'Packed tea', 'found by barcode in the item list');
    W.items.tea = tea;
});

run('barcodes: a scan has to lead to one item', async () => {
    const mk = over => W.svc.createItem(W.ctx, { name: 'Another', pctCode: '9801.2000', taxRate: 16, unitPrice: 1, ...over });
    await W.rejects(mk({ barcode: '8964000123456' }), 409, /already the code or barcode of "Packed tea"/);
    await W.rejects(mk({ barcode: '8964000123456'.toLowerCase() }), 409);
    await W.rejects(mk({ barcode: W.items.lunch.code }), 409, /already the code or barcode of "Lunch buffet"/);
    await W.rejects(mk({ barcode: W.items.lunch.code.toLowerCase() }), 409, /Lunch buffet/); // capitals do not matter
    await W.rejects(mk({ code: '8964000123456' }), 409, /Packed tea/);
    await W.rejects(mk({ barcode: 'bad barcode!' }), 400, /letters, numbers/);
    await W.rejects(mk({ barcode: 'x'.repeat(51) }), 400, /too long/);
    // the same code or barcode in ANOTHER business is fine
    const other = await W.svc.createItem(W.ctxOther, { name: 'Same barcode elsewhere', pctCode: '9801.2000', taxRate: 16, unitPrice: 1, barcode: '8964000123456' });
    assert.strictEqual(other.barcode, '8964000123456');
    // changing a barcode: onto another item's is refused, one's own again is fine, empty removes it
    const tea = W.items.tea;
    await W.rejects(W.svc.updateItem(W.ctx, tea.id, { barcode: W.items.drink.code }), 409);
    assert.strictEqual((await W.svc.updateItem(W.ctx, tea.id, { name: 'Packed tea 100 g' })).barcode, '8964000123456', 'a change that does not mention the barcode keeps it');
    assert.strictEqual((await W.svc.updateItem(W.ctx, tea.id, { barcode: '8964000123456' })).barcode, '8964000123456');
    assert.strictEqual((await W.svc.updateItem(W.ctx, tea.id, { barcode: '' })).barcode, null);
    assert.strictEqual((await W.svc.updateItem(W.ctx, tea.id, { barcode: '8964000123456' })).barcode, '8964000123456');
    assert.ok(W.audits.some(a => /Item "Packed tea 100 g" \(ITM\d+\) changed: .*barcode: 8964000123456 → null/.test(a)), 'the barcode change is in the trail');
});

// ---------- what a scan finds ----------
run('scan: an item is found by its barcode or its code, however it was typed', async () => {
    const find = async code => (await W.svc.lookup(W.ctx, code)).item;
    assert.strictEqual((await find('8964000123456')).name, 'Packed tea 100 g');
    assert.strictEqual((await find('  8964000123456\n')).name, 'Packed tea 100 g', 'a scanner adds a newline');
    assert.strictEqual((await find(W.items.lunch.code.toLowerCase())).name, 'Lunch buffet');
    assert.strictEqual((await find(`*${W.items.lunch.code}*`)).name, 'Lunch buffet', 'Code 39 readers wrap the code in stars');
    const hit = await find(W.items.lunch.code);
    assert.deepStrictEqual([hit.unitPrice, hit.taxRate, hit.taxRateCard], [1500, 16, 5], 'the price and the tax rates it is set to come with it');
    assert.strictEqual(await find('nothing like this'), null);
    assert.strictEqual(await find(''), null);
    assert.strictEqual(await find('x'.repeat(700)), null, 'a QR full of text is not an item');
    await W.svc.createItem(W.ctx, { name: 'Only ours', pctCode: '9801.2000', taxRate: 16, unitPrice: 1, barcode: 'ONLY-OURS-1' });
    assert.strictEqual((await find('only-ours-1')).name, 'Only ours');
    assert.strictEqual((await W.svc.lookup(W.ctxOther, 'ONLY-OURS-1')).item, null, 'another business\'s scan finds none of ours');
    assert.strictEqual((await W.svc.lookup(W.ctx, undefined)).item, null);
});

run('scan: a sale is found by its number, the PRA invoice number, or the QR on its receipt', async () => {
    const sale = (await W.svc.listSales(W.ctx, { q: '', limit: 1, offset: 0 })).sales.find(s => s.state === 'FISCALIZED');
    const rc = await W.svc.receipt(W.ctx, sale.id);
    const viaUrl = await W.svc.lookup(W.ctx, rc.sale.verifyUrl); // exactly what the receipt's QR holds
    assert.strictEqual(viaUrl.sale.id, sale.id);
    assert.strictEqual(viaUrl.item, null, 'an address is not an item code');
    assert.strictEqual((await W.svc.lookup(W.ctx, sale.fiscalNumber)).sale.id, sale.id, 'by the PRA invoice number');
    assert.strictEqual((await W.svc.lookup(W.ctx, sale.fiscalNumber.toLowerCase())).sale.id, sale.id, 'capitals do not matter');
    assert.strictEqual((await W.svc.lookup(W.ctx, sale.usin)).sale.id, sale.id, 'by our own number');
    assert.strictEqual((await W.svc.lookup(W.ctx, String(Number(sale.usin)))).sale.id, sale.id, '12 means 000012');
    assert.strictEqual((await W.svc.lookup(W.ctx, `${praReal.VERIFY_URL}NO-SUCH-NUMBER`)).sale, null);
    assert.strictEqual((await W.svc.lookup(W.ctxOther, rc.sale.verifyUrl)).sale, null, 'never another business\'s sale');
    const found = (await W.svc.lookup(W.ctx, sale.usin)).sale;
    assert.deepStrictEqual(Object.keys(found).sort(), ['attempts', 'buyerName', 'counterId', 'counterName', 'createdAt', 'createdBy', 'env', 'finalizedAt', 'fiscalNumber', 'fiscalizedAt', 'id', 'invoiceType', 'lastError', 'mock', 'paymentMode', 'refUsin', 'state', 'totalBill', 'totalTax', 'usin'].sort());
});

run('scan: a number that is both an item code and a sale number gives both, and the screen takes the one it wants', async () => {
    const one = (await W.svc.listSales(W.ctx, { limit: 500 })).sales.find(s => s.invoiceType === 1);
    const item = await W.svc.createItem(W.ctx, { name: 'Numbered item', pctCode: '9801.2000', taxRate: 16, unitPrice: 5, code: one.usin });
    const both = await W.svc.lookup(W.ctx, one.usin);
    assert.strictEqual(both.item.id, item.id);
    assert.strictEqual(both.sale.id, one.id);
});

// ---------- the category on each line ----------
run('categories: a line keeps the category the item had when it was sold', async () => {
    const r = await W.sellOne({ lines: [{ itemId: W.items.lunch.id, quantity: 1 }, { itemId: W.items.drink.id, quantity: 1 }] });
    const lines = await W.prisma.posSaleLine.findMany({ where: { saleId: r.sale.id }, orderBy: { sort: 'asc' } });
    assert.deepStrictEqual(lines.map(l => l.category), ['Food', 'Drinks']);
    await W.svc.updateItem(W.ctx, W.items.lunch.id, { category: 'Banquet' });
    assert.deepStrictEqual((await W.prisma.posSaleLine.findMany({ where: { saleId: r.sale.id }, orderBy: { sort: 'asc' } })).map(l => l.category), ['Food', 'Drinks'], 'what was sold stays as it was');
    const later = await W.sellOne({ lines: [{ itemId: W.items.lunch.id, quantity: 1 }] });
    assert.strictEqual((await W.prisma.posSaleLine.findFirst({ where: { saleId: later.sale.id } })).category, 'Banquet');
    // a credit note keeps the category of the sold line
    W.advance(10000);
    const d = await W.svc.saleDetail(W.ctx, r.sale.id);
    const cn = await W.svc.creditNote(W.ctx, r.sale.id, { lines: [{ lineId: d.lines[0].id, quantity: 1 }], reason: 'Returned' });
    assert.strictEqual((await W.prisma.posSaleLine.findFirst({ where: { saleId: cn.sale.id } })).category, 'Food');
    // and the spreadsheet with item lines has it
    const { csv } = await W.svc.salesCsv(W.ctx, { detail: 'lines' });
    assert.match(csv.split('\r\n')[0], /,Item code,Item,Category,PCT code,/);
    assert.ok(csv.includes(',Lunch buffet,Food,98012000,'), 'the sold line shows Food');
    assert.ok(csv.includes(',Lunch buffet,Banquet,98012000,'));
    await W.svc.updateItem(W.ctx, W.items.lunch.id, { category: 'Food' });
});
