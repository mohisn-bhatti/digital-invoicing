'use strict';
/* Point of Sale customers: the Customers page (managers) and the picker on the sale screen (everyone at the counter).
   A saved customer fills in the buyer's details in PRA's formats, so a regular company is never typed twice, and its history
   (what it bought, net of returns) is kept together. Loaded after pos.js, which gives it POS, posBtn, posShowModal ... */

const posCust = { q: '', active: '1', rows: [], total: 0, hits: [], findTimer: null, current: null };
POS_RESETS.push(() => { clearTimeout(posCust.findTimer); Object.assign(posCust, { q: '', active: '1', rows: [], total: 0, hits: [], current: null }); });

POS_PAGES.push({
  id: 'p-customers',
  enter: () => posEnterCustomers(),
  html: () => `
    <div class="bg-white rounded-xl shadow p-4">
      <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div><h2 class="font-semibold">Customers</h2><p class="text-xs text-slate-500">Regular customers: pick one on the sale screen instead of typing the buyer's details each time.</p></div>
        <div class="flex flex-wrap gap-2 w-full sm:w-auto">
          <input id="pcQ" type="search" placeholder="Name, code, phone, CNIC or PNTN…" oninput="posCustSearchList(this.value)" class="flex-1 min-w-[10rem] sm:!w-64" autocomplete="off">
          <select id="pcActive" onchange="posCustFilter()" class="!w-auto" aria-label="Which customers"><option value="1">In use</option><option value="">All</option><option value="0">Switched off</option></select>
          <button type="button" onclick="posCustCsv()" class="border rounded px-3 min-h-[2.5rem] text-sm whitespace-nowrap">Download CSV</button>
          <button type="button" onclick="posCustForm()" class="bg-emerald-700 text-white rounded px-3 min-h-[2.5rem] text-sm whitespace-nowrap">+ Add customer</button></div></div>
      <div id="pcNote" class="text-xs text-slate-500 mb-2"></div>
      <div id="pcCards" class="md:hidden space-y-2"></div>
      <div class="hidden md:block overflow-x-auto"><table class="w-full text-sm">
        <thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Code</th><th>Customer</th><th>PNTN / CNIC</th><th>Phone</th><th class="text-right">Bought (net)</th><th>Last sale</th><th></th></tr></thead>
        <tbody id="pcRows"></tbody></table></div>
      <div class="mt-3 text-center"><button type="button" id="pcMore" onclick="posCustLoad(true)" class="hidden border rounded px-4 min-h-[2.5rem] text-sm">Show more</button></div>
    </div>`,
});

