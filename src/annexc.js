// Annex-C (Domestic Sales Invoices) rows, laid out like the IRIS sales tax return annex, for reconciliation.
const COLUMNS = [
    ['srNo', 'Sr. No.'],
    ['buyerNtnCnic', 'Buyer Registration No.'],
    ['buyerName', 'Buyer Name'],
    ['buyerType', 'Buyer Type'],
    ['originProvince', 'Sale Origination Province'],
    ['destinationProvince', 'Destination Province'],
    ['documentType', 'Document Type'],
    ['documentNo', 'Document No. (FBR Invoice No.)'],
    ['documentDate', 'Document Date'],
    ['hsCode', 'HS Code'],
    ['saleType', 'Sale Type'],
    ['rate', 'Rate'],
    ['uoM', 'UOM'],
    ['quantity', 'Quantity'],
    ['valueExclST', 'Value of Sales Excl. ST'],
    ['fixedNotifiedValue', 'Fixed / Notified Value or Retail Price'],
    ['salesTax', 'Sales Tax / FED in ST Mode'],
    ['extraTax', 'Extra Tax'],
    ['stWithheld', 'ST Withheld as WH Agent'],
    ['sroScheduleNo', 'SRO No. / Schedule No.'],
    ['sroItemSerialNo', 'Item Sr. No.'],
    ['furtherTax', 'Further Tax'],
    ['totalValue', 'Total Value incl. Taxes'],
    ['refInvoiceNo', 'Reference Invoice No.'],
    ['localInvoiceNo', 'Our Invoice No.'],
];
const SUM_FIELDS = ['quantity', 'valueExclST', 'fixedNotifiedValue', 'salesTax', 'extraTax', 'stWithheld', 'furtherTax', 'totalValue'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2025-08-31" -> "31-Aug-2025" (IRIS style)
function irisDate(ymd) {
    const [y, m, d] = ymd.split('-');
    return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
}

function monthRange(month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) return null;
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

function rows(invoices, sellerProvince) {
    const out = [];
    for (const inv of invoices) {
        for (const it of inv.items) {
            out.push({
                srNo: out.length + 1,
                buyerNtnCnic: inv.buyerNtnCnic,
                buyerName: inv.buyerBusinessName,
                buyerType: inv.buyerRegistrationType,
                originProvince: sellerProvince,
                destinationProvince: inv.buyerProvince,
                documentType: inv.invoiceType,
                documentNo: inv.fbrInvoiceNumber,
                documentDate: irisDate(inv.invoiceDate),
                hsCode: it.hsCode,
                saleType: it.saleType,
                rate: it.rate,
                uoM: it.uoM,
                quantity: Number(it.quantity),
                valueExclST: Number(it.valueSalesExcludingST),
                fixedNotifiedValue: Number(it.fixedNotifiedValueOrRetailPrice),
                salesTax: Number(it.salesTaxApplicable),
                extraTax: Number(it.extraTax),
                stWithheld: Number(it.salesTaxWithheldAtSource),
                sroScheduleNo: it.sroScheduleNo,
                sroItemSerialNo: it.sroItemSerialNo,
                furtherTax: Number(it.furtherTax),
                totalValue: Number(it.totalValues),
                refInvoiceNo: inv.invoiceRefNo,
                localInvoiceNo: inv.invoiceNo || inv.localNo,
            });
        }
    }
    return out;
}

function totals(list) {
    const t = Object.fromEntries(SUM_FIELDS.map(f => [f, 0]));
    for (const r of list) for (const f of SUM_FIELDS) t[f] += r[f];
    for (const f of SUM_FIELDS) t[f] = Math.round(t[f] * 10000) / 10000;
    return t;
}

// Text that starts with = + - @ would run as a formula in Excel: prefix it with '
const csvCell = v => {
    let s = v === null || v === undefined ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// UTF-8 BOM so Excel opens it with the right encoding
function toCsv(list, sum) {
    const lines = [COLUMNS.map(c => csvCell(c[1])).join(',')];
    for (const r of list) lines.push(COLUMNS.map(([k]) => csvCell(r[k])).join(','));
    lines.push(COLUMNS.map(([k], i) => csvCell(i === 0 ? 'TOTAL' : (k in sum ? sum[k] : ''))).join(','));
    return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { COLUMNS, rows, totals, toCsv, monthRange, irisDate };
