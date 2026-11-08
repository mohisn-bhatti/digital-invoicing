'use strict';
/* Compliance & Deadlines: fee invoices and receipts (SRS 9) and the taxes on them (the CA: several taxes, kept per country and
   suggested for that country's clients). A draft is edited freely; issuing gives it its number; the printout is the firm's invoice. */

const CMP_INV = { status: '', q: '', currency: '', from: '', to: '', timer: null, edit: null, open: null, rates: [] };
CMP_RESETS.push(() => Object.assign(CMP_INV, { status: '', q: '', currency: '', from: '', to: '', edit: null, open: null, rates: [] }));
const CMP_INV_STATUS = { DRAFT: ['Draft', 'bg-slate-100 text-slate-700'], ISSUED: ['Issued', 'bg-sky-100 text-sky-800'], SENT: ['Sent', 'bg-indigo-100 text-indigo-800'],
  PARTIAL: ['Partially received', 'bg-amber-100 text-amber-800'], RECEIVED: ['Received', 'bg-emerald-100 text-emerald-800'], CANCELLED: ['Cancelled', 'bg-slate-200 text-slate-500 line-through'] };
const CMP_METHODS = { BANK: 'Bank transfer', CASH: 'Cash', CHEQUE: 'Cheque', CARD: 'Card', ONLINE: 'Online payment', OTHER: 'Other' };
const cmpInvChip = st => { const [t, c] = CMP_INV_STATUS[st] || [st, 'bg-slate-100']; return `<span class="px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${c}">${t}</span>`; };
const cmpMoney = (n, cur) => `${esc(cur)} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: CmpCountries.currencyDecimals(cur), maximumFractionDigits: CmpCountries.currencyDecimals(cur) })}`;

