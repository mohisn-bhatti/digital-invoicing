// Excel import onto records that already exist (buyers, items with tax rules). Pure: compares a saved record with
// the file's row field by field.
//  - the file has a value and the saved record is empty → filled in automatically ("updated the missing")
//  - both have values and they differ → a conflict; the uploader chooses which one to keep (saved or file)
//  - the file is empty → the saved value stays
const blank = v => v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
const squash = v => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

// Field kinds: how two values are compared and shown
const kinds = {
    text: { same: (a, b) => squash(a) === squash(b), show: v => String(v ?? '') },
    digits: { same: (a, b) => String(a).replace(/\D/g, '') === String(b).replace(/\D/g, ''), show: v => String(v ?? '') },
    // 03001234567 and +923001234567 are the same number
    mobile: { same: (a, b) => { const n = v => String(v).replace(/\D/g, '').replace(/^92(?=3\d{9}$)/, '0'); return n(a) === n(b); }, show: v => String(v ?? '') },
    amount: { same: (a, b) => Number(a) === Number(b), show: v => String(v ?? '') },
    prices: {
        same: (a, b) => JSON.stringify(a.map(x => [squash(x.label), Number(x.price)])) === JSON.stringify(b.map(x => [squash(x.label), Number(x.price)])),
        show: v => (v || []).map(x => `${x.label} ${Number(x.price).toLocaleString('en-US')}`).join(' · '),
    },
    refs: {
        same: (a, b) => JSON.stringify(a.map(x => squash(x.reference))) === JSON.stringify(b.map(x => squash(x.reference))),
        show: v => (v || []).map(x => x.reference).join('; '),
    },
    taxes: {
        same: (a, b) => { const k = l => JSON.stringify(l.map(t => [squash(t.name), t.kind, Number(t.value), t.base || '', t.fbrField])); return k(a) === k(b); },
        show: v => (v || []).map(t => `${t.name} ${t.kind === 'FIXED' ? `Rs ${t.value}` : `${t.value}%`} (${t.fbrField === 'fedPayable' ? 'FED Payable' : 'Extra Tax'})`).join(' · '),
    },
};
const field = (key, label, kind = 'text') => ({ key, label, ...kinds[kind] });

const BUYER_FIELDS = [
    field('businessName', 'Name'), field('ntn', 'NTN', 'digits'), field('cnic', 'CNIC', 'digits'), field('strn', 'STRN', 'digits'),
    field('registrationType', 'Registered / Unregistered'), field('province', 'Province'), field('address', 'Address'),
    field('mobile', 'Mobile number', 'mobile'), field('email', 'Email'), field('note', 'Additional note'),
];
// Item fields, then its tax rule (RULE_KEYS) — a changed rule is saved as a new entry in the item's tax rule history
const ITEM_FIELDS = [
    field('name', 'Item name'), field('description', 'Item description'), field('notes', 'Item notes'), field('hsCode', 'HS code'),
    field('uoM', 'UOM'), field('prices', 'Prices', 'prices'), field('saleType', 'Sale type'), field('rate', 'Sales tax rate'),
    field('sroScheduleNo', 'SRO / Schedule no.'), field('lawRefs', 'Sales tax references', 'refs'), field('taxComment', 'Sales tax comment'), field('sroItemSerialNo', 'Item serial no.'),
    field('notifiedRate', 'Retail price per unit', 'amount'), field('extraTaxes', 'More taxes', 'taxes'),
];
const RULE_KEYS = new Set(['saleType', 'rate', 'sroScheduleNo', 'lawRefs', 'taxComment', 'sroItemSerialNo', 'notifiedRate', 'extraTaxes']);

/** → { fills: [{field,label,file}], conflicts: [{field,label,saved,file}] } */
function compareRecord(saved, incoming, fields) {
    const fills = [], conflicts = [];
    for (const f of fields) {
        if (!(f.key in incoming)) continue;
        const a = saved[f.key], b = incoming[f.key];
        if (blank(b)) continue;
        if (blank(a)) fills.push({ field: f.key, label: f.label, file: f.show(b) });
        else if (!f.same(a, b)) conflicts.push({ field: f.key, label: f.label, saved: f.show(a), file: f.show(b) });
    }
    return { fills, conflicts };
}

/**
 * choice: { [field]: 'file' | 'saved' } for the conflicts; a conflict without a choice keeps the saved value.
 * → { patch (the fields to change), filled, fromFile, keptSaved (labels) }
 */
function mergeRecord(saved, incoming, fields, choice = {}) {
    const { fills, conflicts } = compareRecord(saved, incoming, fields);
    const patch = {}, filled = [], fromFile = [], keptSaved = [];
    for (const f of fills) { patch[f.field] = incoming[f.field]; filled.push(f.label); }
    for (const c of conflicts) {
        if (choice?.[c.field] === 'file') { patch[c.field] = incoming[c.field]; fromFile.push(c.label); }
        else keptSaved.push(c.label);
    }
    return { patch, filled, fromFile, keptSaved };
}

// One line for the result list: "already exists — updated the missing: Mobile number, Email; used the file's: Address"
function mergeMessage({ filled, fromFile, keptSaved }) {
    const parts = [];
    if (filled.length) parts.push(`updated the missing: ${filled.join(', ')}`);
    if (fromFile.length) parts.push(`used the file's: ${fromFile.join(', ')}`);
    if (keptSaved.length) parts.push(`kept the saved: ${keptSaved.join(', ')}`);
    return `already exists — ${parts.join('; ') || 'nothing new in the file'}`;
}

// What changed between two versions of a record (for the change history): [{ field, label, from, to }]
function diffRecord(before, after, fields) {
    const out = [];
    for (const f of fields) {
        const a = before?.[f.key], b = after?.[f.key];
        if (blank(a) && blank(b)) continue;
        if (blank(a) !== blank(b) || !f.same(a, b)) out.push({ field: f.key, label: f.label, from: blank(a) ? '' : f.show(a), to: blank(b) ? '' : f.show(b) });
    }
    return out;
}

module.exports = { diffRecord, compareRecord, mergeRecord, mergeMessage, BUYER_FIELDS, ITEM_FIELDS, RULE_KEYS, blank };
