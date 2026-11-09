// The firm's clients (SRS 3), their extra fields (SRS 3.3), archiving (SRS 14) and the module's settings.
// The portal password and PIN are encrypted and never listed; seeing them is its own permission and is written in the activity log.
const R = require('../../public/cmp-rules');
const V = require('./validate');
const { CmpError, bad, ciContains } = require('./common');

const pad = (n, w) => String(n).padStart(w, '0');
const applies = (def, country) => def.active && (def.allCountries || def.countries.includes(country));

function createClients({ prisma, audit, encrypt, decrypt, common, now }) {
    const log = (ctx, action, entityId, summary, details = {}) => audit(ctx.req, { tenantId: ctx.tenantId, action, entityType: 'CmpClient', entityId, summary, details });

    /* ---------- settings ---------- */
    const getSettings = ctx => common.settings(ctx.tenantId);
    async function putSettings(ctx, b) {
        const data = V.cleanSettings(b || {});
        const before = await common.settings(ctx.tenantId);
        await prisma.cmpSettings.upsert({ where: { tenantId: ctx.tenantId }, create: { tenantId: ctx.tenantId, ...data }, update: data });
        const after = await common.settings(ctx.tenantId);
        const SHOWN = ['timeZone', 'reminderHour', 'amberDays', 'autoNextYear', 'invoiceFormat', 'receiptFormat'];
        const what = Object.keys(data).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map(k => (SHOWN.includes(k) ? `${k} ${before[k]} → ${after[k]}` : k === 'waSenders' ? `WhatsApp numbers: ${after.waSenders.map(s => `${s.label} ${s.phone}`).join(', ') || 'none'}` : k));
        if (what.length) await audit(ctx.req, { tenantId: ctx.tenantId, action: 'cmp.settings.update', entityType: 'CmpSettings', entityId: ctx.tenantId, summary: `Compliance settings: ${what.join(', ')}` });
        return after;
    }

    /* ---------- field definitions ---------- */
    async function listFields(ctx, q = {}) {
        const defs = await prisma.cmpFieldDef.findMany({ where: { tenantId: ctx.tenantId, ...(q.all === '1' ? {} : { active: true }) }, orderBy: [{ active: 'desc' }, { name: 'asc' }], include: { _count: { select: { values: true } } } });
        const country = q.country ? V.country(q.country).code : null;
        return defs.filter(d => !country || d.allCountries || d.countries.includes(country)).map(d => ({
            id: d.id, name: d.name, type: d.type, allCountries: d.allCountries, countries: d.countries, active: d.active, values: d._count.values, createdBy: d.createdBy, createdAt: d.createdAt,
        }));
    }
    const scopeText = d => (d.allCountries ? 'all countries' : d.countries.join(', '));
    async function createField(ctx, b) {
        const d = V.cleanFieldDef(b || {}, { defaultCountry: b && b.defaultCountry });
        try {
            const def = await prisma.cmpFieldDef.create({ data: { tenantId: ctx.tenantId, ...d, createdBy: ctx.email } });
            await audit(ctx.req, { tenantId: ctx.tenantId, action: 'cmp.field.create', entityType: 'CmpFieldDef', entityId: def.id, summary: `Field "${def.name}" (${V.FIELD_TYPES[def.type].toLowerCase()}) added for ${scopeText(def)}` });
            return def;
        } catch (e) { if (e.code === 'P2002') throw new CmpError(409, 'There is already a field with that name.'); throw e; }
    }
    async function updateField(ctx, id, b) {
        const def = await prisma.cmpFieldDef.findFirst({ where: { id: String(id || ''), tenantId: ctx.tenantId }, include: { _count: { select: { values: true } } } });
        if (!def) throw new CmpError(404, 'Field not found.');
        const data = {};
        if (b.name !== undefined || b.type !== undefined || b.allCountries !== undefined || b.countries !== undefined) {
            const d = V.cleanFieldDef({ name: b.name ?? def.name, type: b.type ?? def.type, allCountries: b.allCountries ?? def.allCountries, countries: b.countries ?? def.countries }, { keepKey: def.key });
            if (d.type !== def.type && def._count.values) throw bad(`"${def.name}" already has values for ${def._count.values} client(s): its type cannot change. Add a new field instead.`);
            Object.assign(data, d);
        }
        if (b.active !== undefined) data.active = b.active === true;
        let upd;
        try { upd = await prisma.cmpFieldDef.update({ where: { id: def.id }, data }); } catch (e) { if (e.code === 'P2002') throw new CmpError(409, 'There is already a field with that name.'); throw e; }
        const what = [data.name && data.name !== def.name && `renamed "${def.name}" → "${data.name}"`, data.type && data.type !== def.type && `type → ${V.FIELD_TYPES[data.type].toLowerCase()}`,
            (data.allCountries !== undefined && (data.allCountries !== def.allCountries || data.countries.join() !== def.countries.join())) && `for ${scopeText(upd)}`].filter(Boolean);
        if (what.length) await audit(ctx.req, { tenantId: ctx.tenantId, action: 'cmp.field.update', entityType: 'CmpFieldDef', entityId: def.id, summary: `Field "${upd.name}": ${what.join(', ')}` });
        if (data.active !== undefined && data.active !== def.active) await audit(ctx.req, { tenantId: ctx.tenantId, action: data.active ? 'cmp.field.restore' : 'cmp.field.retire', entityType: 'CmpFieldDef', entityId: def.id, summary: `Field "${upd.name}" ${data.active ? 'back in use' : 'retired (its values are kept, hidden)'}` });
        return upd;
    }

    /* ---------- clients ---------- */
    const listView = c => ({ id: c.id, code: c.code, country: c.country, timeZone: c.timeZone, name: c.name, contactNumber: c.contactNumber, email: c.email, registrationNo: c.registrationNo, reference: c.reference, noWhatsApp: c.noWhatsApp, assignedToId: c.assignedToId, archivedAt: c.archivedAt, createdAt: c.createdAt });
    const fullView = c => ({ ...listView(c), address: c.address, noPortal: c.noPortal, noWhatsApp: c.noWhatsApp, portalUsername: c.portalUsername, hasPassword: Boolean(c.portalPasswordEnc), hasPin: Boolean(c.pinCodeEnc), archivedBy: c.archivedBy, createdBy: c.createdBy, updatedAt: c.updatedAt });

    async function list(ctx, q = {}) {
        const where = { tenantId: ctx.tenantId, archivedAt: q.archived === '1' ? { not: null } : null };
        if (q.country) where.country = V.country(q.country).code;
        if (q.assignee) where.assignedToId = common.assigneeFilter(q.assignee, ctx.userId);
        const s = String(q.q || '').trim().slice(0, 100);
        if (s) where.OR = ['name', 'code', 'email', 'registrationNo', 'contactNumber', 'reference'].map(f => ({ [f]: ciContains(s) }));
        const [rows, total, defs] = await Promise.all([
            prisma.cmpClient.findMany({ where, orderBy: { name: 'asc' }, take: 1000 }),
            prisma.cmpClient.count({ where }),
            prisma.cmpFieldDef.findMany({ where: { tenantId: ctx.tenantId, active: true } }),
        ]);
        const ids = rows.map(r => r.id), at = now();
        const [values, open] = ids.length ? await Promise.all([
            prisma.cmpFieldValue.findMany({ where: { clientId: { in: ids } }, select: { clientId: true, fieldId: true } }),
            prisma.cmpOccurrence.findMany({ where: { clientId: { in: ids }, stage: { not: 'COMPLETED' }, obligation: { archivedAt: null } }, select: { clientId: true, dueAt: true } }),
        ]) : [[], []];
        const have = new Set(values.map(v => `${v.clientId}:${v.fieldId}`));
        const counts = new Map(); // client id → open and overdue periods, counted in one pass
        for (const o of open) { const n = counts.get(o.clientId) || { open: 0, overdue: 0 }; n.open++; if (o.dueAt <= at) n.overdue++; counts.set(o.clientId, n); }
        let out = rows.map(c => {
            const n = counts.get(c.id) || { open: 0, overdue: 0 };
            return { ...listView(c), openCount: n.open, overdueCount: n.overdue,
                missing: defs.filter(d => applies(d, c.country) && !have.has(`${c.id}:${d.id}`)).map(d => d.name) };
        });
        if (q.missing === '1') out = out.filter(c => c.missing.length);
        return { clients: out, total };
    }

    // The client's extra fields: those for its country (with their value, or "missing"); values of fields that no longer apply stay hidden
    async function fieldsOf(tenantId, client) {
        const [defs, values] = await Promise.all([
            prisma.cmpFieldDef.findMany({ where: { tenantId, active: true }, orderBy: { name: 'asc' } }),
            prisma.cmpFieldValue.findMany({ where: { clientId: client.id } }),
        ]);
        const byField = new Map(values.map(v => [v.fieldId, v.value]));
        return defs.filter(d => applies(d, client.country)).map(d => ({ id: d.id, name: d.name, type: d.type, value: byField.get(d.id) || '', missing: !byField.has(d.id) }));
    }
    async function get(ctx, id) {
        const c = await common.findClient(ctx.tenantId, id);
        return { client: fullView(c), fields: await fieldsOf(ctx.tenantId, c) };
    }

    // The extra fields sent with a client: { fieldId: value }. Only fields for the client's country; '' clears a value.
    async function cleanValues(tenantId, countryCode, given, db = prisma) {
        if (given === undefined || given === null) return [];
        if (typeof given !== 'object' || Array.isArray(given)) throw bad('Fields must be sent as { field id: value }.');
        const ids = Object.keys(given);
        if (ids.length > 200) throw bad('Too many fields.');
        const defs = ids.length ? await db.cmpFieldDef.findMany({ where: { tenantId, id: { in: ids } } }) : [];
        return ids.map(id => {
            const def = defs.find(d => d.id === id);
            if (!def || !applies(def, countryCode)) throw bad('One of the fields is not used for this client\'s country. Reload the page and try again.');
            return { def, value: V.cleanFieldValue(def, given[id]) };
        });
    }
    async function writeValues(tx, tenantId, clientId, vals, email) {
        for (const { def, value } of vals) {
            if (value === '') await tx.cmpFieldValue.deleteMany({ where: { clientId, fieldId: def.id } });
            else await tx.cmpFieldValue.upsert({ where: { clientId_fieldId: { clientId, fieldId: def.id } }, create: { tenantId, clientId, fieldId: def.id, value, updatedBy: email }, update: { value, updatedBy: email } });
        }
    }
    // Codes are given in turn (CL0001, CL0002 ...): two clients added at the same moment never get the same one
    const inTurn = (tenantId, what, work) => prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:${what}`}))`;
        return work(tx);
    }, { maxWait: 10000, timeout: 20000 });
    async function nextCode(tx, tenantId) {
        const rows = await tx.cmpClient.findMany({ where: { tenantId, code: { startsWith: 'CL' } }, select: { code: true } });
        return 'CL' + pad(rows.reduce((m, r) => Math.max(m, /^CL(\d+)$/.test(r.code) ? Number(r.code.slice(2)) : 0), 0) + 1, 4);
    }

    async function create(ctx, b) {
        const { data, password, pin } = V.cleanClient(b || {}, { creating: true });
        data.assignedToId = (await common.assignee(ctx.tenantId, b.assignedToId)) || null;
        const vals = await cleanValues(ctx.tenantId, data.country, b.fields);
        const c = await inTurn(ctx.tenantId, 'cmp-client-code', async tx => {
            const row = await tx.cmpClient.create({ data: { tenantId: ctx.tenantId, code: await nextCode(tx, ctx.tenantId), ...data,
                portalPasswordEnc: password ? encrypt(password) : '', pinCodeEnc: pin ? encrypt(pin) : null, createdBy: ctx.email } });
            await writeValues(tx, ctx.tenantId, row.id, vals, ctx.email);
            return row;
        });
        await log(ctx, 'cmp.client.create', c.id, `Client ${common.clientLabel(c)} added (${common.countryName(c.country)})${vals.filter(v => v.value).length ? `, with ${vals.filter(v => v.value).map(v => v.def.name).join(', ')}` : ''}`, { clientId: c.id });
        return get(ctx, c.id);
    }

    const LABELS = { country: 'country', timeZone: 'time zone', noPortal: 'no online portal', noWhatsApp: 'no WhatsApp', name: 'name', address: 'address', contactNumber: 'contact number', email: 'email', registrationNo: 'registration no.', reference: 'reference', portalUsername: 'username' };
    async function update(ctx, id, b) {
        const c = await common.findClient(ctx.tenantId, id, { live: true });
        // a country change without a new time zone takes the new country's own zone
        const merged = { ...c, ...b, timeZone: b.timeZone || (b.country && b.country !== c.country ? '' : c.timeZone) };
        const { data, password, pin, removePin } = V.cleanClient(merged, { creating: false });
        const who = await common.assignee(ctx.tenantId, b.assignedToId);
        if (who !== undefined) data.assignedToId = who;
        const vals = await cleanValues(ctx.tenantId, data.country, b.fields);
        if (!data.noPortal && !password && !c.portalPasswordEnc) throw bad('Password is required.'); // the client had no portal until now
        const upd = { ...data };
        if (password) upd.portalPasswordEnc = encrypt(password); else if (data.noPortal) upd.portalPasswordEnc = '';
        if (pin) upd.pinCodeEnc = encrypt(pin); else if (removePin) upd.pinCodeEnc = null;
        const zoneChanged = data.timeZone !== c.timeZone;
        const oldValues = new Map((await prisma.cmpFieldValue.findMany({ where: { clientId: c.id } })).map(v => [v.fieldId, v.value]));
        await prisma.$transaction(async tx => {
            await tx.cmpClient.update({ where: { id: c.id }, data: upd });
            await writeValues(tx, ctx.tenantId, c.id, vals, ctx.email);
            // the client's midnights move with its clock
            if (zoneChanged) {
                const occs = await tx.cmpOccurrence.findMany({ where: { clientId: c.id }, select: { id: true, periodEnd: true, dueDate: true } });
                for (const o of occs) await tx.cmpOccurrence.update({ where: { id: o.id }, data: R.instants(o, data.timeZone) });
            }
        }, { timeout: 30000 });
        const what = [
            ...Object.keys(LABELS).filter(k => String(data[k]) !== String(c[k])).map(k => (k === 'country' ? `country ${c.country} → ${data.country}` : LABELS[k])),
            data.assignedToId !== undefined && data.assignedToId !== c.assignedToId && 'assigned to someone else',
            password && 'password changed', data.noPortal && !c.noPortal && c.portalPasswordEnc && 'password removed', pin && 'PIN changed', !pin && removePin && c.pinCodeEnc && 'PIN removed',
            ...vals.filter(v => (oldValues.get(v.def.id) || '') !== v.value).map(v => v.def.name),
        ].filter(Boolean);
        if (what.length) await log(ctx, 'cmp.client.update', c.id, `Client ${common.clientLabel({ ...c, ...data })}: ${[...new Set(what)].join(', ')}`, { clientId: c.id, changed: [...new Set(what)] });
        return get(ctx, c.id);
    }

    async function secrets(ctx, id) {
        const c = await common.findClient(ctx.tenantId, id);
        const out = { portalUsername: c.portalUsername, portalPassword: c.portalPasswordEnc ? decrypt(c.portalPasswordEnc) : '', pinCode: c.pinCodeEnc ? decrypt(c.pinCodeEnc) : '' };
        await log(ctx, 'cmp.client.secrets_view', c.id, `Portal password${c.pinCodeEnc ? ' and PIN' : ''} of ${common.clientLabel(c)} shown`, { clientId: c.id });
        return out;
    }

    async function setArchived(ctx, id, archive) {
        const c = await common.findClient(ctx.tenantId, id);
        if (Boolean(c.archivedAt) === archive) throw new CmpError(409, archive ? 'This client is already archived.' : 'This client is not archived.');
        await prisma.cmpClient.update({ where: { id: c.id }, data: archive ? { archivedAt: now(), archivedBy: ctx.email } : { archivedAt: null, archivedBy: null } });
        await log(ctx, archive ? 'cmp.client.archive' : 'cmp.client.restore', c.id, `Client ${common.clientLabel(c)} ${archive ? 'archived (hidden from the lists, dashboards and reminders)' : 'restored'}`, { clientId: c.id });
        return get(ctx, c.id);
    }

    return { getSettings, putSettings, listFields, createField, updateField, list, get, fieldsOf, create, update, secrets, setArchived, applies };
}

module.exports = { createClients, applies };
