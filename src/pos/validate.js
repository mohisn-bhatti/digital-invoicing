// Point of Sale input checks. Field sizes and formats follow PRA's invoice model (PRAL POS Component manual v1.0,
// section 6): BuyerPNTN varchar(9) "1234567-8", BuyerCNIC varchar(13), BuyerPhoneNumber varchar(20), ItemCode varchar(50),
// ItemName varchar(150), PCTCode varchar(8).
const { phoneProblem, phoneDigits } = require('./calc');
class PosValidationError extends Error {}

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const digitsOf = v => String(v === undefined || v === null ? '' : v).replace(/\D/g, '');
// Free text: control characters are dropped (a NUL byte makes the database refuse the row), runs of white space become one space
const text = (v, max, what) => {
    const s = String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
    if (s.length > max) throw new PosValidationError(`${what} is too long (${max} characters at most).`);
    return s;
};
// A number written with its usual separators only: digits, and the spaces, dashes, dots, brackets and leading + people type
const SEPARATORS = { id: /^[\d\s-]+$/, phone: /^\+?[\d\s()-]+$/ };
const num = (v, what, { min = 0, max, decimals = 2 } = {}) => {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!/^\d+(\.\d+)?$/.test(s)) throw new PosValidationError(`${what} must be a number.`);
    const n = Number(s);
    if (n < min) throw new PosValidationError(`${what} cannot be less than ${min}.`);
    if (max !== undefined && n > max) throw new PosValidationError(`${what} cannot be more than ${max}.`);
    if ((s.split('.')[1] || '').length > decimals) throw new PosValidationError(`${what} can have ${decimals} decimal places at most.`);
    return n;
};

// Buyer details are optional; when given they must be in PRA's format
// lenientPhone: for a number that is already stored (a saved customer's): one that no longer passes is left off the invoice instead of stopping the sale
function cleanBuyer(b, { lenientPhone = false } = {}) {
    b = isObject(b) ? b : {};
    const name = text(b.name, 150, 'Buyer name');
    let pntn = String(b.pntn || '').trim();
    if (pntn) {
        const d = digitsOf(pntn);
        if (!SEPARATORS.id.test(pntn) || d.length !== 8) throw new PosValidationError('Buyer PNTN must be 8 digits, like 1234567-8.');
        pntn = `${d.slice(0, 7)}-${d.slice(7)}`;
    }
    let cnic = String(b.cnic || '').trim();
    if (cnic) {
        const d = digitsOf(cnic);
        if (!SEPARATORS.id.test(cnic) || d.length !== 13) throw new PosValidationError('Buyer CNIC must be 13 digits.');
        cnic = d;
    }
    const phoneIssue = phoneProblem(b.phone);
    if (phoneIssue && !lenientPhone) throw new PosValidationError(`Buyer phone number: ${phoneIssue}.`);
    const phone = phoneIssue ? '' : phoneDigits(b.phone);
    return { name, pntn, cnic, phone };
}

// A saved customer: the buyer's details, in PRA's formats, plus an address and a note. The name is required.
function cleanCustomer(c, opts) {
    c = isObject(c) ? c : {};
    const b = cleanBuyer(c, opts);
    if (!b.name) throw new PosValidationError('Enter the customer name.');
    return { ...b, address: text(c.address, 250, 'Address'), notes: text(c.notes, 300, 'Notes'), active: c.active === undefined ? true : c.active === true || c.active === 'true' };
}

// PCT / HS code of the service (Second Schedule): PRA wants 8 characters, no dot (9801.2000 → 98012000)
function cleanPct(v) {
    const d = digitsOf(v);
    if (d.length !== 8) throw new PosValidationError('The PCT code must be 8 digits, like 9801.2000 for restaurants.');
    return d;
}

