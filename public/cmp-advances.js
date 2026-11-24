'use strict';
/* Compliance & Deadlines: Advance Payment (the CA, 24 Nov 2026) — the replica of the receipts for money received before the invoice: each
   advance has its numbered receipt (printed with the country's advance payment format), its WhatsApp message (the obligation's advance
   template) and its place in the reports. An advance is taken off an invoice later (gross amount, advance adjustment, net amount). */

const CMP_ADV = { q: '', status: '', timer: null, rows: [] };
CMP_RESETS.push(() => Object.assign(CMP_ADV, { q: '', status: '', timer: null, rows: [] }));
const CMP_ADV_STATUS = { ACTIVE: ['Not adjusted yet', 'bg-sky-100 text-sky-800'], PARTLY: ['Partly adjusted', 'bg-amber-100 text-amber-900'], ADJUSTED: ['Fully adjusted', 'bg-emerald-100 text-emerald-800'], VOID: ['Void', 'bg-slate-100 text-slate-500'] };
const cmpAdvChip = st => { const [t, c] = CMP_ADV_STATUS[st] || [st, 'bg-slate-100']; return `<span class="px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${c}">${t}</span>`; };

CMP_PAGES.push({
  id: 'cm-advances',
  html: () => `<div class="bg-white rounded-xl shadow p-4">
    <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
      <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3 flex-1">
        <div id="cmAdvRange" class="contents"></div>
        <label><span>Show</span><select id="cmAdvStatus" onchange="CMP_ADV.status = this.value; cmpLoadAdvances()"><option value="">Advance payments</option><option value="OPEN">Not fully adjusted</option><option value="all">With the undone ones</option></select></label>
        <label class="col-span-2 sm:min-w-[12rem]"><span>Search</span><input id="cmAdvQ" type="search" placeholder="Number, client, description or reference" oninput="clearTimeout(CMP_ADV.timer); CMP_ADV.timer = setTimeout(() => { CMP_ADV.q = this.value; cmpLoadAdvances(); }, 350)"></label>
      </div>
      <div class="flex flex-wrap gap-2">${cmpBtn('+ New advance payment', 'cmpAdvanceNew()', 'primary', 'needs-write')}${cmpBtn('Print / PDF', 'cmpPrintTable("Advance payments — " + cmpRangeText("adv"), "cmAdvTable")')}</div>
    </div>
    <div id="cmAdvTotals" class="text-xs text-slate-600 mb-2"></div>
    <div class="overflow-x-auto"><table id="cmAdvTable" class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Receipt</th><th>Date</th><th>Client</th><th>For</th><th class="text-right">Amount</th><th class="text-right">Adjusted</th><th class="text-right">Balance</th><th>Paid by</th><th>Status</th><th>Sent</th><th>Actions</th></tr></thead>
      <tbody id="cmAdvRows"></tbody></table></div></div>`,
  enter: () => {
    if (S.routeArg) { CMP_ADV.q = decodeURIComponent(S.routeArg); CMP_ADV.status = 'all'; cmpRange('adv'); CMP.ranges.adv.r = { ...CMP.ranges.adv.r, mode: 'all' }; }
    $('#cmAdvRange').innerHTML = cmpRangeBar('adv', cmpLoadAdvances);
    $('#cmAdvQ').value = CMP_ADV.q; $('#cmAdvStatus').value = CMP_ADV.status;
    cmpLoadAdvances();
  },
});
async function cmpLoadAdvances() {
  const q = { q: CMP_ADV.q, ...cmpRangeDates('adv'), ...(CMP_ADV.status === 'all' ? { status: 'all' } : {}), ...(CMP_ADV.status === 'OPEN' ? { available: '1' } : {}) };
  let rows;
  try { rows = await api('/api/cmp/advances?' + cmpQs(q)); } catch (err) { $('#cmAdvRows').innerHTML = `<tr><td colspan="11">${cmpEmpty(esc(err.message))}</td></tr>`; return; }
  CMP_ADV.rows = rows;
  const sums = {};
  for (const a of rows) if (!a.voidedAt) { const x = sums[a.currency] || (sums[a.currency] = { amount: 0, left: 0 }); x.amount += a.amount; x.left += a.available; }
  $('#cmAdvTotals').innerHTML = `${esc(cmpRangeText('adv'))} · ${rows.length} advance payment${rows.length === 1 ? '' : 's'}` + Object.entries(sums).map(([c, x]) => ` · <b>${cmpMoney(x.amount, c)}</b> received, ${cmpMoney(x.left, c)} not adjusted yet`).join('');
  const sent = a => (a.sentCount ? `<span class="text-xs text-emerald-800">${esc(CmpRules.sentTimes(a.sentCount))}</span>` : '<span class="text-xs text-slate-400">—</span>');
  $('#cmAdvRows').innerHTML = rows.map(a => `<tr class="border-b last:border-0 ${a.voidedAt ? 'opacity-60' : 'hover:bg-slate-50'}">
    <td class="py-2 font-medium whitespace-nowrap ${a.voidedAt ? 'line-through' : ''}"><a href="#" class="text-emerald-700 underline" onclick="event.preventDefault(); cmpAdvanceView('${a.id}')">${esc(a.number || '—')}</a>${a.voidedAt ? `<div class="text-xs text-red-700 font-normal">void: ${esc(a.voidReason)}</div>` : ''}</td>
    <td class="whitespace-nowrap">${cmpDay(a.receivedOn)}</td><td>${cmpCountry(a.client.country).flag} <a href="#" class="hover:underline" onclick="event.preventDefault(); cmpOpenClient('${a.client.id}')">${esc(a.client.name)}</a></td>
    <td class="text-xs">${esc(a.description)}${a.obligation ? `<div class="text-slate-500">${esc(a.obligation.name)} · ${esc(CmpRules.periodName(a.obligation))}</div>` : ''}</td>
    <td class="text-right whitespace-nowrap">${cmpMoney(a.amount, a.currency)}</td><td class="text-right whitespace-nowrap">${cmpMoney(a.used, a.currency)}</td><td class="text-right whitespace-nowrap font-medium">${cmpMoney(a.available, a.currency)}</td>
    <td class="text-xs">${esc(CMP_METHODS[a.method] || a.method)}${a.reference ? ` · ${esc(a.reference)}` : ''}</td><td>${cmpAdvChip(a.status)}</td><td>${sent(a)}</td>
    <td><div class="flex flex-wrap gap-1">${cmpBtn('View', `cmpAdvanceView('${a.id}')`)}${cmpBtn('Print', `cmpAdvancePrint('${a.id}')`)}
      ${!a.voidedAt && cmpCan('WHATSAPP') && !a.client.noWhatsApp ? cmpBtn(a.sentCount ? 'Send again' : `${CMP_WA_ICON} WhatsApp`, `cmpWhatsApp({ kind: 'ADVANCE', advanceId: '${a.id}' }, cmpLoadAdvances)`, a.sentCount ? 'plain' : 'wa', 'needs-write') : ''}
      ${a.sentCount && cmpCan('WHATSAPP') ? cmpBtn('↶', `cmpAdvanceUnsend('${a.id}')`, 'plain', 'needs-write') : ''}
      ${!a.voidedAt ? cmpBtn('✎', `cmpAdvanceEdit('${a.id}', cmpLoadAdvances)`, 'plain', 'needs-write') : ''}${!a.voidedAt && !a.used ? cmpBtn('↶ Undo', `cmpAdvanceUndo('${a.id}')`, 'danger', 'needs-write') : ''}</div></td></tr>`).join('')
    || `<tr><td colspan="11">${cmpEmpty(`No advance payments for ${esc(cmpRangeText('adv'))}. Record one here (+ New advance payment), on the tracker (Advance payment → + Add), or from a draft invoice.`)}</td></tr>`;
}
// A new advance: choose the client (and, if it is for one, the obligation period), then the advance's details
async function cmpAdvanceNew() {
  let clients = [];
  try { clients = (await api('/api/cmp/clients')).clients.filter(c => !c.archivedAt); } catch (err) { return toast(err.message); }
  if (!clients.length) return toast('Add a client first.');
  cmpShowModal(`${cmpModalHead('New advance payment', 'Money received from a client before the invoice.')}
    <label><span>Client</span><select id="cmAdvClient">${clients.map(c => `<option value="${c.id}" data-cc="${esc(c.country)}">${cmpCountry(c.country).flag} ${esc(c.name)} (${esc(c.code)})</option>`).join('')}</select></label>
    <div class="flex justify-end gap-2 mt-4">${cmpBtn('Cancel', 'cmpCloseModal()')}${cmpBtn('Continue', 'cmpAdvanceNewGo()', 'primary')}</div>`);
}
function cmpAdvanceNewGo() {
  const sel = $('#cmAdvClient'), opt = sel.selectedOptions[0];
  cmpCloseModal();
  cmpAdvanceForm({ clientId: sel.value, country: opt.dataset.cc }, a => { cmpLoadAdvances(); if (a && a.id) cmpAdvanceView(a.id); });
}
// The advance's receipt, as it prints, with what can be done to it
async function cmpAdvanceView(id) {
  let a;
  try { a = await api(`/api/cmp/advances/${id}`); } catch (err) { return toast(err.message); }
  CMP_ADV.open = a;
  cmpShowModal(`${cmpModalHead(`Advance payment ${esc(a.number || '')}`, `${cmpCountry(a.client.country).flag} ${esc(a.client.name)} · ${cmpAdvChip(a.status)}${a.sentCount ? ` · ${esc(CmpRules.sentTimes(a.sentCount))}` : ''}`)}
    <div class="flex flex-wrap gap-2 mb-3">${cmpBtn('Print / PDF', `cmpAdvancePrint('${a.id}')`)}
      ${!a.voidedAt && cmpCan('WHATSAPP') && !a.client.noWhatsApp ? cmpBtn(a.sentCount ? 'Send again' : `${CMP_WA_ICON} Send on WhatsApp`, `cmpWhatsApp({ kind: 'ADVANCE', advanceId: '${a.id}' }, () => cmpAdvanceView('${a.id}'))`, a.sentCount ? 'plain' : 'wa', 'needs-write') : ''}
      ${a.adjustments.length ? `<span class="text-sm text-slate-600 self-center">Taken off ${a.adjustments.map(x => `<a class="text-emerald-700 underline" href="#/cm-invoices/${encodeURIComponent(x.number)}" onclick="cmpCloseModal()">${esc(x.number)}</a> (${cmpMoney(x.amount, a.currency)})`).join(', ')}</span>` : ''}</div>
    <div class="border rounded-lg bg-slate-50 overflow-auto max-h-[70vh] p-2"><div class="cmpDocFit bg-white shadow mx-auto" style="width:max-content">${cmpAdvanceDoc(a, CMP.settings || {})}</div></div>`, { wide: true });
  cmpFitDocs(document.getElementById('cmpModal'));
}
async function cmpAdvancePrint(id) {
  let a;
  try { a = CMP_ADV.open && CMP_ADV.open.id === id ? CMP_ADV.open : await api(`/api/cmp/advances/${id}`); } catch (err) { return toast(err.message); }
  const s = CMP.settings || {};
  cmpPrintDoc(cmpAdvanceDoc(a, s), `Advance payment receipt ${a.number} · ${s.firmName || S.company || ''}`, `#/cm-advances/${encodeURIComponent(a.number)}`);
}
// the last WhatsApp send of its receipt marked "not sent" (the count of sends is adjusted by hand, as for invoices and receipts)
const cmpAdvanceUnsend = id => cmpRun(() => api('/api/cmp/messages/void-last', { method: 'POST', body: { advanceId: id } }), 'Marked as not sent', cmpLoadAdvances);
async function cmpAdvanceUndo(id) {
  const reason = prompt('Undo this advance payment? Its receipt number stays (marked void). Why?', 'Entered by mistake'); if (!reason) return;
  try { await api(`/api/cmp/advances/${id}/void`, { method: 'POST', body: { reason } }); toast('Advance undone', true); cmpLoadAdvances(); } catch (err) { toast(err.message); }
}
