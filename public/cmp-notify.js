'use strict';
/* Compliance & Deadlines: the notifications (SRS 6, 11; the CA's "Deadline Tracker - Notification" sheet and item 37, 24 Nov 2026).
   - the bell at the top right with this user's unread count, and a pop-up when something new comes in
   - the Notifications page: a dashboard over the dates chosen (today, 1, 2, 3, 6 months, 1 year, or from–to) of the notifications made and
     those still to come (worked out by the server, not stored), each opening what it is about; and the reminders to send now (overdue,
     ready, waiting) with their WhatsApp buttons
   - a panel on the right, opened and closed with a click (remembered on this computer), with the days the notifications come on:
     changed by a user with full access, read-only for the others
   - the "Notification settings" section of the Settings page: cmpNotifySettingsHtml(settings, can) and cmpNotifySettingsRead()
   Loaded after cmp.js. The server side is src/compliance/notify.js. */

CMP_PAGES.push({ id: 'cm-notify', html: () => '<div id="cmNotify"></div>', enter: () => cmpEnterNotify() });

const CMP_NT_START = () => ({ tab: 'list', range: 'today', from: '', to: '', q: '', who: 'me', unreadOnly: false, data: null, alerts: null, rules: null, unread: 0, items: [], seq: 0 });
const CMP_NT = CMP_NT_START();
CMP_RESETS.push(() => Object.assign(CMP_NT, CMP_NT_START()));

// kind → [group, what it is, icon, colours]; the groups as the CA's Settings name them (the same lists as the server's KINDS and GROUPS)
const CMP_NT_KINDS = {
  OBLIGATION_CREATED: ['TASK', 'New obligation', '＋', 'bg-emerald-100 text-emerald-800'],
  REMINDER: ['TASK', 'Reminder dates (1st, 2nd, 3rd reminder)', '🔔', 'bg-amber-100 text-amber-900'],
  DUE_DATE: ['TASK', 'Due date', '📅', 'bg-amber-100 text-amber-900'],
  AFTER_DUE: ['TASK', 'Overdue: days after the due date', '⏰', 'bg-red-100 text-red-800'],
  DATA_MIDPOINT: ['TASK', 'Data still to collect (midway between the dates)', '📥', 'bg-slate-100 text-slate-700'],
  DATA_RECEIVED: ['TASK', 'Data received', '📥', 'bg-emerald-100 text-emerald-800'],
  TASK_MIDPOINT: ['TASK', 'Task still open (midway between the dates)', '🛠', 'bg-slate-100 text-slate-700'],
  TASK_DONE: ['TASK', 'Task completed', '✓', 'bg-emerald-100 text-emerald-800'],
  INVOICE_PENDING: ['BILLING', 'Invoice still to create (every few days)', '🧾', 'bg-sky-100 text-sky-800'],
  INVOICE_CREATED: ['BILLING', 'Invoice created', '🧾', 'bg-emerald-100 text-emerald-800'],
  ISSUE_PENDING: ['BILLING', 'Invoice still to send to the client (every few days)', '📤', 'bg-sky-100 text-sky-800'],
  INVOICE_ISSUED: ['BILLING', 'Invoice issued', '📤', 'bg-emerald-100 text-emerald-800'],
  RECEIPT_PENDING: ['BILLING', 'Payment still to receive (every few days)', '💰', 'bg-sky-100 text-sky-800'],
  RECEIPT: ['BILLING', 'Payment received', '💰', 'bg-emerald-100 text-emerald-800'],
  REMINDER_MISSED: ['FAILED', 'Client reminder not sent on its date', '⚠', 'bg-orange-100 text-orange-800'],
};
const CMP_NT_GROUPS = {
  TASK: ['taskAlerts', 'Task and deadline alerts', 'Reminder dates, due dates, overdue, the data collection and the task'],
  BILLING: ['invoiceAlerts', 'Invoice and payment alerts', 'Invoices to create and to send, payments to receive, and when each is done'],
  FAILED: ['failedAlerts', 'Failed reminder alerts', 'A client reminder that was not sent on its date'],
};
const CMP_NT_RANGES = [['today', 'Today due', 0], ['m1', '1 month', 1], ['m2', '2 months', 2], ['m3', '3 months', 3], ['m6', '6 months', 6], ['y1', '1 year', 12]];
const cmpNtHour = h => `${String(h ?? 9).padStart(2, '0')}:00`;

