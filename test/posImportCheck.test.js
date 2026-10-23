// The checking of an import file, without a database: every rule of src/pos/import.js. A file is checked as a whole; nothing is saved here.
const test = require('node:test');
const assert = require('node:assert');
const { checkFile, MAX_ROWS, MAX_UPDATES } = require('../src/pos/import');

const item = (o = {}) => ({ id: 'i' + Math.random().toString(36).slice(2, 8), code: 'ITM0001', barcode: null, name: 'Tea', category: 'Drinks', pctCode: '98012000', taxRate: 16, taxRateCard: 8, unitPrice: 100, openPrice: false, taxInclusive: false, followSchedule: false, active: true, ...o });
const H = ['name', 'code', 'barcode', 'category', 'pct', 'taxRate', 'taxRateCard', 'price', 'openPrice', 'taxInclusive', 'followSchedule', 'active'];
const file = (rows, headers = H) => ({ fileName: 't.xlsx', headers, rows: rows.map((r, i) => ({ row: i + 2, ...r })) });
const ctx = (over = {}) => ({ existing: [], defaults: { itemPct: '', itemTaxRate: null, itemTaxRateCard: null, itemCategory: '' }, scheduled: new Set(), ...over });
const msgs = r => r.errors.flatMap(e => e.messages).join(' | ');
const okRow = (o = {}) => ({ name: 'Biryani', pct: '9801.2000', taxRate: '16', price: '500', ...o });

test('import check (items): a good row becomes a new item, in the form the screens would save it', () => {
    const r = checkFile('items', file([okRow({ code: 'B-1', barcode: '8964000999991', category: 'Food', taxRateCard: '8%', price: '1,250.50', taxInclusive: 'yes', active: 'Y' })]), ctx());
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.ready.length, 1);
    assert.strictEqual(r.ready[0].kind, 'new');
    assert.deepStrictEqual(r.ready[0].data, { code: 'B-1', name: 'Biryani', barcode: '8964000999991', category: 'Food', pctCode: '98012000', taxRate: 16, taxRateCard: 8, unitPrice: 1250.5, openPrice: false, taxInclusive: true, followSchedule: false, active: true });
});

test('import check (items): the whole file is refused for a missing column, no rows, or too many rows', () => {
    assert.match(msgs(checkFile('items', file([okRow()], ['code', 'pct']), ctx())), /column "Name" was not found/);
    assert.match(msgs(checkFile('items', file([okRow()], ['name', 'taxRate']), ctx())), /no "PCT code" column, and no default heading/);
    assert.deepStrictEqual(checkFile('items', file([okRow()], ['name', 'taxRate']), ctx({ defaults: { itemPct: '98012000', itemTaxRate: 16 } })).errors, [], 'a default heading makes the column optional');
    assert.match(msgs(checkFile('items', file([]), ctx())), /no rows/);
    assert.match(msgs(checkFile('items', { headers: H }, ctx())), /no rows/);
    assert.match(msgs(checkFile('items', file(Array.from({ length: MAX_ROWS + 1 }, (_, i) => okRow({ name: 'Item ' + i }))), ctx())), /At most 2000 rows per file/);
    assert.match(msgs(checkFile('nonsense', file([okRow()]), ctx())), /Choose items, customers or vendors/);
});

test('import check (items): every problem of every row is listed with its row number, and nothing is ready', () => {
    const r = checkFile('items', file([
        okRow({ name: 'A', price: '12.345' }), okRow({ name: 'B', taxRate: 'abc' }), okRow({ name: 'C', openPrice: 'maybe' }), okRow({ name: 'D', taxRate: '150' }), okRow({ name: 'E', pct: '9801' }),
        okRow({ name: '' }), okRow({ name: 'G', code: 'bad code!' }), okRow({ name: 'H', price: '-5' }), okRow({ name: 'I', taxRateCard: 'x' }), okRow({ name: 'ok one' }),
    ]), ctx());
    assert.deepStrictEqual(r.errors.map(e => e.row), [2, 3, 4, 5, 6, 7, 8, 9, 10], 'rows 2 to 10 have problems, row 11 is fine');
    assert.match(r.errors[0].messages[0], /Price can have 2 decimal places at most/);
    assert.match(r.errors[1].messages[0], /Sales tax % must be a number/);
    assert.match(r.errors[2].messages[0], /write yes or no/);
    assert.match(r.errors[3].messages[0], /more than 100/);
    assert.match(r.errors[4].messages[0], /8 digits/);
    assert.match(r.errors[5].messages[0], /name is empty/i);
    assert.match(r.errors[6].messages[0], /Item code can use letters/);
    assert.match(r.errors[7].messages[0], /Price must be a number/);
    assert.strictEqual(r.errors[0].sheet, 'Items');
    assert.strictEqual(r.errors[0].name, 'A');
    assert.strictEqual(r.ready.length, 1, 'the good row is ready, but the caller saves nothing while there are errors');
});

