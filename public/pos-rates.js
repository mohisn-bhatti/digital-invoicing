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

    const find = id => PRESETS.find(p => p.id === id) || null;
    // how a suggestion reads in a list: "9801.2000 · 16% (8% on card)"
    const describe = p => `${p.pct} · ${p.rate}%${p.card === null ? '' : ` (${p.card}% on card)`}`;

    return { PRESETS, find, describe };
});
