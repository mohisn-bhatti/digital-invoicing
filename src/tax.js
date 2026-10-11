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
// FBR rates like "18% along with rupees 60 per kilogram" (spec §5.8) also charge Rs 60 per unit sold (error 0105)
function rupeesPerUnit(rate) {
    const m = String(rate || '').match(/rupees?\s*([\d,]+(?:\.\d+)?)\s*per\b/i);
    return m ? Number(m[1].replace(/,/g, '')) : 0;
}

function hasOverride(v) {
    return v !== null && v !== undefined && v !== '';
}

// "More taxes" set on the item's tax rule (CA). Each: { name, kind: PCT|FIXED, value, base, fbrField }.
// base: one or more of VALUE (value excl. ST), SALES_TAX, TAX:<i> (an earlier extra tax), joined with "+" — the tax
// is applied on their sum (CA: multi-select). VALUE_AFTER_TAX (older rules) = VALUE+SALES_TAX.
// FIXED is the amount once on the line, whatever the quantity. FBR has no box per tax, so each goes into the box
// the client chose; the receipt shows them by name.
const EXTRA_TAX_BASES = ['VALUE', 'SALES_TAX'];
const baseParts = base => [...new Set(String(base || 'VALUE').split('+').flatMap(x => x === 'VALUE_AFTER_TAX' ? ['VALUE', 'SALES_TAX'] : [x.trim()]).filter(Boolean))];
// FBR DI API v1.12: salesTaxApplicable is the sales tax only ("excluding further & extra tax") and is checked against
// rate × value (error 0104), and further tax has its own rule — so more taxes can only go to Extra Tax or FED Payable
const EXTRA_TAX_FIELDS = ['extraTax', 'fedPayable'];
const MAX_EXTRA_TAXES = 10;
function extraTaxDefs(v) {
    if (typeof v === 'string') { try { v = v.trim() ? JSON.parse(v) : []; } catch { throw new Error('More taxes could not be read'); } }
    return Array.isArray(v) ? v : [];
}
// Checks and cleans the list; throws a message the user can act on (who = "Item 2" or "Tax rule")
function cleanExtraTaxes(v, who = 'Tax rule') {
    const defs = extraTaxDefs(v);
    if (defs.length > MAX_EXTRA_TAXES) throw new Error(`${who}: at most ${MAX_EXTRA_TAXES} more taxes`);
    return defs.map((d, i) => {
        const name = String(d?.name ?? '').trim().slice(0, 60);
        const kind = d?.kind === 'FIXED' ? 'FIXED' : 'PCT';
        const value = Number(d?.value);
        const parts = kind === 'FIXED' ? [] : baseParts(d?.base);
        const base = parts.join('+');
        const fbrField = String(d?.fbrField || 'extraTax');
        if (!name) throw new Error(`${who}: more tax ${i + 1} needs a name`);
        if (!Number.isFinite(value) || value < 0) throw new Error(`${who}: "${name}" needs an amount of 0 or more`);
        if (kind === 'PCT' && value > 1000) throw new Error(`${who}: "${name}" percent looks wrong`);
        for (const part of parts) {
            const ref = /^TAX:(\d+)$/.exec(part);
            if (!EXTRA_TAX_BASES.includes(part) && !(ref && Number(ref[1]) < i)) {
                throw new Error(`${who}: "${name}" can only be applied on a tax listed above it`);
            }
        }
        if (!EXTRA_TAX_FIELDS.includes(fbrField)) throw new Error(`${who}: "${name}" can only go to FBR's Extra Tax or FED Payable box`);
        // The law the client read for this tax (record only; FBR gets the sales tax's reference)
        const refs = (Array.isArray(d?.refs) ? d.refs : []).slice(0, 20).map(r => ({
            reference: String(r?.reference ?? '').trim().slice(0, 200),
            url: /^https?:\/\//i.test(String(r?.url || '')) ? String(r.url).trim().slice(0, 1000) : '',
            source: String(r?.source ?? '').trim().slice(0, 20),
        })).filter(r => r.reference);
        const comment = String(d?.comment ?? '').trim().slice(0, 2000);
        return { name, kind, value: round2(value), base, fbrField, refs, comment };
    });
}
// Amounts for one line. salesTax = the line's own sales tax (before any extra tax is added to that box).
function calcExtraTaxes(defs, { valueSalesExcludingST, salesTax }) {
    const amounts = [];
    return defs.map((d, i) => {
        let amount;
        if (d.kind === 'FIXED') amount = d.value;
        else {
            const base = baseParts(d.base).reduce((sum, part) => {
                const ref = /^TAX:(\d+)$/.exec(part);
                return sum + (ref ? amounts[Number(ref[1])] : part === 'SALES_TAX' ? salesTax : valueSalesExcludingST);
            }, 0);
            amount = round2(base * d.value / 100);
        }
        amounts[i] = amount;
        return { name: d.name, amount, fbrField: d.fbrField };
    });
}

