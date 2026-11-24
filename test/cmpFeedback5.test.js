// Compliance & Deadlines: the CA's items 28–38 of 24 November 2026, through the real server.
// - templates in categories (1st/2nd/3rd reminder, advance payment, invoice, receipt, others) and per country; an obligation links a
//   template to each reminder and to its advance, invoice and receipt messages; a changed template reaches the unlocked obligations at
//   once, a locked one keeps its version until it is accepted (after unlocking) or rejected
// - the send window starts with the obligation's template of that category
// - advance payments get numbered receipts, their own WhatsApp message, and the advance payment formats
// - formats per country and kind with the client's details and the automatic information ticked; deleted
// - invoices with a discount and additional charges
// - settings: date and number formats, the firm's profile, weekends and public holidays (a reminder moves), WhatsApp numbers active or not
// - security: the login activity, signing out the other sessions
// - archiving takes every period
// Needs the local database; makes its own firm and removes it. Made-up names only.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');
const R = require('../public/cmp-rules');

const A = createApi('cmpfb5');
A.models = ['cmpNotification', 'cmpMessage', 'cmpReceipt', 'cmpInvoice', 'cmpAdvance', 'cmpCredit', 'cmpTaxRate', 'cmpItemPrice', 'cmpItem', 'cmpObligationTemplate', 'cmpReminder', 'cmpOccurrence', 'cmpObligation', 'cmpFieldValue', 'cmpFieldDef', 'cmpTemplate', 'cmpClient', 'cmpSettings', 'cmpInvoiceType'];
const run = A.run;
const W = {};
const today = R.dayIn('Asia/Dubai');
const day = n => R.addDays(today, n);
const ok = (r, what = '') => { assert.ok(r.status === 200, `${what} ${r.status} ${r.text}`); return r.json; };
const call = (url, method = 'GET', body, token) => A.call(url, { token: token || A.owner.token, method, body });

test('feedback 5 API: start a server, a firm with the module and its users', { timeout: 90000 }, async t => {
    if (!(await A.setup(t, { modules: ['COMPLIANCE'] }))) return;
    await A.prisma.user.update({ where: { email: A.owner.email }, data: { cmpPerms: ['FULL'] } });
    await A.prisma.user.update({ where: { email: A.manager.email }, data: { cmpPerms: ['VIEW', 'OBLIGATION_EDIT', 'COMPLETE', 'WHATSAPP', 'INVOICE'] } });
    W.c = ok(await call('/api/cmp/clients', 'POST', { country: 'AE', name: 'Cedar Lane Trading', contactNumber: '+971501112244', portalUsername: 'u', portalPassword: 'pw-1' })).client;
    W.sa = ok(await call('/api/cmp/clients', 'POST', { country: 'SA', name: 'Palm Court Supplies', contactNumber: '+966501112244', noPortal: true })).client;
});

