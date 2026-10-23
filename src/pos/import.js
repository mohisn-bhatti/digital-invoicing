// Bulk import of items, customers and vendors from a spreadsheet, and undoing an import.
//
// The browser reads the file (Excel or CSV) and sends rows with canonical column names ({ row, name, code, ... }); this file does not trust any of it.
// The rules that matter most:
//  - NOTHING is saved while the file has a problem. Every problem of every row is listed at once, with its row number, so the file is fixed and uploaded again.
//  - A row is checked with the very same rules as typing the record in by hand (validate.js, accounts.js), so an import can never make something the screens refuse.
//  - A row that matches something already saved (an item's code or barcode, a customer's PNTN or CNIC, a vendor's NTN, otherwise the same name) never overwrites it:
//    what the saved record is missing is filled in, and for every difference the uploader chooses the file's value or the saved one (importMerge.js, as for FBR).
//  - Opening balances (money owed) are only ever taken from the file for a NEW customer or vendor, never changed on a saved one.
//  - Saving is one transaction under the same locks as the screens use (so codes are never handed out twice), and a file saves entirely or not at all.
//  - Every import is a batch that keeps what it added and what it changed, so it can be undone (see undo).
const crypto = require('crypto');
const V = require('./validate');
const M = require('../importMerge');
const { PosError } = require('./errors');
const { cleanVendor, cleanBalance } = require('./accounts');
const { ciEquals } = require('./like');

const MAX_ROWS = 2000, MAX_UPDATES = 500;
const KINDS = ['items', 'customers', 'vendors'];
const KIND_NAME = { items: 'ITEMS', customers: 'CUSTOMERS', vendors: 'VENDORS' };
// The columns each kind understands, by the canonical names the browser maps headings onto. `required` ones must be present in the file.
const COLUMNS = {
    items: { required: ['name'], all: ['code', 'barcode', 'name', 'category', 'pct', 'taxRate', 'taxRateCard', 'price', 'openPrice', 'taxInclusive', 'followSchedule', 'active'] },
    customers: { required: ['name'], all: ['code', 'name', 'pntn', 'cnic', 'phone', 'address', 'notes', 'openingBalance', 'active'] },
    vendors: { required: ['name'], all: ['code', 'name', 'ntn', 'phone', 'address', 'notes', 'openingBalance', 'active'] },
};
const LABEL = { name: 'Name', pct: 'PCT code', taxRate: 'Sales tax %' };

const squash = v => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const lower = v => String(v ?? '').trim().toLowerCase();
const digits = v => String(v ?? '').replace(/\D/g, '');
class Problem extends Error {} // one thing wrong in one row

// ---------- reading one cell ----------
function cell(v, what) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Problem(`${what} is not a number.`); return String(+v.toFixed(8)); } // 0.30000000000000004 is 0.3
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    throw new Problem(`${what} has something in it that is not text or a number.`);
}
// "1,500.50", "Rs 1500" → "1500.50"; empty → null
function amountCell(v, what) {
    const t = cell(v, what).replace(/,/g, '').replace(/^rs\.?\s*/i, '').trim();
    if (!t) return null;
    if (!/^\d+(\.\d+)?$/.test(t)) throw new Problem(`${what} must be a number like 1500 or 1,500.50.`);
    return t;
}
// "16", "16%", or 0.16 (a cell formatted as a percentage) → "16"; the last is noted so it is not a surprise
function rateCell(v, what, notes) {
    if (typeof v === 'number' && v > 0 && v < 1) { notes.push(`${what} ${v} was read as ${+(v * 100).toFixed(4)}% (a cell formatted as a percentage)`); return String(+(v * 100).toFixed(4)); }
    const t = cell(v, what).replace(/%\s*$/, '').trim();
    if (!t) return null;
    if (!/^\d+(\.\d+)?$/.test(t)) throw new Problem(`${what} must be a number like 16 or 8.5.`);
    return t;
}
function yesNo(v, what) {
    const t = squash(cell(v, what));
    if (!t) return null;
    if (['yes', 'y', 'true', '1', 'x', 'on'].includes(t)) return true;
    if (['no', 'n', 'false', '0', 'off'].includes(t)) return false;
    throw new Problem(`${what}: write yes or no.`);
}
// Excel turns 9801.2000 into the number 9801.2: put the four decimals back
const pctCell = (v, what) => (typeof v === 'number' ? v.toFixed(4) : cell(v, what).trim());
const text = (v, max, what) => { const s = cell(v, what); try { return V.text(s, max, what); } catch (e) { throw new Problem(e.message); } };

// Excel stores 03001234567 as the number 3001234567 and drops the 0: a ten-digit number starting with 3 is a Pakistani mobile that lost its 0
function phoneCell(v, notes) {
    const t = cell(v, 'Phone').trim();
    if (/^3\d{9}$/.test(t)) { notes.push(`the phone ${t} had lost its leading 0 (Excel does that): read as 0${t}`); return '0' + t; }
    return t;
}