test('import check (items): cells as Excel gives them (numbers, percentages, lost decimals) are read as intended, and said so when it matters', () => {
    const r = checkFile('items', file([{ name: 'Excel row', pct: 9801.2, taxRate: 16, taxRateCard: 0.08, price: 1500, taxInclusive: true, active: 1 }]), ctx());
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual([r.ready[0].data.pctCode, r.ready[0].data.taxRate, r.ready[0].data.taxRateCard, r.ready[0].data.unitPrice, r.ready[0].data.taxInclusive], ['98012000', 16, 8, 1500, true], '9801.2 is 9801.2000; 0.08 in a % cell is 8%');
    assert.ok(r.warnings.some(w => /0\.08 was read as 8%/.test(w.messages[0])), 'a fraction read as a percentage is said');
    // a price with floating-point noise
    assert.strictEqual(checkFile('items', file([okRow({ price: 0.1 + 0.2 })]), ctx()).ready[0].data.unitPrice, 0.3);
    // things that are not text or numbers
    assert.match(msgs(checkFile('items', file([okRow({ price: { a: 1 } })]), ctx())), /not text or a number/);
    assert.match(msgs(checkFile('items', file([okRow({ price: Infinity })]), ctx())), /not a number/);
    assert.match(msgs(checkFile('items', { headers: H, rows: ['nonsense', null, [1]] }, ctx())), /not valid/);
});

test('import check (items): a new item takes what the owner chose in Settings for what the file leaves out, and says so; a saved item never does', () => {
    const defaults = { itemPct: '98012000', itemTaxRate: 16, itemTaxRateCard: 8, itemCategory: 'Food' };
    const blank = { name: 'No tax columns' };
    const r = checkFile('items', file([blank]), ctx({ defaults }));
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual([r.ready[0].data.pctCode, r.ready[0].data.taxRate, r.ready[0].data.taxRateCard, r.ready[0].data.category], ['98012000', 16, 8, 'Food']);
    assert.match(r.warnings[0].messages[0], /not in the file, so your defaults were used: PCT code 9801\.2000, tax 16%, card 8%, category "Food"/);
    // a rate typed in the file gets NO default card rate (the default card goes with the default rate)
    const own = checkFile('items', file([{ name: 'Own rate', taxRate: '5' }]), ctx({ defaults }));
    assert.deepStrictEqual([own.ready[0].data.taxRate, own.ready[0].data.taxRateCard], [5, null]);
    // without defaults the missing cells are problems
    const none = checkFile('items', file([blank]), ctx());
    assert.match(msgs(none), /PCT code is empty/);
    assert.match(msgs(none), /sales tax % is empty/);
    // a saved item is matched first, and nothing of the defaults goes into it
    const saved = item({ code: 'ITM0007', name: 'Saved', category: 'Mine' });
    const up = checkFile('items', file([{ name: 'Saved', code: 'ITM0007' }]), ctx({ defaults, existing: [saved] }));
    assert.deepStrictEqual(up.errors, []);
    assert.strictEqual(up.ready[0].kind, 'update');
    assert.deepStrictEqual(Object.keys(up.ready[0].incoming).sort(), ['name'], 'only what the file gave');
    assert.deepStrictEqual(up.warnings, []);
});

