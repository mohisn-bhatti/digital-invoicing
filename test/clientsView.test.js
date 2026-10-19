// The administrator's Clients list: the countdown column, and filtering and sorting (the real public/clients-view.js).
const test = require('node:test');
const assert = require('node:assert');
const V = require('../public/clients-view');
const Access = require('../public/access');

const at = day => new Date(`${day}T12:00:00+05:00`);
const NOW = at('2026-10-19');
let n = 0;
// a client row as the administrator's list receives it
const client = (name, over = {}) => {
    const t = { accessUnit: over.accessUnit || null, accessEndsAt: over.end ? Access.atMidnight(over.end) : null };
    return {
        id: `id${++n}`, companyName: name, emails: [`${name.split(' ')[0].toLowerCase()}@example.com`], mobile: '', active: true, modules: ['INVOICING'], fbrEnv: 'SANDBOX', sellerNtnCnic: '', sectors: [],
        createdAt: new Date(2026, 0, n).toISOString(), integratedAt: new Date(2026, 0, n).toISOString(), lastInvoiceAt: null, thisMonth: { invoices: 0, total: 0 }, pos: null,
        access: Access.access(t, NOW), ...over, ...(over.end ? {} : {}),
    };
};
const names = rows => rows.map(r => r.companyName);

test('the access column: a countdown while running, a warning near the end, grace, expired, or no limit', () => {
    const label = (end, unit = 'YEAR') => V.accessLabel(client('x', { end, accessUnit: unit }));
    assert.deepStrictEqual(V.accessLabel(client('free')), { text: 'No time limit', tone: 'slate', dateLabel: '', date: null });
    assert.deepStrictEqual(label('2027-10-19'), { text: '365 days left', tone: 'emerald', dateLabel: 'ends', date: '2027-10-19' });
    assert.strictEqual(label('2026-11-18').text, '30 days left');
    assert.strictEqual(label('2026-11-18').tone, 'amber', '30 days or fewer: amber');
    assert.strictEqual(label('2026-10-20').text, '1 day left');
    assert.deepStrictEqual([label('2026-10-19').text, label('2026-10-19').tone], ['Ends today', 'amber']);
    assert.deepStrictEqual(label('2026-10-18'), { text: 'Ended 1 day ago', tone: 'orange', dateLabel: 'active until', date: '2026-10-25' }, 'a yearly plan: 7 grace days');
    assert.strictEqual(label('2026-10-18', 'MONTH').date, '2026-10-21', 'a monthly plan: 3 grace days');
    assert.deepStrictEqual(label('2026-10-11'), { text: 'Expired 8 days ago', tone: 'red', dateLabel: 'ended', date: '2026-10-11' }, 'a yearly plan: 7 grace days are over');
    assert.strictEqual(V.accessLabel({}).text, 'No time limit', 'a row without the figures is shown as no limit');
});

const LIST = () => {
    n = 0;
    return [
        client('Zeta Traders', { end: '2027-06-01', accessUnit: 'YEAR', thisMonth: { invoices: 4, total: 100 }, lastInvoiceAt: '2026-10-10T08:00:00Z' }),
        client('Alpha Cold Storage', { end: '2026-10-25', accessUnit: 'MONTH', fbrEnv: 'PRODUCTION', thisMonth: { invoices: 9, total: 900 }, lastInvoiceAt: '2026-10-18T08:00:00Z' }),
        client('Mango Cafe', { end: '2026-10-17', accessUnit: 'MONTH', modules: ['POS'], pos: { sales: { count: 12, total: 5000 }, lastSaleAt: '2026-10-19T05:00:00Z' } }),
        client('Beta Hotel', { modules: ['INVOICING', 'POS'], active: false, pos: { sales: { count: 0, total: 0 }, lastSaleAt: null }, emails: ['owner@betahotel.pk'], mobile: '03001234567', sellerNtnCnic: '1234567', sectors: ['Services'] }),
        client('Old Mill', { end: '2026-09-01', accessUnit: 'YEAR', fbrEnv: 'PRODUCTION', active: false }),
    ];
};

