// Bulk import: spreadsheet rows (one row per item) → invoice request bodies, grouped by the client's own invoice ref.
const crypto = require('crypto');

// Template columns, in order. key = field name; label = header in the template; aliases = other headers we accept.
const COLUMNS = [
    { key: 'invoiceRef', label: 'Invoice Ref', required: true, aliases: ['invoice no', 'invoice number', 'your invoice no', 'ref', 'document no', 'document number'] },
    { key: 'invoiceDate', label: 'Invoice Date', required: true, aliases: ['date', 'document date'] },
    { key: 'documentType', label: 'Document Type', aliases: ['doc type', 'invoice type', 'type'] },
    { key: 'originalFbrInvoiceNo', label: 'Original FBR Invoice No', aliases: ['ref invoice no', 'invoice ref no', 'reference invoice no'] },
    { key: 'reason', label: 'Debit Note Reason', aliases: ['reason'] },
    { key: 'reasonRemarks', label: 'Reason Remarks', aliases: ['remarks'] },
    { key: 'buyerType', label: 'Buyer Type', aliases: ['buyer registration type', 'registration type'] },
    { key: 'buyerNtnCnic', label: 'Buyer NTN/CNIC', aliases: ['buyer ntn', 'buyer cnic', 'buyer registration no', 'registration no', 'ntn', 'cnic'] },
    { key: 'buyerName', label: 'Buyer Name', aliases: ['buyer business name', 'customer', 'customer name'] },
    { key: 'buyerProvince', label: 'Buyer Province', aliases: ['destination province', 'province'] },
    { key: 'buyerAddress', label: 'Buyer Address', aliases: ['address'] },
    { key: 'scenarioId', label: 'Scenario (sandbox)', aliases: ['scenario', 'scenario id'] },
    { key: 'hsCode', label: 'HS Code', required: true, aliases: ['pct code', 'hs'] },
    { key: 'description', label: 'Description', required: true, aliases: ['product description', 'item', 'item name', 'product'] },
    { key: 'saleType', label: 'Sale Type', required: true },
    { key: 'quantity', label: 'Quantity', required: true, aliases: ['qty'] },
    { key: 'uoM', label: 'UOM', required: true, aliases: ['unit'] },
    { key: 'unitPrice', label: 'Unit Price', aliases: ['price', 'price per unit'] },
    // Annex-C style files have the line value instead of a unit price (CA Q&A #19)
    { key: 'lineValue', label: 'Value of Sales Excl. ST (instead of Unit Price)', aliases: ['value of sales excl st', 'value of sales excluding st', 'value excl st', 'sale value', 'value of sales'] },
    { key: 'rate', label: 'Rate', required: true, aliases: ['tax rate', 'st rate'] },
    { key: 'discount', label: 'Discount' },
    { key: 'retailValue', label: 'Retail Value (3rd Sch, line total)', aliases: ['retail value', 'fixed notified value', 'fixed notified value or retail price', 'retail price'] },
    { key: 'extraTax', label: 'Extra Tax' },
    { key: 'fedPayable', label: 'FED Payable', aliases: ['fed'] },
    { key: 'stWithheld', label: 'ST Withheld at Source', aliases: ['st withheld', 'sales tax withheld at source', 'st withheld as wh agent'] },
    { key: 'sroScheduleNo', label: 'SRO Schedule No', aliases: ['sro schedule', 'sro no', 'sro no schedule no', 'sro no schedule'] },
    { key: 'sroItemSerialNo', label: 'SRO Item Serial No', aliases: ['sro item', 'sro item serial', 'item sr no'] },
    { key: 'salesTaxOverride', label: 'Sales Tax (override)', aliases: ['sales tax', 'sales tax fed in st mode', 'sales tax fed in st'] },
    { key: 'furtherTaxOverride', label: 'Further Tax (override)', aliases: ['further tax'] },
];
const MAX_ROWS = 5000, MAX_INVOICES = 1000;

const norm = h => String(h ?? '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, '');
const HEADER_MAP = new Map();
for (const c of COLUMNS) for (const h of [c.label, c.key, ...(c.aliases || [])]) if (!HEADER_MAP.has(norm(h))) HEADER_MAP.set(norm(h), c.key);

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');
function ymd(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}
// 2025-08-31, 31-08-2025, 31/08/2025, 31-Aug-2025, 31 Aug 2025, Excel serial 45900 → "YYYY-MM-DD" (null if unreadable)
function parseDate(v) {
    const s = String(v ?? '').trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return ymd(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) return ymd(+m[3], +m[2], +m[1]); // day first (Pakistan)
    if ((m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{4})$/))) return MONTHS[m[2].toLowerCase()] ? ymd(+m[3], MONTHS[m[2].toLowerCase()], +m[1]) : null;
    if (/^\d{5}(\.\d+)?$/.test(s)) { // Excel serial date
        const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86400000);
        return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    return null;
}

