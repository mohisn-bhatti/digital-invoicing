const test = require('node:test');
const assert = require('node:assert');
const { calcInvoice, ratePercent } = require('../src/tax');
const { isValid, describeErrors, buildPayload, endpoint } = require('../src/fbr');

const base = { hsCode: '0101.2100', productDescription: 'Widget', uoM: 'Numbers, pieces, units', saleType: 'Goods at standard rate (default)' };

test('ratePercent parses FBR rate strings', () => {
    assert.strictEqual(ratePercent('18%'), 18);
    assert.strictEqual(ratePercent('18% along with rupees 60 per kilogram'), 18);
    assert.strictEqual(ratePercent('Exempt'), 0);
});

test('registered buyer: 18% ST, no further tax', () => {
    const { lines, totals } = calcInvoice([{ ...base, quantity: 2, unitPrice: 500, rate: '18%' }], { buyerRegistrationType: 'Registered', furtherTaxRate: 4 });
    assert.strictEqual(lines[0].valueSalesExcludingST, 1000);
    assert.strictEqual(lines[0].salesTaxApplicable, 180);
    assert.strictEqual(lines[0].furtherTax, 0);
    assert.strictEqual(totals.totalAmount, 1180);
});

test('unregistered buyer gets further tax; exempt and 3rd schedule do not', () => {
    const ctx = { buyerRegistrationType: 'Unregistered', furtherTaxRate: 4 };
    const { lines, totals } = calcInvoice([
        { ...base, quantity: 1, unitPrice: 1000, rate: '18%' },
        { ...base, quantity: 1, unitPrice: 100, rate: 'Exempt', saleType: 'Exempt Goods', sroScheduleNo: '6th Schedule Table I', sroItemSerialNo: '176(i)' },
        { ...base, quantity: 1, unitPrice: 80, rate: '18%', saleType: '3rd Schedule Goods', fixedNotifiedValueOrRetailPrice: 100 },
    ], ctx);
    assert.strictEqual(lines[0].furtherTax, 40);
    assert.strictEqual(lines[1].furtherTax, 0);
    assert.strictEqual(lines[1].salesTaxApplicable, 0);
    assert.strictEqual(lines[2].salesTaxApplicable, 18); // on retail price
    assert.strictEqual(lines[2].furtherTax, 0);
    assert.strictEqual(totals.totalAmount, 1000 + 180 + 40 + 100 + 80 + 18);
});

test('overrides and discount', () => {
    const { lines } = calcInvoice([{ ...base, quantity: 3, unitPrice: 33.33, discount: 9.99, rate: '18%', salesTaxApplicable: '15', furtherTax: '0' }],
        { buyerRegistrationType: 'Unregistered', furtherTaxRate: 4 });
    assert.strictEqual(lines[0].valueSalesExcludingST, 90);
    assert.strictEqual(lines[0].salesTaxApplicable, 15);
    assert.strictEqual(lines[0].furtherTax, 0);
});

test('rejects bad input', () => {
    const ctx = { buyerRegistrationType: 'Registered', furtherTaxRate: 4 };
    assert.throws(() => calcInvoice([], ctx), /at least one item/);
    assert.throws(() => calcInvoice([{ ...base, quantity: 0, unitPrice: 1, rate: '18%' }], ctx), /quantity/);
    assert.throws(() => calcInvoice([{ ...base, hsCode: '', quantity: 1, unitPrice: 1, rate: '18%' }], ctx), /hsCode/);
    assert.throws(() => calcInvoice([{ ...base, quantity: 1, unitPrice: 'abc', rate: '18%' }], ctx), /unitPrice/);
});

test('FBR response handling follows spec samples', () => {
    const valid = { statusCode: '00', status: 'Valid', error: '', invoiceStatuses: [{ itemSNo: '1', statusCode: '00', status: 'Valid' }] };
    const headerInvalid = { statusCode: '01', status: 'Invalid', errorCode: '0052', error: 'Provide proper HS Code', invoiceStatuses: null };
    const itemInvalid = { statusCode: '00', status: 'invalid', error: '', invoiceStatuses: [{ itemSNo: '1', statusCode: '01', errorCode: '0046', error: 'Provide rate.' }] };
    assert.ok(isValid(valid));
    assert.ok(!isValid(headerInvalid));
    assert.ok(!isValid(itemInvalid));
    assert.match(describeErrors(headerInvalid), /\[0052\] Provide proper HS Code/);
    assert.match(describeErrors(itemInvalid), /Item 1: \[0046\] Provide rate/);
});

