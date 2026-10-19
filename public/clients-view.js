// The administrator's Clients list: what the access column says, and how the list is filtered and sorted. Pure functions that run
// in Node and in the browser, so they can be tested without a page.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ClientsView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const modulesOf = c => (c.modules && c.modules.length ? c.modules : ['INVOICING']);
    const has = (c, id) => modulesOf(c).includes(id);

    // What the countdown column says for a client: text, a colour, and the date that goes with it
    function accessLabel(c) {
        const a = (c && c.access) || { status: 'UNLIMITED' };
        switch (a.status) {
            case 'UNLIMITED': return { text: 'No time limit', tone: 'slate', dateLabel: '', date: null };
            case 'RUNNING': return { text: `${plural(a.daysLeft, 'day')} left`, tone: 'emerald', dateLabel: 'ends', date: a.endsOn };
            case 'ENDING': return { text: a.daysLeft === 0 ? 'Ends today' : `${plural(a.daysLeft, 'day')} left`, tone: 'amber', dateLabel: 'ends', date: a.endsOn };
            case 'GRACE': return { text: `Ended ${plural(-a.daysLeft, 'day')} ago`, tone: 'orange', dateLabel: 'active until', date: a.graceUntil };
            default: return { text: `Expired ${plural(-a.daysLeft, 'day')} ago`, tone: 'red', dateLabel: 'ended', date: a.endsOn };
        }
    }

    const ACCESS_FILTERS = {
        unlimited: ['UNLIMITED'], running: ['RUNNING'], ending: ['ENDING'], grace: ['GRACE'], expired: ['EXPIRED'],
        attention: ['ENDING', 'GRACE', 'EXPIRED'], // anything that needs the administrator's eye
    };

    // f: { q, status: active|inactive, access: unlimited|running|ending|grace|expired|attention, product: INVOICING|POS, env: SANDBOX|PRODUCTION,
    //      plan: starter|pro|enterprise|none }
    function matches(c, f) {
        if (!f) return true;
        if (f.status === 'active' && !c.active) return false;
        if (f.status === 'inactive' && c.active) return false;
        if (f.access && !(ACCESS_FILTERS[f.access] || []).includes(((c.access && c.access.status) || 'UNLIMITED'))) return false;
        if (f.product && !has(c, f.product)) return false;
        if (f.plan && (c.plan || 'none') !== f.plan) return false; // "none" = a client with no plan (and so no limits)
        if (f.env && !(has(c, 'INVOICING') && c.fbrEnv === f.env)) return false; // the environment is a Digital Invoicing setting
        const words = String(f.q || '').toLowerCase().split(/\s+/).filter(Boolean);
        if (words.length) {
            const hay = [c.companyName, ...(c.emails || []), c.mobile, c.sellerNtnCnic, ...(c.sectors || [])].filter(Boolean).join(' ').toLowerCase();
            if (!words.every(w => hay.includes(w))) return false;
        }
        return true;
    }
    const filterClients = (rows, f) => rows.filter(c => matches(c, f));

    const time = d => (d ? new Date(d).getTime() || 0 : 0);
    const monthCount = c => ((c.thisMonth && c.thisMonth.invoices) || 0) + ((c.pos && c.pos.sales && c.pos.sales.count) || 0);
    const latest = c => Math.max(time(c.lastInvoiceAt), time(c.pos && c.pos.lastSaleAt));
    const byName = (a, b) => String(a.companyName).localeCompare(String(b.companyName), 'en', { sensitivity: 'base' });
    // key → compare function (ties fall back to the name, so the order never jumps about)
    const COMPARE = {
        newest: (a, b) => time(b.createdAt) - time(a.createdAt),
        oldest: (a, b) => time(a.createdAt) - time(b.createdAt),
        name: byName,
        integrated: (a, b) => time(b.integratedAt) - time(a.integratedAt),
        daysLeft: (a, b) => { // the soonest to end (or already over) first; clients with no time limit last
            const x = a.access && a.access.daysLeft, y = b.access && b.access.daysLeft;
            if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
            return y === null || y === undefined ? -1 : x - y;
        },
        busy: (a, b) => monthCount(b) - monthCount(a),
        recent: (a, b) => latest(b) - latest(a),
    };
    const SORTS = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['name', 'Company A–Z'], ['integrated', 'Integration date (newest first)'], ['daysLeft', 'Days left (fewest first)'], ['busy', 'Most sales this month'], ['recent', 'Latest invoice or sale']];
    function sortClients(rows, key) {
        const compare = COMPARE[key] || COMPARE.newest;
        return rows.map((c, i) => [c, i]).sort((a, b) => compare(a[0], b[0]) || (key === 'name' ? 0 : byName(a[0], b[0])) || a[1] - b[1]).map(x => x[0]);
    }

    return { accessLabel, matches, filterClients, sortClients, SORTS, ACCESS_FILTERS, monthCount, modulesOf, has };
});
