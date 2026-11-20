'use strict';
/* Compliance & Deadlines: fee invoices and receipts (SRS 9), the taxes on them (several, kept per country), and the items and services
   billed (the CA: typed once, then suggested with their price for that country's clients).
   The invoices page (the CA, 9 Nov 2026): the list, and beside it the invoice itself with everything that can be done to it (print,
   WhatsApp, sent and its undo, receipts and their undo, cancel at any stage), without another window. A printed invoice carries its own
   web address in the browser's footer (#/cm-invoices/INV-…), which opens that invoice. A receipt is only ever made against an invoice. */

const CMP_INV = { stage: 'created', status: '', q: '', currency: '', timer: null, edit: null, open: null, rates: [], items: [], selected: null, types: null };
CMP_RESETS.push(() => Object.assign(CMP_INV, { stage: 'created', status: '', q: '', currency: '', edit: null, open: null, rates: [], items: [], selected: null, types: null }));
const CMP_RC = { q: '', status: 'VALID', timer: null };
CMP_RESETS.push(() => Object.assign(CMP_RC, { q: '', status: 'VALID' }));
const CMP_INV_STATUS = { DRAFT: ['Draft', 'bg-slate-100 text-slate-700'], ISSUED: ['Issued', 'bg-sky-100 text-sky-800'], SENT: ['Sent', 'bg-indigo-100 text-indigo-800'],
  PARTIAL: ['Partially received', 'bg-amber-100 text-amber-800'], RECEIVED: ['Received', 'bg-emerald-100 text-emerald-800'], CANCELLED: ['Cancelled', 'bg-slate-200 text-slate-500 line-through'] };
const CMP_METHODS = { BANK: 'Bank transfer', CASH: 'Cash', CHEQUE: 'Cheque', CARD: 'Card', ONLINE: 'Online payment', OTHER: 'Other', CREDIT: 'Client credit' };
// a receipt whose invoice was cancelled: the money was refunded, or kept as the client's credit (the CA)
const cmpSettleChip = r => (r.settlement ? `<span class="px-2 py-0.5 rounded-full text-[11px] font-medium ${r.settlement === 'REFUNDED' ? 'bg-rose-100 text-rose-800' : 'bg-sky-100 text-sky-800'}" title="${esc(r.settlementNote || '')}">${r.settlement === 'REFUNDED' ? 'Refunded' : 'Kept as credit'}</span>` : '');
const cmpReceiptLive = r => !r.voidedAt && !r.settlement;
const cmpInvChip = st => { const [t, c] = CMP_INV_STATUS[st] || [st, 'bg-slate-100']; return `<span class="px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${c}">${t}</span>`; };
const cmpMoney = (n, cur) => `${esc(cur)} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: CmpCountries.currencyDecimals(cur), maximumFractionDigits: CmpCountries.currencyDecimals(cur) })}`;
const cmpPayable = inv => ['ISSUED', 'SENT', 'PARTIAL'].includes(inv.status);

/* ---------- the invoices pages (the CA, 16 Nov 2026: "Invoices Created" and "Invoices Issued"): the list, and the invoice beside it ---------- */
// created: made but not yet given to the client (drafts, issued and not sent); issued: sent to the client (or already paid)
const CMP_INV_STAGES = { created: { page: 'cm-invoices', empty: 'No invoices waiting to be sent for these dates. They are made from the tracker (Invoice created → Create), or here with "New invoice".' },
  issued: { page: 'cm-invoices-issued', empty: 'No invoices sent to clients for these dates. An invoice comes here once it is sent on WhatsApp or marked as sent.' } };
const cmpInvPageHtml = stage => `<div class="grid xl:grid-cols-5 gap-4 items-start">
    <div class="min-w-0 xl:col-span-3 bg-white rounded-xl shadow p-4">
      <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3 flex-1">
          <div id="cmInvRange" class="contents"></div>
          <label><span>Status</span><select onchange="CMP_INV.status = this.value; cmpLoadInvoices()"><option value="">All</option><option value="UNPAID">Not paid yet</option>
            ${Object.entries(CMP_INV_STATUS).filter(([k]) => (stage === 'issued' ? k !== 'DRAFT' : !['PARTIAL', 'RECEIVED', 'SENT'].includes(k))).map(([k, [t]]) => `<option value="${k}">${t}</option>`).join('')}</select></label>
          <label><span>Currency</span><select onchange="CMP_INV.currency = this.value; cmpLoadInvoices()"><option value="">All</option>${CmpCountries.currencies.map(c => `<option value="${c.code}">${c.code}</option>`).join('')}</select></label>
          <label class="col-span-2 sm:min-w-[12rem]"><span>Search</span><input id="cmInvQ" type="search" placeholder="Number, client or code" oninput="clearTimeout(CMP_INV.timer); CMP_INV.timer = setTimeout(() => { CMP_INV.q = this.value; cmpLoadInvoices(); }, 350)"></label>
        </div>
        <div class="flex flex-wrap gap-2">${stage === 'created' ? cmpBtn('+ New invoice', 'cmpInvoiceNew()', 'primary', 'needs-write') : ''}
          <span id="cmInvExport"></span>${cmpBtn('Print / PDF', `cmpPrintTable("${stage === 'issued' ? 'Invoices issued' : 'Invoices created'} — " + cmpRangeText("inv"), "cmInvTable")`)}</div>
      </div>
      <div id="cmInvTotals" class="text-xs text-slate-600 mb-2"></div>
      <div class="overflow-x-auto"><table id="cmInvTable" class="w-full text-sm">
        <thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Invoice</th><th>Client</th><th class="text-right">Total / outstanding</th><th>Status</th></tr></thead>
        <tbody id="cmInvRows"></tbody></table></div>
    </div>
    <aside id="cmInvView" class="min-w-0 xl:col-span-2 bg-white rounded-xl shadow p-4 xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto">${cmpEmpty('Click an invoice to see it here.')}</aside></div>`;
// Both pages draw into whichever is open (one list on the screen at a time, so its parts keep their names)
async function cmpInvEnter(stage) {
  if (CMP_INV.stage !== stage) Object.assign(CMP_INV, { status: '', q: '', currency: '', selected: null });
  CMP_INV.stage = stage;
  document.querySelectorAll('[data-inv-host]').forEach(h => { h.innerHTML = ''; });
  const host = document.querySelector(`[data-inv-host="${stage}"]`); if (!host) return;
  host.innerHTML = cmpInvPageHtml(stage);
  $('#cmInvRange').innerHTML = cmpRangeBar('inv', cmpLoadInvoices);
  $('#cmInvExport').innerHTML = cmpCan('EXPORT') ? cmpBtn('Download (Excel)', "cmpDownload('/api/cmp/export/invoices?' + cmpInvQuery(), 'invoices.csv')") : '';
  await cmpLoadInvoices();
  if (S.routeArg) await cmpInvoiceByRef(decodeURIComponent(S.routeArg));
  else if (CMP_INV.selected) cmpInvoiceShow(CMP_INV.selected);
}
CMP_PAGES.push({ id: 'cm-invoices', html: () => '<div data-inv-host="created"></div>', enter: () => cmpInvEnter('created') });
CMP_PAGES.push({ id: 'cm-invoices-issued', html: () => '<div data-inv-host="issued"></div>', enter: () => cmpInvEnter('issued') });
const cmpInvQuery = () => cmpQs({ stage: CMP_INV.stage || 'created', status: CMP_INV.status, q: CMP_INV.q, currency: CMP_INV.currency, ...cmpRangeDates('inv') });
// #/cm-invoices/INV-2026-0001 (the address printed on an invoice) or #/cm-invoices/<id>: that invoice, whatever the dates chosen
async function cmpInvoiceByRef(ref) {
  try {
    let id = /^[0-9a-f-]{36}$/i.test(ref) ? ref : null;
    if (!id) { const d = await api('/api/cmp/invoices?' + cmpQs({ q: ref, limit: 20 })); const hit = d.invoices.find(i => i.number === ref); id = hit && hit.id; }
    if (!id) return toast(`Invoice ${ref} was not found.`);
    await cmpInvoiceShow(id);
    document.getElementById('cmInvView').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) { toast(err.message); }
}
async function cmpLoadInvoices() {
  let d;
  try { d = await api('/api/cmp/invoices?' + cmpInvQuery()); } catch (err) { $('#cmInvRows').innerHTML = `<tr><td colspan="4">${cmpEmpty(esc(err.message))}</td></tr>`; return; }
  const sums = {};
  for (const i of d.invoices) if (!['DRAFT', 'CANCELLED'].includes(i.status)) { sums[i.currency] = sums[i.currency] || { total: 0, out: 0 }; sums[i.currency].total += i.total; sums[i.currency].out += i.outstanding; }
  $('#cmInvTotals').innerHTML = `${esc(cmpRangeText('inv'))} · ${d.invoices.length}${d.total > d.invoices.length ? ` of ${d.total}` : ''} invoice${d.total === 1 ? '' : 's'}` + Object.entries(sums).map(([c, s]) => ` · ${cmpMoney(s.total, c)} invoiced, <b>${cmpMoney(s.out, c)}</b> outstanding`).join('');
  const small = 'px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap border bg-white hover:border-emerald-600';
  const acts = i => {
    if (i.status === 'DRAFT') return `<button type="button" class="needs-write ${small}" onclick="event.stopPropagation(); cmpInvoiceEdit('${i.id}', cmpLoadInvoices)">Edit draft</button>`;
    const out = [];
    if (cmpPayable(i)) out.push(`<button type="button" class="needs-write ${small} !border-emerald-600 text-emerald-800" onclick="event.stopPropagation(); cmpInvoiceShow('${i.id}', true)">+ Receipt</button>`);
    if (cmpPayable(i) && !i.sentAt) out.push(`<button type="button" class="needs-write ${small}" onclick="event.stopPropagation(); cmpInvoiceActOn('${i.id}', 'sent')">Mark sent</button>`);
    if (i.sentAt && i.status !== 'CANCELLED') out.push(`<button type="button" class="needs-write ${small}" title="Sent ${esc(cmpAt(i.sentAt))}" onclick="event.stopPropagation(); cmpInvoiceActOn('${i.id}', 'unsent')">↶ Not sent</button>`);
    return `<div class="flex flex-wrap gap-1">${out.join('')}</div>`;
  };
  $('#cmInvRows').innerHTML = d.invoices.map(i => `<tr data-inv="${i.id}" class="border-b last:border-0 hover:bg-slate-50 cursor-pointer align-top ${CMP_INV.selected === i.id ? 'bg-emerald-50' : ''}" onclick="${i.status === 'DRAFT' ? `cmpInvoiceEdit('${i.id}', cmpLoadInvoices)` : `cmpInvoiceShow('${i.id}')`}">
    <td class="py-2"><div class="font-medium whitespace-nowrap">${i.number ? esc(i.number) : '<span class="text-slate-400">(draft)</span>'}</div><div class="text-xs text-slate-500 whitespace-nowrap">${cmpDay(i.issueDate)}</div></td>
    <td class="py-2 min-w-[10rem]">${cmpCountry(i.client.country).flag} ${esc(i.client.name)}<div class="text-xs text-slate-500">${i.obligation ? `${esc(i.obligation.name)} · ${esc(CmpRules.periodName(i.obligation))}` : ''}</div></td>
    <td class="py-2 text-right whitespace-nowrap">${cmpMoney(i.total, i.currency)}<div class="text-xs ${i.outstanding > 0 && i.status !== 'CANCELLED' && i.status !== 'DRAFT' ? 'font-semibold text-slate-800' : 'text-slate-500'}">${['CANCELLED', 'DRAFT'].includes(i.status) ? '—' : `${cmpMoney(i.outstanding, i.currency)} due`}</div></td>
    <td class="py-2"><div class="flex flex-col items-start gap-1">${cmpInvChip(i.status)}${acts(i)}</div></td></tr>`).join('')
    || `<tr><td colspan="4">${cmpEmpty(CMP_INV_STAGES[CMP_INV.stage || 'created'].empty)}</td></tr>`;
}
async function cmpInvoiceActOn(id, what) {
  try { await api(`/api/cmp/invoices/${id}/${what}`, { method: 'POST' }); toast(what === 'sent' ? 'Marked as sent' : 'Marked as not sent', true); await cmpLoadInvoices(); if (CMP_INV.selected === id) cmpInvoiceShow(id); } catch (err) { toast(err.message); }
}