test('import check (items): which saved item a row is (code, then barcode, then a unique name), and when that is unclear it is an error, not a guess', () => {
    const tea = item({ id: 'tea', code: 'ITM0001', name: 'Tea', barcode: '111' }), rice = item({ id: 'rice', code: 'ITM0002', name: 'Rice', barcode: '222' });
    const c = ctx({ existing: [tea, rice] });
    const kind = (row) => { const r = checkFile('items', file([row]), c); return r.errors.length ? 'ERROR ' + msgs(r) : r.ready[0].kind + ':' + (r.ready[0].existing ? r.ready[0].existing.id : 'new'); };
    assert.strictEqual(kind(okRow({ name: 'Anything', code: 'itm0001' })), 'update:tea', 'by code, capitals do not matter');
    assert.strictEqual(kind(okRow({ name: 'Anything', code: '', barcode: '222' })), 'update:rice', 'by barcode');
    assert.strictEqual(kind(okRow({ name: '  tea ', code: '', barcode: '' })), 'update:tea', 'by name when there is no code and no barcode');
    assert.strictEqual(kind(okRow({ name: 'Coffee', code: '', barcode: '' })), 'new:new');
    assert.match(kind(okRow({ name: 'Anything', code: 'ITM0001', barcode: '222' })), /belongs to "Tea" and the barcode "222" to "Rice"/);
    // two saved items with one name: the file must say which
    const twin = ctx({ existing: [tea, item({ id: 'tea2', code: 'ITM0003', name: 'Tea' })] });
    assert.match(msgs(checkFile('items', file([okRow({ name: 'Tea', code: '', barcode: '' })]), twin)), /2 saved items are called "Tea"/);
    // a new item cannot take another item's code or barcode, however it is written
    assert.match(kind(okRow({ name: 'New', code: 'ITM0002' })).replace('update:rice', 'matched'), /matched/, 'that code IS rice: the row is rice');
    assert.match(kind(okRow({ name: 'New', code: '111' })), /already the code or barcode of "Tea"/);
    assert.match(kind(okRow({ name: 'New', code: 'N-1', barcode: 'itm0001' })), /already the code or barcode of "Tea"/);
    // a saved item cannot be given another item's barcode: found by its own code, the barcode is the other item's, which is two items in one row
    assert.match(msgs(checkFile('items', file([okRow({ name: 'Tea', code: 'ITM0001', barcode: '222' })]), c)), /belongs to "Tea" and the barcode "222" to "Rice"/);
    // but a barcode nobody has is simply a new barcode for the saved item
    assert.strictEqual(checkFile('items', file([okRow({ name: 'Tea', code: 'ITM0001', barcode: '333' })]), c).ready[0].incoming.barcode, '333');
    // a saved item found by barcode whose code differs: the saved code stays, and it is said
    const byBarcode = checkFile('items', file([okRow({ name: 'Tea', code: 'OTHER', barcode: '111' })]), c);
    assert.strictEqual(byBarcode.ready[0].existing.id, 'tea');
    assert.ok(byBarcode.warnings.some(w => /saved code is kept/.test(w.messages[0])));
});

test('import check (items): the same thing twice in one file is an error, however it is written', () => {
    const c = ctx({ existing: [item({ id: 'tea', code: 'ITM0001', name: 'Tea', barcode: '111' })] });
    const two = rows => checkFile('items', file(rows), c);
    assert.match(msgs(two([okRow({ name: 'A', code: 'X1' }), okRow({ name: 'B', code: 'x1' })])), /code "x1" is also used on row 2/);
    assert.match(msgs(two([okRow({ name: 'A', barcode: '9' }), okRow({ name: 'B', barcode: '9' })])), /barcode "9" is also used on row 2/);
    assert.match(msgs(two([okRow({ name: 'A', code: '77' }), okRow({ name: 'B', barcode: '77' })])), /is also used on row 2/);
    assert.match(msgs(two([okRow({ name: 'Same' }), okRow({ name: ' same ' })])), /"same" is also on row 2: give each a code/);
    assert.match(msgs(two([okRow({ name: 'Tea', code: 'ITM0001' }), okRow({ name: 'Tea again', code: '', barcode: '111' })])), /same item as row 2/);
    assert.strictEqual(two([okRow({ name: 'Same' }), okRow({ name: 'Same', code: 'S-2' })]).errors.length, 0, 'one with a code and one without are different');
});

