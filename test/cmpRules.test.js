// The rules of the Compliance & Deadlines module (public/cmp-rules.js): time zones, reminder states, statuses and colours, next year's
// dates, templates and WhatsApp links. Pure functions: no database.
const test = require('node:test');
const assert = require('node:assert');
const R = require('../public/cmp-rules');

const iso = d => new Date(d).toISOString();
const at = s => new Date(s).getTime();

test('zoned: local midnight in fixed-offset zones, including +5:45, +14 and -11', () => {
    assert.strictEqual(iso(R.zoned('2027-03-31', 0, 0, 'Asia/Dubai')), '2027-03-30T20:00:00.000Z');
    assert.strictEqual(iso(R.zoned('2027-03-31', 0, 0, 'Asia/Karachi')), '2027-03-30T19:00:00.000Z');
    assert.strictEqual(iso(R.zoned('2027-01-01', 0, 0, 'Asia/Kathmandu')), '2026-12-31T18:15:00.000Z');
    assert.strictEqual(iso(R.zoned('2027-01-01', 0, 0, 'Pacific/Kiritimati')), '2026-12-31T10:00:00.000Z');
    assert.strictEqual(iso(R.zoned('2027-01-01', 0, 0, 'Pacific/Pago_Pago')), '2027-01-01T11:00:00.000Z');
});

test('zoned: either side of a summer-time change (New York, London)', () => {
    // New York moves its clocks forward at 02:00 on 14 Mar 2027
    assert.strictEqual(iso(R.zoned('2027-03-13', 9, 0, 'America/New_York')), '2027-03-13T14:00:00.000Z');
    assert.strictEqual(iso(R.zoned('2027-03-14', 9, 0, 'America/New_York')), '2027-03-14T13:00:00.000Z');
    // 02:30 does not exist that night: the moment just after the jump (03:30 on the clock)
    assert.strictEqual(iso(R.zoned('2027-03-14', 2, 30, 'America/New_York')), '2027-03-14T07:30:00.000Z');
    // 01:30 happens twice on 7 Nov 2027: one of the two
    const twice = iso(R.zoned('2027-11-07', 1, 30, 'America/New_York'));
    assert.ok(['2027-11-07T05:30:00.000Z', '2027-11-07T06:30:00.000Z'].includes(twice), twice);
    // London: summer time from 28 Mar 2027
    assert.strictEqual(iso(R.zoned('2027-03-27', 9, 0, 'Europe/London')), '2027-03-27T09:00:00.000Z');
    assert.strictEqual(iso(R.zoned('2027-03-28', 9, 0, 'Europe/London')), '2027-03-28T08:00:00.000Z');
});

test('zoned: whatever the zone, the clock there shows the time asked for (or just after a jump)', () => {
    for (const tz of ['America/Santiago', 'America/Havana', 'Asia/Beirut', 'Australia/Lord_Howe', 'Europe/Chisinau', 'America/Asuncion']) {
        for (let d = 0; d < 366; d += 1) {
            const ymd = R.addDays('2027-01-01', d), t = R.zoned(ymd, 0, 0, tz);
            const shown = R.fmtAt(t, tz); // "D Mon YYYY, HH:MM"
            const [day, mon, year] = shown.split(',')[0].split(' ');
            const sameDay = `${year}-${String(R.MONTHS.indexOf(mon) + 1).padStart(2, '0')}-${day.padStart(2, '0')}` === ymd;
            assert.ok(sameDay, `${tz} ${ymd} → ${shown}`);
            assert.ok(/, 0[01]:[0-5]\d$/.test(shown), `${tz} ${ymd} → ${shown}`); // midnight, or a little after it where the clocks jumped over it
        }
    }
});

test('dayIn and fmtAt follow the zone', () => {
    const t = at('2027-03-30T21:00:00Z');
    assert.strictEqual(R.dayIn('Asia/Dubai', t), '2027-03-31');
    assert.strictEqual(R.dayIn('Europe/London', t), '2027-03-30');
    assert.strictEqual(R.fmtAt(t, 'Asia/Dubai'), '31 Mar 2027, 01:00');
});

