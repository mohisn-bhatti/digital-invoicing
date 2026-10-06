// Line-level tax calculation for DI invoices. Pure functions, no I/O.
//
// Defaults (the CA can override salesTaxApplicable / furtherTax per line when a
// sale type needs special treatment, e.g. "18% along with rupees 60 per kilogram"):
//   valueSalesExcludingST = quantity × unitPrice − discount
//   ST base               = fixedNotifiedValueOrRetailPrice if > 0 (3rd schedule), else valueSalesExcludingST
//   salesTaxApplicable    = ST base × rate%
//   furtherTax            = valueSalesExcludingST × furtherTaxRate%   (unregistered business buyer, taxable rate only;
//                           not on sales to end consumers — confirmed by the CA)
//   totalValues           = valueSalesExcludingST + ST + furtherTax + extraTax + fedPayable

// Sale types where further tax is not charged by default
const NO_FURTHER_TAX_SALE_TYPES = new Set(['3rd Schedule Goods', 'Exempt Goods', 'Goods at zero-rate']);

function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function num(v, fallback = 0) {
    if (v === null || v === undefined || v === '') return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
}

// "18%" -> 18, "0%" -> 0, "Exempt" -> 0, "18% along with rupees 60 per kilogram" -> 18
function ratePercent(rate) {
    const m = String(rate || '').match(/^\s*(\d+(?:\.\d+)?)\s*%/);
    return m ? Number(m[1]) : 0;
}

function hasOverride(v) {
    return v !== null && v !== undefined && v !== '';
}

function calcItem(raw, { buyerRegistrationType, furtherTaxRate, endConsumer = false }) {
    const quantity = num(raw.quantity);
    const unitPrice = num(raw.unitPrice);
    const discount = num(raw.discount);
    const fixedNotifiedValueOrRetailPrice = num(raw.fixedNotifiedValueOrRetailPrice);
    const extraTax = num(raw.extraTax);
    const fedPayable = num(raw.fedPayable);
    const salesTaxWithheldAtSource = num(raw.salesTaxWithheldAtSource);
    const pct = ratePercent(raw.rate);

    const numbers = { quantity, unitPrice, discount, fixedNotifiedValueOrRetailPrice, extraTax, fedPayable, salesTaxWithheldAtSource };
    for (const [k, v] of Object.entries(numbers)) {
        if (Number.isNaN(v) || v < 0) throw new Error(`Item ${raw.sNo || ''}: ${k} must be a non-negative number`);
    }
    if (quantity <= 0) throw new Error(`Item ${raw.sNo || ''}: quantity must be greater than 0`);

    const valueSalesExcludingST = round2(quantity * unitPrice - discount);
    if (valueSalesExcludingST < 0) throw new Error(`Item ${raw.sNo || ''}: discount exceeds value`);

    const stBase = fixedNotifiedValueOrRetailPrice > 0 ? fixedNotifiedValueOrRetailPrice : valueSalesExcludingST;
    const salesTaxApplicable = hasOverride(raw.salesTaxApplicable)
        ? round2(num(raw.salesTaxApplicable))
        : round2(stBase * pct / 100);

    const furtherApplies = buyerRegistrationType === 'Unregistered' && !endConsumer && pct > 0 && !NO_FURTHER_TAX_SALE_TYPES.has(raw.saleType);
    const furtherTax = hasOverride(raw.furtherTax)
        ? round2(num(raw.furtherTax))
        : (furtherApplies ? round2(valueSalesExcludingST * Number(furtherTaxRate) / 100) : 0);

    if (Number.isNaN(salesTaxApplicable) || Number.isNaN(furtherTax)) {
        throw new Error(`Item ${raw.sNo || ''}: tax overrides must be numbers`);
    }

    const totalValues = round2(valueSalesExcludingST + salesTaxApplicable + furtherTax + extraTax + fedPayable);

    return {
        sNo: raw.sNo,
        hsCode: String(raw.hsCode || '').trim(),
        productDescription: String(raw.productDescription || '').trim(),
        rate: String(raw.rate || '').trim(),
        uoM: String(raw.uoM || '').trim(),
        saleType: String(raw.saleType || '').trim(),
        sroScheduleNo: String(raw.sroScheduleNo || '').trim(),
        sroItemSerialNo: String(raw.sroItemSerialNo || '').trim(),
        quantity, unitPrice, discount, fixedNotifiedValueOrRetailPrice,
        extraTax: round2(extraTax), fedPayable: round2(fedPayable),
        salesTaxWithheldAtSource: round2(salesTaxWithheldAtSource),
        valueSalesExcludingST, salesTaxApplicable, furtherTax, totalValues,
    };
}

function calcInvoice(items, ctx) {
    if (!Array.isArray(items) || items.length === 0) throw new Error('Add at least one item');
    const lines = items.map((it, i) => calcItem({ ...it, sNo: i + 1 }, ctx));
    for (const l of lines) {
        for (const f of ['hsCode', 'productDescription', 'rate', 'uoM', 'saleType']) {
            if (!l[f]) throw new Error(`Item ${l.sNo}: ${f} is required`);
        }
        if (!/^\d{4}\.\d{4}$/.test(l.hsCode)) throw new Error(`Item ${l.sNo}: HS code must look like 0101.2100`);
    }
    const sum = f => round2(lines.reduce((a, l) => a + l[f], 0));
    return {
        lines,
        totals: {
            totalExclST: sum('valueSalesExcludingST'),
            totalST: sum('salesTaxApplicable'),
            totalFurtherTax: sum('furtherTax'),
            totalAmount: sum('totalValues'),
        },
    };
}

module.exports = { calcInvoice, calcItem, ratePercent, round2 };
