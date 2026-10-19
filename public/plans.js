// ETAX plans and prices, shown on the website (index.html, contact.html). One price list for both products: FBR Digital Invoicing and
// PRA Point of Sale cost the same. Annual plans only, shown at the discounted price with the full price beside it.
//
// Every feature a plan includes is shown with a tick. The plan limits (branches, terminals, products, users) are enforced by the
// application (src/limits.js), which reads them from here.
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
    // what the application counts against each number in a plan's limits (Point of Sale items and Digital Invoicing products share one number)
    const KIND_INDEX = { branches: 0, terminals: 1, products: 2, items: 2, users: 3 };

    // in = [Starter, Pro, Enterprise]; status per product: live (shown as a tick) or na (does not apply to that product: left out)
    const FEATURES = [
        { label: { fbr: 'FBR digital invoicing & QR receipts', pra: 'PRA fiscal invoicing & QR receipts' }, in: [1, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: { fbr: 'Real FBR invoice number on every sale', pra: 'Real PRA invoice number on every sale' }, in: [1, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'Excel bulk upload', in: [1, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: { fbr: 'Setup & FBR testing done for you', pra: 'Setup & PRA testing done for you' }, in: [1, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'Offline-first POS terminal', in: [1, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'All payment methods', in: [1, 1, 1], status: { fbr: 'na', pra: 'live' } },
        { label: 'Inventory & stock tracking', in: [1, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'Basic sales & tax reports', in: [1, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'CSV product import', in: [1, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'Multi-branch & warehouse stock', in: [1, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'Phone & WhatsApp support', in: [1, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'Advanced & scheduled reports', in: [0, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: { fbr: 'Returns, debit notes & cancellations', pra: 'Returns & credit notes' }, in: [0, 1, 1], status: { fbr: 'live', pra: 'live' } },
        { label: 'Stock transfers & audits', in: [0, 1, 1], status: { fbr: 'live', pra: 'live' } },
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
    // the limit of one kind (branches, terminals, products, items, users) on a plan; null = no limit (no plan, or Enterprise)
    const limitOf = (p, kind) => (p && p.limits ? p.limits[KIND_INDEX[kind]] : null);
    const limitTexts = p => LIMITS.map(([one, many], i) => (p.limits ? `${p.limits[i].toLocaleString('en-US')} ${p.limits[i] === 1 ? one : many}` : `Unlimited ${many}`));

    const n = x => Number(x).toLocaleString('en-US');
    // what a plan allows, in a few words: "up to 1 branch, 2 terminals, 1,000 products, 3 users" (Enterprise: "unlimited ...")
    const limitsSentence = p => (p.limits ? `up to ${limitTexts(p).join(', ').toLowerCase()}` : 'unlimited branches, terminals, products and users');

    // How one limit stands for a client: state (none = no limit, ok, full, over), how much of the bar is filled, and a few words
    function standing(used, limit) {
        if (limit === null || limit === undefined) return { state: 'none', pct: 0, caption: 'no limit' };
        if (used > limit) return { state: 'over', pct: 100, caption: `over the limit by ${n(used - limit)}` };
        if (used === limit) return { state: 'full', pct: 100, caption: 'full' };
        return { state: 'ok', pct: Math.round((used / limit) * 100), caption: `${n(limit - used)} left` };
    }

    // What the plan chosen in the picker means for a client that already has `rows` (the usage the server sends): its limits, and a
    // warning for whatever the client has above them (it keeps those, and can add nothing until it is back under)
    function planNote(p, rows) {
        if (!p) return { warn: false, text: 'No plan: no limits. The client can add as much as it likes.' };
        const over = (rows || []).filter(r => limitOf(p, r.kind) !== null && r.used > limitOf(p, r.kind));
        return { warn: over.length > 0, text: `${p.name}: ${limitsSentence(p)}.` + (over.length
            ? ` This client already has more than that (${over.map(r => `${n(r.used)} ${r.noun}, limit ${n(limitOf(p, r.kind))}`).join('; ')}). It keeps all of them, and can add nothing until it is back under.` : '') };
    }

    // The one line on a page about the client's own limits: "Starter plan: 2 of 3 users used." usage = what the server sends:
    // { plan: { id, name } | null, rows: [{ kind, noun, one, used, limit }] }. null when there is nothing to say (no plan, or no limit on
    // these kinds). admin: the one reading is the administrator, who changes the plan instead of asking for a bigger one.
    function hint(usage, kinds, { admin = false } = {}) {
        const rows = ((usage && usage.rows) || []).filter(r => kinds.includes(r.kind) && r.limit !== null);
        if (!usage || !usage.plan || !rows.length) return null;
        const over = rows.some(r => r.used > r.limit), full = rows.some(r => r.used >= r.limit);
        const todo = admin ? 'Change the plan under Manage → Overview to add more.' : 'Ask ETAX to move you to a bigger plan to add more.';
        return { tone: over ? 'red' : full ? 'amber' : 'slate', lead: `${usage.plan.name} plan:`,
            text: `${rows.map(r => `${n(r.used)} of ${n(r.limit)} ${r.limit === 1 ? r.one : r.noun}`).join(', ')} used.${over ? ' Over the limit: nothing more can be added until it is back under.' : ''}${full ? ' ' + todo : ''}` };
    }

    // The rows for one product, in the order shown: what every plan has first, then what the higher plans add
    function featuresFor(productId) {
        const rows = FEATURES.filter(f => (f.status[productId] || 'na') !== 'na')
            .map(f => ({ label: typeof f.label === 'string' ? f.label : f.label[productId], in: f.in.map(Boolean) }));
        return [...rows.filter(r => r.in.every(Boolean)), ...rows.filter(r => !r.in.every(Boolean))];
    }

    return { PRODUCTS, PLANS, LIMITS, KIND_INDEX, FEATURES, rupees, percentOff, plan, product, limitOf, limitTexts, limitsSentence, standing, planNote, hint, featuresFor };
});