run('templates: a category and a country each; the old categories are refused for a new one; listed by country and category', async () => {
    const mk = async (name, purpose, country, body) => ok(await call('/api/cmp/templates', 'POST', { name, purpose, country, body }), name);
    W.r1 = await mk('AE first reminder', 'REMINDER_1', 'AE', 'First: [Obligation] is due on [Due Date].');
    W.r2 = await mk('Every country second reminder', 'REMINDER_2', '', 'Second: [Obligation] due [Due Date].');
    W.saR1 = await mk('SA first reminder', 'REMINDER_1', 'SA', 'SA only.');
    W.inv = await mk('AE invoice message', 'INVOICE', 'AE', 'Invoice [Invoice Number] of [Invoice Amount].');
    W.adv = await mk('AE advance message', 'ADVANCE', 'AE', 'Advance [Advance Number] of [Advance Amount] received.');
    W.rc = await mk('AE receipt message', 'RECEIPT', 'AE', 'Receipt [Receipt Number].');
    assert.deepStrictEqual([W.r1.purpose, W.r1.country, W.r1.version], ['REMINDER_1', 'AE', 1]);
    assert.strictEqual((await call('/api/cmp/templates', 'POST', { name: 'Old kind', purpose: 'DATA_COLLECTION', body: 'x' })).status, 400);
    assert.strictEqual((await call('/api/cmp/templates', 'POST', { name: 'Old kind 2', purpose: 'REMINDER', body: 'x' })).status, 400);
    // a template of before keeps "REMINDER" until its category is chosen (offered for all three reminders meanwhile)
    W.legacy = await A.prisma.cmpTemplate.create({ data: { tenantId: A.tenantId, name: 'Legacy reminder', purpose: 'REMINDER', body: 'Legacy [Obligation].' } });
    assert.strictEqual((await call(`/api/cmp/templates/${W.legacy.id}`, 'PUT', { name: 'Legacy reminder.' })).status, 200, 'a legacy template can still be saved as it is');
    const ae2 = ok(await call('/api/cmp/templates?country=AE&category=REMINDER_2')).map(t => t.name).sort();
    assert.deepStrictEqual(ae2, ['Every country second reminder', 'Legacy reminder.']);
    const sa1 = ok(await call('/api/cmp/templates?country=SA&category=REMINDER_1')).map(t => t.name).sort();
    assert.deepStrictEqual(sa1, ['Legacy reminder.', 'SA first reminder']);
});

run('an obligation links its reminders and its advance, invoice and receipt templates; wrong category or country refused', async () => {
    const it = (name, extra = {}) => ({ name, periodStart: day(-60), periodEnd: day(-1), dueDate: day(6), ...extra });
    const docs = { ADVANCE: W.adv.id, INVOICE: W.inv.id, RECEIPT: W.rc.id };
    let r = await call(`/api/cmp/clients/${W.c.id}/obligations`, 'POST', { frequency: 'YEARLY', items: [it('VAT Return Q1', { reminders: [{ offsetDays: -10, templateId: W.r1.id }, { offsetDays: -2, templateId: W.r2.id }], docTemplates: docs }),
        it('Corporate Tax', { reminders: [{ offsetDays: -10, templateId: W.r1.id }], docTemplates: { INVOICE: W.inv.id }, locked: true })] });
    const [q1, ct] = ok(r, 'create').obligations;
    assert.deepStrictEqual(Object.keys(q1.docTemplates).sort(), ['ADVANCE', 'INVOICE', 'RECEIPT']);
    assert.deepStrictEqual([q1.reminders[0].templateId, q1.reminders[0].frozen, q1.reminders[0].version], [W.r1.id, false, 1]);
    W.q1 = q1; W.ct = ct;
    // the SA template on an AE client, an invoice template on a reminder, a reminder template as the invoice template: refused
    const bad = async (body, re) => { const x = await call(`/api/cmp/clients/${W.c.id}/obligations`, 'POST', { frequency: 'YEARLY', items: [it('Other', body)] }); assert.strictEqual(x.status, 400, x.text); assert.match(x.json.error, re); };
    await bad({ reminders: [{ offsetDays: -3, templateId: W.saR1.id }] }, /Saudi Arabia/);
    await bad({ reminders: [{ offsetDays: -3, templateId: W.inv.id }] }, /not a reminder template/);
    await bad({ docTemplates: { INVOICE: W.r1.id } }, /not an invoice template/);
    // changed on the obligation: another invoice template, the receipt one taken off
    W.inv2 = ok(await call('/api/cmp/templates', 'POST', { name: 'Invoice message 2', purpose: 'INVOICE', country: '', body: 'Second invoice text [Invoice Number].' }));
    r = ok(await call(`/api/cmp/obligations/${q1.id}`, 'PUT', { docTemplates: { INVOICE: W.inv2.id, RECEIPT: null } }), 'docs');
    assert.deepStrictEqual([r.docTemplates.INVOICE.templateId, r.docTemplates.RECEIPT], [W.inv2.id, undefined]);
    r = ok(await call(`/api/cmp/obligations/${q1.id}`, 'PUT', { docTemplates: { INVOICE: W.inv.id, RECEIPT: W.rc.id } }));
    // a template in use cannot be retired or deleted
    assert.strictEqual((await call(`/api/cmp/templates/${W.inv.id}`, 'DELETE')).status, 409);
});

