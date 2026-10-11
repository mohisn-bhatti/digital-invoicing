// Items with tax rules from the Excel template (Items sheet + More taxes sheet). Pure: the server passes in what it
// knows (sale types, the client's items, official HS codes, FBR references) and gets back every problem at once —
// the client fixes the file and uploads again; nothing is saved while there are errors (CA).
// Rows arrive with canonical keys (the browser maps the headings): see ITEM_REQUIRED / TAX_REQUIRED below.
const { normalizeCode, HS_FORMAT } = require('./hscodes');
const { cleanExtraTaxes, SRO_REQUIRED_SALE_TYPES } = require('./tax');
const { compareRecord, ITEM_FIELDS } = require('./importMerge');

const MAX_ITEMS = 2000;
const ITEM_REQUIRED = { name: 'Item name', description: 'Item description', notes: 'Item notes', hsCode: 'HS code', uoM: 'UOM',
    p1Name: 'Price 1 name', p1Amount: 'Price 1 amount', saleType: 'Sale type', rate: 'Sales tax rate' };
const TAX_REQUIRED = { itemName: 'Item name', name: 'Tax name', kind: 'Type', value: 'Rate or Rs', fbrBox: 'FBR box' };
// FBR DI API v1.12: more taxes only in Extra Tax or FED Payable (sales tax is checked against rate × value — 0104)
const FBR_BOXES = { extratax: 'extraTax', fedpayable: 'fedPayable', fed: 'fedPayable' };

const text = v => (v === null || v === undefined ? '' : String(v).trim());
const key = v => text(v).toLowerCase().replace(/[^a-z0-9]/g, '');
const amount = v => {
    if (typeof v === 'number') return v;
    const t = text(v).replace(/,/g, '').replace(/^rs\.?\s*/i, '');
    return t === '' ? NaN : Number(t);
};
// Excel may turn 1701.9910 into the number 1701.991 — put the 4 decimals back
const hsText = v => (typeof v === 'number' ? v.toFixed(4) : text(v));
// "18%", 18 or 0.18 (a cell formatted as %) → "18%"; words like "Exempt" stay as typed
function rateText(v) {
    if (typeof v === 'number') return `${+(v > 0 && v <= 1 ? v * 100 : v).toFixed(4)}%`;
    const t = text(v);
    return /^\d+(\.\d+)?$/.test(t) ? `${t}%` : t;
}

/**
 * @param {{ itemHeaders: string[], items: object[], taxHeaders?: string[], taxes?: object[] }} file
 * An item already saved (same name, or same HS code + sale type) is not an error: its row comes back with the saved
 * item's id, what the file fills in (fills) and where the two differ (conflicts) — the uploader chooses, see importMerge.
 * @param {{ saleTypes: string[], existing: {id,name,hsCode,saleType,…}[], officialCodes: Set<string>, findRef: (t:string)=>object|null }} ctx
 * @returns {{ errors: {sheet,row,name,messages}[], warnings: {sheet,row,name,messages}[], ready: {row,item,rule,existing?,fills?,conflicts?}[] }}
 */
