// ETAX plans and prices, shown on the website (index.html, contact.html). One price list for both products: FBR Digital Invoicing and
// PRA Point of Sale cost the same. Annual plans only, shown at the discounted price with the full price beside it.
//
// A feature a plan includes is a tick only if the product can do it today. One that is promised but not built yet is marked 'soon'
// and shown with a "Soon" tag instead of a tick. When it is built, change its status here and the website follows.
// (The plan limits and the features per plan are what is sold; the application does not enforce them yet.)
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.Plans = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const PRODUCTS = [
        { id: 'fbr', name: 'FBR Digital Invoicing', note: 'Pakistan: invoices filed with FBR' },
        { id: 'pra', name: 'PRA Point of Sale', note: 'Punjab: every sale fiscalized with PRA' },
    ];

    // price and full are rupees per year; limits = [branches, terminals, products, users], null = unlimited
    const PLANS = [
        { id: 'starter', name: 'Starter', tagline: 'Perfect for small businesses and single shops.', full: 24000, price: 12000, limits: [1, 2, 1000, 3], cta: 'Get Started' },
        { id: 'pro', name: 'Pro', tagline: 'Ideal for growing businesses with multiple branches.', full: 60000, price: 30000, limits: [5, 10, 10000, 15], cta: 'Get Started', popular: true },
        { id: 'enterprise', name: 'Enterprise', tagline: 'For chains and high-volume operations.', full: 180000, price: 90000, limits: null, cta: 'Talk to sales' },
    ];
    const LIMITS = [['branch', 'branches'], ['terminal', 'terminals'], ['product', 'products'], ['user', 'users']];

    // in = [Starter, Pro, Enterprise]; status per product: live (it can do it today), soon (promised, not built yet), na (does not apply)
    const FEATURES = [
        { label: { fbr: 'FBR digital invoicing & QR receipts', pra: 'PRA fiscal invoicing & QR receipts' }, in: [1, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: { fbr: 'Real FBR invoice number on every sale', pra: 'Real PRA invoice number on every sale' }, in: [1, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'Excel bulk upload', in: [1, 1, 1], status: { fbr: 'live', pra: 'soon' } },
        { label: { fbr: 'Setup & FBR testing done for you', pra: 'Setup & PRA testing done for you' }, in: [1, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'Offline-first POS terminal', in: [1, 1, 1], status: { fbr: 'soon', pra: 'soon' } },
        { label: 'All payment methods', in: [1, 1, 1], status: { fbr: 'na', pra: 'live' } },
        { label: 'Inventory & stock tracking', in: [1, 1, 1], status: { fbr: 'live', pra: 'soon' } },
        { label: 'Basic sales & tax reports', in: [1, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'CSV product import', in: [1, 1, 1], status: { fbr: 'live', pra: 'soon' } },
        { label: 'Multi-branch & warehouse stock', in: [1, 1, 1], status: { fbr: 'soon', pra: 'soon' } },
        { label: 'Phone & WhatsApp support', in: [1, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: { fbr: 'Advanced reports (Annex-C, stock statement, CSV)', pra: 'Advanced reports (by item and payment type, CSV)' }, in: [0, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'Scheduled reports', in: [0, 1, 1], status: { fbr: 'soon', pra: 'soon' } },
        { label: { fbr: 'Debit notes & cancellations', pra: 'Returns & credit notes' }, in: [0, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'Stock transfers & audits', in: [0, 1, 1], status: { fbr: 'soon', pra: 'soon' } },
        { label: 'Email support', in: [0, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'Priority onboarding', in: [0, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'Dedicated account manager', in: [0, 0, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'Custom onboarding & training', in: [0, 0, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'SDC/IMS setup for Tier-1 retailers', in: [0, 0, 1], status: { fbr: 'live', pra: 'na' } },
        { label: 'Priority compliance support', in: [0, 0, 1], status: { fbr: 'live', pra: 'live' } },
    ];

    const rupees = n => 'Rs. ' + Number(n).toLocaleString('en-US');
    const percentOff = plan => Math.round((1 - plan.price / plan.full) * 100);
    const plan = id => PLANS.find(p => p.id === id) || null;
    const product = id => PRODUCTS.find(p => p.id === id) || null;
    // "1 branch", "2 terminals", "Unlimited users" ...
    const limitTexts = p => LIMITS.map(([one, many], i) => (p.limits ? `${p.limits[i].toLocaleString('en-US')} ${p.limits[i] === 1 ? one : many}` : `Unlimited ${many}`));

    // The rows for one product, in the order shown: what every plan has first, then what the higher plans add
    function featuresFor(productId) {
        const rows = FEATURES.filter(f => (f.status[productId] || 'na') !== 'na')
            .map(f => ({ label: typeof f.label === 'string' ? f.label : f.label[productId], soon: f.status[productId] === 'soon', in: f.in.map(Boolean) }));
        return [...rows.filter(r => r.in.every(Boolean)), ...rows.filter(r => !r.in.every(Boolean))];
    }

    return { PRODUCTS, PLANS, LIMITS, FEATURES, rupees, percentOff, plan, product, limitTexts, featuresFor };
});
