// Compliance & Deadlines API: /api/cmp/*. A separate product: only the login, the audit log and the encryption key are shared.
// Who may do what is the user's own list of permissions (User.cmpPerms, public/cmp-perms.js), which only the ETAX administrator sets.
// Every route checks the module and one permission here, on the server (SRS 2); test/cmpRouteGuards.test.js holds each route to its
// permission, so a route cannot be added without one.
const CmpPerms = require('../../public/cmp-perms');
const { CmpError } = require('./common');
const { guardPrefix } = require('../requestGuard');

const NO_PERM = {
    VIEW: 'see the clients and obligations', CLIENT_EDIT: 'add or change clients', OBLIGATION_EDIT: 'add or change obligations and reminders', WHATSAPP: 'send WhatsApp messages',
    INVOICE: 'issue invoices and receipts', COMPLETE: 'change the status of obligations', SETUP: 'manage templates and custom fields', REPORTS: 'see the notifications and reports',
    LOGS: 'see the message and activity logs', EXPORT: 'export data', ARCHIVE: 'archive or restore', SECRETS: 'see portal passwords and PIN codes', FULL: 'change the module settings',
};

function registerCmpRoutes(app, { svc, authenticateToken, requireTenant, tenantModules, prisma, HttpError, listAudit }) {
    const translate = e => (e instanceof CmpError ? new HttpError(e.status, e.message) : e);
    // the business must have the module switched on; the user's permissions are read fresh on every request (a change applies at once)
    const requireCompliance = async (req, res, next) => {
        const t = await prisma.tenant.findUnique({ where: { id: req.user.tenantId }, select: { modules: true } });
        if (!tenantModules(t).includes('COMPLIANCE')) throw new HttpError(403, 'Compliance & Deadlines is not switched on for this business.');
        let stored;
        if (req.user.impersonatedBy) stored = ['FULL']; // the administrator working in the firm's workspace
        else stored = ((await prisma.user.findUnique({ where: { id: req.user.id }, select: { cmpPerms: true } })) || {}).cmpPerms || [];
        req.cmp = { perms: CmpPerms.effective(stored) };
        next();
    };
    // any one of these permissions lets the request through
    const requirePerm = (...anyOf) => {
        const fn = (req, res, next) => {
            if (!anyOf.some(p => req.cmp.perms.has(p))) throw new HttpError(403, `You do not have permission to ${NO_PERM[anyOf[0]] || 'do this'}. Ask the ETAX administrator.`);
            next();
        };
        fn.perms = anyOf;
        return fn;
    };
    guardPrefix(app, '/api/cmp', HttpError);

    const base = [authenticateToken, requireTenant, requireCompliance];
    const can = (...p) => [...base, requirePerm(...p)];
    const ctxOf = req => ({ tenantId: req.user.tenantId, userId: req.user.impersonatedBy ? null : req.user.id, email: req.user.email, req, perms: req.cmp.perms });
    const routes = [];
    const route = (method, path, chain, handler) => {
        routes.push({ method: method.toUpperCase(), path, perms: (chain.find(f => f.perms) || {}).perms || null, guarded: chain.includes(requireCompliance) });
        app[method](path, ...chain, async (req, res) => {
            try {
                const out = await handler(req, ctxOf(req), res);
                if (!res.headersSent) res.json(out);
            } catch (e) { throw translate(e); }
        });
    };
    const { clients, obligations, comms, invoices, bulk, reports } = svc;

    // who I am here: my permissions, the firm's settings and its team (for the screens)
    // (a user without any permission here learns only that: not the firm's settings, bank details or team)
    route('get', '/api/cmp/me', base, async (req, ctx) => {
        const may = ctx.perms.has('VIEW');
        return {
            perms: [...ctx.perms], workspace: Boolean(req.user.impersonatedBy),
            settings: may ? await clients.getSettings(ctx) : { timeZone: (await clients.getSettings(ctx)).timeZone },
            team: may ? await prisma.user.findMany({ where: { tenantId: ctx.tenantId, role: 'CLIENT_USER', active: true }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } }) : [],
        };
    });
    route('get', '/api/cmp/settings', can('VIEW'), (req, ctx) => clients.getSettings(ctx));
    route('put', '/api/cmp/settings', can('FULL'), (req, ctx) => clients.putSettings(ctx, req.body || {}));

    // clients (SRS 3)
    route('get', '/api/cmp/clients', can('VIEW'), (req, ctx) => clients.list(ctx, req.query));
    route('post', '/api/cmp/clients', can('CLIENT_EDIT'), (req, ctx) => clients.create(ctx, req.body || {}));
    // the client's 360° view (SRS 11): details, fields, obligations; its messages and history for those who may see the logs
    route('get', '/api/cmp/clients/:id', can('VIEW'), async (req, ctx) => {
        const out = await clients.get(ctx, req.params.id);
        out.obligations = await obligations.forClient(ctx, out.client.id);
        if (ctx.perms.has('INVOICE')) out.invoices = (await invoices.list(ctx, { clientId: out.client.id })).invoices;
        if (ctx.perms.has('LOGS')) {
            out.messages = (await prisma.cmpMessage.findMany({ where: { tenantId: ctx.tenantId, clientId: out.client.id }, orderBy: { createdAt: 'desc' }, take: 100,
                include: { occurrence: { select: { seq: true, obligation: { select: { name: true } } } } } }))
                .map(m => ({ id: m.id, createdAt: m.createdAt, kind: m.kind, templateName: m.templateName, phone: m.phone, body: m.body, userEmail: m.userEmail, voidedAt: m.voidedAt, obligation: m.occurrence ? m.occurrence.obligation.name : '' }));
            out.activity = await prisma.auditLog.findMany({ where: { tenantId: ctx.tenantId, action: { startsWith: 'cmp.' }, OR: [{ entityId: out.client.id }, { details: { path: ['clientId'], equals: out.client.id } }] },
                orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, createdAt: true, userEmail: true, action: true, summary: true } });
        }
        return out;
    });
    route('put', '/api/cmp/clients/:id', can('CLIENT_EDIT'), (req, ctx) => clients.update(ctx, req.params.id, req.body || {}));
    route('get', '/api/cmp/clients/:id/secrets', can('SECRETS'), (req, ctx, res) => { res.set('Cache-Control', 'no-store'); return clients.secrets(ctx, req.params.id); });
    route('post', '/api/cmp/clients/:id/archive', can('ARCHIVE'), (req, ctx) => clients.setArchived(ctx, req.params.id, true));
    route('post', '/api/cmp/clients/:id/restore', can('ARCHIVE'), (req, ctx) => clients.setArchived(ctx, req.params.id, false));

    // extra fields (SRS 3.3)
    route('get', '/api/cmp/fields', can('VIEW'), (req, ctx) => clients.listFields(ctx, req.query));
    route('post', '/api/cmp/fields', can('SETUP'), (req, ctx) => clients.createField(ctx, req.body || {}));
    route('put', '/api/cmp/fields/:id', can('SETUP'), (req, ctx) => clients.updateField(ctx, req.params.id, req.body || {}));

    // obligations, their years and reminders (SRS 4, 5)
    route('post', '/api/cmp/clients/:id/obligations', can('OBLIGATION_EDIT'), (req, ctx) => obligations.create(ctx, req.params.id, req.body || {}));
    route('get', '/api/cmp/suggest/obligations', can('VIEW'), (req, ctx) => obligations.suggest(ctx, req.query.country));
    route('get', '/api/cmp/obligations/:id', can('VIEW'), (req, ctx) => obligations.get(ctx, req.params.id));
    route('put', '/api/cmp/obligations/:id', can('OBLIGATION_EDIT'), (req, ctx) => obligations.update(ctx, req.params.id, req.body || {}));
    route('put', '/api/cmp/obligations/:id/reminders', can('OBLIGATION_EDIT'), (req, ctx) => obligations.setReminders(ctx, req.params.id, (req.body || {}).reminders));
    route('post', '/api/cmp/obligations/:id/next', can('OBLIGATION_EDIT'), (req, ctx) => obligations.next(ctx, req.params.id));
    route('post', '/api/cmp/obligations/:id/archive', can('ARCHIVE'), (req, ctx) => obligations.setArchived(ctx, req.params.id, true));
    route('post', '/api/cmp/obligations/:id/restore', can('ARCHIVE'), (req, ctx) => obligations.setArchived(ctx, req.params.id, false));
    route('get', '/api/cmp/occurrences', can('VIEW'), (req, ctx) => obligations.listOccurrences(ctx, req.query));
    route('put', '/api/cmp/occurrences/:id', can('OBLIGATION_EDIT'), (req, ctx) => obligations.updateOccurrence(ctx, req.params.id, req.body || {}));
    route('post', '/api/cmp/occurrences/:id/stage', can('COMPLETE'), (req, ctx) => obligations.setStage(ctx, req.params.id, String((req.body || {}).stage || '')));
    // SRS 9: completed with "Generate invoice" (also needs the invoice permission: a draft is made for the period) or "Close without invoice"
    route('post', '/api/cmp/occurrences/:id/complete', can('COMPLETE'), async (req, ctx) => {
        const mode = String((req.body || {}).mode || 'FREE').toUpperCase();
        if (mode === 'INVOICE' && !ctx.perms.has('INVOICE')) throw new HttpError(403, `You do not have permission to ${NO_PERM.INVOICE}. Close it without an invoice, or ask the ETAX administrator.`);
        // the same transaction makes the draft (or finds the invoice already made for this period, e.g. after a reopen)
        return obligations.complete(ctx, req.params.id, mode, { makeInvoice: async tx => {
            const existing = await tx.cmpInvoice.findFirst({ where: { tenantId: ctx.tenantId, occurrenceId: req.params.id, status: { not: 'CANCELLED' } }, select: { id: true } });
            return existing ? existing.id : (await invoices.draftFor(ctx, { occurrenceId: req.params.id }, tx)).id;
        } });
    });
    route('post', '/api/cmp/occurrences/:id/reopen', can('COMPLETE'), (req, ctx) => obligations.reopen(ctx, req.params.id));

    // templates (SRS 7)
    route('get', '/api/cmp/templates', can('VIEW'), (req, ctx) => comms.listTemplates(ctx, req.query));
    route('post', '/api/cmp/templates', can('SETUP'), (req, ctx) => comms.createTemplate(ctx, req.body || {}));
    route('put', '/api/cmp/templates/:id', can('SETUP'), (req, ctx) => comms.updateTemplate(ctx, req.params.id, req.body || {}));
    route('delete', '/api/cmp/templates/:id', can('SETUP'), (req, ctx) => comms.deleteTemplate(ctx, req.params.id));

    // WhatsApp and its log (SRS 8)
    route('post', '/api/cmp/messages/prepare', can('WHATSAPP'), (req, ctx) => comms.prepare(ctx, req.body || {}));
    route('post', '/api/cmp/messages', can('WHATSAPP'), (req, ctx) => comms.send(ctx, req.body || {}));
    route('post', '/api/cmp/messages/:id/void', can('WHATSAPP'), (req, ctx) => comms.voidMessage(ctx, req.params.id));
    route('get', '/api/cmp/messages', can('LOGS'), (req, ctx, res) => comms.listMessages(ctx, req.query, res));

    // notifications (SRS 6, 11): the dashboard for those who report or send; the counts for the bell for everyone
    route('get', '/api/cmp/notifications', can('REPORTS', 'WHATSAPP'), (req, ctx) => comms.notifications(ctx, req.query));
    route('get', '/api/cmp/alerts', can('VIEW'), (req, ctx) => comms.alerts(ctx));

    // team work (SRS 10): my tasks, and bulk actions (each item done or skipped with its reason)
    route('get', '/api/cmp/my-tasks', can('VIEW'), async (req, ctx) => ({
        ...(await obligations.listOccurrences(ctx, { ...req.query, assignee: 'me', status: req.query.status || 'OPEN' })),
        clients: ctx.userId ? (await clients.list(ctx, { assignee: 'me' })).clients : [],
    }));
    route('post', '/api/cmp/bulk/next-period', can('OBLIGATION_EDIT'), (req, ctx) => bulk.nextPeriod(ctx, (req.body || {}).obligationIds));
    route('post', '/api/cmp/bulk/assign', can('CLIENT_EDIT', 'OBLIGATION_EDIT'), (req, ctx) => {
        const b = req.body || {};
        if (b.clientIds && !ctx.perms.has('CLIENT_EDIT')) throw new HttpError(403, `You do not have permission to ${NO_PERM.CLIENT_EDIT}.`);
        if (b.obligationIds && !ctx.perms.has('OBLIGATION_EDIT')) throw new HttpError(403, `You do not have permission to ${NO_PERM.OBLIGATION_EDIT}.`);
        return bulk.assign(ctx, b);
    });
    route('post', '/api/cmp/bulk/stage', can('COMPLETE'), (req, ctx) => bulk.stage(ctx, req.body || {}));
    route('post', '/api/cmp/bulk/archive', can('ARCHIVE'), (req, ctx) => bulk.archive(ctx, req.body || {}));

    // fee invoices, receipts and their taxes (SRS 9)
    route('get', '/api/cmp/invoices', can('INVOICE'), (req, ctx) => invoices.list(ctx, req.query));
    route('post', '/api/cmp/invoices', can('INVOICE'), (req, ctx) => invoices.create(ctx, req.body || {}));
    route('get', '/api/cmp/invoices/:id', can('INVOICE'), (req, ctx) => invoices.get(ctx, req.params.id));
    route('put', '/api/cmp/invoices/:id', can('INVOICE'), (req, ctx) => invoices.update(ctx, req.params.id, req.body || {}));
    route('delete', '/api/cmp/invoices/:id', can('INVOICE'), (req, ctx) => invoices.remove(ctx, req.params.id));
    route('post', '/api/cmp/invoices/:id/issue', can('INVOICE'), (req, ctx) => invoices.issue(ctx, req.params.id));
    route('post', '/api/cmp/invoices/:id/sent', can('INVOICE'), (req, ctx) => invoices.markSent(ctx, req.params.id));
    route('post', '/api/cmp/invoices/:id/cancel', can('INVOICE'), (req, ctx) => invoices.cancel(ctx, req.params.id, (req.body || {}).reason));
    route('post', '/api/cmp/invoices/:id/receipts', can('INVOICE'), (req, ctx) => invoices.addReceipt(ctx, req.params.id, req.body || {}));
    route('get', '/api/cmp/receipts', can('INVOICE'), (req, ctx) => invoices.listReceipts(ctx, req.query));
    route('post', '/api/cmp/receipts/:id/void', can('INVOICE'), (req, ctx) => invoices.voidReceipt(ctx, req.params.id, (req.body || {}).reason));
    route('get', '/api/cmp/taxes', can('INVOICE', 'SETUP'), (req, ctx) => invoices.listTaxRates(ctx, req.query));
    route('post', '/api/cmp/taxes', can('INVOICE', 'SETUP'), (req, ctx) => invoices.createTaxRate(ctx, req.body || {}));
    route('put', '/api/cmp/taxes/:id', can('INVOICE', 'SETUP'), (req, ctx) => invoices.updateTaxRate(ctx, req.params.id, req.body || {}));

    // dashboard, calendar, reports and downloads (SRS 11, 13)
    route('get', '/api/cmp/dashboard', can('REPORTS'), (req, ctx) => reports.dashboard(ctx, req.query));
    route('get', '/api/cmp/calendar', can('VIEW'), (req, ctx) => reports.calendar(ctx, req.query));
    route('get', '/api/cmp/reports/:kind', can('REPORTS'), (req, ctx) => {
        if (req.params.kind === 'aging' && !ctx.perms.has('INVOICE')) throw new HttpError(403, `You do not have permission to ${NO_PERM.INVOICE}.`);
        return reports.report(ctx, req.params.kind, req.query);
    });
    // a download needs the export permission AND the permission to see that data
    route('get', '/api/cmp/export/:kind', can('EXPORT'), (req, ctx, res) => {
        const need = reports.KINDS[req.params.kind];
        if (need && !ctx.perms.has(need)) throw new HttpError(403, `You do not have permission to ${NO_PERM[need]}.`);
        if (req.params.kind === 'aging' && !ctx.perms.has('INVOICE')) throw new HttpError(403, `You do not have permission to ${NO_PERM.INVOICE}.`);
        return reports.exportCsv(ctx, req.params.kind, req.query, res);
    });

    // the activity log (SRS 12): only this module's actions of this firm (the ETAX log itself stays with the administrator)
    route('get', '/api/cmp/activity', can('LOGS'), async (req, ctx, res) => {
        const settings = await clients.getSettings(ctx);
        await listAudit({ tenantId: ctx.tenantId }, req.query, res, req, { actionPrefix: 'cmp.', exportAction: 'cmp.log.export', timeZone: settings.timeZone, filename: 'compliance-activity-log' });
    });

    return routes;
}

module.exports = { registerCmpRoutes };