/* ---------- the Customers page ---------- */
async function posEnterCustomers() {
  posPollAlerts();
  const q = document.getElementById('pcQ'); if (q) q.value = posCust.q;
  const a = document.getElementById('pcActive'); if (a) a.value = posCust.active;
  await posCustLoad(false);
}
let posCustTimer = null;
function posCustSearchList(v) { posCust.q = v.trim(); clearTimeout(posCustTimer); posCustTimer = setTimeout(() => posCustLoad(false), 300); }
function posCustFilter() { posCust.active = $('#pcActive').value; posCustLoad(false); }
const posCustQuery = (extra = {}) => new URLSearchParams({ ...(posCust.q ? { q: posCust.q } : {}), ...(posCust.active ? { active: posCust.active } : {}), ...extra });
async function posCustLoad(more) {
  try {
    const offset = more ? posCust.rows.length : 0;
    const r = await api('/api/pos/customers?' + posCustQuery({ limit: '100', offset: String(offset) }));
    posCust.rows = more ? posCust.rows.concat(r.customers) : r.customers; posCust.total = r.total;
    posCustRender();
  } catch (err) { toast(err.message); }
}
function posCustRender() {
  const rows = posCust.rows, n = posCust.total;
  $('#pcNote').textContent = rows.length < n ? `Showing ${rows.length} of ${n} customers.` : `${n} ${n === 1 ? 'customer' : 'customers'}`;
  $('#pcMore').classList.toggle('hidden', rows.length >= n);
  const ids = c => [c.pntn && 'PNTN ' + c.pntn, c.cnic && 'CNIC ' + c.cnic].filter(Boolean);
  const off = c => (c.active ? '' : ' <span class="text-xs px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">switched off</span>');
  $('#pcRows').innerHTML = rows.map(c => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer ${c.active ? '' : 'opacity-60'}" onclick="posCustOpen('${c.id}')">
      <td class="py-2 font-mono text-xs">${esc(c.code)}</td><td><div class="font-medium">${esc(c.name)}${off(c)}</div>${c.address ? `<div class="text-xs text-slate-500">${esc(c.address)}</div>` : ''}</td>
      <td class="text-xs">${ids(c).map(esc).join('<br>') || '<span class="text-slate-300">—</span>'}</td><td class="text-xs whitespace-nowrap">${esc(c.phone) || '<span class="text-slate-300">—</span>'}</td>
      <td class="text-right whitespace-nowrap">${c.sales || c.returns ? `${money(c.net)}<div class="text-xs text-slate-500">${c.sales} ${c.sales === 1 ? 'sale' : 'sales'}${c.returns ? `, ${c.returns} returned` : ''}</div>` : '<span class="text-slate-300">—</span>'}</td>
      <td class="text-xs whitespace-nowrap">${c.lastSaleAt ? esc(posWhenShort(c.lastSaleAt)) : '<span class="text-slate-300">—</span>'}</td><td class="text-right text-emerald-700 text-xs">Open</td></tr>`).join('')
    || `<tr><td colspan="7" class="py-6 text-center text-slate-500">${posCust.q ? 'No customer matches.' : 'No customers yet. Add the companies and people you sell to again and again.'}</td></tr>`;
  $('#pcCards').innerHTML = rows.map(c => `<button type="button" onclick="posCustOpen('${c.id}')" class="w-full text-left border rounded-lg p-3 hover:bg-slate-50 ${c.active ? '' : 'opacity-60'}">
      <div class="flex items-start justify-between gap-3"><div class="font-medium break-words min-w-0">${esc(c.name)}${off(c)}</div><div class="font-semibold whitespace-nowrap">${c.sales || c.returns ? money(c.net) : ''}</div></div>
      <div class="text-xs text-slate-500 mt-0.5">${esc(c.code)}${c.phone ? ' · ' + esc(c.phone) : ''}${ids(c).length ? ' · ' + ids(c).map(esc).join(' · ') : ''}</div></button>`).join('')
    || `<p class="py-6 text-center text-sm text-slate-500">${posCust.q ? 'No customer matches.' : 'No customers yet.'}</p>`;
}
function posCustCsv() { return posDownloadFile('/api/pos/export/customers?' + posCustQuery(), 'pos-customers.csv'); }

// One customer: the details, what they have bought, and their latest sales
async function posCustOpen(id) {
  try {
    const [c, led] = await Promise.all([api(`/api/pos/customers/${id}`), api(`/api/pos/customers/${id}/ledger`)]);
    posCust.current = c; c.ledger = led;
    const tile = (t, big, sub) => `<div class="border rounded-lg p-2.5"><div class="text-xs text-slate-500">${t}</div><div class="font-semibold break-words">${big}</div><div class="text-xs text-slate-500">${sub || ''}</div></div>`;
    posShowModal(`<div class="space-y-3">
      <div class="flex items-start justify-between gap-3"><div><h2 class="text-lg font-semibold">${esc(c.name)} <span class="text-xs font-mono text-slate-500">${esc(c.code)}</span>${c.active ? '' : ' <span class="text-xs px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">switched off</span>'}</h2>
        <div class="text-sm text-slate-600">${[c.pntn && 'PNTN ' + c.pntn, c.cnic && 'CNIC ' + c.cnic, c.phone].filter(Boolean).map(esc).join(' · ') || 'No numbers saved'}</div>
        ${c.address ? `<div class="text-sm text-slate-600">${esc(c.address)}</div>` : ''}${c.notes ? `<div class="text-xs text-slate-500 mt-1">${esc(c.notes)}</div>` : ''}</div>
        <button type="button" onclick="posCloseModal()" class="text-2xl leading-none text-slate-400 px-2" aria-label="Close">×</button></div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">${tile('Bought', money(c.salesTotal), `${c.sales} ${c.sales === 1 ? 'sale' : 'sales'}`)}${tile('Returned', money(c.returnsTotal), `${c.returns} credit ${c.returns === 1 ? 'note' : 'notes'}`)}${tile('Net', money(c.net), '')}${tile('Last sale', c.lastSaleAt ? esc(posWhenShort(c.lastSaleAt)) : 'none yet', '')}</div>
      <div class="border rounded-lg p-2.5 flex flex-wrap items-center justify-between gap-2"><div><div class="text-xs text-slate-500">Account (cash received from them)</div><div class="text-sm font-semibold">${posOweCustomer(led.balance)}</div>
        <div class="text-xs text-slate-500">${led.receipts ? `${money(led.received)} received in ${led.receipts} ${led.receipts === 1 ? 'receipt' : 'receipts'}` : 'Nothing received yet'}${led.openingBalance ? ` · opening balance ${money(led.openingBalance)}` : ''}</div></div>
        <div class="flex gap-2">${posBtn('Receive cash…', `posRcvForm('${c.id}')`)}${posBtn('Opening balance…', `posCustOpening('${c.id}')`)}</div></div>
      <div class="text-xs text-slate-500">${c.sales || c.returns ? 'Fiscalized sales only' + (POS.setup && POS.setup.testMode ? ', and only test sales while the server is in test mode' : '') + '.' : ''}</div>
      ${c.recent.length ? `<div><div class="text-sm font-medium mb-1">Latest sales</div><div class="border rounded-lg divide-y">${c.recent.map(s => `<button type="button" onclick="posOpenSale('${s.id}')" class="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between gap-3 text-sm">
          <span class="min-w-0"><b>${esc(s.usin)}</b>${s.invoiceType === 3 ? ' <span class="text-xs px-1.5 py-0.5 rounded bg-slate-200">Credit note</span>' : ''} <span class="text-xs text-slate-500">${esc(posWhenShort(s.createdAt))}</span></span>
          <span class="flex items-center gap-2 shrink-0"><span class="font-medium">${money(s.totalBill)}</span>${posChip(s.state)}</span></button>`).join('')}</div></div>` : '<p class="text-sm text-slate-500">No sales to this customer yet.</p>'}
      <div class="flex flex-wrap gap-2">${posBtn('Change details…', `posCustForm('${c.id}')`, 'primary')}${c.sales || c.returns || c.recent.length ? posBtn('All their sales', 'posCustSales()') : ''}${posBtn('Close', 'posCloseModal()')}</div></div>`);
  } catch (err) { toast(err.message); }
}

// What the customer owed (or had paid in advance) when the books were started here; changing it is written to the activity log
function posCustOpening(id) {
  const c = posCust.current; if (!c || c.id !== id) return;
  posShowModal(`<div class="space-y-3">
    <div class="flex items-start justify-between gap-3"><h2 class="text-lg font-semibold">Opening balance: ${esc(c.name)}</h2><button type="button" onclick="posCloseModal()" class="text-2xl leading-none text-slate-400 px-2" aria-label="Close">×</button></div>
    <label><span>What they owed you when you started using this <span class="text-slate-400">(a minus sign if you were holding their money)</span></span><input id="fcOpen" value="${c.ledger && c.ledger.openingBalance ? esc(c.ledger.openingBalance) : ''}" inputmode="decimal" placeholder="0.00" autocomplete="off"></label>
    <div class="flex gap-2">${posBtn('Save', `posCustOpeningSave('${id}')`, 'primary')}${posBtn('Cancel', `posCustOpen('${id}')`)}</div></div>`);
}
async function posCustOpeningSave(id) {
  try { await api(`/api/pos/customers/${id}/opening-balance`, { method: 'PUT', body: { openingBalance: $('#fcOpen').value } }); toast('Saved', true); await posCustOpen(id); } catch (err) { toast(err.message); }
}

function posCustSales() { const c = posCust.current; if (!c) return; posCloseModal(); posSalesCustomer(c.id, c.name); }

// Add or change a customer (a manager; a cashier can only add one while making a sale)
function posCustForm(id) {
  const c = id ? posCust.rows.find(x => x.id === id) : { name: '', pntn: '', cnic: '', phone: '', address: '', notes: '', active: true };
  if (id && !c) return toast('Open the customer from the list first.');
  posShowModal(`<div class="space-y-3">
    <div class="flex items-start justify-between gap-3"><h2 class="text-lg font-semibold">${id ? `Change ${esc(c.name)} <span class="text-xs font-mono text-slate-500">${esc(c.code)}</span>` : 'Add a customer'}</h2>
      <button type="button" onclick="posCloseModal()" class="text-2xl leading-none text-slate-400 px-2" aria-label="Close">×</button></div>
    <div class="grid sm:grid-cols-2 gap-3">
      <label class="sm:col-span-2"><span>Name (printed on the invoice)</span><input id="fcName" value="${esc(c.name)}" maxlength="150" autocomplete="off"></label>
      <label><span>PNTN <span class="text-slate-400">(like 1234567-8)</span></span><input id="fcPntn" value="${esc(c.pntn)}" maxlength="10" autocomplete="off"></label>
      <label><span>CNIC <span class="text-slate-400">(13 digits)</span></span><input id="fcCnic" value="${esc(c.cnic)}" maxlength="15" inputmode="numeric" autocomplete="off"></label>
      <label><span>Phone</span><input id="fcPhone" value="${esc(c.phone)}" maxlength="20" inputmode="tel" oninput="posPhoneCheck(this)" autocomplete="off"></label>
      <label><span>Address <span class="text-slate-400">(optional)</span></span><input id="fcAddress" value="${esc(c.address)}" maxlength="250" autocomplete="off"></label>
      <label class="sm:col-span-2"><span>Notes <span class="text-slate-400">(optional, for your staff only)</span></span><input id="fcNotes" value="${esc(c.notes)}" maxlength="300" autocomplete="off"></label>
      ${id ? `<label class="flex items-center gap-2 text-sm sm:col-span-2"><input id="fcActive" type="checkbox" style="width:auto" ${c.active ? 'checked' : ''}> In use (untick to hide this customer from the sale screen)</label>` : ''}</div>
    <p class="text-xs text-slate-500">The same PNTN or CNIC cannot be saved twice. A sale keeps its own copy of these details, so changing them later does not change invoices already made.</p>
    <div class="flex gap-2">${posBtn('Save', `posCustSave('${id || ''}')`, 'primary')}${posBtn('Cancel', 'posCloseModal()')}</div></div>`);
}
async function posCustSave(id) {
  const body = { name: $('#fcName').value, pntn: $('#fcPntn').value, cnic: $('#fcCnic').value, phone: $('#fcPhone').value, address: $('#fcAddress').value, notes: $('#fcNotes').value, ...(id ? { active: $('#fcActive').checked } : {}) };
  try {
    const saved = await api(id ? `/api/pos/customers/${id}` : '/api/pos/customers', { method: id ? 'PUT' : 'POST', body });
    toast(id ? 'Customer saved' : `Customer ${saved.code} added`, true); posCloseModal(); await posCustLoad(false);
  } catch (err) { toast(err.message); }
}

/* ---------- the picker on the sale screen ---------- */
// The slot in the buyer box: a search box, or the chosen customer with a way to change
function posRenderCustomer() {
  const el = document.getElementById('pCustomer'); if (!el) return;
  const c = POS.customer;
  for (const id of ['pbName', 'pbPntn', 'pbCnic', 'pbPhone']) { const f = document.getElementById(id); if (f) { f.readOnly = Boolean(c); f.classList.toggle('bg-slate-100', Boolean(c)); } }
  if (c) {
    el.innerHTML = `<div class="flex items-start justify-between gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-2.5">
      <div class="min-w-0 text-sm"><div><b class="break-words">${esc(c.name)}</b> <span class="text-xs font-mono text-slate-500">${esc(c.code)}</span></div>
        <div class="text-xs text-slate-600 break-words">${[c.pntn && 'PNTN ' + c.pntn, c.cnic && 'CNIC ' + c.cnic, c.phone].filter(Boolean).map(esc).join(' · ') || 'No numbers saved'}</div>
        <div class="text-xs text-slate-500">These details go on the invoice.</div></div>
      <button type="button" onclick="posCustClear()" class="shrink-0 px-3 min-h-[2.5rem] rounded-lg border bg-white text-sm">Change</button></div>`;
  } else {
    el.innerHTML = `<label><span>Saved customer</span><input id="pcFind" placeholder="Find by name, phone, CNIC or PNTN…" oninput="posCustFind(this.value)" autocomplete="off"></label>
      <div id="pcHits" class="hidden border rounded-lg bg-white divide-y max-h-52 overflow-y-auto mt-1"></div>`;
  }
  posRenderCustomerSave();
}
// "Save these details as a customer" appears once a name is typed, and not when a customer is already chosen
function posRenderCustomerSave() {
  const el = document.getElementById('pCustomerSave'); if (!el) return;
  const want = !POS.customer && String(POS.buyer.name || '').trim() !== '';
  if (!want) { if (el.innerHTML) el.innerHTML = ''; POS.saveCustomer = false; return; }
  if (el.innerHTML) return;
  el.innerHTML = `<label class="flex items-start gap-2 text-sm"><input id="pcSave" type="checkbox" style="width:auto" class="mt-1" ${POS.saveCustomer ? 'checked' : ''} onchange="POS.saveCustomer = this.checked"> <span>Save these details as a customer <span class="text-xs text-slate-500">(next time, find them above)</span></span></label>`;
}
function posCustFind(v) {
  clearTimeout(posCust.findTimer);
  const q = v.trim(), box = document.getElementById('pcHits');
  if (q.length < 2) { if (box) { box.classList.add('hidden'); box.innerHTML = ''; } return; }
  posCust.findTimer = setTimeout(async () => {
    try {
      const r = await api('/api/pos/customers?' + new URLSearchParams({ q, active: '1', limit: '8' }));
      const hits = document.getElementById('pcHits'); if (!hits || POS.customer) return;
      posCust.hits = r.customers;
      hits.innerHTML = r.customers.map(c => `<button type="button" onclick="posCustPick('${c.id}')" class="w-full text-left px-3 py-2.5 hover:bg-emerald-50 min-h-[2.75rem]"><div class="font-medium text-sm break-words">${esc(c.name)} <span class="text-xs font-mono text-slate-400">${esc(c.code)}</span></div>
        <div class="text-xs text-slate-500">${[c.phone, c.pntn && 'PNTN ' + c.pntn, c.cnic && 'CNIC ' + c.cnic].filter(Boolean).map(esc).join(' · ')}</div></button>`).join('') || '<div class="px-3 py-2.5 text-sm text-slate-500">No saved customer matches. Type the details below.</div>';
      hits.classList.remove('hidden');
    } catch { /* the typed details still work */ }
  }, 250);
}
function posCustPick(id) {
  const c = posCust.hits.find(x => x.id === id); if (!c) return;
  POS.customer = c; POS.saveCustomer = false;
  POS.buyer = { name: c.name, pntn: c.pntn, cnic: c.cnic, phone: c.phone };
  for (const [fid, k] of [['pbName', 'name'], ['pbPntn', 'pntn'], ['pbCnic', 'cnic'], ['pbPhone', 'phone']]) { const f = document.getElementById(fid); if (f) f.value = POS.buyer[k]; }
  posRenderCustomer(); posRenderCart();
  const box = document.getElementById('pBuyerBox'); if (box) box.open = true;
}
function posCustClear() {
  POS.customer = null; POS.saveCustomer = false; POS.buyer = posBlankBuyer();
  for (const fid of ['pbName', 'pbPntn', 'pbCnic', 'pbPhone']) { const f = document.getElementById(fid); if (f) f.value = ''; }
  posRenderCustomer(); posRenderCart();
}