test('payload: scenarioId only in sandbox; endpoints', () => {
    const tenant = { sellerNtnCnic: '1234567', sellerBusinessName: 'A', sellerProvince: 'SINDH', sellerAddress: 'Karachi' };
    const inv = { invoiceType: 'Sale Invoice', invoiceDate: '2026-10-06', buyerBusinessName: 'B', buyerProvince: 'SINDH', buyerAddress: 'K', buyerRegistrationType: 'Unregistered', scenarioId: 'SN002' };
    assert.strictEqual(buildPayload(tenant, { ...inv, fbrEnv: 'SANDBOX' }, []).scenarioId, 'SN002');
    assert.ok(!('scenarioId' in buildPayload(tenant, { ...inv, fbrEnv: 'PRODUCTION' }, [])));
    assert.strictEqual(endpoint('postinvoicedata', 'SANDBOX'), 'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata_sb');
    assert.strictEqual(endpoint('postinvoicedata', 'PRODUCTION'), 'https://gw.fbr.gov.pk/di_data/v1/di/postinvoicedata');
});

test('HS code format is enforced', () => {
    const ctx = { buyerRegistrationType: 'Registered', furtherTaxRate: 4 };
    assert.throws(() => calcInvoice([{ ...base, hsCode: '01012100', quantity: 1, unitPrice: 1, rate: '18%' }], ctx), /HS code must look like/);
    assert.doesNotThrow(() => calcInvoice([{ ...base, hsCode: '9822.9000', quantity: 1, unitPrice: 1, rate: '15%' }], ctx));
});

test('HS search input normalisation and PCT data file', () => {
    const { normalizeCode } = require('../src/hscodes');
    assert.strictEqual(normalizeCode('01012100'), '0101.2100');
    assert.strictEqual(normalizeCode('0101.21'), '0101.21');
    assert.strictEqual(normalizeCode('0101'), '0101');
    const data = require('../data/hs-codes-pct-2017.json');
    assert.ok(data.length > 7000);
    assert.ok(data.every(r => /^\d{4}\.\d{4}$/.test(r.code) && r.description));
    assert.strictEqual(new Set(data.map(r => r.code)).size, data.length);
});

test('FBR call failures: which ones are uncertain (may already be recorded)', async () => {
    const { _call } = require('../src/fbr');
    const http = res => ({ post: async () => (typeof res === 'function' ? res() : res) });
    const ok = await _call(http({ status: 200, data: { validationResponse: {} } }), 'u', {});
    assert.ok(ok.ok);
    assert.strictEqual((await _call(http({ status: 401, data: '' }), 'u', {})).uncertain, false); // rejected
    assert.strictEqual((await _call(http({ status: 500, data: '' }), 'u', {})).uncertain, true);  // server error
    assert.strictEqual((await _call(http({ status: 200, data: 'oops' }), 'u', {})).uncertain, true); // unreadable
    const timeout = await _call(http(() => { const e = new Error('timeout'); e.code = 'ECONNABORTED'; throw e; }), 'u', {});
    assert.strictEqual(timeout.uncertain, true);
    assert.match(timeout.error, /timed out/);
});

test('Annex-C helpers', () => {
    const a = require('../src/annexc');
    assert.strictEqual(a.irisDate('2025-08-31'), '31-Aug-2025');
    assert.deepStrictEqual(a.monthRange('2024-02'), { from: '2024-02-01', to: '2024-02-29' });
    assert.deepStrictEqual(a.monthRange('2025-02'), { from: '2025-02-01', to: '2025-02-28' });
    assert.strictEqual(a.monthRange('2025-13'), null);
    const inv = { buyerNtnCnic: '', buyerBusinessName: 'Ali, "Bro" Store', buyerRegistrationType: 'Unregistered', buyerProvince: 'PUNJAB',
        invoiceType: 'Sale Invoice', fbrInvoiceNumber: '1234567DI1', invoiceDate: '2025-08-31', invoiceRefNo: '', localNo: 7,
        items: [{ hsCode: '3904.1090', saleType: 'Goods at standard rate (default)', rate: '18%', uoM: 'KG', quantity: '40000',
            valueSalesExcludingST: '9844068', fixedNotifiedValueOrRetailPrice: '0', salesTaxApplicable: '1771932.24', extraTax: '0',
            salesTaxWithheldAtSource: '0', sroScheduleNo: '', sroItemSerialNo: '', furtherTax: '0', totalValues: '11616000.24' }] };
    const rows = a.rows([inv, inv], 'PUNJAB');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[1].srNo, 2);
    const t = a.totals(rows);
    assert.strictEqual(t.salesTax, 3543864.48);
    const csv = a.toCsv(rows, t);
    assert.ok(csv.startsWith('﻿Sr. No.,'));
    assert.ok(csv.includes('"Ali, ""Bro"" Store"'));          // comma + quotes escaped
    assert.ok(csv.trim().split('\r\n').pop().startsWith('TOTAL,'));
});

