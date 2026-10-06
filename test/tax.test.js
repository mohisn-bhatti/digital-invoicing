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
        { ...base, quantity: 1, unitPrice: 100, rate: 'Exempt', saleType: 'Exempt Goods' },
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
