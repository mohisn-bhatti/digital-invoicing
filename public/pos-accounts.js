'use strict';
/* Point of Sale accounts (managers): Vendors, Purchase bills, Pay Cash to Vendor, Receive Cash and the Cash Book. None of it goes to PRA.
   A bill or a voucher is never deleted: it is voided with a reason, and then stops counting.
   Loaded after pos.js, which gives it POS, POS_PAGES, POS_RESETS, posBtn, posShowModal, posPrint, posDownloadFile ... */

const posAcct = {
  v: { q: '', filter: '', rows: [], total: 0, owed: null }, p: { q: '', status: '', vendorId: '', from: '', to: '', rows: [], total: 0, totals: null },
  cash: { RECEIPT: { q: '', from: '', to: '', method: '', rows: [], total: 0, sum: 0 }, PAYMENT: { q: '', from: '', to: '', method: '', rows: [], total: 0, sum: 0 } },
  book: { from: '', to: '', method: '', data: null }, lines: [], cur: null, hits: [], findTimer: null, vendors: [],
};
const posAcctBlank = () => ({
  v: { q: '', filter: '', rows: [], total: 0, owed: null }, p: { q: '', status: '', vendorId: '', from: '', to: '', rows: [], total: 0, totals: null },
  cash: { RECEIPT: { q: '', from: '', to: '', method: '', rows: [], total: 0, sum: 0 }, PAYMENT: { q: '', from: '', to: '', method: '', rows: [], total: 0, sum: 0 } },
  book: { from: '', to: '', method: '', data: null }, lines: [], cur: null, hits: [], findTimer: null, vendors: [],
});
POS_RESETS.push(() => { clearTimeout(posAcct.findTimer); Object.assign(posAcct, posAcctBlank()); });

const POS_METHODS = [['CASH', 'Cash'], ['BANK', 'Bank transfer'], ['CHEQUE', 'Cheque'], ['WALLET', 'Wallet / QR']];
const posMethodName = k => (POS_METHODS.find(m => m[0] === k) || [k, k])[1];
const POS_BILL_STATES = { UNPAID: ['Unpaid', 'bg-amber-100 text-amber-800'], PART: ['Part paid', 'bg-sky-100 text-sky-800'], PAID: ['Paid', 'bg-emerald-100 text-emerald-800'], VOID: ['Voided', 'bg-slate-200 text-slate-600'] };
const posBillChip = st => { const [t, c] = POS_BILL_STATES[st] || [st, 'bg-slate-100']; return `<span class="px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${c}">${t}</span>`; };
const posDayShort = d => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const posDash = '<span class="text-slate-300">—</span>';
const posAcctQuery = (o, extra = {}) => new URLSearchParams(Object.fromEntries(Object.entries({ ...o, ...extra }).filter(([, v]) => v !== '' && v !== null && v !== undefined && typeof v !== 'object'))).toString();
const posAcctClose = () => `<button type="button" onclick="posCloseModal()" class="text-2xl leading-none text-slate-400 px-2" aria-label="Close">×</button>`;
const posAcctTile = (t, big, sub, tone = '') => `<div class="border rounded-lg p-2.5"><div class="text-xs text-slate-500">${t}</div><div class="font-semibold break-words ${tone}">${big}</div><div class="text-xs text-slate-500">${sub || ''}</div></div>`;
// What a balance means in words: the business owes (vendors), the customer owes, or money is held
const posOweVendor = n => (n > 0 ? `<span class="text-red-700">We owe ${money(n)}</span>` : n < 0 ? `<span class="text-emerald-700">Paid ${money(-n)} in advance</span>` : '<span class="text-slate-500">Nothing owed</span>');
const posOweCustomer = n => (n > 0 ? `<span class="text-red-700">Owes us ${money(n)}</span>` : n < 0 ? `<span class="text-emerald-700">We hold ${money(-n)} for them</span>` : '<span class="text-slate-500">Nothing owed or held</span>');

POS_PAGES.push(
  {
    id: 'p-vendors', enter: () => posEnterVendors(),
    html: () => `
    <div class="bg-white rounded-xl shadow p-4">
      <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div><h2 class="font-semibold">Vendors</h2><p class="text-xs text-slate-500">The people and companies you buy from, and what you owe each of them.</p></div>
        <div class="flex flex-wrap gap-2 w-full sm:w-auto">
          <input id="avQ" type="search" placeholder="Name, code, phone or NTN…" oninput="posVendSearch(this.value)" class="flex-1 min-w-[10rem] sm:!w-64" autocomplete="off">
          <select id="avFilter" onchange="posVendFilter()" class="!w-auto" aria-label="Which vendors"><option value="">All in use</option><option value="owing">We owe them</option><option value="off">Switched off</option></select>
          <button type="button" onclick="posVendCsv()" class="border rounded px-3 min-h-[2.5rem] text-sm whitespace-nowrap">Download CSV</button>
          <button type="button" onclick="posImpGo('vendors')" class="needs-write border rounded px-3 min-h-[2.5rem] text-sm whitespace-nowrap">Import from Excel</button>
          <button type="button" onclick="posVendForm()" class="needs-write bg-emerald-700 text-white rounded px-3 min-h-[2.5rem] text-sm whitespace-nowrap">+ Add vendor</button></div></div>
      <div id="avNote" class="text-xs text-slate-500 mb-2"></div>
      <div class="overflow-x-auto"><table class="w-full text-sm">
        <thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Code</th><th>Vendor</th><th class="hidden sm:table-cell">Phone</th><th class="hidden md:table-cell text-right">Bought</th><th class="hidden md:table-cell text-right">Paid</th><th class="text-right">Balance</th></tr></thead>
        <tbody id="avRows"></tbody></table></div>
      <div class="mt-3 text-center"><button type="button" id="avMore" onclick="posVendLoad(true)" class="hidden border rounded px-4 min-h-[2.5rem] text-sm">Show more</button></div>
    </div>`,
  },
  {
    id: 'p-purchases', enter: () => posEnterPurchases(),
    html: () => `
    <div class="bg-white rounded-xl shadow p-4">
      <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div><h2 class="font-semibold">Purchase bills</h2><p class="text-xs text-slate-500">What you bought from your vendors. Pay a bill from here or from Pay Vendors.</p></div>
        <button type="button" onclick="posBillForm()" class="needs-write bg-emerald-700 text-white rounded px-3 min-h-[2.5rem] text-sm whitespace-nowrap">+ New purchase bill</button></div>
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-3">
        <label class="col-span-2"><span class="text-xs text-slate-500">Search</span><input id="apQ" type="search" placeholder="Number, vendor, their bill no…" oninput="posBillSearch(this.value)" autocomplete="off"></label>
        <label><span class="text-xs text-slate-500">Status</span><select id="apStatus" onchange="posBillFilter()"><option value="">All</option><option value="OPEN">Still unpaid</option><option value="PAID">Paid</option><option value="VOID">Voided</option></select></label>
        <label><span class="text-xs text-slate-500">Vendor</span><select id="apVendor" onchange="posBillFilter()"><option value="">All vendors</option></select></label>
        <label><span class="text-xs text-slate-500">From</span><input id="apFrom" type="date" onchange="posBillFilter()"></label>
        <label><span class="text-xs text-slate-500">To</span><input id="apTo" type="date" onchange="posBillFilter()"></label></div>
      <div id="apTotals" class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3"></div>
      <div class="overflow-x-auto"><table class="w-full text-sm">
        <thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Bill</th><th class="hidden sm:table-cell">Date</th><th>Vendor</th><th class="text-right">Total</th><th class="hidden sm:table-cell text-right">Still due</th><th>Status</th></tr></thead>
        <tbody id="apRows"></tbody></table></div>
      <div class="mt-3 text-center"><button type="button" id="apMore" onclick="posBillLoad(true)" class="hidden border rounded px-4 min-h-[2.5rem] text-sm">Show more</button></div>
    </div>`,
  },
  { id: 'p-pay', enter: () => posEnterVouchers('PAYMENT'), html: () => posVoucherPageHtml('PAYMENT') },
  { id: 'p-receive', enter: () => posEnterVouchers('RECEIPT'), html: () => posVoucherPageHtml('RECEIPT') },
  { id: 'p-cashbook', enter: () => posEnterBook(), html: () => '<div id="pBook"></div>' },
);

