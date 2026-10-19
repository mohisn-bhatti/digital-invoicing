// Point of Sale input checks. Field sizes and formats follow PRA's invoice model (PRAL POS Component manual v1.0,
// section 6): BuyerPNTN varchar(9) "1234567-8", BuyerCNIC varchar(13), BuyerPhoneNumber varchar(20), ItemCode varchar(50),
// ItemName varchar(150), PCTCode varchar(8).
class PosValidationError extends Error {}

const digitsOf = v => String(v === undefined || v === null ? '' : v).replace(/\D/g, '');
const text = (v, max, what) => {
    const s = String(v === undefined || v === null ? '' : v).trim().replace(/\s+/g, ' ');
    if (s.length > max) throw new PosValidationError(`${what} is too long (${max} characters at most).`);
    return s;
};
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
function cleanBuyer(b = {}) {
    const name = text(b.name, 150, 'Buyer name');
    let pntn = String(b.pntn || '').trim();
    if (pntn) {
        const d = digitsOf(pntn);
        if (d.length !== 8) throw new PosValidationError('Buyer PNTN must be 8 digits, like 1234567-8.');
        pntn = `${d.slice(0, 7)}-${d.slice(7)}`;
    }
    let cnic = String(b.cnic || '').trim();
    if (cnic) {
        const d = digitsOf(cnic);
        if (d.length !== 13) throw new PosValidationError('Buyer CNIC must be 13 digits.');
        cnic = d;
    }
    let phone = String(b.phone || '').trim();
    if (phone) {
        const d = digitsOf(phone);
        if (d.length < 7 || d.length > 20) throw new PosValidationError('Buyer phone number must be 7 to 20 digits.');
        phone = d;
    }
    return { name, pntn, cnic, phone };
}

// PCT / HS code of the service (Second Schedule): PRA wants 8 characters, no dot (9801.2000 → 98012000)
function cleanPct(v) {
    const d = digitsOf(v);
    if (d.length !== 8) throw new PosValidationError('The PCT code must be 8 digits, like 9801.2000 for restaurants.');
    return d;
}

function cleanItem(i = {}) {
    const code = text(i.code, 50, 'Item code');
    if (code && !/^[A-Za-z0-9._\-\/]+$/.test(code)) throw new PosValidationError('Item code can use letters, numbers and . _ - / only.');
    const name = text(i.name, 150, 'Item name');
    if (!name) throw new PosValidationError('Enter the item name.');
    const hasCard = i.taxRateCard !== undefined && i.taxRateCard !== null && String(i.taxRateCard).trim() !== '';
    return {
        code, name,
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
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 6) throw new PosValidationError('Choose how the sale was paid.');
    return n;
}

function cleanProfile(p = {}) {
    return {
        businessName: text(p.businessName, 150, 'Business name'),
        pntn: text(p.pntn, 20, 'PNTN / NTN'),
        address: text(p.address, 250, 'Address'),
        phone: text(p.phone, 30, 'Phone'),
        receiptFooter: text(p.receiptFooter, 200, 'Receipt footer'),
    };
}

function cleanBranch(b = {}) {
    const name = text(b.name, 80, 'Branch name');
    if (!name) throw new PosValidationError('Enter the branch name.');
    return { name, address: text(b.address, 250, 'Branch address'), city: text(b.city, 60, 'City'), phone: text(b.phone, 30, 'Phone') };
}

// POS ID: PRA's registration number for the counter (bigint)
function cleanCounter(c = {}) {
    const name = text(c.name, 60, 'Counter name');
    if (!name) throw new PosValidationError('Enter the counter name.');
    const posId = digitsOf(c.posId);
    if (posId.length < 1 || posId.length > 15 || /^0+$/.test(posId)) throw new PosValidationError('Enter the POS ID PRA gave this counter (digits only).');
    const env = c.env === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';
    return { name, posId: posId.replace(/^0+/, ''), env };
}

// The Bearer token PRA shows on the POS registration screen
function cleanToken(v) {
    const t = String(v === undefined || v === null ? '' : v).trim();
    if (t.length < 16 || /\s/.test(t)) throw new PosValidationError('This does not look like a PRA token: copy the token shown for this POS ID on the PRA portal.');
    return t;
}

module.exports = { PosValidationError, cleanBuyer, cleanPct, cleanItem, cleanPaymentMode, cleanProfile, cleanBranch, cleanCounter, cleanToken };
