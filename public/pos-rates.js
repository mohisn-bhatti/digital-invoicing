// Suggested service headings and tax rates for the kinds of business that use Point of Sale (the "quick rate" boxes in the item form and in
// Settings). They are only suggestions: rates change with each Finance Act, so the account owner confirms them against PRA's current
// schedule (docs/POS_MODULE.md, "Tax rates"), and every item is still checked in full when it is saved. Plain data, shared by the browser
// and by the tests (which check that each heading exists in the PCT table).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.PosRates = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // pct = the heading as PRA's schedule writes it; rate = sales tax %; card = the rate when the customer pays by card, wallet or QR (null = same)
    const PRESETS = [
        { id: 'restaurant', label: 'Restaurant, café, fast food', pct: '9801.2000', rate: 16, card: 8 },
        { id: 'hotel', label: 'Hotel, guest house', pct: '9801.1000', rate: 16, card: 8 },
        { id: 'hall', label: 'Marriage hall, lawn, banquet', pct: '9801.3000', rate: 8, card: null },
        { id: 'caterer', label: 'Caterer, event management', pct: '9801.5000', rate: 8, card: null },
        { id: 'beauty', label: 'Beauty parlour, salon', pct: '9810.0000', rate: 5, card: null },
    ];

    // The list the screens use: the five above until the rate schedule (the super admin's table of PRA rates, by heading and date) has been read, then
    // the schedule's own list. A heading the five above know keeps their friendlier name.
    let current = PRESETS;
    const heading = code => `${String(code).slice(0, 4)}.${String(code).slice(4)}`;
    function use(rows) {
        if (!Array.isArray(rows) || !rows.length) { current = PRESETS; return; }
        current = rows.map(r => {
            const known = PRESETS.find(p => p.pct === heading(r.code));
            return { id: r.code, label: known ? known.label : r.label, pct: heading(r.code), rate: r.rate, card: r.cardRate === null || r.cardRate === undefined ? null : r.cardRate, conditions: r.conditions || '', from: r.effectiveFrom || '', source: [r.sourceName, r.sourceRef].filter(Boolean).join(', '), scheduled: true };
        }).sort((a, b) => a.pct.localeCompare(b.pct));
    }
    const find = id => current.find(p => p.id === id) || null;
    // how a suggestion reads in a list: "9801.2000 · 16% (8% on card)"
    const describe = p => `${p.pct} · ${p.rate}%${p.card === null ? '' : ` (${p.card}% on card)`}`;

    return { PRESETS, get CURRENT() { return current; }, use, find, describe };
});