/* ---------- vendors ---------- */
async function posEnterVendors() {
  posPollAlerts();
  const q = $('#avQ'); if (q) q.value = posAcct.v.q;
  const f = $('#avFilter'); if (f) f.value = posAcct.v.filter;
  await posVendLoad(false);
}
let posVendTimer = null;
function posVendSearch(v) { posAcct.v.q = v.trim(); clearTimeout(posVendTimer); posVendTimer = setTimeout(() => posVendLoad(false), 300); }
function posVendFilter() { posAcct.v.filter = $('#avFilter').value; posVendLoad(false); }
const posVendQuery = (extra = {}) => posAcctQuery({ q: posAcct.v.q, active: posAcct.v.filter === 'off' ? '0' : posAcct.v.filter === '' ? '1' : '', owing: posAcct.v.filter === 'owing' ? '1' : '' }, extra);
async function posVendLoad(more) {
  try {
    const r = await api('/api/pos/vendors?' + posVendQuery({ limit: '100', offset: String(more ? posAcct.v.rows.length : 0) }));
    posAcct.v.rows = more ? posAcct.v.rows.concat(r.vendors) : r.vendors; posAcct.v.total = r.total; posAcct.v.owed = r.totalOwed ?? null;
    posVendRender();
  } catch (err) { toast(err.message); }
}
function posVendRender() {
  const rows = posAcct.v.rows, n = posAcct.v.total;
  $('#avNote').textContent = (rows.length < n ? `Showing ${rows.length} of ${n} vendors.` : `${n} ${n === 1 ? 'vendor' : 'vendors'}.`) + (posAcct.v.owed !== null ? ` Together you owe ${money(posAcct.v.owed)}.` : '');
  $('#avMore').classList.toggle('hidden', rows.length >= n);
  $('#avRows').innerHTML = rows.map(v => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer ${v.active ? '' : 'opacity-60'}" onclick="posVendOpen('${v.id}')">
      <td class="py-2 font-mono text-xs">${esc(v.code)}</td><td><div class="font-medium">${esc(v.name)}${v.active ? '' : ' <span class="text-xs px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">switched off</span>'}</div>${v.ntn ? `<div class="text-xs text-slate-500">NTN ${esc(v.ntn)}</div>` : ''}</td>
      <td class="hidden sm:table-cell text-xs whitespace-nowrap">${esc(v.phone) || posDash}</td>
      <td class="hidden md:table-cell text-right">${v.purchased ? money(v.purchased) : posDash}</td><td class="hidden md:table-cell text-right">${v.paid ? money(v.paid) : posDash}</td>
      <td class="text-right whitespace-nowrap">${posOweVendor(v.balance)}</td></tr>`).join('')
    || `<tr><td colspan="6" class="py-6 text-center text-slate-500">${posAcct.v.q || posAcct.v.filter ? 'No vendor matches.' : 'No vendors yet. Add the people you buy from.'}</td></tr>`;
}
function posVendCsv() { return posDownloadFile('/api/pos/export/vendors?' + posVendQuery(), 'pos-vendors.csv'); }

async function posVendOpen(id) {
  try {
    const v = posAcct.cur = await api(`/api/pos/vendors/${id}`);
    posShowModal(`<div class="space-y-3">
      <div class="flex items-start justify-between gap-3"><div><h2 class="text-lg font-semibold">${esc(v.name)} <span class="text-xs font-mono text-slate-500">${esc(v.code)}</span>${v.active ? '' : ' <span class="text-xs px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">switched off</span>'}</h2>
        <div class="text-sm text-slate-600">${[v.ntn && 'NTN ' + v.ntn, v.phone].filter(Boolean).map(esc).join(' · ') || 'No numbers saved'}</div>${v.address ? `<div class="text-sm text-slate-600">${esc(v.address)}</div>` : ''}${v.notes ? `<div class="text-xs text-slate-500 mt-1">${esc(v.notes)}</div>` : ''}</div>${posAcctClose()}</div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">${posAcctTile('Opening balance', money(v.openingBalance), 'when the books started')}${posAcctTile('Bought', money(v.purchased), `${v.purchases} ${v.purchases === 1 ? 'bill' : 'bills'}`)}${posAcctTile('Paid', money(v.paid), '')}${posAcctTile('Balance', posOweVendor(v.balance), '')}</div>
      ${v.bills.length ? `<div><div class="text-sm font-medium mb-1">Bills</div><div class="border rounded-lg divide-y max-h-56 overflow-y-auto">${v.bills.map(b => `<button type="button" onclick="posBillOpen('${b.id}')" class="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between gap-3 text-sm">
        <span class="min-w-0"><b>${esc(b.number)}</b> <span class="text-xs text-slate-500">${esc(posDayShort(b.date))}${b.vendorRef ? ' · ' + esc(b.vendorRef) : ''}</span></span><span class="flex items-center gap-2 shrink-0"><span class="font-medium">${money(b.total)}</span>${posBillChip(b.status)}</span></button>`).join('')}</div></div>` : '<p class="text-sm text-slate-500">No bills from this vendor yet.</p>'}
      ${v.payments.length ? `<div><div class="text-sm font-medium mb-1">Payments</div><div class="border rounded-lg divide-y max-h-44 overflow-y-auto">${v.payments.map(p => `<button type="button" onclick="posVoucherOpen('${p.id}')" class="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between gap-3 text-sm ${p.voided ? 'opacity-50 line-through' : ''}">
        <span class="min-w-0"><b>${esc(p.number)}</b> <span class="text-xs text-slate-500">${esc(posDayShort(p.date))} · ${esc(p.methodLabel)}${p.purchaseNumber ? ' · for ' + esc(p.purchaseNumber) : ''}</span></span><span class="font-medium shrink-0">${money(p.amount)}</span></button>`).join('')}</div></div>` : ''}
      <div class="flex flex-wrap gap-2">${v.active ? posBtn('+ New bill', `posBillForm('${v.id}')`, 'primary') + posBtn('Pay this vendor', `posPayForm('${v.id}')`) : ''}${posBtn('Change details…', `posVendForm('${v.id}')`)}${posBtn('Close', 'posCloseModal()')}</div></div>`);
  } catch (err) { toast(err.message); }
}
function posVendForm(id) {
  const v = id ? (posAcct.cur && posAcct.cur.id === id ? posAcct.cur : posAcct.v.rows.find(x => x.id === id)) : { name: '', ntn: '', phone: '', address: '', notes: '', openingBalance: 0, active: true };
  if (id && !v) return toast('Open the vendor from the list first.');
  posShowModal(`<div class="space-y-3">
    <div class="flex items-start justify-between gap-3"><h2 class="text-lg font-semibold">${id ? `Change ${esc(v.name)} <span class="text-xs font-mono text-slate-500">${esc(v.code)}</span>` : 'Add a vendor'}</h2>${posAcctClose()}</div>
    <div class="grid sm:grid-cols-2 gap-3">
      <label class="sm:col-span-2"><span>Name</span><input id="fvName" value="${esc(v.name)}" maxlength="150" autocomplete="off"></label>
      <label><span>NTN <span class="text-slate-400">(optional)</span></span><input id="fvNtn" value="${esc(v.ntn)}" maxlength="20" autocomplete="off"></label>
      <label><span>Phone</span><input id="fvPhone" value="${esc(v.phone)}" maxlength="20" inputmode="tel" oninput="posPhoneCheck(this)" autocomplete="off"></label>
      <label class="sm:col-span-2"><span>Address <span class="text-slate-400">(optional)</span></span><input id="fvAddress" value="${esc(v.address)}" maxlength="250" autocomplete="off"></label>
      <label class="sm:col-span-2"><span>Notes <span class="text-slate-400">(optional)</span></span><input id="fvNotes" value="${esc(v.notes)}" maxlength="300" autocomplete="off"></label>
      <label class="sm:col-span-2"><span>Opening balance <span class="text-slate-400">(what you owed them when you started using this; a minus sign if you had paid them in advance)</span></span><input id="fvOpen" value="${v.openingBalance ? esc(v.openingBalance) : ''}" inputmode="decimal" placeholder="0.00" autocomplete="off"></label>
      ${id ? `<label class="flex items-center gap-2 text-sm sm:col-span-2"><input id="fvActive" type="checkbox" style="width:auto" ${v.active ? 'checked' : ''}> In use (untick to stop new bills for this vendor)</label>` : ''}</div>
    <p class="text-xs text-slate-500">A vendor is never deleted: bills and payments point at it. Changing the opening balance is written to the activity log.</p>
    <div class="flex gap-2">${posBtn('Save', `posVendSave('${id || ''}')`, 'primary')}${posBtn('Cancel', 'posCloseModal()')}</div></div>`);
}
async function posVendSave(id) {
  const body = { name: $('#fvName').value, ntn: $('#fvNtn').value, phone: $('#fvPhone').value, address: $('#fvAddress').value, notes: $('#fvNotes').value, openingBalance: $('#fvOpen').value, ...(id ? { active: $('#fvActive').checked } : {}) };
  try {
    const saved = await api(id ? `/api/pos/vendors/${id}` : '/api/pos/vendors', { method: id ? 'PUT' : 'POST', body });
    toast(id ? 'Vendor saved' : `Vendor ${saved.code} added`, true); posCloseModal(); await posVendLoad(false);
  } catch (err) { toast(err.message); }
}

/* ---------- purchase bills ---------- */
async function posEnterPurchases() {
  posPollAlerts();
  try { posAcct.vendors = (await api('/api/pos/vendors?limit=500')).vendors; } catch (err) { return toast(err.message); }
  const p = posAcct.p;
  $('#apVendor').innerHTML = '<option value="">All vendors</option>' + posAcct.vendors.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
  $('#apQ').value = p.q; $('#apStatus').value = p.status; $('#apVendor').value = p.vendorId; $('#apFrom').value = p.from; $('#apTo').value = p.to;
  await posBillLoad(false);
}
let posBillTimer = null;
function posBillSearch(v) { posAcct.p.q = v.trim(); clearTimeout(posBillTimer); posBillTimer = setTimeout(() => posBillLoad(false), 300); }
function posBillFilter() { Object.assign(posAcct.p, { status: $('#apStatus').value, vendorId: $('#apVendor').value, from: $('#apFrom').value, to: $('#apTo').value }); posBillLoad(false); }
async function posBillLoad(more) {
  try {
    const p = posAcct.p;
    const r = await api('/api/pos/purchases?' + posAcctQuery({ q: p.q, status: p.status, vendorId: p.vendorId, from: p.from, to: p.to }, { limit: '100', offset: String(more ? p.rows.length : 0) }));
    p.rows = more ? p.rows.concat(r.purchases) : r.purchases; p.total = r.total; p.totals = r.totals;
    posBillRender();
  } catch (err) { toast(err.message); }
}
function posBillRender() {
  const p = posAcct.p, t = p.totals;
  $('#apTotals').innerHTML = t ? posAcctTile('Bills', String(t.bills), 'not counting voided') + posAcctTile('Bought', money(t.total), '') + posAcctTile('Sales tax on them', money(t.tax), 'input tax') + posAcctTile('Still to pay', money(t.due), '', t.due > 0 ? 'text-red-700' : '') : '';
  $('#apMore').classList.toggle('hidden', p.rows.length >= p.total);
  $('#apRows').innerHTML = p.rows.map(b => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer ${b.status === 'VOID' ? 'opacity-60' : ''}" onclick="posBillOpen('${b.id}')">
      <td class="py-2"><div class="font-mono text-xs ${b.status === 'VOID' ? 'line-through' : ''}">${esc(b.number)}</div>${b.vendorRef ? `<div class="text-xs text-slate-500">${esc(b.vendorRef)}</div>` : ''}</td>
      <td class="hidden sm:table-cell text-xs whitespace-nowrap">${esc(posDayShort(b.date))}</td><td class="font-medium">${esc(b.vendorName)}</td>
      <td class="text-right whitespace-nowrap">${money(b.total)}</td><td class="hidden sm:table-cell text-right whitespace-nowrap">${b.status === 'VOID' ? posDash : money(b.due)}</td><td>${posBillChip(b.status)}</td></tr>`).join('')
    || `<tr><td colspan="6" class="py-6 text-center text-slate-500">${p.q || p.status || p.vendorId || p.from || p.to ? 'No bill matches.' : 'No purchase bills yet.'}</td></tr>`;
}