run('a changed template: the unlocked obligation takes it at once; the locked one keeps its version until accepted or rejected', async () => {
    const occ = id => W[id].occurrences[0].id;
    const prepare = async (o, token) => ok(await call('/api/cmp/messages/prepare', 'POST', { kind: 'REMINDER', occurrenceId: occ(o), reminderId: W[o].reminders[0].id }, token), 'prepare');
    assert.match((await prepare('q1')).body, /^First: VAT Return Q1 is due/);
    assert.strictEqual((await prepare('q1')).category, 'REMINDER_1');
    const upd = ok(await call(`/api/cmp/templates/${W.r1.id}`, 'PUT', { body: 'First (new): [Obligation] by [Due Date].' }), 'update');
    assert.deepStrictEqual([upd.version, upd.followed, upd.kept], [2, 1, 1]);
    assert.match((await prepare('q1')).body, /^First \(new\): VAT Return Q1/, 'unlocked: the new version');
    assert.match((await prepare('ct')).body, /^First: Corporate Tax is due/, 'locked: its own version');
    let ob = ok(await call(`/api/cmp/obligations/${W.ct.id}`));
    assert.deepStrictEqual([ob.reminders[0].frozen, ob.reminders[0].pending, ob.reminders[0].version, ob.reminders[0].latest], [true, true, 1, 2]);
    // accepting needs it unlocked; rejecting does not (and it stops asking)
    let r = await call(`/api/cmp/obligations/${W.ct.id}/template-update`, 'POST', { target: ob.reminders[0].id, accept: true });
    assert.strictEqual(r.status, 409, r.text); assert.match(r.json.error, /locked/);
    ob = ok(await call(`/api/cmp/obligations/${W.ct.id}/template-update`, 'POST', { target: ob.reminders[0].id, accept: false }));
    assert.deepStrictEqual([ob.reminders[0].pending, ob.reminders[0].rejected], [false, true]);
    // unlocked, then aligned with the template
    ok(await call(`/api/cmp/obligations/${W.ct.id}`, 'PUT', { locked: false }));
    ob = ok(await call(`/api/cmp/obligations/${W.ct.id}/template-update`, 'POST', { target: ob.reminders[0].id, accept: true }));
    assert.deepStrictEqual([ob.reminders[0].frozen, ob.reminders[0].version], [false, 2]);
    assert.match((await prepare('ct')).body, /^First \(new\): Corporate Tax/);
    // saving the same reminders again keeps what each has
    ok(await call(`/api/cmp/obligations/${W.q1.id}/reminders`, 'PUT', { reminders: [{ offsetDays: -10, templateId: W.r1.id }, { offsetDays: -2, templateId: W.r2.id }] }));
    const log = await A.prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: { in: ['cmp.template.update', 'cmp.obligation.template'] } }, orderBy: { createdAt: 'asc' } });
    assert.ok(log.some(l => /locked keeps the earlier one/.test(l.summary)) && log.some(l => /rejected/.test(l.summary)) && log.some(l => /accepted/.test(l.summary)), log.map(l => l.summary).join(' | '));
    const tl = log.find(l => l.action === 'cmp.template.update' && /message changed/.test(l.summary));
    assert.ok(tl.details.changes.some(c => c.field === 'Message'), JSON.stringify(tl.details));
});

