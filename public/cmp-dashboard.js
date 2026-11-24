'use strict';
/* Compliance & Deadlines: the Dashboard (the CA's "Comprehensive Dashboard" SRS, 24 Nov 2026) — filters for the whole page, ten figures
   that open their lists, the upcoming and overdue deadlines, a calendar by month, week or day (due dates, reminders, tasks), the reminders
   to act on, the obligations' stages, data collection and tasks, the money per currency, the activity, the alerts, and the work by country
   and by person. It only reads (src/compliance/dashboard.js): nothing is stored, and its Excel and PDF are made here in the browser.
   Reminders: without the WhatsApp Business service a message counts as Sent once WhatsApp opens with it; the person marks it "not sent"
   (↶) if it did not go, and sends it again. */

const CMP_DB_DEFAULT = { preset: 'month', from: '', to: '', days: 30, country: '', clientId: '', obligation: '', assignee: '' };
// (seq, calSeq: the latest request of each; an older answer that comes back later is dropped, so the page always shows the filters chosen)
const CMP_DB = { f: { ...CMP_DB_DEFAULT }, data: null, cal: { view: 'month', day: null, data: null }, sort: {}, page: {}, remFilter: 'ACT', taskView: 'open', timer: null, seq: 0, calSeq: 0 };
CMP_RESETS.push(() => { clearInterval(CMP_DB.timer); Object.assign(CMP_DB, { f: { ...CMP_DB_DEFAULT }, data: null, cal: { view: 'month', day: null, data: null }, sort: {}, page: {}, remFilter: 'ACT', timer: null }); });
const CMP_DB_PRESETS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['quarter', 'This quarter'], ['year', 'This year'], ['lastyear', 'Last year'], ['custom', 'Choose dates']];
const CMP_DB_SIZE = 10;
// the filters are remembered on this computer (not in the database)
const cmpDbKey = () => `cmpDash:${S.company || ''}`;
function cmpDbRestore() { try { const v = JSON.parse(localStorage.getItem(cmpDbKey()) || 'null'); if (v) CMP_DB.f = { ...CMP_DB_DEFAULT, ...v }; } catch { /* the defaults */ } }
function cmpDbRemember() { try { localStorage.setItem(cmpDbKey(), JSON.stringify(CMP_DB.f)); } catch { /* for this visit only */ } }

CMP_PAGES.push({
  id: 'cm-dashboard',
  html: () => `<div class="space-y-4">
    <section id="cmDbFilters" class="bg-white rounded-xl shadow p-3 lg:sticky lg:top-16 z-20 border border-slate-100"></section>
    <div id="cmDbBody" class="space-y-4"></div></div>`,
  enter: () => {
    cmpDbRestore();
    cmpDbFilters();
    CMP_DB.cal.data = null;
    // (those who may not see the reports see the calendar only, as before)
    if (cmpCan('REPORTS')) cmpDbLoad(); else { $('#cmDbBody').innerHTML = CMP_DB_CAL_BOX; cmpDbCalLoad(); }
    clearInterval(CMP_DB.timer);
    // refreshed by itself every five minutes while it is open (the CA's NFR-004)
    CMP_DB.timer = setInterval(() => { if (S.page === 'cm-dashboard' && !document.hidden && !document.querySelector('#cmpModal:not(.hidden)')) { CMP_DB.cal.data = null; if (cmpCan('REPORTS')) cmpDbLoad(true); else cmpDbCalLoad(); } }, 5 * 60000);
  },
});
// (an old link to the calendar opens the Dashboard at its calendar)
CMP_PAGES.push({ id: 'cm-calendar', html: () => '', enter: () => { go('cm-dashboard'); setTimeout(() => { const c = document.getElementById('cmDbCal'); if (c) c.scrollIntoView({ behavior: 'smooth' }); }, 400); } });

/* ---------- the filters (the CA's FR-001 to FR-010) ---------- */
const cmpDbOpt = (v, label, sel) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(label)}</option>`;
// the clients and obligations to choose from (those of the country chosen); the one chosen stays listed even if it is not among them
function cmpDbClientOptions() {
  const f = CMP_DB.f, list = CMP_DB.data ? CMP_DB.data.clientsList : [];
  return `<option value="">All clients</option>${list.map(c => cmpDbOpt(c.id, `${cmpCountry(c.country).flag} ${c.name} (${c.code})`, f.clientId)).join('')}${f.clientId && !list.some(c => c.id === f.clientId) ? cmpDbOpt(f.clientId, '(the client chosen)', f.clientId) : ''}`;
}
function cmpDbObOptions() {
  const f = CMP_DB.f, names = CMP_DB.data ? CMP_DB.data.obligationNames : [];
  return `<option value="">All obligations</option>${names.map(n => cmpDbOpt(n, n, f.obligation)).join('')}${f.obligation && !names.some(n => CmpRules.keyOf(n) === CmpRules.keyOf(f.obligation)) ? cmpDbOpt(f.obligation, f.obligation, f.obligation) : ''}`;
}
function cmpDbFilters() {
  const f = CMP_DB.f, d = CMP_DB.data, team = (CMP.me && CMP.me.team) || [];
  const opt = cmpDbOpt;
  $('#cmDbFilters').innerHTML = `<div class="flex flex-wrap items-end gap-2">
      <label class="w-40"><span>Dates</span><select onchange="cmpDbSet('preset', this.value)">${CMP_DB_PRESETS.map(([k, v]) => opt(k, v, f.preset)).join('')}</select></label>
      ${f.preset === 'custom' ? `<label class="w-40"><span>From</span><input type="date" value="${esc(f.from)}" onchange="cmpDbSet('from', this.value)"></label><label class="w-40"><span>To</span><input type="date" value="${esc(f.to)}" onchange="cmpDbSet('to', this.value)"></label>` : ''}
      <label class="w-36"><span>Upcoming</span><select onchange="cmpDbSet('days', Number(this.value))">${[7, 14, 30, 60, 90].map(n => opt(String(n), `Next ${n} days`, String(f.days))).join('')}</select></label>
      <label class="w-44"><span>Country</span><select onchange="cmpDbSet('country', this.value)">${cmpCountryOptions(f.country, 'All countries')}</select></label>
      <label class="w-52"><span>Client</span><select id="cmDbClient" onchange="cmpDbSet('clientId', this.value)">${cmpDbClientOptions()}</select></label>
      <label class="w-48"><span>Obligation</span><select id="cmDbOb" onchange="cmpDbSet('obligation', this.value)">${cmpDbObOptions()}</select></label>
      <label class="w-40"><span>Assigned to</span><select onchange="cmpDbSet('assignee', this.value)">${opt('', 'Everyone', f.assignee)}${opt('me', 'Me', f.assignee)}${opt('none', 'Nobody', f.assignee)}${team.map(u => opt(u.id, u.name || u.email, f.assignee)).join('')}</select></label>
      <div class="flex flex-wrap gap-2 ml-auto">${cmpBtn('↻ Refresh', "CMP_DB.cal.data = null; cmpCan('REPORTS') ? cmpDbLoad() : cmpDbCalLoad()")}${cmpBtn('Reset', 'cmpDbReset()')}${cmpCan('REPORTS') ? cmpBtn('⚙ Widgets', 'cmpDbWidgets()') + cmpBtn('Download (Excel)', 'cmpDbExcel()') + cmpBtn('Print / PDF', 'cmpDbPrint()') : ''}</div>
    </div>
    <div class="text-xs text-slate-500 mt-2" id="cmDbStamp">${d ? cmpDbStampText(d) : ''}</div>`;
}
const cmpDbStampText = d => `${esc(cmpDbPeriodText(d))} · upcoming: the next ${d.days} days · last updated ${esc(cmpAt(d.generatedAt))} · due dates are each client's own calendar day; money is per currency`;
const cmpDbPeriodText = d => { const p = d.period, name = (CMP_DB_PRESETS.find(x => x[0] === p.preset) || [, ''])[1]; return `${p.preset === 'custom' ? 'Dates' : name}: ${cmpDay(p.from)}${p.to !== p.from ? ` – ${cmpDay(p.to)}` : ''}`; };
function cmpDbSet(k, v) {
  CMP_DB.f[k] = v;
  if (k === 'country') CMP_DB.f.clientId = '';
  if (k === 'preset' && v === 'custom' && !CMP_DB.f.from) { const t = CmpRules.dayIn(cmpTz()); CMP_DB.f.from = t.slice(0, 8) + '01'; CMP_DB.f.to = t; }
  cmpDbRemember(); CMP_DB.page = {};
  if (k === 'preset' || k === 'from' || k === 'to') cmpDbFilters();
  if (CMP_DB.f.preset === 'custom' && (!CMP_DB.f.from || !CMP_DB.f.to)) return;
  if (['country', 'clientId', 'obligation', 'assignee'].includes(k)) CMP_DB.cal.data = null; // (the calendar follows the filters too)
  if (cmpCan('REPORTS')) cmpDbLoad(); else cmpDbCalLoad();
}
function cmpDbReset() { CMP_DB.f = { ...CMP_DB_DEFAULT }; CMP_DB.page = {}; CMP_DB.sort = {}; CMP_DB.remFilter = 'ACT'; CMP_DB.cal.data = null; cmpDbRemember(); cmpDbFilters(); if (cmpCan('REPORTS')) cmpDbLoad(); else cmpDbCalLoad(); }
const cmpDbQuery = () => { const f = CMP_DB.f; return cmpQs({ preset: f.preset, from: f.preset === 'custom' ? f.from : '', to: f.preset === 'custom' ? f.to : '', days: f.days, country: f.country, clientId: f.clientId, obligation: f.obligation, assignee: f.assignee }); };