async function posBillOpen(id) {
  try {
    const b = posAcct.cur = await api(`/api/pos/purchases/${id}`);
    posShowModal(`<div class="space-y-3">
      <div class="flex items-start justify-between gap-3"><div><h2 class="text-lg font-semibold">${esc(b.number)} ${posBillChip(b.status)}</h2>
        <div class="text-sm text-slate-600">${esc(b.vendorName)} <span class="text-xs font-mono text-slate-500">${esc(b.vendorCode)}</span> · ${esc(posDayShort(b.date))}${b.vendorRef ? ' · their bill ' + esc(b.vendorRef) : ''}</div>
        ${b.note ? `<div class="text-xs text-slate-500 mt-1">${esc(b.note)}</div>` : ''}<div class="text-xs text-slate-500">Entered by ${esc(b.createdBy)}</div></div>${posAcctClose()}</div>
      <div class="border rounded-lg overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="px-3 py-1.5">Item</th><th class="text-right">Qty</th><th class="text-right">Price</th><th class="text-right px-3">Amount</th></tr></thead><tbody>
        ${b.lines.map(l => `<tr class="border-b last:border-0"><td class="px-3 py-1.5">${esc(l.itemName)}</td><td class="text-right">${esc(l.quantity)}</td><td class="text-right">${money(l.unitCost)}</td><td class="text-right px-3">${money(l.amount)}</td></tr>`).join('')}
        <tr><td colspan="3" class="px-3 py-1 text-right text-slate-500">Items</td><td class="text-right px-3">${money(b.subtotal)}</td></tr>
        <tr><td colspan="3" class="px-3 py-1 text-right text-slate-500">Sales tax on the bill</td><td class="text-right px-3">${money(b.tax)}</td></tr>
        <tr class="font-semibold"><td colspan="3" class="px-3 py-1 text-right">Total</td><td class="text-right px-3">${money(b.total)}</td></tr></tbody></table></div>
      ${b.status === 'VOID' ? posBanner('warn', `<b>Voided</b> by ${esc(b.voidedBy)}: ${esc(b.voidReason)}`) : `<div class="grid grid-cols-2 gap-2">${posAcctTile('Paid so far', money(b.paid), '')}${posAcctTile('Still to pay', money(b.due), '', b.due > 0 ? 'text-red-700' : '')}</div>`}
      ${b.payments.length ? `<div><div class="text-sm font-medium mb-1">Payments for this bill</div><div class="border rounded-lg divide-y">${b.payments.map(p => `<div class="px-3 py-2 flex items-center justify-between gap-3 text-sm ${p.voided ? 'opacity-50 line-through' : ''}"><span><b>${esc(p.number)}</b> <span class="text-xs text-slate-500">${esc(posDayShort(p.date))} · ${esc(p.methodLabel)}${p.reference ? ' · ' + esc(p.reference) : ''}</span></span><span class="font-medium">${money(p.amount)}</span></div>`).join('')}</div></div>` : ''}
      <div class="flex flex-wrap gap-2">${b.status !== 'VOID' && b.due > 0 ? posBtn('Pay this bill', `posPayForm('${b.vendorId}', '${b.id}')`, 'primary') : ''}${b.status !== 'VOID' ? posBtn('Void this bill…', `posVoidForm('purchase', '${b.id}')`, 'danger') : ''}${posBtn('Close', 'posCloseModal()')}</div></div>`);
  } catch (err) { toast(err.message); }
}