function checkImport(file, ctx) {
    const errors = [], warnings = [], ready = [];
    const fileError = msg => errors.push({ sheet: 'File', row: null, name: '', messages: [msg] });
    const items = Array.isArray(file?.items) ? file.items : [];
    const taxes = Array.isArray(file?.taxes) ? file.taxes : [];

    const itemHeaders = new Set(file?.itemHeaders || []);
    const missingCols = Object.entries(ITEM_REQUIRED).filter(([k]) => !itemHeaders.has(k)).map(([, l]) => `"${l}"`);
    if (missingCols.length) fileError(`Column${missingCols.length > 1 ? 's' : ''} ${missingCols.join(', ')} not found on the Items sheet — please use the template.`);
    if (taxes.length) {
        const taxHeaders = new Set(file?.taxHeaders || []);
        const missingTax = Object.entries(TAX_REQUIRED).filter(([k]) => !taxHeaders.has(k)).map(([, l]) => `"${l}"`);
        if (missingTax.length) fileError(`Column${missingTax.length > 1 ? 's' : ''} ${missingTax.join(', ')} not found on the More taxes sheet — please use the template.`);
    }
    if (!items.length) fileError('The Items sheet has no items — fill at least one row under the headings.');
    if (items.length > MAX_ITEMS) fileError(`At most ${MAX_ITEMS} items per file (this file has ${items.length}).`);
    if (errors.length) return { errors, warnings, ready };

    const saleTypes = new Map(ctx.saleTypes.map(s => [key(s), s]));
    const existingName = new Map(ctx.existing.map(p => [key(p.name), p]));
    const existingPair = new Map(ctx.existing.filter(p => p.saleType).map(p => [`${p.hsCode}|${key(p.saleType)}`, p]));
    const seenName = new Map(), seenPair = new Map();
    const refsOf = v => text(v).split(';').map(text).filter(Boolean).slice(0, 20)
        .map(t => ctx.findRef(t) || { reference: t.slice(0, 200), url: '', source: '' });

    // ---- Items sheet
    const byName = new Map(); // item name (key) → { entry, rowNo }
    for (const r of items) {
        const row = Number(r.row) || null, msgs = [];
        const name = text(r.name);
        for (const [k, label] of Object.entries({ name: 'Item name', description: 'Item description', notes: 'Item notes', uoM: 'UOM' })) {
            if (!text(r[k])) msgs.push(`${label} ${k === 'notes' ? 'are' : 'is'} missing`);
        }
        if (name.length > 200) msgs.push('Item name is longer than 200 characters');
        if (text(r.description).length > 500) msgs.push('Item description is longer than 500 characters');
        if (text(r.notes).length > 1000) msgs.push('Item notes are longer than 1000 characters');

        const hsRaw = hsText(r.hsCode), hsCode = normalizeCode(hsRaw);
        if (!hsRaw) msgs.push('HS code is missing');
        else if (!HS_FORMAT.test(hsCode)) msgs.push(`HS code "${hsRaw}" should look like 0101.2100 (8 digits)`);

        // Prices: Price N name + Price N amount, any number of pairs; at least one
        const prices = [];
        const nums = [...new Set(Object.keys(r).map(k => (/^p(\d+)(Name|Amount)$/.exec(k) || [])[1]).filter(Boolean).map(Number))].sort((a, b) => a - b);
        for (const n of nums) {
            const label = text(r[`p${n}Name`]), raw = r[`p${n}Amount`], hasAmount = text(raw) !== '';
            if (!label && !hasAmount) continue;
            if (!label) { msgs.push(`Price ${n} has an amount but no name`); continue; }
            if (!hasAmount) { msgs.push(`Price ${n} ("${label}") has a name but no amount`); continue; }
            const a = amount(raw);
            if (!Number.isFinite(a) || a < 0) { msgs.push(`Price ${n} ("${label}") amount "${text(raw)}" is not a number of 0 or more`); continue; }
            prices.push({ label: label.slice(0, 40), price: Math.round(a * 100) / 100 });
        }
        if (!prices.length && !msgs.some(m => m.startsWith('Price'))) msgs.push('At least one price is required (Price 1 name and Price 1 amount)');

        const saleTypeRaw = text(r.saleType), saleType = saleTypes.get(key(saleTypeRaw));
        if (!saleTypeRaw) msgs.push('Sale type is missing');
        else if (!saleType) msgs.push(`Sale type "${saleTypeRaw}" is not in the list — copy one from the Lists sheet`);
        const rate = rateText(r.rate);
        if (!rate) msgs.push('Sales tax rate is missing');

        // References are optional (a record of the law read); FBR gets the SRO / Schedule no. (0077) — its own
        // column, else the first reference
        const lawRefs = refsOf(r.refs);
        const sroNo = (text(r.sro) || lawRefs[0]?.reference || '').slice(0, 100);
        if (saleType && SRO_REQUIRED_SALE_TYPES.has(saleType) && !sroNo) msgs.push(`"${saleType}" needs the SRO / Schedule no. (FBR rule 0077)`);
        // FBR DI API v1.12: item serial for exempt / reduced / SRO lines (0078); retail price for 3rd schedule (0090)
        const serial = text(r.serial).slice(0, 50);
        if (saleType && SRO_REQUIRED_SALE_TYPES.has(saleType) && !serial) msgs.push(`"${saleType}" needs the Item serial no. (FBR rule 0078)`);
        const retail = text(r.retail) === '' ? null : amount(r.retail);
        if (saleType === '3rd Schedule Goods' && !(retail > 0)) msgs.push('3rd schedule goods need the Retail price per unit (FBR rule 0090)');
        else if (retail !== null && !(retail > 0)) msgs.push(`Retail price per unit "${text(r.retail)}" is not a number above 0`);

        // Twice in the file: item name, or HS code + sale type (the same code with another sale type is fine).
        // Already saved (same name, else same HS code + sale type): that item is updated, not added
        let match = null, byPair = false;
        if (name) {
            const k = key(name);
            if (seenName.has(k)) msgs.push(`The item name is also on row ${seenName.get(k)}`);
            else seenName.set(k, row);
            match = existingName.get(k) || null;
        }
        if (HS_FORMAT.test(hsCode) && saleType) {
            const k = `${hsCode}|${key(saleType)}`, other = existingPair.get(k);
            if (seenPair.has(k)) msgs.push(`HS code ${hsCode} with sale type "${saleType}" is also on row ${seenPair.get(k)}`);
            else seenPair.set(k, row);
            if (other && match && other !== match) msgs.push(`HS code ${hsCode} with sale type "${saleType}" is already used by your item "${other.name}"`);
            else if (other && !match) { match = other; byPair = true; }
        }
        if (HS_FORMAT.test(hsCode) && ctx.officialCodes && !ctx.officialCodes.has(hsCode)) {
            warnings.push({ sheet: 'Items', row, name, messages: [`HS code ${hsCode} is not in the FBR list — it will be saved as a code created by you`] });
        }

        const entry = { row, name, msgs, extra: [], match, byPair,
            item: { name, description: text(r.description), notes: text(r.notes), hsCode, uoM: text(r.uoM), prices },
            rule: { saleType: saleType || saleTypeRaw, rate, lawRefs, taxComment: text(r.comment).slice(0, 2000), sroItemSerialNo: serial,
                ...(sroNo && { sroScheduleNo: sroNo }),
                notifiedRate: saleType === '3rd Schedule Goods' && retail > 0 ? Math.round(retail * 100) / 100 : '' } };
        if (name && !byName.has(key(name))) byName.set(key(name), entry);
        errors.push({ sheet: 'Items', row, name, messages: msgs }); // emptied later if clean
        ready.push(entry);
    }

    // ---- More taxes sheet: rows attach to their item, in sheet order
    for (const t of taxes) {
        const row = Number(t.row) || null, msgs = [];
        const itemName = text(t.itemName), name = text(t.name);
        const owner = byName.get(key(itemName));
        if (!itemName) msgs.push('Item name is missing');
        else if (!owner) msgs.push(`Item "${itemName}" is not on the Items sheet`);
        if (!name) msgs.push('Tax name is missing');
        const kindKey = key(t.kind);
        const kind = text(t.kind) === '%' || ['pct', 'percent', 'percentage'].includes(kindKey) ? 'PCT'
            : ['fixed', 'fixedrs', 'rs', 'amount'].includes(kindKey) ? 'FIXED' : null;
        if (!text(t.kind)) msgs.push('Type is missing (% or Fixed Rs)');
        else if (!kind) msgs.push(`Type "${text(t.kind)}" should be % or Fixed Rs`);
        const value = amount(t.value);
        if (text(t.value) === '') msgs.push('Rate or Rs is missing');
        else if (!Number.isFinite(value) || value < 0) msgs.push(`Rate or Rs "${text(t.value)}" is not a number of 0 or more`);
        const fbrField = FBR_BOXES[key(t.fbrBox)];
        if (!text(t.fbrBox)) msgs.push('FBR box is missing (Extra Tax or FED Payable)');
        else if (!fbrField) msgs.push(`FBR box "${text(t.fbrBox)}" should be Extra Tax or FED Payable (FBR checks sales tax against the rate)`);

        // Apply on: "Value before tax + Sales tax amount + Withholding" → VALUE+SALES_TAX+TAX:0 (taxes above, same item)
        let base = '';
        if (kind === 'PCT') {
            const parts = text(t.applyOn).split('+').map(text).filter(Boolean);
            if (!parts.length) msgs.push('Apply on is missing (Value before tax, Sales tax amount, or a tax above it)');
            const codes = [];
            for (const part of parts) {
                const k = key(part);
                if (['valuebeforetax', 'value', 'valuebefore'].includes(k)) codes.push('VALUE');
                else if (['salestaxamount', 'salestax'].includes(k)) codes.push('SALES_TAX');
                else if (['valueaftertax', 'valueafter'].includes(k)) codes.push('VALUE', 'SALES_TAX');
                else {
                    const i = owner ? owner.extra.findIndex(x => key(x.name) === key(part.replace(/^on\s+/i, '').replace(/^"|"$/g, ''))) : -1;
                    if (i >= 0) codes.push(`TAX:${i}`);
                    else msgs.push(`Apply on names "${part}", which is not a tax above it for this item`);
                }
            }
            base = [...new Set(codes)].join('+');
        }
        if (owner && owner.extra.length >= 10) msgs.push(`Item "${itemName}" already has 10 more taxes — that is the most allowed`);

        const def = { name, kind: kind || 'PCT', value, base, fbrField: fbrField || 'extraTax', refs: refsOf(t.refs).map(({ reference, url, source }) => ({ reference, url, source })), comment: text(t.comment).slice(0, 2000) };
        if (msgs.length) errors.push({ sheet: 'More taxes', row, name: name || itemName, messages: msgs });
        else if (owner) owner.extra.push(def);
    }

    // Final check of each item's more taxes with the same rules as the screen
    for (const e of ready) {
        try { e.rule.extraTaxes = cleanExtraTaxes(e.extra, 'More taxes'); }
        catch (err) { e.msgs.push(err.message); e.rule.extraTaxes = []; }
    }

    return {
        errors: errors.filter(x => x.messages.length),
        warnings,
        ready: ready.filter(e => !e.msgs.length).map(({ row, item, rule, match, byPair }) => {
            if (!match) return { row, item, rule };
            const incoming = { ...item, ...rule };
            if (!byPair) delete incoming.name; // matched by its name: the name is the same
            return { row, item, rule, existing: { id: match.id, name: match.name }, ...compareRecord(savedItem(match), incoming, ITEM_FIELDS) };
        }),
    };
}

// A saved item in the shape of a file row (older items may have one unitPrice instead of prices)
function savedItem(p) {
    const prices = Array.isArray(p.prices) && p.prices.length ? p.prices : p.unitPrice != null ? [{ label: 'Price', price: Number(p.unitPrice) }] : [];
    return { ...p, prices, lawRefs: Array.isArray(p.lawRefs) ? p.lawRefs : [], extraTaxes: Array.isArray(p.extraTaxes) ? p.extraTaxes : [] };
}

module.exports = { savedItem, checkImport, MAX_ITEMS, ITEM_REQUIRED, TAX_REQUIRED };