/* ---------- a new invoice: choose the client ---------- */
async function cmpInvoiceNew(clientId) {
  if (clientId) return cmpInvoiceDraft({ clientId });
  let list = [];
  try { list = (await api('/api/cmp/clients')).clients; } catch (err) { return toast(err.message); }
  cmpShowModal(`${cmpModalHead('New invoice', 'Choose the client. Its completed obligations are offered on the invoice.')}
    <label><span>Client</span><select id="cmInvClient">${list.map(c => `<option value="${c.id}">${cmpCountry(c.country).flag} ${esc(c.name)} (${esc(c.code)})</option>`).join('')}</select></label>
    <div class="flex justify-end gap-2 mt-4">${cmpBtn('Cancel', 'cmpCloseModal()')}${cmpBtn('Continue', "cmpInvoiceDraft({ clientId: $('#cmInvClient').value })", 'primary')}</div>`);
}
const cmpInvRefresh = () => { if (['cm-invoices', 'cm-invoices-issued'].includes(S.page)) cmpLoadInvoices(); else if (PAGE_ENTER[S.page]) PAGE_ENTER[S.page](); };
async function cmpInvoiceDraft(body, after) {
  try { const inv = await api('/api/cmp/invoices', { method: 'POST', body }); cmpInvoiceEdit(inv.id, typeof after === 'function' ? after : cmpInvRefresh); if (typeof after === 'function') after(); } catch (err) { toast(err.message); }
}
// the firm's invoice types (all of them; a country's active ones when asked)
async function cmpInvoiceTypes(country, force) {
  if (!CMP_INV.types || force) { try { CMP_INV.types = await api('/api/cmp/invoice-types?all=1'); } catch { CMP_INV.types = []; } }
  return country ? CMP_INV.types.filter(t => t.active && t.country === country) : CMP_INV.types;
}

/* ---------- the draft (the CA, 16 Nov 2026): two boxes — the client's completed obligations, and the other items and services (searchable,
   with every price billed before and its date) —, the invoice type of the client's country, the advance payments taken off it (gross,
   advance, net), and the invoice itself beside it, as it is typed ---------- */
async function cmpInvoiceEdit(id, after) {
  let inv, rates, items, billable, advances, types;
  try {
    inv = await api(`/api/cmp/invoices/${id}`);
    if (inv.status !== 'DRAFT') return cmpInvoiceOpen(id, after);
    [rates, items, billable, advances, types] = await Promise.all([api('/api/cmp/taxes?country=' + inv.client.country), api('/api/cmp/items?country=' + inv.client.country),
      api(`/api/cmp/clients/${inv.client.id}/billable?` + cmpQs({ invoiceId: inv.id, currency: inv.currency })), api(`/api/cmp/advances?clientId=${inv.client.id}`), cmpInvoiceTypes(inv.client.country, true)]);
  } catch (err) { return toast(err.message); }
  CMP_INV.edit = { inv, rates, items, billable, advances, types, after };
  const country = cmpCountry(inv.client.country);
  cmpShowModal(`${cmpModalHead('Draft invoice', `${country.flag} ${esc(inv.client.name)} · ${esc(inv.client.code)}`)}
    <div class="grid xl:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] gap-5 items-start">
    <div id="ciEditor" class="space-y-4 min-w-0" oninput="cmpInvoicePreviewSoon()" onchange="cmpInvoicePreviewSoon()">
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
        <label><span class="whitespace-nowrap">Currency <span class="text-slate-400">(${esc(country.currency)})</span></span><select id="ciCur" onchange="cmpInvoiceCurrency()">${CmpCountries.currencies.map(c => `<option value="${c.code}" ${c.code === inv.currency ? 'selected' : ''}>${c.code} · ${esc(c.name)}</option>`).join('')}</select></label>
        <label title="Empty: the day it is issued"><span class="whitespace-nowrap">Invoice date</span><input id="ciDate" type="date" value="${inv.issueDate}"></label>
        <label><span class="whitespace-nowrap">Payment due</span><input id="ciDue" type="date" value="${inv.dueDate}"></label>
        <label title="The invoice formats of ${esc(country.name)}"><span class="whitespace-nowrap">Invoice format</span><select id="ciType"><option value="">Standard</option>${types.map(t => `<option value="${t.id}" ${t.id === inv.typeId ? 'selected' : ''}>${esc(t.name)}${t.isDefault ? ' · default' : ''}</option>`).join('')}</select></label>
      </div>
      <section class="border rounded-lg p-3"><h3 class="text-sm font-semibold">Completed obligations <span class="font-normal text-slate-500">— of ${esc(inv.client.name)}, not billed yet; add as many as you like</span></h3>
        <div id="ciObLines" class="space-y-2 mt-2"></div><div id="ciObFree" class="mt-2"></div></section>
      <section class="border rounded-lg p-3"><div class="flex items-center justify-between gap-2"><h3 class="text-sm font-semibold">Other items and services <span class="font-normal text-slate-500">— type to search the ones billed before (each price with its date) or a new one</span></h3>
        <button type="button" class="text-sm text-emerald-700 underline whitespace-nowrap" onclick="cmpInvoiceLine()">+ Add line</button></div>
        <div id="ciLines" class="space-y-2 mt-2"></div></section>
      <div><div class="flex flex-wrap items-center justify-between gap-2 mb-1"><h3 class="text-sm font-medium">Taxes <span class="text-slate-400 font-normal">— each on the subtotal</span></h3>
        <div class="flex gap-2 items-center"><select id="ciSuggest" class="!w-auto !text-sm" onchange="cmpInvoiceSuggest(this)"><option value="">Add a saved tax…</option>${rates.map((r, i) => `<option value="${i}">${esc(r.name)} ${r.rate}%</option>`).join('')}</select>
          <button type="button" class="text-sm text-emerald-700 underline whitespace-nowrap" onclick="cmpInvoiceTax()">+ New tax</button></div></div>
        <div id="ciTaxes" class="space-y-2"></div></div>
      <section class="border rounded-lg p-3"><div class="flex items-center justify-between gap-2"><h3 class="text-sm font-semibold">Advance payments <span class="font-normal text-slate-500">— taken off this invoice</span></h3>
        <button type="button" class="text-sm text-emerald-700 underline whitespace-nowrap" onclick="cmpAdvanceForm({ clientId: '${inv.client.id}', country: '${inv.client.country}', occurrenceId: ((document.querySelector('#ciObLines .ciObLine') || {}).dataset || {}).occ }, cmpInvoiceAdvAdded)">+ Record an advance</button></div>
        <div id="ciAdv" class="mt-2 space-y-1.5"></div></section>
      <div id="ciTotals" class="ml-auto max-w-sm text-sm space-y-1"></div>
      <label><span>Notes on the invoice</span><textarea id="ciNotes" rows="2" maxlength="1000">${esc(inv.notes)}</textarea></label>
      <div class="flex flex-wrap justify-between gap-2">${cmpBtn('Delete draft', `cmpInvoiceDelete('${inv.id}')`, 'danger', 'needs-write')}
        <div class="flex gap-2">${cmpBtn('Create Invoice', 'cmpInvoiceSave(false)', 'plain', 'needs-write')}${cmpBtn('Create and Issue Invoice', 'cmpInvoiceSave(true)', 'primary', 'needs-write')}</div></div>
    </div>
    <aside class="min-w-0 xl:sticky xl:top-2"><div class="text-xs text-slate-500 mb-1">How it looks (as you type)</div>
      <div class="border rounded-lg bg-white overflow-auto max-h-[78vh] p-2"><div id="ciPreview" class="cmpDocFit"></div></div></aside>
    </div>`, { xl: true });
  for (const l of inv.lines) { if (l.occurrenceId) cmpInvoiceObLine(l); else cmpInvoiceLine(l); }
  inv.taxes.forEach(t => cmpInvoiceTax({ ...t, saved: rates.some(r => r.name.toLowerCase() === t.name.toLowerCase() && r.rate === t.rate) }));
  cmpInvoiceObFree(); cmpInvoiceAdvList(); cmpInvoiceTotals(); cmpInvoicePreview();
}
// The saved items of the client's country in the invoice's currency
const cmpItemsHere = () => CMP_INV.edit.items.filter(x => x.currency === $('#ciCur').value);
const cmpItemFind = name => cmpItemsHere().find(x => CmpRules.keyOf(x.name) === CmpRules.keyOf(name));
const cmpAmt = v => Number(String(v || '').replace(/[,\s]/g, '')) || 0;
const cmpFix = (n, cur) => Number(n).toFixed(CmpCountries.currencyDecimals(cur));
async function cmpInvoiceCurrency() {
  const e = CMP_INV.edit;
  try { e.billable = await api(`/api/cmp/clients/${e.inv.client.id}/billable?` + cmpQs({ invoiceId: e.inv.id, currency: $('#ciCur').value })); } catch { /* the prices stay as they were */ }
  document.querySelectorAll('#ciLines .ciLine').forEach(row => cmpInvoiceLineState(row));
  cmpInvoiceObFree(); cmpInvoiceAdvList(); cmpInvoiceTotals(); cmpInvoicePreviewSoon();
}

