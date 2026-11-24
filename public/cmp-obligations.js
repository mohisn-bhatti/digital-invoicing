'use strict';
/* Compliance & Deadlines: obligations (SRS 4), their reminders (SRS 5) and their periods.
   The tracker (the CA, 16 Nov 2026): "My Obligations" (every client) and the client's page (that client) show the same table, one row per
   period of the dates chosen, in the CA's order of columns: due date, client, obligation, period, portal, the overall status (how many
   of its actions are done, e.g. 2/7), the 1st, 2nd and 3rd reminder (each its date and WhatsApp button: Due on its day, Pending after,
   Sent, Sent twice, …), the data collection, the task, the advance payment, the invoice created, the invoice issued (sent), the
   receipt, edit, archive, delete and remarks. Every action is done in its cell.
   An obligation is added (or edited) in one window: one row per obligation with its three dates and its three reminders, each a day and
   its own message (written in a second window that shows how it looks). It comes back every year on the same dates. */

const CMP_OB = { status: 'ALL', country: '', clientId: '', q: '', assignee: '', archived: false, timer: null, form: null, period: null, clients: null, saving: false };
CMP_RESETS.push(() => Object.assign(CMP_OB, { status: 'ALL', country: '', clientId: '', q: '', assignee: '', archived: false, form: null, period: null, clients: null, saving: false }));
const cmpObQuery = () => cmpQs({ status: CMP_OB.status, country: CMP_OB.country, clientId: CMP_OB.clientId, q: CMP_OB.q, assignee: CMP_OB.assignee, archived: CMP_OB.archived ? '1' : '', ...cmpRangeDates('ob') });

const CMP_OB_STATUSES = [['ALL', 'Everything'], ['OPEN', 'Open (not completed)'], ['OVERDUE', 'Overdue'], ['UPCOMING', 'Upcoming'], ['PERIOD_CLOSED', 'Period closed'], ['DATA_COLLECTED', 'Data collected'],
  ['FILED', 'Filed'], ['PAID', 'Paid'], ['COMPLETED', 'Completed'], ['CONFIRM', 'Dates to confirm'], ['PLANNED', 'Planned (still to come)']];
// From the dashboard or the notifications: a status over all dates (an overdue period of last year is still overdue)
function cmpObligationsFilter(over) {
  Object.assign(CMP_OB, over);
  if (over.status) { cmpRange('ob'); CMP.ranges.ob.r = { ...CMP.ranges.ob.r, mode: 'all' }; }
  const s = document.getElementById('cmObStatus'); if (s) s.value = CMP_OB.status;
}

/* ---------- the tracker: the same table on My Obligations and on the client's page ---------- */
const CMP_TRACK_COLS = ['Due date', 'Client name', 'Obligation', 'Period', 'Portal', 'Overall status', '1st reminder', '2nd reminder', '3rd reminder', 'Data collection', 'Task',
  'Advance payment', 'Invoice created', 'Invoice issued', 'Receipt', 'Edit', 'Archive', 'Delete', 'Remarks'];
// The first columns stay where they are while the others scroll sideways (the CA: the long bar was hard to use)
const cmpStick = (ticks, i) => (i > 2 ? '' : `md:sticky z-[5] ${['md:left-[2rem] w-[7.5rem] min-w-[7.5rem]', 'md:left-[9.5rem] w-[11rem] min-w-[11rem]', 'md:left-[20.5rem] w-[10rem] min-w-[10rem] md:shadow-[4px_0_4px_-4px_rgba(0,0,0,.15)]'][i].replace(/left-\[(\d+(?:\.\d+)?)rem\]/, (m, n) => `left-[${ticks ? n : Number(n) - 2}rem]`)}`);
const cmpTrackerHead = (ticks, { edit = true } = {}) => `<tr>${ticks ? '<th class="py-2 pl-1 w-8 md:sticky md:left-0 z-[6] bg-slate-50"><input type="checkbox" aria-label="Select all" onchange="cmpOccSelectAll(this)"></th>' : ''}${CMP_TRACK_COLS.filter(c => edit || c !== 'Edit').map((c, i) => `<th class="px-2 py-2 font-medium whitespace-nowrap bg-slate-50 sticky top-0 ${i < 3 ? `${cmpStick(ticks, i)} !z-[7]` : 'z-[4]'}">${c}</th>`).join('')}</tr>`;
// The tracker in a box of its own height: its sideways bar is always on the screen, the headings stay on top, and ◀ ▶ move across
const cmpTrackBox = (id, inner) => `<div class="flex flex-wrap items-center justify-between gap-2 mb-1"><div id="${id}Pager" class="flex flex-wrap items-center gap-2 text-xs text-slate-600"></div>
    <div class="flex items-center gap-1 text-xs text-slate-500">Columns ${cmpBtn('◀', `cmpScrollX('${id}Box', -1)`)}${cmpBtn('▶', `cmpScrollX('${id}Box', 1)`)}</div></div>
  <div id="${id}Box" class="overflow-auto border rounded-lg max-h-[calc(100vh-12rem)] min-h-[12rem]">${inner}</div>`;
function cmpScrollX(id, dir) { const el = document.getElementById(id); if (el) el.scrollBy({ left: dir * Math.max(300, el.clientWidth * 0.6), behavior: 'smooth' }); }
// Pages of 25, 50, 75, 100 or all (the CA: 25 by default), remembered on this computer
const cmpPageSize = () => { try { return localStorage.getItem('cmpPageSize') || '25'; } catch { return '25'; } };
const cmpPageLimit = () => (cmpPageSize() === 'all' ? 20000 : Number(cmpPageSize()) || 25);
function cmpPager(d, go) {
  const n = d.total, from = n ? d.offset + 1 : 0, to = Math.min(d.offset + d.rows.length, n), size = cmpPageSize();
  return `<label class="flex items-center gap-1">Show <select class="!w-auto !py-1 !text-xs" onchange="try { localStorage.setItem('cmpPageSize', this.value); } catch {} ${go}(0)">${['25', '50', '75', '100', 'all'].map(v => `<option value="${v}" ${v === size ? 'selected' : ''}>${v === 'all' ? 'All' : v}</option>`).join('')}</select></label>
    <span>${from}–${to} of ${n}</span>${cmpBtn('‹', `${go}(${Math.max(0, d.offset - cmpPageLimit())})`, 'plain', d.offset ? '' : 'opacity-40 pointer-events-none')}${cmpBtn('›', `${go}(${d.offset + cmpPageLimit()})`, 'plain', to < n ? '' : 'opacity-40 pointer-events-none')}`;
}
const CMP_TONE = { wa: 'bg-[#25D366] text-white', due: 'bg-amber-500 text-white', pending: 'border border-amber-500 text-amber-900 bg-amber-50', plain: 'border bg-white hover:border-emerald-600',
  danger: 'border border-red-300 text-red-700 bg-white hover:bg-red-50', ok: 'border border-emerald-300 text-emerald-800 bg-emerald-50' };
const cmpB = (label, onclick, tone = 'plain', title = '') => `<button type="button" class="needs-write px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap ${CMP_TONE[tone]}" ${title ? `title="${esc(title)}"` : ''} onclick="event.stopPropagation(); ${onclick}">${label}</button>`;
const cmpLink = (label, onclick, title = '') => `<button type="button" class="needs-write text-[11px] underline text-slate-600 hover:text-emerald-700 whitespace-nowrap" ${title ? `title="${esc(title)}"` : ''} onclick="event.stopPropagation(); ${onclick}">${label}</button>`;
const cmpOkChip = (text, title = '') => `<span class="inline-block px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-100 text-emerald-800 whitespace-nowrap" ${title ? `title="${esc(title)}"` : ''}>${text}</span>`;
const CMP_DASH = '<span class="text-slate-300">—</span>';
const CMP_PLANNED_CHIP = '<span class="px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap border border-dashed border-slate-400 text-slate-500">Planned</span>';
const cmpOccChip = r => (r.projected ? CMP_PLANNED_CHIP : cmpStatusChip(r.view.status));
const cmpOccDot = r => (r.projected ? '<span class="inline-block w-2.5 h-2.5 rounded-full border border-dashed border-slate-400" title="Planned"></span>' : cmpDot(r.view.colour));
const cmpLive = r => !r.obligation.archivedAt && !r.client.archivedAt;
const cmpCurOf = cc => (CmpCountries.get(cc) || {}).currency || 'USD';

function cmpTrkReminder(r, i, refresh) {
  if (r.projected) { const p = (r.reminderPlan || [])[i]; return p ? `<span class="text-slate-400 whitespace-nowrap">${cmpDay(p.date)}</span>` : CMP_DASH; }
  const x = r.view.reminders[i]; if (!x) return CMP_DASH;
  const day = `<div class="text-[11px] text-slate-500 whitespace-nowrap">${cmpDay(x.date)}</div>`, live = cmpLive(r);
  const noWa = r.client.noWhatsApp, canSend = live && (noWa ? cmpCan('WHATSAPP', 'COMPLETE') : cmpCan('WHATSAPP'));
  const go = noWa ? `cmpRemindedForm('${r.id}', '${x.id}', '${refresh}')` : `cmpWhatsApp({ kind: 'REMINDER', occurrenceId: '${r.id}', reminderId: '${x.id}' }, ${refresh})`;
  const tip = `${CmpRules.offsetLabel(x.offsetDays)} · ${x.templateName || 'message'}${noWa ? ' · no WhatsApp: mark it given by phone or email' : ''}`;
  if (x.button === 'WAIT') return `<span class="text-slate-500 whitespace-nowrap" title="${esc(tip)} · becomes due on this day">${cmpDay(x.date)}</span>`;
  if (x.button === 'CLOSED') return `${day}<span class="text-[11px] text-slate-400" title="The task was done before this reminder's day">not needed</span>`;
  if (x.button === 'SENT') {
    return `${day}<div class="flex flex-wrap items-center gap-1">${cmpOkChip(`✓ ${CmpRules.sentTimes(x.sentCount || 1)}`, x.sentAt ? `Last ${cmpAt(x.sentAt)}` : '')}</div>
      ${canSend ? `<div class="flex gap-2 mt-0.5">${cmpLink('Send again', go, tip)}${cmpCan('WHATSAPP') ? cmpLink('↶', `cmpTrkUnsend({ occurrenceId: '${r.id}', reminderId: '${x.id}' }, ${refresh})`, 'One send did not go: take it off the count') : ''}</div>` : ''}`;
  }
  const label = `${noWa ? '✓' : CMP_WA_ICON} ${x.button === 'DUE' ? 'Due' : 'Pending'}`;
  return day + (canSend ? cmpB(label, go, x.button === 'DUE' ? 'due' : 'pending', tip) : `<span class="text-amber-800 font-medium">${x.button === 'DUE' ? 'Due' : 'Pending'}</span>`);
}
function cmpTrkData(r, refresh) {
  if (r.projected) return CMP_DASH;
  const can = cmpLive(r) && cmpCan('COMPLETE');
  if (r.dataCollectedOn) return `${cmpOkChip(`✓ ${cmpDay(r.dataCollectedOn)}`, r.dataCollectedBy ? `by ${r.dataCollectedBy}` : '')}${cmpTrkNote(r, 'dataNote', refresh, can)}${can && r.stage !== 'COMPLETED' ? `<div>${cmpLink('↶ undo', `cmpTrkDataUndo('${r.id}', ${refresh})`)}</div>` : ''}`;
  return can ? cmpB('Pending', `cmpTrkDataAsk('${r.id}', '${r.client.timeZone}', ${refresh})`, 'pending', 'Click when the data is collected: choose the day') : '<span class="text-amber-800">Pending</span>';
}
// The note with the data collection or the task: shown under it, changed with ✎
const cmpTrkNote = (r, key, refresh, can) => (r[key] ? `<div class="text-[11px] text-slate-600 mt-0.5 line-clamp-2 max-w-[9rem]" title="${esc(r[key])}">📝 ${esc(r[key])}</div>` : '')
  + (can ? `<div>${cmpLink(r[key] ? '✎ note' : '+ note', `cmpTrkNoteEdit('${r.id}', '${key}', ${refresh})`)}</div>` : '');
