// Point of Sale API: /api/pos/*. A separate product from Digital Invoicing: only the login, the roles, the audit log and the
// encryption key are shared with it.
//
// Who may do what (the SRS's three user classes, mapped to the business's own roles):
//   Cashier        (CASHIER)     make sales, send again, correct the buyer, reprint receipts, see sales
//   Manager        (ACCOUNTANT)  also items, returns (credit notes), cancel, record the result of a manual PRA check
//   Administrator  (OWNER)       also the business profile, branches, counters, PRA tokens, decommissioning
const path = require('path');
const { PosError } = require('./service');
const { PosCalcError } = require('./calc');
const { PosValidationError } = require('./validate');
const { PosStateError } = require('./states');

function registerPosRoutes(app, { service, pra, authenticateToken, requireTenant, requireTenantRole, tenantModules, prisma, HttpError }) {
    const translate = e => {
        if (e instanceof PosError) return new HttpError(e.status, e.message);
        if (e instanceof PosValidationError || e instanceof PosCalcError || e instanceof PosStateError) return new HttpError(400, e.message);
        return e;
    };
    // the business must have the Point of Sale module switched on
    const requirePos = async (req, res, next) => {
        const t = await prisma.tenant.findUnique({ where: { id: req.user.tenantId }, select: { modules: true } });
        if (!tenantModules(t).includes('POS')) throw new HttpError(403, 'Point of Sale is not switched on for this business.');
        next();
    };
    const base = [authenticateToken, requireTenant, requirePos];
    const manager = [...base, requireTenantRole('OWNER', 'ACCOUNTANT')];
    const owner = [...base, requireTenantRole('OWNER')];
    const ctxOf = req => ({ tenantId: req.user.tenantId, email: req.user.email, req });
    const wrap = fn => async (req, res) => {
        try { res.json(await fn(req)); } catch (e) { throw translate(e); }
    };

    // the same money maths the server uses, for the cashier screen's preview
    app.get('/pos-calc.js', (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('js').sendFile(path.join(__dirname, 'calc.js')); });

    app.get('/api/pos/setup', ...base, wrap(req => service.cashierSetup(ctxOf(req))));
    app.get('/api/pos/overview', ...base, wrap(req => service.overview(ctxOf(req))));

    app.get('/api/pos/egress-ip', ...owner, wrap(() => pra.egressIp()));
    app.get('/api/pos/profile', ...base, wrap(req => service.getProfile(req.user.tenantId)));
    app.put('/api/pos/profile', ...owner, wrap(req => service.saveProfile(ctxOf(req), req.body || {})));

    app.get('/api/pos/branches', ...manager, wrap(req => service.listBranches(req.user.tenantId)));
    app.post('/api/pos/branches', ...owner, wrap(async req => { await service.createBranch(ctxOf(req), req.body || {}); return service.listBranches(req.user.tenantId); }));
    app.put('/api/pos/branches/:id', ...owner, wrap(async req => { await service.updateBranch(ctxOf(req), req.params.id, req.body || {}); return service.listBranches(req.user.tenantId); }));
    app.post('/api/pos/counters', ...owner, wrap(async req => { await service.createCounter(ctxOf(req), req.body || {}); return service.listBranches(req.user.tenantId); }));
    app.put('/api/pos/counters/:id', ...owner, wrap(async req => { await service.updateCounter(ctxOf(req), req.params.id, req.body || {}); return service.listBranches(req.user.tenantId); }));
    app.post('/api/pos/counters/:id/token', ...owner, wrap(async req => { await service.setToken(ctxOf(req), req.params.id, (req.body || {}).token); return service.listBranches(req.user.tenantId); }));
    app.post('/api/pos/counters/:id/decommission', ...owner, wrap(async req => { const r = await service.decommission(ctxOf(req), req.params.id); return { ...r, branches: await service.listBranches(req.user.tenantId) }; }));

    app.get('/api/pos/items', ...base, wrap(req => service.listItems(req.user.tenantId, { q: req.query.q, activeOnly: req.query.active === '1' })));
    app.post('/api/pos/items', ...manager, wrap(req => service.createItem(ctxOf(req), req.body || {})));
    app.put('/api/pos/items/:id', ...manager, wrap(req => service.updateItem(ctxOf(req), req.params.id, req.body || {})));
    app.get('/api/pos/pct', ...manager, wrap(req => service.searchPct(req.query.q)));

    app.post('/api/pos/sales', ...base, wrap(req => service.createSale(ctxOf(req), req.body || {})));
    app.get('/api/pos/sales', ...base, wrap(req => service.listSales(ctxOf(req), req.query)));
    app.get('/api/pos/sales/:id', ...base, wrap(req => service.saleDetail(ctxOf(req), req.params.id)));
    app.get('/api/pos/sales/:id/receipt', ...base, wrap(req => service.receipt(ctxOf(req), req.params.id)));
    app.patch('/api/pos/sales/:id', ...base, wrap(async req => { await service.updateBuyer(ctxOf(req), req.params.id, (req.body || {}).buyer || req.body); return service.saleDetail(ctxOf(req), req.params.id); }));
    app.post('/api/pos/sales/:id/retry', ...base, wrap(req => service.retry(ctxOf(req), req.params.id)));
    app.post('/api/pos/sales/:id/cancel', ...manager, wrap(async req => { await service.cancel(ctxOf(req), req.params.id, (req.body || {}).reason); return service.saleDetail(ctxOf(req), req.params.id); }));
    app.post('/api/pos/sales/:id/resolve', ...manager, wrap(async req => { await service.resolve(ctxOf(req), req.params.id, req.body || {}); return service.saleDetail(ctxOf(req), req.params.id); }));
    app.post('/api/pos/sales/:id/credit-note', ...manager, wrap(req => service.creditNote(ctxOf(req), req.params.id, req.body || {})));
}

module.exports = { registerPosRoutes };