test('no further tax on sales to end consumers (CA rule)', () => {
    const items = [{ ...base, quantity: 1, unitPrice: 1000, rate: '18%' }];
    const business = calcInvoice(items, { buyerRegistrationType: 'Unregistered', furtherTaxRate: 4, endConsumer: false });
    const consumer = calcInvoice(items, { buyerRegistrationType: 'Unregistered', furtherTaxRate: 4, endConsumer: true });
    assert.strictEqual(business.totals.totalFurtherTax, 40);
    assert.strictEqual(consumer.totals.totalFurtherTax, 0);
    assert.strictEqual(consumer.totals.totalAmount, 1180);
});

test('import: dates, rates', () => {
    const { parseDate, normRate } = require('../src/importer');
    assert.strictEqual(parseDate('2025-08-31'), '2025-08-31');
    assert.strictEqual(parseDate('31-08-2025'), '2025-08-31');
    assert.strictEqual(parseDate('31/8/2025'), '2025-08-31');
    assert.strictEqual(parseDate('31-Aug-2025'), '2025-08-31');
    assert.strictEqual(parseDate('5 September 2025'), '2025-09-05');
    assert.strictEqual(parseDate('45900'), '2025-08-31');      // Excel serial
    assert.strictEqual(parseDate('31-02-2025'), null);          // not a real date
    assert.strictEqual(parseDate('tomorrow'), null);
    assert.strictEqual(normRate(18), '18%');
    assert.strictEqual(normRate('0.18'), '18%');
    assert.strictEqual(normRate('18 %'), '18%');
    assert.strictEqual(normRate('Exempt'), 'Exempt');
});