// ---------- what a saved record looks like to the comparison ----------
const ITEM_FIELDS = [
    M.field('name', 'Item name'), M.field('barcode', 'Barcode'), M.field('category', 'Category'), M.field('pctCode', 'PCT code', 'digits'),
    M.field('taxRate', 'Sales tax %', 'amount'), M.field('taxRateCard', 'Sales tax % on card', 'amount'), M.field('unitPrice', 'Price', 'price'),
    M.field('openPrice', 'Price typed on each sale', 'flag'), M.field('taxInclusive', 'Price includes the sales tax', 'flag'), M.field('followSchedule', 'Follows the rate schedule', 'flag'), M.field('active', 'On sale', 'flag'),
];
const CUSTOMER_FIELDS = [M.field('name', 'Name'), M.field('pntn', 'PNTN', 'digits'), M.field('cnic', 'CNIC', 'digits'), M.field('phone', 'Phone', 'mobile'), M.field('address', 'Address'), M.field('notes', 'Notes'), M.field('active', 'In use', 'flag')];
const VENDOR_FIELDS = [M.field('name', 'Name'), M.field('ntn', 'NTN', 'digits'), M.field('phone', 'Phone', 'mobile'), M.field('address', 'Address'), M.field('notes', 'Notes'), M.field('active', 'In use', 'flag')];
const FIELDS = { items: ITEM_FIELDS, customers: CUSTOMER_FIELDS, vendors: VENDOR_FIELDS };
const num = d => (d === null || d === undefined ? null : Number(d));
const savedItem = i => ({ name: i.name, barcode: i.barcode || null, category: i.category, pctCode: i.pctCode, taxRate: num(i.taxRate), taxRateCard: num(i.taxRateCard), unitPrice: num(i.unitPrice), openPrice: Boolean(i.openPrice), taxInclusive: Boolean(i.taxInclusive), followSchedule: Boolean(i.followSchedule), active: Boolean(i.active) });
const savedCustomer = c => ({ name: c.name, pntn: c.pntn, cnic: c.cnic, phone: c.phone, address: c.address, notes: c.notes, active: Boolean(c.active) });
const savedVendor = v => ({ name: v.name, ntn: v.ntn, phone: v.phone, address: v.address, notes: v.notes, active: Boolean(v.active) });
const SAVED = { items: savedItem, customers: savedCustomer, vendors: savedVendor };

// ---------- checking a file (pure: it is given what is saved) ----------
// ctx: { existing: saved records, defaults: { itemPct, itemTaxRate, itemTaxRateCard, itemCategory }, scheduled: Set of PRA headings the rate schedule has a rate for today }
function checkFile(kind, file, ctx) {
    const errors = [], warnings = [], ready = [];
    const fileError = msg => errors.push({ sheet: 'File', row: null, name: '', messages: [msg] });
    const rows = Array.isArray(file && file.rows) ? file.rows : [];
    const headers = new Set(Array.isArray(file && file.headers) ? file.headers : []);
    const spec = COLUMNS[kind];
    if (!spec) return { errors: [{ sheet: 'File', row: null, name: '', messages: ['Choose items, customers or vendors.'] }], warnings, ready };
    const missing = spec.required.filter(k => !headers.has(k));
    if (missing.length) fileError(`The column ${missing.map(k => `"${LABEL[k] || k}"`).join(', ')} was not found. Use the template, or name the column like the template does.`);
    if (kind === 'items' && !headers.has('pct') && !(ctx.defaults && ctx.defaults.itemPct)) fileError('There is no "PCT code" column, and no default heading is set (Settings, "A new item starts with"). Add the column or set the default.');
    if (!rows.length) fileError('The file has no rows under the headings.');
    if (rows.length > MAX_ROWS) fileError(`At most ${MAX_ROWS} rows per file (this file has ${rows.length}). Split it and upload the parts one after the other.`);
    if (errors.length) return { errors, warnings, ready };

    const idx = indexOf(kind, ctx.existing);
    const seenSaved = new Map(), seenKey = new Map(); // a saved record matched twice; a new record's code / barcode / PNTN used twice in the file
    rows.forEach((raw, n) => {
        const row = Number.isInteger(raw && raw.row) ? raw.row : n + 2;
        const notes = [], problems = [];
        const bad = fn => { try { return fn(); } catch (e) { if (e instanceof Problem || e instanceof V.PosValidationError) { problems.push(e.message); return undefined; } throw e; } };
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return errors.push({ sheet: 'File', row, name: '', messages: ['This row is not valid.'] });
        const name = bad(() => text(raw.name, 150, 'Name')) || '';
        if (!name && !problems.length) problems.push('The name is empty.');
        const report = () => errors.push({ sheet: kindSheet(kind), row, name: name || cellSafe(raw.name), messages: problems });
        const entry = ({ items: itemRow, customers: customerRow, vendors: vendorRow })[kind]({ raw, row, name, ctx, idx, notes, bad, problems, seenKey, headers });
        if (problems.length) return report();
        // one saved record cannot be the match of two rows
        if (entry.existing) {
            const first = seenSaved.get(entry.existing.id);
            if (first) { problems.push(`This is the same ${singular(kind)} as row ${first} (it matches "${entry.existing.name}")`); return report(); }
            seenSaved.set(entry.existing.id, row);
        }
        for (const w of notes) warnings.push({ sheet: kindSheet(kind), row, name, messages: [w] });
        ready.push({ row, name, ...entry });
    });
    const updates = ready.filter(r => r.existing).length;
    if (!errors.length && updates > MAX_UPDATES) fileError(`At most ${MAX_UPDATES} saved ${kind} can be updated by one file (this file matches ${updates}). Split it.`);
    return { errors, warnings, ready };
}
const singular = kind => ({ items: 'item', customers: 'customer', vendors: 'vendor' })[kind];
const kindSheet = kind => ({ items: 'Items', customers: 'Customers', vendors: 'Vendors' })[kind];
const cellSafe = v => (typeof v === 'string' ? v.slice(0, 60) : '');

