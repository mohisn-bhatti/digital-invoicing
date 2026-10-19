// The invoice JSON PRA's cloud IMS API takes, with the field names, order and sizes of the published model
// (PRAL "Technical Specification for Data Sharing through Software Fiscal Device" v1.2, section 7, and the POS Component
// manual v1.0, section 6). Figures come from calc.js.
const { itemAmounts, INVOICE_TYPES, SALE_VALUE_BASIS } = require('./calc');

// Pakistan time, "yyyy-MM-dd HH:mm:ss" (the format in PRA's sample JSON)
const PKT_CLOCK = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function praDateTime(date) {
    const p = Object.fromEntries(PKT_CLOCK.formatToParts(date instanceof Date ? date : new Date(date)).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const paisa = n => Math.round(Number(n) * 100);

// sale: { posId, usin, refUsin?, dateTime, buyer {name,pntn,cnic,phone}, paymentMode, invoiceType,
//         lines: [{ itemCode, itemName, pctCode, quantity, taxRate, saleValue, discount, taxCharged, totalAmount, gross? }], totals }
function buildPayload(sale, basis) {
    const type = sale.invoiceType || INVOICE_TYPES.NEW;
    const ref = sale.refUsin || null;
    const buyer = sale.buyer || {};
    const posId = Number(sale.posId);
    return {
        InvoiceNumber: '', // PRA fills this in
        POSID: Number.isSafeInteger(posId) ? posId : sale.posId,
        USIN: sale.usin,
        DateTime: praDateTime(sale.dateTime),
        BuyerName: buyer.name || '',
        BuyerPNTN: buyer.pntn || '',
        BuyerCNIC: buyer.cnic || '',
        BuyerPhoneNumber: buyer.phone || '',
        TotalBillAmount: sale.totals.bill,
        TotalQuantity: sale.totals.quantity,
        TotalSaleValue: sale.totals.saleValue,
        TotalTaxCharged: sale.totals.tax,
        Discount: sale.totals.discount,
        FurtherTax: 0,
        PaymentMode: sale.paymentMode,
        RefUSIN: ref,
        InvoiceType: type,
        Items: sale.lines.map(l => {
            const a = itemAmounts(l, basis);
            return {
                ItemCode: l.itemCode,
                ItemName: l.itemName,
                Quantity: l.quantity,
                PCTCode: l.pctCode,
                TaxRate: l.taxRate,
                SaleValue: a.SaleValue,
                TotalAmount: a.TotalAmount,
                TaxCharged: a.TaxCharged,
                Discount: a.Discount,
                FurtherTax: 0,
                InvoiceType: type,
                RefUSIN: ref,
            };
        }),
    };
}

// Nothing leaves this server unless the invoice adds up (SRS: TotalBillAmount must reconcile with the line totals).
// Returns a list of problems; empty = fine.
function reconcile(payload, basis) {
    const problems = [];
    const gross = (basis || SALE_VALUE_BASIS) === 'GROSS';
    const sum = key => payload.Items.reduce((s, i) => s + paisa(i[key]), 0);
    // the value tax is charged on: SaleValue itself, or SaleValue less the discount when SaleValue is sent before the discount
    const taxable = i => paisa(i.SaleValue) - (gross ? paisa(i.Discount) : 0);
    if (!payload.Items.length) problems.push('The invoice has no items.');
    if (paisa(payload.TotalTaxCharged) !== sum('TaxCharged')) problems.push('Total tax does not match the item taxes.');
    if (paisa(payload.TotalBillAmount) !== sum('TotalAmount')) problems.push('The bill total does not match the item totals.');
    if (paisa(payload.TotalSaleValue) !== payload.Items.reduce((s, i) => s + taxable(i), 0)) problems.push('The sale value does not match the items.');
    if (paisa(payload.TotalBillAmount) !== paisa(payload.TotalSaleValue) + paisa(payload.TotalTaxCharged) + paisa(payload.FurtherTax)) {
        problems.push('The bill total is not the sale value plus tax.');
    }
    if (payload.Items.some(i => paisa(i.TotalAmount) !== taxable(i) + paisa(i.TaxCharged) + paisa(i.FurtherTax))) problems.push('An item total is not its value plus its tax.');
    if (!payload.USIN || String(payload.USIN).length > 50) problems.push('The invoice number (USIN) is missing or too long.');
    if (payload.InvoiceType === INVOICE_TYPES.CREDIT && !payload.RefUSIN) problems.push('A credit note must name the invoice it returns (RefUSIN).');
    return problems;
}

module.exports = { buildPayload, reconcile, praDateTime };
