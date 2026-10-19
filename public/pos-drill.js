// From a row of a report to the invoices behind it: the sales-list filters that give exactly the invoices the row counted (the row's own
// group, inside the report's dates). Plain functions, shared by the browser (the "Invoices" link on a report row) and by the tests, which
// check for every way of grouping that the list's total is the row's invoices.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.PosDrill = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const lastDayOf = month => { const [y, m] = month.split('-').map(Number); return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };

    // For each way of grouping: the filters that pick one group, from the row's key. The hour and the weekday of a sale are not something
    // the list can be narrowed by, so those rows have no list.
    const BY = {
        day: key => ({ from: key, to: key }),
        // a month row only counts the days of that month that are inside the report's dates
        month: (key, range) => { const first = `${key}-01`, last = lastDayOf(key); return { from: range.from && range.from > first ? range.from : first, to: range.to && range.to < last ? range.to : last }; },
        item: key => ({ itemCode: key }),
        category: key => ({ category: key === '' ? '__none' : key }),
        cashier: key => ({ cashier: key }),
        counter: key => ({ counterId: key }),
        branch: key => ({ branchId: key }),
        payment: key => ({ paymentMode: key }),
        taxRate: key => ({ taxRate: key }),
        customer: key => ({ customerId: key === '' ? 'none' : key }),
    };

    // Can the rows of this grouping open a list of invoices?
    const can = groupBy => Object.prototype.hasOwnProperty.call(BY, groupBy);

    // The filters for one row of a report grouped by `groupBy`; `range` is the report's own { from, to }. null = no list for it.
    function forRow(groupBy, row, range = {}) {
        if (!can(groupBy) || !row || typeof row.key !== 'string') return null;
        if (groupBy === 'month' && !/^\d{4}-\d{2}$/.test(row.key)) return null;
        if (groupBy === 'day' && !/^\d{4}-\d{2}-\d{2}$/.test(row.key)) return null;
        return BY[groupBy](row.key, range);
    }

    return { can, forRow };
});