function indexOf(kind, existing) {
    const idx = { all: existing, byId: new Map(existing.map(r => [r.id, r])) };
    const many = (list, keyFn) => { const m = new Map(); for (const r of list) { const k = keyFn(r); if (k) (m.get(k) || m.set(k, []).get(k)).push(r); } return m; };
    const one = (list, keyFn) => { const m = new Map(); for (const r of list) { const k = keyFn(r); if (k && !m.has(k)) m.set(k, r); } return m; };
    idx.byName = many(existing, r => squash(r.name));
    idx.byCode = one(existing, r => lower(r.code));
    if (kind === 'items') {
        idx.byBarcode = one(existing, r => lower(r.barcode));
        idx.scan = new Map(); // a scan must lead to one item: a code or a barcode is no other item's code or barcode
        for (const r of existing) for (const k of [lower(r.code), lower(r.barcode)]) if (k && !idx.scan.has(k)) idx.scan.set(k, r);
    }
    if (kind === 'customers') { idx.byPntn = one(existing, r => r.pntn); idx.byCnic = one(existing, r => r.cnic); idx.byPhone = many(existing, r => `${squash(r.name)}|${digits(r.phone)}`); }
    if (kind === 'vendors') idx.byNtn = one(existing, r => digits(r.ntn));
    return idx;
}

// ----- items -----
function itemRow({ raw, row, name, ctx, idx, notes, bad, problems, seenKey }) {
    const code = bad(() => text(raw.code, 50, 'Item code')) || '', barcode = bad(() => text(raw.barcode, 50, 'Barcode')) || '';
    // which saved item (if any) this row is: the code, then the barcode, then (no code, no barcode) the name
    let match = null;
    const byC = code ? idx.byCode.get(lower(code)) : null, byB = barcode ? idx.byBarcode.get(lower(barcode)) : null;
    if (byC && byB && byC.id !== byB.id) problems.push(`The code "${code}" belongs to "${byC.name}" and the barcode "${barcode}" to "${byB.name}": they are two different saved items.`);
    match = byC || byB || null;
    if (!match && !code && !barcode && !problems.length) {
        const named = idx.byName.get(squash(name)) || [];
        if (named.length > 1) problems.push(`${named.length} saved items are called "${name}". Give the item code in the file so it is clear which one this is.`);
        else if (named.length === 1) match = named[0];
    }
    if (match && code && lower(match.code) !== lower(code)) notes.push(`the code "${code}" in the file is not the saved item's code (${match.code}): the saved code is kept`);
    if (!problems.length) {
        // a code or a barcode must not be another item's, whatever the other one calls it
        for (const [k, what] of [[code, 'code'], [barcode, 'barcode']]) {
            if (!k) continue;
            const other = idx.scan.get(lower(k));
            if (other && (!match || other.id !== match.id) && !(match && lower(match[what]) === lower(k))) problems.push(`The ${what} "${k}" is already the code or barcode of "${other.name}" (${other.code}). A scan has to lead to one item.`);
        }
    }
    // the rest of the cells
    const given = {};
    const put = (key, v) => { if (v !== undefined && v !== null && v !== '') given[key] = v; };
    put('category', bad(() => text(raw.category, 60, 'Category')));
    const pct = bad(() => pctCell(raw.pct, 'PCT code')), rate = bad(() => rateCell(raw.taxRate, 'Sales tax %', notes)), card = bad(() => rateCell(raw.taxRateCard, 'Sales tax % on card', notes));
    const price = bad(() => amountCell(raw.price, 'Price'));
    put('pctCode', pct); put('taxRate', rate); put('taxRateCard', card); put('unitPrice', price);
    for (const [key, what] of [['openPrice', 'Price typed on each sale'], ['taxInclusive', 'Price includes the sales tax'], ['followSchedule', 'Follows the rate schedule'], ['active', 'On sale']]) {
        const v = bad(() => yesNo(raw[key], what)); if (v !== null && v !== undefined) given[key] = v;
    }
    if (barcode) given.barcode = barcode;
    given.name = name;
    if (problems.length) return {};
    const dflt = ctx.defaults || {};
    if (!match) {
        // a NEW item: what the file leaves out is what the owner chose in Settings ("A new item starts with"), if anything
        const used = [];
        if (given.pctCode === undefined && dflt.itemPct) { given.pctCode = dflt.itemPct; used.push(`PCT code ${dflt.itemPct.slice(0, 4)}.${dflt.itemPct.slice(4)}`); }
        if (given.taxRate === undefined && dflt.itemTaxRate !== null && dflt.itemTaxRate !== undefined) {
            given.taxRate = String(dflt.itemTaxRate); used.push(`tax ${dflt.itemTaxRate}%`);
            if (given.taxRateCard === undefined && dflt.itemTaxRateCard !== null && dflt.itemTaxRateCard !== undefined) { given.taxRateCard = String(dflt.itemTaxRateCard); used.push(`card ${dflt.itemTaxRateCard}%`); }
        }
        if (given.category === undefined && dflt.itemCategory) { given.category = dflt.itemCategory; used.push(`category "${dflt.itemCategory}"`); }
        if (used.length) notes.push(`not in the file, so your defaults were used: ${used.join(', ')}`);
        let clean;
        const full = { code, barcode, name, category: given.category || '', pctCode: given.pctCode, taxRate: given.taxRate, taxRateCard: given.taxRateCard, unitPrice: given.unitPrice === undefined ? 0 : given.unitPrice, openPrice: given.openPrice === true, taxInclusive: given.taxInclusive === true, followSchedule: given.followSchedule === true, active: given.active !== false };
        if (full.pctCode === undefined) problems.push('The PCT code is empty, and no default heading is set (Settings, "A new item starts with").');
        if (full.taxRate === undefined) problems.push('The sales tax % is empty, and no default is set (Settings, "A new item starts with").');
        if (problems.length) return {};
        bad(() => { clean = V.cleanItem(full); });
        if (clean && clean.followSchedule && !(ctx.scheduled && ctx.scheduled.has(clean.pctCode))) problems.push(`The rate schedule has no rate for ${clean.pctCode.slice(0, 4)}.${clean.pctCode.slice(4)} yet, so the item cannot follow it.`);
        if (clean && !clean.openPrice && Number(clean.unitPrice) === 0) notes.push('the price is empty, so it will be 0 (the cashier cannot sell it until a price is set, or it is made an open-price item)');
        // two new rows in one file cannot share a code, a barcode or (with neither) a name
        for (const [k, what] of [[code, 'code'], [barcode, 'barcode']]) if (k) { const first = seenKey.get(lower(k)); if (first) problems.push(`The ${what} "${k}" is also used on row ${first}.`); else seenKey.set(lower(k), row); }
        if (!code && !barcode) { const first = seenKey.get(`name:${squash(name)}`); if (first) problems.push(`There is no code or barcode, and "${name}" is also on row ${first}: give each a code.`); else seenKey.set(`name:${squash(name)}`, row); }
        return problems.length ? {} : { kind: 'new', data: clean };
    }
    // a SAVED item: only what the file gives is compared; the result must still be a valid item
    const base = savedItem(match);
    let incoming = {}, merged;
    bad(() => {
        const probe = V.cleanItem({ ...base, code: match.code, ...asRaw(given) });
        for (const k of Object.keys(given)) incoming[k] = probe[k];
        merged = probe;
    });
    if (problems.length) return {};
    if (merged && merged.followSchedule && !(ctx.scheduled && ctx.scheduled.has(merged.pctCode)) && (given.followSchedule !== undefined || given.pctCode !== undefined)) problems.push(`The rate schedule has no rate for ${merged.pctCode.slice(0, 4)}.${merged.pctCode.slice(4)} yet, so the item cannot follow it.`);
    if (problems.length) return {};
    return { kind: 'update', existing: { id: match.id, name: match.name, code: match.code }, incoming, ...M.compareRecord(base, incoming, ITEM_FIELDS) };
}
// cleanItem takes the values as the form gives them: strings for numbers, booleans for flags
const asRaw = given => Object.fromEntries(Object.entries(given).map(([k, v]) => [k, v]));