/* the first box: the completed obligations */
function cmpInvoiceObLine(l) {
  const e = CMP_INV.edit, b = (e.billable || []).find(x => x.occurrenceId === l.occurrenceId), prices = (b && b.prices) || [];
  $('#ciObLines').insertAdjacentHTML('beforeend', `<div class="ciLine ciObLine flex flex-wrap gap-2 items-center bg-emerald-50/60 border border-emerald-100 rounded-lg p-2" data-occ="${esc(l.occurrenceId)}" data-bank="${esc(l.bankName || (b ? b.name : ''))}">
    <label class="flex-1 min-w-[12rem]"><span class="sr-only">Description</span><input class="ciDesc" maxlength="300" value="${esc(l.description)}"></label>
    ${prices.length ? `<select class="!w-auto !text-xs" title="Prices billed before" onchange="if (this.value) { this.closest('.ciLine').querySelector('.ciAmt').value = this.value; cmpInvoiceTotals(); cmpInvoicePreviewSoon(); } this.value = ''"><option value="">Prices before…</option>${prices.map(p => `<option value="${p.amount}">${cmpMoney(p.amount, b.currency)} · ${esc(cmpDay(p.lastOn))}</option>`).join('')}</select>` : ''}
    <label class="w-32"><span class="sr-only">Amount</span><input class="ciAmt text-right" inputmode="decimal" placeholder="0.00" value="${l.amount ? esc(l.amount) : ''}" oninput="cmpInvoiceTotals()"></label>
    <label class="flex items-center gap-1 text-xs" title="Kept in the price bank under the obligation's name, with today's date"><input type="checkbox" class="ciSave" checked> Keep price</label>
    <button type="button" class="px-2 min-h-[2.5rem] text-red-600" onclick="this.closest('.ciLine').remove(); cmpInvoiceObFree(); cmpInvoiceTotals(); cmpInvoicePreviewSoon()" aria-label="Take it off">✕</button></div>`);
}
function cmpInvoiceObFree() {
  const e = CMP_INV.edit, on = new Set([...document.querySelectorAll('#ciObLines .ciObLine')].map(r => r.dataset.occ));
  const free = (e.billable || []).filter(b => !on.has(b.occurrenceId));
  $('#ciObFree').innerHTML = free.length ? `<div class="text-xs text-slate-500 mb-1">Completed, not billed yet:</div><div class="flex flex-col gap-1">${free.map(b => `<div class="flex flex-wrap items-center justify-between gap-2 text-sm border rounded-lg px-2 py-1.5">
      <span><b>${esc(b.name)}</b> · ${esc(b.period)} <span class="text-xs text-slate-500">completed ${esc(cmpDay(b.completedOn))}</span></span>
      <span class="flex items-center gap-2">${b.price !== null ? `<span class="text-xs text-slate-600">last ${cmpMoney(b.price, b.currency)}</span>` : ''}${cmpBtn('+ Add', `cmpInvoiceObAdd('${b.occurrenceId}')`)}</span></div>`).join('')}</div>`
    : `<div class="text-xs text-slate-500">${on.size ? 'Every completed obligation of this client is on an invoice.' : 'No completed obligation to bill: tasks completed on the tracker show here.'}</div>`;
}
function cmpInvoiceObAdd(occId) {
  const b = CMP_INV.edit.billable.find(x => x.occurrenceId === occId); if (!b) return;
  cmpInvoiceObLine({ occurrenceId: b.occurrenceId, description: `${b.name} — ${b.period}`, amount: b.price !== null ? cmpFix(b.price, b.currency) : '', bankName: b.name });
  cmpInvoiceObFree(); cmpInvoiceTotals(); cmpInvoicePreviewSoon();
}

/* the second box: other items and services, searchable, each price billed before with its date */
function cmpInvoiceLine(l = { description: '', amount: '' }) {
  const country = cmpCountry(CMP_INV.edit.inv.client.country);
  $('#ciLines').insertAdjacentHTML('beforeend', `<div class="ciLine flex flex-wrap gap-2 items-center" data-bank="${esc(l.bankName || '')}"><label class="flex-1 min-w-[12rem] relative"><span class="sr-only">Item or service</span>
      <input class="ciDesc" maxlength="300" placeholder="Search or type what the fee is for" autocomplete="off" value="${esc(l.description)}" oninput="cmpComboOpen(this); cmpInvoiceLineState(this.closest('.ciLine'))" onfocus="cmpComboOpen(this)" onblur="setTimeout(cmpComboClose, 150)" onkeydown="cmpComboKey(event, this)"></label>
    <label class="w-32"><span class="sr-only">Amount</span><input class="ciAmt text-right" inputmode="decimal" placeholder="0.00" value="${l.amount ? esc(l.amount) : ''}" oninput="cmpInvoiceTotals(); cmpInvoiceLineState(this.closest('.ciLine'))"></label>
    <label class="flex items-center gap-1 text-xs ciSaveWrap"><input type="checkbox" class="ciSave"> <span class="ciSaveText">Keep for ${esc(country.name)} clients</span></label>
    <button type="button" class="px-2 min-h-[2.5rem] text-red-600" onclick="this.closest('.ciLine').remove(); cmpInvoiceTotals(); cmpInvoicePreviewSoon()" aria-label="Remove line">✕</button></div>`);
  cmpInvoiceLineState($('#ciLines').lastElementChild, true);
}
// every price of every item, newest first: "VAT Amendment · AED 250.00 · 10 Nov 2026", "VAT Amendment · AED 200.00 · 12 Mar 2026"
function cmpComboOptions(q) {
  const words = CmpRules.keyOf(q).split(' ').filter(Boolean), out = [];
  for (const it of cmpItemsHere()) {
    const k = CmpRules.keyOf(it.name); if (!words.every(w => k.includes(w))) continue;
    const prices = it.prices && it.prices.length ? it.prices : [{ amount: it.amount, lastOn: String(it.updatedAt || '').slice(0, 10) }];
    for (const p of prices) out.push({ name: it.name, amount: p.amount, on: p.lastOn, currency: it.currency });
  }
  return out.slice(0, 80);
}
function cmpComboOpen(input) {
  CMP_INV.combo = { input, list: cmpComboOptions(input.value), i: -1 };
  let box = document.getElementById('ciCombo');
  if (!box) { document.body.insertAdjacentHTML('beforeend', '<div id="ciCombo" class="fixed z-[70] bg-white border rounded-lg shadow-xl max-h-72 overflow-y-auto hidden"></div>'); box = document.getElementById('ciCombo'); }
  const c = CMP_INV.combo, r = input.getBoundingClientRect();
  if (!c.list.length) { box.classList.add('hidden'); return; }
  Object.assign(box.style, { left: `${r.left}px`, top: `${r.bottom + 2}px`, width: `${Math.max(r.width, 320)}px` });
  box.innerHTML = c.list.map((o, i) => `<button type="button" data-i="${i}" class="block w-full text-left px-3 py-1.5 text-sm hover:bg-emerald-50 border-b last:border-0" onmousedown="event.preventDefault(); cmpComboPick(${i})">
    <b>${esc(o.name)}</b> <span class="text-slate-600">· ${cmpMoney(o.amount, o.currency)}</span> <span class="text-xs text-slate-400">· ${esc(cmpDay(o.on))}</span></button>`).join('');
  box.classList.remove('hidden');
}
function cmpComboClose() { const box = document.getElementById('ciCombo'); if (box) box.classList.add('hidden'); }
function cmpComboKey(ev, input) {
  const c = CMP_INV.combo, box = document.getElementById('ciCombo');
  if (!c || c.input !== input || !box || box.classList.contains('hidden')) return;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault(); c.i = Math.max(0, Math.min(c.list.length - 1, c.i + (ev.key === 'ArrowDown' ? 1 : -1)));
    box.querySelectorAll('button').forEach((b, i) => b.classList.toggle('bg-emerald-50', i === c.i)); box.querySelector(`[data-i="${c.i}"]`).scrollIntoView({ block: 'nearest' });
  } else if (ev.key === 'Enter' && c.i >= 0) { ev.preventDefault(); cmpComboPick(c.i); } else if (ev.key === 'Escape') { ev.stopPropagation(); cmpComboClose(); }
}
function cmpComboPick(i) {
  const c = CMP_INV.combo, o = c && c.list[i]; if (!o) return;
  const row = c.input.closest('.ciLine');
  c.input.value = o.name; row.dataset.bank = o.name; row.querySelector('.ciAmt').value = cmpFix(o.amount, o.currency);
  cmpComboClose(); cmpInvoiceLineState(row); cmpInvoiceTotals(); cmpInvoicePreviewSoon();
}
// "Keep" is ticked for a new item or a new price (the bank keeps both prices, each with its date), and says which
function cmpInvoiceLineState(row, first) {
  const desc = row.querySelector('.ciDesc').value.trim(), amt = cmpAmt(row.querySelector('.ciAmt').value), it = desc ? cmpItemFind(desc) : null;
  const box = row.querySelector('.ciSave'), text = row.querySelector('.ciSaveText'), country = cmpCountry(CMP_INV.edit.inv.client.country).name;
  const known = it && (it.prices && it.prices.length ? it.prices.some(p => Math.abs(p.amount - amt) < 1e-9) : Math.abs(it.amount - amt) < 1e-9);
  row.querySelector('.ciSaveWrap').classList.toggle('invisible', !desc || !amt);
  text.textContent = known ? 'Keep (the date moves on)' : it ? `Keep the new price for ${country} clients` : `Keep for ${country} clients`;
  if (first || !box.dataset.touched) box.checked = Boolean(desc && amt > 0);
  box.onchange = () => { box.dataset.touched = '1'; };
}
function cmpInvoiceTax(t = { name: '', rate: '', saved: false }) {
  const country = cmpCountry(CMP_INV.edit.inv.client.country);
  $('#ciTaxes').insertAdjacentHTML('beforeend', `<div class="ciTax flex flex-wrap gap-2 items-center"><input class="ciTaxName flex-1 min-w-[8rem]" maxlength="60" placeholder="e.g. VAT" value="${esc(t.name)}">
    <div class="flex items-center gap-1 w-28"><input class="ciTaxRate text-right" inputmode="decimal" placeholder="5" value="${t.rate === '' ? '' : esc(t.rate)}" oninput="cmpInvoiceTotals()"><span>%</span></div>
    ${t.saved ? `<span class="text-xs text-slate-500">saved for ${esc(country.name)}</span>` : `<label class="flex items-center gap-1 text-xs"><input type="checkbox" class="ciTaxSave" checked> Keep for ${esc(country.name)} clients</label>`}
    <button type="button" class="px-2 min-h-[2.5rem] text-red-600" onclick="this.closest('.ciTax').remove(); cmpInvoiceTotals(); cmpInvoicePreviewSoon()" aria-label="Remove tax">✕</button></div>`);
}
function cmpInvoiceSuggest(sel) {
  const r = CMP_INV.edit.rates[Number(sel.value)]; sel.value = '';
  if (!r) return;
  cmpInvoiceTax({ name: r.name, rate: r.rate, saved: true }); cmpInvoiceTotals(); cmpInvoicePreviewSoon();
}