run('advance payments: numbered receipts, the obligation\'s advance template, sent and unsent; the automatic figures', async () => {
    const a1 = ok(await call('/api/cmp/advances', 'POST', { occurrenceId: W.q1.occurrences[0].id, amount: '500', description: 'Advance for VAT Q1', method: 'CASH', reference: 'R-1', receivedOn: day(-3) }, A.manager.token), 'advance 1');
    const a2 = ok(await call('/api/cmp/advances', 'POST', { clientId: W.c.id, amount: '250', description: 'Advance for bookkeeping', receivedOn: day(-1) }, A.manager.token), 'advance 2');
    const y = day(-3).slice(0, 4);
    assert.deepStrictEqual([a1.number, a2.number, a1.method, a1.reference, a1.status], [`ADV-${y}-0001`, `ADV-${day(-1).slice(0, 4)}-0002`, 'CASH', 'R-1', 'ACTIVE']);
    const g = ok(await call(`/api/cmp/advances/${a2.id}`));
    assert.deepStrictEqual([g.clientTotal, g.clientOutstanding, g.client.name], [750, 750, 'Cedar Lane Trading']);
    const p = ok(await call('/api/cmp/messages/prepare', 'POST', { advanceId: a1.id }, A.manager.token));
    assert.deepStrictEqual([p.kind, p.category, p.templateId], ['ADVANCE', 'ADVANCE', W.adv.id]);
    assert.strictEqual(p.body, `Advance ADV-${y}-0001 of AED 500.00 received.`);
    ok(await call('/api/cmp/messages', 'POST', { advanceId: a1.id, body: p.body, phone: '+971501112244' }, A.manager.token), 'send');
    let list = ok(await call(`/api/cmp/advances?clientId=${W.c.id}`));
    const sent = list.find(x => x.id === a1.id);
    assert.ok(sent.sentAt && sent.sentCount === 1, JSON.stringify(sent));
    ok(await call('/api/cmp/messages/void-last', 'POST', { advanceId: a1.id }, A.manager.token));
    list = ok(await call(`/api/cmp/advances?clientId=${W.c.id}`));
    assert.deepStrictEqual([list.find(x => x.id === a1.id).sentAt, list.find(x => x.id === a1.id).sentCount], [null, 0]);
    // searchable by number; the advance's number counter cannot be fooled into a duplicate
    assert.strictEqual(ok(await call(`/api/cmp/advances?q=${encodeURIComponent(a2.number)}`)).length, 1);
    await A.prisma.cmpSettings.update({ where: { tenantId: A.tenantId }, data: { advanceSeq: 0 } });
    const a3 = ok(await call('/api/cmp/advances', 'POST', { clientId: W.c.id, amount: '10', description: 'Small' }));
    assert.match(a3.number, /-0003$/);
    // the overall status counts the advance when there is one (the CA's answer of 24 Nov 2026)
    const row = ok(await call(`/api/cmp/occurrences?clientId=${W.c.id}&status=ALL`)).rows.find(x => x.id === W.q1.occurrences[0].id);
    assert.ok(row, 'the period is listed');
    assert.strictEqual(row.progress.total, R.progress({ ...row, reminders: row.view.reminders, advance: null }).total + 1, JSON.stringify(row.progress));
    W.a1 = a1;
});

run('formats: advance payment formats per country with ticked client details and automatic fields; a format is deleted', async () => {
    const field = ok(await call('/api/cmp/fields', 'POST', { name: 'Trade Licence', allCountries: false, countries: ['AE'] }));
    const f = ok(await call('/api/cmp/invoice-types', 'POST', { name: 'AE advance', kind: 'ADVANCE', country: 'AE', isDefault: true,
        layout: { advanceTitle: 'ADVANCE RECEIPT', clientFields: ['name', 'email', `f:${field.id}`, 'bogus key!'], autoFields: ['number', 'date', 'outstanding'] } }), 'format');
    assert.deepStrictEqual([f.kind, f.layout.advanceTitle, f.layout.clientFields, f.layout.autoFields], ['ADVANCE', 'ADVANCE RECEIPT', ['name', 'email', `f:${field.id}`], ['number', 'date', 'outstanding']]);
    // a new advance of an AE client takes it, frozen
    const a = ok(await call('/api/cmp/advances', 'POST', { clientId: W.c.id, amount: '20', description: 'With format' }));
    assert.strictEqual(a.typeSnapshot.name, 'AE advance');
    assert.strictEqual(ok(await call('/api/cmp/invoice-types?kind=ADVANCE')).length, 1);
    // an advance format is not an invoice's
    const draft = ok(await call('/api/cmp/invoices', 'POST', { clientId: W.c.id }));
    assert.strictEqual((await call(`/api/cmp/invoices/${draft.id}`, 'PUT', { typeId: f.id })).status, 400);
    ok(await call(`/api/cmp/invoice-types/${f.id}`, 'DELETE'));
    assert.strictEqual(ok(await call('/api/cmp/invoice-types?kind=ADVANCE&all=1')).length, 0);
    assert.strictEqual((await call(`/api/cmp/invoice-types/${f.id}`, 'DELETE', undefined, A.manager.token)).status, 403);
    assert.strictEqual(ok(await call(`/api/cmp/advances/${a.id}`)).typeSnapshot.name, 'AE advance', 'the advance keeps the format it was made with');
    W.draft = draft;
});