// ----- customers -----
function customerRow({ raw, row, name, idx, notes, bad, problems, seenKey }) {
    const body = { name };
    for (const [k, what] of [['pntn', 'PNTN'], ['cnic', 'CNIC'], ['address', 'Address'], ['notes', 'Notes']]) body[k] = bad(() => cell(raw[k], what).trim()) || '';
    body.phone = bad(() => phoneCell(raw.phone, notes)) || '';
    const act = bad(() => yesNo(raw.active, 'In use'));
    if (act !== null && act !== undefined) body.active = act;
    let clean;
    bad(() => { clean = V.cleanCustomer(body); });
    const opening = bad(() => cleanBalanceCell(raw.openingBalance));
    const code = bad(() => text(raw.code, 20, 'Code')) || '';
    if (problems.length) return {};
    // which saved customer this is: its code, its PNTN, its CNIC, then the same name with the same phone, then (no numbers at all) the same name if only one is saved
    const hits = [];
    const add = (c, why) => { if (c && !hits.some(h => h.c.id === c.id)) hits.push({ c, why }); };
    if (code) add(idx.byCode.get(lower(code)), 'code');
    if (clean.pntn) add(idx.byPntn.get(clean.pntn), 'PNTN');
    if (clean.cnic) add(idx.byCnic.get(clean.cnic), 'CNIC');
    if (hits.length > 1) { problems.push(`The ${hits.map(h => h.why).join(' and ')} belong to different saved customers (${hits.map(h => `"${h.c.name}"`).join(', ')}).`); return {}; }
    if (!hits.length && !clean.pntn && !clean.cnic) {
        const same = (idx.byPhone.get(`${squash(name)}|${digits(clean.phone)}`) || []);
        if (same.length === 1) add(same[0], 'name and phone');
        else if (!clean.phone) { const named = idx.byName.get(squash(name)) || []; if (named.length === 1) add(named[0], 'name'); else if (named.length > 1) { problems.push(`${named.length} saved customers are called "${name}". Give their PNTN, CNIC or code so it is clear which one this is.`); return {}; } }
    }
    const match = hits[0] && hits[0].c;
    if (code && !match) notes.push(`the code "${code}" is not a saved customer: a new customer is made with the next code`);
    if (!match) {
        for (const [k, v] of [['pntn', clean.pntn], ['cnic', clean.cnic], ['code', code && lower(code)]]) if (v) { const first = seenKey.get(`${k}:${v}`); if (first) { problems.push(`The ${k.toUpperCase()} ${v} is also on row ${first}.`); return {}; } seenKey.set(`${k}:${v}`, row); }
        if (!clean.pntn && !clean.cnic) { const first = seenKey.get(`name:${squash(name)}|${digits(clean.phone)}`); if (first) { problems.push(`"${name}" with this phone is also on row ${first}.`); return {}; } seenKey.set(`name:${squash(name)}|${digits(clean.phone)}`, row); }
        return { kind: 'new', data: { ...clean, openingBalance: opening || 0 } };
    }
    if (opening) notes.push(`the opening balance in the file is not applied: ${match.name} is already saved (an opening balance is only set when a customer is added)`);
    const base = savedCustomer(match), incoming = {};
    const given = { name: clean.name, pntn: clean.pntn, cnic: clean.cnic, phone: clean.phone, address: clean.address, notes: clean.notes, ...(body.active !== undefined ? { active: body.active } : {}) };
    for (const [k, v] of Object.entries(given)) if (v !== '' && v !== undefined) incoming[k] = v;
    return { kind: 'update', existing: { id: match.id, name: match.name, code: match.code }, incoming, ...M.compareRecord(base, incoming, CUSTOMER_FIELDS) };
}
// accounts.cleanBalance works in whole paisa; a customer or vendor row keeps rupees
const cleanBalanceCell = v => { const t = cell(v, 'Opening balance').replace(/,/g, '').replace(/^rs\.?\s*/i, '').trim(); if (!t) return 0; try { return cleanBalance(t, 'Opening balance') / 100; } catch (e) { throw new Problem(e.message); } };

