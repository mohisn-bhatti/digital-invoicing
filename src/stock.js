// Stock statement (Annex-H1 layout), per HS code + UOM:
//   opening → purchased/imported → adjustments → supplied (taxable / exempt / zero-rated) → closing
// Quantities are exact. Supplies are valued at sale value excl. ST (as in Annex-H1); opening and closing stock at
// weighted average cost of everything received up to that date — confirm this valuation with the CA.
const IN_TYPES = ['OPENING', 'PURCHASE', 'IMPORT', 'ADJUSTMENT_IN'];
const ENTRY_TYPES = [...IN_TYPES, 'ADJUSTMENT_OUT'];
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = n => Math.round((n + Number.EPSILON) * 10000) / 10000;

function supplyCategory(saleType) {
    if (saleType === 'Exempt Goods') return 'exempt';
    if (saleType === 'Goods at zero-rate') return 'zero';
    return 'taxable';
}

// from/to: YYYY-MM-DD (inclusive). fbrEnv: which filed invoices count as supplies.
async function statement(prisma, tenantId, { from, to, fbrEnv }) {
    const [entries, items] = await Promise.all([
        prisma.stockEntry.findMany({ where: { tenantId, entryDate: { lte: to } } }),
        prisma.invoiceItem.findMany({
            where: { invoice: { tenantId, status: 'SUBMITTED', fbrEnv, invoiceDate: { lte: to } } },
            select: { hsCode: true, uoM: true, productDescription: true, quantity: true, valueSalesExcludingST: true, saleType: true, rate: true,
                invoice: { select: { invoiceDate: true, invoiceType: true } } },
        }),
    ]);
    const rows = new Map();
    const row = (hs, uom) => {
        const k = `${hs}|${uom}`;
        if (!rows.has(k)) rows.set(k, {
            hsCode: hs, uoM: uom, description: '', rate: '',
            openQty: 0, inQtyBefore: 0, inValBefore: 0, inQtyTotal: 0, inValTotal: 0,
            purchQty: 0, purchVal: 0, adjQty: 0, taxableQty: 0, taxableVal: 0, exemptQty: 0, exemptVal: 0, zeroQty: 0, zeroVal: 0,
        });
        return rows.get(k);
    };
    for (const e of entries) {
        const r = row(e.hsCode, e.uoM), q = Number(e.quantity), v = Number(e.value), before = e.entryDate < from;
        if (e.description) r.description = e.description;
        const sign = e.entryType === 'ADJUSTMENT_OUT' ? -1 : 1;
        if (before) r.openQty += sign * q;
        if (IN_TYPES.includes(e.entryType)) {
            r.inQtyTotal += q; r.inValTotal += v;
            if (before || e.entryType === 'OPENING') { r.inQtyBefore += q; r.inValBefore += v; }
        }
        if (!before) {
            if (e.entryType === 'OPENING') r.openQty += q;                       // opening entered for this month
            else if (e.entryType === 'PURCHASE' || e.entryType === 'IMPORT') { r.purchQty += q; r.purchVal += v; }
            else r.adjQty += sign * q;
        }
    }
    for (const it of items) {
        const r = row(it.hsCode, it.uoM), sign = it.invoice.invoiceType === 'Debit Note' ? -1 : 1; // debit note = goods back / value reduced
        const q = sign * Number(it.quantity), v = sign * Number(it.valueSalesExcludingST);
        if (!r.description) r.description = it.productDescription;
        if (!r.rate) r.rate = it.rate;
        if (it.invoice.invoiceDate < from) { r.openQty -= q; continue; }
        const c = supplyCategory(it.saleType);
        r[c + 'Qty'] += q; r[c + 'Val'] += v;
    }
    return [...rows.values()].map(r => {
        const avgBefore = r.inQtyBefore ? r.inValBefore / r.inQtyBefore : 0, avgAll = r.inQtyTotal ? r.inValTotal / r.inQtyTotal : 0;
        const closingQty = r.openQty + r.purchQty + r.adjQty - r.taxableQty - r.exemptQty - r.zeroQty;
        return {
            hsCode: r.hsCode, uoM: r.uoM, description: r.description, rate: r.rate,
            openingQty: r4(r.openQty), openingValue: r2(r.openQty * avgBefore),
            purchasedQty: r4(r.purchQty), purchasedValue: r2(r.purchVal),
            adjustmentQty: r4(r.adjQty),
            taxableQty: r4(r.taxableQty), taxableValue: r2(r.taxableVal),
            exemptQty: r4(r.exemptQty), exemptValue: r2(r.exemptVal),
            zeroRatedQty: r4(r.zeroQty), zeroRatedValue: r2(r.zeroVal),
            closingQty: r4(closingQty), closingValue: r2(closingQty * avgAll),
            negative: closingQty < -1e-9,
        };
    }).filter(x => Object.entries(x).some(([k, v]) => typeof v === 'number' && v !== 0))
        .sort((a, b) => a.hsCode.localeCompare(b.hsCode) || a.uoM.localeCompare(b.uoM));
}

const COLUMNS = [
    ['hsCode', 'HS Code'], ['description', 'Description'], ['uoM', 'Unit of Measure'], ['rate', 'Sales Tax Rate'],
    ['openingQty', 'Opening Balance Qty'], ['openingValue', 'Opening Balance Value'],
    ['purchasedQty', 'Purchased / Imported Qty'], ['purchasedValue', 'Purchased / Imported Value'],
    ['adjustmentQty', 'Adjustments Qty (+/-)'],
    ['taxableQty', 'Domestic Taxable Supplies Qty'], ['taxableValue', 'Domestic Taxable Supplies Value'],
    ['exemptQty', 'Exempt Supplies Qty'], ['exemptValue', 'Exempt Supplies Value'],
    ['zeroRatedQty', 'Zero Rated / Export Qty'], ['zeroRatedValue', 'Zero Rated / Export Value'],
    ['closingQty', 'Closing Balance Qty'], ['closingValue', 'Closing Balance Value'],
];
const csvCell = v => {
    let s = v === null || v === undefined ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function toCsv(rows) {
    const lines = [['Sr. No.', ...COLUMNS.map(c => c[1])].map(csvCell).join(',')];
    rows.forEach((r, i) => lines.push([i + 1, ...COLUMNS.map(([k]) => r[k])].map(csvCell).join(',')));
    return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { statement, toCsv, ENTRY_TYPES, supplyCategory, COLUMNS };