run('invoices: a discount and additional charges before the taxes; the receipt\'s automatic figures', async () => {
    let inv = ok(await call(`/api/cmp/invoices/${W.draft.id}`, 'PUT', { currency: 'AED', lines: [{ description: 'VAT return', amount: '1000' }], taxes: [{ name: 'VAT', rate: '5' }], discount: '100', charges: '50' }));
    assert.deepStrictEqual([inv.subtotal, inv.discount, inv.charges, inv.taxTotal, inv.total], [1000, 100, 50, 47.5, 997.5]);
    assert.strictEqual((await call(`/api/cmp/invoices/${W.draft.id}`, 'PUT', { discount: '2000' })).status, 400);
    ok(await call(`/api/cmp/invoices/${W.draft.id}/issue`, 'POST'));
    ok(await call(`/api/cmp/invoices/${W.draft.id}/receipts`, 'POST', { amount: '500' }));
    inv = ok(await call(`/api/cmp/invoices/${W.draft.id}`));
    assert.deepStrictEqual([inv.receipts[0].paidToDate, inv.receipts[0].paymentStatus, inv.receipts[0].clientBalanceAfter], [500, 'PARTLY', 497.5]);
    assert.ok(Array.isArray(inv.clientFields));
});

run('settings: formats, the firm\'s profile, weekends and holidays move a reminder; inactive WhatsApp numbers', async () => {
    const s = ok(await call('/api/cmp/settings', 'PUT', { dateFormat: 'DD/MM/YYYY', numberFormat: '1.234,56', firmCountry: 'AE', firmCity: 'Dubai', firmWebsite: 'www.example.com', firmPhone: '+97140000000', sessionMinutes: 60,
        waSenders: [{ label: 'Old', phone: '+923001234567', active: false, isDefault: true }, { label: 'Office', phone: '+971501234567' }] }));
    assert.deepStrictEqual([s.dateFormat, s.numberFormat, s.firmCity, s.sessionMinutes], ['DD/MM/YYYY', '1.234,56', 'Dubai', 60]);
    assert.deepStrictEqual(s.waSenders.map(x => [x.label, x.active, x.isDefault]), [['Old', false, false], ['Office', true, true]]);
    assert.strictEqual((await call('/api/cmp/settings', 'PUT', { dateFormat: 'whatever' })).status, 400);
    assert.strictEqual((await call('/api/cmp/settings', 'PUT', { firmWebsite: 'not a site' })).status, 400);
    // [Firm Phone] and [Firm Website] in a message
    const t = ok(await call('/api/cmp/templates', 'POST', { name: 'Others firm', purpose: 'OTHER', body: 'Call [Firm Phone] / [Firm Website] by [Due Date].' }));
    const p = ok(await call('/api/cmp/messages/prepare', 'POST', { kind: 'OTHER', occurrenceId: W.q1.occurrences[0].id, templateId: t.id }));
    assert.strictEqual(p.body, `Call +97140000000 / www.example.com by ${R.fmtDay(day(6), 'DD/MM/YYYY')}.`);
    // the 1st reminder of VAT Return Q1 (10 days before the due date) on a weekend day or a holiday moves to the working day before
    const raw = day(-4), wd = new Date(raw + 'T00:00:00Z').getUTCDay();
    ok(await call('/api/cmp/settings', 'PUT', { weekendDays: [wd], holidays: [{ date: R.addDays(raw, -1), name: 'A holiday' }], holidayMode: 'BEFORE' }));
    let ob = ok(await call(`/api/cmp/obligations/${W.q1.id}`));
    assert.strictEqual(ob.occurrences[0].view.reminders[0].date, R.addDays(raw, -2));
    ok(await call('/api/cmp/settings', 'PUT', { holidayMode: 'NONE' }));
    ob = ok(await call(`/api/cmp/obligations/${W.q1.id}`));
    assert.strictEqual(ob.occurrences[0].view.reminders[0].date, raw);
});