/* the advance payments of the client in this currency, each with what is left of it, and how much of it this invoice takes off */
function cmpInvoiceAdvList() {
  const e = CMP_INV.edit, cur = $('#ciCur').value, mine = new Map((e.inv.advanceUse || []).map(u => [u.advanceId, u.amount]));
  const list = (e.advances || []).filter(a => a.currency === cur && (a.available > 0 || mine.has(a.id)));
  const prev = new Map([...document.querySelectorAll('#ciAdv .ciAdvRow')].map(r => [r.dataset.id, { on: r.querySelector('.ciAdvOn').checked, amt: r.querySelector('.ciAdvAmt').value }]));
  $('#ciAdv').innerHTML = list.length ? list.map(a => {
    const p = prev.get(a.id), on = p ? p.on : mine.has(a.id), amt = p ? p.amt : mine.has(a.id) ? cmpFix(mine.get(a.id), cur) : '';
    return `<div class="ciAdvRow flex flex-wrap items-center gap-2 text-sm" data-id="${a.id}" data-left="${a.available}" data-total="${a.amount}" data-on="${esc(a.receivedOn)}" data-desc="${esc(a.description)}">
      <label class="flex items-center gap-2 flex-1 min-w-[14rem]"><input type="checkbox" class="ciAdvOn" ${on ? 'checked' : ''} onchange="cmpInvoiceAdvToggle(this)"> <span>${esc(cmpDay(a.receivedOn))} · ${esc(a.description)} · <b>${cmpMoney(a.amount, a.currency)}</b> <span class="text-xs text-slate-500">(${cmpMoney(a.available, a.currency)} left)</span></span></label>
      <button type="button" class="needs-write text-xs underline text-slate-600 hover:text-emerald-700" onclick="cmpAdvanceEdit('${a.id}', cmpInvoiceAdvAdded)">✎ change</button>
      <label class="w-32"><span class="sr-only">Taken off</span><input class="ciAdvAmt text-right" inputmode="decimal" placeholder="0.00" value="${esc(amt)}" ${on ? '' : 'disabled'} oninput="cmpInvoiceTotals()"></label></div>`;
  }).join('') : `<div class="text-xs text-slate-500">No advance payment in ${esc(cur)} to take off. Record one with "+ Record an advance" (or from the tracker).</div>`;
}
function cmpInvoiceAdvToggle(box) {
  const row = box.closest('.ciAdvRow'), amt = row.querySelector('.ciAdvAmt');
  amt.disabled = !box.checked;
  if (box.checked && !amt.value) { const t = cmpInvoiceTotals(true); amt.value = cmpFix(Math.max(0, Math.min(Number(row.dataset.left), (t.gross - t.adv) / 10 ** t.d)), $('#ciCur').value); }
  cmpInvoiceTotals(); cmpInvoicePreviewSoon();
}
async function cmpInvoiceAdvAdded() {
  const e = CMP_INV.edit;
  try { e.advances = await api(`/api/cmp/advances?clientId=${e.inv.client.id}`); } catch { return; }
  cmpInvoiceAdvList(); cmpInvoiceTotals(); cmpInvoicePreviewSoon();
}
// The same sums as the server: in whole minor units, each tax rounded on the subtotal; then the advance taken off (the CA: gross, advance, net)
function cmpInvoiceTotals(quiet) {
  const cur = $('#ciCur').value, d = CmpCountries.currencyDecimals(cur), minor = n => Math.round(cmpAmt(n) * 10 ** d);
  const sub = [...document.querySelectorAll('#ciEditor .ciAmt')].reduce((m, i) => m + minor(i.value), 0);
  const taxes = [...document.querySelectorAll('#ciTaxes .ciTax')].map(row => ({ name: row.querySelector('.ciTaxName').value || 'Tax', rate: Number(row.querySelector('.ciTaxRate').value) || 0 }))
    .map(t => ({ ...t, minor: Math.round(sub * t.rate / 100) }));
  const gross = sub + taxes.reduce((m, t) => m + t.minor, 0), f = m => cmpMoney(m / 10 ** d, cur);
  const advRows = [...document.querySelectorAll('#ciAdv .ciAdvRow')].filter(r => r.querySelector('.ciAdvOn').checked);
  const adv = advRows.reduce((m, r) => m + minor(r.querySelector('.ciAdvAmt').value), 0), advTotal = advRows.reduce((m, r) => m + minor(r.dataset.total), 0);
  const out = { cur, d, sub, taxes, gross, adv, advTotal };
  if (quiet) return out;
  $('#ciTotals').innerHTML = `<div class="flex justify-between"><span>Subtotal</span><span>${f(sub)}</span></div>${taxes.map(t => `<div class="flex justify-between text-slate-600"><span>${esc(t.name)} ${t.rate}%</span><span>${f(t.minor)}</span></div>`).join('')}
    <div class="flex justify-between font-semibold border-t pt-1"><span>${adv ? 'Gross amount' : 'Total'}</span><span>${f(gross)}</span></div>
    ${adv ? `<div class="flex justify-between text-slate-600"><span>Advance received</span><span>${f(advTotal)}</span></div><div class="flex justify-between text-sky-800"><span>Advance payment adjustment</span><span>− ${f(adv)}</span></div>
      <div class="flex justify-between font-semibold border-t pt-1"><span>Net amount</span><span>${f(gross - adv)}</span></div>${adv > gross ? '<div class="text-xs text-red-700">The advance taken off is more than the gross amount.</div>' : ''}` : ''}`;
  return out;
}
// The draft as it is typed, to draw it beside (the CA: the invoice is seen while it is made)
function cmpInvoiceDraftNow() {
  const e = CMP_INV.edit, t = cmpInvoiceTotals(true), m = n => n / 10 ** t.d;
  const lines = [...document.querySelectorAll('#ciObLines .ciLine'), ...document.querySelectorAll('#ciLines .ciLine')].map(r => ({ description: r.querySelector('.ciDesc').value, amount: cmpAmt(r.querySelector('.ciAmt').value) })).filter(l => l.description || l.amount);
  const advanceDetails = [...document.querySelectorAll('#ciAdv .ciAdvRow')].filter(r => r.querySelector('.ciAdvOn').checked).map(r => ({ adjusted: cmpAmt(r.querySelector('.ciAdvAmt').value), amount: Number(r.dataset.total), receivedOn: r.dataset.on, description: r.dataset.desc }));
  return { ...e.inv, currency: t.cur, issueDate: $('#ciDate').value, dueDate: $('#ciDue').value, notes: $('#ciNotes').value, typeId: $('#ciType').value || null, typeSnapshot: null, lines,
    taxes: t.taxes.map(x => ({ name: x.name, rate: x.rate, amount: m(x.minor) })), subtotal: m(t.sub), total: m(t.gross), advanceAdjusted: m(t.adv), advanceDetails, received: 0, outstanding: m(t.gross - t.adv), status: 'DRAFT', number: null };
}
function cmpInvoicePreview() { const box = document.getElementById('ciPreview'); if (box && CMP_INV.edit) { box.innerHTML = cmpInvoiceDoc(cmpInvoiceDraftNow(), CMP.settings || {}); cmpFitDocs(box.parentElement); } }
function cmpInvoicePreviewSoon() { clearTimeout(CMP_INV.prevTimer); CMP_INV.prevTimer = setTimeout(() => { cmpInvoiceTotals(); cmpInvoicePreview(); }, 120); }
// Items and taxes billed before at another price or rate (the CA: warned, then both are kept, each with its date)
function cmpInvoiceChanges() {
  const out = [], cur = $('#ciCur').value;
  for (const r of document.querySelectorAll('#ciLines .ciLine, #ciObLines .ciLine')) {
    const name = r.dataset.bank || r.querySelector('.ciDesc').value.trim(), amt = cmpAmt(r.querySelector('.ciAmt').value), save = r.querySelector('.ciSave');
    const it = CMP_INV.edit.items.find(x => x.currency === cur && CmpRules.keyOf(x.name) === CmpRules.keyOf(name));
    const prices = it ? (it.prices && it.prices.length ? it.prices.map(p => p.amount) : [it.amount]) : [];
    if (it && amt > 0 && save && save.checked && !prices.some(p => Math.abs(p - amt) < 1e-9)) out.push(`${it.name}: ${cmpMoney(amt, cur)} (billed before at ${prices.map(p => cmpMoney(p, cur)).join(', ')})`);
  }
  for (const r of document.querySelectorAll('#ciTaxes .ciTax')) {
    const name = r.querySelector('.ciTaxName').value.trim(), rate = Number(r.querySelector('.ciTaxRate').value), keep = r.querySelector('.ciTaxSave');
    const same = CMP_INV.edit.rates.filter(x => x.name.toLowerCase() === name.toLowerCase());
    if (keep && keep.checked && same.length && !same.some(x => x.rate === rate)) out.push(`${name}: ${rate}% (saved before at ${same.map(x => `${x.rate}%`).join(', ')})`);
  }
  return out;
}
async function cmpInvoiceSave(issue) {
  const changes = cmpInvoiceChanges();
  if (changes.length && !confirm(`These are already saved at another price or rate:\n\n${changes.join('\n')}\n\nThe new ones are kept too, each with its date (the earlier ones stay). Continue?`)) return;
  const e = CMP_INV.edit, line = r => ({ description: r.querySelector('.ciDesc').value, amount: r.querySelector('.ciAmt').value || '0', save: Boolean(r.querySelector('.ciSave') && r.querySelector('.ciSave').checked && !(r.querySelector('.ciSaveWrap') || { classList: { contains: () => false } }).classList.contains('invisible')),
    occurrenceId: r.dataset.occ || undefined, bankName: r.dataset.bank && (r.dataset.occ || CmpRules.keyOf(r.dataset.bank) === CmpRules.keyOf(r.querySelector('.ciDesc').value)) ? r.dataset.bank : undefined });
  const body = { currency: $('#ciCur').value, issueDate: $('#ciDate').value, dueDate: $('#ciDue').value, notes: $('#ciNotes').value, typeId: $('#ciType').value || null,
    lines: [...[...document.querySelectorAll('#ciObLines .ciLine')].map(line), ...[...document.querySelectorAll('#ciLines .ciLine')].map(line)],
    taxes: [...document.querySelectorAll('#ciTaxes .ciTax')].map(r => ({ name: r.querySelector('.ciTaxName').value, rate: r.querySelector('.ciTaxRate').value, save: Boolean(r.querySelector('.ciTaxSave') && r.querySelector('.ciTaxSave').checked) })),
    advances: [...document.querySelectorAll('#ciAdv .ciAdvRow')].filter(r => r.querySelector('.ciAdvOn').checked).map(r => ({ advanceId: r.dataset.id, amount: r.querySelector('.ciAdvAmt').value || '0' })) };
  try {
    await api(`/api/cmp/invoices/${e.inv.id}`, { method: 'PUT', body });
    if (issue) { if (!confirm('Issue this invoice? It gets its number and can no longer be changed (only cancelled).')) return; await api(`/api/cmp/invoices/${e.inv.id}/issue`, { method: 'POST' }); toast('Invoice issued', true); }
    else toast('Invoice created (not issued yet: it has no number until it is issued)', true);
    if (e.after) e.after();
    if (issue && ['cm-invoices', 'cm-invoices-issued'].includes(S.page)) { cmpCloseModal(); cmpInvoiceShow(e.inv.id); } else if (issue) cmpInvoiceOpen(e.inv.id, e.after); else cmpCloseModal();
  } catch (err) { toast(err.message); }
}
async function cmpInvoiceDelete(id) {
  if (!confirm('Delete this draft?')) return;
  try { await api(`/api/cmp/invoices/${id}`, { method: 'DELETE' }); cmpCloseModal(); toast('Draft deleted', true); if (CMP_INV.edit && CMP_INV.edit.after) CMP_INV.edit.after(); } catch (err) { toast(err.message); }
}

/* ---------- the document: an invoice, or a receipt, as its invoice type says (the CA: country sensitive formats, extra information placed
   anywhere by drag and drop). The page is A4 less the print margins, so what is placed on the screen prints at the same place. ---------- */
