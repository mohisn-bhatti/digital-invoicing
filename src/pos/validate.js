// Point of Sale input checks. Field sizes and formats follow PRA's invoice model (PRAL POS Component manual v1.0,
// section 6): BuyerPNTN varchar(9) "1234567-8", BuyerCNIC varchar(13), BuyerPhoneNumber varchar(20), ItemCode varchar(50),
// ItemName varchar(150), PCTCode varchar(8).
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
function cleanBuyer(b) {
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
    let phone = String(b.phone || '').trim();
    if (phone) {
        const d = digitsOf(phone);
        if (!SEPARATORS.phone.test(phone) || d.length < 7 || d.length > 20) throw new PosValidationError('Buyer phone number must be 7 to 20 digits.');
        phone = d;
    }
    return { name, pntn, cnic, phone };
}

// A saved customer: the buyer's details, in PRA's formats, plus an address and a note. The name is required.
function cleanCustomer(c) {
    c = isObject(c) ? c : {};
    const b = cleanBuyer(c);
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

module.exports = { PosValidationError, cleanBuyer, cleanCustomer, cleanPct, cleanItem, cleanPaymentMode, cleanProfile, cleanBranch, cleanCounter, cleanToken };