test('import check (items): a saved item is compared field by field: the missing is filled in, a difference is a choice, and a blank cell changes nothing', () => {
    const saved = item({ id: 'a', code: 'ITM0001', name: 'Tea', category: '', unitPrice: 0, taxRate: 16, taxRateCard: null, active: true, openPrice: false });
    const r = checkFile('items', file([{ name: 'Tea', code: 'ITM0001', category: 'Drinks', price: '120', taxRate: '8', taxRateCard: '5', pct: '', active: 'no', openPrice: '', taxInclusive: 'yes' }]), ctx({ existing: [saved] }));
    assert.deepStrictEqual(r.errors, []);
    const e = r.ready[0];
    assert.deepStrictEqual(e.fills.map(f => f.field).sort(), ['category', 'taxInclusive' === 'x' ? '' : 'taxRateCard', 'unitPrice'].sort(), 'category, price (0 is not set) and the card rate are empty on the saved item');
    assert.deepStrictEqual(e.conflicts.map(f => f.field).sort(), ['active', 'taxInclusive', 'taxRate'].sort(), 'rate 16 vs 8, on sale yes vs no, tax-inclusive no vs yes');
    assert.strictEqual(e.conflicts.find(c => c.field === 'active').saved, 'Yes');
    assert.strictEqual(e.conflicts.find(c => c.field === 'active').file, 'No');
    assert.ok(!('pctCode' in e.incoming) && !('openPrice' in e.incoming), 'blank cells are not in what the file says');
    // nothing different: nothing to do
    const same = checkFile('items', file([{ name: 'tea', code: 'itm0001', taxRate: '16%' }]), ctx({ existing: [saved] }));
    assert.deepStrictEqual([same.ready[0].fills, same.ready[0].conflicts], [[], []]);
    // what the file gives must still make a valid item together with what is saved
    assert.match(msgs(checkFile('items', file([{ name: 'Tea', code: 'ITM0001', taxRate: '500' }]), ctx({ existing: [saved] }))), /more than 100/);
});

test('import check (items): following the rate schedule needs a rate in the schedule for that heading today', () => {
    const c = ctx({ scheduled: new Set(['98012000']) });
    assert.deepStrictEqual(checkFile('items', file([okRow({ followSchedule: 'yes' })]), c).errors, []);
    assert.match(msgs(checkFile('items', file([okRow({ followSchedule: 'yes', pct: '9899.9999' })]), c)), /schedule has no rate for 9899\.9999/);
    const saved = item({ id: 's', code: 'ITM0001', name: 'Tea', pctCode: '98999999' });
    assert.match(msgs(checkFile('items', file([{ name: 'Tea', code: 'ITM0001', followSchedule: 'yes' }]), ctx({ existing: [saved], scheduled: new Set() }))), /schedule has no rate/);
    assert.deepStrictEqual(checkFile('items', file([{ name: 'Tea', code: 'ITM0001', category: 'x' }]), ctx({ existing: [saved] })).errors, [], 'a saved item that already follows is not asked again for a column it does not touch');
});

test('import check (items): a price of 0 is allowed but said, unless the item is an open-price one', () => {
    const r = checkFile('items', file([okRow({ name: 'No price', price: '' }), okRow({ name: 'Open', price: '', openPrice: 'yes' })]), ctx());
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(r.warnings.filter(w => /price is empty/.test(w.messages[0])).length, 1);
    assert.strictEqual(r.warnings[0].name, 'No price');
});

const CH = ['name', 'code', 'pntn', 'cnic', 'phone', 'address', 'notes', 'openingBalance', 'active'];
const cust = (o = {}) => ({ id: 'c' + Math.random().toString(36).slice(2, 8), code: 'CUS0001', name: 'Khan Events', pntn: '1234567-8', cnic: '', phone: '03001234567', address: '', notes: '', active: true, openingBalance: 0, ...o });
const cfile = rows => file(rows, CH);

