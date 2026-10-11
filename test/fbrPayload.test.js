// The JSON ETAX sends to FBR, checked against PRAL's "Technical Specification for DI API" v1.12 §4.1:
// field names, which are required, data types and formats — and the sums FBR checks (errors 0102 / 0104 / 0105).
// Invoices are built the same way the server builds them: src/tax.js calcInvoice → src/fbr.js buildPayload.
const test = require('node:test');
const assert = require('node:assert');
const { calcInvoice } = require('../src/tax');
const { buildPayload } = require('../src/fbr');

// §4.1.2 "Invoice Field Description" / "Invoice Items Field Description"
const HEADER = {
    invoiceType: { type: 'string', required: true, oneOf: ['Sale Invoice', 'Debit Note'] },
    invoiceDate: { type: 'string', required: true, format: /^\d{4}-\d{2}-\d{2}$/ },
    sellerNTNCNIC: { type: 'string', required: true, format: /^(\d{7}|\d{13})$/ },
    sellerBusinessName: { type: 'string', required: true },
    sellerProvince: { type: 'string', required: true },
    sellerAddress: { type: 'string', required: true },
    buyerNTNCNIC: { type: 'string', required: false }, // optional for unregistered buyers
    buyerBusinessName: { type: 'string', required: true },
    buyerProvince: { type: 'string', required: true },
    buyerAddress: { type: 'string', required: true },
    buyerRegistrationType: { type: 'string', required: true, oneOf: ['Registered', 'Unregistered'] },
    invoiceRefNo: { type: 'string', required: false }, // only for a debit note
    scenarioId: { type: 'string', required: false, format: /^SN\d{3}$/ }, // sandbox only
    items: { type: 'object', required: true },
};
const ITEM = {
    hsCode: { type: 'string', required: true, format: /^\d{4}\.\d{4}$/ },
    productDescription: { type: 'string', required: true },
    rate: { type: 'string', required: true },
    uoM: { type: 'string', required: true },
    quantity: { type: 'number', required: true, dp: 4 },
    totalValues: { type: 'number', required: true, dp: 2 },
    valueSalesExcludingST: { type: 'number', required: true, dp: 2 },
    fixedNotifiedValueOrRetailPrice: { type: 'number', required: true, dp: 2 },
    salesTaxApplicable: { type: 'number', required: true, dp: 2 },
    salesTaxWithheldAtSource: { type: 'number', required: true, dp: 2 },
    extraTax: { type: 'number', required: false, dp: 2, emptyOk: true }, // IRIS "Invoice Format": "" when none
    furtherTax: { type: 'number', required: false, dp: 2 },
    sroScheduleNo: { type: 'string', required: false },
    fedPayable: { type: 'number', required: false, dp: 2 },
    discount: { type: 'number', required: false, dp: 2 },
    saleType: { type: 'string', required: true },
    sroItemSerialNo: { type: 'string', required: false },
};