// 18 / "18" / 0.18 / "18 %" → "18%"; text such as "Exempt" or "18% along with rupees 60 per kilogram" kept as is
function normRate(v) {
    const s = String(v ?? '').trim();
    if (/^\d+(\.\d+)?$/.test(s)) { const n = Number(s); return `${+(n > 0 && n < 1 ? n * 100 : n).toFixed(2)}%`; }
    if (/^\d+(\.\d+)?\s*%$/.test(s)) return s.replace(/\s+/g, '');
    return s;
}
const num = v => (v === null || v === undefined || String(v).trim() === '' ? '' : String(v).replace(/,/g, '').trim());

function buyerKind(v, ntn) {
    const s = norm(v);
    if (s === 'registered') return { buyerRegistrationType: 'Registered', endConsumer: false };
    if (['endconsumer', 'walkin', 'consumer', 'enduser', 'various'].includes(s)) return { buyerRegistrationType: 'Unregistered', endConsumer: true };
    if (s === 'unregistered' || s === 'unregisteredbusiness') return { buyerRegistrationType: 'Unregistered', endConsumer: false };
    if (!s) return ntn ? null : { buyerRegistrationType: 'Unregistered', endConsumer: true };
    return undefined;
}

// Unit price, or derived from the line value: valueExclST = qty × price − discount → price = (value + discount) / qty
function priceOf(r, errors) {
    const unit = num(r.unitPrice), value = num(r.lineValue);
    if (unit !== '') return { unitPrice: unit };
    if (value === '') { errors.push('Each line needs a Unit Price or a Value of Sales Excl. ST.'); return { unitPrice: '' }; }
    const qty = Number(num(r.quantity)), disc = Number(num(r.discount) || 0);
    if (!(qty > 0)) return { unitPrice: '' }; // quantity error is reported by the tax check
    return { unitPrice: String((Number(value) + disc) / qty) };
}

// Same file imported twice must not file twice: one id per (invoice ref, date)
function requestId(ref, date) {
    return 'imp-' + crypto.createHash('sha256').update(`${ref}|${date}`).digest('hex').slice(0, 40);
}