test('import check (customers): numbers are put in PRA\'s formats, a phone is checked, and a phone Excel has cut the 0 off is mended and said', () => {
    const r = checkFile('customers', cfile([{ name: 'Ali Khan', pntn: '12345678', cnic: '35202-1234567-1', phone: 3001234567, openingBalance: '1,500.50' }]), ctx());
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.ready[0].data, { name: 'Ali Khan', pntn: '1234567-8', cnic: '3520212345671', phone: '03001234567', address: '', notes: '', active: true, openingBalance: 1500.5 });
    assert.ok(r.warnings.some(w => /had lost its leading 0/.test(w.messages[0])));
    assert.match(msgs(checkFile('customers', cfile([{ name: 'X', phone: '12345' }]), ctx())), /Buyer phone number: a Pakistani mobile number has 11 digits/);
    assert.match(msgs(checkFile('customers', cfile([{ name: 'X', phone: '0300123456789012' }]), ctx())), /too many digits \(13 at most/);
    assert.match(msgs(checkFile('customers', cfile([{ name: 'X', pntn: '12' }]), ctx())), /PNTN/);
    assert.match(msgs(checkFile('customers', cfile([{ name: 'X', cnic: '123' }]), ctx())), /CNIC/);
    assert.match(msgs(checkFile('customers', cfile([{ name: 'X', openingBalance: 'lots' }]), ctx())), /Opening balance/);
    assert.match(msgs(checkFile('customers', cfile([{ name: 'X', openingBalance: '1.234' }]), ctx())), /two decimals/);
    assert.strictEqual(checkFile('customers', cfile([{ name: 'X', openingBalance: '-2,000' }]), ctx()).ready[0].data.openingBalance, -2000, 'a minus is money already held for them');
});

test('import check (customers): which saved customer a row is, and an opening balance is never applied to a saved one', () => {
    const khan = cust({ id: 'khan', code: 'CUS0001', name: 'Khan Events', pntn: '1234567-8', cnic: '' }), ali = cust({ id: 'ali', code: 'CUS0002', name: 'Ali', pntn: '', cnic: '3520212345671', phone: '03007654321' });
    const c = ctx({ existing: [khan, ali] });
    const one = row => checkFile('customers', cfile([row]), c);
    assert.strictEqual(one({ name: 'Different name', pntn: '12345678' }).ready[0].existing.id, 'khan', 'by PNTN, however it is written');
    assert.strictEqual(one({ name: 'X', cnic: '35202-1234567-1' }).ready[0].existing.id, 'ali', 'by CNIC');
    assert.strictEqual(one({ name: 'X', code: 'cus0001' }).ready[0].existing.id, 'khan', 'by code');
    assert.strictEqual(one({ name: 'Ali', phone: '0300 7654321' }).ready[0].existing.id, 'ali', 'by the same name and phone');
    assert.strictEqual(one({ name: 'Khan Events' }).ready[0].existing.id, 'khan', 'by a name only one saved customer has, when the file gives no number');
    assert.strictEqual(one({ name: 'Somebody New', phone: '03001112223' }).ready[0].kind, 'new');
    assert.match(msgs(one({ name: 'X', pntn: '12345678', cnic: '3520212345671' })), /PNTN and CNIC belong to different saved customers/);
    assert.match(msgs(checkFile('customers', cfile([{ name: 'Khan Events', pntn: '' }]), ctx({ existing: [khan, cust({ id: 'k2', code: 'CUS0009', name: 'Khan Events', pntn: '' })] }))), /2 saved customers are called "Khan Events"/);
    // the file's code says Ali and its PNTN says Khan: it is not guessed
    assert.match(msgs(one({ name: 'Ali', code: 'CUS0002', pntn: '12345678' })), /code and PNTN belong to different saved customers \("Ali", "Khan Events"\)/);
    // opening balance: used for a new customer, ignored (and said) for a saved one
    const withBalance = one({ name: 'Khan Events', pntn: '12345678', openingBalance: '9000' });
    assert.ok(!('openingBalance' in withBalance.ready[0].incoming));
    assert.match(withBalance.warnings[0].messages[0], /opening balance in the file is not applied: Khan Events is already saved/);
    assert.strictEqual(one({ name: 'Brand New', pntn: '99999999', openingBalance: '9000' }).ready[0].data.openingBalance, 9000);
    // a code that is not a saved customer's is not used: the next code is
    assert.ok(one({ name: 'New One', code: 'MY-ID-5', pntn: '88888888' }).warnings.some(w => /is not a saved customer: a new customer is made with the next code/.test(w.messages[0])));
});

