// The rate schedule through the real server: only the super admin changes it; a rate is never edited, a change is a new row from a date; the rate of a
// day is the latest live row on or before it; a point-of-sale item that follows the schedule is sold at the rate of the day of the sale, and an old
// sale keeps the rate it was made at.
const test = require('node:test');
const assert = require('node:assert');
const { createApi } = require('../test-helpers/apiServer');

const A = createApi('rates');
const run = A.run;
test('rates: start a server and a business', { timeout: 90000 }, async t => { await A.setup(t); });
test.after(async () => {
    if (A.ok) { await A.prisma.taxRate.deleteMany({ where: { code: { startsWith: '989999' } } }); if (A.admin) await A.prisma.user.deleteMany({ where: { email: A.admin.email } }); }
    await A.teardown();
});

const PKT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' });
const day = (add = 0) => { const d = new Date(`${PKT.format(new Date())}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + add); return d.toISOString().slice(0, 10); };
const today = day(), tomorrow = day(1), yesterday = day(-1);
const call = (url, who, method = 'GET', body) => A.call(url, { token: who === 'admin' ? A.admin.token : A[who].token, method, body });
const src = { sourceName: 'Test schedule (not a real document)', sourceRef: 'row 1' };
const add = (over = {}, who = 'admin') => call('/api/admin/rates', who, 'POST', { authority: 'PRA', code: '9899.9901', label: 'A test service', rate: 12, effectiveFrom: '2026-01-01', ...src, ...over });

run('rates: only the super admin reaches the schedule', async () => {
    A.admin = { email: `rates-admin-${A.tag}@example.com` };
    await A.prisma.user.create({ data: { email: A.admin.email, password: A.hash, role: 'SUPER_ADMIN', name: 'Rates Admin' } });
    A.admin.token = await A.login(A.admin.email, A.password);
    for (const [method, url] of [['GET', '/api/admin/rates'], ['GET', '/api/admin/rates/history?code=98012000'], ['POST', '/api/admin/rates'], ['POST', '/api/admin/rates/import'], ['GET', '/api/admin/rates/export'], ['POST', '/api/admin/rates/x/void']]) {
        assert.strictEqual((await A.call(url, { method })).status, 401, url);
        for (const who of ['owner', 'manager', 'cashier']) assert.strictEqual((await call(url, who, method)).status, 403, `${who} ${url}`);
    }
    assert.strictEqual((await call('/api/admin/rates', 'admin')).status, 200);
});

run('rates: the five rates this application has always suggested are in the schedule, with where they came from', async () => {
    const r = await call('/api/admin/rates?authority=PRA&limit=1000', 'admin');
    const by = Object.fromEntries(r.json.rates.map(x => [x.code, x]));
    assert.deepStrictEqual([by['98012000'].rate, by['98012000'].cardRate], [16, 8]);
    assert.deepStrictEqual([by['98011000'].rate, by['98011000'].cardRate], [16, 8]);
    assert.deepStrictEqual([by['98013000'].rate, by['98015000'].rate, by['98100000'].rate], [8, 8, 5]);
    assert.strictEqual(by['98012000'].effectiveFrom, '2026-07-01');
    assert.match(by['98012000'].sourceName, /Punjab Sales Tax on Services Act 2012/);
    assert.strictEqual(by['98012000'].heading, '9801.2000');
    assert.strictEqual(r.json.authorityName, 'Punjab Revenue Authority');
    const found = await call('/api/admin/rates?q=restaurants', 'admin');
    assert.deepStrictEqual(found.json.rates.map(x => x.code), ['98012000']);
    assert.deepStrictEqual((await call('/api/admin/rates?q=9801.2', 'admin')).json.rates.map(x => x.code), ['98012000'], 'by the digits of a heading, with or without the dot');
    // before 1 July 2026 they are not in force yet: the schedule shows what is coming, and says so
    const before = (await call('/api/admin/rates?date=2026-06-30', 'admin')).json.rates.find(x => x.code === '98012000');
    assert.strictEqual(before.inForce, false);
    assert.strictEqual((await call('/api/admin/rates?date=nonsense', 'admin')).status, 400);
    assert.strictEqual((await call('/api/admin/rates?authority=XYZ', 'admin')).status, 400);
});

run('rates: a rate is checked, and says where it comes from', async () => {
    const bad = async (over, re) => { const r = await add(over); assert.strictEqual(r.status, 400, JSON.stringify(over) + r.text); assert.match(r.json.error, re); };
    await bad({ authority: 'XYZ' }, /Choose the authority/);
    await bad({ code: '9801' }, /8 digits/);
    await bad({ code: '' }, /8 digits|heading/);
    await bad({ label: '' }, /description/);
    await bad({ rate: '101' }, /more than 100/);
    await bad({ rate: 'abc' }, /number/);
    await bad({ rate: '-5' }, /number/);
    await bad({ rate: '12.345' }, /two decimals/);
    await bad({ cardRate: '150' }, /more than 100/);
    await bad({ effectiveFrom: '' }, /date like/);
    await bad({ effectiveFrom: '2026-02-30' }, /real date/);
    await bad({ effectiveFrom: '1999-01-01' }, /before 2000/);
    await bad({ effectiveFrom: '2099-01-01' }, /two years ahead/);
    await bad({ sourceName: '', sourceRef: '' }, /where the rate comes from/);
    await bad({ sourceUrl: 'javascript:alert(1)' }, /http/);
    await bad({ label: 'x'.repeat(201) }, /too long/);
    assert.strictEqual((await call('/api/admin/rates', 'admin', 'POST', null)).status, 400);
});

run('rates: a change is a new row from a date; the rate of a day is the latest row on or before it', async () => {
    const first = await add({ rate: 10, effectiveFrom: '2026-01-01' });
    assert.strictEqual(first.status, 200, first.text);
    assert.deepStrictEqual([first.json.rate, first.json.cardRate, first.json.heading], [10, null, '9899.9901']);
    A.rate1 = first.json;
    assert.strictEqual((await add({ rate: 12, effectiveFrom: '2026-07-01', cardRate: '6', conditions: 'on card, wallet or QR', sourceUrl: 'https://example.com/schedule.pdf' })).status, 200);
    assert.strictEqual((await add({ rate: 14, effectiveFrom: tomorrow })).status, 200, 'a rate announced for tomorrow can be entered now');
    const ruleOn = async date => (await call(`/api/admin/rates?q=989999&date=${date}`, 'admin')).json.rates.find(x => x.code === '98999901');
    assert.strictEqual((await ruleOn('2026-03-01')).rate, 10);
    assert.strictEqual((await ruleOn('2026-07-01')).rate, 12, 'on the day it starts');
    assert.strictEqual((await ruleOn('2026-06-30')).rate, 10, 'the day before it starts');
    assert.strictEqual((await ruleOn(today)).rate, 12, 'today is still the 12');
    const t = await ruleOn(today);
    assert.deepStrictEqual(t.next, { rate: 14, cardRate: null, effectiveFrom: tomorrow }, 'the next change is shown');
    assert.strictEqual((await ruleOn(tomorrow)).rate, 14);
    assert.strictEqual((await ruleOn('2025-12-31')).inForce, false, 'before the first row nothing is in force');
    // the same date twice is refused
    const dup = await add({ rate: 99, effectiveFrom: '2026-07-01' });
    assert.strictEqual(dup.status, 409);
    assert.match(dup.json.error, /already has a rate from 2026-07-01 \(12%\)/);
    // history: every version, newest first, with the one in force and the one still to come marked
    const h = (await call('/api/admin/rates/history?authority=PRA&code=9899.9901', 'admin')).json;
    assert.deepStrictEqual(h.map(x => [x.rate, x.effectiveFrom]), [[14, tomorrow], [12, '2026-07-01'], [10, '2026-01-01']]);
    assert.deepStrictEqual(h.map(x => [x.inForce, x.future]), [[false, true], [true, false], [false, false]]);
    assert.strictEqual(h[1].sourceUrl, 'https://example.com/schedule.pdf');
    assert.strictEqual(h[1].createdBy, A.admin.email);
    // the activity log names the heading, the rate, the date and the source
    const log = await A.prisma.auditLog.findMany({ where: { action: 'taxrate.create', summary: { contains: '98999901' } } });
    assert.ok(log.some(x => /PRA 98999901 \(A test service\): 12%, 6% on card from 2026-07-01; source: Test schedule/.test(x.summary)));
});

run('rates: a wrong row is voided with a reason, stays in the history, and stops counting', async () => {
    const h = (await call('/api/admin/rates/history?code=98999901', 'admin')).json;
    const future = h.find(x => x.rate === 14);
    assert.strictEqual((await call(`/api/admin/rates/${future.id}/void`, 'admin', 'POST', { reason: '' })).status, 400);
    const v = await call(`/api/admin/rates/${future.id}/void`, 'admin', 'POST', { reason: 'announced by mistake' });
    assert.strictEqual(v.status, 200, v.text);
    assert.deepStrictEqual([v.json.voided, v.json.voidedBy, v.json.voidReason], [true, A.admin.email, 'announced by mistake']);
    assert.strictEqual((await call(`/api/admin/rates/${future.id}/void`, 'admin', 'POST', { reason: 'again' })).status, 409);
    assert.strictEqual((await call('/api/admin/rates/nope/void', 'admin', 'POST', { reason: 'nothing' })).status, 404);
    const after = (await call('/api/admin/rates/history?code=98999901', 'admin')).json;
    assert.strictEqual(after.length, 3, 'still in the history');
    assert.strictEqual(after.find(x => x.id === future.id).voided, true);
    const ruleTomorrow = (await call(`/api/admin/rates?q=989999&date=${tomorrow}`, 'admin')).json.rates.find(x => x.code === '98999901');
    assert.strictEqual(ruleTomorrow.rate, 12, 'tomorrow is the 12 again');
    // and the date is free to use again
    assert.strictEqual((await add({ rate: 13, effectiveFrom: tomorrow })).status, 200);
    const again = (await call('/api/admin/rates/history?code=98999901', 'admin')).json.find(x => x.rate === 13);
    await call(`/api/admin/rates/${again.id}/void`, 'admin', 'POST', { reason: 'not yet decided' });
});

const row = (code, rate, over = {}) => ({ authority: 'PRA', code, label: `Imported ${code}`, rate, cardRate: '', effectiveFrom: '2026-07-01', sourceName: 'Test schedule (not a real document)', sourceRef: 'import', ...over });

run('rates: an import is checked row by row, and all or nothing', async () => {
    const post = (rows, dryRun) => call('/api/admin/rates/import', 'admin', 'POST', { rows, dryRun });
    const empty = await post([], true); assert.strictEqual(empty.status, 400);
    assert.strictEqual((await post(Array.from({ length: 501 }, (_, i) => row('98999950', 1)), true)).status, 400, 'at most 500');
    // a file with problems: every problem is listed with its row, nothing is saved, even if the rest is fine
    const rows = [row('9899.9910', 16), row('98', 16), row('98999911', 150), row('98999912', 8, { effectiveFrom: 'soon' }), row('98999910', 16), row('98999913', 8, { sourceName: '', sourceRef: '' })];
    const bad = await post(rows, false);
    assert.strictEqual(bad.status, 200, bad.text);
    assert.strictEqual(bad.json.ok, false);
    assert.deepStrictEqual(bad.json.problems.map(p => p.row), [2, 3, 4, 5, 6]);
    assert.match(bad.json.problems.find(p => p.row === 5).message, /in the file twice/);
    assert.strictEqual(bad.json.saved, 0);
    assert.strictEqual(await A.prisma.taxRate.count({ where: { code: { startsWith: '9899991' } } }), 0, 'nothing was saved');
    // a good file: a dry run saves nothing and shows what it would do
    const good = [row('9899.9920', 16, { cardRate: '8' }), row('98999921', 5)];
    const dry = await post(good, true);
    assert.deepStrictEqual([dry.json.ok, dry.json.valid, dry.json.saved], [true, 2, 0]);
    assert.deepStrictEqual(dry.json.preview.map(p => [p.code, p.rate, p.cardRate]), [['98999920', 16, 8], ['98999921', 5, null]]);
    assert.strictEqual(await A.prisma.taxRate.count({ where: { code: { startsWith: '9899992' } } }), 0);
    const done = await post(good, false);
    assert.deepStrictEqual([done.json.ok, done.json.saved], [true, 2]);
    assert.strictEqual(await A.prisma.taxRate.count({ where: { code: { startsWith: '9899992' }, voidedAt: null } }), 2);
    // importing the same again is refused (the dates are taken), and nothing doubles
    const twice = await post(good, false);
    assert.strictEqual(twice.json.ok, false);
    assert.match(twice.json.problems[0].message, /already has a rate from 2026-07-01/);
    assert.strictEqual(await A.prisma.taxRate.count({ where: { code: { startsWith: '9899992' } } }), 2);
    const log = await A.prisma.auditLog.findMany({ where: { action: 'taxrate.import' } });
    assert.ok(log.some(x => /2 rates imported \(PRA\)/.test(x.summary)));
});

run('rates: the schedule can be downloaded as a spreadsheet, with a note that it was', async () => {
    await add({ code: '9899.9930', label: '=HYPERLINK("http://evil")', rate: 5, effectiveFrom: '2026-01-01' });
    const r = await A.call('/api/admin/rates/export?authority=PRA', { token: A.admin.token });
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.ok(r.text.startsWith('﻿authority,code,label,rate,cardRate,effectiveFrom,conditions,sourceName,sourceRef,sourceUrl,note'));
    assert.match(r.text, /PRA,9801\.2000,Services provided or rendered by restaurants,16\.?0*,8/);
    assert.ok(r.text.includes("\"'=HYPERLINK(\"\"http://evil\"\")\""), 'text Excel could read as a formula is defused');
    const log = await A.prisma.auditLog.findMany({ where: { action: 'taxrate.export' } });
    assert.ok(log.length >= 1);
});

run('rates: everyone at a business can read the rates in force today (for the quick-rate lists), and only those', async () => {
    const r = await call('/api/pos/rates', 'cashier');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.date, today);
    const codes = r.json.rates.map(x => x.code);
    assert.ok(['98012000', '98011000', '98013000', '98015000', '98100000'].every(c => codes.includes(c)));
    assert.ok(r.json.rates.every(x => x.inForce), 'nothing that has not started');
    assert.strictEqual(r.json.rates.find(x => x.code === '98999901').rate, 12);
    assert.strictEqual((await A.call('/api/pos/rates')).status, 401);
});

run('rates: an item that follows the schedule is shown and sold at the rate of the day, and an old sale keeps its rate', async () => {
    const branch = (await call('/api/pos/branches', 'owner', 'POST', { name: 'Main' })).json[0];
    A.counter = (await call('/api/pos/counters', 'owner', 'POST', { branchId: branch.id, name: 'Till 1', posId: '960001', env: 'SANDBOX' })).json[0].counters[0];
    const mk = (body, who = 'manager') => call('/api/pos/items', who, 'POST', { name: 'Scheduled service', pctCode: '9899.9901', taxRate: 5, unitPrice: 1000, ...body });
    // a heading the schedule has nothing for cannot follow it
    const none = await mk({ pctCode: '9899.9999', followSchedule: true });
    assert.strictEqual(none.status, 400);
    assert.match(none.json.error, /schedule has no rate for 9899\.9999 yet/);
    const it = await mk({ followSchedule: true, taxRateCard: 2 });
    assert.strictEqual(it.status, 200, it.text);
    assert.deepStrictEqual([it.json.followSchedule, it.json.taxRate, it.json.taxRateCard, it.json.ownTaxRate, it.json.ownTaxRateCard], [true, 12, 6, 5, 2], 'shown with the schedule\'s rates; its own are kept');
    assert.strictEqual(it.json.schedule.from, '2026-07-01');
    assert.match(it.json.schedule.source, /Test schedule/);
    const plain = (await mk({ name: 'Own rate service', taxRate: 7 })).json;
    assert.deepStrictEqual([plain.followSchedule, plain.taxRate, plain.ownTaxRate], [false, 7, undefined]);
    A.sched = it.json;
    const sell = (item, over = {}) => call('/api/pos/sales', 'cashier', 'POST', { counterId: A.counter.id, paymentMode: 1, lines: [{ itemId: item.id, quantity: 1 }], ...over });
    const s1 = await sell(it.json);
    assert.strictEqual(s1.status, 200, s1.text);
    assert.deepStrictEqual([s1.json.sale.lines[0].taxRate, s1.json.sale.totals.tax, s1.json.sale.totals.bill], [12, 120, 1120], 'sold at the schedule\'s 12%');
    const card = await sell(it.json, { paymentMode: 2 });
    assert.deepStrictEqual([card.json.sale.lines[0].taxRate, card.json.sale.totals.tax], [6, 60], 'the schedule\'s card rate for a card payment');
    assert.strictEqual((await sell(plain)).json.sale.lines[0].taxRate, 7, 'an item that does not follow is not touched');
    // the cashier screen is told the same rate it will be sold at
    const setup = (await call('/api/pos/setup', 'cashier')).json;
    assert.strictEqual(setup.items.find(x => x.id === it.json.id).taxRate, 12);
    // a new rate from today: new sales use it, the old sale keeps 12
    assert.strictEqual((await add({ rate: 9, cardRate: '4', effectiveFrom: today, sourceRef: 'row 2' })).status, 200);
    const s2 = await sell(it.json);
    assert.deepStrictEqual([s2.json.sale.lines[0].taxRate, s2.json.sale.totals.tax], [9, 90], 'a new sale uses the rate of today');
    const old = (await call(`/api/pos/sales/${s1.json.sale.id}`, 'manager')).json;
    assert.deepStrictEqual([old.lines[0].taxRate, old.totals.tax], [12, 120], 'the old sale keeps the rate it was made at');
    // a credit note on the old sale uses the old rate, not today's
    const cn = await call(`/api/pos/sales/${s1.json.sale.id}/credit-note`, 'manager', 'POST', { reason: 'returned', lines: [{ lineId: old.lines[0].id, quantity: 1 }] });
    assert.deepStrictEqual([cn.json.sale.totals.tax, cn.json.sale.totals.bill], [120, 1120]);
    // editing the item without sending its rates keeps its own rates, though the screen showed the schedule's
    const edit = await call(`/api/pos/items/${it.json.id}`, 'manager', 'PUT', { name: 'Scheduled service (renamed)' });
    assert.deepStrictEqual([edit.json.taxRate, edit.json.ownTaxRate, edit.json.ownTaxRateCard], [9, 5, 2]);
    // unticking it puts the item's own rate back in charge
    const off = await call(`/api/pos/items/${it.json.id}`, 'manager', 'PUT', { followSchedule: false });
    assert.deepStrictEqual([off.json.followSchedule, off.json.taxRate], [false, 5]);
    assert.strictEqual((await sell(it.json)).json.sale.lines[0].taxRate, 5);
    await call(`/api/pos/items/${it.json.id}`, 'manager', 'PUT', { followSchedule: true });
    // if the schedule loses its rows for the heading, the item's own rate keeps the sale going, and the screen says nothing is scheduled
    for (const r of (await call('/api/admin/rates/history?code=98999901', 'admin')).json.filter(x => !x.voided)) await call(`/api/admin/rates/${r.id}/void`, 'admin', 'POST', { reason: 'test cleanup' });
    const s3 = await sell(it.json);
    assert.strictEqual(s3.json.sale.lines[0].taxRate, 5, 'the item\'s own rate is the fallback');
    const shown = (await call('/api/pos/items', 'manager')).json.find(x => x.id === it.json.id);
    assert.strictEqual(shown.schedule, undefined);
    assert.strictEqual(shown.taxRate, 5);
});