function checkFields(obj, spec, where) {
    const problems = [];
    for (const k of Object.keys(obj)) if (!spec[k]) problems.push(`${where}: "${k}" is not a field in the spec`);
    for (const [k, s] of Object.entries(spec)) {
        const v = obj[k];
        if (v === undefined) { if (s.required) problems.push(`${where}: required "${k}" is missing`); continue; }
        if (s.emptyOk && v === '') continue;
        if (typeof v !== s.type) { problems.push(`${where}: "${k}" should be a ${s.type}, got ${typeof v}`); continue; }
        if (s.required && s.type === 'string' && !v.trim()) problems.push(`${where}: required "${k}" is empty`);
        if (s.oneOf && !s.oneOf.includes(v)) problems.push(`${where}: "${k}" = "${v}" is not one of ${s.oneOf.join(' / ')}`);
        if (s.format && v !== '' && !s.format.test(v)) problems.push(`${where}: "${k}" = "${v}" has the wrong format`);
        if (s.type === 'number') {
            if (!Number.isFinite(v) || v < 0) problems.push(`${where}: "${k}" = ${v} must be a number of 0 or more`);
            else if (Math.abs(v * 10 ** s.dp - Math.round(v * 10 ** s.dp)) > 1e-6) problems.push(`${where}: "${k}" = ${v} has more than ${s.dp} decimals`);
        }
    }
    return problems;
}
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const pct = rate => Number((String(rate).match(/^\s*(\d+(?:\.\d+)?)\s*%/) || [])[1] || 0);
const perUnit = rate => Number((String(rate).match(/rupees?\s*([\d,]+(?:\.\d+)?)\s*per\b/i) || [])[1]?.replace(/,/g, '') || 0);
// The sums FBR checks on each item
function checkSums(it, where) {
    const problems = [];
    const base = it.fixedNotifiedValueOrRetailPrice > 0 ? it.fixedNotifiedValueOrRetailPrice : it.valueSalesExcludingST;
    const st = r2(base * pct(it.rate) / 100 + perUnit(it.rate) * it.quantity);
    if (Math.abs(it.salesTaxApplicable - st) > 0.01) problems.push(`${where}: sales tax ${it.salesTaxApplicable} ≠ rate × value ${st} (FBR 0102 / 0104 / 0105)`);
    const total = r2(it.valueSalesExcludingST + it.salesTaxApplicable + it.furtherTax + Number(it.extraTax || 0) + it.fedPayable);
    if (Math.abs(it.totalValues - total) > 0.01) problems.push(`${where}: totalValues ${it.totalValues} ≠ value + taxes ${total}`);
    if (pct(it.rate) === 5 && it.valueSalesExcludingST > 20000) problems.push(`${where}: 5% above Rs 20,000 (FBR 0079)`);
    if (['Exempt Goods', 'Goods at Reduced Rate'].includes(it.saleType) && (!it.sroScheduleNo || !it.sroItemSerialNo)) problems.push(`${where}: SRO / serial missing (FBR 0077 / 0078)`);
    if (it.saleType === '3rd Schedule Goods' && !(it.fixedNotifiedValueOrRetailPrice > 0)) problems.push(`${where}: retail price missing (FBR 0090)`);
    return problems;
}

const tenant = { sellerNtnCnic: '7000007', sellerBusinessName: 'Feedback Test Co', sellerProvince: 'PUNJAB', sellerAddress: 'Lahore' };
const std = { hsCode: '0101.2100', productDescription: 'Tyre Panther', uoM: 'Numbers, pieces, units', saleType: 'Goods at standard rate (default)', rate: '18%', quantity: 1, unitPrice: 600 };
const CASES = {
    'standard rate, registered buyer': { buyer: 'Registered', ntn: '1000000', items: [std] },
    'standard rate, unregistered buyer (further tax 4%)': { buyer: 'Unregistered', ntn: '', items: [std, { ...std, productDescription: 'Tyre Royal', unitPrice: 1000 }] },
    'walk-in end consumer, discount': { buyer: 'Unregistered', ntn: '', endConsumer: true, discount: 50, items: [{ ...std, quantity: 3 }] },
    '3rd schedule (retail price)': { buyer: 'Registered', ntn: '1000000', items: [{ ...std, hsCode: '3402.5000', saleType: '3rd Schedule Goods', quantity: 10, unitPrice: 140, fixedNotifiedValueOrRetailPrice: 1600 }] },
    'exempt with SRO + serial': { buyer: 'Unregistered', ntn: '', items: [{ ...std, hsCode: '0401.1000', saleType: 'Exempt Goods', rate: 'Exempt', sroScheduleNo: '6th Schd Table I', sroItemSerialNo: '19', uoM: 'KG', quantity: 2.5 }] },
    'reduced rate 5% up to Rs 20,000': { buyer: 'Registered', ntn: '3520212345671', items: [{ ...std, saleType: 'Goods at Reduced Rate', rate: '5%', unitPrice: 20000, sroScheduleNo: '8th Schd Table 1', sroItemSerialNo: '70' }] },
    'rate with rupees per unit (0105)': { buyer: 'Registered', ntn: '1000000', items: [{ ...std, rate: '18% along with rupees 60 per kilogram', uoM: 'KG', quantity: 10, unitPrice: 100 }] },
    'more taxes into Extra Tax / FED Payable': { buyer: 'Registered', ntn: '1000000', items: [{ ...std, extraTaxes: [
        { name: 'Withholding', kind: 'PCT', value: 1, base: 'VALUE', fbrField: 'extraTax' },
        { name: 'Cess', kind: 'FIXED', value: 25, fbrField: 'fedPayable' }] }] },
};