/* ---------- loading, and the parts in the CA's order ---------- */
async function cmpDbLoad(quiet) {
  const body = $('#cmDbBody'); if (!body) return;
  const seq = ++CMP_DB.seq;
  if (!quiet && !CMP_DB.data) body.innerHTML = '<div class="bg-white rounded-xl shadow p-6 text-sm text-slate-500">Loading the dashboard…</div>';
  if (!quiet && CMP_DB.data) body.classList.add('opacity-60');
  let d;
  try { d = await api('/api/cmp/overview?' + cmpDbQuery()); }
  catch (err) {
    if (seq !== CMP_DB.seq || !document.getElementById('cmDbBody')) return;
    body.classList.remove('opacity-60'); body.innerHTML = `<div class="bg-white rounded-xl shadow p-6"><div class="text-sm text-red-700 font-medium">The dashboard could not be loaded.</div><div class="text-sm text-slate-600 mt-1">${esc(err.message)}</div><div class="mt-3">${cmpBtn('Try again', 'cmpDbLoad()')}</div></div>`; return;
  }
  if (seq !== CMP_DB.seq || !document.getElementById('cmDbBody')) return; // (filters changed meanwhile, or the page was left)
  body.classList.remove('opacity-60');
  CMP_DB.data = d;
  // (while a filter has the focus the bar is not drawn again, which would lose it: only its lists and the line under it are)
  const keepFilters = document.activeElement && document.getElementById('cmDbFilters').contains(document.activeElement);
  if (!keepFilters) cmpDbFilters();
  else { $('#cmDbStamp').innerHTML = cmpDbStampText(d); const c = document.getElementById('cmDbClient'), o = document.getElementById('cmDbOb'); if (c) c.innerHTML = cmpDbClientOptions(); if (o) o.innerHTML = cmpDbObOptions(); }
  cmpDbRender(d);
}
// The parts, in the CA's order (4.1): figures, upcoming, overdue, calendar, reminders (and the communication log), stages, data collection
// and tasks, money, activity, alerts; then by country and person. Each person may hide parts and change their order (the CA's phase 3:
// customisable widgets), remembered on this computer — not in the database.
const CMP_DB_WIDGETS = [['kpis', 'Figures'], ['up', 'Upcoming statutory deadlines'], ['od', 'Overdue obligations'], ['cal', 'Compliance calendar'], ['rem', 'Reminders'], ['com', 'Communication log'],
  ['wf', 'Obligation workflow'], ['dt', 'Data collection and tasks'], ['fin', 'Financial overview'], ['act', 'Recent activity'], ['alerts', 'Alerts'], ['people', 'By country and staff workload']];
