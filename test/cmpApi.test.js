// Compliance & Deadlines through the real server: permissions on every kind of route, one firm never sees another's, secrets stay
// secret, reminders follow their dates, recurrence, archive, the module's own activity log, the administrator's permission screen,
// read-only access and the background job. Needs the local database; makes its own businesses and removes them.
const test = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const { createApi } = require('../test-helpers/apiServer');
const R = require('../public/cmp-rules');

const A = createApi('cmpapi');
A.models = ['cmpMessage', 'cmpReminder', 'cmpOccurrence', 'cmpObligation', 'cmpFieldValue', 'cmpFieldDef', 'cmpTemplate', 'cmpClient', 'cmpSettings'];
const run = A.run;
const W = {}; // what the tests share
const today = R.dayIn('Asia/Dubai');
const day = n => R.addDays(today, n);

async function makeUser(tenantId, key, extra = {}) {
    const email = `cmpapi-${key}-${A.tag}@example.com`;
    await A.prisma.user.create({ data: { email, password: A.hash, role: 'CLIENT_USER', tenantRole: 'CASHIER', tenantId, name: key, ...extra } });
    return { email, token: await A.login(email, A.password) };
}

test('compliance API: start a server, a firm with the module and its users', { timeout: 90000 }, async t => {
    if (!(await A.setup(t, { modules: ['COMPLIANCE'] }))) return;
    // owner: full access; manager: a preparer; cashier: view only; and one with no access at all
    await A.prisma.user.update({ where: { email: A.owner.email }, data: { cmpPerms: ['FULL'] } });
    await A.prisma.user.update({ where: { email: A.manager.email }, data: { cmpPerms: ['VIEW', 'CLIENT_EDIT', 'OBLIGATION_EDIT', 'WHATSAPP', 'COMPLETE', 'REPORTS', 'SECRETS'] } });
    await A.prisma.user.update({ where: { email: A.cashier.email }, data: { cmpPerms: ['VIEW'] } });
    W.nobody = await makeUser(A.tenantId, 'nobody');
    // a firm without the module, and a second firm with it
    for (const [key, modules] of [['nomod', ['INVOICING']], ['other', ['COMPLIANCE']]]) {
        const tenant = await A.prisma.tenant.create({ data: { companyName: `TEST cmpapi ${key} ${A.tag}`, modules } });
        A.tenants.push(tenant.id);
        W[key] = { tenantId: tenant.id, ...(await makeUser(tenant.id, key, { tenantRole: 'OWNER', cmpPerms: ['FULL'] })) };
    }
});

run('module and permissions: closed to a firm without it; each route asks for its own permission', async () => {
    let r = await A.call('/api/cmp/me', { token: W.nomod.token });
    assert.strictEqual(r.status, 403);
    assert.match(r.json.error, /not switched on/);
    r = await A.call('/api/cmp/me', { token: W.nobody.token });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.json.perms, []);
    assert.strictEqual((await A.call('/api/cmp/clients', { token: W.nobody.token })).status, 403);
    assert.strictEqual((await A.call('/api/cmp/clients', { token: A.cashier.token })).status, 200);
    r = await A.call('/api/cmp/clients', { token: A.cashier.token, method: 'POST', body: {} });
    assert.strictEqual(r.status, 403);
    assert.match(r.json.error, /permission to add or change clients/);
    assert.strictEqual((await A.call('/api/cmp/settings', { token: A.manager.token, method: 'PUT', body: { amberDays: 5 } })).status, 403);
    r = await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { amberDays: 10, timeZone: 'Asia/Dubai' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.amberDays, r.json.timeZone, r.json.reminderHour], [10, 'Asia/Dubai', 9]);
    assert.strictEqual((await A.call('/api/cmp/settings', { token: A.owner.token, method: 'PUT', body: { timeZone: 'Mars/Base' } })).status, 400);
    assert.strictEqual((await A.call('/api/cmp/clients')).status, 401);
});

run('templates: the firm manages them with the setup permission', async () => {
    assert.strictEqual((await A.call('/api/cmp/templates', { token: A.manager.token, method: 'POST', body: { name: 'x', body: 'y' } })).status, 403);
    const mk = async (name, purpose, body) => { const r = await A.call('/api/cmp/templates', { token: A.owner.token, method: 'POST', body: { name, purpose, body } }); assert.strictEqual(r.status, 200, r.text); return r.json; };
    W.tFirst = await mk('VAT first reminder', 'REMINDER', 'Dear [Client Name], your VAT return for [Period Start] to [Period End] is due on [Due Date]. TL: [Trade License Number]. Kindly share the documents.');
    W.tLast = await mk('VAT last call', 'REMINDER', 'Last call: [Obligation] due [Due Date].');
    W.tDone = await mk('Filed', 'COMPLETION', 'Dear [Client Name], your [Obligation] has been filed.');
    assert.strictEqual((await A.call('/api/cmp/templates', { token: A.owner.token, method: 'POST', body: { name: 'VAT last call', body: 'dup' } })).status, 409);
    assert.strictEqual((await A.call('/api/cmp/templates', { token: A.owner.token, method: 'POST', body: { name: 'Empty', body: '   ' } })).status, 400);
    const list = await A.call('/api/cmp/templates', { token: A.cashier.token });
    assert.deepStrictEqual(list.json.map(t => t.name).sort(), ['Filed', 'VAT first reminder', 'VAT last call']);
});