/* ---------- the invoices page ---------- */
CMP_PAGES.push({
  id: 'cm-invoices',
  html: () => `<div class="bg-white rounded-xl shadow p-4">
    <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
      <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3 flex-1">
        <label><span>Status</span><select onchange="CMP_INV.status = this.value; cmpLoadInvoices()"><option value="">All</option><option value="UNPAID">Not paid yet</option>
          ${Object.entries(CMP_INV_STATUS).map(([k, [t]]) => `<option value="${k}">${t}</option>`).join('')}</select></label>
        <label><span>Currency</span><select onchange="CMP_INV.currency = this.value; cmpLoadInvoices()"><option value="">All</option>${CmpCountries.currencies.map(c => `<option value="${c.code}">${c.code}</option>`).join('')}</select></label>
        <label><span>From</span><input type="date" onchange="CMP_INV.from = this.value; cmpLoadInvoices()"></label>
        <label><span>To</span><input type="date" onchange="CMP_INV.to = this.value; cmpLoadInvoices()"></label>
        <label class="col-span-2 sm:min-w-[12rem]"><span>Search</span><input type="search" placeholder="Number, client or code" oninput="clearTimeout(CMP_INV.timer); CMP_INV.timer = setTimeout(() => { CMP_INV.q = this.value; cmpLoadInvoices(); }, 350)"></label>
      </div>
      <div class="flex flex-wrap gap-2">${cmpBtn('+ New invoice', 'cmpInvoiceNew()', 'primary', 'needs-write')}
        <span id="cmInvExport"></span>${cmpBtn('Print / PDF', 'cmpPrintTable("Invoices", "cmInvTable")')}</div>
    </div>
    <div id="cmInvTotals" class="text-xs text-slate-600 mb-2"></div>
    <div class="overflow-x-auto"><table id="cmInvTable" class="w-full text-sm">
      <thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Number</th><th>Date</th><th>Client</th><th>For</th><th class="text-right">Total</th><th class="text-right">Received</th><th class="text-right">Outstanding</th><th>Status</th></tr></thead>
      <tbody id="cmInvRows"></tbody></table></div>
    <details class="mt-5"><summary class="cursor-pointer font-medium text-sm" onclick="setTimeout(cmpLoadReceipts, 0)">Receipts</summary><div id="cmRcpList" class="mt-2"></div></details></div>`,
  enter: () => { $('#cmInvExport').innerHTML = cmpCan('EXPORT') ? cmpBtn('Download (Excel)', "cmpDownload('/api/cmp/export/invoices?' + cmpQs(CMP_INV), 'invoices.csv')") : ''; cmpLoadInvoices(); },
});
async function cmpLoadInvoices() {
  let d;
  try { d = await api('/api/cmp/invoices?' + cmpQs({ status: CMP_INV.status, q: CMP_INV.q, currency: CMP_INV.currency, from: CMP_INV.from, to: CMP_INV.to })); } catch (err) { $('#cmInvRows').innerHTML = `<tr><td colspan="8">${cmpEmpty(esc(err.message))}</td></tr>`; return; }
  const sums = {};
  for (const i of d.invoices) if (!['DRAFT', 'CANCELLED'].includes(i.status)) { sums[i.currency] = sums[i.currency] || { total: 0, out: 0 }; sums[i.currency].total += i.total; sums[i.currency].out += i.outstanding; }
  $('#cmInvTotals').innerHTML = `${d.invoices.length}${d.total > d.invoices.length ? ` of ${d.total}` : ''} invoice${d.total === 1 ? '' : 's'}` + Object.entries(sums).map(([c, s]) => ` · ${cmpMoney(s.total, c)} invoiced, <b>${cmpMoney(s.out, c)}</b> outstanding`).join('');
  $('#cmInvRows').innerHTML = d.invoices.map(i => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer" onclick="cmpInvoiceOpen('${i.id}', cmpLoadInvoices)">
    <td class="py-2 font-medium">${i.number ? esc(i.number) : '<span class="text-slate-400">(draft)</span>'}</td><td class="whitespace-nowrap">${cmpDay(i.issueDate)}</td>
    <td>${cmpCountry(i.client.country).flag} ${esc(i.client.name)}</td><td class="text-xs">${i.obligation ? `${esc(i.obligation.name)} · ${esc(CmpRules.periodName(i.obligation))}` : ''}</td>
    <td class="text-right whitespace-nowrap">${cmpMoney(i.total, i.currency)}</td><td class="text-right whitespace-nowrap">${cmpMoney(i.received, i.currency)}</td>
    <td class="text-right whitespace-nowrap ${i.outstanding > 0 && i.status !== 'CANCELLED' && i.status !== 'DRAFT' ? 'font-semibold' : ''}">${['CANCELLED', 'DRAFT'].includes(i.status) ? '—' : cmpMoney(i.outstanding, i.currency)}</td><td>${cmpInvChip(i.status)}</td></tr>`).join('')
    || `<tr><td colspan="8">${cmpEmpty('No invoices. They are made when an obligation is completed ("Generate invoice"), or here with "New invoice".')}</td></tr>`;
}
async function cmpLoadReceipts() {
  let rows;
  try { rows = await api('/api/cmp/receipts'); } catch (err) { $('#cmRcpList').innerHTML = cmpEmpty(esc(err.message)); return; }
  $('#cmRcpList').innerHTML = rows.length ? `<table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-1">Receipt</th><th>Date</th><th>Client</th><th>Invoice</th><th class="text-right">Amount</th><th>Paid by</th><th></th></tr></thead><tbody>
    ${rows.map(r => `<tr class="border-b last:border-0 ${r.voidedAt ? 'opacity-50 line-through' : ''}"><td class="py-1.5">${esc(r.number)}</td><td>${cmpDay(r.receivedOn)}</td><td>${cmpCountry(r.client.country).flag} ${esc(r.client.name)}</td>
      <td><a href="#" class="text-emerald-700 underline" onclick="event.preventDefault(); cmpInvoiceOpen('${r.invoice.id}')">${esc(r.invoice.number)}</a></td><td class="text-right">${cmpMoney(r.amount, r.currency)}</td><td>${esc(CMP_METHODS[r.method] || r.method)}</td>
      <td class="text-right">${r.voidedAt ? '<span class="text-xs">void</span>' : ''}</td></tr>`).join('')}</tbody></table>` : cmpEmpty('No receipts yet.');
}

/* ---------- a new invoice: choose the client ---------- */
async function cmpInvoiceNew(clientId) {
  if (clientId) return cmpInvoiceDraft({ clientId });
  let list = [];
  try { list = (await api('/api/cmp/clients')).clients; } catch (err) { return toast(err.message); }
  cmpShowModal(`${cmpModalHead('New invoice', 'Choose the client. To bill an obligation, complete it with "Generate invoice" instead: the period is filled in for you.')}
    <label><span>Client</span><select id="cmInvClient">${list.map(c => `<option value="${c.id}">${cmpCountry(c.country).flag} ${esc(c.name)} (${esc(c.code)})</option>`).join('')}</select></label>
    <div class="flex justify-end gap-2 mt-4">${cmpBtn('Cancel', 'cmpCloseModal()')}${cmpBtn('Continue', "cmpInvoiceDraft({ clientId: $('#cmInvClient').value })", 'primary')}</div>`);
}
async function cmpInvoiceDraft(body) {
  try { const inv = await api('/api/cmp/invoices', { method: 'POST', body }); cmpInvoiceEdit(inv.id); } catch (err) { toast(err.message); }
}

/* ---------- the draft editor ---------- */
async function cmpInvoiceEdit(id, after) {
  let inv, rates = [];
  try { inv = await api(`/api/cmp/invoices/${id}`); rates = await api('/api/cmp/taxes?country=' + inv.client.country); } catch (err) { return toast(err.message); }
  if (inv.status !== 'DRAFT') return cmpInvoiceOpen(id, after);
  CMP_INV.edit = { inv, rates, after };
  const country = cmpCountry(inv.client.country);
  cmpShowModal(`${cmpModalHead(`Draft invoice`, `${country.flag} ${esc(inv.client.name)} · ${esc(inv.client.code)}${inv.obligation ? ` · ${esc(inv.obligation.name)} ${esc(CmpRules.periodName(inv.obligation))}` : ''}`)}
    <div class="space-y-4">
      <div class="grid sm:grid-cols-3 gap-3">
        <label><span>Currency <span class="text-slate-400">(${esc(country.name)}: ${esc(country.currency)})</span></span><select id="ciCur" onchange="cmpInvoiceTotals()">${CmpCountries.currencies.map(c => `<option value="${c.code}" ${c.code === inv.currency ? 'selected' : ''}>${c.code} · ${esc(c.name)}</option>`).join('')}</select></label>
        <label><span>Invoice date <span class="text-slate-400">(empty = the day it is issued)</span></span><input id="ciDate" type="date" value="${inv.issueDate}"></label>
        <label><span>Payment due</span><input id="ciDue" type="date" value="${inv.dueDate}"></label>
      </div>
      <div><div class="flex items-center justify-between mb-1"><h3 class="text-sm font-medium">Fee <span class="text-slate-400 font-normal">— typed by you</span></h3><button type="button" class="text-sm text-emerald-700 underline" onclick="cmpInvoiceLine()">+ Add line</button></div>
        <div id="ciLines" class="space-y-2"></div></div>
      <div><div class="flex flex-wrap items-center justify-between gap-2 mb-1"><h3 class="text-sm font-medium">Taxes <span class="text-slate-400 font-normal">— each on the subtotal</span></h3>
        <div class="flex gap-2 items-center"><select id="ciSuggest" class="!w-auto !text-sm" onchange="cmpInvoiceSuggest(this)"><option value="">Add a saved tax…</option>${rates.map((r, i) => `<option value="${i}">${esc(r.name)} ${r.rate}%</option>`).join('')}</select>
          <button type="button" class="text-sm text-emerald-700 underline whitespace-nowrap" onclick="cmpInvoiceTax()">+ New tax</button></div></div>
        <div id="ciTaxes" class="space-y-2"></div></div>
      <div id="ciTotals" class="ml-auto max-w-xs text-sm space-y-1"></div>
      <label><span>Notes on the invoice</span><textarea id="ciNotes" rows="2" maxlength="1000">${esc(inv.notes)}</textarea></label>
      <div class="flex flex-wrap justify-between gap-2">${cmpBtn('Delete draft', `cmpInvoiceDelete('${inv.id}')`, 'danger', 'needs-write')}
        <div class="flex gap-2">${cmpBtn('Save draft', 'cmpInvoiceSave(false)', 'plain', 'needs-write')}${cmpBtn('Save and issue', 'cmpInvoiceSave(true)', 'primary', 'needs-write')}</div></div>
    </div>`, { wide: true });
  inv.lines.forEach(l => cmpInvoiceLine(l));
  inv.taxes.forEach(t => cmpInvoiceTax({ ...t, saved: rates.some(r => r.name.toLowerCase() === t.name.toLowerCase() && r.rate === t.rate) }));
  cmpInvoiceTotals();
}
function cmpInvoiceLine(l = { description: '', amount: '' }) {
  $('#ciLines').insertAdjacentHTML('beforeend', `<div class="ciLine flex gap-2 items-end"><label class="flex-1"><span class="sr-only">Description</span><input class="ciDesc" maxlength="300" placeholder="What the fee is for" value="${esc(l.description)}"></label>
    <label class="w-40"><span class="sr-only">Amount</span><input class="ciAmt text-right" inputmode="decimal" placeholder="0.00" value="${l.amount ? esc(l.amount) : ''}" oninput="cmpInvoiceTotals()"></label>
    <button type="button" class="px-2 min-h-[2.5rem] text-red-600" onclick="this.closest('.ciLine').remove(); cmpInvoiceTotals()" aria-label="Remove line">✕</button></div>`);
}
function cmpInvoiceTax(t = { name: '', rate: '', saved: false }) {
  const country = cmpCountry(CMP_INV.edit.inv.client.country);
  $('#ciTaxes').insertAdjacentHTML('beforeend', `<div class="ciTax flex flex-wrap gap-2 items-center"><input class="ciTaxName flex-1 min-w-[8rem]" maxlength="60" placeholder="e.g. VAT" value="${esc(t.name)}">
    <div class="flex items-center gap-1 w-28"><input class="ciTaxRate text-right" inputmode="decimal" placeholder="5" value="${t.rate === '' ? '' : esc(t.rate)}" oninput="cmpInvoiceTotals()"><span>%</span></div>
    ${t.saved ? `<span class="text-xs text-slate-500">saved for ${esc(country.name)}</span>` : `<label class="flex items-center gap-1 text-xs"><input type="checkbox" class="ciTaxSave" checked> Keep for ${esc(country.name)} clients</label>`}
    <button type="button" class="px-2 min-h-[2.5rem] text-red-600" onclick="this.closest('.ciTax').remove(); cmpInvoiceTotals()" aria-label="Remove tax">✕</button></div>`);
}
function cmpInvoiceSuggest(sel) {
  const r = CMP_INV.edit.rates[Number(sel.value)]; sel.value = '';
  if (!r) return;
  cmpInvoiceTax({ name: r.name, rate: r.rate, saved: true }); cmpInvoiceTotals();
}
// The same sums as the server: in whole minor units, each tax rounded on the subtotal
function cmpInvoiceTotals() {
  const cur = $('#ciCur').value, d = CmpCountries.currencyDecimals(cur), minor = n => Math.round((Number(String(n).replace(/[,\s]/g, '')) || 0) * 10 ** d);
  const sub = [...document.querySelectorAll('#ciLines .ciAmt')].reduce((m, i) => m + minor(i.value), 0);
  const taxes = [...document.querySelectorAll('#ciTaxes .ciTax')].map(row => ({ name: row.querySelector('.ciTaxName').value || 'Tax', rate: Number(row.querySelector('.ciTaxRate').value) || 0 }))
    .map(t => ({ ...t, minor: Math.round(sub * t.rate / 100) }));
  const total = sub + taxes.reduce((m, t) => m + t.minor, 0), f = m => cmpMoney(m / 10 ** d, cur);
  $('#ciTotals').innerHTML = `<div class="flex justify-between"><span>Subtotal</span><span>${f(sub)}</span></div>${taxes.map(t => `<div class="flex justify-between text-slate-600"><span>${esc(t.name)} ${t.rate}%</span><span>${f(t.minor)}</span></div>`).join('')}
    <div class="flex justify-between font-semibold border-t pt-1"><span>Total</span><span>${f(total)}</span></div>`;
}
async function cmpInvoiceSave(issue) {
  const e = CMP_INV.edit;
  const body = { currency: $('#ciCur').value, issueDate: $('#ciDate').value, dueDate: $('#ciDue').value, notes: $('#ciNotes').value,
    lines: [...document.querySelectorAll('#ciLines .ciLine')].map(r => ({ description: r.querySelector('.ciDesc').value, amount: r.querySelector('.ciAmt').value || '0' })),
    taxes: [...document.querySelectorAll('#ciTaxes .ciTax')].map(r => ({ name: r.querySelector('.ciTaxName').value, rate: r.querySelector('.ciTaxRate').value, save: Boolean(r.querySelector('.ciTaxSave') && r.querySelector('.ciTaxSave').checked) })) };
  try {
    await api(`/api/cmp/invoices/${e.inv.id}`, { method: 'PUT', body });
    if (issue) { if (!confirm('Issue this invoice? It gets its number and can no longer be changed (only cancelled).')) return; await api(`/api/cmp/invoices/${e.inv.id}/issue`, { method: 'POST' }); toast('Invoice issued', true); }
    else toast('Draft saved', true);
    if (e.after) e.after();
    issue ? cmpInvoiceOpen(e.inv.id, e.after) : cmpCloseModal();
  } catch (err) { toast(err.message); }
}
async function cmpInvoiceDelete(id) {
  if (!confirm('Delete this draft?')) return;
  try { await api(`/api/cmp/invoices/${id}`, { method: 'DELETE' }); cmpCloseModal(); toast('Draft deleted', true); if (CMP_INV.edit && CMP_INV.edit.after) CMP_INV.edit.after(); } catch (err) { toast(err.message); }
}

/* ---------- an issued invoice: the document, payments, WhatsApp ---------- */
function cmpInvoiceDoc(inv, s, receipt) {
  const c = inv.client, cur = inv.currency, firm = s.firmName || S.company || '';
  const head = `<div style="display:flex;justify-content:space-between;gap:24px;align-items:flex-start">
      <div><div style="font-size:20px;font-weight:700">${esc(firm)}</div><div style="white-space:pre-wrap;font-size:12px;color:#334155">${esc(s.firmAddress || '')}</div>
        <div style="font-size:12px;color:#334155">${[s.firmPhone, s.firmEmail].filter(Boolean).map(esc).join(' · ')}</div>${s.firmTaxNo ? `<div style="font-size:12px">Tax registration no.: ${esc(s.firmTaxNo)}</div>` : ''}</div>
      <div style="text-align:right"><div style="font-size:22px;font-weight:700;letter-spacing:.05em">${receipt ? 'RECEIPT' : 'INVOICE'}</div>
        <div style="font-size:13px"><b>${esc(receipt ? receipt.number : inv.number || 'DRAFT')}</b></div>
        <div style="font-size:12px">Date: ${esc(CmpRules.fmtDay(receipt ? receipt.receivedOn : inv.issueDate) || '—')}</div>
        ${!receipt && inv.dueDate ? `<div style="font-size:12px">Payment due: ${esc(CmpRules.fmtDay(inv.dueDate))}</div>` : ''}${receipt ? `<div style="font-size:12px">For invoice ${esc(inv.number)}</div>` : ''}</div></div>
    <div style="margin:18px 0 12px;font-size:13px"><div style="color:#64748b;font-size:11px;text-transform:uppercase">${receipt ? 'Received from' : 'Bill to'}</div><b>${esc(c.name)}</b>
      <div style="white-space:pre-wrap">${esc(c.address || '')}</div><div>${esc(cmpCountry(c.country).name)}${c.registrationNo ? ` · Registration No. ${esc(c.registrationNo)}` : ''}</div></div>`;
  const td = 'padding:6px 8px;border-bottom:1px solid #e2e8f0', tr = (a, b, bold) => `<tr><td style="${td};text-align:right;${bold ? 'font-weight:700' : ''}">${a}</td><td style="${td};text-align:right;white-space:nowrap;${bold ? 'font-weight:700' : ''}">${b}</td></tr>`;
  if (receipt) {
    return `<div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:180mm">${head}
      <p style="font-size:14px;margin:16px 0">Received with thanks the sum of <b>${cmpMoney(receipt.amount, cur)}</b> by ${esc((CMP_METHODS[receipt.method] || receipt.method).toLowerCase())}${receipt.reference ? ` (ref. ${esc(receipt.reference)})` : ''}, against invoice ${esc(inv.number)} of ${cmpMoney(inv.total, cur)}.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px">${tr('Invoice total', cmpMoney(inv.total, cur))}${tr('Received to date', cmpMoney(inv.received, cur))}${tr('Still owed', cmpMoney(inv.outstanding, cur), true)}</table>
      ${receipt.voidedAt ? `<p style="color:#b91c1c;font-weight:700;margin-top:12px">VOID: ${esc(receipt.voidReason)}</p>` : ''}
      <div style="margin-top:40px;font-size:12px;color:#475569;white-space:pre-wrap">${esc(s.invoiceFooter || '')}</div></div>`;
  }
  return `<div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:180mm">${head}
    <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="background:#f1f5f9"><th style="${td};text-align:left">Description</th><th style="${td};text-align:right">Amount (${esc(cur)})</th></tr></thead><tbody>
      ${inv.lines.map(l => `<tr><td style="${td}">${esc(l.description)}</td><td style="${td};text-align:right;white-space:nowrap">${cmpMoney(l.amount, cur)}</td></tr>`).join('')}</tbody></table>
    <table style="margin-left:auto;margin-top:8px;border-collapse:collapse;font-size:13px;min-width:70mm">${tr('Subtotal', cmpMoney(inv.subtotal, cur))}${inv.taxes.map(t => tr(`${esc(t.name)} ${t.rate}%`, cmpMoney(t.amount, cur))).join('')}${tr('Total', cmpMoney(inv.total, cur), true)}
      ${inv.received ? tr('Received', cmpMoney(inv.received, cur)) + tr('Outstanding', cmpMoney(inv.outstanding, cur), true) : ''}</table>
    ${inv.status === 'CANCELLED' ? `<p style="color:#b91c1c;font-weight:700;margin-top:12px">CANCELLED: ${esc(inv.cancelReason)}</p>` : ''}
    ${inv.notes ? `<p style="font-size:12px;margin-top:16px;white-space:pre-wrap">${esc(inv.notes)}</p>` : ''}
    ${s.bankDetails ? `<div style="margin-top:16px;font-size:12px"><div style="color:#64748b;font-size:11px;text-transform:uppercase">Payment details</div><div style="white-space:pre-wrap">${esc(s.bankDetails)}</div></div>` : ''}
    <div style="margin-top:32px;font-size:12px;color:#475569;white-space:pre-wrap">${esc(s.invoiceFooter || '')}</div></div>`;
}
async function cmpInvoiceOpen(id, after) {
  let inv;
  try { inv = await api(`/api/cmp/invoices/${id}`); } catch (err) { return toast(err.message); }
  if (inv.status === 'DRAFT') return cmpInvoiceEdit(id, after);
  CMP_INV.open = { inv, after };
  const s = CMP.settings || {}, live = !['CANCELLED'].includes(inv.status), payable = ['ISSUED', 'SENT', 'PARTIAL'].includes(inv.status);
  cmpShowModal(`${cmpModalHead(`Invoice ${esc(inv.number)} ${cmpInvChip(inv.status)}`, `${cmpCountry(inv.client.country).flag} ${esc(inv.client.name)} · issued ${esc(cmpAt(inv.issuedAt))} by ${esc(inv.issuedBy || '')}${inv.sentAt ? ` · sent ${esc(cmpAt(inv.sentAt))}` : ''}`)}
    <div class="flex flex-wrap gap-2 mb-4">
      ${cmpBtn('Print / PDF', 'cmpInvoicePrint()', 'primary')}
      ${live && cmpCan('WHATSAPP') ? cmpBtn(`${CMP_WA_ICON} WhatsApp`, `cmpInvoiceWhatsApp({ invoiceId: '${inv.id}' })`, 'wa', 'needs-write') : ''}
      ${payable && !inv.sentAt ? cmpBtn('Mark as sent', `cmpInvoiceAct('sent')`, 'plain', 'needs-write') : ''}
      ${payable ? cmpBtn('Record payment', 'cmpReceiptForm()', 'plain', 'needs-write') : ''}
      ${live ? cmpBtn('Cancel invoice', 'cmpInvoiceCancel()', 'danger', 'needs-write') : ''}
    </div>
    ${s.firmName ? '' : `<p class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3">The firm's name, address and bank details for invoices are set under Setup → Settings.</p>`}
    <div class="border rounded-lg p-4 overflow-x-auto bg-white">${cmpInvoiceDoc(inv, s)}</div>
    <h3 class="font-medium mt-4 mb-2">Payments received</h3>
    ${inv.receipts.length ? `<table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-1">Receipt</th><th>Date</th><th class="text-right">Amount</th><th>Paid by</th><th></th></tr></thead><tbody>
      ${inv.receipts.map(r => `<tr class="border-b last:border-0 ${r.voidedAt ? 'opacity-60' : ''}"><td class="py-1.5 ${r.voidedAt ? 'line-through' : ''}">${esc(r.number)}</td><td>${cmpDay(r.receivedOn)}</td><td class="text-right">${cmpMoney(r.amount, inv.currency)}</td>
        <td>${esc(CMP_METHODS[r.method] || r.method)}${r.reference ? ` · ${esc(r.reference)}` : ''}${r.voidedAt ? `<div class="text-xs text-red-700">void: ${esc(r.voidReason)}</div>` : ''}</td>
        <td class="text-right whitespace-nowrap">${cmpBtn('Print', `cmpReceiptPrint('${r.id}')`)} ${!r.voidedAt && cmpCan('WHATSAPP') ? cmpBtn('WhatsApp', `cmpInvoiceWhatsApp({ receiptId: '${r.id}' })`, 'plain', 'needs-write') : ''} ${!r.voidedAt ? cmpBtn('Void', `cmpReceiptVoid('${r.id}')`, 'danger', 'needs-write') : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="text-sm text-slate-500">None yet.</p>'}
    <div class="flex justify-end mt-4">${cmpBtn('Close', 'cmpCloseModal()')}</div>`, { wide: true });
}
const cmpPrintA4 = html => posPrint(`<div style="padding:4mm">${html}</div>`, '@page { size: A4; margin: 12mm; }');
const cmpInvoicePrint = () => cmpPrintA4(cmpInvoiceDoc(CMP_INV.open.inv, CMP.settings || {}));
function cmpReceiptPrint(id) { const inv = CMP_INV.open.inv; cmpPrintA4(cmpInvoiceDoc(inv, CMP.settings || {}, inv.receipts.find(r => r.id === id))); }
async function cmpInvoiceWhatsApp(what) {
  let t = [];
  try { t = await cmpTemplates(true); } catch { /* the message starts empty */ }
  const purpose = what.receiptId ? 'RECEIPT' : 'INVOICE', pref = t.find(x => x.purpose === purpose);
  const o = CMP_INV.open;
  cmpWhatsApp({ ...what, kind: purpose, templateId: pref ? pref.id : undefined }, () => { if (o.after) o.after(); });
}
async function cmpInvoiceAct(what) {
  const o = CMP_INV.open;
  try { await api(`/api/cmp/invoices/${o.inv.id}/${what}`, { method: 'POST' }); toast('Saved', true); if (o.after) o.after(); cmpInvoiceOpen(o.inv.id, o.after); } catch (err) { toast(err.message); }
}
async function cmpInvoiceCancel() {
  const o = CMP_INV.open, reason = prompt('Why is this invoice cancelled? (It keeps its number and stays in the list as cancelled.)');
  if (!reason) return;
  try { await api(`/api/cmp/invoices/${o.inv.id}/cancel`, { method: 'POST', body: { reason } }); toast('Invoice cancelled', true); if (o.after) o.after(); cmpInvoiceOpen(o.inv.id, o.after); } catch (err) { toast(err.message); }
}
function cmpReceiptForm() {
  const inv = CMP_INV.open.inv, d = CmpCountries.currencyDecimals(inv.currency);
  cmpShowModal(`${cmpModalHead('Record a payment', `Invoice ${esc(inv.number)} · ${esc(inv.client.name)} · still owed ${cmpMoney(inv.outstanding, inv.currency)}`)}
    <form id="crForm" onsubmit="event.preventDefault(); cmpReceiptSave()" class="space-y-3">
      <div class="grid sm:grid-cols-3 gap-3">
        <label><span>Amount (${esc(inv.currency)})</span><input name="amount" required inputmode="decimal" value="${inv.outstanding.toFixed(d)}"></label>
        <label><span>Date received</span><input name="receivedOn" type="date" value="${CmpRules.dayIn(cmpTz())}"></label>
        <label><span>Paid by</span><select name="method">${Object.entries(CMP_METHODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      </div>
      <label><span>Reference <span class="text-slate-400">(cheque or transfer no.)</span></span><input name="reference" maxlength="120"></label>
      <label><span>Notes</span><textarea name="notes" rows="2" maxlength="500"></textarea></label>
      <div class="flex justify-end gap-2">${cmpBtn('Back', `cmpInvoiceOpen('${inv.id}', CMP_INV.open.after)`)}<button class="px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">Save receipt</button></div>
    </form>`);
}
async function cmpReceiptSave() {
  const o = CMP_INV.open, f = new FormData($('#crForm'));
  try {
    await api(`/api/cmp/invoices/${o.inv.id}/receipts`, { method: 'POST', body: Object.fromEntries(f) });
    toast('Receipt saved', true); if (o.after) o.after(); cmpInvoiceOpen(o.inv.id, o.after);
  } catch (err) { toast(err.message); }
}
async function cmpReceiptVoid(id) {
  const o = CMP_INV.open, reason = prompt('Why is this receipt void? (It stays in the list, crossed out, and the money is owed again.)');
  if (!reason) return;
  try { await api(`/api/cmp/receipts/${id}/void`, { method: 'POST', body: { reason } }); toast('Receipt voided', true); if (o.after) o.after(); cmpInvoiceOpen(o.inv.id, o.after); } catch (err) { toast(err.message); }
}

/* ---------- tax rates (Setup) ---------- */
CMP_PAGES.push({
  id: 'cm-taxes',
  html: () => `<div class="bg-white rounded-xl shadow p-4">
    <div class="flex flex-wrap items-start justify-between gap-3 mb-3"><div><h2 class="font-semibold">Taxes on fee invoices</h2>
      <p class="text-xs text-slate-500 max-w-2xl">Each tax is suggested on the invoices of clients of its countries. A new tax added on an invoice with "Keep for … clients" ticked appears here too. The same name can have different rates in different countries (e.g. VAT 5% in the UAE, 15% in Saudi Arabia).</p></div>
      <div class="flex items-center gap-3"><label class="flex items-center gap-2 text-xs"><input type="checkbox" id="cmTaxAll" onchange="cmpLoadTaxes()"> Show retired</label>${cmpBtn('+ Add tax', 'cmpTaxForm()', 'primary', 'needs-write')}</div></div>
    <table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Tax</th><th class="text-right">Rate</th><th>Countries</th><th></th></tr></thead><tbody id="cmTaxRows"></tbody></table></div>`,
  enter: () => cmpLoadTaxes(),
});
async function cmpLoadTaxes() {
  try { CMP_INV.rates = await api('/api/cmp/taxes' + ($('#cmTaxAll').checked ? '?all=1' : '')); } catch (err) { return toast(err.message); }
  $('#cmTaxRows').innerHTML = CMP_INV.rates.map(r => `<tr class="border-b last:border-0 ${r.active ? '' : 'opacity-60'}"><td class="py-2 font-medium">${esc(r.name)}${r.active ? '' : ' <span class="text-xs text-slate-500">(retired)</span>'}</td><td class="text-right">${r.rate}%</td>
    <td>${r.allCountries ? 'All countries' : r.countries.map(c => `${cmpCountry(c).flag} ${esc(c)}`).join(' ')}</td>
    <td class="text-right whitespace-nowrap"><button class="needs-write text-emerald-700 underline mr-2" onclick="cmpTaxForm('${r.id}')">Edit</button><button class="needs-write ${r.active ? 'text-red-600' : 'text-emerald-700'} underline" onclick="cmpTaxActive('${r.id}', ${!r.active})">${r.active ? 'Retire' : 'Use again'}</button></td></tr>`).join('')
    || `<tr><td colspan="4">${cmpEmpty('No taxes yet. Add one here, or on an invoice.')}</td></tr>`;
}
function cmpTaxForm(id) {
  const r = id ? CMP_INV.rates.find(x => x.id === id) : null;
  CMP_INV.taxEdit = id || null;
  cmpShowModal(`${cmpModalHead(r ? `Edit ${esc(r.name)} ${r.rate}%` : 'Add a tax')}
    <form id="ctForm" onsubmit="event.preventDefault(); cmpTaxSave()" class="space-y-3">
      <div class="grid grid-cols-3 gap-3"><label class="col-span-2"><span>Name</span><input name="name" required maxlength="60" placeholder="e.g. VAT" value="${r ? esc(r.name) : ''}"></label>
        <label><span>Rate %</span><input name="rate" required inputmode="decimal" value="${r ? r.rate : ''}"></label></div>
      <div class="text-sm space-y-1"><label class="flex items-center gap-2"><input type="checkbox" name="allCountries" ${r && r.allCountries ? 'checked' : ''} onchange="$('#ctCountries').disabled = this.checked"> All countries</label>
        <select id="ctCountries" multiple size="8" ${r && r.allCountries ? 'disabled' : ''}>${CmpCountries.list.map(c => `<option value="${c.code}" ${r && r.countries.includes(c.code) ? 'selected' : ''}>${c.flag} ${esc(c.name)}</option>`).join('')}</select>
        <p class="text-xs text-slate-500">Hold Ctrl (or ⌘ on a Mac) to choose several.</p></div>
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseModal()')}<button class="px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">Save</button></div></form>`);
}
async function cmpTaxSave() {
  const f = $('#ctForm'), id = CMP_INV.taxEdit;
  const body = { name: f.name.value, rate: f.rate.value, allCountries: f.allCountries.checked, countries: [...$('#ctCountries').selectedOptions].map(o => o.value) };
  try { await api(id ? `/api/cmp/taxes/${id}` : '/api/cmp/taxes', { method: id ? 'PUT' : 'POST', body }); cmpCloseModal(); toast('Tax saved', true); cmpLoadTaxes(); } catch (err) { toast(err.message); }
}
async function cmpTaxActive(id, active) {
  try { await api(`/api/cmp/taxes/${id}`, { method: 'PUT', body: { active } }); cmpLoadTaxes(); } catch (err) { toast(err.message); }
}