/* ---------- the bell, its count and the pop-up ---------- */
async function cmpPollAlerts() {
  if (!S.token || S.module !== 'COMPLIANCE') { clearInterval(CMP.alertTimer); return; }
  if (document.hidden || !cmpCan('VIEW')) return;
  try { const c = await api('/api/cmp/notify/count'); cmpBadge(c); cmpPopup(c); } catch { /* the pages report problems themselves */ }
}
// The bell at the top right of the window (the CA: notifications there, not in the menu), with this user's unread count
function cmpBell() {
  if (!cmpCan('VIEW')) { document.getElementById('cmpBell')?.remove(); return; }
  if (document.getElementById('cmpBell')) return;
  const bar = document.querySelector('#topbar > div'); if (!bar) return;
  bar.insertAdjacentHTML('beforeend', `<button type="button" id="cmpBell" onclick="go('cm-notify')" class="relative p-2 rounded-full hover:bg-slate-100 shrink-0" aria-label="Notifications" title="Notifications">
    <svg viewBox="0 0 24 24" class="w-6 h-6 text-slate-700" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${ICON.bell}"/></svg>
    <span id="cmpBellN" class="hidden absolute -top-0.5 -right-0.5 min-w-[1.25rem] h-5 px-1 rounded-full text-[11px] font-semibold text-white bg-red-600 items-center justify-center"></span></button>`);
  cmpBadge();
}
function cmpBadge(c) {
  if (c && Number.isInteger(c.unread)) CMP_NT.unread = c.unread;
  const n = document.getElementById('cmpBellN'), k = CMP_NT.unread || 0;
  if (!n) return;
  n.textContent = k > 99 ? '99+' : String(k);
  n.classList.toggle('hidden', !k); n.classList.toggle('flex', Boolean(k));
  const bell = document.getElementById('cmpBell');
  bell.title = k ? `${k} unread notification${k === 1 ? '' : 's'}` : 'Notifications';
  bell.setAttribute('aria-label', bell.title);
}
// Once per session for the newest one: "N unread notifications" with the latest few
function cmpPopup(c) {
  if (!c || !c.unread || !c.latest || !c.latest.length || S.page === 'cm-notify') return;
  const key = `cmpNtPopup:${S.company}:${c.latest[0].id}`;
  try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { /* shown again next time: harmless */ }
  document.getElementById('cmpPopup')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div id="cmpPopup" role="alert" class="fixed bottom-4 right-4 z-40 max-w-sm bg-white rounded-xl shadow-2xl border-l-4 border-emerald-600 p-4">
    <div class="flex items-start gap-3"><span class="text-xl" aria-hidden="true">🔔</span><div class="flex-1 min-w-0 text-sm">
      <div class="font-semibold mb-1">${c.unread} unread notification${c.unread === 1 ? '' : 's'}</div>
      <ul class="space-y-1 text-slate-700">${c.latest.map(x => `<li class="truncate" title="${esc(x.title)}">${(CMP_NT_KINDS[x.kind] || [])[2] || '•'} ${esc(x.title)}</li>`).join('')}</ul>
      <div class="flex gap-2 mt-3">${cmpBtn('Open notifications', "document.getElementById('cmpPopup').remove(); go('cm-notify')", 'primary')}${cmpBtn('Later', "document.getElementById('cmpPopup').remove()")}</div></div></div></div>`);
}

/* ---------- the page ---------- */
async function cmpEnterNotify() {
  const box = $('#cmNotify');
  if (!box.dataset.ready) { box.dataset.ready = '1'; box.innerHTML = cmpNtShell(); }
  document.getElementById('cmpPopup')?.remove();
  cmpNtPanelShow(cmpNtPanelWanted(), false);
  cmpNtTab(CMP_NT.tab);
}
function cmpNtShell() {
  const tab = (id, label) => `<button type="button" role="tab" id="cmNtTab_${id}" onclick="cmpNtTab('${id}')" class="px-3 min-h-[2.25rem] rounded-md text-sm font-medium">${label}</button>`;
  return `<div class="flex flex-col lg:flex-row gap-4 items-start">
    <div class="flex-1 min-w-0 w-full space-y-4">
      <div class="bg-white rounded-xl shadow p-4 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex gap-1 bg-slate-100 rounded-lg p-1" role="tablist" aria-label="Notifications">${tab('list', 'Notifications')}${cmpCan('REPORTS', 'WHATSAPP') ? tab('reminders', 'Reminders to send') : ''}</div>
          <div class="flex flex-wrap gap-2">
            <span id="cmNtReadAllBox">${cmpBtn('✓ Mark all read', 'cmpNtReadAll()', 'plain', 'needs-write')}</span>
            ${cmpBtn('Refresh', 'cmpNtRefresh()')}
            <button type="button" id="cmNtPanelBtn" onclick="cmpNtPanelToggle()" aria-controls="cmNtPanel" aria-expanded="false" class="px-3 min-h-[2.5rem] rounded-lg text-sm font-medium whitespace-nowrap border bg-white hover:border-emerald-600">⚙ Trigger days</button>
          </div>
        </div>
        <div id="cmNtFilters"></div>
      </div>
      <div id="cmNtSummary" class="grid grid-cols-2 md:grid-cols-4 gap-3"></div>
      <div id="cmNtBody" class="bg-white rounded-xl shadow p-4"></div>
    </div>
    <aside id="cmNtPanel" class="hidden w-full lg:w-80 shrink-0 bg-white rounded-xl shadow p-4 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto" aria-label="Notification trigger days"></aside>
  </div>
  <button type="button" id="cmNtEdge" onclick="cmpNtPanelToggle()" aria-controls="cmNtPanel" aria-expanded="false" title="Show or hide the trigger days"
    class="hidden lg:block fixed right-0 top-1/3 z-30 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-medium px-1.5 py-3 rounded-l-lg shadow [writing-mode:vertical-rl]">⚙ Trigger days</button>`;
}
function cmpNtTab(tab) {
  if (tab === 'reminders' && !cmpCan('REPORTS', 'WHATSAPP')) tab = 'list';
  CMP_NT.tab = tab;
  for (const id of ['list', 'reminders']) {
    const b = document.getElementById('cmNtTab_' + id); if (!b) continue;
    b.setAttribute('aria-selected', String(id === tab));
    b.classList.toggle('bg-white', id === tab); b.classList.toggle('shadow', id === tab); b.classList.toggle('text-slate-600', id !== tab);
  }
  document.getElementById('cmNtReadAllBox').classList.toggle('hidden', tab !== 'list');
  if (tab === 'list') { $('#cmNtFilters').innerHTML = cmpNtFiltersHtml(); cmpNtLoad(); }
  else { $('#cmNtFilters').innerHTML = cmpNtRemFiltersHtml(); cmpLoadReminders(); }
}
const cmpNtRefresh = () => (CMP_NT.tab === 'list' ? cmpNtLoad() : cmpLoadReminders());

/* ---------- the dashboard: which dates ---------- */
function cmpNtDates() {
  const today = CmpRules.dayIn(cmpTz());
  if (CMP_NT.range === 'dates') { const from = CMP_NT.from || today; return { from, to: CMP_NT.to && CMP_NT.to >= from ? CMP_NT.to : from }; }
  const r = CMP_NT_RANGES.find(x => x[0] === CMP_NT.range) || CMP_NT_RANGES[0];
  return { from: today, to: r[2] ? CmpRules.shiftMonths(today, r[2], false) : today };
}
function cmpNtFiltersHtml() {
  const chip = (id, label) => `<button type="button" aria-pressed="${CMP_NT.range === id}" onclick="cmpNtRange('${id}')"
    class="px-3 min-h-[2.25rem] rounded-full text-sm border whitespace-nowrap ${CMP_NT.range === id ? 'bg-emerald-700 text-white border-emerald-700' : 'bg-white hover:border-emerald-600'}">${label}</button>`;
  const { from, to } = cmpNtDates();
  return `<div class="flex flex-wrap gap-1.5" role="group" aria-label="Dates">${CMP_NT_RANGES.map(([id, label]) => chip(id, label)).join('')}${chip('dates', 'From – To')}</div>
    <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3 mt-3">
      ${CMP_NT.range === 'dates' ? `<label><span>From</span><input id="cmNtFrom" type="date" value="${esc(from)}" onchange="CMP_NT.from = this.value; cmpNtLoad()"></label>
        <label><span>To</span><input id="cmNtTo" type="date" value="${esc(to)}" onchange="CMP_NT.to = this.value; cmpNtLoad()"></label>` : ''}
      <label class="col-span-2 sm:flex-1 sm:min-w-[14rem]"><span>Search</span><input type="search" value="${esc(CMP_NT.q)}" placeholder="Client, obligation, invoice number…" autocomplete="off"
        oninput="clearTimeout(CMP.searchTimer); CMP.searchTimer = setTimeout(() => { CMP_NT.q = this.value; cmpNtLoad(); }, 350)"></label>
      ${cmpCan('FULL') ? `<label><span>Whose</span><select onchange="CMP_NT.who = this.value; cmpNtLoad()"><option value="me" ${CMP_NT.who === 'me' ? 'selected' : ''}>Mine and the firm's</option><option value="all" ${CMP_NT.who === 'all' ? 'selected' : ''}>Everyone's</option></select></label>` : ''}
      <label class="flex items-center gap-2 text-sm sm:pb-2"><input type="checkbox" ${CMP_NT.unreadOnly ? 'checked' : ''} onchange="CMP_NT.unreadOnly = this.checked; cmpNtDraw()"> Unread only</label>
    </div>
    <p id="cmNtNote" class="text-xs text-slate-500 mt-2"></p>`;
}
function cmpNtRange(id) {
  CMP_NT.range = id;
  if (id === 'dates' && !CMP_NT.from) { const d = cmpNtDates(); CMP_NT.from = d.from; CMP_NT.to = CmpRules.shiftMonths(d.from, 1, false); }
  $('#cmNtFilters').innerHTML = cmpNtFiltersHtml();
  cmpNtLoad();
}
async function cmpNtLoad() {
  const body = document.getElementById('cmNtBody'); if (!body) return;
  const { from, to } = cmpNtDates(), seq = ++CMP_NT.seq;
  if (CmpRules.daysBetween(from, to) > 400) { body.innerHTML = cmpEmpty('Choose at most one year at a time.'); return; }
  const qs = new URLSearchParams({ from, to, ...(CMP_NT.q.trim() ? { q: CMP_NT.q.trim() } : {}), ...(CMP_NT.who === 'all' ? { who: 'all' } : {}) });
  if (!CMP_NT.data) body.innerHTML = cmpEmpty('Loading…');
  let d, alerts;
  try { [d, alerts] = await Promise.all([api('/api/cmp/notify?' + qs), api('/api/cmp/alerts').catch(() => null)]); } catch (err) { if (seq === CMP_NT.seq) body.innerHTML = cmpEmpty(esc(err.message)); return; }
  if (seq !== CMP_NT.seq) return; // (a newer choice is on its way)
  CMP_NT.data = d; CMP_NT.alerts = alerts;
  cmpBadge({ unread: d.unread });
  cmpNtDraw();
}

/* ---------- the dashboard: what it shows ---------- */
function cmpNtDraw() {
  const d = CMP_NT.data, body = document.getElementById('cmNtBody');
  if (!d || !body || CMP_NT.tab !== 'list') return;
  const note = document.getElementById('cmNtNote');
  if (note) note.textContent = `${d.from === d.to ? (d.from === d.today ? `Today, ${cmpDay(d.from)}` : cmpDay(d.from)) : `${cmpDay(d.from)} – ${cmpDay(d.to)}`} · made each day at ${cmpNtHour(d.notifyHour)}, ${CmpCountries.zoneCity(d.timeZone)} time`
    + `${d.inApp ? '' : ' · in-app notifications are switched off in Settings'}`;
  const a = CMP_NT.alerts, canRem = cmpCan('REPORTS', 'WHATSAPP');
  const card = (label, n, tone, sub, onclick) => `<button type="button" ${onclick ? `onclick="${onclick}"` : 'disabled'} class="text-left bg-white rounded-xl shadow p-4 border-l-4 ${tone} ${onclick ? 'hover:ring-2 hover:ring-emerald-200' : 'cursor-default'}">
    <div class="text-2xl font-semibold">${n}</div><div class="text-sm font-medium">${label}</div><div class="text-xs text-slate-500">${sub}</div></button>`;
  $('#cmNtSummary').innerHTML = [
    card('Unread', d.unread, 'border-emerald-600', CMP_NT.unreadOnly ? 'showing unread only' : 'click to show only these', 'CMP_NT.unreadOnly = !CMP_NT.unreadOnly; cmpNtTab(\'list\')'),
    card('Made', d.made.length, 'border-slate-300', 'in these dates', ''),
    card('Still to come', d.comingTotal, 'border-sky-500', d.to >= d.today ? 'in these dates' : 'none: these dates are past', ''),
    a ? card('Overdue', a.overdue, 'border-red-600', canRem ? `${a.ready} reminder${a.ready === 1 ? '' : 's'} to send` : 'past the due date, not completed', canRem ? "cmpNtTab('reminders')" : "cmpOpenObligations('OVERDUE')") : '',
  ].join('');
  CMP_NT.items = [];
  const keep = x => !CMP_NT.unreadOnly || (!x.coming && !x.read);
  const parts = [];
  const earlier = d.earlier.filter(keep);
  if (earlier.length) parts.push(`<section><h3 class="text-sm font-semibold text-emerald-800 mb-1">Not read yet, from before these dates</h3><ul class="divide-y">${earlier.map(cmpNtItem).join('')}</ul></section>`);
  const byDay = new Map();
  for (const x of [...d.made, ...d.coming].filter(keep)) { if (!byDay.has(x.forDay)) byDay.set(x.forDay, []); byDay.get(x.forDay).push(x); }
  for (const day of [...byDay.keys()].sort()) {
    const wd = new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
    parts.push(`<section><h3 class="text-sm font-semibold mb-1 ${day === d.today ? 'text-emerald-800' : 'text-slate-700'}">${day === d.today ? 'Today · ' : ''}${wd} ${cmpDay(day)}</h3><ul class="divide-y">${byDay.get(day).map(cmpNtItem).join('')}</ul></section>`);
  }
  if (d.comingTotal > d.coming.length) parts.push(`<p class="text-xs text-slate-500">And ${d.comingTotal - d.coming.length} more still to come: choose fewer dates to see them.</p>`);
  body.innerHTML = parts.length ? `<div class="space-y-5">${parts.join('')}</div>`
    : cmpEmpty(CMP_NT.unreadOnly ? 'Nothing unread in these dates.' : d.inApp ? 'No notifications in these dates.' : 'In-app notifications are switched off (Settings → Notification settings).');
}
function cmpNtTeamName(id) { const u = ((CMP.me && CMP.me.team) || []).find(x => x.id === id); return u ? u.name || u.email : 'someone'; }
function cmpNtItem(x) {
  const i = CMP_NT.items.push(x) - 1, k = CMP_NT_KINDS[x.kind] || ['TASK', x.kind, '•', 'bg-slate-100 text-slate-700'];
  const unread = !x.coming && !x.read && x.status !== 'FAILED';
  const chip = (t, tone, title = '') => `<span class="px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${tone}" ${title ? `title="${esc(title)}"` : ''}>${esc(t)}</span>`;
  const chips = [
    unread && chip('New', 'bg-emerald-600 text-white'),
    x.coming && chip(`Coming · ${cmpNtHour(CMP_NT.data && CMP_NT.data.notifyHour)}`, 'bg-slate-100 text-slate-700'),
    x.status === 'FAILED' && chip(`Not passed on · ${x.attempts || 1} ${(x.attempts || 1) === 1 ? 'try' : 'tries'}`, 'bg-red-100 text-red-800', x.lastError),
    !x.userId && chip('For everyone', 'bg-sky-50 text-sky-800'),
    x.userId && CMP_NT.who === 'all' && chip(`For ${cmpNtTeamName(x.userId)}`, 'bg-violet-50 text-violet-800'),
  ].filter(Boolean).join(' ');
  const when = x.coming ? (x.repeats ? `then every ${x.repeats} days until it is done` : '') : `made ${cmpAt(x.createdAt)}`;
  return `<li class="flex items-start gap-3 py-3 ${unread ? 'bg-emerald-50/70 -mx-2 px-2 rounded-lg' : ''}">
    <span class="mt-0.5 w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-sm ${k[3]}" aria-hidden="true">${k[2]}</span>
    <div class="flex-1 min-w-0">
      <div class="flex flex-wrap items-center gap-1.5"><button type="button" class="text-left font-medium hover:underline ${x.coming ? 'text-slate-600' : ''}" onclick="cmpNtOpen(${i})">${esc(x.title)}</button>${chips}</div>
      ${x.body ? `<div class="text-sm text-slate-600">${esc(x.body)}</div>` : ''}
      ${x.status === 'FAILED' && x.lastError ? `<div class="text-xs text-red-700">${esc(x.lastError)}</div>` : ''}
      <div class="text-xs text-slate-400">${esc(k[1])}${when ? ` · ${esc(when)}` : ''}</div>
    </div>
    ${unread ? `<button type="button" class="needs-write text-xs text-slate-600 underline hover:text-emerald-700 shrink-0 mt-1" onclick="cmpNtRead([${i}])">Mark read</button>` : ''}
  </li>`;
}
// What it is about opens: the invoice (for those who may see it), the obligation's period, else the client. Opening it reads it.
function cmpNtOpen(i) {
  const x = CMP_NT.items[i]; if (!x) return;
  if (!x.coming && !x.read && x.id) cmpNtRead([i], true);
  if (x.invoiceId && cmpCan('INVOICE') && typeof cmpInvoiceOpen === 'function') return cmpInvoiceOpen(x.invoiceId, cmpNtLoad);
  if (x.obligationId && x.occurrenceId && typeof cmpOpenPeriod === 'function') return cmpOpenPeriod(x.obligationId, x.occurrenceId, cmpNtLoad);
  if (x.clientId) return cmpOpenClient(x.clientId);
  toast('There is nothing to open for this one.');
}
async function cmpNtRead(idx, quiet = false) {
  const list = idx.map(i => CMP_NT.items[i]).filter(x => x && x.id && !x.read);
  if (!list.length) return;
  try {
    const r = await api('/api/cmp/notify/read', { method: 'POST', body: { ids: list.map(x => x.id) } });
    for (const x of list) x.read = true;
    cmpBadge(r);
    if (CMP_NT.data) CMP_NT.data.unread = r.unread;
    cmpNtDraw();
  } catch (err) { if (!quiet) toast(err.message); }
}
async function cmpNtReadAll() {
  try {
    const r = await api('/api/cmp/notify/read', { method: 'POST', body: { all: true, ...(CMP_NT.who === 'all' ? { who: 'all' } : {}) } });
    cmpBadge(r); toast(r.marked ? `${r.marked} marked as read` : 'Nothing was unread', true);
    cmpNtLoad();
  } catch (err) { toast(err.message); }
}

/* ---------- the panel on the right: the trigger days (the CA: hideable, click to open and click to close) ---------- */
function cmpNtPanelWanted() {
  try { const v = localStorage.getItem('cmpNtPanel'); if (v === '1' || v === '0') return v === '1'; } catch { /* the default then */ }
  return window.innerWidth >= 1024; // (open at first on a wide screen, closed on a phone)
}
function cmpNtPanelToggle() { const p = document.getElementById('cmNtPanel'); if (p) cmpNtPanelShow(p.classList.contains('hidden'), true); }
function cmpNtPanelShow(open, remember) {
  const p = document.getElementById('cmNtPanel'); if (!p) return;
  p.classList.toggle('hidden', !open);
  for (const id of ['cmNtPanelBtn', 'cmNtEdge']) { const b = document.getElementById(id); if (b) b.setAttribute('aria-expanded', String(open)); }
  const edge = document.getElementById('cmNtEdge'); if (edge) edge.textContent = open ? 'Hide trigger days ▸' : '◂ Trigger days';
  const btn = document.getElementById('cmNtPanelBtn'); if (btn) btn.classList.toggle('border-emerald-600', open);
  if (remember) { try { localStorage.setItem('cmpNtPanel', open ? '1' : '0'); } catch { /* remembered for this visit only */ } }
  if (open) cmpNtPanelLoad();
}
async function cmpNtPanelLoad() {
  const p = document.getElementById('cmNtPanel'); if (!p) return;
  if (!CMP_NT.rules) p.innerHTML = cmpEmpty('Loading…');
  try { CMP_NT.rules = await api('/api/cmp/notify/rules'); } catch (err) { p.innerHTML = cmpEmpty(esc(err.message)); return; }
  cmpNtPanelDraw(CMP_NT.rules.rules);
}
function cmpNtPanelDraw(r) {
  const p = document.getElementById('cmNtPanel'), d = CMP_NT.rules; if (!p || !d) return;
  const can = cmpCan('FULL') && d.canEdit, dis = can ? '' : 'disabled';
  const num = (key, label, min, max, before, after) => `<label class="block"><span>${label}</span><span class="flex items-center gap-2 text-sm text-slate-600">${before}
    <input id="cmNtR_${key}" type="number" min="${min}" max="${max}" step="1" value="${esc(String(r[key]))}" ${dis} class="!w-20" aria-label="${esc(label)}">${after}</span></label>`;
  const list = (key, label, hint) => `<label class="block"><span>${label}</span><input id="cmNtR_${key}" value="${esc((r[key] || []).join(', '))}" ${dis} placeholder="e.g. 1, 3, 7" inputmode="numeric" aria-label="${esc(label)}">
    <span class="block text-xs text-slate-500 mt-0.5">${hint}</span></label>`;
  const head = t => `<h3 class="text-xs font-semibold uppercase tracking-wide text-slate-500">${t}</h3>`;
  p.innerHTML = `<div class="flex items-start justify-between gap-2 mb-3">
      <div><h2 class="font-semibold">Trigger days</h2><p class="text-xs text-slate-500">The days the notifications come on (they start as the days in your notification sheet: the reminder dates, the due date, 1, 3 and 7 days after it, every 3 days while billing is open).${can ? '' : ' Only a user with full access can change them.'}</p></div>
      <button type="button" onclick="cmpNtPanelToggle()" class="text-slate-400 hover:text-slate-700 text-2xl leading-none px-1" aria-label="Hide the trigger days">×</button></div>
    <div class="space-y-5">
      <section class="space-y-3">${head('Deadlines')}
        ${num('reminderBefore', '1st, 2nd and 3rd reminder', 0, 30, '', 'days before each reminder date (0 = on the date)')}
        ${list('dueBefore', 'Due date', 'Days before it, 0 = on the due date. Several: e.g. 7, 0. Empty: none.')}
        ${list('afterDue', 'After the due date, while not completed', 'Days after it, e.g. 1, 3, 7.')}
        <p class="text-xs text-slate-500">Data collection and task: midway between the period end, each reminder date and the due date, while that step is open.</p>
      </section>
      <section class="space-y-3">${head('Billing, while it is open')}
        ${num('invoiceEvery', 'Invoice still to create', 1, 90, 'every', 'days')}
        ${num('issueEvery', 'Invoice still to send to the client', 1, 90, 'every', 'days')}
        ${num('receiptEvery', 'Payment still to receive', 1, 90, 'every', 'days')}
      </section>
      <section class="space-y-3">${head('Alerts')}
        ${num('missedAfter', 'Client reminder not sent', 1, 30, '', 'days after its date')}
        ${num('retryAttempts', 'A notification that could not be passed on', 1, 10, 'tried', 'times in all')}
      </section>
      <p class="text-xs text-slate-500">Made each day at <b>${cmpNtHour(d.notifyHour)}</b>, ${esc(CmpCountries.zoneCity(d.timeZone))} time${can ? ' (Settings → Notification settings)' : ''}.</p>
      ${can ? `<div class="flex flex-wrap gap-2">${cmpBtn('Save', 'cmpNtRulesSave()', 'primary', 'needs-write')}${cmpBtn('Use the default days', 'cmpNtRulesDefaults()', 'plain', 'needs-write')}</div>` : ''}
    </div>`;
}
function cmpNtRulesDefaults() {
  if (!CMP_NT.rules) return;
  cmpNtPanelDraw({ ...CMP_NT.rules.defaults.rules });
  toast('The default days are filled in: Save to use them.');
}
async function cmpNtRulesSave() {
  const v = key => document.getElementById('cmNtR_' + key).value;
  const rules = Object.fromEntries(['reminderBefore', 'dueBefore', 'afterDue', 'invoiceEvery', 'issueEvery', 'receiptEvery', 'missedAfter', 'retryAttempts'].map(k => [k, v(k)]));
  try {
    CMP_NT.rules = await api('/api/cmp/notify/rules', { method: 'PUT', body: { rules } });
    cmpNtPanelDraw(CMP_NT.rules.rules);
    toast('Trigger days saved', true);
    if (CMP_NT.tab === 'list') cmpNtLoad();
  } catch (err) { toast(err.message); }
}

/* ---------- the reminders to send now (SRS 6, 11): overdue, ready, waiting, each with its reminders' WhatsApp buttons ---------- */
function cmpNtRemFiltersHtml() {
  const n = CMP.notify, opt = (v, t) => `<option value="${v}" ${n.show === v ? 'selected' : ''}>${t}</option>`;
  return `<div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3">
      <label><span>Show</span><select onchange="CMP.notify.show = this.value; cmpLoadReminders()">${opt('all', 'Everything in its reminder period')}${opt('overdue', 'Overdue')}${opt('ready', 'Ready to send')}${opt('waiting', 'Waiting')}</select></label>
      <label><span>Country</span><select onchange="CMP.notify.country = this.value; cmpLoadReminders()">${cmpCountryOptions(n.country, 'All countries')}</select></label>
      <label class="col-span-2 sm:flex-1 sm:min-w-[14rem]"><span>Search</span><input type="search" value="${esc(n.q)}" placeholder="Client, code or obligation" autocomplete="off"
        oninput="clearTimeout(CMP.searchTimer); CMP.searchTimer = setTimeout(() => { CMP.notify.q = this.value; cmpLoadReminders(); }, 350)"></label>
    </div>
    <p class="text-xs text-slate-500 mt-2">An obligation shows here from the end of its period (or its first reminder) until it is completed. The reminder whose time has come is highlighted with its WhatsApp button; later reminders stay dimmed until their time.</p>`;
}
async function cmpLoadReminders() {
  const body = document.getElementById('cmNtBody'); if (!body || CMP_NT.tab !== 'reminders') return;
  const n = CMP.notify, qs = new URLSearchParams({ show: n.show, ...(n.country ? { country: n.country } : {}), ...(n.q ? { q: n.q } : {}) });
  let d;
  try { d = await api('/api/cmp/notifications?' + qs); } catch (err) { body.innerHTML = cmpEmpty(esc(err.message)); return; }
  if (CMP_NT.tab !== 'reminders') return;
  CMP.settings = d.settings || CMP.settings;
  CMP.alerts = { overdue: d.summary.overdue, ready: d.summary.ready, confirm: d.summary.confirm };
  const card = (key, label, k, tone, note) => `<button type="button" onclick="${key === 'confirm' ? "cmpOpenObligations('CONFIRM')" : `CMP.notify.show = '${key}'; cmpNtTab('reminders')`}"
    class="text-left bg-white rounded-xl shadow p-4 border-l-4 ${tone} hover:ring-2 hover:ring-emerald-200"><div class="text-2xl font-semibold">${k}</div><div class="text-sm font-medium">${label}</div><div class="text-xs text-slate-500">${note}</div></button>`;
  $('#cmNtSummary').innerHTML = [
    card('overdue', 'Overdue', d.summary.overdue, 'border-red-600', 'past the due date, not completed'),
    card('ready', 'Ready to send', d.summary.ready, 'border-amber-500', 'a reminder has come due'),
    card('waiting', 'Waiting', d.summary.waiting, 'border-slate-300', 'next reminder not due yet'),
    card('confirm', 'Dates to confirm', d.summary.confirm, 'border-sky-500', 'copied from the period before'),
  ].join('');
  body.innerHTML = d.items.length ? `<div class="space-y-3">${d.items.map(cmpNotifyCard).join('')}</div>` : cmpEmpty('Nothing here. Obligations show up once their period ends (or their first reminder comes due).');
}
function cmpNotifyCard(x) {
  const v = x.view, refresh = 'cmpLoadReminders';
  return `<div class="border rounded-lg border-l-4 ${CMP_BAR[v.colour]} p-3">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <a href="#" onclick="event.preventDefault(); cmpOpenClient('${x.client.id}')" class="font-medium hover:underline">${cmpCountry(x.client.country).flag} ${esc(x.client.name)}</a> <span class="text-xs text-slate-500">${esc(x.client.code)}</span>
        <div class="text-sm"><b>${esc(x.obligation.name)}</b> · ${esc(CmpRules.periodName(x))} · due <b>${cmpDay(x.dueDate)}</b> <span class="text-slate-500">(${esc(CmpCountries.zoneCity(x.client.timeZone))})</span>
          · <span class="${v.overdue ? 'text-red-700 font-medium' : 'text-slate-600'}">${cmpDaysLeft(v)}</span>${x.datesConfirmed ? '' : ' · <span class="text-sky-700">dates to confirm</span>'}</div>
      </div>
      <div class="flex items-center gap-2">${cmpStatusChip(v.status)}</div>
    </div>
    <div class="mt-2 flex flex-col gap-1.5">${v.reminders.length ? v.reminders.map(r => cmpReminderPill(r, x, refresh)).join('') : '<div class="text-xs text-slate-500">No reminders set for this obligation.</div>'}</div>
    <div class="mt-2 flex flex-wrap gap-2">
      ${cmpBtn('Open', `cmpOpenPeriod('${x.obligation.id}', '${x.id}', ${refresh})`)}
      ${cmpCan('WHATSAPP') && !x.client.noWhatsApp ? cmpBtn(`${CMP_WA_ICON} Other message`, `cmpClientMessage('${x.client.id}', '${x.id}')`, 'plain', 'needs-write') : ''}
      ${x.obligation.portalUrl ? `<a href="${esc(x.obligation.portalUrl)}" target="_blank" rel="noopener noreferrer" class="px-3 min-h-[2.5rem] inline-flex items-center rounded-lg text-sm border bg-white hover:border-emerald-600">Portal ↗</a>` : ''}
    </div></div>`;
}

/* ---------- Settings → Notification settings (the CA's Settings sheet) ---------- */
// The preferences as stored, read leniently (what is missing is on), as the server reads them
function cmpNtPrefsOf(v) {
  const o = v && typeof v === 'object' ? v : {}, ev = o.events && typeof o.events === 'object' ? o.events : {};
  const out = { inApp: o.inApp !== false, events: {} };
  for (const [pref] of Object.values(CMP_NT_GROUPS)) out[pref] = o[pref] !== false;
  for (const kind of Object.keys(CMP_NT_KINDS)) out.events[kind] = ev[kind] !== false;
  return out;
}
// can: whether this user may change them (full access)
function cmpNotifySettingsHtml(settings, can) {
  const s = settings || {}, p = cmpNtPrefsOf(s.notifyPrefs), hour = Number.isInteger(s.notifyHour) ? s.notifyHour : 9, dis = can ? '' : 'disabled';
  const box = (id, checked, label, note = '', extra = '') => `<label class="flex items-start gap-2 py-1"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} ${dis} ${extra} class="mt-1">
    <span><span class="text-sm">${label}</span>${note ? `<span class="block text-xs text-slate-500">${note}</span>` : ''}</span></label>`;
  const groups = Object.entries(CMP_NT_GROUPS).map(([g, [pref, label, note]]) => `<fieldset class="border rounded-lg p-3">
      <legend class="px-1 font-medium">${box('cmNsG_' + g, p[pref], esc(label), esc(note))}</legend>
      <div class="grid sm:grid-cols-2 gap-x-4 pl-6">${Object.entries(CMP_NT_KINDS).filter(([, k]) => k[0] === g).map(([kind, k]) => box('cmNsE_' + kind, p.events[kind], esc(k[1]))).join('')}</div></fieldset>`).join('');
  // (the Settings page gives the section its heading)
  return `<div id="cmNsBox" class="space-y-3">
    ${box('cmNsInApp', p.inApp, '<b>In-app notifications</b>', 'The bell and the Notifications page, for the person assigned to each obligation (or everyone in the firm when nobody is). Off: none are made for anyone.')}
    <label class="block sm:w-64"><span>Notification time (the firm's clock)</span><select id="cmNsHour" ${dis}>${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === hour ? 'selected' : ''}>${cmpNtHour(h)}</option>`).join('')}</select></label>
    <div class="text-sm font-medium">Notification preferences by event</div>
    ${groups}
  </div>`;
}
// { notifyHour, notifyPrefs } from that section, for the settings save ({} when the section is not on the page)
function cmpNotifySettingsRead() {
  if (!document.getElementById('cmNsBox')) return {};
  const on = id => Boolean(document.getElementById(id) && document.getElementById(id).checked);
  const notifyPrefs = { inApp: on('cmNsInApp'), events: {} };
  for (const [g, [pref]] of Object.entries(CMP_NT_GROUPS)) notifyPrefs[pref] = on('cmNsG_' + g);
  for (const kind of Object.keys(CMP_NT_KINDS)) notifyPrefs.events[kind] = on('cmNsE_' + kind);
  return { notifyHour: Number(document.getElementById('cmNsHour').value), notifyPrefs };
}