test('import check (customers): the same customer twice in one file, and a customer that is a saved one twice', () => {
    const c = ctx({ existing: [cust({ id: 'khan', code: 'CUS0001', pntn: '1234567-8' })] });
    assert.match(msgs(checkFile('customers', cfile([{ name: 'A', pntn: '11111111' }, { name: 'B', pntn: '1111111-1' }]), c)), /PNTN 1111111-1 is also on row 2/);
    assert.match(msgs(checkFile('customers', cfile([{ name: 'A', cnic: '3520212345671' }, { name: 'B', cnic: '35202-1234567-1' }]), c)), /CNIC 3520212345671 is also on row 2/);
    assert.match(msgs(checkFile('customers', cfile([{ name: 'Walk In', phone: '03001112223' }, { name: ' walk in ', phone: '0300-1112223' }]), c)), /with this phone is also on row 2/);
    assert.match(msgs(checkFile('customers', cfile([{ name: 'A', pntn: '12345678' }, { name: 'B', code: 'CUS0001' }]), c)), /same customer as row 2/);
    assert.strictEqual(checkFile('customers', cfile([{ name: 'Walk In', phone: '03001112223' }, { name: 'Walk In', phone: '03001112224' }]), c).errors.length, 0, 'same name, different phone: two people');
});

const VH = ['name', 'code', 'ntn', 'phone', 'address', 'notes', 'openingBalance', 'active'];
const vend = (o = {}) => ({ id: 'v' + Math.random().toString(36).slice(2, 8), code: 'VEN0001', name: 'Al-Noor Traders', ntn: '1234567-8', phone: '', address: '', notes: '', active: true, ...o });

test('import check (vendors): a vendor is checked like a customer, matched by code, NTN or a unique name, with an opening balance only for a new one', () => {
    const noor = vend({ id: 'noor', code: 'VEN0001', name: 'Al-Noor Traders', ntn: '1234567-8' });
    const c = ctx({ existing: [noor] });
    const one = row => checkFile('vendors', file([row], VH), c);
    assert.strictEqual(one({ name: 'Renamed', ntn: '12345678' }).ready[0].existing.id, 'noor', 'by NTN, whatever the dashes');
    assert.strictEqual(one({ name: 'Al-Noor Traders' }).ready[0].existing.id, 'noor', 'by a unique name');
    assert.strictEqual(one({ name: 'X', code: 'ven0001' }).ready[0].existing.id, 'noor');
    const fresh = one({ name: 'Metro', ntn: '7654321-0', phone: '+92 300 1234567', openingBalance: '5,000' });
    assert.deepStrictEqual(fresh.ready[0].data, { name: 'Metro', ntn: '7654321-0', phone: '923001234567', address: '', notes: '', active: true, openingBalance: 5000 });
    assert.match(msgs(one({ name: 'X', phone: '999' })), /Phone number: a Pakistani mobile/);
    assert.match(one({ name: 'Al-Noor Traders', openingBalance: '10' }).warnings[0].messages[0], /not applied: Al-Noor Traders is already saved/);
    assert.match(msgs(checkFile('vendors', file([{ name: 'A', ntn: '1111111-1' }, { name: 'B', ntn: '11111111' }], VH), c)), /NTN 11111111 is also on row 2/);
    assert.match(msgs(checkFile('vendors', file([{ name: 'Same' }, { name: 'same' }], VH), c)), /"same" is also on row 2/);
    assert.match(msgs(checkFile('vendors', file([{ name: 'Al-Noor Traders' }], VH), ctx({ existing: [noor, vend({ id: 'n2', code: 'VEN0002', name: 'Al-Noor Traders', ntn: '' })] }))), /2 saved vendors are called/);
});

test('import check: a file that updates too many saved records is refused whole', () => {
    const many = Array.from({ length: MAX_UPDATES + 1 }, (_, i) => item({ id: 'x' + i, code: 'C' + i, name: 'N' + i }));
    const r = checkFile('items', file(many.map(m => ({ name: m.name, code: m.code, category: 'New' }))), ctx({ existing: many }));
    assert.match(msgs(r), /At most 500 saved items can be updated by one file/);
});