function cleanItem(i) {
    i = isObject(i) ? i : {};
    const code = text(i.code, 50, 'Item code');
    if (code && !/^[A-Za-z0-9._\-\/]+$/.test(code)) throw new PosValidationError('Item code can use letters, numbers and . _ - / only.');
    const name = text(i.name, 150, 'Item name');
    if (!name) throw new PosValidationError('Enter the item name.');
    const barcode = text(i.barcode, 50, 'Barcode');
    if (barcode && !/^[A-Za-z0-9._\-\/]+$/.test(barcode)) throw new PosValidationError('A barcode can use letters, numbers and . _ - / only.');
    const hasCard = i.taxRateCard !== undefined && i.taxRateCard !== null && String(i.taxRateCard).trim() !== '';
    return {
        code, name,
        barcode: barcode || null, // nothing typed = no barcode (the code is what is scanned)
        category: text(i.category, 60, 'Category'),
        pctCode: cleanPct(i.pctCode),
        taxRate: num(i.taxRate, 'Tax rate', { max: 100 }),
        taxRateCard: hasCard ? num(i.taxRateCard, 'Tax rate on card payments', { max: 100 }) : null,
        unitPrice: num(i.unitPrice === undefined || String(i.unitPrice).trim() === '' ? 0 : i.unitPrice, 'Price', { max: 99999999.99 }),
        openPrice: i.openPrice === true || i.openPrice === 'true',
        taxInclusive: i.taxInclusive === true || i.taxInclusive === 'true',
        followSchedule: i.followSchedule === true || i.followSchedule === 'true',
        active: i.active === undefined ? true : i.active === true || i.active === 'true',
    };
}

function cleanPaymentMode(v) {
    const n = typeof v === 'number' || (typeof v === 'string' && /^\s*\d{1,2}\s*$/.test(v)) ? Number(v) : NaN; // a number, not true or [1]
    if (!Number.isInteger(n) || n < 1 || n > 6) throw new PosValidationError('Choose how the sale was paid.');
    return n;
}

function cleanProfile(p) {
    p = isObject(p) ? p : {};
    const pntn = text(p.pntn, 20, 'PNTN / NTN');
    if (pntn && !/^\d[\d-]{5,18}\d$/.test(pntn)) throw new PosValidationError('The PNTN / NTN is made of digits (and a dash), like 1234567-8.');
    return {
        businessName: text(p.businessName, 150, 'Business name'),
        pntn,
        address: text(p.address, 250, 'Address'),
        phone: text(p.phone, 30, 'Phone'),
        receiptFooter: text(p.receiptFooter, 200, 'Receipt footer'),
    };
}

// What the account owner sets once for the whole business: how a new sale starts, how the receipt looks, and what a new item starts
// with (a convenience for the item form: an item is still checked in full when it is saved). A field that is not sent keeps its stored
// value (`current`), so one thing can be changed without knowing the rest.
const RECEIPT_WIDTHS = [58, 80]; // millimetres: the two common thermal rolls
const flag = (v, what) => {
    if (v === true || v === 'true') return true;
    if (v === false || v === 'false') return false;
    throw new PosValidationError(`${what} must be yes or no.`);
};
const optionalRate = (v, what) => (v === null || String(v).trim() === '' ? null : num(v, what, { max: 100 }));
function cleanSettings(s, current = {}) {
    s = isObject(s) ? s : {};
    const pick = (key, clean) => (s[key] === undefined ? current[key] : clean(s[key]));
    return {
        defaultPaymentMode: pick('defaultPaymentMode', v => {
            const n = typeof v === 'number' || (typeof v === 'string' && /^\s*\d{1,2}\s*$/.test(v)) ? Number(v) : NaN;
            if (!Number.isInteger(n) || n < 1 || n > 6) throw new PosValidationError('Choose how a new sale starts: cash, card, gift voucher, loyalty card, mixed or cheque.');
            return n;
        }),
        receiptHeader: pick('receiptHeader', v => text(v, 120, 'Receipt header')),
        receiptWidth: pick('receiptWidth', v => {
            const n = typeof v === 'number' || (typeof v === 'string' && /^\s*\d{2}\s*$/.test(v)) ? Number(v) : NaN;
            if (!RECEIPT_WIDTHS.includes(n)) throw new PosValidationError(`The receipt paper is ${RECEIPT_WIDTHS.join(' mm or ')} mm wide.`);
            return n;
        }),
        showCashier: pick('showCashier', v => flag(v, 'Showing the cashier on the receipt')),
        itemPct: pick('itemPct', v => (String(v === undefined || v === null ? '' : v).trim() === '' ? '' : cleanPct(v))),
        itemTaxRate: pick('itemTaxRate', v => optionalRate(v, 'The sales tax for new items')),
        itemTaxRateCard: pick('itemTaxRateCard', v => optionalRate(v, 'The sales tax on card payments for new items')),
        itemCategory: pick('itemCategory', v => text(v, 60, 'Category')),
        retentionYears: pick('retentionYears', cleanRetention),
    };
}