run('clients: country first, mandatory details, the password and PIN encrypted and never listed', async () => {
    const base = { country: 'AE', name: 'Al Noor Trading LLC', contactNumber: '050 123 4567', portalUsername: 'alnoor', portalPassword: 'S3cret!pass', pinCode: '4321', email: 'Accounts@AlNoor.ae', registrationNo: '100123456700003' };
    const bad = async (over, re) => { const r = await A.call('/api/cmp/clients', { token: A.manager.token, method: 'POST', body: { ...base, ...over } }); assert.strictEqual(r.status, 400, r.text); assert.match(r.json.error, re); };
    await bad({ country: '' }, /country first/);
    await bad({ portalPassword: '' }, /Password is required/);
    await bad({ portalUsername: '' }, /Username is required/);
    await bad({ email: 'not-an-email' }, /valid email/);
    await bad({ contactNumber: '12' }, /country code/);
    let r = await A.call('/api/cmp/clients', { token: A.manager.token, method: 'POST', body: base });
    assert.strictEqual(r.status, 200, r.text);
    W.client = r.json.client;
    assert.deepStrictEqual([W.client.code, W.client.contactNumber, W.client.email, W.client.timeZone, W.client.hasPassword, W.client.hasPin], ['CL0001', '+971501234567', 'accounts@alnoor.ae', 'Asia/Dubai', true, true]);
    assert.ok(!/S3cret|4321/.test(r.text), 'the password or PIN came back');
    const row = await A.prisma.cmpClient.findUnique({ where: { id: W.client.id } });
    assert.ok(row.portalPasswordEnc && !row.portalPasswordEnc.includes('S3cret') && row.pinCodeEnc && !row.pinCodeEnc.includes('4321'));
    for (const url of ['/api/cmp/clients', `/api/cmp/clients/${W.client.id}`]) assert.ok(!/S3cret|4321|portalPasswordEnc|pinCodeEnc/.test((await A.call(url, { token: A.owner.token })).text), url);
    // seeing them is its own permission, and is logged
    assert.strictEqual((await A.call(`/api/cmp/clients/${W.client.id}/secrets`, { token: A.cashier.token })).status, 403);
    r = await A.call(`/api/cmp/clients/${W.client.id}/secrets`, { token: A.manager.token });
    assert.deepStrictEqual(r.json, { portalUsername: 'alnoor', portalPassword: 'S3cret!pass', pinCode: '4321' });
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.ok(await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'cmp.client.secrets_view', entityId: W.client.id } }));
    // a second client, in Pakistan; a blank password on edit keeps the old one
    r = await A.call('/api/cmp/clients', { token: A.manager.token, method: 'POST', body: { ...base, country: 'PK', name: 'Lahore Textiles', contactNumber: '0300 1234567' } });
    assert.strictEqual(r.status, 200, r.text);
    W.pkClient = r.json.client;
    assert.deepStrictEqual([W.pkClient.code, W.pkClient.contactNumber, W.pkClient.timeZone], ['CL0002', '+923001234567', 'Asia/Karachi']);
    r = await A.call(`/api/cmp/clients/${W.pkClient.id}`, { token: A.manager.token, method: 'PUT', body: { reference: 'Mr Aslam', portalPassword: '' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual((await A.call(`/api/cmp/clients/${W.pkClient.id}/secrets`, { token: A.owner.token })).json.portalPassword, 'S3cret!pass');
});

run('custom fields: for the chosen countries only; missing on existing clients; never shown elsewhere', async () => {
    assert.strictEqual((await A.call('/api/cmp/fields', { token: A.manager.token, method: 'POST', body: { name: 'Trade License Number', defaultCountry: 'AE' } })).status, 403);
    let r = await A.call('/api/cmp/fields', { token: A.owner.token, method: 'POST', body: { name: 'Trade License Number', type: 'TEXT', defaultCountry: 'AE' } });
    assert.strictEqual(r.status, 200, r.text);
    W.fTl = r.json;
    assert.deepStrictEqual([W.fTl.countries, W.fTl.allCountries], [['AE'], false]);
    r = await A.call('/api/cmp/fields', { token: A.owner.token, method: 'POST', body: { name: 'WhatsApp Number', allCountries: true } });
    W.fWa = r.json;
    assert.strictEqual((await A.call('/api/cmp/fields', { token: A.owner.token, method: 'POST', body: { name: 'password' } })).status, 400); // a basic detail's name
    assert.strictEqual((await A.call('/api/cmp/fields', { token: A.owner.token, method: 'POST', body: { name: 'trade  license number.', defaultCountry: 'AE' } })).status, 409);
    // the UAE client misses it; the Pakistani one never sees it
    let list = (await A.call('/api/cmp/clients', { token: A.cashier.token })).json.clients;
    assert.deepStrictEqual(list.find(c => c.id === W.client.id).missing.sort(), ['Trade License Number', 'WhatsApp Number']);
    assert.deepStrictEqual(list.find(c => c.id === W.pkClient.id).missing, ['WhatsApp Number']);
    assert.deepStrictEqual((await A.call('/api/cmp/fields?country=PK', { token: A.cashier.token })).json.map(f => f.name), ['WhatsApp Number']);
    // a value for a field of another country is refused; a valid one is saved and no longer missing
    r = await A.call(`/api/cmp/clients/${W.pkClient.id}`, { token: A.manager.token, method: 'PUT', body: { fields: { [W.fTl.id]: 'X' } } });
    assert.strictEqual(r.status, 400);
    r = await A.call(`/api/cmp/clients/${W.client.id}`, { token: A.manager.token, method: 'PUT', body: { fields: { [W.fTl.id]: 'TL-998', [W.fWa.id]: '+971 55 999 8888' } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json.fields.map(f => [f.name, f.value, f.missing]), [['Trade License Number', 'TL-998', false], ['WhatsApp Number', '+971 55 999 8888', false]]);
    list = (await A.call('/api/cmp/clients?missing=1', { token: A.cashier.token })).json.clients;
    assert.deepStrictEqual(list.map(c => c.id), [W.pkClient.id]);
    const upd = await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'cmp.client.update', entityId: W.client.id }, orderBy: { createdAt: 'desc' } });
    assert.match(upd.summary, /Trade License Number, WhatsApp Number/);
});

