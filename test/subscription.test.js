// How long a client may use the application: the end date, the countdown, the grace days (3 for a monthly plan, 7 for a yearly one),
// and the automatic switch-off. Dates are Pakistan calendar days.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/subscription');

const at = (day, time = '12:00:00') => new Date(`${day}T${time}+05:00`); // a moment on a Pakistan day
const tenant = (over = {}) => ({ id: 't1', companyName: 'Test', active: true, inactiveReason: null, integratedAt: S.atMidnight('2026-01-15'), accessUnit: null, accessCount: null, accessEndsAt: null, ...over });

test('access period: a month or a year is added to the integration day, keeping the day of the month', () => {
    assert.strictEqual(S.addMonths('2026-10-19', 12), '2027-10-19');
    assert.strictEqual(S.addMonths('2026-10-19', 1), '2026-11-19');
    assert.strictEqual(S.addMonths('2026-12-19', 1), '2027-01-19', 'over the new year');
    assert.strictEqual(S.addMonths('2026-01-31', 1), '2026-02-28', '31 Jan + 1 month: the last day of February');
    assert.strictEqual(S.addMonths('2028-01-31', 1), '2028-02-29', 'in a leap year');
    assert.strictEqual(S.addMonths('2028-02-29', 12), '2029-02-28', 'a leap day + 1 year');
    assert.strictEqual(S.addMonths('2026-03-31', 6), '2026-09-30');
    assert.strictEqual(S.addMonths('2026-10-19', 24), '2028-10-19');
});

test('access period: setting it from the integration day', () => {
    const t = tenant();
    const year = S.setPeriod({ integratedAt: '2026-10-19', unit: 'YEAR', count: 1 }, t);
    assert.strictEqual(S.dayOf(year.accessEndsAt), '2027-10-19');
    assert.strictEqual(S.dayOf(year.integratedAt), '2026-10-19');
    assert.deepStrictEqual([year.accessUnit, year.accessCount], ['YEAR', 1]);
    const months = S.setPeriod({ integratedAt: '2026-10-19', unit: 'month', count: '6' }, t);
    assert.strictEqual(S.dayOf(months.accessEndsAt), '2027-04-19');
    assert.deepStrictEqual([months.accessUnit, months.accessCount], ['MONTH', 6]);
    // no date given: the stored integration day stays
    assert.strictEqual(S.dayOf(S.setPeriod({ unit: 'MONTH', count: 1 }, t).accessEndsAt), '2026-02-15');
    // no time limit
    assert.deepStrictEqual(S.setPeriod({ integratedAt: '2026-10-19', unlimited: true }, t), { integratedAt: S.atMidnight('2026-10-19'), accessUnit: null, accessCount: null, accessEndsAt: null });
});

test('access period: what is refused', () => {
    const t = tenant();
    for (const bad of ['2026-13-01', '2026-02-30', 'yesterday', '19/10/2026', '2019-12-31', '2101-01-01']) assert.throws(() => S.setPeriod({ integratedAt: bad, unit: 'YEAR', count: 1 }, t), S.AccessError, bad);
    for (const [unit, count] of [['WEEK', 1], ['', 1], [undefined, 1], ['YEAR', 0], ['YEAR', -1], ['YEAR', 1.5], ['YEAR', 'x'], ['YEAR', ''], ['YEAR', 21], ['MONTH', 121], ['MONTH', undefined]]) {
        assert.throws(() => S.setPeriod({ integratedAt: '2026-10-19', unit, count }, t), S.AccessError, `${unit} ${count}`);
    }
    assert.doesNotThrow(() => S.setPeriod({ integratedAt: '2026-10-19', unit: 'YEAR', count: 20 }, t));
    assert.doesNotThrow(() => S.setPeriod({ integratedAt: '2026-10-19', unit: 'MONTH', count: 120 }, t));
});

test('countdown: days left, "ending soon", grace and expiry (a yearly plan has 7 grace days)', () => {
    const t = tenant({ accessUnit: 'YEAR', accessCount: 1, accessEndsAt: S.atMidnight('2026-10-19') });
    const on = day => S.access(t, at(day));
    assert.strictEqual(on('2026-01-01').status, 'RUNNING');
    assert.strictEqual(on('2026-01-01').daysLeft, 291);
    assert.deepStrictEqual([on('2026-09-18').daysLeft, on('2026-09-18').status], [31, 'RUNNING'], '31 days left: not yet "ending soon"');
    assert.deepStrictEqual([on('2026-09-19').daysLeft, on('2026-09-19').status], [30, 'ENDING'], '30 days or fewer is');
    assert.strictEqual(on('2026-10-18').daysLeft, 1);
    assert.deepStrictEqual([on('2026-10-19').status, on('2026-10-19').daysLeft], ['ENDING', 0], 'the last day itself is still a day of access');
    assert.deepStrictEqual([on('2026-10-20').status, on('2026-10-20').daysLeft], ['GRACE', -1]);
    assert.strictEqual(on('2026-10-26').status, 'GRACE', 'the 7th grace day (19 Oct + 7) is still allowed');
    assert.strictEqual(on('2026-10-26').graceUntil, '2026-10-26');
    assert.deepStrictEqual([on('2026-10-27').status, on('2026-10-27').daysLeft], ['EXPIRED', -8]);
    assert.strictEqual(on('2026-10-27').inactiveFrom, '2026-10-27');
    assert.strictEqual(on('2027-03-01').status, 'EXPIRED');
});