// ----- vendors -----
function vendorRow({ raw, row, name, idx, notes, bad, problems, seenKey }) {
    const body = { name };
    for (const [k, what] of [['ntn', 'NTN'], ['address', 'Address'], ['notes', 'Notes']]) body[k] = bad(() => cell(raw[k], what).trim()) || '';
    body.phone = bad(() => phoneCell(raw.phone, notes)) || '';
    const act = bad(() => yesNo(raw.active, 'In use'));
    if (act !== null && act !== undefined) body.active = act;
    let clean;
    bad(() => { clean = cleanVendor({ ...body, openingBalance: '' }); });
    const opening = bad(() => cleanBalanceCell(raw.openingBalance));
    const code = bad(() => text(raw.code, 20, 'Code')) || '';
    if (problems.length) return {};
    const hits = [];
    const add = (v, why) => { if (v && !hits.some(h => h.v.id === v.id)) hits.push({ v, why }); };
    if (code) add(idx.byCode.get(lower(code)), 'code');
    if (digits(clean.ntn)) add(idx.byNtn.get(digits(clean.ntn)), 'NTN');
    if (hits.length > 1) { problems.push(`The ${hits.map(h => h.why).join(' and ')} belong to different saved vendors (${hits.map(h => `"${h.v.name}"`).join(', ')}).`); return {}; }
    if (!hits.length && !digits(clean.ntn)) { const named = idx.byName.get(squash(name)) || []; if (named.length === 1) add(named[0], 'name'); else if (named.length > 1) { problems.push(`${named.length} saved vendors are called "${name}". Give their NTN or code so it is clear which one this is.`); return {}; } }
    const match = hits[0] && hits[0].v;
    if (code && !match) notes.push(`the code "${code}" is not a saved vendor: a new vendor is made with the next code`);
    if (!match) {
        for (const [k, v] of [['ntn', digits(clean.ntn)], ['code', code && lower(code)]]) if (v) { const first = seenKey.get(`${k}:${v}`); if (first) { problems.push(`The ${k.toUpperCase()} ${v} is also on row ${first}.`); return {}; } seenKey.set(`${k}:${v}`, row); }
        if (!digits(clean.ntn)) { const first = seenKey.get(`name:${squash(name)}`); if (first) { problems.push(`"${name}" is also on row ${first}: give their NTN or a code.`); return {}; } seenKey.set(`name:${squash(name)}`, row); }
        return { kind: 'new', data: { name: clean.name, ntn: clean.ntn, phone: clean.phone, address: clean.address, notes: clean.notes, active: clean.active, openingBalance: opening || 0 } };
    }
    if (opening) notes.push(`the opening balance in the file is not applied: ${match.name} is already saved (an opening balance is only set when a vendor is added)`);
    const base = savedVendor(match), incoming = {};
    const given = { name: clean.name, ntn: clean.ntn, phone: clean.phone, address: clean.address, notes: clean.notes, ...(body.active !== undefined ? { active: body.active } : {}) };
    for (const [k, v] of Object.entries(given)) if (v !== '' && v !== undefined) incoming[k] = v;
    return { kind: 'update', existing: { id: match.id, name: match.name, code: match.code }, incoming, ...M.compareRecord(base, incoming, VENDOR_FIELDS) };
}

// ---------- the service: reading what is saved, saving, undoing ----------
// The same advisory locks as the screens take (items, customers, accounts), so a code is never handed out twice; a longer time than a screen's, because a file
// of hundreds of rows is saved in one transaction (it saves all or none: a timeout leaves nothing behind).
const LOCK = { items: 'item', customers: 'customer', vendors: 'accounts' };
const digitsOnly = v => (typeof v === 'number' ? v.toFixed(4) : String(v ?? '')).replace(/\D/g, '');