const CMP_PAGE = { w: 178, h: 265 }; // mm
// The page drawn to fit the box it is in (beside the list, the draft's preview, the settings' preview): never larger than itself
function cmpFitDocs(root = document) {
  root.querySelectorAll('.cmpDocFit').forEach(el => { const w = el.parentElement.clientWidth - 18; if (w > 0) el.style.zoom = String(Math.min(1, Math.max(0.3, w / (CMP_PAGE.w * 96 / 25.4)))); });
}
window.addEventListener('resize', () => cmpFitDocs());
// The layout a document is printed with: a receipt's own receipt format (frozen when it was made), else the invoice's format
function cmpDocLayout(inv, receipt) {
  if (receipt && receipt.typeSnapshot && receipt.typeSnapshot.layout) return receipt.typeSnapshot.layout;
  if (inv.typeSnapshot && inv.typeSnapshot.layout) return inv.typeSnapshot.layout;
  const t = inv.typeId && (CMP_INV.types || []).find(x => x.id === inv.typeId);
  return t ? t.layout : null;
}
// an extra block's text with its [placeholders] filled in (unknown ones stay as typed)
function cmpDocText(text, inv, s, receipt) {
  const net = Number(inv.total) - Number(inv.advanceAdjusted || 0), c = inv.client || {};
  return CmpRules.render(text, { client: c, countryName: cmpCountry(c.country).name,
    invoice: { number: inv.number || 'DRAFT', date: inv.issueDate, dueDate: inv.dueDate, amountText: cmpMoney(net, inv.currency), outstandingText: cmpMoney(inv.outstanding, inv.currency) },
    receipt: receipt ? { number: receipt.number, date: receipt.receivedOn, amountText: cmpMoney(receipt.amount, inv.currency) } : {}, firm: { name: s.firmName || '', phone: s.firmPhone || '', email: s.firmEmail || '' } }).text;
}
function cmpDocBlocks(L, inv, s, receipt, { edit = false } = {}) {
  return (L.blocks || []).filter(b => (b.doc || 'INVOICE') === (receipt ? 'RECEIPT' : 'INVOICE')).map(b => `<div data-block="${esc(b.id)}" style="position:absolute;left:${(CMP_PAGE.w * b.x / 100).toFixed(1)}mm;top:${(CMP_PAGE.h * b.y / 100).toFixed(1)}mm;width:${(CMP_PAGE.w * b.w / 100).toFixed(1)}mm;font-size:${b.size}px;font-weight:${b.bold ? 700 : 400};text-align:${b.align};white-space:pre-wrap;line-height:1.35;${b.border ? 'border:1px solid #94a3b8;padding:1.5mm;' : ''}${edit ? 'cursor:move;outline:1px dashed #10b981;background:rgba(236,253,245,.55);touch-action:none;' : ''}">${esc(cmpDocText(b.text, inv, s, receipt))}</div>`).join('');
}
function cmpInvoiceDoc(inv, s, receipt, { layout, edit = false } = {}) {
  const L = layout || cmpDocLayout(inv, receipt) || {}, c = inv.client || {}, cur = inv.currency;
  const firm = L.firmName || s.firmName || S.company || '', addr = L.firmAddress || s.firmAddress || '';
  const taxNo = L.taxNo || s.firmTaxNo || '', taxLine = taxNo ? `${esc(L.taxLabel || 'Tax registration no.')}: ${esc(taxNo)}` : '';
  const bank = L.showBank === false ? '' : (L.bankDetails || s.bankDetails || ''), footer = L.footer || s.invoiceFooter || '';
  const style = L.headerStyle && L.headerStyle !== 'DEFAULT' ? L.headerStyle : (s.headerStyle === 'LETTERHEAD' ? 'LETTERHEAD' : 'LOGO');
  const title = `<div style="text-align:right"><div style="font-size:22px;font-weight:700;letter-spacing:.05em">${esc(receipt ? (L.receiptTitle || 'RECEIPT') : (L.invoiceTitle || 'INVOICE'))}</div>
        <div style="font-size:13px"><b>${esc(receipt ? receipt.number : inv.number || 'DRAFT')}</b></div>
        <div style="font-size:12px">Date: ${esc(CmpRules.fmtDay(receipt ? receipt.receivedOn : inv.issueDate) || '—')}</div>
        ${!receipt && inv.dueDate ? `<div style="font-size:12px">Payment due: ${esc(CmpRules.fmtDay(inv.dueDate))}</div>` : ''}${receipt ? `<div style="font-size:12px">For invoice ${esc(inv.number)}</div>` : ''}</div>`;
  // the top: nothing but the title, a full letterhead picture (the CA), or the logo, the header line and the firm's details
  const top = style === 'NONE' ? `<div style="display:flex;justify-content:space-between;gap:24px;align-items:flex-start"><div style="font-size:12px">${taxLine}</div>${title}</div>`
    : style === 'LETTERHEAD' && s.letterhead
      ? `<img src="${esc(s.letterhead)}" alt="" style="display:block;width:100%;max-height:55mm;object-fit:contain;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;gap:24px;align-items:flex-start"><div style="font-size:12px">${taxLine}</div>${title}</div>`
      : `${s.invoiceHeader ? `<div style="text-align:center;font-size:12px;color:#334155;white-space:pre-wrap;border-bottom:1px solid #e2e8f0;padding-bottom:6px;margin-bottom:12px">${esc(s.invoiceHeader)}</div>` : ''}
    <div style="display:flex;justify-content:space-between;gap:24px;align-items:flex-start">
      <div style="display:flex;gap:12px;align-items:flex-start">${s.logo ? `<img src="${esc(s.logo)}" alt="" style="max-height:64px;max-width:160px;object-fit:contain">` : ''}
        <div><div style="font-size:20px;font-weight:700">${esc(firm)}</div><div style="white-space:pre-wrap;font-size:12px;color:#334155">${esc(addr)}</div>
        <div style="font-size:12px;color:#334155">${[s.firmPhone, s.firmEmail].filter(Boolean).map(esc).join(' · ')}</div>${taxLine ? `<div style="font-size:12px">${taxLine}</div>` : ''}</div></div>
      ${title}</div>`;
  const head = `${top}
    <div style="margin:18px 0 12px;font-size:13px"><div style="color:#64748b;font-size:11px;text-transform:uppercase">${receipt ? 'Received from' : 'Bill to'}</div><b>${esc(c.name)}</b>
      <div style="white-space:pre-wrap">${esc(c.address || '')}</div><div>${esc(cmpCountry(c.country).name)}${c.registrationNo && L.showClientTaxNo !== false ? ` · Registration No. ${esc(c.registrationNo)}` : ''}</div></div>`;
  const td = 'padding:6px 8px;border-bottom:1px solid #e2e8f0', tr = (a, b, bold, color) => `<tr><td style="${td};text-align:right;${bold ? 'font-weight:700;' : ''}${color ? `color:${color};` : ''}">${a}</td><td style="${td};text-align:right;white-space:nowrap;${bold ? 'font-weight:700;' : ''}${color ? `color:${color};` : ''}">${b}</td></tr>`;
  const adv = Number(inv.advanceAdjusted || 0), net = Number(inv.total) - adv, det = inv.advanceDetails || [], advTotal = det.reduce((m, a) => m + Number(a.amount), 0);
  const page = inner => `<div class="cmpDoc" style="position:relative;width:${CMP_PAGE.w}mm;min-height:${CMP_PAGE.h}mm;box-sizing:border-box;font-family:system-ui,sans-serif;color:#0f172a">${inner}${cmpDocBlocks(L, inv, s, receipt, { edit })}</div>`;
  if (receipt) {
    return page(`${head}
      <p style="font-size:14px;margin:16px 0">Received with thanks the sum of <b>${cmpMoney(receipt.amount, cur)}</b> by ${esc((CMP_METHODS[receipt.method] || receipt.method).toLowerCase())}${receipt.reference ? ` (ref. ${esc(receipt.reference)})` : ''}, against invoice ${esc(inv.number)} of ${cmpMoney(adv ? net : inv.total, cur)}.</p>
      ${L.receiptNote ? `<p style="font-size:12px;white-space:pre-wrap;margin:0 0 12px">${esc(L.receiptNote)}</p>` : ''}
      <table style="width:100%;border-collapse:collapse;font-size:13px">${adv ? tr('Gross amount', cmpMoney(inv.total, cur)) + tr('Advance adjusted', `− ${cmpMoney(adv, cur)}`) : ''}${tr(adv ? 'Net amount' : 'Invoice total', cmpMoney(adv ? net : inv.total, cur))}${tr('Received to date', cmpMoney(inv.received, cur))}${tr('Still owed', cmpMoney(inv.outstanding, cur), true)}</table>
      ${receipt.voidedAt ? `<p style="color:#b91c1c;font-weight:700;margin-top:12px">VOID: ${esc(receipt.voidReason)}</p>` : ''}
      <div style="margin-top:40px;font-size:12px;color:#475569;white-space:pre-wrap">${esc(footer)}</div>`);
  }
  return page(`${head}
    <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#f1f5f9"><th style="${td};text-align:left">Description</th><th style="${td};text-align:right">Amount (${esc(cur)})</th></tr></thead><tbody>
      ${(inv.lines || []).map(l => `<tr><td style="${td}">${esc(l.description)}</td><td style="${td};text-align:right;white-space:nowrap">${cmpMoney(l.amount, cur)}</td></tr>`).join('')}</tbody></table>
    <table style="margin-left:auto;margin-top:8px;border-collapse:collapse;font-size:13px;min-width:75mm">${tr('Subtotal', cmpMoney(inv.subtotal, cur))}${(inv.taxes || []).map(t => tr(`${esc(t.name)} ${t.rate}%`, cmpMoney(t.amount, cur))).join('')}${tr(adv ? 'Gross amount' : 'Total', cmpMoney(inv.total, cur), true)}
      ${adv ? `${advTotal ? tr('Advance received', cmpMoney(advTotal, cur)) : ''}${tr('Advance payment adjustment', `− ${cmpMoney(adv, cur)}`, false, '#075985')}${tr('Net amount', cmpMoney(net, cur), true)}` : ''}
      ${inv.received ? tr('Received', cmpMoney(inv.received, cur)) + tr('Outstanding', cmpMoney(inv.outstanding, cur), true) : ''}</table>
    ${adv && advTotal > adv + 1e-9 ? `<p style="font-size:11px;color:#475569;text-align:right;margin-top:4px">Advance not taken off here (kept for later): ${cmpMoney(det.reduce((m, a) => m + Number(a.amount) - Number(a.used ?? a.adjusted), 0), cur)}</p>` : ''}
    ${inv.status === 'CANCELLED' ? `<p style="color:#b91c1c;font-weight:700;margin-top:12px">CANCELLED: ${esc(inv.cancelReason)}</p>` : ''}
    ${inv.notes ? `<p style="font-size:12px;margin-top:16px;white-space:pre-wrap">${esc(inv.notes)}</p>` : ''}
    ${bank ? `<div style="margin-top:16px;font-size:12px"><div style="color:#64748b;font-size:11px;text-transform:uppercase">Payment details</div><div style="white-space:pre-wrap">${esc(bank)}</div></div>` : ''}
    <div style="margin-top:32px;font-size:12px;color:#475569;white-space:pre-wrap">${esc(footer)}</div>`);
}