test('countdown: a monthly plan has 3 grace days', () => {
    const t = tenant({ accessUnit: 'MONTH', accessCount: 1, accessEndsAt: S.atMidnight('2026-11-19') });
    const on = day => S.access(t, at(day)).status;
    assert.strictEqual(on('2026-11-19'), 'ENDING');
    assert.strictEqual(on('2026-11-20'), 'GRACE');
    assert.strictEqual(on('2026-11-22'), 'GRACE', '19 Nov + 3');
    assert.strictEqual(on('2026-11-23'), 'EXPIRED');
    assert.strictEqual(S.access(t, at('2026-11-22')).graceDays, 3);
});

test('countdown: the day changes at midnight in Pakistan, not in UTC', () => {
    const t = tenant({ accessUnit: 'MONTH', accessCount: 1, accessEndsAt: S.atMidnight('2026-11-19') });
    // 20 Nov 00:30 Pakistan time is still 19 Nov 19:30 UTC
    assert.strictEqual(S.access(t, new Date('2026-11-19T19:30:00Z')).daysLeft, -1);
    assert.strictEqual(S.access(t, new Date('2026-11-19T18:30:00Z')).daysLeft, 0); // 23:30 Pakistan time on the 19th
});

test('countdown: no end date means no limit', () => {
    for (const t of [tenant(), null, undefined, { accessEndsAt: null }]) assert.strictEqual(S.access(t).status, 'UNLIMITED');
    assert.strictEqual(S.access(tenant()).daysLeft, null);
    assert.strictEqual(S.blockedMessage(tenant(), at('2040-01-01')), null);
});

test('renew: adds a period to the end date, or to today when it has passed', () => {
    const running = tenant({ accessUnit: 'YEAR', accessCount: 1, accessEndsAt: S.atMidnight('2026-12-01') });
    // early: nothing is lost (end date + 1 year)
    assert.strictEqual(S.dayOf(S.renew({}, running, at('2026-10-19')).accessEndsAt), '2027-12-01');
    // in the grace period or long after: from today
    assert.strictEqual(S.dayOf(S.renew({}, running, at('2026-12-03')).accessEndsAt), '2027-12-03');
    assert.strictEqual(S.dayOf(S.renew({}, running, at('2027-05-10')).accessEndsAt), '2028-05-10');
    // a different period; the grace follows the new unit
    const monthly = S.renew({ unit: 'MONTH', count: 3 }, running, at('2026-10-19'));
    assert.deepStrictEqual([monthly.accessUnit, monthly.accessCount, S.dayOf(monthly.accessEndsAt)], ['MONTH', 3, '2027-03-01']);
    // a client with no limit can be given one: from today
    assert.strictEqual(S.dayOf(S.renew({ unit: 'YEAR', count: 1 }, tenant(), at('2026-10-19')).accessEndsAt), '2027-10-19');
    assert.throws(() => S.renew({}, tenant(), at('2026-10-19')), S.AccessError, 'no period to repeat');
    assert.throws(() => S.renew({ unit: 'YEAR', count: 0 }, running), S.AccessError);
});

test('who is let in: only a client switched off by hand is turned away at the door; one whose period is over may come in and look', () => {
    const lapsed = tenant({ accessUnit: 'YEAR', accessCount: 1, accessEndsAt: S.atMidnight('2026-10-19') });
    assert.strictEqual(S.blockedMessage(lapsed, at('2026-10-26')), null, 'in the grace period: yes');
    assert.strictEqual(S.blockedMessage(lapsed, at('2026-10-27')), null, 'the period is over: still let in (to look)');
    assert.strictEqual(S.blockedMessage({ ...lapsed, active: false, inactiveReason: 'EXPIRED' }, at('2026-10-20')), null, 'made inactive by the job: let in (to look)');
    assert.strictEqual(S.blockedMessage({ ...lapsed, active: false, inactiveReason: 'ADMIN' }, at('2026-12-01')), S.INACTIVE_MESSAGE, 'switched off by hand, even if its period is also over: not let in');
    assert.strictEqual(S.blockedMessage(tenant({ active: false, inactiveReason: 'ADMIN' }), at('2026-10-20')), S.INACTIVE_MESSAGE);
    assert.strictEqual(S.blockedMessage(tenant({ active: false, inactiveReason: null }), at('2026-10-20')), S.INACTIVE_MESSAGE, 'older rows have no reason');
    assert.strictEqual(S.blockedMessage(tenant(), at('2026-10-20')), null);
    assert.strictEqual(S.blockedMessage(null), null);
});