function cmpTrkTask(r, refresh) {
  if (r.projected) return CMP_DASH;
  const can = cmpLive(r) && cmpCan('COMPLETE');
  if (r.stage === 'COMPLETED') return `${cmpOkChip(`✓ ${cmpDay(r.completedOn || r.closedAt)}`, r.closedBy ? `by ${r.closedBy}` : '')}${cmpTrkNote(r, 'taskNote', refresh, can)}${can ? `<div>${cmpLink('↶ reopen', `cmpTrkReopen('${r.id}', ${refresh})`)}</div>` : ''}`;
  if (!r.dataCollectedOn) return '<span class="text-slate-400" title="The task is completed only once the data is collected">Pending</span>';
  return can ? cmpB('Pending', `cmpTrkTaskAsk('${r.id}', '${r.dataCollectedOn}', '${r.client.timeZone}', ${refresh})`, 'pending', 'Click when the task is done: choose the day') : '<span class="text-amber-800">Pending</span>';
}
function cmpTrkAdvance(r, refresh) {
  if (r.projected || !cmpCan('INVOICE')) return CMP_DASH;
  const sums = {}, used = {};
  for (const a of r.advances || []) { sums[a.currency] = (sums[a.currency] || 0) + a.amount; used[a.currency] = (used[a.currency] || 0) + a.used; }
  const list = Object.entries(sums).map(([c, n]) => cmpMoney(n, c) + (used[c] ? `<span class="block text-[11px] font-normal text-slate-500 no-underline">${cmpMoney(used[c], c)} adjusted</span>` : '')).join('');
  return `${list ? `<button type="button" class="text-xs font-medium text-sky-800 underline whitespace-nowrap" onclick="cmpTrkAdvances('${r.id}', ${refresh})">${list}</button>` : ''}
    ${cmpLive(r) ? `<div class="${list ? 'mt-0.5' : ''}">${list ? cmpLink('+ add', `cmpAdvanceForm({ occurrenceId: '${r.id}', clientId: '${r.client.id}', country: '${r.client.country}' }, ${refresh})`) : cmpB('+ Add', `cmpAdvanceForm({ occurrenceId: '${r.id}', clientId: '${r.client.id}', country: '${r.client.country}' }, ${refresh})`)}</div>` : ''}`;
}
function cmpTrkInvoice(r, refresh) {
  if (r.projected || !cmpCan('INVOICE')) return CMP_DASH;
  const inv = r.invoice, live = cmpLive(r);
  const amt = inv ? `<div class="text-[11px] text-slate-600 whitespace-nowrap">${cmpMoney(inv.total, inv.currency)}${inv.advanceAdjusted ? ` · net ${cmpMoney(inv.total - inv.advanceAdjusted, inv.currency)}` : ''}</div>` : '';
  if (inv && inv.number) return `<button type="button" class="text-xs font-medium text-emerald-800 hover:underline whitespace-nowrap" onclick="cmpInvoiceOpen('${inv.id}', ${refresh})">✓ ${esc(inv.number)}</button>${amt}`;
  if (inv) return cmpB('Draft', `cmpInvoiceEdit('${inv.id}', ${refresh})`, 'pending', 'A draft invoice: open it to enter the fee and issue it') + amt;
  if (r.stage !== 'COMPLETED') return '<span class="text-slate-400" title="Pending once the task is completed">—</span>';
  if (r.closeKind === 'FREE') return `<span class="text-xs text-slate-500">No invoice</span>${live ? `<div>${cmpLink('↶ undo', `cmpTrkBilling('${r.id}', '', ${refresh})`)}</div>` : ''}`;
  return live ? `${cmpB('Pending · Create', `cmpInvoiceDraft({ occurrenceId: '${r.id}' }, ${refresh})`, 'pending', 'Make the invoice for this period')}<div>${cmpLink('no invoice', `cmpTrkBilling('${r.id}', 'FREE', ${refresh})`, 'Free work (family, friends, goodwill): no invoice')}</div>` : '<span class="text-amber-800">Pending</span>';
}
function cmpTrkIssued(r, refresh) {
  const inv = r.invoice;
  if (r.projected || !inv || !inv.number) return CMP_DASH;
  const live = cmpLive(r), wa = cmpCan('WHATSAPP') && !r.client.noWhatsApp && live, send = `cmpTrkSend({ kind: 'INVOICE', invoiceId: '${inv.id}' }, ${refresh})`;
  const net = `<div class="text-[11px] text-slate-600 whitespace-nowrap">${cmpMoney(inv.total - (inv.advanceAdjusted || 0), inv.currency)}</div>`;
  if (inv.sentCount > 0 || inv.sentAt) {
    const chip = inv.sentCount ? cmpOkChip(`✓ ${CmpRules.sentTimes(inv.sentCount)}`) : cmpOkChip('✓ Marked sent');
    return `${chip}${net}<div class="flex gap-2 mt-0.5">${wa ? cmpLink('Send again', send) : ''}${cmpCan('INVOICE', 'WHATSAPP') && live ? cmpLink('↶', inv.sentCount ? `cmpTrkUnsend({ invoiceId: '${inv.id}' }, ${refresh})` : `cmpTrkUnsent('${inv.id}', ${refresh})`, 'Not sent after all: take one off') : ''}</div>`;
  }
  return `${wa ? cmpB(`${CMP_WA_ICON} Pending`, send, 'pending', 'Send the invoice on WhatsApp') : '<span class="text-amber-800">Pending</span>'}${net}${live && cmpCan('INVOICE') ? `<div>${cmpLink('mark sent', `cmpTrkMarkSent('${inv.id}', ${refresh})`, 'Given to the client another way')}</div>` : ''}`;
}
function cmpTrkReceipt(r, refresh) {
  const inv = r.invoice;
  if (r.projected || !inv || !inv.number || !cmpCan('INVOICE')) return CMP_DASH;
  const sent = inv.sentCount > 0 || inv.sentAt || inv.receipts.length || ['PARTIAL', 'RECEIVED'].includes(inv.status);
  if (!sent) return '<span class="text-slate-400" title="Pending once the invoice is sent">—</span>';
  const live = cmpLive(r), last = inv.receipts[inv.receipts.length - 1], out = [];
  if (inv.status === 'RECEIVED') out.push(cmpOkChip(inv.receipts.length ? '✓ Received' : '✓ Paid by advance'), inv.received ? `<div class="text-[11px] text-slate-600 whitespace-nowrap">${cmpMoney(inv.received, inv.currency)}</div>` : '');
  else if (inv.receipts.length) out.push(`<span class="text-xs text-amber-800 whitespace-nowrap">${cmpMoney(inv.received, inv.currency)} received</span><div class="text-[11px] text-slate-600 whitespace-nowrap">${cmpMoney(inv.outstanding, inv.currency)} still due</div>`);
  else out.push(`<span class="text-xs text-amber-800 font-medium">Pending</span><div class="text-[11px] text-slate-600 whitespace-nowrap">${cmpMoney(inv.outstanding, inv.currency)} due</div>`);
  if (last && cmpCan('WHATSAPP') && !r.client.noWhatsApp && live) {
    const send = `cmpTrkSend({ kind: 'RECEIPT', receiptId: '${last.id}' }, ${refresh})`;
    out.push(last.sentCount ? `<div class="flex flex-wrap gap-2 items-center mt-0.5"><span class="text-[11px] text-emerald-800">${esc(last.number)} ${esc(CmpRules.sentTimes(last.sentCount).toLowerCase())}</span>${cmpLink('Send again', send)}${cmpLink('↶', `cmpTrkUnsend({ receiptId: '${last.id}' }, ${refresh})`, 'Not sent after all: take one off')}</div>`
      : `<div class="mt-0.5">${cmpB(`${CMP_WA_ICON} Send ${esc(last.number)}`, send, 'wa')}</div>`);
  }
  if (inv.status !== 'RECEIVED' && live) out.push(`<div class="mt-0.5">${cmpB('+ Receipt', `cmpQuickReceipt('${inv.id}', ${refresh})`, 'plain', 'Record the money received')}</div>`);
  return out.join('');
}
const CMP_ROWS = new Map(); // the rows drawn last, by period id (what their cells' windows start from)
function cmpTrackerRow(r, refresh, { ticks = false, edit: withEdit = true } = {}) {
  const live = cmpLive(r), ob = r.obligation, p = r.progress, locked = Boolean(ob.locked);
  CMP_ROWS.set(r.id, r);
  const edit = r.projected ? `cmpObligationForm('${r.client.id}', '${ob.id}', { seq: ${r.seq} })` : `cmpObligationForm('${r.client.id}', '${ob.id}', { occurrenceId: '${r.id}' })`;
  const bg = r.projected ? 'bg-slate-50' : 'bg-white';
  let col = 0;
  const td = (html, cls = '') => `<td class="px-2 py-2 align-top ${col < 3 ? `${cmpStick(ticks, col)} ${bg}` : ''} ${cls}">${(col++, html)}</td>`;
  const lockNote = 'Locked: unlock it in the obligations window (✎ Edit) first';
  return `<tr class="border-b last:border-0 hover:bg-slate-50/70 text-xs ${r.projected ? 'text-slate-500 bg-slate-50' : ''}">
    ${ticks ? `<td class="py-2 pl-1 align-top md:sticky md:left-0 z-[5] ${bg}">${r.projected ? '' : `<input type="checkbox" class="cmSel" data-id="${r.id}" data-ob="${ob.id}" data-client="${r.client.id}" ${CMP_SEL.occ.has(r.id) ? 'checked' : ''} onchange="cmpOccSelect(this, '${r.id}', '${ob.id}', '${r.client.id}')" aria-label="Select">`}</td>` : ''}
    ${td(`<div class="flex items-start gap-1.5"><span class="mt-1">${cmpOccDot(r)}</span><div><div class="text-sm whitespace-nowrap">${cmpDay(r.dueDate)}</div><div class="${r.view.overdue ? 'text-red-700' : 'text-slate-500'} whitespace-nowrap">${r.projected ? 'planned' : cmpDaysLeft(r.view)}</div></div></div>`)}
    ${td(`<a href="#" class="text-sm hover:underline" title="Show only this client" onclick="event.preventDefault(); ${ticks ? `cmpObOnly('${r.client.id}')` : `cmpOpenClient('${r.client.id}')`}">${cmpCountry(r.client.country).flag} ${esc(r.client.name)}</a> <span class="text-slate-500">${esc(r.client.code)}</span>`, 'min-w-[10rem]')}
    ${td(`<button type="button" class="text-sm text-left hover:underline hover:text-emerald-800" onclick="${cmpCan('OBLIGATION_EDIT') && live ? edit : `cmpOpenPeriod('${ob.id}', '${r.id}', ${refresh})`}">${esc(ob.name)}</button>${locked ? ' <span title="Locked against changes" class="text-[11px]">🔒</span>' : ''}${r.datesConfirmed || r.projected ? '' : `<div>${cmpCan('OBLIGATION_EDIT') && live ? cmpLink('dates to confirm ✓', `cmpTrkConfirm('${r.id}', ${refresh})`, 'Copied from the period before: click if they are right') : '<span class="text-sky-700">dates to confirm</span>'}</div>`}`, 'min-w-[9rem]')}
    ${td(esc(CmpRules.periodName(r)), 'whitespace-nowrap')}
    ${td(ob.portalUrl ? `<a href="${esc(ob.portalUrl)}" target="_blank" rel="noopener noreferrer" class="text-emerald-700 underline whitespace-nowrap">Open ↗</a>` : CMP_DASH)}
    ${td(r.projected ? CMP_PLANNED_CHIP : `<div class="font-semibold text-sm" title="${p.done} of ${p.total} actions done">${p.done}/${p.total}</div><div class="h-1.5 w-14 bg-slate-200 rounded-full mt-0.5"><div class="h-1.5 rounded-full ${p.done === p.total ? 'bg-emerald-600' : 'bg-amber-500'}" style="width:${p.total ? Math.round(100 * p.done / p.total) : 0}%"></div></div><div class="mt-1">${cmpStatusChip(r.view.status)}</div>`)}
    ${[0, 1, 2].map(i => td(cmpTrkReminder(r, i, refresh), 'min-w-[6.5rem]')).join('')}
    ${td(cmpTrkData(r, refresh), 'min-w-[6rem]')}${td(cmpTrkTask(r, refresh), 'min-w-[6rem]')}${td(cmpTrkAdvance(r, refresh), 'min-w-[6rem]')}
    ${td(cmpTrkInvoice(r, refresh), 'min-w-[7rem]')}${td(cmpTrkIssued(r, refresh), 'min-w-[7rem]')}${td(cmpTrkReceipt(r, refresh), 'min-w-[7.5rem]')}
    ${withEdit ? td(live && cmpCan('OBLIGATION_EDIT') ? cmpB('✎ Edit', edit, 'plain', 'All the obligations of this client, to change at once') : CMP_DASH) : ''}
    ${td(cmpCan('ARCHIVE') && !r.client.archivedAt ? (locked && !ob.archivedAt ? `<span class="text-slate-400" title="${lockNote}">🔒</span>` : cmpB(ob.archivedAt ? 'Restore' : 'Archive', `cmpObligationArchive('${ob.id}', ${!ob.archivedAt}, ${refresh})`, ob.archivedAt ? 'plain' : 'danger')) : CMP_DASH)}
    ${td(cmpCan('ARCHIVE') ? (locked ? `<span class="text-slate-400" title="${lockNote}">🔒</span>` : cmpB('Delete', `cmpObligationDelete('${ob.id}', ${refresh})`, 'danger')) : CMP_DASH)}
    ${td(r.projected ? CMP_DASH : `<button type="button" class="text-left text-xs ${r.notes ? 'text-slate-700' : 'text-slate-400'} hover:text-emerald-800 line-clamp-3 max-w-[12rem]" title="${esc(r.notes || 'Add a remark')}" ${live && cmpCan('OBLIGATION_EDIT') ? `onclick="cmpTrkRemarks('${r.id}', ${refresh})"` : 'disabled'}>${r.notes ? esc(r.notes) : '+ remark'}</button>`, 'min-w-[8rem]')}</tr>`;
}