const occ = (over = {}) => ({ periodStart: '2027-01-01', periodEnd: '2027-03-31', dueDate: '2027-04-28', stage: 'OPEN', ...over });
const REMS = [{ id: 'a', offsetDays: -15 }, { id: 'b', offsetDays: -5 }, { id: 'c', offsetDays: 0 }, { id: 'd', offsetDays: 3 }];
const states = (now, opts = {}) => Object.fromEntries(R.reminderStates(opts.occ || occ(), REMS, { tz: 'Asia/Dubai', hour: 9, now: at(now), ...opts }).map(r => [r.id, r.state]));

test('instants: the period closes and the obligation becomes overdue at the midnight after, on the client\'s clock', () => {
    const { periodEndAt, dueAt } = R.instants(occ(), 'Asia/Dubai');
    assert.strictEqual(iso(periodEndAt), '2027-03-31T20:00:00.000Z');
    assert.strictEqual(iso(dueAt), '2027-04-28T20:00:00.000Z');
    const view = now => R.occurrenceView(occ(), { tz: 'Asia/Dubai', now });
    assert.strictEqual(view(at('2027-04-28T19:59:59.999Z')).overdue, false);
    assert.strictEqual(view(at('2027-04-28T20:00:00.000Z')).overdue, true);
    // the same day is still open in London when Dubai has moved on
    assert.strictEqual(R.occurrenceView(occ(), { tz: 'Europe/London', now: at('2027-04-28T20:00:00Z') }).overdue, false);
});

test('reminders: bleak until their time, then highlighted until the next one (or the due date), missed after', () => {
    // fire times, Dubai 09:00: -15 → 13 Apr, -5 → 23 Apr, 0 → 28 Apr, +3 → 1 May
    assert.deepStrictEqual(states('2027-04-10T00:00:00Z'), { a: 'BLEAK', b: 'BLEAK', c: 'BLEAK', d: 'BLEAK' });
    assert.deepStrictEqual(states('2027-04-13T04:59:00Z'), { a: 'BLEAK', b: 'BLEAK', c: 'BLEAK', d: 'BLEAK' });
    assert.deepStrictEqual(states('2027-04-13T05:00:00Z'), { a: 'HIGHLIGHTED', b: 'BLEAK', c: 'BLEAK', d: 'BLEAK' });
    assert.deepStrictEqual(states('2027-04-24T00:00:00Z'), { a: 'MISSED', b: 'HIGHLIGHTED', c: 'BLEAK', d: 'BLEAK' });
    assert.deepStrictEqual(states('2027-04-24T00:00:00Z', { sent: new Map([['a', new Date()]]) }), { a: 'SENT', b: 'HIGHLIGHTED', c: 'BLEAK', d: 'BLEAK' });
    // on the due date, until its midnight
    assert.deepStrictEqual(states('2027-04-28T19:00:00Z'), { a: 'MISSED', b: 'MISSED', c: 'HIGHLIGHTED', d: 'BLEAK' });
    // overdue: the due-date reminder's window ended at midnight; the one after the due date waits for its own time
    assert.deepStrictEqual(states('2027-04-29T00:00:00Z'), { a: 'MISSED', b: 'MISSED', c: 'MISSED', d: 'BLEAK' });
    assert.deepStrictEqual(states('2027-05-02T00:00:00Z'), { a: 'MISSED', b: 'MISSED', c: 'MISSED', d: 'HIGHLIGHTED' });
    // a closed year: what was not sent is closed
    assert.deepStrictEqual(states('2027-04-24T00:00:00Z', { occ: occ({ stage: 'COMPLETED' }), sent: new Map([['a', new Date()]]) }), { a: 'SENT', b: 'CLOSED', c: 'CLOSED', d: 'CLOSED' });
});