// The new-bill form: a vendor, a date, the vendor's own bill number, the lines, and the tax printed on their bill
async function posBillForm(vendorId) {
  try { posAcct.vendors = (await api('/api/pos/vendors?active=1&limit=500')).vendors; } catch (err) { return toast(err.message); }
  if (!posAcct.vendors.length) { posCloseModal(); return toast('Add a vendor first (Vendors page).'); }
  posAcct.lines = [{ itemName: '', quantity: '1', unitCost: '' }];
  posShowModal(`<div class="space-y-3">
    <div class="flex items-start justify-between gap-3"><h2 class="text-lg font-semibold">New purchase bill</h2>${posAcctClose()}</div>
    <div class="grid sm:grid-cols-3 gap-3">
      <label class="sm:col-span-2"><span>Vendor</span><select id="fbVendor">${posAcct.vendors.map(v => `<option value="${v.id}" ${v.id === vendorId ? 'selected' : ''}>${esc(v.name)} (${esc(v.code)})</option>`).join('')}</select></label>
      <label><span>Bill date</span><input id="fbDate" type="date" value="${pkDate()}" max="${pkDate()}"></label>
      <label class="sm:col-span-2"><span>Their bill number <span class="text-slate-400">(optional)</span></span><input id="fbRef" maxlength="60" autocomplete="off"></label></div>
    <div><div class="text-sm font-medium mb-1">What was bought</div><div id="fbLines" class="space-y-2"></div>
      <button type="button" onclick="posBillAddLine()" class="mt-2 border rounded px-3 min-h-[2.25rem] text-sm">+ Add a line</button></div>
    <div class="grid sm:grid-cols-3 gap-3">
      <label><span>Sales tax on their bill <span class="text-slate-400">(optional)</span></span><input id="fbTax" inputmode="decimal" placeholder="0.00" oninput="posBillTotals()" autocomplete="off"></label>
      <label class="sm:col-span-2"><span>Note <span class="text-slate-400">(optional)</span></span><input id="fbNote" maxlength="300" autocomplete="off"></label></div>
    <div id="fbTotals" class="text-sm text-right"></div>
    <div class="flex gap-2">${posBtn('Save bill', 'posBillSave()', 'primary')}${posBtn('Cancel', 'posCloseModal()')}</div></div>`);
  posBillLines();
}
function posBillRead() {
  posAcct.lines = [...document.querySelectorAll('#fbLines [data-line]')].map(r => ({ itemName: r.querySelector('.fl-name').value, quantity: r.querySelector('.fl-qty').value, unitCost: r.querySelector('.fl-cost').value }));
}
function posBillLines() {
  $('#fbLines').innerHTML = posAcct.lines.map((l, i) => `<div data-line="${i}" class="grid grid-cols-[1fr_4.5rem_6rem_2.25rem] sm:grid-cols-[1fr_6rem_8rem_2.25rem] gap-2 items-end">
    <label><span class="text-xs text-slate-500">${i === 0 ? 'Item' : '&nbsp;'}</span><input class="fl-name" value="${esc(l.itemName)}" maxlength="150" placeholder="Item" autocomplete="off"></label>
    <label><span class="text-xs text-slate-500">${i === 0 ? 'Qty' : '&nbsp;'}</span><input class="fl-qty" value="${esc(l.quantity)}" inputmode="decimal" oninput="posBillTotals()" autocomplete="off"></label>
    <label><span class="text-xs text-slate-500">${i === 0 ? 'Price' : '&nbsp;'}</span><input class="fl-cost" value="${esc(l.unitCost)}" inputmode="decimal" oninput="posBillTotals()" autocomplete="off"></label>
    <button type="button" onclick="posBillDropLine(${i})" class="min-h-[2.5rem] text-slate-400 hover:text-red-600 text-xl leading-none" aria-label="Remove this line" ${posAcct.lines.length === 1 ? 'disabled' : ''}>×</button></div>`).join('');
  posBillTotals();
}
function posBillAddLine() { posBillRead(); if (posAcct.lines.length >= 100) return toast('A bill can have 100 lines at most.'); posAcct.lines.push({ itemName: '', quantity: '1', unitCost: '' }); posBillLines(); const n = document.querySelectorAll('#fbLines .fl-name'); n[n.length - 1].focus(); }
function posBillDropLine(i) { posBillRead(); posAcct.lines.splice(i, 1); posBillLines(); }
// A preview only: the server works the amounts in whole paisa and its answer is the one that counts
function posBillTotals() {
  const el = $('#fbTotals'); if (!el) return;
  let sub = 0;
  for (const r of document.querySelectorAll('#fbLines [data-line]')) sub += Math.round((Number(r.querySelector('.fl-qty').value) || 0) * (Number(r.querySelector('.fl-cost').value) || 0) * 100) / 100;
  const tax = Number($('#fbTax').value) || 0;
  el.innerHTML = `<div class="text-slate-500">Items ${money(sub)} + tax ${money(tax)}</div><div class="text-lg font-semibold">Total ${money(Math.round((sub + tax) * 100) / 100)}</div>`;
}
async function posBillSave() {
  posBillRead();
  const body = { vendorId: $('#fbVendor').value, date: $('#fbDate').value, vendorRef: $('#fbRef').value, tax: $('#fbTax').value, note: $('#fbNote').value, lines: posAcct.lines.filter(l => l.itemName.trim() || l.unitCost !== '') };
  try {
    const b = await api('/api/pos/purchases', { method: 'POST', body });
    toast(`Bill ${b.number} saved`, true); posCloseModal();
    if (!$('#apRows') || $('#apRows').closest('.hidden')) return;
    await posBillLoad(false);
  } catch (err) { toast(err.message); }
}

