'use strict';
/* Compliance & Deadlines: printing any list as a PDF (SRS 13), and the table of periods the lists share. The Dashboard and its calendar
   are in cmp-dashboard.js, the Reports page in cmp-report-catalog.js. */

const CMP_REP = { days: 30, month: null, day: null, calCountry: '', calAssignee: '', report: 'obligations', repDays: 30, repStatus: 'ALL' };
CMP_RESETS.push(() => Object.assign(CMP_REP, { days: 30, month: null, day: null, calCountry: '', calAssignee: '', report: 'obligations', repDays: 30, repStatus: 'ALL' }));

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
  ${rows.map(r => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer ${r.projected ? 'text-slate-500' : ''}" onclick="cmpOpenPeriod('${r.obligation.id}', '${r.id}', () => PAGE_ENTER[S.page] && PAGE_ENTER[S.page]())">
    <td class="py-1.5 w-5">${cmpOccDot(r)}</td><td class="whitespace-nowrap">${cmpDay(r.dueDate)}</td><td>${cmpCountry(r.client.country).flag} ${esc(r.client.name)}</td>
    <td>${esc(r.obligation.name)}</td><td class="whitespace-nowrap">${esc(CmpRules.periodName(r))}</td><td>${cmpOccChip(r)}</td>
    ${showDays ? `<td class="text-right ${r.view.overdue ? 'text-red-700 font-semibold' : ''}">${r.view.daysLeft}</td>` : ''}<td class="text-xs">${esc(cmpWho(r.assignedToId))}</td></tr>`).join('')
  || `<tr><td colspan="8">${cmpEmpty('Nothing here.')}</td></tr>`}</tbody></table></div>`;