/* ---------- an issued invoice with everything that can be done to it: beside the list (the invoices page), or in a window ---------- */
function cmpInvoiceViewHtml(inv, inPanel) {
  const s = CMP.settings || {}, live = inv.status !== 'CANCELLED', payable = cmpPayable(inv), wa = cmpCan('WHATSAPP') && !inv.client.noWhatsApp;
  return `<div class="flex items-start justify-between gap-3 mb-3"><div class="min-w-0"><h2 class="text-lg font-semibold">Invoice ${esc(inv.number)} ${cmpInvChip(inv.status)}</h2>
      <div class="text-sm text-slate-500">${cmpCountry(inv.client.country).flag} ${esc(inv.client.name)} · issued ${esc(cmpAt(inv.issuedAt))} by ${esc(inv.issuedBy || '')}${inv.sentAt ? ` · sent ${esc(cmpAt(inv.sentAt))}` : ''}${inv.typeSnapshot ? ` · ${esc(inv.typeSnapshot.name)}` : ''}</div></div>
    <button type="button" onclick="${inPanel ? 'cmpInvoiceHide()' : 'cmpCloseModal()'}" class="text-slate-400 hover:text-slate-700 text-2xl leading-none px-2" aria-label="Close">×</button></div>
    <div class="flex flex-wrap gap-2 mb-3">
      ${cmpBtn('Print / PDF', 'cmpInvoicePrint()', 'primary')}
      ${live && wa ? cmpBtn(`${CMP_WA_ICON} WhatsApp`, `cmpInvoiceWhatsApp({ invoiceId: '${inv.id}' })`, 'wa', 'needs-write') : ''}
      ${payable && !inv.sentAt ? cmpBtn('Mark as sent', `cmpInvoiceAct('sent')`, 'plain', 'needs-write') : ''}
      ${live && inv.sentAt ? cmpBtn('↶ Undo "sent"', `cmpInvoiceAct('unsent')`, 'plain', 'needs-write') : ''}
      ${payable ? cmpBtn('+ Receipt', 'cmpReceiptForm()', 'plain', 'needs-write') : ''}
      ${live ? cmpBtn('Cancel invoice', 'cmpInvoiceCancel()', 'danger', 'needs-write') : ''}
      ${!inPanel && cmpCan('INVOICE') ? cmpBtn('Open in Invoices', `cmpCloseModal(); location.hash = '#/cm-invoices/${encodeURIComponent(inv.number || inv.id)}'`) : ''}
    </div>
    <div id="cmRcpForm"></div>
    ${(inv.clientCredit || []).length ? `<p class="text-xs text-sky-800 bg-sky-50 border border-sky-200 rounded px-3 py-2 mb-3">${esc(inv.client.name)} has credit: <b>${inv.clientCredit.map(c => cmpMoney(c.remaining, c.currency)).join(', ')}</b>. It can pay this invoice: + Receipt → Paid by: Client credit.</p>` : ''}
    ${inv.status === 'CANCELLED' && inv.cancelSettlement ? `<p class="text-xs text-slate-700 bg-slate-50 border rounded px-3 py-2 mb-3">Money received was <b>${{ VOID: 'voided', REFUND: 'refunded', CREDIT: 'kept as the client\'s credit' }[inv.cancelSettlement]}</b> when it was cancelled.</p>` : ''}
    ${s.firmName ? '' : `<p class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3">The firm's name, logo, address and bank details for invoices are set under Invoice and Receipt Format.</p>`}
    <div class="border rounded-lg p-3 bg-white overflow-hidden"><div class="cmpDocFit">${cmpInvoiceDoc(inv, s)}</div></div>
    <h3 class="font-medium mt-4 mb-2">Receipts</h3>
    ${inv.receipts.length ? `<div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-1">Receipt</th><th>Date</th><th class="text-right">Amount</th><th>Paid by</th><th></th></tr></thead><tbody>
      ${inv.receipts.map(r => `<tr class="border-b last:border-0 ${r.voidedAt ? 'opacity-60' : ''}"><td class="py-1.5 ${r.voidedAt ? 'line-through' : ''}">${esc(r.number)}</td><td class="whitespace-nowrap">${cmpDay(r.receivedOn)}</td><td class="text-right whitespace-nowrap">${cmpMoney(r.amount, inv.currency)}</td>
        <td>${esc(CMP_METHODS[r.method] || r.method)}${r.reference ? ` · ${esc(r.reference)}` : ''}${r.voidedAt ? `<div class="text-xs text-red-700">void: ${esc(r.voidReason)}</div>` : ''}${r.settlement ? `<div class="mt-0.5">${cmpSettleChip(r)} <span class="text-xs text-slate-500">${esc(r.settlementNote)}</span></div>` : ''}</td>
        <td class="text-right"><div class="flex flex-wrap justify-end gap-1">${cmpBtn('Print', `cmpReceiptPrint('${r.id}')`)}${!r.voidedAt && wa ? cmpBtn('WhatsApp', `cmpInvoiceWhatsApp({ receiptId: '${r.id}' })`, 'plain', 'needs-write') : ''}${cmpReceiptLive(r) ? cmpBtn('↶ Undo', `cmpReceiptVoid('${r.id}')`, 'danger', 'needs-write') : ''}</div></td></tr>`).join('')}</tbody></table></div>`
      : `<p class="text-sm text-slate-500">None yet.${payable ? ' Record one with <b>+ Receipt</b>.' : ''}</p>`}
    ${inPanel ? '' : `<div class="flex justify-end mt-4">${cmpBtn('Close', 'cmpCloseModal()')}</div>`}`;
}
// Beside the list (the invoices page)
async function cmpInvoiceShow(id, receipt) {
  let inv;
  try { inv = await api(`/api/cmp/invoices/${id}`); } catch (err) { return toast(err.message); }
  if (inv.status === 'DRAFT') return cmpInvoiceEdit(id, cmpLoadInvoices);
  CMP_INV.selected = id;
  CMP_INV.open = { inv, after: cmpLoadInvoices, panel: true };
  const box = document.getElementById('cmInvView'); if (!box) return cmpInvoiceOpen(id);
  box.innerHTML = cmpInvoiceViewHtml(inv, true); cmpFitDocs(box);
  document.querySelectorAll('#cmInvRows tr[data-inv]').forEach(tr => tr.classList.toggle('bg-emerald-50', tr.dataset.inv === id));
  if (window.innerWidth < 1280) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (receipt) cmpReceiptForm();
}
function cmpInvoiceHide() { CMP_INV.selected = null; const box = document.getElementById('cmInvView'); if (box) box.innerHTML = cmpEmpty('Click an invoice to see it here.'); document.querySelectorAll('#cmInvRows tr[data-inv]').forEach(tr => tr.classList.remove('bg-emerald-50')); }
// In a window (from a client's page, the sheet, a report)
async function cmpInvoiceOpen(id, after) {
  let inv;
  try { inv = await api(`/api/cmp/invoices/${id}`); } catch (err) { return toast(err.message); }
  if (inv.status === 'DRAFT') return cmpInvoiceEdit(id, after);
  CMP_INV.open = { inv, after, panel: false };
  cmpShowModal(cmpInvoiceViewHtml(inv, false), { wide: true }); cmpFitDocs();
}
// After any change: the list, and the invoice drawn again where it is shown
async function cmpInvoiceRedraw() {
  const o = CMP_INV.open; if (!o) return;
  if (o.after) await o.after();
  if (o.panel) await cmpInvoiceShow(o.inv.id); else await cmpInvoiceOpen(o.inv.id, o.after);
}
// A receipt against an invoice, from anywhere (the sheet, the receipts page): the invoice in a window with the receipt form open
async function cmpQuickReceipt(invoiceId, after) {
  await cmpInvoiceOpen(invoiceId, after);
  if (CMP_INV.open && CMP_INV.open.inv.id === invoiceId && cmpPayable(CMP_INV.open.inv)) cmpReceiptForm();
}

/* ---------- printing: the invoice's own web address in the browser's footer (the CA), and its number as the title and file name ---------- */
const cmpPrintA4 = html => posPrint(`<div style="padding:4mm">${html}</div>`, '@page { size: A4; margin: 12mm; }');
function cmpPrintDoc(html, title, ref) {
  const oldTitle = document.title, oldUrl = location.href;
  document.title = title;
  if (ref) history.replaceState(history.state, '', ref);
  const back = () => { document.title = oldTitle; if (ref) history.replaceState(history.state, '', oldUrl); window.removeEventListener('afterprint', back); };
  window.addEventListener('afterprint', back);
  cmpPrintA4(html);
}
function cmpInvoicePrint() {
  const inv = CMP_INV.open.inv, s = CMP.settings || {};
  cmpPrintDoc(cmpInvoiceDoc(inv, s), `Invoice ${inv.number} · ${s.firmName || S.company || ''}`, `#/cm-invoices/${encodeURIComponent(inv.number)}`);
}
function cmpReceiptPrint(id) {
  const inv = CMP_INV.open.inv, s = CMP.settings || {}, r = inv.receipts.find(x => x.id === id);
  cmpPrintDoc(cmpInvoiceDoc(inv, s, r), `Receipt ${r.number} · ${s.firmName || S.company || ''}`, `#/cm-receipts/${encodeURIComponent(r.number)}`);
}
async function cmpInvoiceWhatsApp(what) {
  let t = [];
  try { t = await cmpTemplates(true); } catch { /* the message starts empty */ }
  const purpose = what.receiptId ? 'RECEIPT' : 'INVOICE', pref = t.find(x => x.purpose === purpose);
  cmpWhatsApp({ ...what, kind: purpose, templateId: pref ? pref.id : undefined }, () => { if (CMP_INV.open) cmpInvoiceRedraw(); });
}
async function cmpInvoiceAct(what) {
  const o = CMP_INV.open;
  try { await api(`/api/cmp/invoices/${o.inv.id}/${what}`, { method: 'POST' }); toast(what === 'sent' ? 'Marked as sent' : 'Marked as not sent', true); await cmpInvoiceRedraw(); } catch (err) { toast(err.message); }
}
// Cancelled at any stage (the CA). Money already received: refunded, kept as the client's credit, or the receipts voided, as chosen.
function cmpInvoiceCancel() {
  const o = CMP_INV.open, inv = o.inv, live = inv.receipts.filter(cmpReceiptLive), sum = live.reduce((m, r) => m + r.amount, 0);
  const opt = (v, title, note, extra = '') => `<label class="flex items-start gap-2 border rounded-lg p-3 cursor-pointer hover:border-emerald-600"><input type="radio" name="cmCxl" value="${v}" class="mt-1" onchange="document.querySelectorAll('.cmCxlMore').forEach(x => x.classList.toggle('hidden', x.dataset.for !== this.value))">
    <span class="flex-1"><b>${title}</b><span class="block text-xs text-slate-600">${note}</span>${extra}</span></label>`;
  const today = CmpRules.dayIn(cmpTz());
  cmpShowModal(`${cmpModalHead(`Cancel invoice ${esc(inv.number)}`, `${esc(inv.client.name)} · ${cmpMoney(inv.total, inv.currency)}. It keeps its number and stays in the list as cancelled.`)}
    <div class="space-y-3">
      <label><span>Why is it cancelled? *</span><input id="cmCxlWhy" maxlength="300" placeholder="e.g. issued to the wrong client"></label>
      ${live.length ? `<div class="rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-sm"><b>${cmpMoney(sum, inv.currency)}</b> was received against it (${live.map(r => esc(r.number)).join(', ')}). What becomes of it?</div>
        ${opt('REFUND', 'Refund it to the client', 'The money was paid back. The receipts stay, marked refunded.', `<span data-for="REFUND" class="cmCxlMore hidden grid sm:grid-cols-3 gap-2 mt-2">
          <span><span class="text-xs text-slate-600">Paid back on</span><input id="cmRfDate" type="date" value="${today}"></span>
          <span><span class="text-xs text-slate-600">Paid back by</span><select id="cmRfHow">${Object.entries(CMP_METHODS).filter(([k]) => k !== 'CREDIT').map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></span>
          <span><span class="text-xs text-slate-600">Reference</span><input id="cmRfRef" maxlength="120" placeholder="cheque or transfer no."></span></span>`)}
        ${opt('CREDIT', `Keep it as ${esc(inv.client.name)}'s credit`, `It pays the client's next invoices in ${esc(inv.currency)} (Paid by: Client credit). The receipts stay, marked kept as credit.`)}
        ${opt('VOID', 'Void the receipts', 'The money was never really received (entered by mistake, a bounced cheque). The receipts stay, crossed out.')}` : ''}
      <div class="flex justify-end gap-2">${cmpBtn('Back', `CMP_INV.open.panel ? cmpCloseModal() : cmpInvoiceOpen('${inv.id}', CMP_INV.open.after)`)}${cmpBtn('Cancel invoice', 'cmpInvoiceCancelGo()', 'danger', 'needs-write')}</div></div>`);
  CMP_INV.cancelling = { live: live.length > 0 };
}
async function cmpInvoiceCancelGo() {
  const inv = CMP_INV.open.inv, reason = $('#cmCxlWhy').value.trim(), pick = document.querySelector('input[name="cmCxl"]:checked');
  if (!reason) return toast('Write why it is cancelled.');
  if (CMP_INV.cancelling.live && !pick) return toast('Choose what becomes of the money received: refund, credit or void.');
  const body = { reason };
  if (pick) { body.settle = pick.value; if (pick.value === 'REFUND') body.refund = { date: $('#cmRfDate').value, method: $('#cmRfHow').value, reference: $('#cmRfRef').value }; }
  try {
    await api(`/api/cmp/invoices/${inv.id}/cancel`, { method: 'POST', body });
    if (CMP_INV.open.panel) cmpCloseModal();
    toast(`Invoice cancelled${pick ? ` (${{ REFUND: 'money refunded', CREDIT: 'money kept as the client\'s credit', VOID: 'receipts voided' }[pick.value]})` : ''}`, true); await cmpInvoiceRedraw();
  } catch (err) { toast(err.message); }
}
// The receipt form, inside the invoice (beside the list or in its window)
function cmpReceiptForm() {
  const inv = CMP_INV.open.inv, d = CmpCountries.currencyDecimals(inv.currency), box = document.getElementById('cmRcpForm'); if (!box) return;
  const credit = (inv.clientCredit || []).find(c => c.currency === inv.currency && c.remaining > 0) || null;
  box.innerHTML = `<form id="crForm" onsubmit="event.preventDefault(); cmpReceiptSave()" class="space-y-3 bg-emerald-50 border border-emerald-200 rounded-lg p-3 mb-3">
      <div class="font-medium text-sm">Receipt against ${esc(inv.number)} · still owed ${cmpMoney(inv.outstanding, inv.currency)}</div>
      <div class="grid sm:grid-cols-3 gap-3">
        <label><span>Amount (${esc(inv.currency)})</span><input name="amount" required inputmode="decimal" value="${inv.outstanding.toFixed(d)}"></label>
        <label><span>Date received</span><input name="receivedOn" type="date" value="${CmpRules.dayIn(cmpTz())}"></label>
        <label><span>Paid by</span><select name="method" onchange="cmpReceiptMethod(this)">${Object.entries(CMP_METHODS).filter(([k]) => k !== 'CREDIT' || credit).map(([k, v]) => `<option value="${k}">${k === 'CREDIT' ? `${v} (${cmpMoney(credit.remaining, inv.currency)} available)` : v}</option>`).join('')}</select></label>
      </div>
      <div class="grid sm:grid-cols-3 gap-3"><label><span>Reference <span class="text-slate-400">(cheque or transfer no.)</span></span><input name="reference" maxlength="120"></label>
        <label><span>Notes</span><input name="notes" maxlength="500"></label>
        <label><span>Receipt format</span><select name="typeId" id="crType"><option value="">Standard</option></select></label></div>
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', "document.getElementById('cmRcpForm').innerHTML = ''")}<button class="needs-write px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">Save receipt</button></div>
    </form>`;
  box.querySelector('input[name="amount"]').focus();
  // the receipt formats of the client's country, its default first (the CA)
  cmpInvoiceTypes(null).then(all => {
    const sel = document.getElementById('crType'); if (!sel) return;
    const list = all.filter(t => t.active && t.kind === 'RECEIPT' && t.country === inv.client.country).sort((a, b) => b.isDefault - a.isDefault || a.name.localeCompare(b.name));
    sel.innerHTML = '<option value="">Standard</option>' + list.map(t => `<option value="${t.id}">${esc(t.name)}${t.isDefault ? ' · default' : ''}</option>`).join('');
    if (list[0] && list[0].isDefault) sel.value = list[0].id;
  });
}
// Paid from the client's credit: the amount is at most what is left of it
function cmpReceiptMethod(sel) {
  const inv = CMP_INV.open.inv, credit = (inv.clientCredit || []).find(c => c.currency === inv.currency), amt = sel.form.amount, d = CmpCountries.currencyDecimals(inv.currency);
  if (sel.value === 'CREDIT' && credit) amt.value = Math.min(inv.outstanding, credit.remaining).toFixed(d);
}
async function cmpReceiptSave() {
  const o = CMP_INV.open, f = new FormData($('#crForm'));
  try {
    await api(`/api/cmp/invoices/${o.inv.id}/receipts`, { method: 'POST', body: Object.fromEntries(f) });
    toast('Receipt saved', true); await cmpInvoiceRedraw();
  } catch (err) { toast(err.message); }
}
// Undone (voided): it stays in the list, crossed out, and the money is owed again
async function cmpReceiptVoid(id, after) {
  const reason = prompt('Undo this receipt? It stays in the list, crossed out, and the money is owed again. Why?', 'Entered by mistake');
  if (!reason) return;
  try {
    await api(`/api/cmp/receipts/${id}/void`, { method: 'POST', body: { reason } }); toast('Receipt undone', true);
    if (after) after(); else await cmpInvoiceRedraw();
  } catch (err) { toast(err.message); }
}

