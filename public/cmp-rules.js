/* The rules of the Compliance & Deadlines module, in one place for the server (require) and the browser (window.CmpRules), so a screen
   never shows a different state from what the server decides:
   - time zones: a due date is a calendar day in the CLIENT's time zone; it is overdue from the midnight after it, there
   - reminders: when each one comes due, and whether it is waiting (bleak), due now (highlighted), missed, sent or closed (SRS 6)
   - the status and colour of one year of an obligation
   - next year's dates of a recurring obligation (SRS 4: dates are never calculated, only copied a year on for a person to confirm)
   - message templates and their [placeholders] (SRS 7), and WhatsApp links (SRS 8)
   Dates are 'YYYY-MM-DD' strings; instants are Date objects (or milliseconds). Nothing here touches the database or the page. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CmpRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DAY = 86400000;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = n => String(n).padStart(2, '0');

  /* ---------- calendar days ---------- */
  function ymdOk(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
    const [y, m, d] = s.split('-').map(Number), dt = new Date(Date.UTC(y, m - 1, d));
    return y >= 1900 && y <= 2200 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  // A day from the database (a date column comes back as midnight UTC) or a string → 'YYYY-MM-DD'
  const ymdOf = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
  const parse = ymd => { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const addDays = (ymd, n) => new Date(parse(ymd) + n * DAY).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / DAY);
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12
  const fmtDay = v => { const s = ymdOf(v); if (!ymdOk(s)) return ''; const [y, m, d] = s.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

  /* ---------- time zones ---------- */
  const fmtCache = new Map();
  function clock(tz) {
    let f = fmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      fmtCache.set(tz, f);
    }
    return f;
  }
  function wall(tz, t) {
    const p = {};
    for (const x of clock(tz).formatToParts(new Date(t))) p[x.type] = x.value;
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
  }
  // How far the clock in tz is ahead of UTC at instant t (ms)
  function offsetMs(tz, t) {
    const w = wall(tz, t);
    return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000;
  }
  // The instant at which the clock in tz shows ymd hh:mm. Where the clocks jump forward over that time (a summer-time change) it is
  // the moment just after the jump; where they go back and show it twice, it is one of the two.
  function zoned(ymd, hh, mm, tz) {
    const [y, m, d] = ymd.split('-').map(Number);
    const local = Date.UTC(y, m - 1, d, hh, mm);
    let t = local - offsetMs(tz, local);
    const o2 = offsetMs(tz, t);
    if (local - o2 !== t) {
      const t2 = local - o2;
      t = offsetMs(tz, t2) === o2 ? t2 : Math.max(t, t2);
    }
    return new Date(t);
  }
  // Today's date in tz
  function dayIn(tz, now = Date.now()) { const w = wall(tz, +now); return `${w.y}-${pad(w.m)}-${pad(w.d)}`; }
  // "3 Mar 2027, 09:00" as the clock in tz shows it
  function fmtAt(t, tz) {
    if (t === null || t === undefined || !Number.isFinite(+t)) return '';
    const w = wall(tz, +t);
    return `${w.d} ${MONTHS[w.m - 1]} ${w.y}, ${pad(w.h)}:${pad(w.mi)}`;
  }

  /* ---------- one year of an obligation ---------- */
  const STAGES = ['OPEN', 'DATA_COLLECTED', 'FILED', 'PAID', 'COMPLETED'];
  const MANUAL = ['DATA_COLLECTED', 'FILED', 'PAID']; // the steps a person sets; Upcoming, Period closed and Overdue follow from the dates
  const STATUS = {
    UPCOMING: 'Upcoming', PERIOD_CLOSED: 'Period closed', DATA_COLLECTED: 'Data collected', FILED: 'Filed', PAID: 'Paid', COMPLETED: 'Completed', OVERDUE: 'Overdue',
    PLANNED: 'Planned', // a period still to come, shown ahead of time (not made yet)
  };

  // When the period is over (the midnight after its last day) and when the obligation becomes overdue (the midnight after the due date),
  // both in the client's time zone
  function instants(occ, tz) {
    return { periodEndAt: zoned(addDays(ymdOf(occ.periodEnd), 1), 0, 0, tz), dueAt: zoned(addDays(ymdOf(occ.dueDate), 1), 0, 0, tz) };
  }
  // A reminder comes due offsetDays from the due date (negative = before), at the firm's reminder hour on the client's clock
  const fireAt = (dueYmd, offsetDays, hour, tz) => zoned(addDays(ymdOf(dueYmd), offsetDays), hour, 0, tz);

  // Every reminder of one year, with its state (SRS 6):
  //   BLEAK        its time has not come: dimmed, no WhatsApp button
  //   HIGHLIGHTED  its time has come and the next reminder's (or, before the due date, the due date) has not: the one to send now
  //   MISSED       its time came and went without a message: still sendable
  //   SENT         a message was sent for it (this year)
  //   CLOSED       the year was closed without it
  // sent: Map reminderId → when it was sent (only messages that were not marked "not sent")
  function reminderStates(occ, reminders, { tz, hour = 9, now = Date.now(), sent = new Map() } = {}) {
    const due = ymdOf(occ.dueDate), dueAt = +instants(occ, tz).dueAt, closed = occ.stage === 'COMPLETED';
    const list = [...(reminders || [])].sort((a, b) => a.offsetDays - b.offsetDays)
      .map(r => ({ ...r, fireAt: +fireAt(due, r.offsetDays, hour, tz), sentAt: sent.get(r.id) || null }));
    list.forEach((r, i) => {
      const next = i + 1 < list.length ? list[i + 1].fireAt : Infinity;
      r.until = r.fireAt < dueAt ? Math.min(next, dueAt) : next;
      if (r.sentAt) r.state = 'SENT';
      else if (closed) r.state = 'CLOSED';
      else if (+now < r.fireAt) r.state = 'BLEAK';
      else r.state = +now < r.until ? 'HIGHLIGHTED' : 'MISSED';
    });
    return list;
  }

  // Status, colour and reminders of one year. Overdue = not completed by the end of the due date (SRS 6), whatever step it is at.
  // Colours: green safe, amber approaching (a reminder to send, or the due date within amberDays), red overdue, 'done' completed.
  function occurrenceView(occ, { tz, hour = 9, amberDays = 7, now = Date.now(), reminders = [], sent } = {}) {
    const { periodEndAt, dueAt } = instants(occ, tz);
    const rs = reminderStates(occ, reminders, { tz, hour, now, sent });
    const completed = occ.stage === 'COMPLETED';
    const overdue = !completed && +now >= +dueAt;
    const status = completed ? 'COMPLETED' : overdue ? 'OVERDUE' : MANUAL.includes(occ.stage) ? occ.stage : +now >= +periodEndAt ? 'PERIOD_CLOSED' : 'UPCOMING';
    const highlighted = rs.find(r => r.state === 'HIGHLIGHTED') || null;
    const missed = rs.filter(r => r.state === 'MISSED');
    const soon = +dueAt - +now <= amberDays * DAY;
    const colour = completed ? 'done' : overdue ? 'red' : (highlighted || missed.length || soon) ? 'amber' : 'green';
    const firstFire = rs.length ? rs[0].fireAt : Infinity;
    return {
      status, colour, overdue, completed, periodEndAt, dueAt, reminders: rs, highlighted, missed,
      actionable: Boolean(highlighted) || missed.length > 0,
      // shown on the notifications dashboard from the end of the period (or the first reminder, if earlier) until it is closed
      inWindow: !completed && +now >= Math.min(+periodEndAt, firstFire),
      daysLeft: daysBetween(dayIn(tz, now), ymdOf(occ.dueDate)), // 0 = due today, negative = days overdue (client's calendar)
    };
  }

  /* ---------- recurrence ---------- */
  // How often an obligation comes back (the CA: some countries' returns are monthly or quarterly). Each repetition is a "period"; a
  // limit is given in years (SRS 4), so a monthly obligation for 2 years has 24 periods.
  const FREQUENCIES = {
    YEARLY: { months: 12, perYear: 1, label: 'Every year', unit: 'year' },
    HALF_YEARLY: { months: 6, perYear: 2, label: 'Every six months', unit: 'half-year' },
    QUARTERLY: { months: 3, perYear: 4, label: 'Every quarter', unit: 'quarter' },
    MONTHLY: { months: 1, perYear: 12, label: 'Every month', unit: 'month' },
  };
  const freqOf = f => FREQUENCIES[f] || FREQUENCIES.YEARLY;
  // ymd moved k months. sticky: a month's last day stays the last day (31 Jan → 28 Feb → 31 Mar); otherwise the day is kept, or the
  // month's last day if the month is shorter (31 Jan → 28 Feb, 29 Feb → 28 Feb next year).
  function shiftMonths(ymd, k, sticky) {
    const [y, m, d] = ymd.split('-').map(Number), idx = y * 12 + (m - 1) + k;
    const ny = Math.floor(idx / 12), nm = idx - ny * 12 + 1, last = lastDay(ny, nm);
    const dd = sticky && d === lastDay(y, m) ? last : Math.min(d, last);
    return `${ny}-${pad(nm)}-${pad(dd)}`;
  }
  const shiftYears = (ymd, k, sticky) => shiftMonths(ymd, 12 * k, sticky);
  // The proposed dates of period n of a series whose period 1 has the base dates (a person confirms them: SRS 4, no calculated due
  // dates). A due date is never moved later than the same day of the month; a period that ends on a month's last day keeps doing so.
  function periodDates(base, n, frequency = 'YEARLY') {
    const k = (n - 1) * freqOf(frequency).months;
    const periodStart = shiftMonths(ymdOf(base.periodStart), k, false), dueDate = shiftMonths(ymdOf(base.dueDate), k, false);
    let periodEnd = shiftMonths(ymdOf(base.periodEnd), k, true);
    if (dueDate < periodEnd) periodEnd = shiftMonths(ymdOf(base.periodEnd), k, false);
    return { periodStart, periodEnd, dueDate };
  }
  const yearDates = (base, n) => periodDates(base, n, 'YEARLY');
  // How often an obligation comes back, from its first period (the CA: no "comes back" list, the three dates say it). A period of
  // exactly one month comes back every month, three months every quarter, six months every six months; anything else every year
  // (a year, like 1 Jul 2026 – 30 Jun 2027, or any other stretch). A person can still choose "every year" for a shorter period.
  function detectFrequency(periodStart, periodEnd) {
    const a = ymdOf(periodStart), b = ymdOf(periodEnd);
    if (!ymdOk(a) || !ymdOk(b)) return 'YEARLY';
    for (const [k, f] of [[1, 'MONTHLY'], [3, 'QUARTERLY'], [6, 'HALF_YEARLY']]) {
      if (addDays(shiftMonths(a, k, false), -1) === b) return f;
      const [ya, ma, da] = a.split('-').map(Number);
      if (da === 1 && shiftMonths(`${ya}-${pad(ma)}-01`, k - 1, false).slice(0, 7) === b.slice(0, 7) && Number(b.slice(8)) === lastDay(...b.split('-').slice(0, 2).map(Number))) return f;
    }
    return 'YEARLY';
  }
  // The periods still to come of a series, as they would be proposed (the CA: the calendar shows the future, with no end for an obligation
  // that has none). From period fromSeq while the due date is not after untilDue, never past the number of years, at most max of them.
  function projectPeriods(series, fromSeq, untilDue, max = 400) {
    const base = { periodStart: series.basePeriodStart, periodEnd: series.basePeriodEnd, dueDate: series.baseDueDate };
    const limit = periodsAllowed(series.yearsTotal, series.frequency), out = [];
    for (let seq = Math.max(1, fromSeq); out.length < max && (!limit || seq <= limit); seq++) {
      const d = periodDates(base, seq - (series.baseSeq || 1) + 1, series.frequency);
      if (d.dueDate > untilDue) break;
      out.push({ seq, ...d });
    }
    return out;
  }
  // How many periods a limit of so many years allows (null = no end)
  const periodsAllowed = (yearsTotal, frequency) => (yearsTotal ? yearsTotal * freqOf(frequency).perYear : null);
  // A short name for a period: "Mar 2027" for a calendar month, "Jan – Mar 2027" for calendar months, "2027" for a calendar year, else the dates
  function periodName(o) {
    const a = ymdOf(o.periodStart), b = ymdOf(o.periodEnd);
    if (!ymdOk(a) || !ymdOk(b)) return '';
    const [ya, ma, da] = a.split('-').map(Number), [yb, mb, db] = b.split('-').map(Number);
    if (da === 1 && db === lastDay(yb, mb)) {
      if (ya === yb && ma === 1 && mb === 12) return String(ya);
      if (ya === yb && ma === mb) return `${MONTHS[ma - 1]} ${ya}`;
      return ya === yb ? `${MONTHS[ma - 1]} – ${MONTHS[mb - 1]} ${yb}` : `${MONTHS[ma - 1]} ${ya} – ${MONTHS[mb - 1]} ${yb}`;
    }
    return `${fmtDay(a)} – ${fmtDay(b)}`;
  }
  // SRS 4 and 15: the period end is not before its start, the due date is on or after the period end; and nothing absurd
  function datesProblem(periodStart, periodEnd, dueDate) {
    if (!ymdOk(periodStart)) return 'Enter the period start date.';
    if (!ymdOk(periodEnd)) return 'Enter the period end date.';
    if (!ymdOk(dueDate)) return 'Enter the due date.';
    if (periodEnd < periodStart) return 'The period end cannot be before the period start.';
    if (dueDate < periodEnd) return 'The due date cannot be before the period end.';
    if (daysBetween(periodStart, periodEnd) > 3 * 366) return 'A period can be at most three years long.';
    if (daysBetween(periodEnd, dueDate) > 3 * 366) return 'The due date must be within three years of the period end.';
    return null;
  }
  const offsetLabel = n => (n < 0 ? `${-n} day${n === -1 ? '' : 's'} before` : n > 0 ? `${n} day${n === 1 ? '' : 's'} after` : 'On the due date');
  const yearsLabel = n => (n ? `for ${n} year${n === 1 ? '' : 's'}` : 'with no end');
  const repeatsLabel = (frequency, yearsTotal) => `${freqOf(frequency).label} ${yearsLabel(yearsTotal)}`;
  // "for 5 years" / "unlimited": the CA's "How many years"
  const yearsShort = n => (n ? `${n} year${n === 1 ? '' : 's'}` : 'Unlimited');

  /* ---------- templates and WhatsApp ---------- */
  // [Placeholder] names match whatever the case, the spaces and the dots: [client name] = [Client Name], [Registration No] = [Registration No.]
  const keyOf = s => String(s || '').replace(/\./g, '').trim().replace(/\s+/g, ' ').toLowerCase();
  // Every [placeholder] a template can use, in groups (the CA: from everywhere, the client's details together, the obligation's
  // together...). The client's own extra fields come after the client's details.
  const PLACEHOLDER_GROUPS = [
    ['Client details', ['Client Name', 'Client Code', 'Registration No.', 'Contact Number', 'WhatsApp Number', 'Email', 'Address', 'Reference', 'Country']],
    ['Obligation', ['Obligation', 'Period Start', 'Period End', 'Due Date', 'Days Left', 'Portal Link']],
    ['Invoice', ['Invoice Number', 'Invoice Date', 'Invoice Amount', 'Payment Due', 'Amount Outstanding']],
    ['Receipt', ['Receipt Number', 'Receipt Date', 'Receipt Amount']],
    ['Your firm', ['Firm Name', 'Firm Phone', 'Firm Email']],
  ];
  const PLACEHOLDERS = PLACEHOLDER_GROUPS.flatMap(g => g[1]);
  // A custom field may not take one of these names (nor the portal login's: those never go into a message). "WhatsApp Number" may: a
  // field of that name is the number WhatsApp messages go to.
  const RESERVED = new Set([...PLACEHOLDERS.filter(n => n !== 'WhatsApp Number'), 'Username', 'User Name', 'Password', 'Pin Code', 'Pin'].map(keyOf));

  // Fills a template. ctx: { client, countryName, whatsapp, obligationName, portalUrl, daysLeft, occurrence, fields: { 'Trade License Number': '…' },
  // invoice: { number, amountText, date, dueDate, outstandingText }, receipt: { number, date, amountText }, firm: { name, phone, email } }
  // Returns the text, the [names] that are not known (left as typed) and the known ones that have no value (left empty).
  function render(body, ctx = {}) {
    const values = new Map();
    const put = (k, v) => { if (!values.has(keyOf(k))) values.set(keyOf(k), v === null || v === undefined ? '' : String(v)); };
    const c = ctx.client || {}, o = ctx.occurrence || {};
    const inv = ctx.invoice || {}, rc = ctx.receipt || {}, firm = ctx.firm || {};
    put('Client Name', c.name); put('Client Code', c.code); put('Registration No.', c.registrationNo); put('Email', c.email); put('Contact Number', c.contactNumber);
    put('WhatsApp Number', ctx.whatsapp || c.contactNumber); put('Address', c.address); put('Reference', c.reference); put('Country', ctx.countryName || c.country);
    put('Obligation', ctx.obligationName); put('Due Date', fmtDay(o.dueDate)); put('Period Start', fmtDay(o.periodStart)); put('Period End', fmtDay(o.periodEnd));
    put('Days Left', ctx.daysLeft === undefined || ctx.daysLeft === null || !o.dueDate ? '' : ctx.daysLeft >= 0 ? `${ctx.daysLeft} day${ctx.daysLeft === 1 ? '' : 's'}` : `${-ctx.daysLeft} day${ctx.daysLeft === -1 ? '' : 's'} overdue`);
    put('Portal Link', ctx.portalUrl);
    put('Invoice Number', inv.number); put('Invoice Date', fmtDay(inv.date)); put('Invoice Amount', inv.amountText); put('Payment Due', fmtDay(inv.dueDate)); put('Amount Outstanding', inv.outstandingText);
    put('Receipt Number', rc.number); put('Receipt Date', fmtDay(rc.date)); put('Receipt Amount', rc.amountText);
    put('Firm Name', firm.name); put('Firm Phone', firm.phone); put('Firm Email', firm.email);
    for (const [name, v] of Object.entries(ctx.fields || {})) put(name, v);
    const missing = [], empty = [];
    const text = String(body || '').replace(/\[([^[\]\n]{1,60})\]/g, (all, name) => {
      const k = keyOf(name);
      if (!values.has(k)) { if (!missing.includes(name)) missing.push(name); return all; }
      const v = values.get(k);
      if (!v && !empty.includes(name)) empty.push(name);
      return v;
    });
    return { text, missing, empty };
  }

  // A phone number as WhatsApp wants it: the country code and the number, digits only (8 to 15). A number typed with + or 00 is taken as it
  // is; one starting with 0 is a national number of the client's country (the 0 goes, the country's code comes first).
  function waPhone(raw, dial) {
    const s = String(raw || '').trim();
    if (!s || /[^\d\s()+.-]/.test(s)) return null;
    const d = s.replace(/\D/g, ''), cc = String(dial || '');
    let digits;
    if (s.startsWith('+')) digits = d;
    else if (d.startsWith('00')) digits = d.slice(2);
    else if (d.startsWith('0')) digits = cc + d.replace(/^0+/, '');
    else if (cc && d.startsWith(cc) && d.length >= cc.length + 7) digits = d;
    else digits = cc + d;
    return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
  }
  const toE164 = (raw, dial) => { const d = waPhone(raw, dial); return d ? '+' + d : null; };
  const waUrl = (digits, text) => `https://wa.me/${digits}?text=${encodeURIComponent(text || '')}`;
  // Which WhatsApp a message goes from (the user's request: the firm's business number). A link cannot pick the sender: WhatsApp sends
  // from the account that is open where the link opens. So each of the firm's numbers says how it is opened on this computer or phone.
  const SENDER_OPEN = { WEB: 'WhatsApp Web (in the browser)', BUSINESS: 'WhatsApp Business app', APP: 'WhatsApp app (installed)', ANY: 'Let the device choose' };
  function waLink(digits, text, open = 'ANY', { android = false } = {}) {
    const t = encodeURIComponent(text || '');
    if (open === 'WEB') return `https://web.whatsapp.com/send?phone=${digits}&text=${t}`;
    if (open === 'APP') return `whatsapp://send?phone=${digits}&text=${t}`;
    if (open === 'BUSINESS' && android) return `intent://send?phone=${digits}&text=${t}#Intent;scheme=whatsapp;package=com.whatsapp.w4b;end`;
    return waUrl(digits, text); // (WhatsApp Business on a computer or an iPhone: the device opens the WhatsApp it has)
  }

  const TEMPLATE_PURPOSES = { REMINDER: 'Reminder', DATA_COLLECTION: 'Data collection', COMPLETION: 'Obligation completed', INVOICE: 'Invoice', RECEIPT: 'Receipt', OTHER: 'Other' };
  const MESSAGE_KINDS = TEMPLATE_PURPOSES;

  return {
    DAY, MONTHS, ymdOk, ymdOf, addDays, daysBetween, fmtDay, zoned, dayIn, fmtAt, offsetMs,
    STAGES, MANUAL, STATUS, instants, fireAt, reminderStates, occurrenceView,
    FREQUENCIES, freqOf, shiftMonths, shiftYears, periodDates, yearDates, detectFrequency, projectPeriods, periodsAllowed, periodName, datesProblem, offsetLabel, yearsLabel, repeatsLabel, yearsShort,
    keyOf, PLACEHOLDER_GROUPS, PLACEHOLDERS, RESERVED, render, waPhone, toE164, waUrl, SENDER_OPEN, waLink, TEMPLATE_PURPOSES, MESSAGE_KINDS,
  };
});