// rows: array of objects keyed by the sheet's header text. Returns { invoices, errors, unknownHeaders }
function groupRows(rows) {
    if (!Array.isArray(rows) || !rows.length) return { invoices: [], errors: ['The file has no rows.'], unknownHeaders: [] };
    if (rows.length > MAX_ROWS) return { invoices: [], errors: [`Too many rows (${rows.length}); max ${MAX_ROWS} per file.`], unknownHeaders: [] };

    const headers = [...new Set(rows.flatMap(r => Object.keys(r || {})))]; // every column used on any row
    const keyOf = Object.fromEntries(headers.map(h => [h, HEADER_MAP.get(norm(h))]));
    const unknownHeaders = headers.filter(h => !keyOf[h] && norm(h));
    const present = new Set(Object.values(keyOf));
    const missing = COLUMNS.filter(c => c.required && !present.has(c.key)).map(c => c.label);
    if (!present.has('unitPrice') && !present.has('lineValue')) missing.push('Unit Price (or Value of Sales Excl. ST)');
    if (missing.length) return { invoices: [], errors: [`Missing column(s): ${missing.join(', ')}. Download the template to see the layout.`], unknownHeaders };

    const groups = new Map();
    rows.forEach((raw, i) => {
        const r = {};
        for (const [h, v] of Object.entries(raw)) if (keyOf[h]) r[keyOf[h]] = typeof v === 'string' ? v.trim() : v;
        if (Object.values(r).every(v => v === '' || v === null || v === undefined)) return; // blank line
        const rowNo = i + 2; // +1 header, +1 to count from 1
        const ref = String(r.invoiceRef ?? '').trim();
        const key = ref || `__row${rowNo}`;
        if (!groups.has(key)) groups.set(key, { ref, rows: [], rowNumbers: [] });
        const g = groups.get(key);
        g.rows.push(r); g.rowNumbers.push(rowNo);
    });
    if (groups.size > MAX_INVOICES) return { invoices: [], errors: [`Too many invoices (${groups.size}); max ${MAX_INVOICES} per file.`], unknownHeaders };

    const invoices = [...groups.values()].map(g => {
        const errors = [];
        // Invoice-level columns: the first non-blank value on any row of this invoice (rows may leave them blank)
        const first = {};
        for (const k of ['invoiceDate', 'documentType', 'originalFbrInvoiceNo', 'reason', 'reasonRemarks', 'buyerType', 'buyerNtnCnic', 'buyerName', 'buyerProvince', 'buyerAddress', 'scenarioId']) {
            first[k] = g.rows.map(r => r[k]).find(v => v !== undefined && v !== null && String(v).trim() !== '');
        }
        if (!g.ref) errors.push('Invoice Ref is empty.');
        const invoiceDate = parseDate(first.invoiceDate);
        if (!invoiceDate) errors.push(`Invoice Date "${first.invoiceDate ?? ''}" is not a date (use YYYY-MM-DD or DD-MM-YYYY).`);
        // Header columns must agree on every row of the same invoice
        for (const k of ['invoiceDate', 'documentType', 'buyerType', 'buyerNtnCnic', 'buyerName', 'scenarioId', 'originalFbrInvoiceNo']) {
            const vals = new Set(g.rows.map(r => String(r[k] ?? '').trim()).filter(Boolean));
            if (vals.size > 1) errors.push(`Rows of this invoice disagree on ${COLUMNS.find(c => c.key === k).label}: ${[...vals].join(' / ')}.`);
        }
        const ntn = String(first.buyerNtnCnic ?? '').replace(/\D/g, '');
        const kind = buyerKind(first.buyerType, ntn);
        if (kind === null) errors.push('Buyer Type is required when a Buyer NTN/CNIC is given (Registered / Unregistered / End consumer).');
        if (kind === undefined) errors.push(`Buyer Type "${first.buyerType}" not recognised (use Registered / Unregistered / End consumer).`);
        const docType = norm(first.documentType);
        if (docType && !['saleinvoice', 'sale', 'invoice', 'debitnote', 'debit'].includes(docType)) errors.push(`Document Type "${first.documentType}" not recognised (Sale Invoice / Debit Note).`);

        const body = {
            invoiceType: docType.startsWith('debit') ? 'Debit Note' : 'Sale Invoice',
            invoiceDate,
            invoiceRefNo: String(first.originalFbrInvoiceNo ?? '').trim(),
            reason: String(first.reason ?? '').trim(),
            reasonRemarks: String(first.reasonRemarks ?? '').trim(),
            ...(kind || { buyerRegistrationType: 'Unregistered', endConsumer: true }),
            buyerNtnCnic: ntn,
            buyerBusinessName: String(first.buyerName ?? '').trim(),
            buyerProvince: String(first.buyerProvince ?? '').trim().toUpperCase(),
            buyerAddress: String(first.buyerAddress ?? '').trim(),
            scenarioId: String(first.scenarioId ?? '').trim().toUpperCase(),
            items: g.rows.map(r => ({
                ...priceOf(r, errors),
                hsCode: String(r.hsCode ?? '').trim(),
                productDescription: String(r.description ?? '').trim(),
                saleType: String(r.saleType ?? '').trim(),
                quantity: num(r.quantity),
                uoM: String(r.uoM ?? '').trim(),
                rate: normRate(r.rate),
                discount: num(r.discount),
                fixedNotifiedValueOrRetailPrice: num(r.retailValue),
                extraTax: num(r.extraTax),
                fedPayable: num(r.fedPayable),
                salesTaxWithheldAtSource: num(r.stWithheld),
                sroScheduleNo: String(r.sroScheduleNo ?? '').trim(),
                sroItemSerialNo: String(r.sroItemSerialNo ?? '').trim(),
                salesTaxApplicable: num(r.salesTaxOverride),
                furtherTax: num(r.furtherTaxOverride),
            })),
        };
        return { ref: g.ref, rowNumbers: g.rowNumbers, body, errors, clientRequestId: invoiceDate && g.ref ? requestId(g.ref, invoiceDate) : null };
    });
    return { invoices, errors: [], unknownHeaders };
}

const csvCell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function templateCsv(sandbox) {
    const ex1 = { invoiceRef: 'INV-1001', invoiceDate: '2026-10-06', documentType: 'Sale Invoice', buyerType: 'Registered', buyerNtnCnic: '1234567',
        buyerName: 'ABC Traders', buyerProvince: 'SINDH', buyerAddress: 'Karachi', scenarioId: sandbox ? 'SN001' : '', hsCode: '3904.1090',
        description: 'PVC resin', saleType: 'Goods at standard rate (default)', quantity: 100, uoM: 'KG', unitPrice: 250, rate: '18%', discount: 0 };
    const ex2 = { ...ex1, description: 'PVC pipes', hsCode: '3917.2390', quantity: 20, unitPrice: 1200 };
    const ex3 = { invoiceRef: 'INV-1002', invoiceDate: '2026-10-06', documentType: 'Sale Invoice', buyerType: 'End consumer', scenarioId: sandbox ? 'SN026' : '',
        hsCode: '0403.1000', description: 'Yogurt 500g', saleType: 'Goods at standard rate (default)', quantity: 5, uoM: 'KG', unitPrice: 300, rate: '18%' };
    const lines = [COLUMNS.map(c => csvCell(c.label)).join(',')];
    for (const ex of [ex1, ex2, ex3]) lines.push(COLUMNS.map(c => csvCell(ex[c.key])).join(','));
    return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { COLUMNS, groupRows, parseDate, normRate, requestId, templateCsv, MAX_ROWS, MAX_INVOICES };
