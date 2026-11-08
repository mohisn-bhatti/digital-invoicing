// What the parts of the Compliance & Deadlines module share: the error they throw, the firm's settings, finding a client or an
// obligation of THIS firm (another firm's id is simply "not found"), and searching without ILIKE wildcards.
const C = require('../../public/cmp-countries');
const { ciContains } = require('../pos/like');

class CmpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}
const bad = msg => new CmpError(400, msg);
const notFound = what => new CmpError(404, `${what} not found.`);

const DEFAULT_SETTINGS = { timeZone: 'Asia/Karachi', reminderHour: 9, amberDays: 7, autoNextYear: true,
    firmName: '', firmAddress: '', firmPhone: '', firmEmail: '', firmTaxNo: '', bankDetails: '', invoiceFooter: '', invoiceFormat: 'INV-{YYYY}-{NNNN}', receiptFormat: 'RCT-{YYYY}-{NNNN}', waSenders: [] };

function createCommon({ prisma }) {
    async function settings(tenantId, db = prisma) {
        const s = await db.cmpSettings.findUnique({ where: { tenantId } });
        return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(k => [k, s ? s[k] : DEFAULT_SETTINGS[k]])); // (not the running numbers)
    }
    // live = refuse an archived client (nothing new is added to it until it is restored)
    async function findClient(tenantId, id, { live = false, db = prisma } = {}) {
        const c = await db.cmpClient.findFirst({ where: { id: String(id || ''), tenantId } });
        if (!c) throw notFound('Client');
        if (live && c.archivedAt) throw new CmpError(409, 'This client is archived. Restore it first.');
        return c;
    }
    async function findObligation(tenantId, id, { live = false, db = prisma } = {}) {
        const o = await db.cmpObligation.findFirst({ where: { id: String(id || ''), tenantId }, include: { client: true } });
        if (!o) throw notFound('Obligation');
        if (live && (o.archivedAt || o.client.archivedAt)) throw new CmpError(409, o.client.archivedAt ? 'This client is archived. Restore it first.' : 'This obligation is archived. Restore it first.');
        return o;
    }
    async function findOccurrence(tenantId, id, { live = false, db = prisma } = {}) {
        const occ = await db.cmpOccurrence.findFirst({ where: { id: String(id || ''), tenantId }, include: { obligation: { include: { client: true, reminders: { include: { template: { select: { id: true, name: true, active: true } } } } } } } });
        if (!occ) throw notFound('Obligation year');
        if (live && (occ.obligation.archivedAt || occ.obligation.client.archivedAt)) throw new CmpError(409, 'This obligation is archived. Restore it first.');
        return occ;
    }
    // Every template named by these reminders must be one of the firm's own, and still in use
    async function checkTemplates(tenantId, reminders, db = prisma) {
        const ids = [...new Set(reminders.map(r => r.templateId))];
        if (!ids.length) return;
        const found = await db.cmpTemplate.findMany({ where: { tenantId, id: { in: ids }, active: true }, select: { id: true } });
        if (found.length !== ids.length) throw bad('Choose a message template for each reminder (one of your templates that is still in use).');
    }
    // SRS 10: a client or obligation is given to a team member of THIS firm ('' or null = nobody)
    async function assignee(tenantId, id, db = prisma) {
        if (id === undefined) return undefined;
        if (id === null || id === '') return null;
        const u = await db.user.findFirst({ where: { id: String(id), tenantId, role: 'CLIENT_USER', active: true }, select: { id: true } });
        if (!u) throw bad('Choose a team member of this firm.');
        return u.id;
    }
    // ?assignee=me / none / a user id → a filter on a field that holds the assignee
    const assigneeFilter = (v, me) => (v === 'none' ? null : v === 'me' ? (me || '-') : String(v)); // ('-' matches nobody: the administrator in a workspace has no tasks)
    const countryName = code => (C.get(code) || { name: code }).name;
    const clientLabel = c => `${c.name} (${c.code})`;
    return { settings, findClient, findObligation, findOccurrence, checkTemplates, assignee, assigneeFilter, countryName, clientLabel };
}

module.exports = { CmpError, bad, notFound, DEFAULT_SETTINGS, createCommon, ciContains };