test('occurrenceView: status and colour', () => {
    const v = (now, over, opts = {}) => R.occurrenceView(occ(over), { tz: 'Asia/Dubai', hour: 9, amberDays: 7, reminders: REMS, now: at(now), ...opts });
    let x = v('2027-02-01T00:00:00Z');
    assert.deepStrictEqual([x.status, x.colour, x.inWindow], ['UPCOMING', 'green', false]);
    x = v('2027-04-02T00:00:00Z');
    assert.deepStrictEqual([x.status, x.colour, x.inWindow, x.daysLeft], ['PERIOD_CLOSED', 'green', true, 26]);
    x = v('2027-04-14T00:00:00Z', { stage: 'DATA_COLLECTED' });
    assert.deepStrictEqual([x.status, x.colour, x.actionable, x.highlighted.id], ['DATA_COLLECTED', 'amber', true, 'a']);
    x = v('2027-04-22T00:00:00Z', { stage: 'FILED' }, { reminders: [] }); // no reminders, 6 days to go
    assert.deepStrictEqual([x.status, x.colour], ['FILED', 'amber']);
    x = v('2027-05-02T00:00:00Z', { stage: 'FILED' });
    assert.deepStrictEqual([x.status, x.colour, x.overdue, x.daysLeft], ['OVERDUE', 'red', true, -4]);
    x = v('2027-05-02T00:00:00Z', { stage: 'COMPLETED' });
    assert.deepStrictEqual([x.status, x.colour, x.overdue, x.inWindow, x.actionable], ['COMPLETED', 'done', false, false, false]);
    // a reminder before the period ends opens the window early
    x = R.occurrenceView(occ(), { tz: 'Asia/Dubai', reminders: [{ id: 'early', offsetDays: -60 }], now: at('2027-03-01T00:00:00Z') });
    assert.deepStrictEqual([x.status, x.inWindow, x.highlighted.id], ['UPCOMING', true, 'early']);
});

test('yearDates: next year\'s dates are the same days a year on; month ends and 29 February', () => {
    const base = { periodStart: '2026-01-01', periodEnd: '2026-12-31', dueDate: '2027-04-30' };
    assert.deepStrictEqual(R.yearDates(base, 1), base);
    assert.deepStrictEqual(R.yearDates(base, 3), { periodStart: '2028-01-01', periodEnd: '2028-12-31', dueDate: '2029-04-30' });
    // a February period end that is the month's last day stays the last day
    assert.deepStrictEqual(R.yearDates({ periodStart: '2026-12-01', periodEnd: '2027-02-28', dueDate: '2027-03-31' }, 2), { periodStart: '2027-12-01', periodEnd: '2028-02-29', dueDate: '2028-03-31' });
    // a due date on 29 February never moves later
    assert.deepStrictEqual(R.yearDates({ periodStart: '2027-12-01', periodEnd: '2028-01-31', dueDate: '2028-02-29' }, 2), { periodStart: '2028-12-01', periodEnd: '2029-01-31', dueDate: '2029-02-28' });
    // due on the period's last day: the period end is not pushed past the due date
    assert.deepStrictEqual(R.yearDates({ periodStart: '2027-02-01', periodEnd: '2027-02-28', dueDate: '2027-02-28' }, 2), { periodStart: '2028-02-01', periodEnd: '2028-02-28', dueDate: '2028-02-28' });
    assert.deepStrictEqual(R.yearDates({ periodStart: '2028-02-29', periodEnd: '2028-03-31', dueDate: '2028-04-30' }, 2), { periodStart: '2029-02-28', periodEnd: '2029-03-31', dueDate: '2029-04-30' });
    for (let n = 1; n < 40; n++) {
        const d = R.yearDates({ periodStart: '2027-02-28', periodEnd: '2027-02-28', dueDate: '2027-02-28' }, n);
        assert.strictEqual(R.datesProblem(d.periodStart, d.periodEnd, d.dueDate), null, JSON.stringify(d));
    }
});

test('datesProblem: the SRS date rules', () => {
    assert.strictEqual(R.datesProblem('2027-01-01', '2027-03-31', '2027-04-28'), null);
    assert.strictEqual(R.datesProblem('2027-01-01', '2027-03-31', '2027-03-31'), null); // on the period end is allowed (SRS 15)
    assert.match(R.datesProblem('2027-04-01', '2027-03-31', '2027-04-28'), /period end cannot be before/);
    assert.match(R.datesProblem('2027-01-01', '2027-03-31', '2027-03-30'), /due date cannot be before/);
    assert.match(R.datesProblem('2027-02-30', '2027-03-31', '2027-04-28'), /period start/);
    assert.match(R.datesProblem('2020-01-01', '2027-03-31', '2027-04-28'), /three years long/);
    assert.match(R.datesProblem('2027-01-01', '2027-03-31', '2031-04-28'), /within three years/);
});