const CMP_DB_CAL_BOX = '<section id="cmDbCal" class="bg-white rounded-xl shadow p-4 scroll-mt-40 min-w-0 overflow-x-auto"></section>';
function cmpDbLayout() {
  let v = null; try { v = JSON.parse(localStorage.getItem(`cmpDashW:${S.company || ''}`) || 'null'); } catch { /* the standard layout */ }
  const keys = CMP_DB_WIDGETS.map(w => w[0]), order = (v && Array.isArray(v.order) ? v.order.filter(k => keys.includes(k)) : []);
  for (const k of keys) if (!order.includes(k)) order.push(k); // (a part added later comes at the end)
  return { order, hidden: v && Array.isArray(v.hidden) ? v.hidden.filter(k => keys.includes(k)) : [] };
}
function cmpDbLayoutSave(L) { try { localStorage.setItem(`cmpDashW:${S.company || ''}`, JSON.stringify(L)); } catch { /* for this visit only */ } }
function cmpDbRender(d) {
  const L = cmpDbLayout(), sub = '<span class="text-sm font-normal text-slate-500">';
  const parts = {
    kpis: () => cmpDbKpis(d),
    up: () => cmpDbSec('up', `Upcoming statutory deadlines ${sub}— the next ${d.days} days</span>`, cmpDbUpTable(d), cmpDbRepLink('obligations-upcoming')),
    od: () => cmpDbSec('od', '<span class="text-red-700">Overdue obligations</span>', cmpDbOdTable(d), cmpDbRepLink('obligations-overdue')),
    cal: () => CMP_DB_CAL_BOX, rem: () => cmpDbReminders(d), com: () => (d.logs ? cmpDbCom(d) : ''), wf: () => cmpDbWorkflow(d), dt: () => cmpDbDataTasks(d),
    fin: () => (d.money ? cmpDbFinance(d) : ''), act: () => (d.logs ? cmpDbActivity(d) : ''), alerts: () => cmpDbAlerts(d), people: () => cmpDbPeople(d),
  };
  const shown = L.order.filter(k => !L.hidden.includes(k));
  $('#cmDbBody').innerHTML = shown.map(k => parts[k]()).join('') || cmpEmpty('Every part of the dashboard is hidden: ⚙ Widgets shows them again.');
  if (shown.includes('cal')) { if (CMP_DB.cal.data) cmpDbCalDraw(); else cmpDbCalLoad(); }
}
// ⚙ Widgets: show or hide each part, and move it up or down
function cmpDbWidgets() {
  const L = cmpDbLayout(), name = Object.fromEntries(CMP_DB_WIDGETS);
  cmpShowSub(`${cmpSubHead('Dashboard widgets', 'Show or hide each part and change its order. Remembered on this computer.')}
    <ul class="divide-y border rounded-lg">${L.order.map((k, i) => `<li class="flex items-center gap-2 px-3 py-1.5"><label class="flex items-center gap-2 flex-1 text-sm"><input type="checkbox" ${L.hidden.includes(k) ? '' : 'checked'} onchange="cmpDbWidget('${k}', 'toggle')"> ${esc(name[k])}</label>
      <button type="button" class="px-2 py-1 rounded border text-xs disabled:opacity-30" ${i ? '' : 'disabled'} onclick="cmpDbWidget('${k}', -1)" aria-label="Up">↑</button><button type="button" class="px-2 py-1 rounded border text-xs disabled:opacity-30" ${i < L.order.length - 1 ? '' : 'disabled'} onclick="cmpDbWidget('${k}', 1)" aria-label="Down">↓</button></li>`).join('')}</ul>
    <div class="flex justify-between gap-2 mt-3">${cmpBtn('The standard layout', "cmpDbLayoutSave({ order: [], hidden: [] }); cmpDbRedraw(); cmpDbWidgets()")}${cmpBtn('Close', 'cmpCloseSub()', 'primary')}</div>`);
}
function cmpDbWidget(k, how) {
  const L = cmpDbLayout(), i = L.order.indexOf(k);
  if (how === 'toggle') L.hidden = L.hidden.includes(k) ? L.hidden.filter(x => x !== k) : [...L.hidden, k];
  else { const j = i + how; if (j >= 0 && j < L.order.length) [L.order[i], L.order[j]] = [L.order[j], L.order[i]]; }
  cmpDbLayoutSave(L); cmpDbRedraw(); cmpDbWidgets();
}
// a report of the Reports page, opened from its part of the dashboard
const cmpDbRepLink = (key, label = 'Report ›') => `<button type="button" class="text-sm text-emerald-700 underline" onclick="cmpDbReport('${key}')">${esc(label)}</button>`;
function cmpDbReport(key) { if (typeof CMP_RPT !== 'undefined') { CMP_RPT.key = key; CMP_RPT.cat = ''; } go('cm-reports'); }
const cmpDbSec = (id, title, inner, extra = '') => `<section id="cmDbSec-${id}" class="bg-white rounded-xl shadow p-4 scroll-mt-40 min-w-0"><div class="flex flex-wrap items-center justify-between gap-2 mb-2"><h2 class="font-semibold">${title}</h2>${extra}</div>${inner}</section>`;
const cmpDbGo = id => { const el = document.getElementById('cmDbSec-' + id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
const cmpDbMoneyLines = (list, key) => (list.length ? list.map(x => `<div class="text-base font-semibold whitespace-nowrap">${cmpMoney(x[key], x.currency)}</div>`).join('') : '<div class="text-2xl font-semibold">0</div>');

/* ---------- the ten figures (FR-011 to FR-017, FR-027, FR-034, FR-038, FR-044, FR-055), each opening its list (FR-088 to FR-097) ---------- */
function cmpDbKpis(d) {
  const k = d.kpis, money = d.money ? d.finance.currencies : [];
  const card = (inner, label, tone, go, title = '') => `<button type="button" onclick="${go}" title="${esc(title)}" class="text-left bg-white rounded-xl shadow p-4 border-l-4 ${tone} hover:ring-2 hover:ring-emerald-200 min-w-0">${inner}<div class="text-sm mt-0.5">${label}</div></button>`;
  const n = v => `<div class="text-2xl font-semibold">${v}</div>`;
  return `<div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
    ${card(n(k.activeClients) + `<div class="text-[11px] text-slate-500">${k.newClients} new (${esc(cmpDbPeriodText(d).split(':')[0].toLowerCase())})</div>`, 'Active clients', 'border-slate-300', "cmpDbClients(false)", 'Not archived; "new" = added in the dates chosen')}
    ${card(n(k.missingInfo), 'Missing client information', k.missingInfo ? 'border-amber-400' : 'border-slate-300', "cmpDbClients(true)", 'Clients with an additional-information field of their country left blank')}
    ${card(n(k.open), 'Open obligations', 'border-sky-500', "cmpDbObligations('OPEN')")}
    ${card(n(k.overdue), 'Overdue obligations', 'border-red-600', "cmpDbObligations('OVERDUE')")}
    ${card(n(k.upcoming), `Due in the next ${d.days} days`, 'border-amber-500', "cmpDbObligations('UPCOMING_WINDOW')")}
    ${card(n(k.remindersDue), 'Reminders to send', k.remindersDue ? 'border-amber-500' : 'border-slate-300', "CMP_DB.remFilter = 'ACT'; cmpDbRedraw(); cmpDbGo('rem')", 'Due, not sent after their day, or marked not sent')}
    ${card(n(k.dataPending), 'Data collection pending', 'border-violet-400', "cmpDbObligations('DATA_PENDING')")}
    ${card(n(k.taskPending), 'Tasks pending', 'border-indigo-400', "cmpDbObligations('TASK_PENDING')", 'Each obligation\'s task: open once its data is collected')}
    ${d.money ? card(cmpDbMoneyLines(cmpDbOutstandingLines(d), 'v'), 'Outstanding invoices', 'border-rose-400', "cmpDbGo('out')") : ''}
    ${d.money ? card(cmpDbMoneyLines(money.filter(x => x.advances.unallocated).map(x => ({ currency: x.currency, v: x.advances.unallocated })), 'v'), 'Unallocated advances', 'border-teal-400', "cmpDbAdvances('', 'OPEN')") : ''}
  </div>`;
}
// money cards: the outstanding per currency (the helper above draws lines from a key)
const cmpDbOutstandingLines = d => d.finance.currencies.filter(x => x.invoices.outstanding).map(x => ({ currency: x.currency, v: x.invoices.outstanding }));

/* ---------- drill-downs: the lists of the module with the dashboard's filters ---------- */
function cmpDbClients(missing) {
  const f = CMP_DB.f;
  Object.assign(CMP_CL, { country: f.country, assignee: f.assignee, missing: Boolean(missing), q: '' });
  go('cm-clients');
  setTimeout(() => { const c = document.getElementById('cmClCountry'); if (c) c.value = f.country; const m = document.querySelector('[data-page="cm-clients"] input[onchange*="CMP_CL.missing"]'); if (m) m.checked = Boolean(missing); }, 150);
}
// Each opens the same periods as its figure counts: the obligation by its exact name (not the search box, which reads words such as
// "open" as a status); "due in the next days" = open and not past the due date, without the planned periods; the completed ones (counted
// by the day they were completed) in the dashboard's own list of completed tasks
function cmpDbObligations(status) {
  const f = CMP_DB.f, d = CMP_DB.data, today = CmpRules.dayIn(cmpTz());
  if (status === 'COMPLETED') {
    if (!cmpDbLayout().hidden.includes('dt')) { CMP_DB.taskView = 'done'; CMP_DB.page.tasksDone = 0; cmpDbRedraw(); return cmpDbGo('tasks'); }
    return cmpDbReport('tasks-completed');
  }
  const inWindow = status === 'UPCOMING_WINDOW';
  cmpObligationsFilter({ status: inWindow ? 'OPEN_NOT_DUE' : status, country: f.country, clientId: f.clientId, assignee: f.assignee, q: '', obligation: f.obligation || '' });
  if (inWindow || status === 'PLANNED') { cmpRange('ob'); CMP.ranges.ob.r = { ...CMP.ranges.ob.r, mode: 'dates', from: today, to: CmpRules.addDays(today, d ? d.days : 30) }; }
  go('cm-obligations');
  setTimeout(() => {
    const pg = document.querySelector('[data-page="cm-obligations"]'); if (!pg) return;
    const c = pg.querySelector('select[onchange*="CMP_OB.country"]'); if (c) c.value = f.country;
    const q = pg.querySelector('input[oninput*="CMP_OB.q"]'); if (q) q.value = '';
  }, 150);
}
// the Advance Payments page over all dates (an advance received last year can still be unallocated)
function cmpDbAdvances(q, status) { CMP_ADV.q = q; CMP_ADV.status = status; cmpRange('adv'); CMP.ranges.adv.r = { ...CMP.ranges.adv.r, mode: 'all' }; go('cm-advances'); }

/* ---------- tables: sorted by a click on a heading, ten rows a page (UI-002, NFR-002) ---------- */
function cmpDbTable(id, rows, cols, { empty = 'Nothing here.', rowClass = () => '' } = {}) {
  const s = CMP_DB.sort[id] || {}, col = cols.find(c => c.key === s.key);
  const list = col ? [...rows].sort((a, b) => { const x = col.val(a), y = col.val(b); return (x < y ? -1 : x > y ? 1 : 0) * (s.dir || 1); }) : rows;
  const page = CMP_DB.page[id] = Math.min(CMP_DB.page[id] || 0, Math.max(0, Math.ceil(list.length / CMP_DB_SIZE) - 1)), shown = list.slice(page * CMP_DB_SIZE, page * CMP_DB_SIZE + CMP_DB_SIZE);
  if (!rows.length) return cmpEmpty(empty);
  return `<div class="overflow-x-auto"><table id="cmDbT-${id}" class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr>${cols.map(c => `<th class="py-2 pr-2 whitespace-nowrap ${c.right ? 'text-right' : ''}">${c.val ? `<button type="button" class="hover:text-emerald-700" onclick="cmpDbSort('${id}', '${c.key}')">${esc(c.label)}${s.key === c.key ? (s.dir > 0 ? ' ▲' : ' ▼') : ''}</button>` : esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${shown.map(r => `<tr class="border-b last:border-0 ${rowClass(r)}">${cols.map(c => `<td class="py-1.5 pr-2 align-top ${c.right ? 'text-right' : ''}">${c.html(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    ${list.length > CMP_DB_SIZE ? `<div class="flex items-center justify-end gap-2 text-xs text-slate-600 mt-2">${page * CMP_DB_SIZE + 1}–${Math.min(list.length, (page + 1) * CMP_DB_SIZE)} of ${list.length}
      ${cmpBtn('‹', `cmpDbPage('${id}', -1)`)}${cmpBtn('›', `cmpDbPage('${id}', 1)`)}</div>` : ''}`;
}
function cmpDbSort(id, key) { const s = CMP_DB.sort[id] || {}; CMP_DB.sort[id] = { key, dir: s.key === key ? -(s.dir || 1) : 1 }; CMP_DB.page[id] = 0; cmpDbRedraw(); }
function cmpDbPage(id, n) { CMP_DB.page[id] = Math.max(0, (CMP_DB.page[id] || 0) + n); cmpDbRedraw(); }
function cmpDbRedraw() { const d = CMP_DB.data; if (!d) { if (!cmpCan('REPORTS')) cmpDbCalLoad(); return; } const y = window.scrollY; cmpDbRender(d); window.scrollTo(0, y); }
const cmpDbOpen = r => `cmpOpenPeriod('${r.obligation.id}', '${r.id}', cmpDbLoad)`;
const cmpDbClientCell = r => `<a href="#" class="hover:underline" onclick="event.preventDefault(); cmpOpenClient('${r.client.id}')">${esc(r.client.name)}</a> <span class="text-xs text-slate-400">${esc(r.client.code)}</span>`;
const cmpDbCountry = r => `<span title="${esc(cmpCountry(r.client.country).name)}">${cmpCountry(r.client.country).flag} ${esc(r.client.country)}</span>`;
const cmpDbPeriod = r => `<span class="whitespace-nowrap">${esc(CmpRules.periodName(r))}</span>`;
const cmpDbStatus = r => (r.status === 'PLANNED' ? CMP_PLANNED_CHIP : cmpStatusChip(r.status)) + (r.datesConfirmed === false ? ' <span class="text-[11px] text-sky-700">dates to confirm</span>' : '') + (r.obligation.locked ? ' 🔒' : '');
// the 1st, 2nd and 3rd reminders of a period: sent, due, not sent after its day, not needed, or its day (OBL-09)
function cmpDbRemChips(r) {
  if (!r.reminders || !r.reminders.length) return '<span class="text-xs text-slate-400">no reminders</span>';
  const tone = { SENT: 'bg-emerald-100 text-emerald-800', DUE: 'bg-amber-500 text-white', PENDING: 'border border-amber-500 text-amber-900 bg-amber-50', CLOSED: 'bg-slate-100 text-slate-400', WAIT: 'bg-slate-50 text-slate-500 border' };
  return `<div class="flex flex-wrap gap-1">${r.reminders.map(x => `<span class="px-1.5 py-0.5 rounded text-[11px] whitespace-nowrap ${tone[x.button] || ''}" title="${esc(`${CmpRules.ordinal(x.n)} reminder · ${cmpDay(x.date)}`)}">${CmpRules.ordinal(x.n)} ${x.button === 'SENT' ? `✓${x.sentCount > 1 ? '×' + x.sentCount : ''}` : x.button === 'DUE' ? 'due' : x.button === 'PENDING' ? 'not sent' : x.button === 'CLOSED' ? '–' : cmpDay(x.date)}</span>`).join('')}</div>`;
}
function cmpDbUpTable(d) {
  const cols = [
    { key: 'client', label: 'Client', val: r => r.client.name.toLowerCase(), html: cmpDbClientCell }, { key: 'country', label: 'Country', val: r => r.client.country, html: cmpDbCountry },
    { key: 'ob', label: 'Obligation', val: r => r.obligation.name.toLowerCase(), html: r => esc(r.obligation.name) }, { key: 'period', label: 'Period', val: r => r.periodStart, html: cmpDbPeriod },
    { key: 'due', label: 'Due date', val: r => r.dueDate, html: r => `<span class="whitespace-nowrap">${cmpDay(r.dueDate)}</span>` }, { key: 'left', label: 'Days left', right: true, val: r => r.daysLeft, html: r => `<span class="${r.daysLeft <= 3 ? 'text-red-700 font-semibold' : r.daysLeft <= 7 ? 'text-amber-700 font-medium' : ''}">${r.daysLeft}</span>` },
    { key: 'who', label: 'Assigned to', val: r => cmpWho(r.assignedToId), html: r => `<span class="text-xs">${esc(cmpWho(r.assignedToId) || '—')}</span>` }, { key: 'st', label: 'Status', val: r => r.status, html: cmpDbStatus },
    { key: 'rem', label: 'Reminders', html: cmpDbRemChips }, { key: 'act', label: '', html: r => cmpBtn('Open', cmpDbOpen(r)) },
  ];
  return `${d.upcoming.total > d.upcoming.rows.length ? `<p class="text-xs text-slate-500 mb-1">The first ${d.upcoming.rows.length} of ${d.upcoming.total}.</p>` : ''}${cmpDbTable('up', d.upcoming.rows, cols, { empty: `Nothing due in the next ${d.days} days.`, rowClass: r => (r.daysLeft <= 7 ? 'bg-amber-50/60' : '') })}`;
}
function cmpDbOdTable(d) {
  const last = r => { const l = r.lastReminder; if (!l) return '<span class="text-xs text-slate-400">none due yet</span>'; return `<span class="text-xs whitespace-nowrap ${l.status === 'NOT_SENT' ? 'text-amber-800 font-medium' : ''}">${CmpRules.ordinal(l.n)} · ${{ SENT: `sent${l.sends > 1 ? ` ×${l.sends}` : ''}`, OTHER_WAY: 'given another way', NOT_NEEDED: 'not needed', NOT_SENT: 'not sent' }[l.status]}</span>`; };
  const cols = [
    { key: 'client', label: 'Client', val: r => r.client.name.toLowerCase(), html: cmpDbClientCell }, { key: 'country', label: 'Country', val: r => r.client.country, html: cmpDbCountry },
    { key: 'ob', label: 'Obligation', val: r => r.obligation.name.toLowerCase(), html: r => esc(r.obligation.name) }, { key: 'period', label: 'Period', val: r => r.periodStart, html: cmpDbPeriod },
    { key: 'due', label: 'Due date', val: r => r.dueDate, html: r => `<span class="whitespace-nowrap">${cmpDay(r.dueDate)}</span>` }, { key: 'late', label: 'Days overdue', right: true, val: r => r.daysOverdue, html: r => `<span class="text-red-700 font-semibold">${r.daysOverdue}</span>` },
    { key: 'who', label: 'Assigned to', val: r => cmpWho(r.assignedToId), html: r => `<span class="text-xs">${esc(cmpWho(r.assignedToId) || '—')}</span>` }, { key: 'st', label: 'Status', val: r => r.stage, html: cmpDbStatus },
    { key: 'last', label: 'Last reminder', html: last }, { key: 'act', label: '', html: r => cmpBtn('Open', cmpDbOpen(r)) },
  ];
  return cmpDbTable('od', d.overdue.rows, cols, { empty: 'Nothing is overdue.', rowClass: () => 'bg-red-50/40' });
}

/* ---------- reminders (FR-027 to FR-033): what can be known without the WhatsApp Business service ---------- */
const CMP_DB_REM = { DUE: ['Due', 'bg-amber-500 text-white'], MISSED: ['Not sent after its day', 'border border-amber-500 text-amber-900 bg-amber-50'], MARKED_NOT_SENT: ['Marked not sent', 'bg-rose-100 text-rose-800'],
  SCHEDULED: ['Scheduled', 'bg-slate-100 text-slate-600'], SENT: ['Sent', 'bg-emerald-100 text-emerald-800'], OTHER_WAY: ['Given another way', 'bg-sky-100 text-sky-800'], NOT_NEEDED: ['Not needed', 'bg-slate-100 text-slate-400'] };
function cmpDbReminders(d) {
  const R2 = d.reminders, c = R2.counts, f = CMP_DB.remFilter;
  const keep = x => (f === 'ACT' ? ['DUE', 'MISSED', 'MARKED_NOT_SENT'].includes(x.status) : f === 'ALL' ? true : x.status === f);
  const chip = (k, n, label, tone) => `<button type="button" onclick="CMP_DB.remFilter = '${k}'; CMP_DB.page.rem = 0; cmpDbRedraw()" class="px-3 py-1.5 rounded-full text-xs font-medium ${tone} ${f === k ? 'ring-2 ring-emerald-500' : ''}">${esc(label)} <b>${n}</b></button>`;
  const actions = x => {
    const o = x.occurrence, wa = !o.client.noWhatsApp && cmpCan('WHATSAPP'), out = [];
    if (['DUE', 'MISSED', 'MARKED_NOT_SENT'].includes(x.status)) {
      if (wa) out.push(cmpBtn(`${CMP_WA_ICON} Send`, `cmpWhatsApp({ kind: 'REMINDER', occurrenceId: '${o.id}', reminderId: '${x.reminderId}' }, cmpDbLoad)`, 'wa', 'needs-write'));
      if (cmpCan('WHATSAPP', 'COMPLETE')) out.push(cmpBtn(o.client.noWhatsApp ? '✓ Reminded by phone / email' : 'Another way', `cmpRemindedForm('${o.id}', '${x.reminderId}', 'cmpDbLoad')`, 'plain', 'needs-write'));
    } else if (x.status === 'SENT' || x.status === 'OTHER_WAY') {
      if (cmpCan('WHATSAPP')) out.push(cmpBtn('↶ Not sent', `cmpTrkUnsend({ occurrenceId: '${o.id}', reminderId: '${x.reminderId}' }, cmpDbLoad)`, 'plain', 'needs-write'));
      if (wa) out.push(cmpBtn('Send again', `cmpWhatsApp({ kind: 'REMINDER', occurrenceId: '${o.id}', reminderId: '${x.reminderId}' }, cmpDbLoad)`, 'plain', 'needs-write'));
    }
    return `<div class="flex flex-wrap gap-1 justify-end">${out.join('')}</div>`;
  };
  const cols = [
    { key: 'client', label: 'Client', val: x => x.occurrence.client.name.toLowerCase(), html: x => cmpDbClientCell(x.occurrence) },
    { key: 'ob', label: 'Obligation', val: x => x.occurrence.obligation.name.toLowerCase(), html: x => `<a href="#" class="hover:underline" onclick="event.preventDefault(); ${cmpDbOpen(x.occurrence)}">${esc(x.occurrence.obligation.name)}</a> <span class="text-xs text-slate-500">${esc(CmpRules.periodName(x.occurrence))}</span>` },
    { key: 'n', label: 'Reminder', val: x => x.n, html: x => `${CmpRules.ordinal(x.n)}` }, { key: 'date', label: 'Date', val: x => x.date, html: x => `<span class="whitespace-nowrap">${cmpDay(x.date)}</span>` },
    { key: 'tpl', label: 'Template', val: x => x.templateName, html: x => `<span class="text-xs">${esc(x.templateName || '—')}</span>` },
    { key: 'ch', label: 'Channel', val: x => x.channel, html: x => `<span class="text-xs">${esc(x.channel ? CmpRules.CHANNELS[x.channel] || x.channel : x.occurrence.client.noWhatsApp ? 'Phone / email' : 'WhatsApp')}</span>` },
    { key: 'st', label: 'Status', val: x => x.status, html: x => `<span class="px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${CMP_DB_REM[x.status][1]}">${esc(CMP_DB_REM[x.status][0])}${x.sends > 1 ? ` ×${x.sends}` : ''}</span>${x.voided && ['SENT', 'OTHER_WAY'].includes(x.status) ? `<div class="text-[10px] text-slate-500">${x.voided} marked not sent before</div>` : ''}` },
    { key: 'who', label: 'Assigned to', val: x => cmpWho(x.occurrence.assignedToId), html: x => `<span class="text-xs">${esc(cmpWho(x.occurrence.assignedToId) || '—')}</span>` }, { key: 'act', label: '', html: actions },
  ];
  return cmpDbSec('rem', 'Reminders', `<div class="flex flex-wrap gap-2 mb-2">${chip('ACT', c.DUE + c.MISSED + c.MARKED_NOT_SENT, 'To send', 'bg-amber-100 text-amber-900')}${chip('DUE', c.DUE, 'Due', CMP_DB_REM.DUE[1])}${chip('MISSED', c.MISSED, 'Not sent after its day', CMP_DB_REM.MISSED[1])}
      ${chip('MARKED_NOT_SENT', c.MARKED_NOT_SENT, 'Marked not sent', CMP_DB_REM.MARKED_NOT_SENT[1])}${chip('SCHEDULED', c.SCHEDULED, `Scheduled`, CMP_DB_REM.SCHEDULED[1])}${chip('SENT', c.SENT, 'Sent', CMP_DB_REM.SENT[1])}${chip('OTHER_WAY', c.OTHER_WAY, 'Given another way', CMP_DB_REM.OTHER_WAY[1])}${chip('ALL', R2.rows.length, 'All', 'bg-white border')}</div>
    <p class="text-xs text-slate-500 mb-2">${esc(cmpDbPeriodText(d))}: ${R2.inPeriod.sent} sent on WhatsApp, ${R2.inPeriod.otherWay} given another way, ${R2.inPeriod.markedNotSent} marked not sent. Without the WhatsApp Business service the app cannot see whether a message was delivered or read: a message counts as <b>Sent</b> once WhatsApp opens with it. Check it in WhatsApp; if it did not go, press <b>↶ Not sent</b> and send it again.</p>
    ${cmpDbTable('rem', R2.rows.filter(keep), cols, { empty: f === 'ACT' ? 'No reminder to send now.' : 'None.' })}`, cmpDbRepLink('reminder-register'));
}
// The communication log (the CA's 3.4.3, COM-01 to COM-08): every message of the dates chosen, for those who may see the logs
const CMP_DB_COM_KIND = { REMINDER: 'Reminder', DATA_COLLECTION: 'Data collection', COMPLETION: 'Other', INVOICE: 'Invoice', RECEIPT: 'Receipt', ADVANCE: 'Advance payment', OTHER: 'Other' };
function cmpDbCom(d) {
  const C2 = d.communication, st = { SENT: ['Sent', 'bg-emerald-100 text-emerald-800'], OTHER_WAY: ['Given another way', 'bg-sky-100 text-sky-800'], MARKED_NOT_SENT: ['Marked not sent', 'bg-rose-100 text-rose-800'] };
  const open = x => (x.link.invoice ? `cmpInvoiceOpen('${x.link.invoice}', cmpDbLoad)` : x.link.advance ? `cmpAdvanceView('${x.link.advance}')` : x.link.period ? `cmpOpenPeriod('${x.link.period[0]}', '${x.link.period[1]}', cmpDbLoad)` : `cmpOpenClient('${x.link.client}')`);
  const cols = [
    { key: 'at', label: 'Date and time', val: x => x.at, html: x => `<span class="whitespace-nowrap text-xs">${esc(cmpAt(x.at))}</span>` },
    { key: 'client', label: 'Client', val: x => x.client.name.toLowerCase(), html: x => `<a href="#" class="hover:underline" onclick="event.preventDefault(); cmpOpenClient('${x.client.id}')">${esc(x.client.name)}</a>` },
    { key: 'kind', label: 'Category', val: x => x.kind, html: x => esc(CMP_DB_COM_KIND[x.kind] || x.kind) }, { key: 'tpl', label: 'Template', val: x => x.templateName, html: x => `<span class="text-xs">${esc(x.templateName || '—')}</span>` },
    { key: 'ch', label: 'Channel', val: x => x.channel, html: x => `<span class="text-xs">${esc(CmpRules.CHANNELS[x.channel] || x.channel)}</span>` },
    { key: 'st', label: 'Status', val: x => x.status, html: x => `<span class="px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${st[x.status][1]}">${st[x.status][0]}</span>` },
    { key: 'rel', label: 'About', val: x => x.related, html: x => (x.related ? `<a href="#" class="text-xs hover:underline" onclick="event.preventDefault(); ${open(x)}">${esc(x.related)}</a>` : '—') },
    { key: 'user', label: 'By', val: x => x.user, html: x => `<span class="text-xs">${esc(x.user)}</span>` },
  ];
  return cmpDbSec('com', `Communication log <span class="text-sm font-normal text-slate-500">— ${esc(cmpDbPeriodText(d))}</span>`, `${C2.total > C2.rows.length ? `<p class="text-xs text-slate-500 mb-1">The latest ${C2.rows.length} of ${C2.total}.</p>` : ''}
    ${cmpDbTable('com', C2.rows, cols, { empty: 'No message in these dates.' })}<p class="text-xs text-slate-500 mt-2">"Sent" = handed to WhatsApp (the app cannot see delivery); "Marked not sent" = the user marked that it did not go.</p>`,
    '<a href="#/cm-messages" class="text-sm text-emerald-700 underline">WhatsApp Log ›</a>');
}

/* ---------- the obligations' stages (OBS-01 to OBS-11) ---------- */
function cmpDbWorkflow(d) {
  const w = d.workflow, st = [['CONFIRM', 'Dates to confirm', 'border-sky-400'], ['PLANNED', `Planned (next ${d.days} days)`, 'border-slate-300'], ['UPCOMING', 'Upcoming', 'border-emerald-400'], ['OPEN', 'Open', 'border-sky-500'],
    ['OVERDUE', 'Overdue', 'border-red-600'], ['PERIOD_CLOSED', 'Period closed', 'border-amber-400'], ['DATA_PENDING', 'Data collection pending', 'border-violet-400'], ['DATA_COLLECTED', 'Data collected', 'border-violet-600'],
    ['FILED', 'Filed', 'border-indigo-400'], ['PAID', 'Paid', 'border-indigo-600'], ['COMPLETED', `Completed (${cmpDbPeriodText(d).split(':')[0].toLowerCase()})`, 'border-emerald-600']];
  return cmpDbSec('wf', 'Obligation workflow', `<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">${st.map(([k, label, tone]) => `<button type="button" onclick="cmpDbObligations('${k}')" class="text-left rounded-lg border-l-4 ${tone} bg-slate-50 hover:bg-emerald-50 px-3 py-2"><div class="text-lg font-semibold">${w[k]}</div><div class="text-xs">${esc(label)}</div></button>`).join('')}</div>
    <p class="text-xs text-slate-500 mt-2">A period can be in more than one of these (e.g. open and overdue). Click one to open those periods on My Obligations.</p>`, cmpDbRepLink('obligation-register'));
}

/* ---------- data collection and tasks (FR-034 to FR-041) ---------- */
function cmpDbDataTasks(d) {
  const D = d.data, T = d.tasks;
  const mini = (n, label, tone = '') => `<div class="rounded-lg bg-slate-50 px-3 py-2"><div class="text-lg font-semibold ${tone}">${n}</div><div class="text-xs">${esc(label)}</div></div>`;
  const dataCols = [
    { key: 'client', label: 'Client', val: r => r.client.name.toLowerCase(), html: cmpDbClientCell }, { key: 'ob', label: 'Obligation', val: r => r.obligation.name.toLowerCase(), html: r => `${esc(r.obligation.name)} <span class="text-xs text-slate-500">${esc(CmpRules.periodName(r))}</span>` },
    { key: 'dl', label: 'Collect by', val: r => r.deadline, html: r => `<span class="whitespace-nowrap ${r.late ? 'text-red-700 font-medium' : ''}">${cmpDay(r.deadline)}${r.late ? ' · late' : ''}</span>` },
    { key: 'who', label: 'Assigned to', val: r => cmpWho(r.assignedToId), html: r => `<span class="text-xs">${esc(cmpWho(r.assignedToId) || '—')}</span>` },
    { key: 'act', label: '', html: r => (cmpCan('COMPLETE') ? cmpBtn('Collected', `cmpTrkDataAsk('${r.id}', '${r.client.timeZone}', cmpDbLoad)`, 'plain', 'needs-write') : '') },
  ];
  const taskCols = [
    { key: 'client', label: 'Client', val: r => r.client.name.toLowerCase(), html: cmpDbClientCell }, { key: 'ob', label: 'Task', val: r => r.obligation.name.toLowerCase(), html: r => `${esc(r.obligation.name)} <span class="text-xs text-slate-500">${esc(CmpRules.periodName(r))}</span>` },
    { key: 'due', label: 'Due date', val: r => r.dueDate, html: r => `<span class="whitespace-nowrap ${r.daysLeft < 0 ? 'text-red-700 font-medium' : r.daysLeft === 0 ? 'text-amber-700 font-medium' : ''}">${cmpDay(r.dueDate)}${r.daysLeft < 0 ? ' · overdue' : r.daysLeft === 0 ? ' · today' : ''}</span>` },
    { key: 'who', label: 'Assigned to', val: r => cmpWho(r.assignedToId), html: r => `<span class="text-xs">${esc(cmpWho(r.assignedToId) || '—')}</span>` },
    { key: 'act', label: '', html: r => (cmpCan('COMPLETE') ? cmpBtn('Done', `cmpTrkTaskAsk('${r.id}', '${r.dataCollectedOn}', '${r.client.timeZone}', cmpDbLoad)`, 'plain', 'needs-write') : '') },
  ];
  // (the completed tasks of the dates chosen: FR-041)
  const doneCols = [
    { key: 'client', label: 'Client', val: r => r.client.name.toLowerCase(), html: r => `<a href="#" class="hover:underline" onclick="event.preventDefault(); cmpOpenClient('${r.client.id}')">${esc(r.client.name)}</a>` },
    { key: 'ob', label: 'Task', val: r => r.obligation.name.toLowerCase(), html: r => `<a href="#" class="hover:underline" onclick="event.preventDefault(); cmpOpenPeriod('${r.obligation.id}', '${r.id}', cmpDbLoad)">${esc(r.obligation.name)}</a> <span class="text-xs text-slate-500">${esc(CmpRules.periodName(r))}</span>` },
    { key: 'done', label: 'Completed', val: r => r.completedOn, html: r => `<span class="whitespace-nowrap">${cmpDay(r.completedOn)}</span>` },
    { key: 'due', label: 'Due date', val: r => r.dueDate, html: r => `<span class="whitespace-nowrap ${r.completedOn > r.dueDate ? 'text-amber-700' : ''}">${cmpDay(r.dueDate)}${r.completedOn > r.dueDate ? ' · late' : ''}</span>` },
    { key: 'who', label: 'Assigned to', val: r => cmpWho(r.assignedToId), html: r => `<span class="text-xs">${esc(cmpWho(r.assignedToId) || '—')}</span>` },
  ];
  return `<div class="grid xl:grid-cols-2 gap-4 items-start">
    ${cmpDbSec('data', 'Data collection', `<div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">${mini(D.pending, 'Pending')}${mini(D.late, 'Late', D.late ? 'text-red-700' : '')}${mini(D.collected, 'Collected (open periods)')}${mini(D.collectedInPeriod, `Collected (${cmpDbPeriodText(d).split(':')[0].toLowerCase()})`)}</div>
      <p class="text-xs text-slate-500 mb-2">Late: the last reminder's day has passed (else the due date) and the data is not in yet.</p>${cmpDbTable('data', D.rows, dataCols, { empty: 'No data waiting to be collected.' })}`, cmpDbRepLink('data-pending'))}
    ${cmpDbSec('tasks', 'Tasks', `<div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">${mini(T.dueToday, 'Due today', T.dueToday ? 'text-amber-700' : '')}${mini(T.upcoming, `Upcoming (${d.days} days)`)}${mini(T.overdue, 'Overdue', T.overdue ? 'text-red-700' : '')}${mini(T.completed, `Completed (${cmpDbPeriodText(d).split(':')[0].toLowerCase()})`)}</div>
      <p class="text-xs text-slate-500 mb-2">A task is an obligation's work: open once its data is collected, until it is marked done.</p>
      <div class="inline-flex bg-slate-100 rounded-xl p-1 mb-2">${[['open', `Open (${T.pending})`], ['done', `Completed (${T.completed})`]].map(([k, l]) => `<button type="button" class="seg-btn ${CMP_DB.taskView === k ? 'on' : ''}" onclick="CMP_DB.taskView = '${k}'; cmpDbRedraw()">${l}</button>`).join('')}</div>
      ${CMP_DB.taskView === 'done' ? cmpDbTable('tasksDone', T.completedRows, doneCols, { empty: 'No task completed in these dates.' }) : cmpDbTable('tasks', T.rows, taskCols, { empty: 'No task open.' })}`, cmpDbRepLink(CMP_DB.taskView === 'done' ? 'tasks-completed' : 'tasks-pending'))}
  </div>`;
}

/* ---------- the money, per currency (FR-042 to FR-064) ---------- */
function cmpDbFinance(d) {
  const F = d.finance, pt = cmpDbPeriodText(d).split(':')[0].toLowerCase();
  const line = (label, v, strong) => `<div class="flex justify-between gap-3 text-sm py-0.5"><span class="text-slate-600">${label}</span><span class="${strong ? 'font-semibold' : ''} whitespace-nowrap">${v}</span></div>`;
  const blocks = F.currencies.map(x => `<div class="border rounded-lg p-3 min-w-0"><div class="font-semibold mb-1">${esc(x.currency)}</div>
      <div class="text-[11px] uppercase tracking-wide text-slate-500 font-semibold mt-1">Advance payments</div>
      ${line(`Received (${pt}, ${x.advances.receivedCount})`, cmpMoney(x.advances.received, x.currency))}${line(`Adjusted on invoices (${pt})`, cmpMoney(x.advances.adjusted, x.currency))}${line('Unallocated now', cmpMoney(x.advances.unallocated, x.currency), true)}
      <div class="text-[11px] uppercase tracking-wide text-slate-500 font-semibold mt-2">Invoices</div>
      ${line(`Invoiced (${pt})`, cmpMoney(x.invoices.invoiced, x.currency))}${line('Net of advances', cmpMoney(x.invoices.net, x.currency))}${line(`Outstanding now (${x.invoices.unpaid})`, cmpMoney(x.invoices.outstanding, x.currency), true)}
      <div class="text-[11px] uppercase tracking-wide text-slate-500 font-semibold mt-2">Receipts</div>
      ${line(`Booked (${pt}, ${x.receipts.count})`, cmpMoney(x.receipts.total, x.currency), true)}${Object.entries(x.receipts.methods).map(([k, v]) => line(`· ${esc(CMP_METHODS[k] || k)}`, cmpMoney(v, x.currency))).join('')}
      ${x.receipts.undoneCount ? line(`Undone (${x.receipts.undoneCount}, not counted)`, cmpMoney(x.receipts.undone, x.currency)) : ''}</div>`).join('');
  const st = F.counts, stat = (k, label) => `<div class="rounded-lg bg-slate-50 px-3 py-2"><div class="text-lg font-semibold">${st[k] || 0}</div><div class="text-xs">${esc(label)}</div></div>`;
  const advCols = [
    { key: 'client', label: 'Client', val: r => r.client.name.toLowerCase(), html: r => `<a href="#" class="hover:underline" onclick="event.preventDefault(); cmpOpenClient('${r.client.id}')">${esc(r.client.name)}</a>` },
    { key: 'rec', label: 'Received', right: true, val: r => r.received, html: r => cmpMoney(r.received, r.currency) }, { key: 'adj', label: 'Adjusted', right: true, val: r => r.adjusted, html: r => cmpMoney(r.adjusted, r.currency) },
    { key: 'rem', label: 'Remaining', right: true, val: r => r.remaining, html: r => `<b>${cmpMoney(r.remaining, r.currency)}</b>` }, { key: 'last', label: 'Last payment', val: r => r.lastOn, html: r => cmpDay(r.lastOn) },
    { key: 'act', label: '', html: r => cmpBtn('Open', `cmpDbAdvances(${JSON.stringify(r.client.name).replace(/"/g, '&quot;')}, '')`) },
  ];
  const outCols = [
    { key: 'no', label: 'Invoice', val: r => r.number, html: r => `<a href="#" class="text-emerald-700 underline" onclick="event.preventDefault(); cmpInvoiceOpen('${r.id}', cmpDbLoad)">${esc(r.number)}</a>` },
    { key: 'client', label: 'Client', val: r => r.client.name.toLowerCase(), html: r => esc(r.client.name) }, { key: 'date', label: 'Issued', val: r => r.issueDate, html: r => `<span class="whitespace-nowrap">${cmpDay(r.issueDate)}</span>` },
    { key: 'gross', label: 'Gross', right: true, val: r => r.gross, html: r => cmpMoney(r.gross, r.currency) }, { key: 'adv', label: 'Advance adjusted', right: true, val: r => r.advanceAdjusted, html: r => (r.advanceAdjusted ? `− ${cmpMoney(r.advanceAdjusted, r.currency)}` : '—') },
    { key: 'rec', label: 'Receipts', right: true, val: r => r.received, html: r => (r.received ? `− ${cmpMoney(r.received, r.currency)}` : '—') }, { key: 'out', label: 'Outstanding', right: true, val: r => r.outstanding, html: r => `<b>${cmpMoney(r.outstanding, r.currency)}</b>` },
    { key: 'age', label: 'Days', right: true, val: r => r.age, html: r => `${r.age}` },
  ];
  return cmpDbSec('fin', 'Financial overview', `<div class="grid sm:grid-cols-2 xl:grid-cols-3 gap-3 mb-4">${blocks || cmpEmpty('No advances, invoices or receipts for these filters.')}</div>
      <div class="text-sm font-semibold mb-1">Invoices issued (${pt}), by their status now · drafts now <span class="font-normal text-slate-500">· created (${pt}): ${F.created.count}${F.created.drafts ? `, ${F.created.drafts} still a draft` : ''}</span></div>
      <div class="grid grid-cols-3 md:grid-cols-6 gap-2 mb-4">${stat('DRAFT', 'Drafts')}${stat('ISSUED', 'Issued, not sent')}${stat('SENT', 'Sent')}${stat('PARTIAL', 'Partly received')}${stat('RECEIVED', 'Received')}${stat('CANCELLED', 'Cancelled')}</div>
      <div class="grid xl:grid-cols-2 gap-4 items-start"><div id="cmDbSec-out" class="scroll-mt-40 min-w-0"><div class="text-sm font-semibold mb-1">Outstanding invoices <span class="font-normal text-slate-500">(${F.outstanding.total}) — gross, less the advance and the receipts allocated to it</span></div>${cmpDbTable('out', F.outstanding.rows, outCols, { empty: 'Every issued invoice is paid.' })}</div>
        <div class="min-w-0"><div class="text-sm font-semibold mb-1">Advances by client</div>${cmpDbTable('adv', F.advancesByClient, advCols, { empty: 'No advance payments.' })}</div></div>
      <p class="text-xs text-slate-500 mt-2">An advance is not a receipt: it counts as paid on an invoice only when it is taken off that invoice. Amounts in different currencies are never added together.</p>`,
    `<span class="flex gap-3">${cmpDbRepLink('receivables-outstanding', 'Outstanding report ›')}${cmpDbRepLink('advance-balance', 'Advances report ›')}${cmpDbRepLink('collection-summary', 'Collections report ›')}</span>`);
}

/* ---------- recent activity (FR-065 to FR-080) and the alerts to act on (FR-081 to FR-087) ---------- */
function cmpDbActivity(d) {
  const A = d.activity, tone = { Client: 'bg-slate-100', Obligation: 'bg-sky-100 text-sky-800', Reminder: 'bg-emerald-100 text-emerald-800', 'Data collection': 'bg-violet-100 text-violet-800', Task: 'bg-indigo-100 text-indigo-800', Advance: 'bg-teal-100 text-teal-800', Invoice: 'bg-amber-100 text-amber-900', Receipt: 'bg-lime-100 text-lime-900' };
  const open = a => (!a.link ? '' : a.link.invoice ? `cmpInvoiceOpen('${a.link.invoice}', cmpDbLoad)` : a.link.advance ? `cmpAdvanceView('${a.link.advance}')` : a.link.period ? `cmpOpenPeriod('${a.link.period[0]}', '${a.link.period[1]}', cmpDbLoad)` : a.link.client ? `cmpOpenClient('${a.link.client}')` : '');
  const page = CMP_DB.page.act = Math.min(CMP_DB.page.act || 0, Math.max(0, Math.ceil(A.rows.length / 15) - 1)), rows = A.rows.slice(page * 15, page * 15 + 15);
  return cmpDbSec('act', `Recent activity <span class="text-sm font-normal text-slate-500">— ${esc(cmpDbPeriodText(d))}</span>`, rows.length ? `<ul class="divide-y">${rows.map(a => `<li class="py-2 flex gap-3 items-start">
      <span class="px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${tone[a.type] || 'bg-slate-100'}">${esc(a.type)}</span>
      <div class="min-w-0 flex-1"><div class="text-sm">${open(a) ? `<a href="#" class="hover:underline font-medium" onclick="event.preventDefault(); ${open(a)}">${esc(a.label)}</a>` : `<b>${esc(a.label)}</b>`}${a.client ? ` · ${esc(a.client)}` : ''}</div>
        <div class="text-xs text-slate-500 truncate" title="${esc(a.summary)}">${esc(a.summary)}</div></div>
      <div class="text-[11px] text-slate-500 text-right whitespace-nowrap">${esc(cmpAt(a.at))}<div>${esc(a.user || '')}</div></div></li>`).join('')}</ul>
    ${A.rows.length > 15 ? `<div class="flex items-center justify-end gap-2 text-xs text-slate-600 mt-2">${page * 15 + 1}–${Math.min(A.rows.length, page * 15 + 15)} of ${A.rows.length}${A.total > A.rows.length ? ` (the latest ${A.rows.length} of ${A.total})` : ''}${cmpBtn('‹', "cmpDbPage('act', -1)")}${cmpBtn('›', "cmpDbPage('act', 1)")}</div>` : ''}
    ${A.more ? '<p class="text-xs text-slate-500 mt-1">A very busy stretch of dates: only the latest part of the log was read. Choose fewer dates to see all of it.</p>' : ''}
    <div class="mt-2"><a href="#/cm-activity" class="text-sm text-emerald-700 underline">The whole activity log ›</a></div>` : cmpEmpty('Nothing happened in these dates.'), cmpDbRepLink('audit-trail'));
}
function cmpDbAlerts(d) {
  const go = { MARKED_NOT_SENT: "CMP_DB.remFilter = 'MARKED_NOT_SENT'; cmpDbRedraw(); cmpDbGo('rem')", OVERDUE: "cmpDbObligations('OVERDUE')", MISSED: "CMP_DB.remFilter = 'MISSED'; cmpDbRedraw(); cmpDbGo('rem')",
    DUE_SOON: "cmpDbGo('up')", CONFIRM: "cmpDbObligations('CONFIRM')", DATA_LATE: "cmpDbGo('data')", MISSING: 'cmpDbClients(true)', FAILED_NOTIFICATIONS: "go('cm-notify')" };
  const tone = { critical: 'border-red-600 bg-red-50', high: 'border-amber-500 bg-amber-50', medium: 'border-slate-300 bg-slate-50' };
  return cmpDbSec('alerts', 'Alerts', d.alerts.length ? `<div class="space-y-2">${d.alerts.map(a => `<button type="button" onclick="${go[a.key]}" class="w-full text-left rounded-lg border-l-4 ${tone[a.level]} px-3 py-2 hover:ring-2 hover:ring-emerald-200 text-sm"><b>${a.count}</b> ${esc(a.text)}</button>`).join('')}</div>
    <p class="text-xs text-slate-500 mt-2">Only what needs action shows here; everything else is in the activity.</p>` : cmpEmpty('Nothing needs attention. 🎉'));
}

/* ---------- by country and by person (the CA's phase 3) ---------- */
function cmpDbPeople(d) {
  const num = (v, red) => `<td class="py-1 text-right ${red && v ? 'text-red-700 font-semibold' : ''}">${v}</td>`;
  const head = first => `<thead class="text-left text-slate-500 border-b"><tr><th class="py-1">${first}</th><th class="text-right">Clients</th><th class="text-right">Open</th><th class="text-right">Overdue</th><th class="text-right">Due ${d.days}d</th><th class="text-right">Data pending</th><th class="text-right">Tasks pending</th></tr></thead>`;
  const row = (label, x) => `<tr class="border-b last:border-0"><td class="py-1">${label}</td>${num(x.clients)}${num(x.open)}${num(x.overdue, true)}${num(x.upcoming)}${num(x.dataPending)}${num(x.taskPending)}</tr>`;
  return `<div class="grid xl:grid-cols-2 gap-4 items-start">
    ${cmpDbSec('ctry', 'By country', d.byCountry.length ? `<div class="overflow-x-auto"><table class="w-full text-sm">${head('Country')}<tbody>${d.byCountry.map(x => row(cmpFlagName(x.key), x)).join('')}</tbody></table></div>` : cmpEmpty('No clients.'), `<span class="flex gap-3">${cmpDbRepLink('clients-by-country', 'Clients ›')}${cmpDbRepLink('deadlines-by-country', 'Deadlines ›')}</span>`)}
    ${cmpDbSec('staff', 'Staff workload', d.byPerson.length ? `<div class="overflow-x-auto"><table class="w-full text-sm">${head('Person')}<tbody>${d.byPerson.map(x => row(esc(x.name), x)).join('')}</tbody></table></div><p class="text-xs text-slate-500 mt-2">An obligation counts for its own person, else its client's person.</p>` : cmpEmpty('No work assigned.'), cmpDbRepLink('staff-workload'))}
  </div>`;
}

/* ---------- the calendar: month, week or day (FR-019 to FR-026) ---------- */
function cmpDbCalRange() {
  const c = CMP_DB.cal, day = c.day || CmpRules.dayIn(cmpTz());
  if (c.view === 'day') return { from: day, to: day };
  if (c.view === 'week') { const from = CmpRules.addDays(day, -((new Date(day + 'T00:00:00Z').getUTCDay() + 6) % 7)); return { from, to: CmpRules.addDays(from, 6) }; }
  const [y, m] = day.split('-').map(Number); return { from: `${day.slice(0, 8)}01`, to: `${day.slice(0, 8)}${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}` };
}
async function cmpDbCalLoad() {
  if (!document.getElementById('cmDbCal')) return;
  const r = cmpDbCalRange(), f = CMP_DB.f, seq = ++CMP_DB.calSeq;
  let data;
  try { data = await api('/api/cmp/overview/calendar?' + cmpQs({ ...r, country: f.country, clientId: f.clientId, obligation: f.obligation, assignee: f.assignee })); }
  catch (err) { const box = document.getElementById('cmDbCal'); if (box && seq === CMP_DB.calSeq) box.innerHTML = `<h2 class="font-semibold mb-2">Compliance calendar</h2>${cmpEmpty(esc(err.message))}`; return; }
  if (seq !== CMP_DB.calSeq || !document.getElementById('cmDbCal')) return; // (another month or filter was chosen meanwhile)
  CMP_DB.cal.data = data;
  cmpDbCalDraw();
}
function cmpDbCalMove(n) {
  const c = CMP_DB.cal, day = c.day || CmpRules.dayIn(cmpTz());
  if (c.view === 'day') c.day = CmpRules.addDays(day, n);
  else if (c.view === 'week') c.day = CmpRules.addDays(day, 7 * n);
  else { const [y, m] = day.split('-').map(Number), idx = y * 12 + (m - 1) + n; c.day = `${Math.floor(idx / 12)}-${String(idx % 12 + 1).padStart(2, '0')}-01`; }
  cmpDbCalLoad();
}
const CMP_DB_CAL_TONE = { red: 'bg-red-100 text-red-800', amber: 'bg-amber-100 text-amber-900', green: 'bg-emerald-50 text-emerald-900', done: 'bg-slate-100 text-slate-500 line-through', planned: 'border border-dashed border-slate-400 text-slate-500' };
function cmpDbCalEntry(e, wide) {
  const o = e.occurrence, who = `${cmpCountry(o.client.country).flag} ${esc(o.client.name)} · ${esc(o.obligation.name)}`;
  const open = o.projected ? `cmpOpenPlanned('${o.obligation.id}', ${o.seq})` : `cmpOpenPeriod('${o.obligation.id}', '${o.id}', () => { cmpDbCalLoad(); if (cmpCan('REPORTS')) cmpDbLoad(true); })`;
  const cls = wide ? 'w-full text-left text-xs rounded px-2 py-1 mt-1' : 'w-full text-left text-[11px] leading-tight truncate rounded px-1 py-0.5 mt-0.5';
  if (e.type === 'due') return `<button type="button" onclick="${open}" class="${cls} ${CMP_DB_CAL_TONE[o.colour] || ''}" title="${esc(`Due: ${o.client.name} — ${o.obligation.name}`)}">⚑ ${who}${wide ? ` <span class="text-slate-500">· due · ${esc(CmpRules.STATUS[o.status] || o.status)}</span>` : ''}</button>`;
  if (e.type === 'reminder') return `<button type="button" onclick="${open}" class="${cls} ${e.button === 'SENT' ? 'bg-emerald-50 text-emerald-800' : e.planned || e.button === 'WAIT' ? 'bg-white border text-slate-500' : e.button === 'CLOSED' ? 'bg-slate-50 text-slate-400' : 'bg-amber-50 text-amber-900 border border-amber-300'}" title="${esc(`${CmpRules.ordinal(e.n)} reminder: ${o.client.name} — ${o.obligation.name}`)}">✉ ${CmpRules.ordinal(e.n)} · ${who}${wide && e.templateName ? ` <span class="text-slate-500">· ${esc(e.templateName)}</span>` : ''}${e.button === 'SENT' ? ' ✓' : ''}</button>`;
  return `<button type="button" onclick="${open}" class="${cls} bg-indigo-50 text-indigo-800" title="${esc(`Task done: ${o.client.name} — ${o.obligation.name}`)}">✓ ${who}${wide ? ' <span class="text-slate-500">· task done</span>' : ''}</button>`;
}
function cmpDbCalDraw() {
  const box = document.getElementById('cmDbCal'), c = CMP_DB.cal, d = c.data, today = CmpRules.dayIn(cmpTz()), day = c.day || today;
  const byDay = new Map(); for (const e of d.entries) { if (!byDay.has(e.date)) byDay.set(e.date, []); byDay.get(e.date).push(e); }
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const [y, m] = day.split('-').map(Number);
  const title = c.view === 'month' ? `${MONTHS[m - 1]} ${y}` : c.view === 'week' ? `${cmpDay(d.from)} – ${cmpDay(d.to)}` : cmpDay(day);
  let grid = '';
  if (c.view === 'month') {
    const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7, days = new Date(Date.UTC(y, m, 0)).getUTCDate(), cells = [];
    for (let i = 0; i < lead; i++) cells.push('<div class="bg-slate-50 min-h-[6rem]"></div>');
    for (let dd = 1; dd <= days; dd++) {
      const ymd = `${day.slice(0, 8)}${String(dd).padStart(2, '0')}`, items = byDay.get(ymd) || [];
      cells.push(`<div class="bg-white min-h-[6rem] p-1 ${ymd === today ? 'ring-2 ring-inset ring-emerald-500' : ''}"><button type="button" class="text-xs ${ymd === today ? 'font-bold text-emerald-700' : 'text-slate-500'} hover:underline" onclick="CMP_DB.cal.view = 'day'; CMP_DB.cal.day = '${ymd}'; cmpDbCalLoad()">${dd}</button>
        ${items.slice(0, 4).map(e => cmpDbCalEntry(e)).join('')}${items.length > 4 ? `<button type="button" class="text-[11px] text-emerald-700 underline" onclick="CMP_DB.cal.view = 'day'; CMP_DB.cal.day = '${ymd}'; cmpDbCalLoad()">+${items.length - 4} more</button>` : ''}</div>`);
    }
    while (cells.length % 7) cells.push('<div class="bg-slate-50 min-h-[6rem]"></div>');
    grid = `<div class="grid grid-cols-7 text-xs text-slate-500 mb-1">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => `<div class="px-1">${x}</div>`).join('')}</div>
      <div class="grid grid-cols-7 gap-px bg-slate-200 border border-slate-200 rounded-lg overflow-hidden">${cells.join('')}</div>`;
  } else if (c.view === 'week') {
    grid = `<div class="grid grid-cols-1 md:grid-cols-7 gap-2">${Array.from({ length: 7 }, (_, i) => { const ymd = CmpRules.addDays(d.from, i), items = byDay.get(ymd) || [];
      return `<div class="border rounded-lg p-2 min-h-[8rem] ${ymd === today ? 'ring-2 ring-emerald-500' : ''}"><button type="button" class="text-xs font-semibold hover:underline" onclick="CMP_DB.cal.view = 'day'; CMP_DB.cal.day = '${ymd}'; cmpDbCalLoad()">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i]} ${cmpDay(ymd)}</button>${items.map(e => cmpDbCalEntry(e)).join('') || '<div class="text-[11px] text-slate-300 mt-1">—</div>'}</div>`; }).join('')}</div>`;
  } else {
    const items = byDay.get(day) || [];
    grid = items.length ? `<div class="space-y-1">${items.map(e => cmpDbCalEntry(e, true)).join('')}</div>` : cmpEmpty('Nothing on this day.');
  }
  box.innerHTML = `<div class="flex flex-wrap items-end justify-between gap-3 mb-3"><div class="flex flex-wrap items-center gap-2"><h2 class="font-semibold mr-2">Compliance calendar</h2>
      <div class="inline-flex bg-slate-100 rounded-xl p-1">${['month', 'week', 'day'].map(v => `<button type="button" class="seg-btn ${c.view === v ? 'on' : ''}" onclick="CMP_DB.cal.view = '${v}'; cmpDbCalLoad()">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
      ${cmpBtn('‹', 'cmpDbCalMove(-1)')}${cmpBtn('Today', "CMP_DB.cal.day = null; cmpDbCalLoad()")}${cmpBtn('›', 'cmpDbCalMove(1)')}<span class="font-semibold text-lg px-2">${esc(title)}</span></div>
      <label class="w-44"><span>Go to a date</span><input type="date" value="${esc(day)}" onchange="if (this.value) { CMP_DB.cal.day = this.value; cmpDbCalLoad(); }"></label></div>
    ${grid}
    <p class="text-xs text-slate-500 mt-2">⚑ due date (green safe · amber approaching · red overdue · grey completed · dashed: planned) · ✉ reminder (✓ sent) · ✓ task done. Each on its client's own calendar day; the filters at the top apply.</p>`;
}

/* ---------- Excel and PDF, made here from what is on the screen (nothing is written on the server: no activity-log line either) ---------- */
function cmpDbExcel() {
  const d = CMP_DB.data; if (!d) return toast('Load the dashboard first.');
  const q = v => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const lines = [], row = (...v) => lines.push(v.map(q).join(',')), blank = () => lines.push('');
  row('ETAX Compliance & Deadlines — Dashboard', S.company || ''); row(cmpDbPeriodText(d), `Upcoming: next ${d.days} days`, `Made ${cmpAt(d.generatedAt)}`);
  row('Filters', `Country: ${d.filters.country || 'all'}`, `Client: ${d.filters.clientId ? ((d.clientsList.find(c => c.id === d.filters.clientId) || {}).name || '') : 'all'}`, `Obligation: ${d.filters.obligation || 'all'}`, `Assigned to: ${d.filters.assignee ? (cmpWho(d.filters.assignee) || d.filters.assignee) : 'everyone'}`); blank();
  row('Figure', 'Value'); const k = d.kpis;
  [['Active clients', k.activeClients], ['Missing client information', k.missingInfo], ['Open obligations', k.open], ['Overdue obligations', k.overdue], [`Due in the next ${d.days} days`, k.upcoming], ['Reminders to send', k.remindersDue], ['Data collection pending', k.dataPending], ['Tasks pending', k.taskPending]].forEach(([a, b]) => row(a, b));
  if (d.money) for (const x of d.finance.currencies) { row(`Outstanding invoices (${x.currency})`, x.invoices.outstanding); row(`Unallocated advances (${x.currency})`, x.advances.unallocated); }
  blank(); row('Upcoming statutory deadlines'); row('Client', 'Code', 'Country', 'Obligation', 'Period', 'Due date', 'Days left', 'Assigned to', 'Status', 'Reminders');
  for (const r of d.upcoming.rows) row(r.client.name, r.client.code, r.client.country, r.obligation.name, CmpRules.periodName(r), cmpDay(r.dueDate), r.daysLeft, cmpWho(r.assignedToId), CmpRules.STATUS[r.status] || r.status, (r.reminders || []).map(x => `${CmpRules.ordinal(x.n)} ${x.button.toLowerCase()}`).join(' / '));
  blank(); row('Overdue obligations'); row('Client', 'Code', 'Country', 'Obligation', 'Period', 'Due date', 'Days overdue', 'Assigned to', 'Status', 'Last reminder');
  for (const r of d.overdue.rows) row(r.client.name, r.client.code, r.client.country, r.obligation.name, CmpRules.periodName(r), cmpDay(r.dueDate), r.daysOverdue, cmpWho(r.assignedToId), CmpRules.STATUS[r.status] || r.status, r.lastReminder ? `${CmpRules.ordinal(r.lastReminder.n)} ${r.lastReminder.status.toLowerCase().replace(/_/g, ' ')}` : '');
  blank(); row('Reminders'); row('Client', 'Obligation', 'Period', 'Reminder', 'Date', 'Template', 'Channel', 'Status', 'Assigned to');
  for (const x of d.reminders.rows) row(x.occurrence.client.name, x.occurrence.obligation.name, CmpRules.periodName(x.occurrence), CmpRules.ordinal(x.n), cmpDay(x.date), x.templateName, x.channel ? CmpRules.CHANNELS[x.channel] || x.channel : '', CMP_DB_REM[x.status][0], cmpWho(x.occurrence.assignedToId));
  if (d.logs && d.communication) { blank(); row('Communication log'); row('Date and time', 'Client', 'Category', 'Template', 'Channel', 'Status', 'About', 'By');
    for (const x of d.communication.rows) row(cmpAt(x.at), x.client.name, CMP_DB_COM_KIND[x.kind] || x.kind, x.templateName, CmpRules.CHANNELS[x.channel] || x.channel, { SENT: 'Sent', OTHER_WAY: 'Given another way', MARKED_NOT_SENT: 'Marked not sent' }[x.status], x.related, x.user); }
  blank(); row('Obligation workflow'); Object.entries(d.workflow).forEach(([a, b]) => row(a.replace(/_/g, ' ').toLowerCase(), b));
  blank(); row('Data collection', 'Pending', d.data.pending, 'Late', d.data.late, 'Collected (open)', d.data.collected, 'Collected (dates)', d.data.collectedInPeriod);
  row('Tasks', 'Due today', d.tasks.dueToday, 'Upcoming', d.tasks.upcoming, 'Overdue', d.tasks.overdue, 'Completed (dates)', d.tasks.completed);
  if (d.money) {
    blank(); row('Money', 'Currency', 'Advances received', 'Advances adjusted', 'Unallocated advances', 'Invoiced', 'Net of advances', 'Outstanding', 'Receipts booked', 'Receipts undone');
    for (const x of d.finance.currencies) row('', x.currency, x.advances.received, x.advances.adjusted, x.advances.unallocated, x.invoices.invoiced, x.invoices.net, x.invoices.outstanding, x.receipts.total, x.receipts.undone);
    blank(); row('Outstanding invoices'); row('Invoice', 'Client', 'Currency', 'Issued', 'Gross', 'Advance adjusted', 'Receipts', 'Outstanding', 'Days');
    for (const r of d.finance.outstanding.rows) row(r.number, r.client.name, r.currency, cmpDay(r.issueDate), r.gross, r.advanceAdjusted, r.received, r.outstanding, r.age);
  }
  const blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `dashboard-${d.today}.csv`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function cmpDbPrint() {
  const d = CMP_DB.data; if (!d) return toast('Load the dashboard first.');
  const t = (head, rows) => `<table style="width:100%;border-collapse:collapse;font-size:10px;margin:4px 0 10px"><thead><tr>${head.map(h => `<th style="border:1px solid #cbd5e1;padding:3px 5px;text-align:left;background:#f1f5f9">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td style="border:1px solid #cbd5e1;padding:3px 5px">${esc(c)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${head.length}" style="padding:4px">None</td></tr>`}</tbody></table>`;
  const h = s => `<div style="font-weight:700;font-size:12px;margin-top:8px">${esc(s)}</div>`, k = d.kpis;
  const html = `<div style="font-family:system-ui,sans-serif;color:#0f172a"><div style="display:flex;justify-content:space-between"><div style="font-size:16px;font-weight:700">Dashboard</div><div style="font-size:10px;color:#475569">${esc(S.company || '')} · ${esc(cmpDbPeriodText(d))} · printed ${esc(cmpAt(Date.now()))}</div></div>
    ${t(['Active clients', 'Missing info', 'Open', 'Overdue', `Due ${d.days}d`, 'Reminders to send', 'Data pending', 'Tasks pending'], [[k.activeClients, k.missingInfo, k.open, k.overdue, k.upcoming, k.remindersDue, k.dataPending, k.taskPending]])}
    ${h('Upcoming statutory deadlines')}${t(['Client', 'Country', 'Obligation', 'Period', 'Due', 'Days left', 'Assigned to', 'Status'], d.upcoming.rows.map(r => [r.client.name, r.client.country, r.obligation.name, CmpRules.periodName(r), cmpDay(r.dueDate), r.daysLeft, cmpWho(r.assignedToId), CmpRules.STATUS[r.status] || r.status]))}
    ${h('Overdue obligations')}${t(['Client', 'Country', 'Obligation', 'Period', 'Due', 'Days overdue', 'Assigned to'], d.overdue.rows.map(r => [r.client.name, r.client.country, r.obligation.name, CmpRules.periodName(r), cmpDay(r.dueDate), r.daysOverdue, cmpWho(r.assignedToId)]))}
    ${d.money ? h('Money') + t(['Currency', 'Advances received', 'Adjusted', 'Unallocated', 'Invoiced', 'Outstanding', 'Receipts'], d.finance.currencies.map(x => [x.currency, cmpMoney(x.advances.received, x.currency), cmpMoney(x.advances.adjusted, x.currency), cmpMoney(x.advances.unallocated, x.currency), cmpMoney(x.invoices.invoiced, x.currency), cmpMoney(x.invoices.outstanding, x.currency), cmpMoney(x.receipts.total, x.currency)])) : ''}</div>`;
  posPrint(html, '@page { size: A4 landscape; margin: 10mm; }');
}