/* ---------- the receipts page (the CA: under Invoices; a receipt is only made against an invoice) ---------- */
CMP_PAGES.push({
  id: 'cm-receipts',
  html: () => `<div class="bg-white rounded-xl shadow p-4">
    <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
      <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3 flex-1">
        <div id="cmRcRange" class="contents"></div>
        <label><span>Show</span><select id="cmRcStatus" onchange="CMP_RC.status = this.value; cmpLoadReceiptsPage()"><option value="VALID">Receipts</option><option value="VOID">Undone (void)</option><option value="">Both</option></select></label>
        <label class="col-span-2 sm:min-w-[12rem]"><span>Search</span><input id="cmRcQ" type="search" placeholder="Receipt, invoice, client or reference" oninput="clearTimeout(CMP_RC.timer); CMP_RC.timer = setTimeout(() => { CMP_RC.q = this.value; cmpLoadReceiptsPage(); }, 350)"></label>
      </div>
      <div class="flex flex-wrap gap-2">${cmpBtn('+ New receipt', 'cmpReceiptNew()', 'primary', 'needs-write')}<span id="cmRcExport"></span>${cmpBtn('Print / PDF', 'cmpPrintTable("Receipts — " + cmpRangeText("rc"), "cmRcTable")')}</div>
    </div>
    <div id="cmRcTotals" class="text-xs text-slate-600 mb-2"></div>
    <div class="overflow-x-auto"><table id="cmRcTable" class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Receipt</th><th>Date</th><th>Client</th><th>Invoice</th><th class="text-right">Amount</th><th>Paid by</th><th>Actions</th></tr></thead>
      <tbody id="cmRcRows"></tbody></table></div></div>`,
  enter: () => {
    if (S.routeArg) { CMP_RC.q = decodeURIComponent(S.routeArg); CMP_RC.status = ''; cmpRange('rc'); CMP.ranges.rc.r = { ...CMP.ranges.rc.r, mode: 'all' }; }
    $('#cmRcRange').innerHTML = cmpRangeBar('rc', cmpLoadReceiptsPage);
    $('#cmRcQ').value = CMP_RC.q; $('#cmRcStatus').value = CMP_RC.status;
    $('#cmRcExport').innerHTML = cmpCan('EXPORT') ? cmpBtn('Download (Excel)', "cmpDownload('/api/cmp/export/receipts?' + cmpRcQuery(), 'receipts.csv')") : '';
    cmpLoadReceiptsPage();
  },
});
const cmpRcQuery = () => cmpQs({ q: CMP_RC.q, status: CMP_RC.status, ...cmpRangeDates('rc') });
async function cmpLoadReceiptsPage() {
  let rows;
  try { rows = await api('/api/cmp/receipts?' + cmpRcQuery()); } catch (err) { $('#cmRcRows').innerHTML = `<tr><td colspan="7">${cmpEmpty(esc(err.message))}</td></tr>`; return; }
  const sums = {};
  for (const r of rows) if (cmpReceiptLive(r)) sums[r.currency] = (sums[r.currency] || 0) + r.amount;
  $('#cmRcTotals').innerHTML = `${esc(cmpRangeText('rc'))} · ${rows.length} receipt${rows.length === 1 ? '' : 's'}` + Object.entries(sums).map(([c, n]) => ` · <b>${cmpMoney(n, c)}</b> received`).join('');
  $('#cmRcRows').innerHTML = rows.map(r => `<tr class="border-b last:border-0 ${r.voidedAt ? 'opacity-60' : ''}"><td class="py-2 font-medium ${r.voidedAt ? 'line-through' : ''}">${esc(r.number)}${r.voidedAt ? `<div class="text-xs text-red-700 font-normal no-underline">void: ${esc(r.voidReason)}</div>` : ''}</td>
    <td class="whitespace-nowrap">${cmpDay(r.receivedOn)}</td><td>${cmpCountry(r.client.country).flag} ${esc(r.client.name)}</td>
    <td><a href="#/cm-invoices/${encodeURIComponent(r.invoice.number)}" class="text-emerald-700 underline">${esc(r.invoice.number)}</a></td><td class="text-right whitespace-nowrap">${cmpMoney(r.amount, r.currency)}</td><td>${esc(CMP_METHODS[r.method] || r.method)}${r.reference ? ` · ${esc(r.reference)}` : ''}${r.settlement ? `<div class="mt-0.5">${cmpSettleChip(r)}</div>` : ''}</td>
    <td><div class="flex flex-wrap gap-1">${cmpBtn('Print', `cmpReceiptPrintFrom('${r.invoice.id}', '${r.id}')`)}${!r.voidedAt && cmpCan('WHATSAPP') ? cmpBtn('WhatsApp', `cmpWhatsApp({ kind: 'RECEIPT', receiptId: '${r.id}' }, cmpLoadReceiptsPage)`, 'plain', 'needs-write') : ''}${cmpReceiptLive(r) ? cmpBtn('↶ Undo', `cmpReceiptVoid('${r.id}', cmpLoadReceiptsPage)`, 'danger', 'needs-write') : ''}</div></td></tr>`).join('')
    || `<tr><td colspan="7">${cmpEmpty(`No receipts for ${esc(cmpRangeText('rc'))}. A receipt is made against an invoice: + New receipt, or + Receipt on an invoice.`)}</td></tr>`;
}
async function cmpReceiptPrintFrom(invoiceId, receiptId) {
  try { const inv = await api(`/api/cmp/invoices/${invoiceId}`); CMP_INV.open = { inv, after: cmpLoadReceiptsPage, panel: false }; cmpReceiptPrint(receiptId); } catch (err) { toast(err.message); }
}
// A new receipt: choose the invoice it is for (only invoices not paid in full)
async function cmpReceiptNew() {
  let list = [];
  try { list = (await api('/api/cmp/invoices?status=UNPAID&limit=2000')).invoices; } catch (err) { return toast(err.message); }
  if (!list.length) return toast('Every issued invoice is paid. A receipt is always made against an invoice.');
  cmpShowModal(`${cmpModalHead('New receipt', 'A receipt is made against an invoice: choose the invoice that was paid.')}
    <label><span>Invoice</span><select id="cmRcInv">${list.map(i => `<option value="${i.id}">${esc(i.number)} · ${cmpCountry(i.client.country).flag} ${esc(i.client.name)} · still owed ${cmpMoney(i.outstanding, i.currency)}</option>`).join('')}</select></label>
    <div class="flex justify-end gap-2 mt-4">${cmpBtn('Cancel', 'cmpCloseModal()')}${cmpBtn('Continue', "cmpQuickReceipt($('#cmRcInv').value, cmpLoadReceiptsPage)", 'primary')}</div>`);
}