test('render: placeholders, whatever the case; unknown ones stay, empty ones are listed', () => {
    const ctx = {
        client: { name: 'Al Noor Trading LLC', registrationNo: '100123456700003', email: '', contactNumber: '+971501234567' },
        countryName: 'United Arab Emirates', obligationName: 'VAT Return Q1',
        occurrence: { periodStart: '2027-01-01', periodEnd: '2027-03-31', dueDate: '2027-04-28' },
        fields: { 'Trade License Number': 'TL-998', 'Client Name': 'not this one' },
    };
    const r = R.render('Dear [Client Name], your VAT return for the period [Period Start] to [Period End] is due on [Due Date]. TRN [registration no] · TL [trade license  number] · [Email] · [Whatever]', ctx);
    assert.strictEqual(r.text, 'Dear Al Noor Trading LLC, your VAT return for the period 1 Jan 2027 to 31 Mar 2027 is due on 28 Apr 2027. TRN 100123456700003 · TL TL-998 ·  · [Whatever]');
    assert.deepStrictEqual(r.missing, ['Whatever']);
    assert.deepStrictEqual(r.empty, ['Email']);
    assert.strictEqual(R.render('[Invoice Amount] [Receipt Number]', { invoice: { amountText: 'AED 1,500.00' }, receipt: { number: 'RCT-2027-0001' } }).text, 'AED 1,500.00 RCT-2027-0001');
    assert.ok(R.RESERVED.has(R.keyOf('Password')) && R.RESERVED.has(R.keyOf('pin code')) && R.RESERVED.has(R.keyOf('Client Name')));
});

test('waPhone: national and international forms; nonsense is refused', () => {
    assert.strictEqual(R.waPhone('050 123 4567', '971'), '971501234567');
    assert.strictEqual(R.waPhone('+971 50 123 4567', '92'), '971501234567');
    assert.strictEqual(R.waPhone('00971-50-123-4567', '92'), '971501234567');
    assert.strictEqual(R.waPhone('0300 1234567', '92'), '923001234567');
    assert.strictEqual(R.waPhone('923001234567', '92'), '923001234567');
    assert.strictEqual(R.waPhone('3001234567', '92'), '923001234567');
    assert.strictEqual(R.waPhone('(212) 555-0101', '1'), '12125550101');
    assert.strictEqual(R.waPhone('call me', '971'), null);
    assert.strictEqual(R.waPhone('123', '971'), null);
    assert.strictEqual(R.waPhone('', '971'), null);
    assert.strictEqual(R.toE164('050 123 4567', '971'), '+971501234567');
});

test('waLink: the firm\'s number opens WhatsApp Web, the app, WhatsApp Business on Android, or whatever the device has', () => {
    const t = 'Hi & bye';
    assert.strictEqual(R.waLink('971501234567', t, 'WEB'), 'https://web.whatsapp.com/send?phone=971501234567&text=Hi%20%26%20bye');
    assert.strictEqual(R.waLink('971501234567', t, 'APP'), 'whatsapp://send?phone=971501234567&text=Hi%20%26%20bye');
    assert.strictEqual(R.waLink('971501234567', t, 'BUSINESS', { android: true }), 'intent://send?phone=971501234567&text=Hi%20%26%20bye#Intent;scheme=whatsapp;package=com.whatsapp.w4b;end');
    assert.strictEqual(R.waLink('971501234567', t, 'BUSINESS'), R.waUrl('971501234567', t));
    assert.strictEqual(R.waLink('971501234567', t, 'ANY'), R.waUrl('971501234567', t));
});

test('waUrl: the message survives new lines, &, Arabic and emoji', () => {
    const text = 'Dear Client,\nPlease send A&B documents 🙏 شكرا';
    const url = R.waUrl('971501234567', text);
    assert.ok(url.startsWith('https://wa.me/971501234567?text='));
    assert.strictEqual(decodeURIComponent(url.split('?text=')[1]), text);
});