run('items and taxes: a code, category and unit; a tax type and the day it applies from', async () => {
    const it = ok(await call('/api/cmp/items', 'POST', { name: 'VAT return filing', code: 'VR-01', category: 'Tax filing', unit: 'return', currency: 'AED', amount: '700', countries: ['AE'] }));
    assert.deepStrictEqual([it.code, it.category, it.unit], ['VR-01', 'Tax filing', 'return']);
    const u = ok(await call(`/api/cmp/items/${it.id}`, 'PUT', { category: 'Filing' }));
    assert.strictEqual(u.category, 'Filing');
    const tx = ok(await call('/api/cmp/taxes', 'POST', { name: 'Excise', rate: '50', type: 'Excise tax', effectiveFrom: '2026-01-01', countries: ['AE'] }));
    assert.deepStrictEqual([tx.type, tx.effectiveFrom], ['Excise tax', '2026-01-01']);
    const log = await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'cmp.item.update' }, orderBy: { createdAt: 'desc' } });
    assert.deepStrictEqual(log.details.changes, [{ field: 'Category', old: 'Tax filing', new: 'Filing' }]);
});

run('security: the login activity, and signing out the other sessions', async () => {
    const mine = ok(await call('/api/cmp/security/logins', 'GET', undefined, A.manager.token));
    assert.ok(!mine.all && mine.rows.every(r => r.userEmail === A.manager.email) && mine.rows.length >= 1, JSON.stringify(mine).slice(0, 300));
    const all = ok(await call('/api/cmp/security/logins'));
    assert.ok(all.all && new Set(all.rows.map(r => r.userEmail)).size >= 2);
    const other = await A.login(A.manager.email, A.password);
    const r = ok(await call('/api/cmp/security/signout-others', 'POST', undefined, A.manager.token));
    assert.strictEqual((await call('/api/cmp/me', 'GET', undefined, other)).status, 401, 'the other session is signed out');
    assert.strictEqual((await call('/api/cmp/me', 'GET', undefined, r.token)).status, 200, 'this one goes on with its new token');
    A.manager.token = r.token;
});

run('archiving an obligation takes all its periods; the clients\' history keeps each change', async () => {
    ok(await call(`/api/cmp/obligations/${W.ct.id}/archive`, 'POST'));
    const log = await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'cmp.obligation.archive' }, orderBy: { createdAt: 'desc' } });
    assert.match(log.summary, /with all its periods/);
    const rows = ok(await call(`/api/cmp/occurrences?clientId=${W.c.id}&status=ALL`)).rows;
    assert.ok(rows.length && rows.some(x => x.obligation.id === W.q1.id), 'the other obligation is still listed');
    assert.ok(!rows.some(x => x.obligation.id === W.ct.id), 'no period of the archived obligation is listed');
    const archived = ok(await call(`/api/cmp/occurrences?clientId=${W.c.id}&status=ALL&archived=1`)).rows;
    assert.ok(archived.length && archived.every(x => x.obligation.id === W.ct.id), 'its periods are under Archived');
    ok(await call(`/api/cmp/clients/${W.c.id}`, 'PUT', { email: 'accounts@cedar.example' }));
    const cl = await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'cmp.client.update' }, orderBy: { createdAt: 'desc' } });
    assert.deepStrictEqual(cl.details.changes, [{ field: 'email', old: '', new: 'accounts@cedar.example' }]);
});

test('feedback 5 API: clean up', async () => { await A.teardown(); });
