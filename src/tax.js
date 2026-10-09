// Line-level tax calculation for DI invoices. Pure functions, no I/O.
//
// Defaults (the CA can override salesTaxApplicable / furtherTax per line when a
// sale type needs special treatment, e.g. "18% along with rupees 60 per kilogram"):
//   valueSalesExcludingST = quantity × unitPrice − discount
//   ST base               = fixedNotifiedValueOrRetailPrice if > 0 (3rd schedule), else valueSalesExcludingST
//   salesTaxApplicable    = ST base × rate%
//   furtherTax            = valueSalesExcludingST × furtherTaxRate%   for unregistered business buyers and for
//                           registered buyers that are not active (non-ATL) — STA s.3(1A); taxable rates only;
//                           never on sales to end consumers (CA rule / DI Rules #2–3)
//   totalValues           = valueSalesExcludingST + ST + furtherTax + extraTax + fedPayable

// Sale types where further tax is not charged by default
const NO_FURTHER_TAX_SALE_TYPES = new Set(['3rd Schedule Goods', 'Exempt Goods', 'Goods at zero-rate']);
// Exempt / concessionary lines must name the schedule/SRO and its serial (e.g. "6th Schedule Table I", "176(i)")
const SRO_REQUIRED_SALE_TYPES = new Set(['Exempt Goods', 'Goods at Reduced Rate', 'Goods as per SRO.297(|)/2023']);
// Counted units can't be sold in fractions (CA feedback: quantity should be a round number); KG, litre etc. can
const WHOLE_NUMBER_UOMS = new Set(['numbers, pieces, units', 'pair', 'dozen', 'set', 'bag', 'carton', 'packs', 'thousand unit', 'timber logs']);
const isWholeNumberUom = uom => WHOLE_NUMBER_UOMS.has(String(uom || '').trim().toLowerCase());

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

function calcItem(raw, { buyerRegistrationType, furtherTaxRate, endConsumer = false, buyerNonAtl = false }) {
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
    if (isWholeNumberUom(raw.uoM) && !Number.isInteger(quantity)) {
        throw new Error(`Item ${raw.sNo || ''}: quantity must be a whole number for "${String(raw.uoM).trim()}"`);
    }

    const valueSalesExcludingST = round2(quantity * unitPrice - discount);
    if (valueSalesExcludingST < 0) throw new Error(`Item ${raw.sNo || ''}: discount exceeds value`);

    const stBase = fixedNotifiedValueOrRetailPrice > 0 ? fixedNotifiedValueOrRetailPrice : valueSalesExcludingST;
    const salesTaxApplicable = hasOverride(raw.salesTaxApplicable)
        ? round2(num(raw.salesTaxApplicable))
        : round2(stBase * pct / 100);

    const furtherBuyer = buyerRegistrationType === 'Unregistered' ? !endConsumer : buyerNonAtl;
    const furtherApplies = furtherBuyer && pct > 0 && !NO_FURTHER_TAX_SALE_TYPES.has(raw.saleType);
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

// One discount for the whole invoice, split over the lines by their value (qty × price) — FBR takes it per line.
// The last line gets the rounding remainder so the parts add up exactly.
function spreadDiscount(items, invoiceDiscount) {
    const total = num(invoiceDiscount);
    if (Number.isNaN(total) || total < 0) throw new Error('Discount must be a non-negative number');
    if (!total) return items;
    const gross = items.map(it => round2(num(it.quantity) * num(it.unitPrice)));
    const sumGross = round2(gross.reduce((a, g) => a + (Number.isFinite(g) ? g : 0), 0));
    if (total > sumGross) throw new Error(`Discount (${total.toFixed(2)}) is more than the invoice value (${sumGross.toFixed(2)})`);
    let left = total;
    return items.map((it, i) => {
        const share = i === items.length - 1 ? round2(left) : round2(total * gross[i] / sumGross);
        left = round2(left - share);
        return { ...it, discount: round2(num(it.discount) + share) };
    });
}

function calcInvoice(items, ctx, invoiceDiscount = 0) {
    if (!Array.isArray(items) || items.length === 0) throw new Error('Add at least one item');
    const lines = spreadDiscount(items, invoiceDiscount).map((it, i) => calcItem({ ...it, sNo: i + 1 }, ctx));
    for (const l of lines) {
        for (const f of ['hsCode', 'productDescription', 'rate', 'uoM', 'saleType']) {
            if (!l[f]) throw new Error(`Item ${l.sNo}: ${f} is required`);
        }
        if (!/^\d{4}\.\d{4}$/.test(l.hsCode)) throw new Error(`Item ${l.sNo}: HS code must look like 0101.2100`);
        if (SRO_REQUIRED_SALE_TYPES.has(l.saleType) && (!l.sroScheduleNo || !l.sroItemSerialNo)) {
            throw new Error(`Item ${l.sNo}: "${l.saleType}" needs the SRO / Schedule no. and item serial (e.g. 6th Schedule Table I, 176(i)) — set it on the item's tax rule`);
        }
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

module.exports = { calcInvoice, calcItem, spreadDiscount, ratePercent, round2, SRO_REQUIRED_SALE_TYPES, WHOLE_NUMBER_UOMS, isWholeNumberUom };