test('the list can be filtered by status, access period, product and environment', () => {
    const rows = LIST();
    assert.deepStrictEqual(names(V.filterClients(rows, {})), names(rows), 'no filter: everyone');
    assert.deepStrictEqual(names(V.filterClients(rows, null)), names(rows));
    assert.deepStrictEqual(names(V.filterClients(rows, { status: 'active' })), ['Zeta Traders', 'Alpha Cold Storage', 'Mango Cafe']);
    assert.deepStrictEqual(names(V.filterClients(rows, { status: 'inactive' })), ['Beta Hotel', 'Old Mill']);
    assert.deepStrictEqual(names(V.filterClients(rows, { access: 'unlimited' })), ['Beta Hotel']);
    assert.deepStrictEqual(names(V.filterClients(rows, { access: 'running' })), ['Zeta Traders']);
    assert.deepStrictEqual(names(V.filterClients(rows, { access: 'ending' })), ['Alpha Cold Storage']);
    assert.deepStrictEqual(names(V.filterClients(rows, { access: 'grace' })), ['Mango Cafe']);
    assert.deepStrictEqual(names(V.filterClients(rows, { access: 'expired' })), ['Old Mill']);
    assert.deepStrictEqual(names(V.filterClients(rows, { access: 'attention' })), ['Alpha Cold Storage', 'Mango Cafe', 'Old Mill'], 'ending, in grace or expired');
    assert.deepStrictEqual(names(V.filterClients(rows, { product: 'POS' })), ['Mango Cafe', 'Beta Hotel']);
    assert.deepStrictEqual(names(V.filterClients(rows, { product: 'INVOICING' })), ['Zeta Traders', 'Alpha Cold Storage', 'Beta Hotel', 'Old Mill']);
    assert.deepStrictEqual(names(V.filterClients(rows, { env: 'PRODUCTION' })), ['Alpha Cold Storage', 'Old Mill']);
    assert.deepStrictEqual(names(V.filterClients(rows, { env: 'SANDBOX' })), ['Zeta Traders', 'Beta Hotel'], 'a POS-only client has no FBR environment');
    assert.deepStrictEqual(names(V.filterClients(rows, { status: 'active', access: 'attention', product: 'INVOICING' })), ['Alpha Cold Storage'], 'filters combine');
});

test('the list can be searched by company, login, mobile, NTN and sector', () => {
    const rows = LIST();
    const find = q => names(V.filterClients(rows, { q }));
    assert.deepStrictEqual(find('mango'), ['Mango Cafe']);
    assert.deepStrictEqual(find('  COLD   storage '), ['Alpha Cold Storage'], 'any case, any spacing');
    assert.deepStrictEqual(find('betahotel.pk'), ['Beta Hotel'], 'by login');
    assert.deepStrictEqual(find('0300123'), ['Beta Hotel'], 'by mobile');
    assert.deepStrictEqual(find('1234567'), ['Beta Hotel'], 'by NTN');
    assert.deepStrictEqual(find('services'), ['Beta Hotel'], 'by sector');
    assert.deepStrictEqual(find('cold nothing'), [], 'every word must match');
    assert.deepStrictEqual(find('@example.com').length, 4);
});

test('the list can be sorted, with the name as the tie-break, and it never changes the list it was given', () => {
    const rows = LIST(), before = names(rows);
    const sorted = key => names(V.sortClients(rows, key));
    assert.deepStrictEqual(sorted('newest'), ['Old Mill', 'Beta Hotel', 'Mango Cafe', 'Alpha Cold Storage', 'Zeta Traders']);
    assert.deepStrictEqual(sorted('oldest'), ['Zeta Traders', 'Alpha Cold Storage', 'Mango Cafe', 'Beta Hotel', 'Old Mill']);
    assert.deepStrictEqual(sorted('name'), ['Alpha Cold Storage', 'Beta Hotel', 'Mango Cafe', 'Old Mill', 'Zeta Traders']);
    assert.deepStrictEqual(sorted('integrated'), ['Old Mill', 'Beta Hotel', 'Mango Cafe', 'Alpha Cold Storage', 'Zeta Traders']);
    assert.deepStrictEqual(sorted('daysLeft'), ['Old Mill', 'Mango Cafe', 'Alpha Cold Storage', 'Zeta Traders', 'Beta Hotel'], 'most overdue first, then soonest, no limit last');
    assert.deepStrictEqual(sorted('busy'), ['Mango Cafe', 'Alpha Cold Storage', 'Zeta Traders', 'Beta Hotel', 'Old Mill'], 'invoices and POS sales this month (12, 9, 4, 0, 0), most first');
    assert.deepStrictEqual(sorted('recent'), ['Mango Cafe', 'Alpha Cold Storage', 'Zeta Traders', 'Beta Hotel', 'Old Mill'], 'the latest invoice or sale, none last');
    assert.deepStrictEqual(sorted('nonsense'), sorted('newest'), 'an unknown key falls back to the default');
    assert.deepStrictEqual(names(rows), before, 'the original order is untouched');
    assert.strictEqual(V.SORTS.length, 7);
    for (const [key] of V.SORTS) assert.strictEqual(sorted(key).length, rows.length, key);
});