run('obligations: dates checked; reminders bleak until their time; suggestions stay within the country', async () => {
    const body = { name: 'VAT Return Q3', frequency: 'YEARLY', periodStart: day(-91), periodEnd: day(-2), dueDate: day(30), portalUrl: 'https://eservices.tax.gov.ae',
        reminders: [{ offsetDays: -40, templateId: W.tFirst.id }, { offsetDays: -5, templateId: W.tLast.id }] };
    let r = await A.call(`/api/cmp/clients/${W.client.id}/obligations`, { token: A.manager.token, method: 'POST', body: { ...body, dueDate: day(-3) } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /due date cannot be before the period end/);
    assert.strictEqual((await A.call(`/api/cmp/clients/${W.client.id}/obligations`, { token: A.manager.token, method: 'POST', body: { ...body, portalUrl: 'javascript:alert(1)' } })).status, 400);
    assert.strictEqual((await A.call(`/api/cmp/clients/${W.client.id}/obligations`, { token: A.manager.token, method: 'POST', body: { ...body, reminders: [{ offsetDays: 3, templateId: W.tLast.id }, { offsetDays: 3, templateId: W.tFirst.id }] } })).status, 400);
    assert.strictEqual((await A.call(`/api/cmp/clients/${W.client.id}/obligations`, { token: A.cashier.token, method: 'POST', body })).status, 403);
    r = await A.call(`/api/cmp/clients/${W.client.id}/obligations`, { token: A.manager.token, method: 'POST', body });
    assert.strictEqual(r.status, 200, r.text);
    W.ob = r.json;
    // its period is over and next year's due date is still ahead: year 2 is prepared at once, its dates to confirm
    assert.deepStrictEqual(W.ob.occurrences.map(o => [o.seq, o.view.status, o.datesConfirmed]), [[1, 'PERIOD_CLOSED', true], [2, 'UPCOMING', false]]);
    assert.strictEqual(W.ob.frequency, 'YEARLY');
    const y1 = W.ob.occurrences[0];
    W.y1 = y1;
    assert.deepStrictEqual([y1.seq, y1.view.status, y1.view.colour, y1.view.daysLeft], [1, 'PERIOD_CLOSED', 'amber', 30]);
    assert.deepStrictEqual(y1.view.reminders.map(x => [x.offsetDays, x.state]), [[-40, 'HIGHLIGHTED'], [-5, 'BLEAK']]);
    // suggestions: the UAE name for UAE clients, nothing for Pakistan
    const sug = (await A.call('/api/cmp/suggest/obligations?country=AE', { token: A.cashier.token })).json;
    assert.deepStrictEqual(sug.map(s => [s.name, s.dueDate, s.reminders.length]), [['VAT Return Q3', day(30), 2]]);
    assert.deepStrictEqual((await A.call('/api/cmp/suggest/obligations?country=PK', { token: A.cashier.token })).json, []);
});

run('WhatsApp: a bleak reminder cannot be sent; an active one is filled in, logged and shows as sent', async () => {
    const [active, bleak] = W.y1.view.reminders;
    let r = await A.call('/api/cmp/messages/prepare', { token: A.manager.token, method: 'POST', body: { occurrenceId: W.y1.id, reminderId: bleak.id } });
    assert.strictEqual(r.status, 409);
    assert.match(r.json.error, /not due yet/);
    assert.strictEqual((await A.call('/api/cmp/messages', { token: A.manager.token, method: 'POST', body: { occurrenceId: W.y1.id, reminderId: bleak.id, body: 'x', phone: '971501234567' } })).status, 409);
    assert.strictEqual((await A.call('/api/cmp/messages/prepare', { token: A.cashier.token, method: 'POST', body: { occurrenceId: W.y1.id, reminderId: active.id } })).status, 403);
    r = await A.call('/api/cmp/messages/prepare', { token: A.manager.token, method: 'POST', body: { occurrenceId: W.y1.id, reminderId: active.id } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.phone, '971559998888'); // the WhatsApp Number field wins over the contact number
    assert.strictEqual(r.json.body, `Dear Al Noor Trading LLC, your VAT return for ${R.fmtDay(day(-91))} to ${R.fmtDay(day(-2))} is due on ${R.fmtDay(day(30))}. TL: TL-998. Kindly share the documents.`);
    assert.deepStrictEqual(r.json.missing, []);
    const edited = r.json.body + '\nRegards, the firm';
    r = await A.call('/api/cmp/messages', { token: A.manager.token, method: 'POST', body: { occurrenceId: W.y1.id, reminderId: active.id, body: edited, phone: r.json.phone } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.url, R.waUrl('971559998888', edited));
    W.msgId = r.json.message.id;
    let ob = (await A.call(`/api/cmp/obligations/${W.ob.id}`, { token: A.cashier.token })).json;
    assert.deepStrictEqual(ob.occurrences[0].view.reminders.map(x => x.state), ['SENT', 'BLEAK']);
    // the log: for LOGS only; the owner sees the final text
    assert.strictEqual((await A.call('/api/cmp/messages', { token: A.manager.token })).status, 403);
    r = await A.call('/api/cmp/messages', { token: A.owner.token });
    assert.deepStrictEqual(r.json.messages.map(m => [m.kind, m.client.code, m.obligation.name, m.templateName, m.body, m.userEmail]), [['REMINDER', 'CL0001', 'VAT Return Q3', 'VAT first reminder', edited, A.manager.email]]);
    const csv = await A.call('/api/cmp/messages?format=csv', { token: A.owner.token });
    assert.ok(csv.text.startsWith('﻿') && csv.text.includes('VAT first reminder'));
    // "not sent after all": the reminder is to send again
    assert.strictEqual((await A.call(`/api/cmp/messages/${W.msgId}/void`, { token: A.manager.token, method: 'POST' })).status, 200);
    ob = (await A.call(`/api/cmp/obligations/${W.ob.id}`, { token: A.cashier.token })).json;
    assert.deepStrictEqual(ob.occurrences[0].view.reminders.map(x => x.state), ['HIGHLIGHTED', 'BLEAK']);
    // a free message about the client (data collection), no reminder
    r = await A.call('/api/cmp/messages/prepare', { token: A.manager.token, method: 'POST', body: { kind: 'DATA_COLLECTION', clientId: W.pkClient.id, templateId: W.tDone.id } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.phone, r.json.empty], ['923001234567', ['Obligation']]);
});

run('notifications: overdue and ready to send first; the dashboard needs reports or WhatsApp, the counts only viewing', async () => {
    // an overdue one for the Pakistani client
    let r = await A.call(`/api/cmp/clients/${W.pkClient.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'Sales Tax Return', frequency: 'YEARLY', periodStart: day(-60), periodEnd: day(-31), dueDate: day(-15), yearsTotal: 1 } });
    assert.strictEqual(r.status, 200, r.text);
    W.overdueOb = r.json;
    assert.deepStrictEqual([r.json.occurrences.length, r.json.occurrences[0].view.status, r.json.occurrences[0].view.colour], [1, 'OVERDUE', 'red']);
    assert.strictEqual((await A.call('/api/cmp/notifications', { token: A.cashier.token })).status, 403);
    r = await A.call('/api/cmp/notifications', { token: A.manager.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.summary.overdue, r.json.summary.ready], [1, 1]);
    assert.deepStrictEqual(r.json.items.map(i => i.obligation.name), ['Sales Tax Return', 'VAT Return Q3']);
    assert.deepStrictEqual((await A.call('/api/cmp/notifications?show=ready', { token: A.manager.token })).json.items.map(i => i.obligation.name), ['VAT Return Q3']);
    assert.deepStrictEqual((await A.call('/api/cmp/notifications?country=AE', { token: A.manager.token })).json.items.map(i => i.obligation.name), ['VAT Return Q3']);
    r = await A.call('/api/cmp/alerts', { token: A.cashier.token });
    assert.deepStrictEqual([r.json.overdue, r.json.ready], [1, 1]);
    // the obligations list and its filters
    const names = async q => (await A.call('/api/cmp/occurrences' + q, { token: A.cashier.token })).json.rows.map(x => x.obligation.name);
    assert.deepStrictEqual(await names(''), ['Sales Tax Return', 'VAT Return Q3', 'VAT Return Q3']);
    assert.deepStrictEqual(await names('?status=OVERDUE'), ['Sales Tax Return']);
    assert.deepStrictEqual(await names('?status=PERIOD_CLOSED'), ['VAT Return Q3']);
    assert.deepStrictEqual(await names('?status=CONFIRM'), ['VAT Return Q3']);
    assert.deepStrictEqual(await names('?q=noor'), ['VAT Return Q3', 'VAT Return Q3']);
    assert.deepStrictEqual(await names(`?from=${day(0)}&to=${day(60)}`), ['VAT Return Q3']);
    assert.deepStrictEqual(await names('?q=%25'), []); // a % is a percent sign, not "anything"
});

run('steps, completion and recurrence: next year is a copy to confirm; the number of years is respected', async () => {
    assert.strictEqual((await A.call(`/api/cmp/occurrences/${W.y1.id}/stage`, { token: A.cashier.token, method: 'POST', body: { stage: 'FILED' } })).status, 403);
    let r = await A.call(`/api/cmp/occurrences/${W.y1.id}/stage`, { token: A.manager.token, method: 'POST', body: { stage: 'FILED' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.occurrences[0].view.status, 'FILED');
    r = await A.call(`/api/cmp/occurrences/${W.y1.id}/complete`, { token: A.manager.token, method: 'POST' });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json.occurrences.map(o => [o.seq, o.view.status, o.datesConfirmed]), [[1, 'COMPLETED', true], [2, 'UPCOMING', false]]);
    const y2 = r.json.occurrences[1];
    assert.deepStrictEqual([y2.periodStart, y2.periodEnd, y2.dueDate], [R.yearDates({ periodStart: day(-91), periodEnd: day(-2), dueDate: day(30) }, 2).periodStart, R.yearDates({ periodStart: day(-91), periodEnd: day(-2), dueDate: day(30) }, 2).periodEnd, R.yearDates({ periodStart: day(-91), periodEnd: day(-2), dueDate: day(30) }, 2).dueDate]);
    assert.strictEqual((await A.call(`/api/cmp/occurrences/${W.y1.id}/stage`, { token: A.manager.token, method: 'POST', body: { stage: 'PAID' } })).status, 409);
    // not another year before this one's dates are confirmed
    r = await A.call(`/api/cmp/obligations/${W.ob.id}/next`, { token: A.manager.token, method: 'POST' });
    assert.strictEqual(r.status, 409);
    assert.match(r.json.error, /Confirm the dates of year 2/);
    // a change to year 2 that the years after follow: year 3 takes the new pattern
    const moved = { periodStart: y2.periodStart, periodEnd: y2.periodEnd, dueDate: R.addDays(y2.dueDate, 5) };
    r = await A.call(`/api/cmp/occurrences/${y2.id}`, { token: A.manager.token, method: 'PUT', body: { ...moved, applyFuture: true } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.occurrences[1].dueDate, r.json.occurrences[1].datesConfirmed, r.json.occurrences[1].overridden, r.json.baseDueDate], [moved.dueDate, true, false, moved.dueDate]); // the pattern from period 2 on is now these dates
    r = await A.call(`/api/cmp/obligations/${W.ob.id}/next`, { token: A.manager.token, method: 'POST' });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json.occurrences.map(o => o.seq), [1, 2, 3]);
    assert.strictEqual(r.json.occurrences[2].dueDate, R.yearDates(moved, 2).dueDate);
    // a one-year obligation: completing it makes no next year, and the button says why
    const one = W.overdueOb.occurrences[0];
    r = await A.call(`/api/cmp/occurrences/${one.id}/complete`, { token: A.manager.token, method: 'POST' });
    assert.deepStrictEqual(r.json.occurrences.map(o => o.view.status), ['COMPLETED']);
    r = await A.call(`/api/cmp/obligations/${W.overdueOb.id}/next`, { token: A.manager.token, method: 'POST' });
    assert.strictEqual(r.status, 409);
    assert.match(r.json.error, /1 year/);
    assert.strictEqual((await A.call(`/api/cmp/obligations/${W.ob.id}`, { token: A.manager.token, method: 'PUT', body: { yearsTotal: 2 } })).status, 400); // 3 years are there already
    // reopen
    r = await A.call(`/api/cmp/occurrences/${one.id}/reopen`, { token: A.manager.token, method: 'POST' });
    assert.strictEqual(r.json.occurrences[0].view.status, 'OVERDUE');
    // reminders changed: logged with before and after
    r = await A.call(`/api/cmp/obligations/${W.ob.id}/reminders`, { token: A.manager.token, method: 'PUT', body: { reminders: [{ offsetDays: -10, templateId: W.tFirst.id }, { offsetDays: 0, templateId: W.tLast.id }] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json.reminders.map(x => x.offsetDays).sort((a, b) => a - b), [-10, 0]);
    assert.ok(await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'cmp.reminder.update', summary: { contains: '40 days before' } } }));
    // a template used by a reminder cannot be deleted or retired
    assert.strictEqual((await A.call(`/api/cmp/templates/${W.tLast.id}`, { token: A.owner.token, method: 'DELETE' })).status, 409);
});

run('archive: hidden from lists and notifications, searchable apart, restorable; nothing new while archived', async () => {
    assert.strictEqual((await A.call(`/api/cmp/clients/${W.pkClient.id}/archive`, { token: A.manager.token, method: 'POST' })).status, 403); // the preparer has no ARCHIVE
    let r = await A.call(`/api/cmp/clients/${W.pkClient.id}/archive`, { token: A.owner.token, method: 'POST' });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual((await A.call('/api/cmp/clients', { token: A.cashier.token })).json.clients.map(c => c.code), ['CL0001']);
    assert.deepStrictEqual((await A.call('/api/cmp/clients?archived=1', { token: A.cashier.token })).json.clients.map(c => c.code), ['CL0002']);
    assert.strictEqual((await A.call('/api/cmp/notifications', { token: A.owner.token })).json.summary.overdue, 0);
    assert.deepStrictEqual((await A.call('/api/cmp/occurrences?archived=1&status=ALL', { token: A.cashier.token })).json.rows.map(x => x.obligation.name), ['Sales Tax Return']);
    r = await A.call(`/api/cmp/clients/${W.pkClient.id}`, { token: A.manager.token, method: 'PUT', body: { reference: 'x' } });
    assert.strictEqual(r.status, 409);
    assert.strictEqual((await A.call(`/api/cmp/clients/${W.pkClient.id}/restore`, { token: A.owner.token, method: 'POST' })).status, 200);
    assert.strictEqual((await A.call('/api/cmp/notifications', { token: A.owner.token })).json.summary.overdue, 1);
});

run('one firm never sees another\'s clients, obligations or templates', async () => {
    let r = await A.call('/api/cmp/clients', { token: W.other.token, method: 'POST', body: { country: 'GB', name: 'Other firm client', contactNumber: '+44 7700 900123', portalUsername: 'u', portalPassword: 'p' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.client.code, 'CL0001'); // its own numbering
    const theirs = r.json.client.id;
    for (const [url, method] of [[`/api/cmp/clients/${theirs}`, 'GET'], [`/api/cmp/clients/${theirs}/secrets`, 'GET'], [`/api/cmp/clients/${theirs}/archive`, 'POST'], [`/api/obligations/x`, 'GET']]) {
        const x = await A.call(url, { token: A.owner.token, method });
        assert.ok([404].includes(x.status), `${method} ${url} → ${x.status}`);
    }
    assert.strictEqual((await A.call(`/api/cmp/obligations/${W.ob.id}`, { token: W.other.token })).status, 404);
    assert.strictEqual((await A.call(`/api/cmp/occurrences/${W.y1.id}/complete`, { token: W.other.token, method: 'POST' })).status, 404);
    r = await A.call(`/api/cmp/clients/${theirs}/obligations`, { token: W.other.token, method: 'POST', body: { name: 'VAT', frequency: 'YEARLY', periodStart: day(0), periodEnd: day(10), dueDate: day(20), reminders: [{ offsetDays: -1, templateId: W.tFirst.id }] } });
    assert.strictEqual(r.status, 400); // our template is not theirs
    assert.deepStrictEqual((await A.call('/api/cmp/clients', { token: W.other.token })).json.clients.map(c => c.name), ['Other firm client']);
    assert.strictEqual((await A.call('/api/cmp/notifications', { token: W.other.token })).json.items.length, 0);
    assert.deepStrictEqual((await A.call('/api/cmp/suggest/obligations?country=AE', { token: W.other.token })).json, []);
});

run('monthly obligations (the CA: some countries file every month): one obligation, a period per month, each confirmed', async () => {
    assert.strictEqual((await A.call(`/api/cmp/clients/${W.pkClient.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'x', frequency: 'WEEKLY', periodStart: '2027-01-01', periodEnd: '2027-01-31', dueDate: '2027-02-18' } })).status, 400);
    let r = await A.call(`/api/cmp/clients/${W.pkClient.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'Sales Tax Return (monthly)', frequency: 'MONTHLY', yearsTotal: 1,
        periodStart: '2027-01-01', periodEnd: '2027-01-31', dueDate: '2027-02-18', reminders: [{ offsetDays: -3, templateId: W.tLast.id }] } });
    assert.strictEqual(r.status, 200, r.text);
    const ob = r.json;
    assert.deepStrictEqual([ob.frequency, ob.occurrences.length], ['MONTHLY', 1]);
    r = await A.call(`/api/cmp/obligations/${ob.id}/next`, { token: A.manager.token, method: 'POST' });
    assert.strictEqual(r.status, 200, r.text);
    const feb = r.json.occurrences[1];
    assert.deepStrictEqual([feb.seq, feb.periodStart, feb.periodEnd, feb.dueDate, feb.datesConfirmed], [2, '2027-02-01', '2027-02-28', '2027-03-18', false]);
    r = await A.call(`/api/cmp/obligations/${ob.id}/next`, { token: A.manager.token, method: 'POST' });
    assert.strictEqual(r.status, 409);
    assert.match(r.json.error, /Confirm the dates of Feb 2027/);
    assert.strictEqual((await A.call(`/api/cmp/occurrences/${feb.id}`, { token: A.manager.token, method: 'PUT', body: { confirm: true } })).status, 200);
    r = await A.call(`/api/cmp/obligations/${ob.id}/next`, { token: A.manager.token, method: 'POST' });
    assert.deepStrictEqual(r.json.occurrences.map(o => [o.periodStart, o.periodEnd, o.dueDate]).slice(2), [['2027-03-01', '2027-03-31', '2027-04-18']]);
    assert.ok(await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'cmp.occurrence.generate', summary: { contains: 'Mar 2027 prepared' } } }));
    // review fix: a due date on the 30th, carried on to the periods after, stays the 30th (it is not shifted back to February and lost)
    const mar = r.json.occurrences[2];
    r = await A.call(`/api/cmp/occurrences/${mar.id}`, { token: A.manager.token, method: 'PUT', body: { periodStart: '2027-03-01', periodEnd: '2027-03-31', dueDate: '2027-04-30', applyFuture: true } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.occurrences[2].dueDate, r.json.baseSeq, r.json.baseDueDate], ['2027-04-30', 3, '2027-04-30']);
    r = await A.call(`/api/cmp/obligations/${ob.id}/next`, { token: A.manager.token, method: 'POST' });
    assert.deepStrictEqual(r.json.occurrences.slice(3).map(o => [o.periodStart, o.periodEnd, o.dueDate]), [['2027-04-01', '2027-04-30', '2027-05-30']]);
    // one year = twelve months at most; more years allowed after a change
    assert.strictEqual((await A.call(`/api/cmp/obligations/${ob.id}`, { token: A.manager.token, method: 'PUT', body: { yearsTotal: 2 } })).status, 200);
});

run('a client with no online portal: no username or password asked for, none kept', async () => {
    let r = await A.call('/api/cmp/clients', { token: A.manager.token, method: 'POST', body: { country: 'AE', name: 'Family member', contactNumber: '+971 50 000 1111', noPortal: true, portalUsername: 'ignored', portalPassword: 'ignored' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.json.client.noPortal, r.json.client.portalUsername, r.json.client.hasPassword], [true, '', false]);
    const id = r.json.client.id;
    assert.strictEqual((await A.prisma.cmpClient.findUnique({ where: { id } })).portalPasswordEnc, ''); // review fix: nothing encrypted for "no password"
    assert.deepStrictEqual((await A.call(`/api/cmp/clients/${id}/secrets`, { token: A.owner.token })).json, { portalUsername: '', portalPassword: '', pinCode: '' });
    // back to having a portal: the password is needed then
    r = await A.call(`/api/cmp/clients/${id}`, { token: A.manager.token, method: 'PUT', body: { noPortal: false, portalUsername: 'fam' } });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /Password is required/);
    r = await A.call(`/api/cmp/clients/${id}`, { token: A.manager.token, method: 'PUT', body: { noPortal: false, portalUsername: 'fam', portalPassword: 'pw1' } });
    assert.deepStrictEqual([r.json.client.noPortal, r.json.client.hasPassword], [false, true]);
});

run('activity log: only this module\'s actions of this firm, whatever the filter asks; the download is defused and logged', async () => {
    // an administrator-side entry for this firm that the firm must not see in its compliance log
    await A.prisma.auditLog.create({ data: { tenantId: A.tenantId, userEmail: 'admin@example.com', action: 'user.cmp_perms', summary: 'ADMIN-ONLY ENTRY' } });
    await A.prisma.auditLog.create({ data: { tenantId: A.tenantId, userEmail: A.owner.email, action: 'cmp.client.update', summary: '=HYPERLINK("http://x")' } });
    assert.strictEqual((await A.call('/api/cmp/activity', { token: A.manager.token })).status, 403);
    let r = await A.call('/api/cmp/activity', { token: A.owner.token });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.json.entries.length > 5 && r.json.entries.every(e => e.action.startsWith('cmp.')));
    for (const action of ['user.', 'user.cmp_perms', '']) {
        const x = await A.call(`/api/cmp/activity?action=${action}`, { token: A.owner.token });
        assert.ok(x.json.entries.every(e => e.action.startsWith('cmp.')) && !x.text.includes('ADMIN-ONLY'), action);
    }
    assert.ok((await A.call('/api/cmp/activity?action=cmp.client.', { token: A.owner.token })).json.entries.every(e => e.action.startsWith('cmp.client.')));
    const csv = await A.call('/api/cmp/activity?format=csv', { token: A.owner.token });
    assert.ok(csv.text.includes("'=HYPERLINK") && !csv.text.includes('ADMIN-ONLY'));
    assert.match(csv.headers.get('content-disposition'), /compliance-activity-log/);
    assert.ok(await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'cmp.log.export' } }));
    // the client's 360 view shows its own history and messages to those who may see the logs
    r = await A.call(`/api/cmp/clients/${W.client.id}`, { token: A.owner.token });
    assert.ok(r.json.activity.some(a => a.action === 'cmp.client.create') && r.json.messages.length === 1 && r.json.obligations.length === 1);
    r = await A.call(`/api/cmp/clients/${W.client.id}`, { token: A.cashier.token });
    assert.ok(!('activity' in r.json) && !('messages' in r.json));
});

run('the administrator sets permissions; an owner cannot (not even through the users API); switching the module on gives owners full access', async () => {
    const email = `cmpapi-admin-${A.tag}@example.com`;
    await A.prisma.user.create({ data: { email, password: await bcrypt.hash(A.password, 10), role: 'SUPER_ADMIN', name: 'Admin' } });
    try {
        const admin = await A.login(email, A.password);
        const cashier = await A.prisma.user.findUnique({ where: { email: A.cashier.email } });
        assert.strictEqual((await A.call(`/api/admin/clients/${A.tenantId}/users/${cashier.id}/cmp-perms`, { token: A.owner.token, method: 'PUT', body: { perms: ['FULL'] } })).status, 403);
        // the owner's own users API ignores cmpPerms
        await A.call(`/api/client/users/${cashier.id}`, { token: A.owner.token, method: 'PATCH', body: { cmpPerms: ['FULL'], name: 'cashier' } });
        assert.deepStrictEqual((await A.prisma.user.findUnique({ where: { id: cashier.id } })).cmpPerms, ['VIEW']);
        let r = await A.call(`/api/admin/clients/${A.tenantId}/users/${cashier.id}/cmp-perms`, { token: admin, method: 'PUT', body: { perms: ['WHATSAPP', 'bogus', 'VIEW'] } });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.json.cmpPerms, ['VIEW', 'WHATSAPP']);
        assert.strictEqual((await A.call('/api/cmp/me', { token: A.cashier.token })).json.perms.sort().join(), 'VIEW,WHATSAPP'); // at once, same session
        const logged = await A.prisma.auditLog.findFirst({ where: { tenantId: A.tenantId, action: 'user.cmp_perms', entityId: cashier.id } });
        assert.match(logged.summary, /Viewer → 2 permissions/);
        assert.deepStrictEqual((await A.call(`/api/admin/clients/${A.tenantId}/users`, { token: admin })).json.find(u => u.id === cashier.id).cmpPerms, ['VIEW', 'WHATSAPP']);
        // a firm that gets the module: its owner gets full access, others nothing
        const owner = await A.prisma.user.findUnique({ where: { email: W.nomod.email } });
        await A.prisma.user.update({ where: { id: owner.id }, data: { cmpPerms: [] } });
        r = await A.call(`/api/admin/clients/${W.nomod.tenantId}/settings`, { token: admin, method: 'PUT', body: { modules: ['INVOICING', 'COMPLIANCE'] } });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual((await A.prisma.user.findUnique({ where: { id: owner.id } })).cmpPerms, ['FULL']);
        assert.strictEqual((await A.call('/api/cmp/me', { token: W.nomod.token })).status, 200);
        // review fix: the administrator sets that owner to No access; switching the module off and on again does not give it back
        await A.call(`/api/admin/clients/${W.nomod.tenantId}/users/${owner.id}/cmp-perms`, { token: admin, method: 'PUT', body: { perms: [] } });
        await A.call(`/api/admin/clients/${W.nomod.tenantId}/settings`, { token: admin, method: 'PUT', body: { modules: ['INVOICING'] } });
        await A.call(`/api/admin/clients/${W.nomod.tenantId}/settings`, { token: admin, method: 'PUT', body: { modules: ['INVOICING', 'COMPLIANCE'] } });
        assert.deepStrictEqual((await A.prisma.user.findUnique({ where: { id: owner.id } })).cmpPerms, []);
    } finally {
        const admin = await A.prisma.user.findUnique({ where: { email } });
        if (admin) await A.prisma.user.delete({ where: { id: admin.id } });
    }
});

run('the background job notes an overdue year once, and prepares next year when a period ends', async () => {
    const { createCompliance } = require('../src/compliance');
    const { createAudit } = require('../src/audit');
    const { encrypt, decrypt } = require('../src/crypto');
    let clock = new Date();
    const svc = createCompliance({ prisma: A.prisma, audit: createAudit(A.prisma), encrypt, decrypt, now: () => clock });
    let r = await svc.sweep({ tenantId: A.tenantId });
    assert.strictEqual(r.overdue, 1); // the Sales Tax Return, reopened above
    assert.strictEqual((await svc.sweep({ tenantId: A.tenantId })).overdue, 0);
    assert.strictEqual(await A.prisma.auditLog.count({ where: { tenantId: A.tenantId, action: 'cmp.occurrence.overdue' } }), 1);
    // a new obligation whose period ends tomorrow: nothing yet; the day after, year 2 appears (dates to confirm)
    const ob = (await A.call(`/api/cmp/clients/${W.client.id}/obligations`, { token: A.manager.token, method: 'POST', body: { name: 'Corporate Tax', periodStart: day(-364), periodEnd: day(1), dueDate: day(200) } })).json;
    assert.strictEqual(ob.occurrences.length, 1);
    assert.strictEqual((await svc.sweep({ tenantId: A.tenantId })).made, 0);
    clock = new Date(Date.now() + 3 * R.DAY);
    r = await svc.sweep({ tenantId: A.tenantId });
    assert.strictEqual(r.made, 1);
    const years = await A.prisma.cmpOccurrence.findMany({ where: { obligationId: ob.id }, orderBy: { seq: 'asc' } });
    assert.deepStrictEqual(years.map(y => [y.seq, y.datesConfirmed]), [[1, true], [2, false]]);
    assert.strictEqual((await svc.sweep({ tenantId: A.tenantId })).made, 0); // never twice
});

run('read-only firm: it can look, not change', async () => {
    await A.prisma.tenant.update({ where: { id: A.tenantId }, data: { accessEndsAt: new Date(Date.now() - 30 * R.DAY), accessUnit: 'YEAR', accessCount: 1, active: false, inactiveReason: 'EXPIRED' } });
    try {
        assert.strictEqual((await A.call('/api/cmp/clients', { token: A.owner.token })).status, 200);
        assert.strictEqual((await A.call(`/api/cmp/clients/${W.client.id}/secrets`, { token: A.owner.token })).status, 200);
        const r = await A.call('/api/cmp/templates', { token: A.owner.token, method: 'POST', body: { name: 'z', body: 'z' } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json.readOnly, true);
        assert.strictEqual((await A.call('/api/cmp/messages', { token: A.owner.token, method: 'POST', body: {} })).status, 403);
    } finally {
        await A.prisma.tenant.update({ where: { id: A.tenantId }, data: { accessEndsAt: null, accessUnit: null, accessCount: null, active: true, inactiveReason: null } });
    }
});

test.after(() => A.teardown());