for (const [name, c] of Object.entries(CASES)) {
    for (const env of ['SANDBOX', 'PRODUCTION']) {
        test(`FBR JSON (${env.toLowerCase()}): ${name} — matches spec v1.12 §4.1`, () => {
            const { lines } = calcInvoice(c.items, { buyerRegistrationType: c.buyer, furtherTaxRate: 4, endConsumer: Boolean(c.endConsumer) }, c.discount || 0);
            const invoice = { invoiceType: 'Sale Invoice', invoiceDate: '2026-10-10', buyerNtnCnic: c.ntn, buyerBusinessName: c.ntn ? 'Buyer Co' : 'Walk-in Customer',
                buyerProvince: 'SINDH', buyerAddress: 'Karachi', buyerRegistrationType: c.buyer, invoiceRefNo: '', fbrEnv: env, scenarioId: 'SN001' };
            const payload = buildPayload(tenant, invoice, lines);
            const problems = [
                ...checkFields(payload, HEADER, 'header'),
                ...payload.items.flatMap((it, i) => [...checkFields(it, ITEM, `item ${i + 1}`), ...checkSums(it, `item ${i + 1}`)]),
            ];
            if (payload.buyerRegistrationType === 'Registered' && !/^(\d{7}|\d{9}|\d{13})$/.test(payload.buyerNTNCNIC)) problems.push('header: a registered buyer needs a 7 / 9 / 13 digit NTN or CNIC (FBR 0002)');
            if (payload.buyerRegistrationType === 'Registered' && payload.items.some(it => it.furtherTax > 0)) problems.push('further tax charged to a registered (active) buyer');
            if (env === 'SANDBOX' && !payload.scenarioId) problems.push('sandbox needs scenarioId');
            if (env === 'PRODUCTION' && 'scenarioId' in payload) problems.push('production must not send scenarioId');
            assert.deepStrictEqual(problems, []);
        });
    }
}

test('your example: Tyre 600 / 1,000 to an unregistered buyer → 108 + 24 = 732 and 180 + 40 = 1,220', () => {
    const { lines } = calcInvoice(CASES['standard rate, unregistered buyer (further tax 4%)'].items, { buyerRegistrationType: 'Unregistered', furtherTaxRate: 4 });
    assert.deepStrictEqual(lines.map(l => [l.valueSalesExcludingST, l.salesTaxApplicable, l.furtherTax, l.totalValues]), [[600, 108, 24, 732], [1000, 180, 40, 1220]]);
});

test('IRIS "Invoice Format": extraTax is "" when there is none, the amount when there is', () => {
    const ctx = { buyerRegistrationType: 'Registered', furtherTaxRate: 4 };
    const inv = { invoiceType: 'Sale Invoice', invoiceDate: '2026-10-10', buyerNtnCnic: '1000000', buyerBusinessName: 'B', buyerProvince: 'SINDH', buyerAddress: 'K', buyerRegistrationType: 'Registered', fbrEnv: 'SANDBOX', scenarioId: 'SN001' };
    assert.strictEqual(buildPayload(tenant, inv, calcInvoice([std], ctx).lines).items[0].extraTax, '');
    const withTax = calcInvoice([{ ...std, extraTaxes: [{ name: 'W', kind: 'PCT', value: 1, base: 'VALUE', fbrField: 'extraTax' }] }], ctx).lines;
    assert.strictEqual(buildPayload(tenant, inv, withTax).items[0].extraTax, 6);
});

