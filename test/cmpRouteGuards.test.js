// SRS 2: "role-based access must be enforced at every action (server-side)". Every Compliance & Deadlines route is registered on a
// stand-in app and held to the permission listed for it here: a new route without an entry, or with a different permission, fails.
const test = require('node:test');
const assert = require('node:assert');
const { registerCmpRoutes } = require('../src/compliance/routes');

const PERMS = {
    'GET /api/cmp/me': null, // anyone the module is open to (it says what they may do)
    'GET /api/cmp/settings': ['VIEW'], 'PUT /api/cmp/settings': ['FULL'],
    'GET /api/cmp/clients': ['VIEW'], 'POST /api/cmp/clients': ['CLIENT_EDIT'],
    'GET /api/cmp/clients/:id': ['VIEW'], 'PUT /api/cmp/clients/:id': ['CLIENT_EDIT'], 'GET /api/cmp/clients/:id/secrets': ['SECRETS'],
    'POST /api/cmp/clients/:id/archive': ['ARCHIVE'], 'POST /api/cmp/clients/:id/restore': ['ARCHIVE'],
    'GET /api/cmp/fields': ['VIEW'], 'POST /api/cmp/fields': ['SETUP'], 'PUT /api/cmp/fields/:id': ['SETUP'],
    'POST /api/cmp/clients/:id/obligations': ['OBLIGATION_EDIT'], 'GET /api/cmp/suggest/obligations': ['VIEW'],
    'GET /api/cmp/obligations/:id': ['VIEW'], 'PUT /api/cmp/obligations/:id': ['OBLIGATION_EDIT'], 'PUT /api/cmp/obligations/:id/reminders': ['OBLIGATION_EDIT'],
    'POST /api/cmp/obligations/:id/next': ['OBLIGATION_EDIT'], 'POST /api/cmp/obligations/:id/archive': ['ARCHIVE'], 'POST /api/cmp/obligations/:id/restore': ['ARCHIVE'], 'POST /api/cmp/obligations/:id/delete': ['ARCHIVE'],
    'GET /api/cmp/occurrences': ['VIEW'], 'PUT /api/cmp/occurrences/:id': ['OBLIGATION_EDIT'],
    'POST /api/cmp/occurrences/:id/stage': ['COMPLETE'], 'POST /api/cmp/occurrences/:id/complete': ['COMPLETE'], 'POST /api/cmp/occurrences/:id/reopen': ['COMPLETE'],
    'GET /api/cmp/templates': ['VIEW'], 'GET /api/cmp/templates/context': ['VIEW'], 'POST /api/cmp/templates': ['SETUP'], 'PUT /api/cmp/templates/:id': ['SETUP'], 'DELETE /api/cmp/templates/:id': ['SETUP'],
    'POST /api/cmp/messages/prepare': ['WHATSAPP'], 'POST /api/cmp/messages': ['WHATSAPP'], 'POST /api/cmp/messages/:id/void': ['WHATSAPP'], 'POST /api/cmp/messages/manual': ['WHATSAPP', 'COMPLETE'], 'GET /api/cmp/messages': ['LOGS'],
    'GET /api/cmp/notifications': ['REPORTS', 'WHATSAPP'], 'GET /api/cmp/alerts': ['VIEW'],
    'GET /api/cmp/activity': ['LOGS'],
    'GET /api/cmp/my-tasks': ['VIEW'],
    'POST /api/cmp/bulk/next-period': ['OBLIGATION_EDIT'], 'POST /api/cmp/bulk/assign': ['CLIENT_EDIT', 'OBLIGATION_EDIT'], 'POST /api/cmp/bulk/stage': ['COMPLETE'], 'POST /api/cmp/bulk/archive': ['ARCHIVE'],
    'GET /api/cmp/invoices': ['INVOICE'], 'POST /api/cmp/invoices': ['INVOICE'], 'GET /api/cmp/invoices/:id': ['INVOICE'], 'PUT /api/cmp/invoices/:id': ['INVOICE'], 'DELETE /api/cmp/invoices/:id': ['INVOICE'],
    'POST /api/cmp/invoices/:id/issue': ['INVOICE'], 'POST /api/cmp/invoices/:id/sent': ['INVOICE'], 'POST /api/cmp/invoices/:id/unsent': ['INVOICE'], 'POST /api/cmp/invoices/:id/cancel': ['INVOICE'], 'POST /api/cmp/invoices/:id/receipts': ['INVOICE'],
    'GET /api/cmp/receipts': ['INVOICE'], 'POST /api/cmp/receipts/:id/void': ['INVOICE'],
    'GET /api/cmp/taxes': ['INVOICE', 'SETUP'], 'POST /api/cmp/taxes': ['INVOICE', 'SETUP'], 'PUT /api/cmp/taxes/:id': ['INVOICE', 'SETUP'],
    'GET /api/cmp/items': ['INVOICE', 'SETUP'], 'POST /api/cmp/items': ['INVOICE', 'SETUP'], 'PUT /api/cmp/items/:id': ['INVOICE', 'SETUP'],
    'GET /api/cmp/dashboard': ['REPORTS'], 'GET /api/cmp/calendar': ['VIEW'], 'GET /api/cmp/reports/:kind': ['REPORTS'], 'GET /api/cmp/export/:kind': ['EXPORT'],
};

test('every compliance route checks the module and its own permission', () => {
    const app = { use() {}, param() {} };
    for (const m of ['get', 'post', 'put', 'delete', 'patch']) app[m] = () => {};
    const routes = registerCmpRoutes(app, { svc: { clients: {}, obligations: {}, comms: {}, invoices: {}, bulk: {}, reports: {} }, authenticateToken() {}, requireTenant() {}, tenantModules: () => [], prisma: {}, HttpError: Error, listAudit() {} });
    const seen = new Set();
    for (const r of routes) {
        const key = `${r.method} ${r.path}`;
        assert.ok(!seen.has(key), 'twice: ' + key); seen.add(key);
        assert.ok(key in PERMS, `no permission is listed for ${key}: add it to this test with the permission it must ask for`);
        assert.ok(r.guarded, `${key} does not check the module`);
        assert.deepStrictEqual(r.perms, PERMS[key], key);
    }
    for (const key of Object.keys(PERMS)) assert.ok(seen.has(key), 'listed but not registered: ' + key);
});