test('import: template parses back, rows group into invoices', () => {
    const imp = require('../src/importer');
    // tiny CSV reader for the template (quoted cells, CRLF)
    const parse = csv => csv.replace(/^﻿/, '').trim().split('\r\n').map(l => [...l.matchAll(/("([^"]|"")*"|[^,]*)(,|$)/g)].map(m => m[1].replace(/^"|"$/g, '').replace(/""/g, '"')).slice(0, -1));
    const [head, ...data] = parse(imp.templateCsv(true));
    const rows = data.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
    const g = imp.groupRows(rows);
    assert.deepStrictEqual(g.errors, []);
    assert.strictEqual(g.invoices.length, 2);                   // INV-1001 has 2 lines
    assert.strictEqual(g.invoices[0].body.items.length, 2);
    assert.strictEqual(g.invoices[0].body.buyerRegistrationType, 'Registered');
    assert.strictEqual(g.invoices[1].body.endConsumer, true);
    assert.ok(g.invoices.every(i => !i.errors.length && /^imp-[0-9a-f]{40}$/.test(i.clientRequestId)));
    assert.strictEqual(imp.requestId('INV-1', '2025-01-01'), imp.requestId('INV-1', '2025-01-01'));

    // other header spellings, missing columns, disagreeing rows, unknown buyer type
    const alias = imp.groupRows([{ 'Invoice No': 'A1', Date: '01/09/2025', 'HS': '0403.1000', Item: 'Yogurt', 'Sale Type': 'x', Qty: '1,000', Unit: 'KG', Price: 10, 'Tax Rate': 18, Junk: 1 }]);
    assert.deepStrictEqual(alias.errors, []);
    assert.strictEqual(alias.invoices[0].body.items[0].quantity, '1000');
    assert.strictEqual(alias.invoices[0].body.invoiceDate, '2025-09-01');
    assert.deepStrictEqual(alias.unknownHeaders, ['Junk']);
    assert.match(imp.groupRows([{ 'Invoice Ref': 'A' }]).errors[0], /Missing column/);
    const base = { 'Invoice Ref': 'A', 'HS Code': '0403.1000', Description: 'Y', 'Sale Type': 's', Quantity: 1, UOM: 'KG', 'Unit Price': 1, Rate: '18%' };
    const clash = imp.groupRows([{ ...base, 'Invoice Date': '2025-09-01' }, { ...base, 'Invoice Date': '2025-09-02' }]);
    assert.match(clash.invoices[0].errors.join(), /disagree on Invoice Date/);
    const bt = imp.groupRows([{ ...base, 'Invoice Date': '2025-09-01', 'Buyer Type': 'Alien' }]);
    assert.match(bt.invoices[0].errors.join(), /not recognised/);
    const ntnNoType = imp.groupRows([{ ...base, 'Invoice Date': '2025-09-01', 'Buyer NTN/CNIC': '1234567' }]);
    assert.match(ntnNoType.invoices[0].errors.join(), /Buyer Type is required/);
});

test('DI rules: non-ATL registered buyer pays further tax; exempt needs SRO', () => {
    const items = [{ ...base, quantity: 1, unitPrice: 1000, rate: '18%' }];
    assert.strictEqual(calcInvoice(items, { buyerRegistrationType: 'Registered', furtherTaxRate: 4 }).totals.totalFurtherTax, 0);
    assert.strictEqual(calcInvoice(items, { buyerRegistrationType: 'Registered', furtherTaxRate: 4, buyerNonAtl: true }).totals.totalFurtherTax, 40);
    const exempt = { ...base, quantity: 1, unitPrice: 100, rate: 'Exempt', saleType: 'Exempt Goods' };
    assert.throws(() => calcInvoice([exempt], { buyerRegistrationType: 'Registered', furtherTaxRate: 4 }), /SRO \/ Schedule no/);
    assert.doesNotThrow(() => calcInvoice([{ ...exempt, sroScheduleNo: '6th Schedule Table I', sroItemSerialNo: '176(i)' }], { buyerRegistrationType: 'Registered', furtherTaxRate: 4 }));
});

test('import: Annex-C style columns (line value instead of unit price)', () => {
    const imp = require('../src/importer');
    const { calcInvoice } = require('../src/tax');
    const g = imp.groupRows([{ 'Sr. No.': 1, 'Document No.': 'S-1', 'Document Date': '31-Aug-2025', 'Buyer Registration No.': '1234567', 'Buyer Type': 'Registered',
        'HS Code': '3904.1090', Description: 'PVC', 'Sale Type': 'Goods at standard rate (default)', Rate: '18%', UOM: 'KG', Quantity: '40,000.00', 'Value of Sales Excl. ST': '9,844,068' }]);
    assert.deepStrictEqual(g.errors, []);
    const inv = g.invoices[0];
    assert.deepStrictEqual(inv.errors, []);
    assert.strictEqual(inv.body.invoiceDate, '2025-08-31');
    assert.strictEqual(inv.body.buyerNtnCnic, '1234567');
    const t = calcInvoice(inv.body.items, { buyerRegistrationType: 'Registered', furtherTaxRate: 4 });
    assert.strictEqual(t.lines[0].valueSalesExcludingST, 9844068);   // exactly the Annex-C value
    assert.strictEqual(t.lines[0].salesTaxApplicable, 1771932.24);   // = Annex-C 1,771,932
    assert.match(imp.groupRows([{ 'Invoice Ref': 'A', 'Invoice Date': '2025-01-01', 'HS Code': '0403.1000', Description: 'Y', 'Sale Type': 's', Quantity: 1, UOM: 'KG', Rate: '18%' }]).errors[0], /Unit Price \(or Value/);
});

test('review fixes: CSV formula injection, header value on a later row', () => {
    const a = require('../src/annexc'), imp = require('../src/importer');
    const inv = { buyerNtnCnic: '', buyerBusinessName: '=HYPERLINK("http://x")', buyerRegistrationType: 'Unregistered', buyerProvince: 'PUNJAB',
        invoiceType: 'Sale Invoice', fbrInvoiceNumber: '1DI1', invoiceDate: '2025-08-31', invoiceRefNo: '', localNo: 1, invoiceNo: 'INV-1',
        items: [{ hsCode: '0403.1000', saleType: 's', rate: '18%', uoM: 'KG', quantity: '1', valueSalesExcludingST: '1', fixedNotifiedValueOrRetailPrice: '0',
            salesTaxApplicable: '0.18', extraTax: '0', salesTaxWithheldAtSource: '0', sroScheduleNo: '', sroItemSerialNo: '', furtherTax: '0', totalValues: '1.18' }] };
    const rows = a.rows([inv], 'PUNJAB');
    assert.ok(a.toCsv(rows, a.totals(rows)).includes(`"'=HYPERLINK(""http://x"")"`));
    const base = { 'Invoice Ref': 'D-5', 'Invoice Date': '2025-09-01', 'HS Code': '0403.1000', Description: 'Y', 'Sale Type': 's', Quantity: 1, UOM: 'KG', 'Unit Price': 1, Rate: '18%' };
    const g = imp.groupRows([{ ...base, 'Document Type': '', 'Buyer Type': '' }, { ...base, 'Document Type': 'Debit Note', 'Buyer Type': 'Registered', 'Buyer NTN/CNIC': '1234567' }]);
    assert.strictEqual(g.invoices[0].body.invoiceType, 'Debit Note');
    assert.strictEqual(g.invoices[0].body.buyerRegistrationType, 'Registered');
    assert.strictEqual(g.invoices[0].body.buyerNtnCnic, '1234567');
});

// CA's Document 1, "Practical Example of How to Calculate Any Transaction"
test('Document 1 scenario A: standard goods, registered vs unregistered buyer', () => {
    const steel = { ...base, hsCode: '7214.9990', uoM: 'KG', quantity: 1000, unitPrice: 1000, rate: '18%' };
    const reg = calcInvoice([steel], { buyerRegistrationType: 'Registered', furtherTaxRate: 4 });
    assert.strictEqual(reg.totals.totalST, 180000);
    assert.strictEqual(reg.totals.totalAmount, 1180000);
    const unreg = calcInvoice([steel], { buyerRegistrationType: 'Unregistered', furtherTaxRate: 4 });
    assert.strictEqual(unreg.totals.totalFurtherTax, 40000);
    assert.strictEqual(unreg.totals.totalAmount, 1220000);
});

test('Document 1 scenario B: 3rd schedule detergent taxed on retail price, no further tax', () => {
    const { totals } = calcInvoice([{ ...base, hsCode: '3402.9000', saleType: '3rd Schedule Goods', quantity: 1000, unitPrice: 800, rate: '18%', fixedNotifiedValueOrRetailPrice: 1000000 }],
        { buyerRegistrationType: 'Unregistered', furtherTaxRate: 4 });
    assert.strictEqual(totals.totalST, 180000);
    assert.strictEqual(totals.totalFurtherTax, 0);
    assert.strictEqual(totals.totalAmount, 980000);
});

test('counted units need a whole-number quantity; KG may have decimals', () => {
    const ctx = { buyerRegistrationType: 'Registered', furtherTaxRate: 4 };
    assert.throws(() => calcInvoice([{ ...base, quantity: 1.5, unitPrice: 10, rate: '18%' }], ctx), /whole number/);
    assert.strictEqual(calcInvoice([{ ...base, uoM: 'KG', quantity: 1.5, unitPrice: 10, rate: '18%' }], ctx).totals.totalExclST, 15);
});

test('HS tax rules: every matching rule, most specific first; fill in only an unconditional most-specific rule', () => {
    const { matchRules, autoRule } = require('../src/hsTaxRules');
    const rules = [{ prefix: '3402', condition: '', saleType: '3rd Schedule Goods' },
        { prefix: '34029000', condition: 'pesticide ingredient', saleType: 'Exempt Goods' },
        { prefix: '0401', condition: 'sold in retail packing', saleType: '3rd Schedule Goods' },
        { prefix: '0401', condition: 'not branded', saleType: 'Exempt Goods' }, { prefix: '01', condition: '', saleType: 'Exempt Goods' }];
    assert.deepStrictEqual(matchRules(rules, '3402.9000').map(r => r.prefix), ['34029000', '3402']);
    assert.strictEqual(autoRule(matchRules(rules, '3402.9000')), null); // conditional rule on top: ask
    assert.strictEqual(autoRule(matchRules(rules, '3402.1100')).prefix, '3402');
    assert.strictEqual(matchRules(rules, '0401.1000').length, 2);
    assert.strictEqual(autoRule(matchRules(rules, '0401.1000')), null);
    assert.strictEqual(autoRule(matchRules(rules, '0101.2100')).prefix, '01');
    assert.deepStrictEqual(matchRules(rules, '8471.3010'), []);
});

test('one invoice discount is split over the lines by value and taxed on the net', () => {
    const items = [{ ...base, quantity: 1, unitPrice: 200, rate: '18%' }, { ...base, quantity: 1, unitPrice: 900, rate: '18%' }];
    const { lines, totals } = calcInvoice(items, { buyerRegistrationType: 'Registered', furtherTaxRate: 4 }, 100);
    assert.strictEqual(lines[0].discount, 18.18);
    assert.strictEqual(lines[1].discount, 81.82);
    assert.strictEqual(totals.totalExclST, 1000);
    assert.strictEqual(totals.totalST, 180);
    assert.throws(() => calcInvoice(items, { buyerRegistrationType: 'Registered', furtherTaxRate: 4 }, 2000), /more than the invoice value/);
    assert.strictEqual(calcInvoice(items, { buyerRegistrationType: 'Registered', furtherTaxRate: 4 }, '').totals.totalExclST, 1100);
});

// "More taxes" on the item's tax rule — the examples in the plan (Sugar 3 × 1,000, 18%, registered buyer)
const sugar = { ...base, quantity: 3, unitPrice: 1000, rate: '18%' };
const reg = { buyerRegistrationType: 'Registered', furtherTaxRate: 4 };
const one = extra => calcInvoice([{ ...sugar, extraTaxes: extra }], reg).lines[0];

test('more taxes: % on value, value after tax, sales tax; fixed; tax on tax; each FBR box', () => {
    let l = one([{ name: 'Withholding', kind: 'PCT', value: 2, base: 'VALUE', fbrField: 'extraTax' }]);
    assert.strictEqual(l.extraTax, 60); assert.strictEqual(l.totalValues, 3600);
    l = one([{ name: 'Levy', kind: 'PCT', value: 1, base: 'VALUE_AFTER_TAX', fbrField: 'extraTax' }]);
    assert.strictEqual(l.extraTax, 35.4); assert.strictEqual(l.totalValues, 3575.4);
    l = one([{ name: 'Surcharge', kind: 'PCT', value: 10, base: 'SALES_TAX', fbrField: 'fedPayable' }]);
    assert.strictEqual(l.fedPayable, 54); assert.strictEqual(l.totalValues, 3594);
    l = one([{ name: 'Municipal', kind: 'FIXED', value: 5500, fbrField: 'extraTax' }]);
    assert.strictEqual(l.extraTax, 5500); assert.strictEqual(l.totalValues, 9040);
    const ten = calcInvoice([{ ...sugar, quantity: 10, extraTaxes: [{ name: 'Municipal', kind: 'FIXED', value: 5500 }] }], reg).lines[0];
    assert.strictEqual(ten.extraTax, 5500); // fixed: not × quantity
    l = one([{ name: 'Withholding', kind: 'PCT', value: 2, base: 'VALUE', fbrField: 'extraTax' },
        { name: 'Cess', kind: 'PCT', value: 5, base: 'TAX:0', fbrField: 'extraTax' }]);
    assert.strictEqual(l.extraTax, 63); assert.strictEqual(l.totalValues, 3603);
    assert.deepStrictEqual(l.extraTaxDetail.map(t => t.amount), [60, 3]);
    l = one([{ name: 'Additional ST', kind: 'PCT', value: 3, base: 'VALUE', fbrField: 'salesTaxApplicable' }]);
    assert.strictEqual(l.salesTaxApplicable, 630); assert.strictEqual(l.totalValues, 3630);
    l = one([{ name: 'Extra further', kind: 'PCT', value: 4, base: 'VALUE', fbrField: 'furtherTax' }]);
    assert.strictEqual(l.furtherTax, 120); assert.strictEqual(l.totalValues, 3660);
    // sent as JSON text from the invoice form
    assert.strictEqual(calcInvoice([{ ...sugar, extraTaxes: JSON.stringify([{ name: 'W', kind: 'PCT', value: 2, base: 'VALUE' }]) }], reg).lines[0].extraTax, 60);
});

test('more taxes: worked example and the full invoice from the plan', () => {
    const defs = [{ name: 'Withholding', kind: 'PCT', value: 2, base: 'VALUE', fbrField: 'extraTax' },
        { name: 'Municipal', kind: 'FIXED', value: 50, fbrField: 'extraTax' },
        { name: 'Surcharge', kind: 'PCT', value: 10, base: 'SALES_TAX', fbrField: 'fedPayable' },
        { name: 'Cess', kind: 'PCT', value: 1, base: 'TAX:0', fbrField: 'extraTax' }];
    const w = calcInvoice([{ ...sugar, quantity: 2, extraTaxes: defs }], reg).lines[0];
    assert.strictEqual(w.extraTax, 90.4); assert.strictEqual(w.fedPayable, 36); assert.strictEqual(w.totalValues, 2486.4);

    const a = { ...sugar, extraTaxes: [defs[0], { name: 'Municipal', kind: 'FIXED', value: 5500, fbrField: 'extraTax' }, defs[2]] };
    const b = { ...base, hsCode: '1006.3010', saleType: 'Exempt Goods', rate: 'Exempt', quantity: 10, unitPrice: 150, sroScheduleNo: '6th Schd Table I', sroItemSerialNo: '19' };
    const { lines, totals } = calcInvoice([a, b], { buyerRegistrationType: 'Unregistered', endConsumer: false, furtherTaxRate: 4 }, 300);
    assert.deepStrictEqual([lines[0].valueSalesExcludingST, lines[0].salesTaxApplicable, lines[0].furtherTax, lines[0].extraTax, lines[0].fedPayable, lines[0].totalValues],
        [2800, 504, 112, 5556, 50.4, 9022.4]);
    assert.strictEqual(lines[1].totalValues, 1400);
    assert.strictEqual(totals.totalAmount, 10422.4);
});

test('more taxes: bad definitions are refused', () => {
    assert.throws(() => one([{ name: 'A', kind: 'PCT', value: 1, base: 'TAX:0' }]), /listed above it/);
    assert.throws(() => one([{ name: '', kind: 'PCT', value: 1, base: 'VALUE' }]), /needs a name/);
    assert.throws(() => one([{ name: 'A', kind: 'FIXED', value: -5 }]), /0 or more/);
    assert.throws(() => one([{ name: 'A', kind: 'PCT', value: 1, base: 'VALUE', fbrField: 'discount' }]), /FBR box/);
});

test('more taxes: several bases ticked — the tax is on their sum', () => {
    const t = (base, value = 1) => one([{ name: 'W', kind: 'PCT', value: 2, base: 'VALUE' }, { name: 'X', kind: 'PCT', value, base }]).extraTaxDetail[1].amount;
    assert.strictEqual(t('VALUE+SALES_TAX'), 35.4); // = value after tax, 1% × 3,540
    assert.strictEqual(t('VALUE_AFTER_TAX'), 35.4); // older rules read the same
    assert.strictEqual(t('SALES_TAX+TAX:0', 10), 60); // 10% × (540 + 60)
    assert.strictEqual(t('VALUE+SALES_TAX+TAX:0', 10), 360); // 10% × (3,000 + 540 + 60)
    assert.strictEqual(t('VALUE+VALUE'), 30); // the same base twice counts once
    assert.throws(() => one([{ name: 'A', kind: 'PCT', value: 1, base: 'VALUE+TAX:0' }]), /listed above it/);
});

test('exempt line needs only the SRO / Schedule no. (no serial box — CA)', () => {
    const ex = { ...base, hsCode: '1006.3010', saleType: 'Exempt Goods', rate: 'Exempt', quantity: 1, unitPrice: 100 };
    assert.throws(() => calcInvoice([ex], { buyerRegistrationType: 'Registered', furtherTaxRate: 4 }), /SRO \/ Schedule no/);
    assert.doesNotThrow(() => calcInvoice([{ ...ex, sroScheduleNo: '6th Schd Table I' }], { buyerRegistrationType: 'Registered', furtherTaxRate: 4 }));
});

test('a line without a rate is refused (not filed at Rs 0)', () => {
    assert.throws(() => calcInvoice([{ ...base, quantity: 1, unitPrice: '', rate: '18%' }], { buyerRegistrationType: 'Registered', furtherTaxRate: 4 }), /rate \(per unit\) is missing/);
});