// The business logo for the receipt: a small PNG or JPEG sent as a data: address. What is checked is the file itself, not what it claims to be
// (its first bytes must be a PNG's or a JPEG's), its size, and a PNG's own width and height; SVG is refused because it can carry script.
const LOGO_MAX_BYTES = 150 * 1024, LOGO_MAX_SIDE = 2000;
function cleanLogo(v) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(s);
    if (!m) throw new PosValidationError('The logo must be a PNG or JPEG picture.');
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > LOGO_MAX_BYTES) throw new PosValidationError(`The logo is too big (${Math.ceil(LOGO_MAX_BYTES / 1024)} KB at most). Use a smaller picture.`);
    const png = bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (m[1] === 'png' ? !png : !jpeg) throw new PosValidationError('That file is not a real PNG or JPEG picture.');
    if (png && (bytes.readUInt32BE(16) > LOGO_MAX_SIDE || bytes.readUInt32BE(20) > LOGO_MAX_SIDE || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20))) throw new PosValidationError(`The logo can be ${LOGO_MAX_SIDE} pixels wide or high at most.`);
    return `data:image/${m[1]};base64,${bytes.toString('base64')}`;
}

// How long records are kept before they may be archived (years); the law's period is for the owner to confirm with the CA
const RETENTION_MIN = 1, RETENTION_MAX = 30;
function cleanRetention(v) {
    const n = typeof v === 'number' || (typeof v === 'string' && /^\s*\d{1,2}\s*$/.test(v)) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < RETENTION_MIN || n > RETENTION_MAX) throw new PosValidationError(`Records are kept for ${RETENTION_MIN} to ${RETENTION_MAX} years.`);
    return n;
}

function cleanBranch(b) {
    b = isObject(b) ? b : {};
    const name = text(b.name, 80, 'Branch name');
    if (!name) throw new PosValidationError('Enter the branch name.');
    return { name, address: text(b.address, 250, 'Branch address'), city: text(b.city, 60, 'City'), phone: text(b.phone, 30, 'Phone') };
}

// POS ID: PRA's registration number for the counter (bigint)
function cleanCounter(c) {
    c = isObject(c) ? c : {};
    const name = text(c.name, 60, 'Counter name');
    if (!name) throw new PosValidationError('Enter the counter name.');
    const posId = String(c.posId === undefined || c.posId === null ? '' : c.posId).trim();
    if (!/^\d{1,15}$/.test(posId) || /^0+$/.test(posId)) throw new PosValidationError('Enter the POS ID PRA gave this counter (digits only, up to 15).');
    if (c.env !== undefined && c.env !== 'SANDBOX' && c.env !== 'PRODUCTION') throw new PosValidationError('Choose Sandbox or Production for the environment.');
    return { name, posId: posId.replace(/^0+/, ''), env: c.env === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX' };
}

// The Bearer token PRA shows on the POS registration screen
function cleanToken(v) {
    const t = String(v === undefined || v === null ? '' : v).trim();
    if (t.length < 16 || t.length > 4096 || /\s/.test(t)) throw new PosValidationError('This does not look like a PRA token: copy the token shown for this POS ID on the PRA portal.');
    return t;
}

module.exports = { PosValidationError, phoneProblem, phoneDigits, isObject, digitsOf, text, num, RECEIPT_WIDTHS, cleanBuyer, cleanCustomer, cleanLogo, cleanRetention, LOGO_MAX_BYTES, cleanPct, cleanItem, cleanPaymentMode, cleanProfile, cleanSettings, cleanBranch, cleanCounter, cleanToken };
