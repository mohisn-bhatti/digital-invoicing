// Point of Sale money maths. Used by the server (which decides every figure) and by the cashier screen (which only
// previews), so both always show the same numbers. Plain JS that runs in Node and in the browser.
//
// Money is kept in whole paisa, quantity in ten-thousandths and tax rates in hundredths of a percent, all as BigInt:
// no floating-point drift. Rounding is half-up to the paisa (the SRS asks for decimal maths, rounding to be confirmed
// against the PRA sandbox: change it here only).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.PosCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // What goes in an item's SaleValue when a discount was given. The SRS (v1.7, 4.3) and PRA's own manual disagree:
    //   'NET'   PRA manual: SaleValue is "the price on which tax is calculated, exclusive of tax and discount", so it is the
    //           value after the discount; Discount is informational; TaxCharged = SaleValue × rate; TotalAmount = SaleValue + tax.
    //   'GROSS' SRS baseline: SaleValue is the value before the discount; tax is charged on SaleValue − Discount.
    // With no discount the two are identical. To be settled in the PRA sandbox; this is the only place to change.
    const SALE_VALUE_BASIS = 'NET';

    const PAYMENT_MODES = [
        { id: 1, label: 'Cash' }, { id: 2, label: 'Card' }, { id: 3, label: 'Gift Voucher' },
        { id: 4, label: 'Loyalty Card' }, { id: 5, label: 'Mixed' }, { id: 6, label: 'Cheque' },
    ];
    const CARD = 2;
    const INVOICE_TYPES = { NEW: 1, DEBIT: 2, CREDIT: 3 };

    class PosCalcError extends Error {}

    // "12.345" → scaled integer, half-up on the first dropped digit. Only plain non-negative numbers are accepted.
    function scaled(value, scale, what) {
        const s = String(value === undefined || value === null ? '' : value).trim();
        if (!/^\d+(\.\d+)?$/.test(s)) throw new PosCalcError(`${what} must be a number (not negative).`);
        const [int, frac = ''] = s.split('.');
        let n = BigInt(int + frac.slice(0, scale).padEnd(scale, '0'));
        if (frac.length > scale && frac[scale] >= '5') n += 1n;
        return n;
    }
    const divRound = (n, d) => (n * 2n + d) / (2n * d); // half-up, n ≥ 0
    const rupees = p => Number((Number(p) / 100).toFixed(2));
    const qtyNum = q => Number(q) / 10000;

    // One item line. quantity × unitPrice (ex tax) − discount = the value tax is charged on.
    function calcLine(l) {
        const qty4 = scaled(l.quantity, 4, 'Quantity');
        if (qty4 <= 0n) throw new PosCalcError('Quantity must be more than zero.');
        const price = scaled(l.unitPrice, 2, 'Price');
        const gross = divRound(qty4 * price, 10000n);
        const discount = scaled(l.discount === undefined || l.discount === null || l.discount === '' ? 0 : l.discount, 2, 'Discount');
        if (discount > gross) throw new PosCalcError('A discount cannot be more than the item amount.');
        const rateBp = scaled(l.taxRate === undefined || l.taxRate === null || l.taxRate === '' ? 0 : l.taxRate, 2, 'Tax rate');
        if (rateBp > 10000n) throw new PosCalcError('A tax rate cannot be more than 100%.');
        const net = gross - discount;
        const tax = divRound(net * rateBp, 10000n);
        return { qty4, price, gross, discount, rateBp, net, tax, total: net + tax };
    }

    function lineOut(c) {
        return {
            quantity: qtyNum(c.qty4), unitPrice: rupees(c.price), gross: rupees(c.gross), discount: rupees(c.discount),
            taxRate: Number(c.rateBp) / 100, saleValue: rupees(c.net), taxCharged: rupees(c.tax), totalAmount: rupees(c.total),
        };
    }

    // lines: [{ quantity, unitPrice, discount?, taxRate }] → every line and the totals (numbers, 2 decimals)
    function calcSale(lines) {
        if (!Array.isArray(lines) || !lines.length) throw new PosCalcError('Add at least one item.');
        let qty4 = 0n, net = 0n, discount = 0n, tax = 0n, total = 0n;
        const out = lines.map(l => {
            const c = calcLine(l);
            qty4 += c.qty4; net += c.net; discount += c.discount; tax += c.tax; total += c.total;
            return lineOut(c);
        });
        return { lines: out, totals: { quantity: qtyNum(qty4), saleValue: rupees(net), discount: rupees(discount), tax: rupees(tax), bill: rupees(total) } };
    }

    // The discount as a percentage of the line amount, in rupees (for the cashier typing "10%")
    function discountFromPercent(line, percent) {
        const gross = divRound(scaled(line.quantity, 4, 'Quantity') * scaled(line.unitPrice, 2, 'Price'), 10000n);
        const pctBp = scaled(percent, 2, 'Discount %');
        if (pctBp > 10000n) throw new PosCalcError('A discount cannot be more than 100%.');
        return rupees(divRound(gross * pctBp, 10000n));
    }

    // An item's tax rate depends on how it is paid (e.g. restaurants: a lower rate on card / QR payments). Mixed payments use
    // the standard rate.
    function rateFor(item, paymentMode) {
        const card = item.taxRateCard;
        return Number(paymentMode) === CARD && card !== undefined && card !== null && card !== '' ? card : item.taxRate;
    }

    // A credit note returns some (or all) of a sold line, at the sale's own price and rate. The last part returns exactly what
    // is left, so the credit notes add up to the sale to the paisa.
    // orig: the sold line { quantity, discount, saleValue, taxCharged, unitPrice, taxRate }
    // done: what earlier credit notes already returned { quantity, discount, saleValue, taxCharged }
    function creditLine(orig, returnQuantity, done) {
        const origQ = scaled(orig.quantity, 4, 'Quantity'), retQ = scaled(returnQuantity, 4, 'Return quantity');
        const doneQ = scaled(done.quantity, 4, 'Quantity');
        if (retQ <= 0n) throw new PosCalcError('Return quantity must be more than zero.');
        if (doneQ + retQ > origQ) throw new PosCalcError('You cannot return more than was sold.');
        const o = { net: scaled(orig.saleValue, 2, 'Value'), disc: scaled(orig.discount, 2, 'Discount'), tax: scaled(orig.taxCharged, 2, 'Tax') };
        const d = { net: scaled(done.saleValue, 2, 'Value'), disc: scaled(done.discount, 2, 'Discount'), tax: scaled(done.taxCharged, 2, 'Tax') };
        const last = doneQ + retQ === origQ;
        const part = (all, spent) => (last ? all - spent : divRound(all * retQ, origQ));
        const net = part(o.net, d.net), disc = part(o.disc, d.disc), tax = part(o.tax, d.tax);
        return {
            quantity: qtyNum(retQ), unitPrice: Number(orig.unitPrice), discount: rupees(disc), taxRate: Number(orig.taxRate),
            saleValue: rupees(net), gross: rupees(net + disc), taxCharged: rupees(tax), totalAmount: rupees(net + tax),
        };
    }

    // The totals of lines that are already worked out (credit notes: some returned lines of a sale)
    function totalsOf(lines) {
        let qty4 = 0n, net = 0n, discount = 0n, tax = 0n, total = 0n;
        for (const l of lines) {
            qty4 += scaled(l.quantity, 4, 'Quantity'); net += scaled(l.saleValue, 2, 'Value'); discount += scaled(l.discount, 2, 'Discount');
            tax += scaled(l.taxCharged, 2, 'Tax'); total += scaled(l.totalAmount, 2, 'Total');
        }
        return { quantity: qtyNum(qty4), saleValue: rupees(net), discount: rupees(discount), tax: rupees(tax), bill: rupees(total) };
    }

    // The item amounts as PRA wants them, for the chosen basis
    function itemAmounts(line, basis) {
        const b = basis || SALE_VALUE_BASIS;
        const gross = line.gross !== undefined ? line.gross : Number((line.saleValue + line.discount).toFixed(2));
        return {
            SaleValue: b === 'GROSS' ? gross : line.saleValue,
            Discount: line.discount,
            TaxCharged: line.taxCharged,
            TotalAmount: line.totalAmount,
        };
    }

    return { SALE_VALUE_BASIS, PAYMENT_MODES, CARD, INVOICE_TYPES, PosCalcError, calcLine, calcSale, discountFromPercent, rateFor, creditLine, totalsOf, itemAmounts };
});
