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
  // How a day is written (the CA's Settings, 24 Nov 2026: the firm chooses). The browser sets the firm's choice once (setDayFormat); the
  // server, shared by every firm, passes it where it matters (a message: ctx.dateFormat) and otherwise writes "3 Mar 2027".
  const DAY_FORMATS = { 'D MMM YYYY': '25 Mar 2027', 'DD/MM/YYYY': '25/03/2027', 'MM/DD/YYYY': '03/25/2027', 'YYYY-MM-DD': '2027-03-25', 'DD-MMM-YYYY': '25-Mar-2027' };
  let dayFormat = 'D MMM YYYY';
  const setDayFormat = f => { dayFormat = DAY_FORMATS[f] ? f : 'D MMM YYYY'; };
  const fmtDay = (v, fmt = dayFormat) => {
    const s = ymdOf(v); if (!ymdOk(s)) return '';
    const [y, m, d] = s.split('-').map(Number);
    switch (fmt) {
      case 'DD/MM/YYYY': return `${pad(d)}/${pad(m)}/${y}`;
      case 'MM/DD/YYYY': return `${pad(m)}/${pad(d)}/${y}`;
      case 'YYYY-MM-DD': return s;
      case 'DD-MMM-YYYY': return `${pad(d)}-${MONTHS[m - 1]}-${y}`;
      default: return `${d} ${MONTHS[m - 1]} ${y}`;
    }
  };
  const fmtDayAs = (v, fmt) => fmtDay(v, fmt);
  // How a number is written (the same settings): the thousands and decimal marks, and the Indian/Pakistani grouping (12,34,567.89)
  const NUMBER_FORMATS = { '1,234.56': '1,234,567.89', '1.234,56': '1.234.567,89', '1 234.56': '1 234 567.89', "1'234.56": "1'234'567.89", '12,34,567.89': '12,34,567.89' };
  let numberFormat = '1,234.56';
  const setNumberFormat = f => { numberFormat = NUMBER_FORMATS[f] ? f : '1,234.56'; };
  function fmtNum(n, decimals = 2, fmt = numberFormat) {
    const v = Number(n || 0), neg = v < 0, [int, frac] = Math.abs(v).toFixed(decimals).split('.');
    let g;
    if (fmt === '12,34,567.89') g = int.length > 3 ? `${int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${int.slice(-3)}` : int;
    else g = int.replace(/\B(?=(\d{3})+(?!\d))/g, { '1.234,56': '.', '1 234.56': ' ', "1'234.56": "'" }[fmt] || ',');
    const dec = fmt === '1.234,56' ? ',' : '.';
    return (neg ? '-' : '') + g + (frac ? dec + frac : '');
  }

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
    return `${fmtDay(`${w.y}-${pad(w.m)}-${pad(w.d)}`)}, ${pad(w.h)}:${pad(w.mi)}`;
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
  // A reminder comes due offsetDays from the due date (negative = before), at the firm's reminder hour on the client's clock. work (the CA's
  // Settings, 24 Nov 2026): { weekend: [0 = Sunday … 6 = Saturday], holidays: ['YYYY-MM-DD'], mode: BEFORE | AFTER } moves a reminder that
  // falls on a weekend day or a public holiday to the working day before (or after); mode NONE (or no work) leaves it where it is.
  function reminderDay(dueYmd, offsetDays, work) {
    let d = addDays(ymdOf(dueYmd), offsetDays);
    if (!work || !['BEFORE', 'AFTER'].includes(work.mode)) return d;
    const off = new Set(work.weekend || []), hol = work.holidaySet || new Set(work.holidays || []), step = work.mode === 'BEFORE' ? -1 : 1;
    for (let i = 0; i < 31 && (off.has(new Date(parse(d)).getUTCDay()) || hol.has(d)); i++) d = addDays(d, step);
    return d;
  }
  // The firm's settings → the work option above (once per request: the holidays as a set)
  const workOf = st => (st && ['BEFORE', 'AFTER'].includes(st.holidayMode) ? { mode: st.holidayMode, weekend: st.weekendDays || [], holidaySet: new Set((st.holidays || []).map(h => h.date)) } : null);
  const fireAt = (dueYmd, offsetDays, hour, tz, work) => zoned(reminderDay(dueYmd, offsetDays, work), hour, 0, tz);

  // Every reminder of one year, with its state (SRS 6):
  //   BLEAK        its time has not come: dimmed, no WhatsApp button
  //   HIGHLIGHTED  its time has come and the next reminder's (or, before the due date, the due date) has not: the one to send now
  //   MISSED       its time came and went without a message: still sendable
  //   SENT         a message was sent for it (this year)
  //   CLOSED       the year was closed without it
  // sent: Map reminderId → when it was sent (only messages that were not marked "not sent")
  function reminderStates(occ, reminders, { tz, hour = 9, now = Date.now(), sent = new Map(), work = null } = {}) {
    const due = ymdOf(occ.dueDate), dueAt = +instants(occ, tz).dueAt, closed = occ.stage === 'COMPLETED';
    const list = [...(reminders || [])].sort((a, b) => a.offsetDays - b.offsetDays)
      .map(r => ({ ...r, fireAt: +fireAt(due, r.offsetDays, hour, tz, work), sentAt: sent.get(r.id) || null }));
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
  function occurrenceView(occ, { tz, hour = 9, amberDays = 7, now = Date.now(), reminders = [], sent, work = null } = {}) {
    const { periodEndAt, dueAt } = instants(occ, tz);
    const rs = reminderStates(occ, reminders, { tz, hour, now, sent, work });
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
    ['Advance payment', ['Advance Number', 'Advance Date', 'Advance Amount', 'Advance Description', 'Advance Balance']],
    ['Invoice', ['Invoice Number', 'Invoice Date', 'Invoice Amount', 'Payment Due', 'Amount Outstanding']],
    ['Receipt', ['Receipt Number', 'Receipt Date', 'Receipt Amount']],
    ['Your firm', ['Firm Name', 'Firm Phone', 'Firm Email', 'Firm Address', 'Firm Website']],
  ];
  const PLACEHOLDERS = PLACEHOLDER_GROUPS.flatMap(g => g[1]);
  // A custom field may not take one of these names (nor the portal login's: those never go into a message). "WhatsApp Number" may: a
  // field of that name is the number WhatsApp messages go to.
  const RESERVED = new Set([...PLACEHOLDERS.filter(n => n !== 'WhatsApp Number'), 'Username', 'User Name', 'Password', 'Pin Code', 'Pin'].map(keyOf));

  // Fills a template. ctx: { client, countryName, whatsapp, obligationName, portalUrl, daysLeft, occurrence, fields: { 'Trade License Number': '…' },
  // invoice: { number, amountText, date, dueDate, outstandingText }, receipt: { number, date, amountText }, advance: { number, date, amountText,
  // description, balanceText }, firm: { name, phone, email, address, website }, dateFormat }
  // Returns the text, the [names] that are not known (left as typed) and the known ones that have no value (left empty).
  function render(body, ctx = {}) {
    const values = new Map();
    const put = (k, v) => { if (!values.has(keyOf(k))) values.set(keyOf(k), v === null || v === undefined ? '' : String(v)); };
    const c = ctx.client || {}, o = ctx.occurrence || {};
    const inv = ctx.invoice || {}, rc = ctx.receipt || {}, adv = ctx.advance || {}, firm = ctx.firm || {};
    const fmtDay = v => fmtDayAs(v, ctx.dateFormat || dayFormat);
    put('Client Name', c.name); put('Client Code', c.code); put('Registration No.', c.registrationNo); put('Email', c.email); put('Contact Number', c.contactNumber);
    put('WhatsApp Number', ctx.whatsapp || c.contactNumber); put('Address', c.address); put('Reference', c.reference); put('Country', ctx.countryName || c.country);
    put('Obligation', ctx.obligationName); put('Due Date', fmtDay(o.dueDate)); put('Period Start', fmtDay(o.periodStart)); put('Period End', fmtDay(o.periodEnd));
    put('Days Left', ctx.daysLeft === undefined || ctx.daysLeft === null || !o.dueDate ? '' : ctx.daysLeft >= 0 ? `${ctx.daysLeft} day${ctx.daysLeft === 1 ? '' : 's'}` : `${-ctx.daysLeft} day${ctx.daysLeft === -1 ? '' : 's'} overdue`);
    put('Portal Link', ctx.portalUrl);
    put('Invoice Number', inv.number); put('Invoice Date', fmtDay(inv.date)); put('Invoice Amount', inv.amountText); put('Payment Due', fmtDay(inv.dueDate)); put('Amount Outstanding', inv.outstandingText);
    put('Receipt Number', rc.number); put('Receipt Date', fmtDay(rc.date)); put('Receipt Amount', rc.amountText);
    put('Advance Number', adv.number); put('Advance Date', fmtDay(adv.date)); put('Advance Amount', adv.amountText); put('Advance Description', adv.description); put('Advance Balance', adv.balanceText);
    put('Firm Name', firm.name); put('Firm Phone', firm.phone); put('Firm Email', firm.email); put('Firm Address', firm.address); put('Firm Website', firm.website);
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

  /* ---------- the tracker (the CA, 16 Nov 2026) ---------- */
  const ordinal = n => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
  // A reminder's button on the tracker: WAIT (its date has not come: the date only), DUE (its day, on the client's clock), PENDING (its day
  // has passed and it was not sent), SENT (sent once or more: the count shows, and it can be sent again), CLOSED (the task was done first)
  function reminderButton(r, { tz, now = Date.now(), completed = false } = {}) {
    if ((r.sentCount || 0) > 0 || r.state === 'SENT') return 'SENT';
    if (completed || r.state === 'CLOSED') return 'CLOSED';
    if (+now < +new Date(r.fireAt)) return 'WAIT';
    return dayIn(tz, now) === dayIn(tz, +new Date(r.fireAt)) ? 'DUE' : 'PENDING';
  }
  const sentTimes = n => (n === 1 ? 'Sent' : n === 2 ? 'Sent twice' : `Sent ${n} times`);
  // The overall status of a period: how many of its actions are done (the CA: "if 2 are done of 7, 2/7"). The actions: each reminder (a
  // reminder that was not needed because the task was done first does not count), the data collection, the task, and, unless the work
  // is closed without an invoice, the invoice created, the invoice sent to the client and the money received in full. The advance payment
  // counts too when there is one (the CA, 24 Nov 2026: "if there is a value in advance then it would be counted"), as done.
  function progress(p) {
    const steps = [];
    if (p.advance && Number(p.advance.amount) > 0) steps.push(true);
    for (const r of p.reminders || []) { const sent = (r.sentCount || 0) > 0 || r.state === 'SENT'; if (sent || r.state !== 'CLOSED') steps.push(sent); }
    steps.push(Boolean(p.dataCollectedOn), p.stage === 'COMPLETED');
    if (p.closeKind !== 'FREE') {
      const inv = p.invoice && p.invoice.status !== 'CANCELLED' ? p.invoice : null;
      steps.push(Boolean(inv && inv.number), Boolean(inv && (inv.sentAt || inv.sentCount > 0 || ['PARTIAL', 'RECEIVED'].includes(inv.status))), Boolean(inv && inv.status === 'RECEIVED'));
    }
    return { done: steps.filter(Boolean).length, total: steps.length };
  }

  // How a message or reminder went: on WhatsApp, or another way and marked by hand (the CA: clients with no WhatsApp)
  const CHANNELS ={ WHATSAPP: 'WhatsApp', PHONE: 'Phone call', EMAIL: 'Email', OTHER: 'Another way' };
  // A template's category (the CA, 24 Nov 2026: "Used for" is written as Category, with only these). REMINDER: a template made before the
  // reminders were told apart, offered for all three until its category is chosen.
  const TEMPLATE_PURPOSES = { REMINDER_1: '1st Reminder', REMINDER_2: '2nd Reminder', REMINDER_3: '3rd Reminder', ADVANCE: 'Advance Payment', INVOICE: 'Invoice', RECEIPT: 'Receipt', OTHER: 'Others' };
  const TEMPLATE_LEGACY = { REMINDER: 'Reminder (1st, 2nd or 3rd: choose)', DATA_COLLECTION: 'Others', COMPLETION: 'Others' };
  const templateCategory = p => TEMPLATE_PURPOSES[p] || TEMPLATE_LEGACY[p] || p;
  // The category a message of this kind takes its template from (a reminder: its place, 1st, 2nd or 3rd)
  const categoryFor = (kind, n = 1) => (kind === 'REMINDER' ? `REMINDER_${Math.min(3, Math.max(1, n))}` : kind === 'ADVANCE' || kind === 'INVOICE' || kind === 'RECEIPT' ? kind : 'OTHER');
  // Whether a template of category p (and country) may be used where category want is asked for, for a client of country cc
  const templateFits = (t, want, cc) => (!t.country || !cc || t.country === cc) && (t.purpose === want || (t.purpose === 'REMINDER' && /^REMINDER_/.test(want)) || (want === 'OTHER' && ['DATA_COLLECTION', 'COMPLETION'].includes(t.purpose)));
  const MESSAGE_KINDS = { REMINDER: 'Reminder', ADVANCE: 'Advance payment', INVOICE: 'Invoice', RECEIPT: 'Receipt', OTHER: 'Other', DATA_COLLECTION: 'Data collection', COMPLETION: 'Obligation completed' };

  return {
    DAY, MONTHS, ymdOk, ymdOf, addDays, daysBetween, fmtDay, zoned, dayIn, fmtAt, offsetMs, DAY_FORMATS, setDayFormat, NUMBER_FORMATS, setNumberFormat, fmtNum,
    STAGES, MANUAL, STATUS, instants, fireAt, reminderDay, workOf, reminderStates, occurrenceView,
    FREQUENCIES, freqOf, shiftMonths, shiftYears, periodDates, yearDates, projectPeriods, periodsAllowed, periodName, datesProblem, offsetLabel, yearsLabel, repeatsLabel, yearsShort,
    keyOf, PLACEHOLDER_GROUPS, PLACEHOLDERS, RESERVED, render, waPhone, toE164, waUrl, SENDER_OPEN, waLink, CHANNELS, TEMPLATE_PURPOSES, TEMPLATE_LEGACY, templateCategory, categoryFor, templateFits, MESSAGE_KINDS,
    ordinal, reminderButton, sentTimes, progress,
  };
});
