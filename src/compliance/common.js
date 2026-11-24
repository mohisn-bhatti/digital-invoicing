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
    firmName: '', firmAddress: '', firmPhone: '', firmEmail: '', firmTaxNo: '', bankDetails: '', invoiceFooter: '', invoiceFormat: 'INV-{YYYY}-{NNNN}', receiptFormat: 'RCT-{YYYY}-{NNNN}', waSenders: [],
    logo: '', invoiceHeader: '', headerStyle: 'LOGO', letterhead: '', advanceFormat: 'ADV-{YYYY}-{NNNN}',
    // the CA's Settings (24 Nov 2026)
    dateFormat: 'D MMM YYYY', numberFormat: '1,234.56', firmCountry: '', firmCity: '', firmWebsite: '', weekendDays: [], holidayMode: 'NONE', holidays: [],
    notifyHour: 9, notifyPrefs: {}, notifyRules: {}, sessionMinutes: 30 };

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
    // Every template named by these reminders must be one of the firm's own, still in use, a reminder template (1st, 2nd or 3rd; the CA,
    // 24 Nov 2026) and, when the client's country is given, for that country or every country
    async function checkTemplates(tenantId, reminders, db = prisma, { country } = {}) {
        const ids = [...new Set(reminders.map(r => r.templateId).filter(Boolean))]; // (a reminder with its own message names none)
        if (!ids.length) return;
        const found = await db.cmpTemplate.findMany({ where: { tenantId, id: { in: ids }, active: true }, select: { id: true, name: true, purpose: true, country: true } });
        if (found.length !== ids.length) throw bad('Choose a message template for each reminder (one of your templates that is still in use).');
        const R = require('../../public/cmp-rules');
        for (const t of found) {
            if (!/^REMINDER/.test(t.purpose)) throw bad(`"${t.name}" is not a reminder template (its category is ${R.templateCategory(t.purpose)}).`);
            if (country && t.country && t.country !== country) throw bad(`"${t.name}" is for ${countryName(t.country)} clients.`);
        }
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
    // Something happened that the notifications want to hear about (src/compliance/notify.js): never throws, never holds up the request
    const hooks = { notify: null };
    const notify = (ctx, kind, data = {}) => {
        if (!hooks.notify) return Promise.resolve();
        return Promise.resolve().then(() => hooks.notify.event(ctx, kind, data)).catch(err => console.error('compliance notification failed:', kind, err.message));
    };
    // The fields that changed, for the activity log's details (the CA's history reports: field, old value, new value):
    // labels = { key: 'Label' }; values are compared and written as text ('' for none)
    const changes = (before, after, labels) => Object.entries(labels).map(([k, field]) => {
        const txt = v => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));
        return { field, old: txt(before[k]), new: txt(after[k]) };
    }).filter(c => c.old !== c.new);
    return { settings, findClient, findObligation, findOccurrence, checkTemplates, assignee, assigneeFilter, countryName, clientLabel, hooks, notify, changes };
}

module.exports = { CmpError, bad, notFound, DEFAULT_SETTINGS, createCommon, ciContains };