/* ---------- vouchers: cash paid to vendors, cash received from customers ---------- */
const POS_VOUCHER = {
  PAYMENT: { page: 'pay', title: 'Pay Cash to Vendor', blurb: 'Money you pay out to a vendor, on a bill or on account.', add: '+ Pay a vendor', party: 'Vendor', numberLabel: 'Payment' },
  RECEIPT: { page: 'rcv', title: 'Receive Cash', blurb: 'Money a customer pays you: a part payment, an old balance or an advance (a banquet booking, say).', add: '+ Receive cash', party: 'Customer', numberLabel: 'Receipt' },
};
function posVoucherPageHtml(kind) {
  const k = POS_VOUCHER[kind], id = k.page;
  return `<div class="bg-white rounded-xl shadow p-4">
    <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
      <div><h2 class="font-semibold">${k.title}</h2><p class="text-xs text-slate-500">${k.blurb}</p></div>
      <button type="button" onclick="${kind === 'PAYMENT' ? 'posPayForm()' : 'posRcvForm()'}" class="needs-write bg-emerald-700 text-white rounded px-3 min-h-[2.5rem] text-sm whitespace-nowrap">${k.add}</button></div>
    <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
      <label class="col-span-2"><span class="text-xs text-slate-500">Search</span><input id="${id}Q" type="search" placeholder="Number, name, reference…" oninput="posVoucherSearch('${kind}', this.value)" autocomplete="off"></label>
      <label><span class="text-xs text-slate-500">How</span><select id="${id}Method" onchange="posVoucherFilter('${kind}')"><option value="">Any</option>${POS_METHODS.map(m => `<option value="${m[0]}">${m[1]}</option>`).join('')}</select></label>
      <label><span class="text-xs text-slate-500">From</span><input id="${id}From" type="date" onchange="posVoucherFilter('${kind}')"></label>
      <label><span class="text-xs text-slate-500">To</span><input id="${id}To" type="date" onchange="posVoucherFilter('${kind}')"></label></div>
    <div id="${id}Note" class="text-xs text-slate-500 mb-2"></div>
    <div class="overflow-x-auto"><table class="w-full text-sm">
      <thead class="text-left text-slate-500 border-b"><tr><th class="py-2">${k.numberLabel}</th><th class="hidden sm:table-cell">Date</th><th>${k.party}</th><th class="hidden sm:table-cell">How</th><th class="text-right">Amount</th></tr></thead>
      <tbody id="${id}Rows"></tbody></table></div>
    <div class="mt-3 text-center"><button type="button" id="${id}More" onclick="posVoucherLoad('${kind}', true)" class="hidden border rounded px-4 min-h-[2.5rem] text-sm">Show more</button></div></div>`;
}
async function posEnterVouchers(kind) {
  posPollAlerts();
  const id = POS_VOUCHER[kind].page, s = posAcct.cash[kind];
  $(`#${id}Q`).value = s.q; $(`#${id}Method`).value = s.method; $(`#${id}From`).value = s.from; $(`#${id}To`).value = s.to;
  await posVoucherLoad(kind, false);
}
const posVoucherTimers = {};
function posVoucherSearch(kind, v) { posAcct.cash[kind].q = v.trim(); clearTimeout(posVoucherTimers[kind]); posVoucherTimers[kind] = setTimeout(() => posVoucherLoad(kind, false), 300); }
function posVoucherFilter(kind) { const id = POS_VOUCHER[kind].page; Object.assign(posAcct.cash[kind], { method: $(`#${id}Method`).value, from: $(`#${id}From`).value, to: $(`#${id}To`).value }); posVoucherLoad(kind, false); }
async function posVoucherLoad(kind, more) {
  try {
    const s = posAcct.cash[kind];
    const r = await api('/api/pos/cash?' + posAcctQuery({ kind, q: s.q, method: s.method, from: s.from, to: s.to }, { limit: '100', offset: String(more ? s.rows.length : 0) }));
    s.rows = more ? s.rows.concat(r.entries) : r.entries; s.total = r.total; s.sum = r.sum;
    posVoucherRender(kind);
  } catch (err) { toast(err.message); }
}
function posVoucherRender(kind) {
  const id = POS_VOUCHER[kind].page, s = posAcct.cash[kind];
  $(`#${id}Note`).textContent = `${s.rows.length < s.total ? `Showing ${s.rows.length} of ${s.total}` : s.total} ${kind === 'PAYMENT' ? 'payments' : 'receipts'}, together ${money(s.sum)}.`;
  $(`#${id}More`).classList.toggle('hidden', s.rows.length >= s.total);
  $(`#${id}Rows`).innerHTML = s.rows.map(e => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer" onclick="posVoucherOpen('${e.id}')">
      <td class="py-2"><div class="font-mono text-xs">${esc(e.number)}</div>${e.purchaseNumber ? `<div class="text-xs text-slate-500">for ${esc(e.purchaseNumber)}</div>` : ''}</td>
      <td class="hidden sm:table-cell text-xs whitespace-nowrap">${esc(posDayShort(e.date))}</td><td class="font-medium">${esc(kind === 'PAYMENT' ? e.vendorName : e.customerName)}</td>
      <td class="hidden sm:table-cell text-xs">${esc(e.methodLabel)}${e.reference ? `<div class="text-slate-500">${esc(e.reference)}</div>` : ''}</td><td class="text-right whitespace-nowrap">${money(e.amount)}</td></tr>`).join('')
    || `<tr><td colspan="5" class="py-6 text-center text-slate-500">${s.q || s.method || s.from || s.to ? 'Nothing matches.' : kind === 'PAYMENT' ? 'No payments yet.' : 'No cash received yet.'}</td></tr>`;
}
// One voucher: what it was for, and a way to print it or to void it
async function posVoucherOpen(id) {
  try {
    const e = posAcct.cur = await api(`/api/pos/cash/${id}`);
    const pay = e.kind === 'PAYMENT';
    posShowModal(`<div class="space-y-3">
      <div class="flex items-start justify-between gap-3"><div><h2 class="text-lg font-semibold">${esc(e.number)} <span class="text-sm font-normal text-slate-500">${pay ? 'Payment to a vendor' : 'Cash received'}</span></h2>
        <div class="text-sm text-slate-600">${esc(pay ? e.vendorName : e.customerName)} <span class="text-xs font-mono text-slate-500">${esc(pay ? e.vendorCode : e.customerCode)}</span> · ${esc(posDayShort(e.date))}</div></div>${posAcctClose()}</div>
      <div class="grid grid-cols-2 gap-2">${posAcctTile('Amount', money(e.amount), '')}${posAcctTile('How', esc(e.methodLabel), esc(e.reference))}</div>
      ${e.purchaseNumber ? `<div class="text-sm">For bill <b>${esc(e.purchaseNumber)}</b></div>` : ''}${e.note ? `<div class="text-sm text-slate-600">${esc(e.note)}</div>` : ''}
      <div class="text-xs text-slate-500">Entered by ${esc(e.createdBy)}</div>
      ${e.voided ? posBanner('warn', `<b>Voided</b> by ${esc(e.voidedBy)}: ${esc(e.voidReason)}`) : ''}
      <div class="flex flex-wrap gap-2">${posBtn('Print voucher', `posVoucherPrint('${e.id}')`, 'primary')}${e.voided ? '' : posBtn('Void…', `posVoidForm('cash', '${e.id}')`, 'danger')}${posBtn('Close', 'posCloseModal()')}</div></div>`);
  } catch (err) { toast(err.message); }
}
async function posVoucherPrint(id) {
  const e = posAcct.cur && posAcct.cur.id === id ? posAcct.cur : null; if (!e) return;
  let name = ''; try { name = (POS.profile || await api('/api/pos/profile')).businessName || ''; } catch { /* the voucher prints without a heading */ }
  const pay = e.kind === 'PAYMENT';
  posPrint(`<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#000;max-width:150mm">
    <div style="font-size:16px;font-weight:bold">${esc(name)}</div>
    <div style="font-size:15px;font-weight:bold;margin:6px 0 10px">${pay ? 'PAYMENT VOUCHER' : 'CASH RECEIPT'} ${esc(e.number)}${e.voided ? ' (VOIDED)' : ''}</div>
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:3px 0;width:32%">Date</td><td><b>${esc(posDayShort(e.date))}</b></td></tr>
      <tr><td style="padding:3px 0">${pay ? 'Paid to' : 'Received from'}</td><td><b>${esc(pay ? e.vendorName : e.customerName)}</b></td></tr>
      <tr><td style="padding:3px 0">Amount</td><td><b>Rs ${money(e.amount)}</b></td></tr>
      <tr><td style="padding:3px 0">How</td><td>${esc(e.methodLabel)}${e.reference ? ' · ' + esc(e.reference) : ''}</td></tr>
      ${e.purchaseNumber ? `<tr><td style="padding:3px 0">For bill</td><td>${esc(e.purchaseNumber)}</td></tr>` : ''}${e.note ? `<tr><td style="padding:3px 0">Note</td><td>${esc(e.note)}</td></tr>` : ''}</table>
    <div style="display:flex;justify-content:space-between;margin-top:40px;font-size:11px"><div style="border-top:1px solid #000;padding-top:3px;width:45%">Prepared by ${esc(e.createdBy)}</div><div style="border-top:1px solid #000;padding-top:3px;width:45%">${pay ? 'Received by' : 'Signature'}</div></div></div>`, '@page { size: A4; margin: 15mm; }');
}

// Pay a vendor (on a bill, or on account) / receive cash from a customer
async function posPayForm(vendorId, purchaseId) {
  try { posAcct.vendors = (await api('/api/pos/vendors?active=1&limit=500')).vendors; } catch (err) { return toast(err.message); }
  if (!posAcct.vendors.length) { posCloseModal(); return toast('Add a vendor first (Vendors page).'); }
  const first = vendorId || posAcct.vendors[0].id;
  posShowModal(`<div class="space-y-3">
    <div class="flex items-start justify-between gap-3"><h2 class="text-lg font-semibold">Pay cash to a vendor</h2>${posAcctClose()}</div>
    <div class="grid sm:grid-cols-2 gap-3">
      <label class="sm:col-span-2"><span>Vendor</span><select id="fpVendor" onchange="posPayVendorChanged()">${posAcct.vendors.map(v => `<option value="${v.id}" ${v.id === first ? 'selected' : ''}>${esc(v.name)} (${esc(v.code)})</option>`).join('')}</select></label>
      <div class="sm:col-span-2 text-sm" id="fpOwe"></div>
      <label class="sm:col-span-2"><span>For which bill <span class="text-slate-400">(or on account)</span></span><select id="fpBill" onchange="posPayBillChanged()"><option value="">On account: no particular bill</option></select></label>
      ${posVoucherFields()}</div>
    <div class="flex gap-2">${posBtn('Save payment', 'posPaySave()', 'primary')}${posBtn('Cancel', 'posCloseModal()')}</div></div>`);
  await posPayVendorChanged(purchaseId);
}
async function posPayVendorChanged(purchaseId) {
  const id = $('#fpVendor').value;
  try {
    const [v, bills] = await Promise.all([api(`/api/pos/vendors/${id}`), api('/api/pos/purchases?' + posAcctQuery({ vendorId: id, status: 'OPEN' }, { limit: '200' }))]);
    if ($('#fpVendor').value !== id) return; // another vendor was picked while this loaded
    $('#fpOwe').innerHTML = posOweVendor(v.balance);
    posAcct.openBills = bills.purchases;
    $('#fpBill').innerHTML = '<option value="">On account: no particular bill</option>' + bills.purchases.map(b => `<option value="${b.id}" ${b.id === purchaseId ? 'selected' : ''}>${esc(b.number)} · ${esc(posDayShort(b.date))} · still ${money(b.due)}</option>`).join('');
    posPayBillChanged();
  } catch (err) { toast(err.message); }
}
function posPayBillChanged() {
  const b = (posAcct.openBills || []).find(x => x.id === $('#fpBill').value);
  if (b && !$('#fvAmount').dataset.touched) $('#fvAmount').value = String(b.due);
}
async function posPaySave() {
  const body = { vendorId: $('#fpVendor').value, purchaseId: $('#fpBill').value || undefined, ...posVoucherRead() };
  try {
    const e = await api('/api/pos/cash/pay', { method: 'POST', body });
    toast(`Payment ${e.number} saved`, true); posCloseModal(); posAcct.cur = e;
    if ($('#payRows') && !$('#payRows').closest('.hidden')) await posVoucherLoad('PAYMENT', false);
    if ($('#apRows') && !$('#apRows').closest('.hidden')) await posBillLoad(false);
  } catch (err) { toast(err.message); }
}
function posVoucherFields() {
  return `<label><span>Amount</span><input id="fvAmount" inputmode="decimal" placeholder="0.00" oninput="this.dataset.touched = '1'" autocomplete="off"></label>
      <label><span>Date</span><input id="fvDate" type="date" value="${pkDate()}" max="${pkDate()}"></label>
      <label><span>How</span><select id="fvMethod">${POS_METHODS.map(m => `<option value="${m[0]}">${m[1]}</option>`).join('')}</select></label>
      <label><span>Reference <span class="text-slate-400">(cheque or transfer no., optional)</span></span><input id="fvRef" maxlength="60" autocomplete="off"></label>
      <label class="sm:col-span-2"><span>Note <span class="text-slate-400">(optional)</span></span><input id="fvNoteV" maxlength="300" autocomplete="off"></label>`;
}
const posVoucherRead = () => ({ amount: $('#fvAmount').value, date: $('#fvDate').value, method: $('#fvMethod').value, reference: $('#fvRef').value, note: $('#fvNoteV').value });

function posRcvForm(customerId) {
  posAcct.hits = []; posAcct.rcvCustomer = null;
  posShowModal(`<div class="space-y-3">
    <div class="flex items-start justify-between gap-3"><h2 class="text-lg font-semibold">Receive cash</h2>${posAcctClose()}</div>
    <div class="grid sm:grid-cols-2 gap-3">
      <div class="sm:col-span-2" id="frCust"></div>
      ${posVoucherFields()}</div>
    <p class="text-xs text-slate-500">Money received is kept against the customer. If they owe you nothing yet, it shows as money you are holding for them (an advance).</p>
    <div class="flex gap-2">${posBtn('Save receipt', 'posRcvSave()', 'primary')}${posBtn('Cancel', 'posCloseModal()')}</div></div>`);
  if (customerId) posRcvPick(customerId); else posRcvRender();
}
function posRcvRender() {
  const c = posAcct.rcvCustomer, el = $('#frCust'); if (!el) return;
  if (c) {
    el.innerHTML = `<div class="flex items-start justify-between gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-2.5"><div class="min-w-0 text-sm"><div><b class="break-words">${esc(c.name)}</b> <span class="text-xs font-mono text-slate-500">${esc(c.code)}</span></div>
      <div class="text-xs">${posOweCustomer(c.balance)}</div></div><button type="button" onclick="posRcvClear()" class="shrink-0 px-3 min-h-[2.5rem] rounded-lg border bg-white text-sm">Change</button></div>`;
  } else {
    el.innerHTML = `<label><span>Customer</span><input id="frFind" placeholder="Find by name, phone, CNIC or PNTN…" oninput="posRcvFind(this.value)" autocomplete="off"></label>
      <div id="frHits" class="hidden border rounded-lg bg-white divide-y max-h-52 overflow-y-auto mt-1"></div>
      <p class="text-xs text-slate-500 mt-1">Not saved yet? Add them on the Customers page first.</p>`;
  }
}
function posRcvFind(v) {
  clearTimeout(posAcct.findTimer);
  const q = v.trim(), box = $('#frHits');
  if (q.length < 2) { if (box) { box.classList.add('hidden'); box.innerHTML = ''; } return; }
  posAcct.findTimer = setTimeout(async () => {
    try {
      const r = await api('/api/pos/customers?' + new URLSearchParams({ q, active: '1', limit: '8' }));
      const hits = $('#frHits'); if (!hits || posAcct.rcvCustomer) return;
      posAcct.hits = r.customers;
      hits.innerHTML = r.customers.map(c => `<button type="button" onclick="posRcvPick('${c.id}')" class="w-full text-left px-3 py-2.5 hover:bg-emerald-50 min-h-[2.75rem]"><div class="font-medium text-sm break-words">${esc(c.name)} <span class="text-xs font-mono text-slate-400">${esc(c.code)}</span></div>
        <div class="text-xs text-slate-500">${[c.phone, c.pntn && 'PNTN ' + c.pntn, c.cnic && 'CNIC ' + c.cnic].filter(Boolean).map(esc).join(' · ')}</div></button>`).join('') || '<div class="px-3 py-2.5 text-sm text-slate-500">No saved customer matches.</div>';
      hits.classList.remove('hidden');
    } catch { /* the search can be tried again */ }
  }, 250);
}
async function posRcvPick(id) {
  try {
    const known = posAcct.hits.find(x => x.id === id);
    const [c, l] = await Promise.all([known ? Promise.resolve(known) : api(`/api/pos/customers/${id}`), api(`/api/pos/customers/${id}/ledger`)]);
    posAcct.rcvCustomer = { id: c.id, name: c.name, code: c.code, balance: l.balance };
    posRcvRender();
  } catch (err) { toast(err.message); }
}
function posRcvClear() { posAcct.rcvCustomer = null; posRcvRender(); }
async function posRcvSave() {
  const c = posAcct.rcvCustomer; if (!c) return toast('Choose the customer the money is from.');
  try {
    const e = await api('/api/pos/cash/receive', { method: 'POST', body: { customerId: c.id, ...posVoucherRead() } });
    toast(`Receipt ${e.number} saved`, true); posCloseModal(); posAcct.cur = e;
    if ($('#rcvRows') && !$('#rcvRows').closest('.hidden')) await posVoucherLoad('RECEIPT', false);
  } catch (err) { toast(err.message); }
}

// Void a bill or a voucher: a reason is needed and is kept with who did it
function posVoidForm(what, id) {
  posShowModal(`<div class="space-y-3">
    <div class="flex items-start justify-between gap-3"><h2 class="text-lg font-semibold">Void ${what === 'purchase' ? 'this bill' : 'this voucher'}</h2>${posAcctClose()}</div>
    <p class="text-sm text-slate-600">It stays on record, marked as voided with your name and the reason, but no longer counts in any balance or in the cash book.</p>
    <label><span>Why</span><input id="fxReason" maxlength="300" autocomplete="off"></label>
    <div class="flex gap-2">${posBtn('Void it', `posVoidSave('${what}', '${id}')`, 'danger')}${posBtn('Cancel', 'posCloseModal()')}</div></div>`);
  $('#fxReason').focus();
}
async function posVoidSave(what, id) {
  try {
    await api(what === 'purchase' ? `/api/pos/purchases/${id}/void` : `/api/pos/cash/${id}/void`, { method: 'POST', body: { reason: $('#fxReason').value } });
    toast('Voided', true); posCloseModal();
    for (const [sel, f] of [['#apRows', () => posBillLoad(false)], ['#payRows', () => posVoucherLoad('PAYMENT', false)], ['#rcvRows', () => posVoucherLoad('RECEIPT', false)], ['#avRows', () => posVendLoad(false)]]) if ($(sel) && !$(sel).closest('.hidden')) await f();
    if ($('#pBook .bk-rows') && !$('#pBook').closest('.hidden')) await posBookRun();
  } catch (err) { toast(err.message); }
}

/* ---------- the cash book ---------- */
async function posEnterBook() {
  posPollAlerts();
  if (!posAcct.book.from) { posAcct.book.from = pkDate().slice(0, 8) + '01'; posAcct.book.to = pkDate(); }
  posBookShell(); await posBookRun();
}
function posBookShell() {
  const b = posAcct.book;
  $('#pBook').innerHTML = `<div class="bg-white rounded-xl shadow p-4 space-y-3">
    <div><h2 class="font-semibold">Cash book</h2><p class="text-xs text-slate-500">Every payment out and every receipt in, with the balance after each. Voided vouchers are left out.</p></div>
    <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end">
      <label><span class="text-xs text-slate-500">From</span><input id="bkFrom" type="date" value="${b.from}" onchange="posBookRead()"></label>
      <label><span class="text-xs text-slate-500">To</span><input id="bkTo" type="date" value="${b.to}" onchange="posBookRead()"></label>
      <label><span class="text-xs text-slate-500">How</span><select id="bkMethod" onchange="posBookRead()"><option value="">All</option>${POS_METHODS.map(m => `<option value="${m[0]}" ${b.method === m[0] ? 'selected' : ''}>${m[1]}</option>`).join('')}</select></label>
      <div class="col-span-2 flex flex-wrap gap-2">${posBtn('Download CSV', 'posBookCsv()')}${posBtn('Print', 'posBookPrint()')}</div></div>
    <div id="bkBody"><p class="text-sm text-slate-500">Loading…</p></div></div>`;
}
function posBookRead() { Object.assign(posAcct.book, { from: $('#bkFrom').value, to: $('#bkTo').value, method: $('#bkMethod').value }); posBookRun(); }
const posBookQuery = () => posAcctQuery({ from: posAcct.book.from, to: posAcct.book.to, method: posAcct.book.method });
async function posBookRun() {
  try { posAcct.book.data = await api('/api/pos/cashbook?' + posBookQuery()); posBookRender(); } catch (err) { $('#bkBody').innerHTML = posBanner('bad', esc(err.message)); }
}
function posBookRender() {
  const d = posAcct.book.data; if (!d) return;
  const meth = Object.values(d.byMethod).filter(m => m.in || m.out);
  $('#bkBody').innerHTML = `<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">${posAcctTile('Opening balance', money(d.opening), 'before ' + esc(posDayShort(d.from)))}${posAcctTile('Received', money(d.received), '', 'text-emerald-700')}${posAcctTile('Paid out', money(d.paid), '', 'text-red-700')}${posAcctTile('Closing balance', money(d.closing), 'at the end of ' + esc(posDayShort(d.to)))}</div>
    ${meth.length > 1 || (meth.length === 1 && !d.method) ? `<div class="text-xs text-slate-600 flex flex-wrap gap-x-4 gap-y-1">${meth.map(m => `<span><b>${esc(m.label)}</b>: in ${money(m.in)}, out ${money(m.out)}</span>`).join('')}</div>` : ''}
    ${d.truncated ? posBanner('warn', `Showing the first ${d.entries.length} of ${d.count} vouchers. Narrow the dates to see the rest. The totals above are complete.`) : ''}
    <div class="overflow-x-auto"><table class="w-full text-sm">
      <thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Date</th><th>Voucher</th><th>Party</th><th class="hidden sm:table-cell">How</th><th class="text-right">In</th><th class="text-right">Out</th><th class="text-right">Balance</th></tr></thead>
      <tbody class="bk-rows"><tr class="border-b bg-slate-50"><td class="py-1.5" colspan="6">Opening balance</td><td class="text-right">${money(d.opening)}</td></tr>
      ${d.entries.map(e => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer" onclick="posVoucherOpen('${e.id}')"><td class="py-1.5 text-xs whitespace-nowrap">${esc(posDayShort(e.date))}</td><td class="font-mono text-xs">${esc(e.number)}</td>
        <td>${esc(e.customerName || e.vendorName)}</td><td class="hidden sm:table-cell text-xs">${esc(e.methodLabel)}</td>
        <td class="text-right">${e.kind === 'RECEIPT' ? money(e.amount) : ''}</td><td class="text-right">${e.kind === 'PAYMENT' ? money(e.amount) : ''}</td><td class="text-right whitespace-nowrap">${money(e.balance)}</td></tr>`).join('')}
      <tr class="font-semibold bg-slate-50"><td class="py-1.5" colspan="4">Closing balance</td><td class="text-right">${money(d.received)}</td><td class="text-right">${money(d.paid)}</td><td class="text-right">${money(d.closing)}</td></tr></tbody></table></div>
    ${d.entries.length ? '' : '<p class="text-sm text-slate-500">Nothing was received or paid in this period.</p>'}`;
}
function posBookCsv() { return posDownloadFile('/api/pos/export/cashbook?' + posBookQuery(), 'pos-cash-book.csv'); }
async function posBookPrint() {
  const d = posAcct.book.data; if (!d) return;
  let name = ''; try { name = (POS.profile || await api('/api/pos/profile')).businessName || ''; } catch { /* prints without a heading */ }
  const td = 'style="padding:3px 6px;border-bottom:1px solid #ddd"', tr = 'style="padding:3px 6px;border-bottom:1px solid #ddd;text-align:right"';
  posPrint(`<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#000"><div style="font-size:15px;font-weight:bold">${esc(name)}</div>
    <div style="font-size:13px;font-weight:bold;margin:4px 0">Cash book: ${esc(posDayShort(d.from))} to ${esc(posDayShort(d.to))}${d.method ? ' · ' + esc(posMethodName(d.method)) : ''}</div>
    <table style="width:100%;border-collapse:collapse"><thead><tr style="text-align:left;border-bottom:2px solid #000"><th ${td}>Date</th><th ${td}>Voucher</th><th ${td}>Party</th><th ${td}>How</th><th ${tr}>In</th><th ${tr}>Out</th><th ${tr}>Balance</th></tr></thead><tbody>
    <tr><td ${td} colspan="6"><b>Opening balance</b></td><td ${tr}><b>${money(d.opening)}</b></td></tr>
    ${d.entries.map(e => `<tr><td ${td}>${esc(posDayShort(e.date))}</td><td ${td}>${esc(e.number)}</td><td ${td}>${esc(e.customerName || e.vendorName)}</td><td ${td}>${esc(e.methodLabel)}</td><td ${tr}>${e.kind === 'RECEIPT' ? money(e.amount) : ''}</td><td ${tr}>${e.kind === 'PAYMENT' ? money(e.amount) : ''}</td><td ${tr}>${money(e.balance)}</td></tr>`).join('')}
    <tr><td ${td} colspan="4"><b>Closing balance</b></td><td ${tr}><b>${money(d.received)}</b></td><td ${tr}><b>${money(d.paid)}</b></td><td ${tr}><b>${money(d.closing)}</b></td></tr></tbody></table></div>`, '@page { size: A4; margin: 12mm; }');
}