test('switching off: only active clients whose grace is over, each once, with a note in the activity log', async () => {
    const rows = [
        tenant({ id: 'over', accessUnit: 'YEAR', accessCount: 1, accessEndsAt: S.atMidnight('2026-10-19') }),   // grace over on 26 Oct
        tenant({ id: 'grace', accessUnit: 'MONTH', accessCount: 1, accessEndsAt: S.atMidnight('2026-10-28') }),  // 3 days of grace: until 31 Oct
        tenant({ id: 'running', accessUnit: 'YEAR', accessCount: 1, accessEndsAt: S.atMidnight('2027-05-01') }),
        tenant({ id: 'free' }),
        tenant({ id: 'off', active: false, inactiveReason: 'ADMIN', accessUnit: 'MONTH', accessCount: 1, accessEndsAt: S.atMidnight('2026-01-01') }),
    ];
    const updates = [], notes = [];
    const prisma = { tenant: {
        findMany: async ({ where }) => rows.filter(r => r.active === where.active && r.accessEndsAt && r.accessEndsAt < where.accessEndsAt.lt),
        updateMany: async ({ where, data }) => { const r = rows.find(x => x.id === where.id && x.active === where.active); if (!r) return { count: 0 }; Object.assign(r, data); updates.push([r.id, data]); return { count: 1 }; },
    } };
    const audit = async (req, e) => notes.push([req, e.tenantId, e.action, e.summary]);
    const now = at('2026-11-01');
    // 19 Oct + 7 = 26 Oct, and 28 Oct + 3 = 31 Oct: on 1 Nov both are over
    assert.deepStrictEqual(await S.expireDueClients({ prisma, audit, now }), ['over', 'grace']);
    assert.deepStrictEqual(updates.map(u => u[0]).sort(), ['grace', 'over']);
    assert.deepStrictEqual(updates[0][1], { active: false, inactiveReason: 'EXPIRED' });
    assert.ok(rows.find(r => r.id === 'running').active && rows.find(r => r.id === 'free').active, 'the others stay');
    assert.strictEqual(rows.find(r => r.id === 'off').inactiveReason, 'ADMIN', 'one switched off by hand keeps its reason');
    assert.ok(notes.every(n => n[0] === null && n[2] === 'client.expired' && /made inactive automatically/.test(n[3])));
    assert.deepStrictEqual(await S.expireDueClients({ prisma, audit, now }), [], 'a second run finds nothing to do');
    // earlier, only the yearly one is over
    rows.find(r => r.id === 'over').active = true; rows.find(r => r.id === 'grace').active = true;
    assert.deepStrictEqual(await S.expireDueClients({ prisma, audit, now: at('2026-10-29') }), ['over']);
});

test('what a client may do: use everything, only look (its period is over), or nothing (switched off by hand)', () => {
    const lapsed = tenant({ accessUnit: 'YEAR', accessCount: 1, accessEndsAt: S.atMidnight('2026-10-19') });
    const mode = (t, day) => S.accessMode(t, at(day));
    for (const day of ['2026-01-01', '2026-10-01', '2026-10-19', '2026-10-26']) assert.strictEqual(mode(lapsed, day).mode, 'FULL', `${day}: running, ending or in the grace period`);
    assert.strictEqual(mode(lapsed, '2026-10-27').mode, 'READ_ONLY', 'the first day after the grace, before the job has run');
    assert.strictEqual(mode(lapsed, '2030-01-01').mode, 'READ_ONLY', 'and for as long as it is not renewed');
    assert.strictEqual(mode({ ...lapsed, active: false, inactiveReason: 'EXPIRED' }, '2026-10-27').mode, 'READ_ONLY', 'after the job has run');
    assert.strictEqual(mode({ ...lapsed, active: false, inactiveReason: 'EXPIRED' }, '2026-10-01').mode, 'READ_ONLY', 'the reason is what counts once the job has noted it');
    assert.strictEqual(mode({ ...lapsed, active: false, inactiveReason: 'ADMIN' }, '2026-10-01').mode, 'BLOCKED');
    assert.strictEqual(mode({ ...lapsed, active: false, inactiveReason: 'ADMIN' }, '2027-06-01').mode, 'BLOCKED', 'switched off by hand beats an ended period');
    assert.strictEqual(mode(tenant({ active: false, inactiveReason: null }), '2026-10-01').mode, 'BLOCKED', 'an older row with no reason');
    assert.strictEqual(mode(tenant({ accessEndsAt: null }), '2040-01-01').mode, 'FULL', 'no time limit');
    assert.strictEqual(S.accessMode(null).mode, 'FULL');
    assert.strictEqual(mode(lapsed, '2026-10-27').message, 'Your access period ended on 19 Oct 2026. You can look at, print and download your records, but you cannot make changes. Contact ETAX to renew it.');
    assert.strictEqual(mode(lapsed, '2026-10-20').message, null);
    assert.strictEqual(mode({ ...lapsed, active: false, inactiveReason: 'EXPIRED', accessEndsAt: null }, '2026-10-27').message, 'Your access period has ended. You can look at, print and download your records, but you cannot make changes. Contact ETAX to renew it.');
    assert.strictEqual(mode(tenant({ active: false, inactiveReason: 'ADMIN' }), '2026-10-01').message, S.INACTIVE_MESSAGE);
});
