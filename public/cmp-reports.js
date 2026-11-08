'use strict';
/* Compliance & Deadlines: the dashboard (SRS 11: upcoming in 7/30/60-day windows and overdue, with flags), the calendar of deadlines,
   the reports (overdue list, upcoming deadlines, invoice aging) and printing any list as a PDF (SRS 13). */

const CMP_REP = { days: 30, month: null, calCountry: '', calAssignee: '', report: 'overdue', repDays: 30 };
CMP_RESETS.push(() => Object.assign(CMP_REP, { days: 30, month: null, calCountry: '', calAssignee: '', report: 'overdue', repDays: 30 }));

// Any table on the screen, printed on A4 (the browser's "Save as PDF" makes the PDF)
function cmpPrintTable(title, tableId, note = '') {
  const t = document.getElementById(tableId); if (!t) return;
  const copy = t.cloneNode(true);
  copy.querySelectorAll('input, button, select').forEach(el => el.remove());
  copy.style.cssText = 'width:100%;border-collapse:collapse;font-size:11px';
  copy.querySelectorAll('th, td').forEach(c => { c.style.border = '1px solid #cbd5e1'; c.style.padding = '4px 6px'; c.style.textAlign = c.classList.contains('text-right') ? 'right' : 'left'; });
  posPrint(`<div style="font-family:system-ui,sans-serif;color:#0f172a"><div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
    <div style="font-size:16px;font-weight:700">${esc(title)}</div><div style="font-size:11px;color:#475569">${esc(S.company || '')} · printed ${esc(cmpAt(Date.now()))}</div></div>
    ${note ? `<div style="font-size:11px;margin-bottom:6px">${note}</div>` : ''}${copy.outerHTML}</div>`, '@page { size: A4 landscape; margin: 10mm; }');
}
const cmpOccTable = (rows, id, { showDays = true } = {}) => `<div class="overflow-x-auto"><table id="${id}" class="w-full text-sm">
  <thead class="text-left text-slate-500 border-b"><tr><th class="py-2"></th><th>Due date</th><th>Client</th><th>Obligation</th><th>Period</th><th>Status</th>${showDays ? '<th class="text-right">Days</th>' : ''}<th>Assigned to</th></tr></thead><tbody>
  ${rows.map(r => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer" onclick="cmpOpenPeriod('${r.obligation.id}', '${r.id}', () => PAGE_ENTER[S.page] && PAGE_ENTER[S.page]())">
    <td class="py-1.5 w-5">${cmpDot(r.view.colour)}</td><td class="whitespace-nowrap">${cmpDay(r.dueDate)}</td><td>${cmpCountry(r.client.country).flag} ${esc(r.client.name)}</td>
    <td>${esc(r.obligation.name)}</td><td class="whitespace-nowrap">${esc(CmpRules.periodName(r))}</td><td>${cmpStatusChip(r.view.status)}</td>
    ${showDays ? `<td class="text-right ${r.view.overdue ? 'text-red-700 font-semibold' : ''}">${r.view.daysLeft}</td>` : ''}<td class="text-xs">${esc(cmpWho(r.assignedToId))}</td></tr>`).join('')
  || `<tr><td colspan="8">${cmpEmpty('Nothing here.')}</td></tr>`}</tbody></table></div>`;

/* ---------- the dashboard ---------- */
CMP_PAGES.push({
  id: 'cm-dashboard',
  html: () => `<div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3"><div role="tablist" class="inline-flex bg-slate-100 rounded-xl p-1">
      ${[7, 30, 60].map(n => `<button type="button" class="seg-btn cmDays" data-days="${n}" onclick="CMP_REP.days = ${n}; cmpLoadDashboard()">Next ${n} days</button>`).join('')}</div>
      <div class="text-xs text-slate-500">Due dates are each client's own calendar day.</div></div>
    <div id="cmDashCards" class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3"></div>
    <div class="grid xl:grid-cols-3 gap-4">
      <section class="min-w-0 xl:col-span-2 bg-white rounded-xl shadow p-4"><h2 class="font-semibold mb-2 text-red-700">Overdue</h2><div id="cmDashOverdue"></div>
        <h2 class="font-semibold mt-5 mb-2">Due in the window <span id="cmDashWin" class="text-slate-500 font-normal text-sm"></span></h2><div id="cmDashUpcoming"></div></section>
      <div class="min-w-0 space-y-4"><section class="bg-white rounded-xl shadow p-4"><h2 class="font-semibold mb-2">By country</h2><div id="cmDashCountries"></div></section>
        <section id="cmDashUnpaidBox" class="bg-white rounded-xl shadow p-4 hidden"><h2 class="font-semibold mb-2">Fees not paid yet</h2><div id="cmDashUnpaid"></div></section></div>
    </div></div>`,
  enter: () => cmpLoadDashboard(),
});
async function cmpLoadDashboard() {
  document.querySelectorAll('.cmDays').forEach(b => b.classList.toggle('on', Number(b.dataset.days) === CMP_REP.days));
  let d;
  try { d = await api('/api/cmp/dashboard?days=' + CMP_REP.days); } catch (err) { $('#cmDashCards').innerHTML = cmpEmpty(esc(err.message)); return; }
  const s = d.summary;
  const card = (n, label, tone, go) => `<button type="button" onclick="${go}" class="text-left bg-white rounded-xl shadow p-4 border-l-4 ${tone} hover:ring-2 hover:ring-emerald-200"><div class="text-2xl font-semibold">${n}</div><div class="text-sm">${label}</div></button>`;
  $('#cmDashCards').innerHTML = [
    card(s.overdue, 'Overdue', 'border-red-600', "cmpOpenObligations('OVERDUE')"),
    card(s.dueInWindow, `Due in ${d.days} days`, 'border-amber-500', "cmpOpenObligations('OPEN')"),
    card(s.ready, 'Reminders to send', 'border-amber-400', "go('cm-notify')"),
    card(s.confirm, 'Dates to confirm', 'border-sky-500', "cmpOpenObligations('CONFIRM')"),
    card(s.completedThisMonth, 'Completed this month', 'border-emerald-500', "cmpOpenObligations('COMPLETED')"),
    card(s.clients, 'Clients', 'border-slate-300', "go('cm-clients')"),
  ].join('');
  $('#cmDashWin').textContent = `(next ${d.days} days)`;
  $('#cmDashOverdue').innerHTML = cmpOccTable(d.overdue, 'cmDashOverdueT');
  $('#cmDashUpcoming').innerHTML = cmpOccTable(d.upcoming, 'cmDashUpcomingT');
  $('#cmDashCountries').innerHTML = d.byCountry.length ? `<table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-1">Country</th><th class="text-right">Open</th><th class="text-right">Overdue</th></tr></thead><tbody>
    ${d.byCountry.map(c => `<tr class="border-b last:border-0"><td class="py-1">${cmpFlagName(c.country)}</td><td class="text-right">${c.open}</td><td class="text-right ${c.overdue ? 'text-red-700 font-semibold' : ''}">${c.overdue}</td></tr>`).join('')}</tbody></table>` : cmpEmpty('No open obligations.');
  $('#cmDashUnpaidBox').classList.toggle('hidden', !d.unpaid);
  if (d.unpaid) $('#cmDashUnpaid').innerHTML = d.unpaid.length ? d.unpaid.map(u => `<div class="flex justify-between text-sm py-1 border-b last:border-0"><span>${u.count} invoice${u.count === 1 ? '' : 's'}</span><b>${cmpMoney(u.outstanding, u.currency)}</b></div>`).join('')
    + `<div class="mt-2">${cmpBtn('Invoice aging', "CMP_REP.report = 'aging'; go('cm-reports')")}</div>` : cmpEmpty('Everything is paid.');
}

/* ---------- the calendar ---------- */
CMP_PAGES.push({
  id: 'cm-calendar',
  html: () => `<div class="bg-white rounded-xl shadow p-4">
    <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
      <div class="flex items-center gap-2">${cmpBtn('‹', 'cmpCalMove(-1)')}<h2 id="cmCalTitle" class="font-semibold text-lg w-44 text-center"></h2>${cmpBtn('›', 'cmpCalMove(1)')}${cmpBtn('Today', 'CMP_REP.month = null; cmpLoadCalendar()')}</div>
      <div class="flex flex-wrap gap-2">
        <label><span>Country</span><select onchange="CMP_REP.calCountry = this.value; cmpLoadCalendar()">${cmpCountryOptions('', 'All countries')}</select></label>
        <label><span>Assigned to</span><select id="cmCalWho" onchange="CMP_REP.calAssignee = this.value; cmpLoadCalendar()"></select></label></div></div>
    <div class="grid grid-cols-7 text-xs text-slate-500 mb-1">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="px-1">${d}</div>`).join('')}</div>
    <div id="cmCalGrid" class="grid grid-cols-7 gap-px bg-slate-200 border border-slate-200 rounded-lg overflow-hidden"></div>
    <p class="text-xs text-slate-500 mt-2">Each due date in its client's own calendar. Green safe · amber approaching · red overdue · grey completed.</p></div>`,
  enter: () => { $('#cmCalWho').innerHTML = cmpTeamFilter(); $('#cmCalWho').value = CMP_REP.calAssignee; cmpLoadCalendar(); },
});
function cmpCalMove(n) {
  const [y, m] = (CMP_REP.month || CmpRules.dayIn(cmpTz()).slice(0, 7)).split('-').map(Number), idx = y * 12 + (m - 1) + n;
  CMP_REP.month = `${Math.floor(idx / 12)}-${String(idx % 12 + 1).padStart(2, '0')}`;
  cmpLoadCalendar();
}
async function cmpLoadCalendar() {
  const month = CMP_REP.month || CmpRules.dayIn(cmpTz()).slice(0, 7), first = month + '-01';
  const [y, m] = month.split('-').map(Number), days = new Date(Date.UTC(y, m, 0)).getUTCDate(), last = `${month}-${String(days).padStart(2, '0')}`;
  $('#cmCalTitle').textContent = `${CmpRules.MONTHS[m - 1]} ${y}`;
  let d;
  try { d = await api('/api/cmp/calendar?' + cmpQs({ from: first, to: last, country: CMP_REP.calCountry, assignee: CMP_REP.calAssignee })); } catch (err) { $('#cmCalGrid').innerHTML = cmpEmpty(esc(err.message)); return; }
  const byDay = new Map();
  for (const r of d.rows) { const k = r.dueDate; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(r); }
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7, today = CmpRules.dayIn(cmpTz()), cells = [];
  for (let i = 0; i < lead; i++) cells.push('<div class="bg-slate-50 min-h-[6rem]"></div>');
  for (let dd = 1; dd <= days; dd++) {
    const ymd = `${month}-${String(dd).padStart(2, '0')}`, items = byDay.get(ymd) || [];
    cells.push(`<div class="bg-white min-h-[6rem] p-1 ${ymd === today ? 'ring-2 ring-inset ring-emerald-500' : ''}"><div class="text-xs ${ymd === today ? 'font-bold text-emerald-700' : 'text-slate-500'}">${dd}</div>
      ${items.slice(0, 4).map(r => `<button type="button" onclick="cmpOpenPeriod('${r.obligation.id}', '${r.id}', cmpLoadCalendar)" title="${esc(`${r.client.name} — ${r.obligation.name} (${CmpRules.STATUS[r.view.status]})`)}"
        class="w-full text-left text-[11px] leading-tight truncate rounded px-1 py-0.5 mt-0.5 ${{ red: 'bg-red-100 text-red-800', amber: 'bg-amber-100 text-amber-900', green: 'bg-emerald-50 text-emerald-900', done: 'bg-slate-100 text-slate-500 line-through' }[r.view.colour]}">${cmpCountry(r.client.country).flag} ${esc(r.client.name)} · ${esc(r.obligation.name)}</button>`).join('')}
      ${items.length > 4 ? `<button type="button" class="text-[11px] text-emerald-700 underline" onclick="cmpObligationsFilter({ status: 'ALL' }); go('cm-obligations')">+${items.length - 4} more</button>` : ''}</div>`);
  }
  while (cells.length % 7) cells.push('<div class="bg-slate-50 min-h-[6rem]"></div>');
  $('#cmCalGrid').innerHTML = cells.join('');
}