/* ---------- the tracker's actions ---------- */
const cmpRun = async (fn, msg, refresh) => { try { await fn(); if (msg) toast(msg, true); } catch (err) { toast(err.message); } if (typeof refresh === 'function') refresh(); };
function cmpTrkDataAsk(occId, tz, refresh) {
  cmpAskDate('Data collected', 'The day the client\'s data came in.', { max: CmpRules.dayIn(tz), withNote: true }, (d, note) => cmpRun(() => api(`/api/cmp/occurrences/${occId}/data`, { method: 'POST', body: { on: d, note } }), 'Data collection marked', refresh));
}
function cmpTrkNoteEdit(occId, key, refresh) {
  const r = CMP_ROWS.get(occId) || {};
  CMP_OB.noteEdit = { occId, key, refresh };
  cmpShowSub(`${cmpSubHead(key === 'dataNote' ? 'Note · data collection' : 'Note · task')}
    <div class="space-y-3"><textarea id="cmTrkNote" rows="3" maxlength="1000">${esc(r[key] || '')}</textarea>
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseSub()')}${cmpBtn('Save', 'cmpTrkNoteSave()', 'primary', 'needs-write')}</div></div>`);
}
function cmpTrkNoteSave() {
  const { occId, key, refresh } = CMP_OB.noteEdit, v = $('#cmTrkNote').value;
  cmpCloseSub();
  cmpRun(() => api(`/api/cmp/occurrences/${occId}`, { method: 'PUT', body: { [key]: v } }), 'Note saved', refresh);
}
function cmpTrkDataUndo(occId, refresh) {
  if (!confirm('Mark the data collection as pending again?')) return;
  cmpRun(() => api(`/api/cmp/occurrences/${occId}/data`, { method: 'POST', body: { on: null } }), 'Data collection pending again', refresh);
}
function cmpTrkTaskAsk(occId, dataOn, tz, refresh) {
  cmpAskDate('Task completed', `The day the work was done (the data came in on ${cmpDay(dataOn)}). The invoice comes next.`, { max: CmpRules.dayIn(tz), okLabel: 'Mark completed', withNote: true },
    (d, note) => cmpRun(() => api(`/api/cmp/occurrences/${occId}/complete`, { method: 'POST', body: { mode: 'TASK', on: d, note } }), 'Task completed', refresh));
}
function cmpTrkReopen(occId, refresh) {
  if (!confirm('Reopen this task? It is no longer completed.')) return;
  cmpRun(() => api(`/api/cmp/occurrences/${occId}/reopen`, { method: 'POST' }), 'Reopened', refresh);
}
function cmpTrkBilling(occId, mode, refresh) {
  if (mode === 'FREE' && !confirm('No invoice for this period (free work for family, friends or goodwill)?')) return;
  cmpRun(() => api(`/api/cmp/occurrences/${occId}/billing`, { method: 'POST', body: { mode } }), mode === 'FREE' ? 'Marked: no invoice' : 'An invoice is to be made', refresh);
}
const cmpTrkConfirm = (occId, refresh) => cmpRun(() => api(`/api/cmp/occurrences/${occId}`, { method: 'PUT', body: { confirm: true } }), 'Dates confirmed', refresh);
// what = { invoiceId } or { receiptId } (with kind): the WhatsApp window with the firm's invoice or receipt template
async function cmpTrkSend(what, refresh) {
  let t = [];
  try { t = await cmpTemplates(true); } catch { /* the message starts empty */ }
  const pref = t.find(x => x.purpose === what.kind);
  cmpWhatsApp({ ...what, templateId: pref ? pref.id : undefined }, refresh);
}
// one send that did not go taken off the count (the CA: the number of sends is adjusted by hand)
function cmpTrkUnsend(what, refresh) {
  if (!confirm('Take the last send off? It is marked "not sent" in the WhatsApp log.')) return;
  cmpRun(() => api('/api/cmp/messages/void-last', { method: 'POST', body: what }), 'Marked as not sent', refresh);
}
const cmpTrkMarkSent = (invId, refresh) => cmpRun(() => api(`/api/cmp/invoices/${invId}/sent`, { method: 'POST' }), 'Marked as sent', refresh);
const cmpTrkUnsent = (invId, refresh) => cmpRun(() => api(`/api/cmp/invoices/${invId}/unsent`, { method: 'POST' }), 'Marked as not sent', refresh);
function cmpTrkRemarks(occId, refresh) {
  const notes = (CMP_ROWS.get(occId) || {}).notes || '';
  CMP_OB.remarks = { occId, refresh };
  cmpShowSub(`${cmpSubHead('Remarks', 'Notes on this period, for the team.')}
    <div class="space-y-3"><textarea id="cmRemarks" rows="4" maxlength="1000">${esc(notes)}</textarea>
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseSub()')}${cmpBtn('Save', 'cmpTrkRemarksSave()', 'primary', 'needs-write')}</div></div>`);
}
function cmpTrkRemarksSave() {
  const { occId, refresh } = CMP_OB.remarks, notes = $('#cmRemarks').value;
  cmpCloseSub();
  cmpRun(() => api(`/api/cmp/occurrences/${occId}`, { method: 'PUT', body: { notes } }), 'Remarks saved', refresh);
}
// advance payments of a period (the CA): the date, a description (the ones typed before are suggested) and the amount, typed by hand
async function cmpAdvanceForm(at, refresh) {
  let words = [];
  try { words = await api('/api/cmp/advances/descriptions'); } catch { /* none suggested */ }
  CMP_OB.advance = { at, refresh };
  const cur = cmpCurOf(at.country);
  cmpShowSub(`${cmpSubHead('Advance payment', 'Money received before the invoice. It is taken off the invoice later: gross amount, advance adjusted, net amount.')}
    <form id="cmAdvForm" onsubmit="event.preventDefault(); cmpAdvanceSave()" class="space-y-3">
      <div class="grid grid-cols-2 gap-3"><label><span>Received on</span><input name="receivedOn" type="date" required value="${CmpRules.dayIn(cmpTz())}"></label>
        <label><span>Currency</span><select name="currency">${CmpCountries.currencies.map(c => `<option value="${c.code}" ${c.code === cur ? 'selected' : ''}>${c.code}</option>`).join('')}</select></label></div>
      <label><span>Description</span><input name="description" required maxlength="200" list="cmAdvWords" autocomplete="off" placeholder="e.g. Advance for VAT return Q1"><datalist id="cmAdvWords">${words.map(w => `<option value="${esc(w)}"></option>`).join('')}</datalist></label>
      <div class="grid grid-cols-2 gap-3"><label><span>Amount</span><input name="amount" required inputmode="decimal" placeholder="0.00"></label>
        <label><span>Paid by</span><select name="method">${Object.entries(CMP_METHODS).filter(([k]) => k !== 'CREDIT').map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label></div>
      <label><span>Reference <span class="text-slate-400">(cheque or transfer no., optional)</span></span><input name="reference" maxlength="120"></label>
      <p class="text-xs text-slate-500">It gets its own receipt number (the client's advance payment receipt), to print or send on WhatsApp.</p>
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseSub()')}<button class="needs-write px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">Save advance</button></div></form>`);
}
async function cmpAdvanceSave() {
  const { at, refresh } = CMP_OB.advance, f = $('#cmAdvForm');
  try {
    const a = await api('/api/cmp/advances', { method: 'POST', body: { occurrenceId: at.occurrenceId || undefined, clientId: at.clientId, receivedOn: f.receivedOn.value, currency: f.currency.value, description: f.description.value, amount: f.amount.value, method: f.method.value, reference: f.reference.value } });
    cmpCloseSub(); toast(`Advance ${a.number} of ${cmpMoney(a.amount, a.currency)} saved`, true);
    if (typeof refresh === 'function') refresh(a);
  } catch (err) { toast(err.message); }
}
async function cmpTrkAdvances(occId, refresh) {
  let list = [];
  try { list = await api('/api/cmp/advances?occurrenceId=' + occId); } catch (err) { return toast(err.message); }
  // (and the ones taken off this period's invoice, recorded from the invoice)
  const more = ((CMP_ROWS.get(occId) || {}).advances || []).filter(a => !list.some(x => x.id === a.id));
  if (more.length) { try { const all = await api('/api/cmp/advances?clientId=' + (CMP_ROWS.get(occId) || {}).client.id); list = [...list, ...all.filter(a => more.some(m => m.id === a.id))]; } catch { /* the period's own */ } }
  CMP_OB.advList = { occId, refresh }; CMP_OB.advCache = list;
  cmpShowSub(`${cmpSubHead('Advance payments', 'Received for this period. Taken off its invoice: gross amount, advance adjusted, net amount.')}
    ${list.length ? `<table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-1">Receipt</th><th>Date</th><th>Description</th><th class="text-right">Amount</th><th class="text-right">Adjusted</th><th></th></tr></thead><tbody>
      ${list.map(a => `<tr class="border-b last:border-0"><td class="py-1.5 whitespace-nowrap">${esc(a.number || '')}</td><td class="whitespace-nowrap">${cmpDay(a.receivedOn)}</td><td>${esc(a.description)}</td><td class="text-right whitespace-nowrap">${cmpMoney(a.amount, a.currency)}</td>
        <td class="text-right whitespace-nowrap">${cmpMoney(a.used, a.currency)}</td><td class="text-right whitespace-nowrap space-x-1">${cmpLink('Print', `cmpAdvancePrint('${a.id}')`)} ${cmpCan('WHATSAPP') ? cmpLink('WhatsApp', `cmpCloseSub(); cmpWhatsApp({ kind: 'ADVANCE', advanceId: '${a.id}' }, CMP_OB.advList.refresh)`) : ''} ${cmpLink('✎ change', `cmpAdvanceEdit('${a.id}', () => cmpTrkAdvances('${occId}', CMP_OB.advList.refresh).then(() => { if (typeof CMP_OB.advList.refresh === 'function') CMP_OB.advList.refresh(); }))`)} ${a.used > 0 ? '' : cmpLink('↶ undo', `cmpAdvanceVoid('${a.id}')`)}</td></tr>`).join('')}</tbody></table>` : cmpEmpty('None.')}
    <div class="flex justify-end mt-3">${cmpBtn('Close', 'cmpCloseSub()')}</div>`);
}
// An advance changed (the CA: editable): its date, description and amount (never less than what is already taken off an invoice)
function cmpAdvanceEdit(id, after) {
  const a = [...(CMP_OB.advCache || []), ...((CMP_INV.edit && CMP_INV.edit.advances) || []), ...((typeof CMP_ADV !== 'undefined' && CMP_ADV.rows) || [])].find(x => x.id === id); if (!a) return toast('Reload the page and try again.');
  CMP_OB.advEdit = { id, after };
  cmpShowSub(`${cmpSubHead('Change the advance payment', a.used > 0 ? `${cmpMoney(a.used, a.currency)} of it is taken off an invoice: the amount cannot be less.` : '')}
    <form id="cmAdvEdit" onsubmit="event.preventDefault(); cmpAdvanceEditSave()" class="space-y-3">
      <div class="grid grid-cols-2 gap-3"><label><span>Received on</span><input name="receivedOn" type="date" required value="${esc(a.receivedOn)}"></label>
        <label><span>Amount (${esc(a.currency)})</span><input name="amount" required inputmode="decimal" value="${esc(String(a.amount))}"></label></div>
      <label><span>Description</span><input name="description" required maxlength="200" value="${esc(a.description)}"></label>
      <div class="grid grid-cols-2 gap-3"><label><span>Paid by</span><select name="method">${Object.entries(CMP_METHODS).filter(([k]) => k !== 'CREDIT').map(([k, v]) => `<option value="${k}" ${k === (a.method || 'BANK') ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label><span>Reference</span><input name="reference" maxlength="120" value="${esc(a.reference || '')}"></label></div>
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseSub()')}<button class="needs-write px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">Save</button></div></form>`);
}
async function cmpAdvanceEditSave() {
  const { id, after } = CMP_OB.advEdit, f = $('#cmAdvEdit');
  try { await api(`/api/cmp/advances/${id}`, { method: 'PUT', body: { receivedOn: f.receivedOn.value, amount: f.amount.value, description: f.description.value, method: f.method.value, reference: f.reference.value } }); cmpCloseSub(); toast('Advance changed', true); if (typeof after === 'function') after(); }
  catch (err) { toast(err.message); }
}
async function cmpAdvanceVoid(id) {
  const reason = prompt('Undo this advance payment? Why?', 'Entered by mistake'); if (!reason) return;
  const { occId, refresh } = CMP_OB.advList;
  try { await api(`/api/cmp/advances/${id}/void`, { method: 'POST', body: { reason } }); toast('Advance undone', true); if (typeof refresh === 'function') refresh(); cmpTrkAdvances(occId, refresh); } catch (err) { toast(err.message); }
}

/* ---------- My Obligations ---------- */
CMP_PAGES.push({
  id: 'cm-obligations',
  html: () => `<div class="bg-white rounded-xl shadow p-4">
    <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3 mb-3">
      <div id="cmObRange" class="contents"></div>
      <label><span>Status</span><select id="cmObStatus" onchange="CMP_OB.status = this.value; cmpLoadObligations()">${CMP_OB_STATUSES.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label><span>Client</span><select id="cmObClient" onchange="CMP_OB.clientId = this.value; cmpLoadObligations()"></select></label>
      <label><span>Country</span><select onchange="CMP_OB.country = this.value; cmpLoadObligations()">${cmpCountryOptions('', 'All countries')}</select></label>
      <label class="col-span-2 sm:flex-1 sm:min-w-[12rem]"><span>Search</span><input type="search" placeholder="Client, code or obligation" autocomplete="off"
        oninput="clearTimeout(CMP_OB.timer); CMP_OB.timer = setTimeout(() => { CMP_OB.q = this.value; cmpLoadObligations(); }, 350)"></label>
      <label><span>Assigned to</span><select id="cmObWho" onchange="CMP_OB.assignee = this.value; cmpLoadObligations()"></select></label>
      <label class="flex items-center gap-2 text-sm min-h-[2.5rem]"><input type="checkbox" onchange="CMP_OB.archived = this.checked; cmpLoadObligations()"> Archived</label>
      <div class="flex items-end gap-2"><span id="cmObExport"></span>${cmpBtn('Print / PDF', 'cmpPrintTable("My Obligations — " + cmpRangeText("ob"), "cmObTable")')}</div>
    </div>
    <div id="cmObBulk" class="hidden flex flex-wrap items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-2"></div>
    <div class="flex flex-wrap items-center justify-between gap-2 mb-2"><div id="cmObNote" class="text-xs text-slate-500"></div>
      <label class="flex items-center gap-2 text-xs text-slate-600" title="Off: ticking selects rows for the actions on several rows"><input type="checkbox" id="cmObTickMode" onchange="cmpTickMode(this.checked)"> Ticking a row shows only that client</label></div>
    ${cmpTrackBox('cmOb', `<table id="cmObTable" class="w-full text-sm min-w-[100rem] border-separate border-spacing-0">
      <thead class="text-left text-slate-500">${cmpTrackerHead(true)}</thead>
      <tbody id="cmObRows"></tbody></table>`)}</div>`,
  enter: async () => {
    const s = document.getElementById('cmObStatus'); if (s) s.value = CMP_OB.status;
    $('#cmObRange').innerHTML = cmpRangeBar('ob', cmpLoadObligations);
    $('#cmObTickMode').checked = cmpTickFilters();
    $('#cmObWho').innerHTML = cmpTeamFilter(); $('#cmObWho').value = CMP_OB.assignee;
    $('#cmObExport').innerHTML = cmpCan('EXPORT') ? cmpBtn('Download (Excel)', "cmpDownload('/api/cmp/export/obligations?' + cmpObQuery(), 'obligations.csv')") : '';
    await cmpObClients();
    cmpLoadObligations();
  },
});
// The client picker of the sheet (filled once; a client added later appears on the next visit)
async function cmpObClients() {
  if (!CMP_OB.clients) { try { CMP_OB.clients = (await api('/api/cmp/clients')).clients; } catch { CMP_OB.clients = []; } }
  const sel = document.getElementById('cmObClient'); if (!sel) return;
  sel.innerHTML = '<option value="">All clients</option>' + CMP_OB.clients.map(c => `<option value="${c.id}">${cmpCountry(c.country).flag} ${esc(c.name)} (${esc(c.code)})</option>`).join('');
  if (CMP_OB.clientId && !CMP_OB.clients.some(c => c.id === CMP_OB.clientId)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(CMP_OB.clientId)}">(${CMP_OB.clientId.split(',').length} clients ticked)</option>`);
  sel.value = CMP_OB.clientId;
}
// The two ways a tick works (the CA: keep both): show only that client at once, or select the row for the actions on several rows
const cmpTickFilters = () => { try { return localStorage.getItem('cmpTickFilter') === '1'; } catch { return false; } };
function cmpTickMode(on) { try { localStorage.setItem('cmpTickFilter', on ? '1' : '0'); } catch { /* for this visit only */ } CMP_SEL.occ.clear(); CMP_SEL.occClient.clear(); cmpLoadObligations(); }
// The sheet for one client (the CA: tick a client to see only that client, for the dates chosen)
function cmpObOnly(clientId) { CMP_OB.clientId = clientId; CMP_SEL.occ.clear(); cmpObClients(); cmpLoadObligations(); }

// offset: the page to show (another filter starts again at the first page)
async function cmpLoadObligations(offset) {
  const qs = cmpObQuery();
  if (typeof offset === 'number') CMP_OB.offset = offset; else if (qs !== CMP_OB.lastQs) CMP_OB.offset = 0;
  CMP_OB.lastQs = qs;
  let d;
  try { d = await api('/api/cmp/occurrences?' + qs + `&projected=1&offset=${CMP_OB.offset || 0}&limit=${cmpPageLimit()}`); } catch (err) { $('#cmObRows').innerHTML = `<tr><td colspan="20">${cmpEmpty(esc(err.message))}</td></tr>`; return; }
  if (d.rows.length === 0 && d.offset > 0) return cmpLoadObligations(0);
  $('#cmObPager').innerHTML = cmpPager(d, 'cmpLoadObligations');
  for (const id of [...CMP_SEL.occ.keys()]) if (!d.rows.some(r => r.id === id)) CMP_SEL.occ.delete(id); // (what is no longer shown is no longer selected)
  const real = d.total - (d.planned || 0);
  $('#cmObNote').innerHTML = `${esc(cmpRangeText('ob'))} · ${real} period${real === 1 ? '' : 's'}${d.planned ? ` and ${d.planned} planned (still to come)` : ''} · by due date, then client`
    + (CMP_OB.clientId ? ` · <button type="button" class="underline text-emerald-700" onclick="cmpObOnly('')">show all clients</button>` : '');
  $('#cmObRows').innerHTML = d.rows.map(r => cmpTrackerRow(r, 'cmpLoadObligations', { ticks: true })).join('')
    || `<tr><td colspan="20">${cmpEmpty(`Nothing for ${esc(cmpRangeText('ob'))}. Obligations are added from a client's page; choose other dates above to see other years.`)}</td></tr>`;
  cmpOccBar();
}

/* ---------- the client's obligations, all in one window (the CA, 20 Nov 2026): every obligation of the client on its own row — its name,
   its three dates, its 1st, 2nd and 3rd reminder (a day and its message), then its own settings (how many years, amber, by itself,
   portal, person, notes) and its lock — to change, add or delete at once. "+ Obligation", Edit on any row, a past, present or future
   period: all open this window, with that period's dates on the obligation's row. ---------- */
// (the CA, 24 Nov 2026: each reminder takes a template of its category — 1st, 2nd or 3rd reminder — chosen in a list, and the exact message
// for this client shows under the row; after the 3rd reminder: the advance payment, invoice and receipt templates. The messages are written
// only on Message Templates.)
const CMP_DOC_KINDS = [['ADVANCE', 'Advance payment template'], ['INVOICE', 'Invoice template'], ['RECEIPT', 'Receipt template']];
const CMP_OB_GRID = 'grid grid-cols-[minmax(11rem,1.6fr)_repeat(3,8.2rem)_repeat(3,10.5rem)_repeat(3,10rem)_5.5rem_4.5rem_3.5rem_minmax(10rem,1fr)_9rem_2.75rem_2.75rem_2rem] gap-2';
// The period an obligation's row shows: the one clicked, else the first not completed, else the next one still to come, else the last
function cmpObPeriodOf(ob, at = {}) {
  if (at.seq) { const d = CmpRules.projectPeriods(ob, at.seq, '2200-12-31', 1)[0]; if (d) return { ...d, planned: true }; }
  if (at.occurrenceId) { const p = ob.occurrences.find(o => o.id === at.occurrenceId); if (p) return p; }
  const open = ob.occurrences.find(o => o.stage !== 'COMPLETED'); if (open) return open;
  const last = ob.occurrences[ob.occurrences.length - 1];
  const next = CmpRules.projectPeriods(ob, (last ? last.seq : 0) + 1, '2200-12-31', 1)[0];
  return next ? { ...next, planned: true } : last;
}
// focusId / at: the obligation and period clicked; addRow: start with an empty row for a new one ("+ Obligation")
async function cmpObligationForm(clientId, focusId = null, at = {}, { addRow = !focusId } = {}) {
  let client, obs = [], templates = [], suggestions = [], ctx = null;
  try {
    const c = await api(`/api/cmp/clients/${clientId}`);
    client = c.client; obs = (c.obligations || []).filter(o => !o.archivedAt);
    [templates, suggestions, ctx] = await Promise.all([cmpTemplates(true), api('/api/cmp/suggest/obligations?country=' + client.country), api('/api/cmp/templates/context?clientId=' + client.id).catch(() => null)]);
  } catch (err) { return toast(err.message); }
  if (client.archivedAt) return toast('This client is archived. Restore it first.');
  CMP_OB.form = { clientId, client, templates, suggestions, ctx, rowSeq: 0, rows: new Map() };
  const country = cmpCountry(client.country), can = cmpCan('OBLIGATION_EDIT');
  const head = ['Obligation *', 'Period start *', 'Period end *', `Due date * <span class="text-slate-400 font-normal">(${esc(CmpCountries.zoneCity(client.timeZone))})</span>`, '1st reminder', '2nd reminder', '3rd reminder', ...CMP_DOC_KINDS.map(k => k[1]),
    '<span title="Empty = unlimited">How many years</span>', '<span title="Turns amber this many days before the due date">Amber days</span>', '<span title="Prepare the next period by itself when this one ends">By itself</span>', 'Portal link', 'Assigned to', 'Notes', 'Lock', ''];
  cmpShowModal(`${cmpModalHead(`Obligations of ${esc(client.name)}`, `${country.flag} ${esc(client.code)} · ${obs.length} obligation${obs.length === 1 ? '' : 's'}${can ? ' · change any of them, add new ones, or delete (✕); 🔒 keeps one from being changed by mistake' : ''}`)}
    <form id="cmObForm" onsubmit="event.preventDefault(); cmpObligationSave()" class="space-y-3">
      <datalist id="cmObNames">${suggestions.map(x => `<option value="${esc(x.name)}"></option>`).join('')}</datalist>
      <datalist id="cmObPortals">${[...new Set(suggestions.map(x => x.portalUrl).filter(Boolean))].map(u => `<option value="${esc(u)}"></option>`).join('')}</datalist>
      <div class="overflow-x-auto pb-2"><div class="min-w-[140rem]">
        <div class="${CMP_OB_GRID} text-xs font-medium text-slate-600 mb-1 sticky top-0 bg-white">${head.map((h, i) => `<span class="${i === 0 ? 'sticky left-0 bg-white z-10' : ''}">${h}</span>`).join('')}</div>
        <div id="cmObNew" class="space-y-2"></div></div></div>
      <div id="cmObHint"></div>
      <div class="flex flex-wrap items-center gap-4">${can ? '<button type="button" class="text-sm text-emerald-700 underline" onclick="cmpObRow()">+ Add another obligation</button>' : ''}
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="cmObFuture" checked> New dates also apply to the periods after the one shown</label></div>
      <p class="text-xs text-slate-500">Each obligation comes back <b>every year on the same dates</b> (type them by hand; for quarterly VAT add four, Q1 to Q4: "+ Add another" proposes the next quarter). Each row shows one period (the one you clicked, else the next one to do); its dates and reminder days apply from that period on. Reminders: choose the day and the template (only the templates of that reminder's category for ${esc(country.name)} clients are offered); the exact message for ${esc(client.name)} shows under the row. Messages are written on <a href="#/cm-templates" class="underline text-emerald-700" onclick="cmpCloseModal()">Message Templates</a>.</p>
      <div class="flex flex-wrap justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseModal()')}${can ? '<button id="cmObSave" class="needs-write px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">Save</button>' : ''}</div>
    </form>`, { xl: true });
  const sorted = obs.map(ob => ({ ob, p: cmpObPeriodOf(ob, ob.id === focusId ? at : {}) })).filter(x => x.p).sort((a, b) => (a.p.dueDate < b.p.dueDate ? -1 : a.p.dueDate > b.p.dueDate ? 1 : 0) || a.ob.name.localeCompare(b.ob.name));
  for (const { ob, p } of sorted) {
    const rems = [...ob.reminders].sort((a, b) => a.offsetDays - b.offsetDays);
    cmpObRow({ ob, period: p, name: ob.name, start: p.periodStart, end: p.periodEnd, due: p.dueDate, years: ob.yearsTotal, amber: ob.amberDays, auto: ob.autoNext, portal: ob.portalUrl, assigned: ob.assignedToId, notes: ob.notes, locked: ob.locked, focus: ob.id === focusId,
      extra: rems.slice(3), rems: rems.slice(0, 3).map(r => ({ date: CmpRules.addDays(p.dueDate, r.offsetDays), tpl: r.templateId || (r.own ? CMP_OWN : ''), link: r })),
      docs: Object.fromEntries(CMP_DOC_KINDS.map(([k]) => [k, (ob.docTemplates || {})[k] ? ob.docTemplates[k].templateId : ''])), docLinks: ob.docTemplates || {} });
  }
  if (addRow || !sorted.length) cmpObRow(null, { focus: true });
  const f = document.querySelector('#cmObNew .cmObRow.ring-2'); if (f) f.scrollIntoView({ block: 'nearest' });
}
const cmpObState = row => CMP_OB.form.rows.get(row.dataset.key);
// What a row says now (to see what changed, and what to send)
function cmpObRowValues(row) {
  const g = c => row.querySelector(c), st = cmpObState(row);
  return { name: g('.obName').value.trim(), start: g('.obStart').value, end: g('.obEnd').value, due: g('.obDue').value,
    rems: [...row.querySelectorAll('.cmRem')].map(c => ({ date: c.querySelector('.remDate').value, tpl: c.querySelector('.remTpl').value })),
    docs: Object.fromEntries([...row.querySelectorAll('.docTpl')].map(el => [el.dataset.kind, el.value])),
    years: g('.obYears').value.trim(), amber: g('.obAmber').value, auto: g('.obAuto').checked, portal: g('.obPortal').value.trim(), assigned: g('.obWho').value, notes: st.notes, locked: st.locked };
}
// One obligation's row. A new row with nothing given proposes the next one after the last row: the name with the next quarter (Q1 → Q2),
// the dates and the reminder days one period on, the same messages and settings, for the person to check.
function cmpObRow(v, { focus = false } = {}) {
  const rows = document.querySelectorAll('#cmObNew .cmObRow'), prev = rows[rows.length - 1], can = cmpCan('OBLIGATION_EDIT');
  if (!v) {
    v = { name: '', start: '', end: '', due: '', rems: [], docs: {}, years: null, amber: 7, auto: true, portal: '', assigned: '', notes: '', locked: false };
    if (prev && !focus) {
      const pv = cmpObRowValues(prev), m = pv.name.match(/^(.*\bQ)([1-4])\b(.*)$/i);
      v.name = m ? `${m[1]}${Number(m[2]) % 4 + 1}${m[3]}` : '';
      let k = 12;
      if (pv.start && pv.end && pv.due) {
        for (const n of [1, 3, 6]) if (CmpRules.addDays(CmpRules.shiftMonths(pv.start, n, false), -1) === pv.end) k = n;
        v.start = CmpRules.shiftMonths(pv.start, k, false); v.end = CmpRules.shiftMonths(pv.end, k, true); v.due = CmpRules.shiftMonths(pv.due, k, false);
      }
      v.rems = pv.rems.map(r => ({ date: r.date && v.due ? CmpRules.addDays(v.due, CmpRules.daysBetween(pv.due, r.date)) : '', tpl: r.tpl === CMP_OWN ? '' : r.tpl }));
      v.docs = { ...pv.docs };
      Object.assign(v, { years: pv.years ? Number(pv.years) : null, amber: pv.amber, auto: pv.auto, portal: pv.portal, assigned: pv.assigned });
    }
  }
  const key = String(++CMP_OB.form.rowSeq), ob = v.ob || null, p = v.period || null;
  const caption = ob ? `${p.planned ? 'planned' : p.stage === 'COMPLETED' ? 'completed' : 'period'} ${CmpRules.periodName(p)}` : 'new';
  $('#cmObNew').insertAdjacentHTML('beforeend', `<div class="cmObRow ${CMP_OB_GRID} items-start rounded-lg ${v.focus ? 'ring-2 ring-emerald-400' : ''} ${ob ? '' : 'bg-emerald-50/50'} p-1" data-key="${key}">
    <label class="sticky left-0 z-10 bg-white"><span class="sr-only">Obligation *</span><input class="obName" required maxlength="120" list="cmObNames" autocomplete="off" placeholder="e.g. VAT Return Q1" value="${esc(v.name)}" oninput="cmpObNameCheck(this); cmpObligationNameHint(this)">
      <span class="obCap block text-[10px] text-slate-500 mt-0.5">${esc(caption)}</span></label>
    <label><span class="sr-only">Period start *</span><input class="obStart" type="date" required value="${v.start || ''}"></label>
    <label><span class="sr-only">Period end *</span><input class="obEnd" type="date" required value="${v.end || ''}"></label>
    <label><span class="sr-only">Due date *</span><input class="obDue" type="date" required value="${v.due || ''}" data-prev="${v.due || ''}" onchange="cmpObDueMoved(this)"></label>
    ${[0, 1, 2].map(n => `<div class="cmRem space-y-1" data-n="${n}"><input class="remDate" type="date" aria-label="${CmpRules.ordinal(n + 1)} reminder" value="${(v.rems[n] && v.rems[n].date) || ''}" onchange="cmpRemDate(this)">
      <select class="remTpl text-xs" aria-label="${CmpRules.ordinal(n + 1)} reminder template" onchange="cmpObPreview(this)" onfocus="cmpObPreview(this)">${cmpTplOptions(`REMINDER_${n + 1}`, (v.rems[n] && v.rems[n].tpl) || '', v.rems[n] && v.rems[n].link)}</select>
      <div class="tplNote"></div></div>`).join('')}
    ${CMP_DOC_KINDS.map(([k, label]) => `<div class="cmDoc space-y-1" data-kind="${k}"><select class="docTpl text-xs" data-kind="${k}" aria-label="${esc(label)}" onchange="cmpObPreview(this)" onfocus="cmpObPreview(this)">${cmpTplOptions(k, (v.docs || {})[k] || '')}</select><div class="tplNote"></div></div>`).join('')}
    <label><span class="sr-only">How many years</span><input class="obYears" type="number" min="1" max="100" placeholder="∞" title="Empty = unlimited" value="${v.years || ''}"></label>
    <label><span class="sr-only">Amber days</span><input class="obAmber" type="number" min="0" max="90" value="${v.amber ?? 7}"></label>
    <label class="flex justify-center min-h-[2.5rem] items-center" title="Prepare the next period by itself when this one ends"><input class="obAuto" type="checkbox" ${v.auto !== false ? 'checked' : ''}></label>
    <label><span class="sr-only">Portal link</span><input class="obPortal" type="url" maxlength="500" placeholder="https://" list="cmObPortals" autocomplete="off" value="${esc(v.portal || '')}"></label>
    <label><span class="sr-only">Assigned to</span><select class="obWho">${cmpTeamOptions(v.assigned || '', 'Client\'s person')}</select></label>
    <button type="button" class="obNotesBtn min-h-[2.5rem] rounded border text-sm" title="Notes" onclick="cmpObNotes(this)">📝</button>
    <button type="button" class="obLockBtn min-h-[2.5rem] rounded border text-base" onclick="cmpObLock(this)"></button>
    <button type="button" class="obDel min-h-[2.5rem] text-red-600 disabled:opacity-25 disabled:cursor-not-allowed" title="${ob ? 'Delete this obligation' : 'Remove this row'}" onclick="cmpObDelete(this)" ${can ? '' : 'disabled'}>✕</button>
    <div class="obWarn col-span-full hidden text-xs text-red-700 -mt-1"></div>
    <div class="obPrev col-span-full hidden text-xs bg-[#efeae2] rounded-lg p-2 ml-[11.5rem] max-w-3xl"></div></div>`);
  const row = $('#cmObNew').lastElementChild;
  row.querySelectorAll('.cmRem').forEach((c, n) => { c._link = v.rems[n] && v.rems[n].link ? v.rems[n].link : null; });
  row.querySelectorAll('.cmDoc').forEach(c => { c._link = (v.docLinks || {})[c.dataset.kind] || null; });
  CMP_OB.form.rows.set(key, { ob, period: p, extra: v.extra || [], notes: v.notes || '', locked: Boolean(v.locked), wasLocked: Boolean(v.locked), deleted: false, delNote: '', initial: null });
  cmpRemLabels(row); cmpObRowLock(row);
  cmpObState(row).initial = JSON.stringify(cmpObRowValues(row));
  if (!can) row.querySelectorAll('input, select, .obNotesBtn, .obLockBtn').forEach(el => { el.disabled = true; });
  cmpObNameCheck(row.querySelector('.obName'));
  if (focus || (!ob && rows.length)) row.querySelector('.obName').focus();
}
// The due date moved: the reminders keep their distance from it (they come the same days before the due date)
function cmpObDueMoved(input) {
  const row = input.closest('.cmObRow'), was = input.dataset.prev, now = input.value;
  if (was && now) { const k = CmpRules.daysBetween(was, now); if (k) row.querySelectorAll('.remDate').forEach(d => { if (d.value) d.value = CmpRules.addDays(d.value, k); }); }
  input.dataset.prev = now;
  cmpRemLabels(row);
}
// 🔒 locked: nothing in the row can be changed until it is unlocked (the CA: no change by a wrong touch)
function cmpObRowLock(row) {
  const st = cmpObState(row), b = row.querySelector('.obLockBtn');
  b.textContent = st.locked ? '🔒' : '🔓';
  b.title = st.locked ? 'Locked: click to unlock and change it' : 'Lock it when everything is entered (no change by mistake)';
  b.classList.toggle('bg-amber-50', st.locked); b.classList.toggle('border-amber-400', st.locked);
  row.querySelectorAll('input, select, .obNotesBtn, .obDel').forEach(el => { el.disabled = st.locked || st.deleted || !cmpCan('OBLIGATION_EDIT'); });
  row.classList.toggle('opacity-70', st.locked && !st.deleted);
  cmpTplNotes(row);
}
function cmpObLock(btn) {
  const row = btn.closest('.cmObRow'), st = cmpObState(row);
  if (st.deleted) return;
  if (st.locked && !confirm(`Unlock "${row.querySelector('.obName').value}" to change it?`)) return;
  st.locked = !st.locked; cmpObRowLock(row);
}
function cmpObNotes(btn) {
  const row = btn.closest('.cmObRow'), st = cmpObState(row);
  CMP_OB.notesRow = row;
  cmpShowSub(`${cmpSubHead(`Notes · ${esc(row.querySelector('.obName').value || 'new obligation')}`)}
    <div class="space-y-3"><textarea id="cmObNotesTa" rows="4" maxlength="1000">${esc(st.notes)}</textarea>
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseSub()')}${cmpBtn('OK', "cmpObState(CMP_OB.notesRow).notes = $('#cmObNotesTa').value; cmpObNotesMark(CMP_OB.notesRow); cmpCloseSub()", 'primary')}</div></div>`);
}
const cmpObNotesMark = row => { const b = row.querySelector('.obNotesBtn'), n = cmpObState(row).notes; b.classList.toggle('bg-sky-50', Boolean(n)); b.classList.toggle('border-sky-400', Boolean(n)); b.title = n ? `Notes: ${n}` : 'Notes'; };
// ✕: a new row goes; an obligation is marked to be deleted when saved (with a note when a message was sent or an invoice issued for it)
async function cmpObDelete(btn) {
  const row = btn.closest('.cmObRow'), st = cmpObState(row);
  if (!st.ob) { row.remove(); CMP_OB.form.rows.delete(row.dataset.key); document.querySelectorAll('#cmObNew .obName').forEach(cmpObNameCheck); return; }
  if (st.deleted) { st.deleted = false; st.delNote = ''; row.classList.remove('line-through', 'bg-red-50'); btn.textContent = '✕'; btn.title = 'Delete this obligation'; row.querySelector('.obWarn').classList.add('hidden'); return cmpObRowLock(row); }
  if (st.locked) return toast('It is locked: unlock it (🔒) first.');
  let usage = { messages: 0, invoices: 0 };
  try { usage = (await api(`/api/cmp/obligations/${st.ob.id}`)).usage || usage; } catch (err) { return toast(err.message); }
  let note = '';
  if (usage.messages || usage.invoices) {
    note = prompt(`${[usage.messages && `${usage.messages} WhatsApp message${usage.messages === 1 ? ' was' : 's were'} sent`, usage.invoices && `${usage.invoices} invoice${usage.invoices === 1 ? ' was' : 's were'} issued`].filter(Boolean).join(' and ')} for "${st.ob.name}". They stay in their logs. Why is it deleted? (required)`) || '';
    if (!note.trim()) return toast('Write why it is deleted.');
  } else if (!confirm(`Delete "${st.ob.name}" with all its periods (past and future) when you save?`)) return;
  st.deleted = true; st.delNote = note;
  row.classList.add('line-through', 'bg-red-50'); btn.disabled = false; btn.textContent = '↶'; btn.title = 'Keep it';
  const w = row.querySelector('.obWarn'); w.textContent = 'Deleted with all its periods when you save (↶ keeps it).'; w.classList.remove('hidden');
  row.querySelectorAll('input, select, .obNotesBtn').forEach(el => { el.disabled = true; });
}
// The same name twice in the window (the CA: "created double")
function cmpObNameCheck(input) {
  const row = input.closest('.cmObRow'), box = row.querySelector('.obWarn'), k = CmpRules.keyOf(input.value), st = cmpObState(row);
  if (st && st.deleted) return;
  const twice = k && [...document.querySelectorAll('#cmObNew .cmObRow')].filter(r => !cmpObState(r).deleted && CmpRules.keyOf(r.querySelector('.obName').value) === k).length > 1;
  box.textContent = twice ? `"${input.value.trim()}" is in this window twice: each obligation needs its own name (e.g. Q1, Q2), or delete the extra one (✕).` : '';
  box.classList.toggle('hidden', !box.textContent); input.classList.toggle('!border-red-500', Boolean(twice));
}
// The options of a template list: the firm's templates of that category for this client's country (or every country). A reminder that
// still has its own message from before templates were required keeps it as a choice; a template no longer in use stays shown while set.
const CMP_OWN = '__own';
function cmpTplOptions(category, selected, link) {
  const f = CMP_OB.form, cc = f.client.country;
  const list = (f.templates || []).filter(t => CmpRules.templateFits(t, category, cc));
  if (selected && selected !== CMP_OWN && !list.some(t => t.id === selected)) { const t = (f.allTemplates || []).find(x => x.id === selected); list.unshift(t || { id: selected, name: (link && link.templateName) || 'a template no longer in use' }); }
  return `<option value="">${list.length ? '— choose a template —' : '— no template of this category —'}</option>`
    + (link && link.own ? `<option value="${CMP_OWN}" ${selected === CMP_OWN ? 'selected' : ''}>Its own message (written before)</option>` : '')
    + list.map(t => `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${esc(t.name)}${t.purpose === 'REMINDER' ? ' (reminder)' : ''}</option>`).join('');
}
// How far each reminder is from the due date, under its list
function cmpRemLabels(row) {
  const due = row.querySelector('.obDue').value;
  row.querySelectorAll('.cmRem').forEach(c => {
    const d = c.querySelector('.remDate').value, sel = c.querySelector('.remTpl');
    sel.classList.toggle('!border-amber-400', Boolean(d && !sel.value));
    sel.title = d && due ? CmpRules.offsetLabel(CmpRules.daysBetween(due, d)) : '';
  });
  cmpObNotesMark(row);
  cmpTplNotes(row);
}
// A template that changed while the obligation was locked (the CA): "the template of the 1st reminder is updated: unlock to accept, or
// reject"; a rejected one can still be aligned with the template later (after unlocking)
function cmpTplNotes(row) {
  const st = cmpObState(row); if (!st) return;
  row.querySelectorAll('.cmRem, .cmDoc').forEach(c => {
    const l = c._link, box = c.querySelector('.tplNote'), sel = c.querySelector('select');
    const same = l && l.templateId && sel.value === l.templateId;
    if (!l || !same || !(l.pending || l.rejected) || st.deleted) { box.innerHTML = ''; return; }
    const what = c.classList.contains('cmRem') ? `the ${CmpRules.ordinal(Number(c.dataset.n) + 1)} reminder` : `the ${CmpRules.templateCategory(c.dataset.kind).toLowerCase()} template`;
    const target = c.classList.contains('cmRem') ? l.id : c.dataset.kind;
    box.innerHTML = l.pending
      ? `<div class="text-[10px] leading-tight rounded border border-amber-300 bg-amber-50 text-amber-900 p-1">"${esc(l.templateName)}" was updated.${st.locked ? ' Unlock 🔒 to accept it, or' : ''}
          <span class="flex gap-1 mt-1">${st.locked ? '' : `<button type="button" class="px-1.5 py-0.5 rounded bg-emerald-700 text-white" onclick="cmpTplDecide(this, '${target}', true)" title="Use the updated template for ${esc(what)}">Accept</button>`}<button type="button" class="px-1.5 py-0.5 rounded border border-amber-500 bg-white" onclick="cmpTplDecide(this, '${target}', false)" title="Keep the earlier version">Reject</button></span></div>`
      : `<div class="text-[10px] leading-tight text-slate-500">Earlier version kept.${st.locked ? '' : ` <button type="button" class="underline text-emerald-700" onclick="cmpTplDecide(this, '${target}', true)">Align with the template</button>`}</div>`;
  });
}
async function cmpTplDecide(btn, target, accept) {
  const row = btn.closest('.cmObRow'), st = cmpObState(row), ob = st.ob;
  try {
    if (accept && st.wasLocked) { await api(`/api/cmp/obligations/${ob.id}`, { method: 'PUT', body: { locked: false } }); st.wasLocked = false; }
    const out = await api(`/api/cmp/obligations/${ob.id}/template-update`, { method: 'POST', body: { target, accept } });
    // the reminders and templates as the server has them now
    const rems = [...out.reminders].sort((a, b) => a.offsetDays - b.offsetDays);
    row.querySelectorAll('.cmRem').forEach(c => { const l = c._link && rems.find(r => r.id === c._link.id); if (l) c._link = l; });
    row.querySelectorAll('.cmDoc').forEach(c => { if (c._link) c._link = (out.docTemplates || {})[c.dataset.kind] || c._link; });
    cmpTplNotes(row);
    toast(accept ? 'The updated template is used now' + (st.locked ? '' : ' (lock it again when you are done)') : 'Update rejected: it keeps the earlier version', true);
  } catch (err) { toast(err.message); }
}
// The exact message of the list just chosen (or looked at), for this client with this row's dates, shown under the row (the CA)
function cmpObPreview(sel) {
  const row = sel.closest('.cmObRow'), box = row.querySelector('.obPrev'), f = CMP_OB.form, g = c => row.querySelector(c).value;
  const cell = sel.closest('.cmRem, .cmDoc'), l = cell._link, id = sel.value;
  const label = cell.classList.contains('cmRem') ? `${CmpRules.ordinal(Number(cell.dataset.n) + 1)} reminder` : CmpRules.templateCategory(cell.dataset.kind);
  if (cell.classList.contains('cmRem')) cmpRemLabels(row);
  if (!id) { box.classList.add('hidden'); return; }
  const t = (f.allTemplates || f.templates || []).find(x => x.id === id);
  const body = id === CMP_OWN ? (l && l.body) || '' : l && l.templateId === id && l.body ? l.body : t ? t.body : '';
  const due = g('.obDue'), on = cell.classList.contains('cmRem') ? cell.querySelector('.remDate').value : '', real = f.ctx && f.ctx.ctx;
  const base = real || { client: { name: f.client.name, code: f.client.code, country: f.client.country }, countryName: cmpCountry(f.client.country).name, fields: {}, firm: { name: (CMP.settings || {}).firmName || '' } };
  const r = CmpRules.render(body, { ...base, obligationName: g('.obName') || 'the obligation', occurrence: { periodStart: g('.obStart'), periodEnd: g('.obEnd'), dueDate: due },
    daysLeft: due && on ? CmpRules.daysBetween(on, due) : null, portalUrl: g('.obPortal') || '' });
  box.innerHTML = `<div class="text-[11px] text-slate-600 mb-1">${esc(label)} · ${esc(id === CMP_OWN ? 'its own message' : t ? t.name : 'template')}${l && l.templateId === id && l.body ? ' (the earlier version it keeps)' : ''} — as ${esc(f.client.name)} gets it${on ? ` on ${cmpDay(on)}` : ''}:</div>
    <div class="whitespace-pre-wrap bg-[#d9fdd3] rounded-lg rounded-tr-none shadow px-3 py-2 text-sm">${esc(r.text) || '<span class="text-slate-400">(empty)</span>'}</div>`;
  box.classList.remove('hidden');
}
// A day chosen with no template yet: the only template of that reminder's category is chosen by itself
function cmpRemDate(input) {
  const cell = input.closest('.cmRem'), sel = cell.querySelector('.remTpl');
  if (input.value && !sel.value) { const opts = [...sel.options].filter(o => o.value && o.value !== CMP_OWN); if (opts.length === 1) { sel.value = opts[0].value; cmpObPreview(sel); } }
  cmpRemLabels(cell.closest('.cmObRow'));
}
function cmpInsertAt(id, text) {
  const ta = document.getElementById(id), a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, a) + text + ta.value.slice(b); ta.focus(); ta.selectionStart = ta.selectionEnd = a + text.length;
  ta.dispatchEvent(new Event('input'));
}
// A new row's name already used by other clients of this country (the CA: country-sensitive): their dates and reminders, to use
function cmpObligationNameHint(input) {
  const box = document.getElementById('cmObHint'), form = CMP_OB.form, row = input.closest('.cmObRow'); if (!box || cmpObState(row).ob) return;
  const k = CmpRules.keyOf(input.value), i = form.suggestions.findIndex(x => !x.otherCountry && CmpRules.keyOf(x.name) === k);
  if (!k || i < 0) { box.innerHTML = ''; return; }
  CMP_OB.hintRow = row;
  const s = form.suggestions[i], country = cmpCountry(form.client.country), rem = s.reminders.length;
  box.innerHTML = `<div class="rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-sm flex flex-wrap items-center gap-2">
    <span>${country.flag} ${s.clients} ${esc(country.name)} client${s.clients === 1 ? ' has' : 's have'} <b>${esc(s.name)}</b>: ${esc(CmpRules.periodName(s))}, due ${esc(cmpDay(s.dueDate))}${rem ? `, ${rem} reminder${rem === 1 ? '' : 's'} (${s.reminders.map(r => esc(CmpRules.offsetLabel(r.offsetDays).toLowerCase())).join(', ')})` : ''}.</span>
    ${cmpBtn('Use these dates and reminders', `cmpObligationSuggest(${i})`, 'plain')}</div>`;
}
function cmpObligationSuggest(i) {
  const s = CMP_OB.form.suggestions[Number(i)], row = CMP_OB.hintRow; if (!s || !row) return;
  row.querySelector('.obName').value = s.name; row.querySelector('.obPortal').value = row.querySelector('.obPortal').value || s.portalUrl || '';
  row.querySelector('.obStart').value = s.periodStart; row.querySelector('.obEnd').value = s.periodEnd; row.querySelector('.obDue').value = s.dueDate; row.querySelector('.obDue').dataset.prev = s.dueDate;
  row.querySelector('.obYears').value = s.yearsTotal || '';
  row.querySelectorAll('.cmRem').forEach((c, n) => {
    const r = s.reminders[n], sel = c.querySelector('.remTpl');
    c.querySelector('.remDate').value = r ? CmpRules.addDays(s.dueDate, r.offsetDays) : '';
    sel.value = r && r.templateId && [...sel.options].some(o => o.value === r.templateId) ? r.templateId : '';
  });
  cmpRemLabels(row);
  $('#cmObHint').innerHTML = '';
  toast('Filled in from another client of this country: check the dates.', true);
}
// Every row checked here first (names, dates, reminders, settings), then what is sent
function cmpObCheck(row, i) {
  const v = cmpObRowValues(row), label = v.name || `Row ${i + 1}`;
  if (!v.name) throw new Error(`Row ${i + 1}: type the obligation's name.`);
  const problem = CmpRules.datesProblem(v.start, v.end, v.due); if (problem) throw new Error(`${label}: ${problem}`);
  if (v.years && !(Number.isInteger(Number(v.years)) && Number(v.years) >= 1 && Number(v.years) <= 100)) throw new Error(`${label}: how many years is a number from 1 to 100 (empty = unlimited).`);
  if (!(Number.isInteger(Number(v.amber)) && Number(v.amber) >= 0 && Number(v.amber) <= 90)) throw new Error(`${label}: amber days is a number from 0 to 90.`);
  const reminders = [], cells = [...row.querySelectorAll('.cmRem')];
  v.rems.forEach((r, n) => {
    if (!r.date) return;
    const offsetDays = CmpRules.daysBetween(v.due, r.date);
    if (Math.abs(offsetDays) > 366) throw new Error(`${label}: the ${CmpRules.ordinal(n + 1)} reminder must be within a year of the due date.`);
    if (reminders.some(x => x.offsetDays === offsetDays)) throw new Error(`${label}: two reminders are on the same day.`);
    if (!r.tpl) throw new Error(`${label}: choose the template of the ${CmpRules.ordinal(n + 1)} reminder (or clear its day).`);
    const link = cells[n]._link;
    reminders.push(r.tpl === CMP_OWN ? { offsetDays, body: (link && link.body) || '' } : { offsetDays, templateId: r.tpl });
  });
  return { v, reminders, settings: { name: v.name, yearsTotal: v.years ? Number(v.years) : null, amberDays: Number(v.amber), autoNext: v.auto, portalUrl: v.portal, assignedToId: v.assigned || null, notes: v.notes,
    docTemplates: Object.fromEntries(CMP_DOC_KINDS.map(([k]) => [k, v.docs[k] || null])) } };
}
// pastOk: the due date of a new obligation has passed (the CA: asked first; or moved to the next year that is still ahead)
async function cmpObligationSave(pastOk) {
  const form = CMP_OB.form;
  if (CMP_OB.saving) return; // (a second click while the first is saving: the CA's "created double")
  const rows = [...document.querySelectorAll('#cmObNew .cmObRow')], plan = [];
  try {
    rows.forEach((row, i) => {
      const st = cmpObState(row);
      if (st.deleted) { plan.push({ row, st, kind: 'delete' }); return; }
      const dirty = JSON.stringify(cmpObRowValues(row)) !== st.initial;
      if (st.ob && !dirty) return;
      plan.push({ row, st, kind: st.ob ? 'update' : 'create', ...cmpObCheck(row, i) });
    });
  } catch (err) { return toast(err.message); }
  const names = rows.filter(r => !cmpObState(r).deleted).map(r => CmpRules.keyOf(r.querySelector('.obName').value));
  if (new Set(names).size !== names.length) return toast('Two rows have the same name: each obligation needs its own (or delete the extra one with ✕).');
  if (!plan.length) { cmpCloseModal(); return toast('Nothing changed.', true); }
  const today = CmpRules.dayIn(form.client.timeZone), past = plan.filter(x => x.kind === 'create' && x.v.due < today);
  if (!pastOk && past.length) return cmpObPastAsk(past.map(x => ({ name: x.v.name, dueDate: x.v.due })), today);
  CMP_OB.saving = true; const btn = document.getElementById('cmObSave'); if (btn) btn.disabled = true;
  const done = { deleted: 0, changed: 0, added: 0 }, future = Boolean(($('#cmObFuture') || {}).checked);
  try {
    for (const x of plan.filter(p => p.kind === 'delete')) {
      await api(`/api/cmp/obligations/${x.st.ob.id}/delete`, { method: 'POST', body: { note: x.st.delNote } }).catch(e => { throw new Error(`${x.st.ob.name}: ${e.message}`); });
      done.deleted++;
    }
    for (const x of plan.filter(p => p.kind === 'update')) {
      const ob = x.st.ob, p = x.st.period, v = x.v, at = e => { throw new Error(`${ob.name}: ${e.message}`); };
      const init = JSON.parse(x.st.initial);
      if (x.st.wasLocked && !x.st.locked) await api(`/api/cmp/obligations/${ob.id}`, { method: 'PUT', body: { locked: false } }).catch(at);
      const moved = v.start !== p.periodStart || v.end !== p.periodEnd || v.due !== p.dueDate;
      if (moved && p.planned) await api(`/api/cmp/obligations/${ob.id}/pattern`, { method: 'PUT', body: { fromSeq: p.seq, periodStart: v.start, periodEnd: v.end, dueDate: v.due } }).catch(at);
      else if (moved) await api(`/api/cmp/occurrences/${p.id}`, { method: 'PUT', body: { periodStart: v.start, periodEnd: v.end, dueDate: v.due, applyFuture: future } }).catch(at);
      if (moved || JSON.stringify(init.rems) !== JSON.stringify(v.rems)) {
        const extra = x.st.extra.map(r => (r.templateId ? { offsetDays: r.offsetDays, templateId: r.templateId } : { offsetDays: r.offsetDays, body: r.body }));
        await api(`/api/cmp/obligations/${ob.id}/reminders`, { method: 'PUT', body: { reminders: [...x.reminders, ...extra] } }).catch(at);
      }
      await api(`/api/cmp/obligations/${ob.id}`, { method: 'PUT', body: { ...x.settings, locked: x.st.locked } }).catch(at);
      done.changed++;
    }
    const adds = plan.filter(p => p.kind === 'create');
    if (adds.length) {
      const items = adds.map(x => ({ ...x.settings, periodStart: x.v.start, periodEnd: x.v.end, dueDate: x.v.due, reminders: x.reminders, locked: x.st.locked }));
      const r = await api(`/api/cmp/clients/${form.clientId}/obligations`, { method: 'POST', body: { frequency: 'YEARLY', items } });
      done.added = r.obligations.length;
    }
    cmpCloseModal();
    toast([done.added && `${done.added} added`, done.changed && `${done.changed} changed`, done.deleted && `${done.deleted} deleted`].filter(Boolean).join(', ') || 'Saved', true);
  } catch (err) { toast(err.message + (done.deleted + done.changed ? ` (${[done.deleted && `${done.deleted} deleted`, done.changed && `${done.changed} changed`].filter(Boolean).join(', ')} before it)` : '')); }
  finally {
    CMP_OB.saving = false; const b = document.getElementById('cmObSave'); if (b) b.disabled = false;
    if (S.page === 'cm-client') cmpLoadClient(); else if (S.page === 'cm-obligations') cmpLoadObligations(); else if (PAGE_ENTER[S.page]) PAGE_ENTER[S.page]();
  }
}
function cmpObPastAsk(past, today) {
  cmpShowSub(`${cmpSubHead('The due date has passed', `Today is ${cmpDay(today)} (${esc(CmpCountries.zoneCity(CMP_OB.form.client.timeZone))}).`)}
    <ul class="text-sm list-disc pl-5 space-y-1 mb-3">${past.map(x => `<li><b>${esc(x.name)}</b> — due ${cmpDay(x.dueDate)}</li>`).join('')}</ul>
    <p class="text-sm mb-3">Do you still want to add ${past.length === 1 ? 'it' : 'them'} for the past date${past.length === 1 ? '' : 's'}? ${past.length === 1 ? 'It shows' : 'They show'} as overdue until completed. Or move ${past.length === 1 ? 'it' : 'them'} to the next year that is still ahead (then check and save).</p>
    <div class="flex flex-wrap justify-end gap-2">${cmpBtn('Go back', 'cmpCloseSub()')}${cmpBtn('Move to the next year ahead', 'cmpObPastMove()')}${cmpBtn('Yes, add for the past date', 'cmpCloseSub(); cmpObligationSave(true)', 'primary', 'needs-write')}</div>`);
}
function cmpObPastMove() {
  const today = CmpRules.dayIn(CMP_OB.form.client.timeZone);
  document.querySelectorAll('#cmObNew .cmObRow').forEach(row => {
    if (cmpObState(row).ob) return; // (only new obligations)
    const due = row.querySelector('.obDue'); let k = 0;
    while (due.value && CmpRules.shiftMonths(due.value, 12 * k, false) < today && k < 50) k++;
    if (!k) return;
    for (const [c, sticky] of [['.obStart', false], ['.obEnd', true], ['.obDue', false]]) { const el = row.querySelector(c); el.value = CmpRules.shiftMonths(el.value, 12 * k, sticky); }
    due.dataset.prev = due.value;
    row.querySelectorAll('.remDate').forEach(el => { if (el.value) el.value = CmpRules.shiftMonths(el.value, 12 * k, false); });
    cmpRemLabels(row);
  });
  cmpCloseSub(); toast('Moved a year on (or more) until the due date is ahead: check the dates, then save.', true);
}

async function cmpNextPeriod(id, after) {
  try { await api(`/api/cmp/obligations/${id}/next`, { method: 'POST' }); toast('Next period added: check its dates', true); if (after) after(); else if (S.page === 'cm-client') cmpLoadClient(); else if (S.page === 'cm-obligations') cmpLoadObligations(); }
  catch (err) { toast(err.message); }
}
async function cmpObligationArchive(id, archive, after) {
  if (archive && !confirm('Archive this obligation with ALL its periods — past, current and future? They leave the lists, dashboards, reminders and notifications. It can be restored (tick "Archived" on My Obligations, or on the client\'s page).')) return;
  try { await api(`/api/cmp/obligations/${id}/${archive ? 'archive' : 'restore'}`, { method: 'POST' }); toast(archive ? 'Obligation archived with all its periods' : 'Obligation restored with all its periods', true); if (typeof after === 'function') after(); else if (S.page === 'cm-client') cmpLoadClient(); }
  catch (err) { toast(err.message); }
}
// Deleted for good (the CA). Once a WhatsApp message was sent (or an invoice issued) for it: a warning, and a note saying why.
async function cmpObligationDelete(id, after) {
  let ob;
  try { ob = await api(`/api/cmp/obligations/${id}`); } catch (err) { return toast(err.message); }
  const u = ob.usage || { messages: 0, invoices: 0 }, serious = u.messages || u.invoices;
  CMP_OB.deleting = { id, after: typeof after === 'function' ? after : S.page === 'cm-client' ? cmpLoadClient : S.page === 'cm-obligations' ? cmpLoadObligations : null };
  cmpShowModal(`${cmpModalHead(`Delete ${esc(ob.name)}?`, `${cmpCountry(ob.client.country).flag} ${esc(ob.client.name)} · ${ob.occurrences.length} period${ob.occurrences.length === 1 ? '' : 's'}`)}
    <div class="space-y-3 text-sm">
      ${serious ? `<div class="rounded-lg border-2 border-red-300 bg-red-50 px-3 py-2 text-red-900">⚠ <b>${[u.messages && `${u.messages} WhatsApp message${u.messages === 1 ? ' was' : 's were'} sent`, u.invoices && `${u.invoices} invoice${u.invoices === 1 ? ' was' : 's were'} issued`].filter(Boolean).join(' and ')}</b> for this obligation.
        They stay in the WhatsApp log and the invoices, no longer tied to it. Its periods and reminders are removed for good.</div>
        <label><span>Note — why it is deleted *</span><textarea id="cmDelNote" rows="2" maxlength="500" placeholder="e.g. added for the wrong client"></textarea></label>`
      : '<p>Its periods and reminders are removed for good. To keep them but hide them, archive it instead.</p>'}
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseModal()')}${cmpBtn('Delete for good', 'cmpObligationDeleteGo()', 'danger', 'needs-write')}</div></div>`);
}
async function cmpObligationDeleteGo() {
  const d = CMP_OB.deleting, note = document.getElementById('cmDelNote');
  if (note && !note.value.trim()) return toast('Write a note saying why it is deleted.');
  try {
    await api(`/api/cmp/obligations/${d.id}/delete`, { method: 'POST', body: { note: note ? note.value : '' } });
    cmpCloseModal(); toast('Obligation deleted', true); if (d.after) d.after();
  } catch (err) { toast(err.message); }
}

/* ---------- one period in a window (from the calendar, the notifications, the reports): its dates, data, task and reminders ---------- */
async function cmpOpenPeriod(obligationId, occurrenceId, refresh) {
  if (String(occurrenceId).startsWith('plan:')) return cmpOpenPlanned(obligationId, Number(occurrenceId.split(':')[2]), refresh);
  let ob;
  try { ob = await api(`/api/cmp/obligations/${obligationId}`); } catch (err) { return toast(err.message); }
  const p = ob.occurrences.find(x => x.id === occurrenceId);
  if (!p) return toast('That period is not there any more. Reload the page.');
  CMP_OB.period = { ob, p, refresh };
  const v = p.view, done = p.stage === 'COMPLETED', live = !ob.archivedAt && !ob.client.archivedAt, item = { ...p, client: ob.client };
  const editDates = live && cmpCan('OBLIGATION_EDIT'), steps = live && cmpCan('COMPLETE');
  cmpShowModal(`<div class="flex items-start justify-between gap-3 mb-4"><div class="min-w-0"><h2 class="text-lg font-semibold">${esc(ob.name)} · ${esc(CmpRules.periodName(p))}</h2>
      <div class="text-sm text-slate-500">${cmpCountry(ob.client.country).flag} ${esc(ob.client.name)} · ${esc(ob.client.code)} · ${esc(CmpRules.repeatsLabel(ob.frequency, ob.yearsTotal))}</div>
      <div class="flex flex-wrap gap-2 mt-2">${live && cmpCan('OBLIGATION_EDIT') ? cmpBtn('✎ Edit obligations', `cmpObligationForm('${ob.client.id}', '${ob.id}', { occurrenceId: '${p.id}' })`, 'plain', 'needs-write') : ''}
        ${cmpCan('ARCHIVE') ? cmpBtn('Delete obligation', `cmpObligationDelete('${ob.id}')`, 'danger', 'needs-write') : ''}
        ${cmpBtn('Client', `cmpCloseModal(); cmpOpenClient('${ob.client.id}')`)}</div></div>
    <button type="button" onclick="cmpCloseModal()" class="text-slate-400 hover:text-slate-700 text-2xl leading-none px-2" aria-label="Close">×</button></div>
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-3 rounded-lg border-l-4 ${CMP_BAR[v.colour]} bg-slate-50 px-3 py-2">${cmpStatusChip(v.status)}
        <span class="text-sm">Due <b>${cmpDay(p.dueDate)}</b> (${esc(CmpCountries.zoneCity(ob.client.timeZone))})${cmpDaysLeft(v) ? ` · <span class="${v.overdue ? 'text-red-700 font-medium' : ''}">${cmpDaysLeft(v)}</span>` : ''}</span>
        ${done ? `<span class="text-xs text-slate-500">Completed on ${esc(cmpDay(p.completedOn))} (marked ${esc(cmpAt(p.closedAt))} by ${esc(p.closedBy || '')})</span>` : ''}</div>
      <section><h3 class="text-sm font-medium mb-2">Dates ${p.datesConfirmed ? '' : '<span class="text-sky-700 font-normal">— copied from the period before: check and confirm them</span>'}</h3>
        <div class="grid sm:grid-cols-3 gap-3">
          <label><span>Period start</span><input id="cpStart" type="date" value="${p.periodStart}" ${editDates ? '' : 'disabled'}></label>
          <label><span>Period end</span><input id="cpEnd" type="date" value="${p.periodEnd}" ${editDates ? '' : 'disabled'}></label>
          <label><span>Due date</span><input id="cpDue" type="date" value="${p.dueDate}" ${editDates ? '' : 'disabled'}></label>
        </div>
        ${editDates ? `<div class="flex flex-wrap items-center gap-3 mt-2">
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="cpFuture"> Also use these dates for the periods after this one</label>
          <div class="flex gap-2 ml-auto">${p.datesConfirmed ? '' : cmpBtn('Dates are right', 'cmpPeriodConfirm()', 'plain', 'needs-write')}${cmpBtn('Save dates', 'cmpPeriodDates()', 'primary', 'needs-write')}</div></div>` : ''}
      </section>
      ${steps ? `<section><h3 class="text-sm font-medium mb-2">Progress</h3><div class="grid sm:grid-cols-2 gap-3 text-sm">
        <div class="border rounded-lg p-2"><div class="text-xs text-slate-500 mb-1">Data collection</div>${p.dataCollectedOn ? `✓ ${cmpDay(p.dataCollectedOn)} ${done ? '' : cmpLink('↶ undo', 'cmpPeriodData(null)')}` : cmpB('Pending · mark collected', `cmpAskDate('Data collected', 'The day the client\\'s data came in.', { max: '${CmpRules.dayIn(ob.client.timeZone)}' }, d => cmpPeriodData(d))`, 'pending')}</div>
        <div class="border rounded-lg p-2"><div class="text-xs text-slate-500 mb-1">Task</div>${done ? `✓ ${cmpDay(p.completedOn)} ${cmpLink('↶ reopen', 'cmpPeriodReopen()')}` : p.dataCollectedOn ? cmpB('Pending · mark completed', 'cmpPeriodComplete()', 'pending') : '<span class="text-slate-400">Pending — the data collection first</span>'}</div>
      </div><p class="text-xs text-slate-500 mt-1">Upcoming, Period closed and Overdue follow from the dates. It stays overdue until the task is completed.</p></section>` : ''}
      <section><h3 class="text-sm font-medium mb-2">Reminders</h3><div class="flex flex-col gap-1.5">${v.reminders.length ? v.reminders.map(r => cmpReminderPill(r, item, 'cmpPeriodRefresh')).join('') : '<p class="text-sm text-slate-500">No reminders. Add them with Edit obligation.</p>'}</div></section>
      ${editDates ? `<label><span>Remarks for this period</span><textarea id="cpNotes" rows="2" maxlength="1000" onchange="cmpPeriodNotes(this.value)">${esc(p.notes)}</textarea></label>` : (p.notes ? `<p class="text-sm whitespace-pre-wrap">${esc(p.notes)}</p>` : '')}
      <div class="flex flex-wrap justify-between gap-2 pt-2 border-t">
        <div class="flex flex-wrap gap-2">
          ${ob.portalUrl ? `<a href="${esc(ob.portalUrl)}" target="_blank" rel="noopener noreferrer" class="px-3 min-h-[2.5rem] inline-flex items-center rounded-lg text-sm border bg-white hover:border-emerald-600">Open portal ↗</a>` : ''}
          ${live && cmpCan('WHATSAPP') && !ob.client.noWhatsApp ? cmpBtn(`${CMP_WA_ICON} Other message`, `cmpClientMessage('${ob.client.id}', '${p.id}')`, 'plain', 'needs-write') : ''}
        </div>${cmpBtn('Close', 'cmpCloseModal()')}</div>
    </div>`);
}
// A period still to come (Planned): the CA wants the same window as Edit
async function cmpOpenPlanned(obligationId, seq) {
  let ob;
  try { ob = await api(`/api/cmp/obligations/${obligationId}`); } catch (err) { return toast(err.message); }
  cmpObligationForm(ob.client.id, ob.id, { seq });
}
async function cmpPeriodRefresh() {
  const c = CMP_OB.period; if (!c) return;
  if (c.refresh) c.refresh();
  if (!document.getElementById('cmpModal').classList.contains('hidden')) cmpOpenPeriod(c.ob.id, c.p.id, c.refresh);
}
// reopen = false: the caller shows its own window next (e.g. "Completed ✓"), so the period is not drawn again over it
async function cmpPeriodCall(url, body, msg, { reopen = true } = {}) {
  const c = CMP_OB.period;
  try {
    const ob = await api(url, { method: url.endsWith(c.p.id) ? 'PUT' : 'POST', body });
    if (msg) toast(msg, true);
    if (c.refresh) c.refresh();
    if (reopen && ob.occurrences.some(x => x.id === c.p.id)) await cmpOpenPeriod(ob.id, c.p.id, c.refresh);
    return ob;
  } catch (err) { toast(err.message); return null; }
}
const cmpPeriodDates = () => cmpPeriodCall(`/api/cmp/occurrences/${CMP_OB.period.p.id}`, { periodStart: $('#cpStart').value, periodEnd: $('#cpEnd').value, dueDate: $('#cpDue').value, applyFuture: $('#cpFuture').checked }, 'Dates saved');
const cmpPeriodConfirm = () => cmpPeriodCall(`/api/cmp/occurrences/${CMP_OB.period.p.id}`, { confirm: true }, 'Dates confirmed');
const cmpPeriodNotes = notes => cmpPeriodCall(`/api/cmp/occurrences/${CMP_OB.period.p.id}`, { notes }, 'Remarks saved');
const cmpPeriodData = on => cmpPeriodCall(`/api/cmp/occurrences/${CMP_OB.period.p.id}/data`, { on }, on ? 'Data collection marked' : 'Data collection pending again');
const cmpPeriodReopen = () => cmpPeriodCall(`/api/cmp/occurrences/${CMP_OB.period.p.id}/reopen`, null, 'Reopened');
// The task done on a day (the CA: only once the data is collected); then the invoice, no invoice (free work), or later, and a message
function cmpPeriodComplete() {
  const c = CMP_OB.period;
  cmpAskDate('Task completed', `${esc(c.ob.name)} · ${esc(CmpRules.periodName(c.p))}: the day the work was done.`, { max: CmpRules.dayIn(c.ob.client.timeZone), okLabel: 'Mark completed' }, d => cmpPeriodCompleteGo(d));
}
async function cmpPeriodCompleteGo(on) {
  const c = CMP_OB.period;
  const ob = await cmpPeriodCall(`/api/cmp/occurrences/${c.p.id}/complete`, { mode: 'TASK', on }, null, { reopen: false });
  if (!ob) return;
  const next = ob.occurrences.find(x => x.seq === c.p.seq + 1), wa = cmpCan('WHATSAPP') && !c.ob.client.noWhatsApp;
  cmpShowModal(`${cmpModalHead('Completed ✓', `${esc(c.ob.name)} · ${esc(CmpRules.periodName(c.p))} · ${esc(c.ob.client.name)}`)}
    <div class="space-y-3 text-sm">
      ${next ? `<p>The next period (${esc(CmpRules.periodName(next))}, due ${esc(cmpDay(next.dueDate))}) is ready${next.datesConfirmed ? '' : ': check its dates when you can'}.</p>` : ''}
      <div class="flex flex-wrap gap-2">${cmpCan('INVOICE') ? cmpBtn('Create the invoice now', `cmpCloseModal(); cmpInvoiceDraft({ occurrenceId: '${c.p.id}' }, CMP_OB.period.refresh)`, 'primary', 'needs-write') : ''}
        ${cmpBtn('No invoice (free work)', `cmpCloseModal(); cmpTrkBilling('${c.p.id}', 'FREE', CMP_OB.period.refresh)`, 'plain', 'needs-write')}
        ${wa ? cmpBtn(`${CMP_WA_ICON} Tell the client`, `cmpClientMessage('${c.ob.client.id}', '${c.p.id}')`, 'wa', 'needs-write') : ''}${cmpBtn('Later', 'cmpCloseModal()')}</div>
    </div>`);
}