function calcItem(raw, { buyerRegistrationType, furtherTaxRate, endConsumer = false, buyerNonAtl = false }) {
    const quantity = num(raw.quantity);
    // a missing rate is an error, not Rs 0 (the invoice's rate box is read-only, so the browser doesn't check it)
    if (raw.unitPrice === '' || raw.unitPrice === null || raw.unitPrice === undefined) throw new Error(`Item ${raw.sNo || ''}: rate (per unit) is missing — the item needs a price`);
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
    // FBR DI API v1.12 error 0079: above Rs 20,000 the 5% rate is not allowed
    if (pct === 5 && valueSalesExcludingST > 20000) {
        throw new Error(`Item ${raw.sNo || ''}: FBR does not allow the 5% rate when the value is above Rs 20,000 (FBR rule 0079)`);
    }

    const stBase = fixedNotifiedValueOrRetailPrice > 0 ? fixedNotifiedValueOrRetailPrice : valueSalesExcludingST;
    const salesTaxApplicable = hasOverride(raw.salesTaxApplicable)
        ? round2(num(raw.salesTaxApplicable))
        : round2(stBase * pct / 100 + rupeesPerUnit(raw.rate) * quantity);

    const furtherBuyer = buyerRegistrationType === 'Unregistered' ? !endConsumer : buyerNonAtl;
    const furtherApplies = furtherBuyer && pct > 0 && !NO_FURTHER_TAX_SALE_TYPES.has(raw.saleType);
    const furtherTax = hasOverride(raw.furtherTax)
        ? round2(num(raw.furtherTax))
        : (furtherApplies ? round2(valueSalesExcludingST * Number(furtherTaxRate) / 100) : 0);

    if (Number.isNaN(salesTaxApplicable) || Number.isNaN(furtherTax)) {
        throw new Error(`Item ${raw.sNo || ''}: tax overrides must be numbers`);
    }

    // More taxes from the item's tax rule, each added into the FBR box chosen for it
    const extraTaxes = cleanExtraTaxes(raw.extraTaxes, `Item ${raw.sNo || ''}`);
    const extraTaxDetail = calcExtraTaxes(extraTaxes, { valueSalesExcludingST, salesTax: salesTaxApplicable });
    const box = { salesTaxApplicable, furtherTax, extraTax: round2(extraTax), fedPayable: round2(fedPayable) };
    for (const t of extraTaxDetail) box[t.fbrField] = round2(box[t.fbrField] + t.amount);

    const totalValues = round2(valueSalesExcludingST + box.salesTaxApplicable + box.furtherTax + box.extraTax + box.fedPayable);

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
        extraTax: box.extraTax, fedPayable: box.fedPayable,
        salesTaxWithheldAtSource: round2(salesTaxWithheldAtSource),
        valueSalesExcludingST, salesTaxApplicable: box.salesTaxApplicable, furtherTax: box.furtherTax, totalValues,
        extraTaxes, extraTaxDetail,
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
        // CA: no serial box — only the SRO / Schedule no. is required; the serial is sent when the item has one
        // FBR DI API v1.12 errors 0077 / 0078: exempt, reduced-rate and SRO lines need the SRO / Schedule no. and the item serial
        if (SRO_REQUIRED_SALE_TYPES.has(l.saleType) && (!l.sroScheduleNo || !l.sroItemSerialNo)) {
            throw new Error(`Item ${l.sNo}: "${l.saleType}" needs the SRO / Schedule no. and the item serial no. (FBR rules 0077 / 0078) — set them on the item's tax rule`);
        }
        // Errors 0090 / 0102: 3rd schedule goods are taxed on the printed retail price, which FBR needs
        if (l.saleType === '3rd Schedule Goods' && !(l.fixedNotifiedValueOrRetailPrice > 0)) {
            throw new Error(`Item ${l.sNo}: 3rd schedule goods need the retail price (FBR rule 0090) — set the retail price per unit on the item's tax rule`);
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

module.exports = { calcInvoice, calcItem, spreadDiscount, cleanExtraTaxes, calcExtraTaxes, ratePercent, rupeesPerUnit, round2, SRO_REQUIRED_SALE_TYPES, WHOLE_NUMBER_UOMS, isWholeNumberUom };