/* ---------- reports ---------- */
CMP_PAGES.push({
  id: 'cm-reports',
  html: () => `<div class="bg-white rounded-xl shadow p-4">
    <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
      <div class="flex flex-wrap items-end gap-3"><div role="tablist" id="cmRepTabs" class="inline-flex bg-slate-100 rounded-xl p-1"></div>
        <label id="cmRepDaysWrap"><span>Window</span><select onchange="CMP_REP.repDays = Number(this.value); cmpLoadReport()">${[7, 30, 60, 90].map(n => `<option value="${n}" ${n === 30 ? 'selected' : ''}>Next ${n} days</option>`).join('')}</select></label></div>
      <div class="flex gap-2"><span id="cmRepExport"></span>${cmpBtn('Print / PDF', 'cmpPrintTable($("#cmRepTitle").textContent, "cmRepTable")')}</div></div>
    <h2 id="cmRepTitle" class="font-semibold mb-2"></h2><div id="cmRepBody"></div></div>`,
  enter: () => cmpLoadReport(),
});
async function cmpLoadReport() {
  const tabs = [['overdue', 'Overdue list'], ['upcoming', 'Upcoming deadlines'], ...(cmpCan('INVOICE') ? [['aging', 'Invoice aging']] : [])];
  if (!tabs.some(([k]) => k === CMP_REP.report)) CMP_REP.report = 'overdue';
  $('#cmRepTabs').innerHTML = tabs.map(([k, v]) => `<button type="button" class="seg-btn ${k === CMP_REP.report ? 'on' : ''}" onclick="CMP_REP.report = '${k}'; cmpLoadReport()">${v}</button>`).join('');
  $('#cmRepDaysWrap').classList.toggle('hidden', CMP_REP.report !== 'upcoming');
  const qs = CMP_REP.report === 'upcoming' ? `?days=${CMP_REP.repDays}` : '';
  $('#cmRepExport').innerHTML = cmpCan('EXPORT') ? cmpBtn('Download (Excel)', `cmpDownload('/api/cmp/export/${CMP_REP.report}${qs}', 'compliance-${CMP_REP.report}.csv')`) : '';
  let d;
  try { d = await api(`/api/cmp/reports/${CMP_REP.report}${qs}`); } catch (err) { $('#cmRepBody').innerHTML = cmpEmpty(esc(err.message)); return; }
  if (d.kind === 'aging') {
    $('#cmRepTitle').textContent = `Invoice aging — invoices not paid in full, by days since the invoice date (${CmpRules.fmtDay(d.today)})`;
    $('#cmRepBody').innerHTML = `<div class="overflow-x-auto mb-4"><table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-1">Currency</th>${d.buckets.map(b => `<th class="text-right">${b} days</th>`).join('')}<th class="text-right">Total</th></tr></thead><tbody>
      ${d.totals.map(t => `<tr class="border-b last:border-0 font-medium"><td class="py-1">${esc(t.currency)} <span class="text-xs text-slate-500">(${t.count})</span></td>${d.buckets.map(b => `<td class="text-right">${cmpMoney(t[b], t.currency)}</td>`).join('')}<td class="text-right">${cmpMoney(t.total, t.currency)}</td></tr>`).join('')
      || `<tr><td colspan="6">${cmpEmpty('Everything is paid.')}</td></tr>`}</tbody></table></div>
      <div class="overflow-x-auto"><table id="cmRepTable" class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-1">Invoice</th><th>Date</th><th>Client</th><th class="text-right">Age</th><th>Bucket</th><th class="text-right">Total</th><th class="text-right">Outstanding</th></tr></thead><tbody>
      ${d.rows.map(i => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer" onclick="cmpInvoiceOpen('${i.id}', cmpLoadReport)"><td class="py-1.5">${esc(i.number)}</td><td>${cmpDay(i.issueDate)}</td><td>${cmpCountry(i.client.country).flag} ${esc(i.client.name)}</td>
        <td class="text-right">${i.age}</td><td>${esc(i.bucket)}</td><td class="text-right">${cmpMoney(i.total, i.currency)}</td><td class="text-right font-medium">${cmpMoney(i.outstanding, i.currency)}</td></tr>`).join('')}</tbody></table></div>`;
    return;
  }
  $('#cmRepTitle').textContent = d.kind === 'overdue' ? `Overdue obligations (${d.rows.length})` : `Deadlines in the next ${d.days} days (${d.rows.length})`;
  $('#cmRepBody').innerHTML = cmpOccTable(d.rows, 'cmRepTable');
}