function createImportService({ prisma, audit, service, accounts, rates, now = () => new Date() }) {
    const emailOf = ctx => (ctx.req && ctx.req.user && ctx.req.user.email) || ctx.email || 'user';
    const I = service.internals, A = accounts.internals;
    const kindOf = k => { if (!KINDS.includes(k)) throw new PosError(404, 'Choose items, customers or vendors.'); return k; };
    const inTurn = (ctx, kind, work) => prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${ctx.tenantId}:${LOCK[kind]}`}))`;
        return work(tx);
    }, { maxWait: 15000, timeout: 120000 });

    // what is saved, what the owner chose for a new item, and which headings the rate schedule has a rate for (every heading the file or the saved items use)
    async function load(ctx, kind, file) {
        const model = { items: prisma.posItem, customers: prisma.posCustomer, vendors: prisma.posVendor }[kind];
        const existing = await model.findMany({ where: { tenantId: ctx.tenantId }, take: 50000 });
        const out = { existing, defaults: null, scheduled: new Set() };
        if (kind === 'items') {
            const s = await service.getSettings(ctx.tenantId);
            out.defaults = { itemPct: s.itemPct, itemTaxRate: s.itemTaxRate, itemTaxRateCard: s.itemTaxRateCard, itemCategory: s.itemCategory };
            if (rates) {
                const fromFile = Array.isArray(file && file.rows) ? file.rows.map(r => digitsOnly(r && r.pct)).filter(c => c.length === 8) : [];
                out.scheduled = new Set((await rates.effective('PRA', [...new Set([...existing.map(i => i.pctCode), ...fromFile, s.itemPct].filter(Boolean))])).keys());
            }
        }
        return out;
    }
    const previewOf = (kind, d) => (kind === 'items' ? `${d.pctCode ? d.pctCode.slice(0, 4) + '.' + d.pctCode.slice(4) : ''} · ${d.taxRate}%${d.taxRateCard === null || d.taxRateCard === undefined ? '' : ` / ${d.taxRateCard}% on card`} · ${d.openPrice ? 'price on sale' : Number(d.unitPrice).toLocaleString('en-US', { minimumFractionDigits: 2 })}${d.taxInclusive ? ' incl. tax' : ''}`
        : kind === 'customers' ? [d.pntn && 'PNTN ' + d.pntn, d.cnic && 'CNIC ' + d.cnic, d.phone, d.openingBalance ? `opening ${d.openingBalance}` : ''].filter(Boolean).join(' · ')
            : [d.ntn && 'NTN ' + d.ntn, d.phone, d.openingBalance ? `opening ${d.openingBalance}` : ''].filter(Boolean).join(' · '));
    function summarize(kind, r) {
        const updates = r.ready.filter(x => x.existing);
        return {
            errors: r.errors, warnings: r.warnings, new: r.ready.length - updates.length,
            updates: updates.map(({ row, name, existing, fills, conflicts }) => ({ row, name, existing, fills, conflicts })),
            preview: r.ready.filter(x => !x.existing).slice(0, 15).map(x => ({ row: x.row, name: x.name, code: x.data.code || '', detail: previewOf(kind, x.data) })),
        };
    }
    // places on the plan an items file takes: new items that are on sale, and saved items it switches back on
    const placesNeeded = (ready, saved) => ready.filter(x => (x.kind === 'new' && x.data.active) || (x.kind === 'update' && x.incoming.active === true && saved.get(x.existing.id) && !saved.get(x.existing.id).active)).length;

    async function check(ctx, kind, file) {
        kindOf(kind);
        const c = await load(ctx, kind, file);
        const r = checkFile(kind, file || {}, c);
        if (!r.errors.length && kind === 'items') { const n = placesNeeded(r.ready, new Map(c.existing.map(e => [e.id, e]))); if (n) await I.assertItemRoom(ctx, n); } // the file must fit the plan
        return summarize(kind, r);
    }

    // ---- saving ----
    async function commit(ctx, kind, file, choices) {
        kindOf(kind);
        const c = await load(ctx, kind, file);
        const r = checkFile(kind, file || {}, c);
        if (r.errors.length) throw Object.assign(new PosError(400, 'The file has problems: check it again.'), { errors: r.errors, warnings: r.warnings });
        const fields = FIELDS[kind], toSaved = SAVED[kind], byId = new Map(c.existing.map(e => [e.id, e]));
        const adds = r.ready.filter(x => x.kind === 'new'), ups = r.ready.filter(x => x.kind === 'update');
        // the uploader's choices turn each saved record's differences into a patch; the patch must still make a valid record
        const problems = [], patches = [];
        for (const u of ups) {
            const saved = byId.get(u.existing.id), base = toSaved(saved);
            const m = M.mergeRecord(base, u.incoming, fields, choices && choices[u.row]);
            let data;
            try { data = patchData(kind, saved, base, m.patch); } catch (e) { if (e instanceof V.PosValidationError || e instanceof Problem) { problems.push({ sheet: kindSheet(kind), row: u.row, name: u.name, messages: [`with your choices: ${e.message}`] }); continue; } throw e; }
            if (kind === 'items' && (data.followSchedule !== undefined || data.pctCode !== undefined)) {
                const follows = data.followSchedule !== undefined ? data.followSchedule : saved.followSchedule, heading = data.pctCode || saved.pctCode;
                if (follows && !c.scheduled.has(heading)) { problems.push({ sheet: 'Items', row: u.row, name: u.name, messages: [`with your choices: the rate schedule has no rate for ${heading.slice(0, 4)}.${heading.slice(4)}, so the item cannot follow it`] }); continue; }
            }
            patches.push({ u, saved, base, m, data });
        }
        if (problems.length) throw Object.assign(new PosError(400, 'Some choices do not make a valid record: choose again.'), { errors: problems, warnings: r.warnings });
        if (kind === 'items') { const n = adds.filter(a => a.data.active).length + patches.filter(p => p.data.active === true && !p.saved.active).length; if (n) await I.assertItemRoom(ctx, n); }
        const batch = await inTurn(ctx, kind, tx => ({ items: runItems, customers: runCustomers, vendors: runVendors })[kind](tx, ctx, kind, file, { adds, patches }));
        const details = patches.map(p => ({ row: p.u.row, name: p.u.existing.name, message: M.mergeMessage(p.m), changed: Object.keys(p.data).length > 0 }));
        await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.import', entityType: 'PosImportBatch', entityId: batch.id, summary: `Imported ${kind} from "${String((file && file.fileName) || '').slice(0, 80)}": ${batch.added} added, ${batch.updated} changed (batch ${batch.id.slice(0, 8)})` });
        return { batchId: batch.id, added: batch.added, updated: batch.updated, details, warnings: r.warnings };
    }
    // a patch as database columns, checked as a whole record
    function patchData(kind, saved, base, patch) {
        if (!Object.keys(patch).length) return {};
        let d;
        if (kind === 'items') d = V.cleanItem({ ...base, code: saved.code, ...patch });
        // (a phone already saved that would not pass today is left as it is unless this patch sets another: the patch is checked, not the whole old record)
        else if (kind === 'customers') d = V.cleanCustomer({ ...base, ...patch }, { lenientPhone: !('phone' in patch) });
        else d = cleanVendor({ ...base, ...patch, openingBalance: '' }, { keepPhone: !('phone' in patch) });
        return Object.fromEntries(Object.keys(patch).map(k => [k, d[k]]));
    }
    const nextCodes = (first, prefix, width, count) => { const start = Number(first.slice(prefix.length)); return Array.from({ length: count }, (_, i) => prefix + String(start + i).padStart(width, '0')); };
    const record = (tx, ctx, kind, file, { addedIds, patches }) => {
        const changed = patches.filter(p => Object.keys(p.data).length);
        return tx.posImportBatch.create({
            data: {
                tenantId: ctx.tenantId, kind: KIND_NAME[kind], fileName: String((file && file.fileName) || '').slice(0, 200), createdBy: emailOf(ctx), added: addedIds.length, updated: changed.length, addedIds,
                changes: changed.map(p => ({ id: p.saved.id, name: p.saved.name, before: Object.fromEntries(Object.keys(p.data).map(k => [k, p.base[k]])), after: p.data })),
            },
        });
    };
    async function runItems(tx, ctx, kind, file, { adds, patches }) {
        // under the lock what is saved is read again, so an item added a moment ago by someone else is seen
        const saved = await tx.posItem.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, code: true, barcode: true } });
        const taken = new Map(); for (const s of saved) for (const k of [lower(s.code), lower(s.barcode)]) if (k) taken.set(k, s.id);
        for (const a of adds) for (const k of [a.data.code, a.data.barcode]) if (k && taken.has(lower(k))) throw new PosError(409, `"${k}" was just taken by another item. Check the file again.`);
        for (const p of patches) if (p.data.barcode && taken.has(lower(p.data.barcode)) && taken.get(lower(p.data.barcode)) !== p.saved.id) throw new PosError(409, `The barcode "${p.data.barcode}" was just taken by another item. Check the file again.`);
        const needCodes = adds.filter(a => !a.data.code);
        const codes = needCodes.length ? nextCodes(await I.nextItemCode(ctx.tenantId, tx), 'ITM', 4, needCodes.length) : [];
        let k = 0; const rows = adds.map(a => ({ id: crypto.randomUUID(), tenantId: ctx.tenantId, ...a.data, code: a.data.code || codes[k++], barcode: a.data.barcode || null }));
        if (rows.length) await tx.posItem.createMany({ data: rows });
        for (const p of patches) if (Object.keys(p.data).length) await tx.posItem.update({ where: { id: p.saved.id }, data: p.data });
        return record(tx, ctx, kind, file, { addedIds: rows.map(x => x.id), patches });
    }
    async function runCustomers(tx, ctx, kind, file, { adds, patches }) {
        const now_ = await tx.posCustomer.findMany({ where: { tenantId: ctx.tenantId }, select: { id: true, pntn: true, cnic: true } });
        for (const a of adds) for (const [f, what] of [['pntn', 'PNTN'], ['cnic', 'CNIC']]) if (a.data[f] && now_.some(s => s[f] === a.data[f])) throw new PosError(409, `A customer with the ${what} ${a.data[f]} was just added by someone else. Check the file again.`);
        for (const p of patches) for (const [f, what] of [['pntn', 'PNTN'], ['cnic', 'CNIC']]) if (p.data[f] && now_.some(s => s[f] === p.data[f] && s.id !== p.saved.id)) throw new PosError(409, `The ${what} ${p.data[f]} was just given to another customer. Check the file again.`);
        const codes = adds.length ? nextCodes(await I.nextCustomerCode(ctx.tenantId, tx), 'CUS', 4, adds.length) : [];
        const rows = adds.map((a, i) => ({ id: crypto.randomUUID(), tenantId: ctx.tenantId, ...a.data, code: codes[i] }));
        if (rows.length) await tx.posCustomer.createMany({ data: rows });
        for (const p of patches) if (Object.keys(p.data).length) await tx.posCustomer.update({ where: { id: p.saved.id }, data: p.data });
        return record(tx, ctx, kind, file, { addedIds: rows.map(x => x.id), patches });
    }
    async function runVendors(tx, ctx, kind, file, { adds, patches }) {
        const codes = adds.length ? nextCodes(await A.nextVendorCode(tx, ctx.tenantId), 'VEN', 4, adds.length) : [];
        const rows = adds.map((a, i) => ({ id: crypto.randomUUID(), tenantId: ctx.tenantId, ...a.data, code: codes[i] }));
        if (rows.length) await tx.posVendor.createMany({ data: rows });
        for (const p of patches) if (Object.keys(p.data).length) await tx.posVendor.update({ where: { id: p.saved.id }, data: p.data });
        return record(tx, ctx, kind, file, { addedIds: rows.map(x => x.id), patches });
    }

    // ---- history and undo ----
    const batchView = b => ({ id: b.id, kind: b.kind.toLowerCase(), fileName: b.fileName, createdBy: b.createdBy, createdAt: b.createdAt, added: b.added, updated: b.updated, undone: Boolean(b.undoneAt), undoneAt: b.undoneAt, undoneBy: b.undoneBy, undoNote: b.undoNote });
    async function history(ctx) {
        return (await prisma.posImportBatch.findMany({ where: { tenantId: ctx.tenantId }, orderBy: { createdAt: 'desc' }, take: 50 })).map(batchView);
    }
    // Undo a whole import. What it ADDED is removed, unless it has been used since (a sale, a bill, a payment), in which case it is only switched off: a record
    // that money or a tax invoice points at is never deleted. What it CHANGED is put back, field by field, unless someone has changed that field since
    // (then the newer value stays). It says exactly what it did. An import can be undone once.
    async function undo(ctx, id) {
        const b0 = await prisma.posImportBatch.findFirst({ where: { id: String(id), tenantId: ctx.tenantId } });
        if (!b0) throw new PosError(404, 'Import not found.');
        const kind = b0.kind.toLowerCase();
        const result = await inTurn(ctx, kind, async tx => {
            const b = await tx.posImportBatch.findFirst({ where: { id: b0.id } });
            if (b.undoneAt) throw new PosError(409, 'This import has already been undone.');
            const model = { items: tx.posItem, customers: tx.posCustomer, vendors: tx.posVendor }[kind];
            const used = { items: rid => tx.posSaleLine.count({ where: { itemId: rid } }), customers: async rid => (await tx.posSale.count({ where: { customerId: rid } })) + (await tx.posCashEntry.count({ where: { customerId: rid } })), vendors: async rid => (await tx.posPurchase.count({ where: { vendorId: rid } })) + (await tx.posCashEntry.count({ where: { vendorId: rid } })) }[kind];
            let removed = 0, switchedOff = 0, restored = 0, keptNewer = 0, gone = 0;
            for (const rid of b.addedIds) {
                const row = await model.findFirst({ where: { id: rid, tenantId: ctx.tenantId } });
                if (!row) { gone++; continue; }
                if (await used(rid)) { if (row.active) await model.update({ where: { id: rid }, data: { active: false } }); switchedOff++; } else { await model.delete({ where: { id: rid } }); removed++; }
            }
            const fields = FIELDS[kind], toSaved = SAVED[kind];
            for (const ch of b.changes) {
                const row = await model.findFirst({ where: { id: ch.id, tenantId: ctx.tenantId } });
                if (!row) { gone++; continue; }
                const now_ = toSaved(row), back = {}; let skipped = false;
                for (const k of Object.keys(ch.after)) {
                    const f = fields.find(x => x.key === k);
                    if (f && f.same(now_[k] ?? '', ch.after[k] ?? '') ) back[k] = ch.before[k] ?? (typeof ch.before[k] === 'boolean' ? false : null);
                    else skipped = true;
                }
                if (back.barcode) { const clash = await tx.posItem.findFirst({ where: { tenantId: ctx.tenantId, id: { not: ch.id }, OR: [{ code: ciEquals(back.barcode) }, { barcode: ciEquals(back.barcode) }] }, select: { id: true } }); if (clash) { delete back.barcode; skipped = true; } }
                if (Object.keys(back).length) { await model.update({ where: { id: ch.id }, data: normalize(kind, back) }); restored++; }
                if (skipped) keptNewer++;
            }
            const parts = [];
            if (removed) parts.push(`removed ${removed} that it added`);
            if (switchedOff) parts.push(`switched off ${switchedOff} that it added and that have been used since (they are kept)`);
            if (restored) parts.push(`put back ${restored} that it changed`);
            if (keptNewer) parts.push(`left ${keptNewer} where something it changed was changed again since`);
            if (gone) parts.push(`${gone} were already gone`);
            const note = parts.join('; ') || 'there was nothing to undo';
            await tx.posImportBatch.update({ where: { id: b.id }, data: { undoneAt: now(), undoneBy: emailOf(ctx), undoNote: note } });
            return { note, b };
        });
        await audit(ctx.req, { tenantId: ctx.tenantId, action: 'pos.import.undo', entityType: 'PosImportBatch', entityId: b0.id, summary: `Undid the import of ${kind} from "${b0.fileName}": ${result.note}`.slice(0, 480) });
        return batchView(await prisma.posImportBatch.findFirst({ where: { id: b0.id } }));
    }
    // restored values as database columns (a blank rate or barcode goes back to null)
    function normalize(kind, back) {
        const out = { ...back };
        if (kind === 'items') { for (const k of ['taxRate', 'taxRateCard', 'unitPrice']) if (k in out && out[k] !== null) out[k] = Number(out[k]); if ('barcode' in out && !out.barcode) out.barcode = null; }
        return out;
    }

    return { check, commit, history, undo };
}

module.exports = { createImportService, checkFile, COLUMNS, KINDS, MAX_ROWS, MAX_UPDATES, ITEM_FIELDS, CUSTOMER_FIELDS, VENDOR_FIELDS };