/* ---------- tax rates, and items and services (Setup) ---------- */
CMP_PAGES.push({
  id: 'cm-taxes',
  html: () => `<div class="space-y-4"><div class="bg-white rounded-xl shadow p-4">
    <div class="flex flex-wrap items-start justify-between gap-3 mb-3"><div><h2 class="font-semibold">Taxes on fee invoices</h2>
      <p class="text-xs text-slate-500 max-w-2xl">Each tax is suggested on the invoices of clients of its countries. A new tax added on an invoice with "Keep for … clients" ticked appears here too. A tax can have several rates (e.g. VAT 5% in the UAE, 15% in Saudi Arabia): a new rate is kept beside the earlier ones (you are warned first).</p></div>
      <div class="flex items-center gap-3"><label class="flex items-center gap-2 text-xs"><input type="checkbox" id="cmTaxAll" onchange="cmpLoadTaxes()"> Show retired</label>${cmpBtn('+ Add tax', 'cmpTaxForm()', 'primary', 'needs-write')}</div></div>
    <table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Tax</th><th class="text-right">Rate</th><th>Countries</th><th></th></tr></thead><tbody id="cmTaxRows"></tbody></table></div>
    <div class="bg-white rounded-xl shadow p-4">
    <div class="flex flex-wrap items-start justify-between gap-3 mb-3"><div><h2 class="font-semibold">Items and services</h2>
      <p class="text-xs text-slate-500 max-w-2xl">What you bill, with every price it was billed at (each with its date), suggested on the invoices of clients of its countries. A line typed on an invoice with "Keep" ticked appears here too; a new price is kept beside the earlier ones (you are warned first).</p></div>
      <div class="flex items-center gap-3"><label class="flex items-center gap-2 text-xs"><input type="checkbox" id="cmItemAll" onchange="cmpLoadItems()"> Show retired</label>${cmpBtn('+ Add item', 'cmpItemForm()', 'primary', 'needs-write')}</div></div>
    <table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Item or service</th><th class="text-right">Price</th><th>Countries</th><th></th></tr></thead><tbody id="cmItemRows"></tbody></table></div></div>`,
  enter: () => { cmpLoadTaxes(); cmpLoadItems(); },
});
async function cmpLoadTaxes() {
  try { CMP_INV.rates = await api('/api/cmp/taxes' + ($('#cmTaxAll').checked ? '?all=1' : '')); } catch (err) { return toast(err.message); }
  $('#cmTaxRows').innerHTML = CMP_INV.rates.map(r => `<tr class="border-b last:border-0 ${r.active ? '' : 'opacity-60'}"><td class="py-2 font-medium">${esc(r.name)}${r.active ? '' : ' <span class="text-xs text-slate-500">(retired)</span>'}</td><td class="text-right">${r.rate}%</td>
    <td>${r.allCountries ? 'All countries' : r.countries.map(c => `${cmpCountry(c).flag} ${esc(c)}`).join(' ')}</td>
    <td class="text-right whitespace-nowrap"><button class="needs-write text-emerald-700 underline mr-2" onclick="cmpTaxForm('${r.id}')">Edit</button><button class="needs-write ${r.active ? 'text-red-600' : 'text-emerald-700'} underline" onclick="cmpTaxActive('${r.id}', ${!r.active})">${r.active ? 'Retire' : 'Use again'}</button></td></tr>`).join('')
    || `<tr><td colspan="4">${cmpEmpty('No taxes yet. Add one here, or on an invoice.')}</td></tr>`;
}
const cmpCountryPicker = (id, sel) => `<select id="${id}" multiple size="8">${CmpCountries.list.map(c => `<option value="${c.code}" ${sel.includes(c.code) ? 'selected' : ''}>${c.flag} ${esc(c.name)}</option>`).join('')}</select>`;
function cmpTaxForm(id) {
  const r = id ? CMP_INV.rates.find(x => x.id === id) : null;
  CMP_INV.taxEdit = id || null;
  cmpShowModal(`${cmpModalHead(r ? `Edit ${esc(r.name)} ${r.rate}%` : 'Add a tax')}
    <form id="ctForm" onsubmit="event.preventDefault(); cmpTaxSave()" class="space-y-3">
      <div class="grid grid-cols-3 gap-3"><label class="col-span-2"><span>Name</span><input name="name" required maxlength="60" placeholder="e.g. VAT" value="${r ? esc(r.name) : ''}"></label>
        <label><span>Rate %</span><input name="rate" required inputmode="decimal" value="${r ? r.rate : ''}"></label></div>
      <div class="text-sm space-y-1"><label class="flex items-center gap-2"><input type="checkbox" name="allCountries" ${r && r.allCountries ? 'checked' : ''} onchange="$('#ctCountries').disabled = this.checked"> All countries</label>
        ${cmpCountryPicker('ctCountries', r ? r.countries : [])}
        <p class="text-xs text-slate-500">Hold Ctrl (or ⌘ on a Mac) to choose several.</p></div>
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseModal()')}<button class="px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">Save</button></div></form>`);
  if (r && r.allCountries) $('#ctCountries').disabled = true;
}
async function cmpTaxSave() {
  const f = $('#ctForm'), id = CMP_INV.taxEdit;
  const body = { name: f.name.value, rate: f.rate.value, allCountries: f.allCountries.checked, countries: [...$('#ctCountries').selectedOptions].map(o => o.value) };
  // another rate of a tax (the CA: warned, then both rates are kept)
  const same = CMP_INV.rates.filter(x => x.name.toLowerCase() === body.name.trim().toLowerCase() && x.id !== id);
  const old = id && CMP_INV.rates.find(x => x.id === id);
  if (old && Number(body.rate) !== old.rate) {
    if (!confirm(`${old.name} is ${old.rate}%. Keep ${body.rate}% as another rate beside it? (Both are then offered on the invoices.)`)) return;
    body.keepOld = true;
  } else if (!id && same.length && !same.some(x => x.rate === Number(body.rate)) && !confirm(`${body.name} is already there at ${same.map(x => `${x.rate}%`).join(', ')}. Keep ${body.rate}% as another rate?`)) return;
  try { await api(id ? `/api/cmp/taxes/${id}` : '/api/cmp/taxes', { method: id ? 'PUT' : 'POST', body }); cmpCloseModal(); toast('Tax saved', true); cmpLoadTaxes(); } catch (err) { toast(err.message); }
}
async function cmpTaxActive(id, active) {
  try { await api(`/api/cmp/taxes/${id}`, { method: 'PUT', body: { active } }); cmpLoadTaxes(); } catch (err) { toast(err.message); }
}
async function cmpLoadItems() {
  try { CMP_INV.items = await api('/api/cmp/items' + ($('#cmItemAll').checked ? '?all=1' : '')); } catch (err) { return toast(err.message); }
  $('#cmItemRows').innerHTML = CMP_INV.items.map(r => `<tr class="border-b last:border-0 ${r.active ? '' : 'opacity-60'}"><td class="py-2 font-medium">${esc(r.name)}${r.active ? '' : ' <span class="text-xs text-slate-500">(retired)</span>'}</td><td class="text-right whitespace-nowrap">${(r.prices && r.prices.length ? r.prices : [{ amount: r.amount, lastOn: '' }]).map(p => `<div>${cmpMoney(p.amount, r.currency)}${p.lastOn ? ` <span class="text-xs text-slate-500">${esc(cmpDay(p.lastOn))}</span>` : ''}</div>`).join('')}</td>
    <td>${r.allCountries ? 'All countries' : r.countries.map(c => `${cmpCountry(c).flag} ${esc(c)}`).join(' ')}</td>
    <td class="text-right whitespace-nowrap"><button class="needs-write text-emerald-700 underline mr-2" onclick="cmpItemForm('${r.id}')">Edit</button><button class="needs-write ${r.active ? 'text-red-600' : 'text-emerald-700'} underline" onclick="cmpItemActive('${r.id}', ${!r.active})">${r.active ? 'Retire' : 'Use again'}</button></td></tr>`).join('')
    || `<tr><td colspan="4">${cmpEmpty('No items yet. Add one here, or keep a line typed on an invoice.')}</td></tr>`;
}
function cmpItemForm(id) {
  const r = id ? CMP_INV.items.find(x => x.id === id) : null;
  CMP_INV.itemEdit = id || null;
  cmpShowModal(`${cmpModalHead(r ? `Edit ${esc(r.name)}` : 'Add an item or service')}
    <form id="cmItForm" onsubmit="event.preventDefault(); cmpItemSave()" class="space-y-3">
      <label><span>Item or service</span><input name="name" required maxlength="300" placeholder="e.g. VAT return filing (quarter)" value="${r ? esc(r.name) : ''}"></label>
      <div class="grid grid-cols-2 gap-3"><label><span>Currency</span><select name="currency">${CmpCountries.currencies.map(c => `<option value="${c.code}" ${(r ? r.currency : 'AED') === c.code ? 'selected' : ''}>${c.code} · ${esc(c.name)}</option>`).join('')}</select></label>
        <label><span>Price</span><input name="amount" required inputmode="decimal" value="${r ? r.amount : ''}"></label></div>
      <div class="text-sm space-y-1"><label class="flex items-center gap-2"><input type="checkbox" name="allCountries" ${r && r.allCountries ? 'checked' : ''} onchange="$('#citCountries').disabled = this.checked"> All countries</label>
        ${cmpCountryPicker('citCountries', r ? r.countries : [])}
        <p class="text-xs text-slate-500">Hold Ctrl (or ⌘ on a Mac) to choose several.</p></div>
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseModal()')}<button class="px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">Save</button></div></form>`);
  if (r && r.allCountries) $('#citCountries').disabled = true;
}
async function cmpItemSave() {
  const f = $('#cmItForm'), id = CMP_INV.itemEdit;
  const body = { name: f.name.value, currency: f.currency.value, amount: f.amount.value, allCountries: f.allCountries.checked, countries: [...$('#citCountries').selectedOptions].map(o => o.value) };
  // the same item in that currency (the CA: warned, then its new price is kept beside the earlier ones, each with its date)
  const known = !id && CMP_INV.items.find(x => x.currency === body.currency && CmpRules.keyOf(x.name) === CmpRules.keyOf(body.name));
  if (known) {
    if (!confirm(`"${known.name}" is already there at ${(known.prices && known.prices.length ? known.prices : [{ amount: known.amount }]).map(p => cmpMoney(p.amount, known.currency)).join(', ')}.\n\nKeep ${cmpMoney(Number(body.amount) || 0, body.currency)} as another price? (The earlier prices stay, each with its date.)`)) return;
    body.addPrice = true;
  }
  if (id) { const r = CMP_INV.items.find(x => x.id === id); if (r && Number(body.amount) !== r.amount && !confirm(`${r.name} changes from ${cmpMoney(r.amount, r.currency)} to ${cmpMoney(Number(body.amount) || 0, body.currency)}.\n\nThe earlier price stays in its list of prices, with its date. Continue?`)) return; }
  try { await api(id ? `/api/cmp/items/${id}` : '/api/cmp/items', { method: id ? 'PUT' : 'POST', body }); cmpCloseModal(); toast('Item saved', true); cmpLoadItems(); } catch (err) { toast(err.message); }
}
async function cmpItemActive(id, active) {
  try { await api(`/api/cmp/items/${id}`, { method: 'PUT', body: { active } }); cmpLoadItems(); } catch (err) { toast(err.message); }
}
