'use strict';
/* Point of Sale (PRA) screens: the cashier, sales and receipts, items, dashboard and settings.
   Loaded before app.html's own script, so nothing here touches that script's globals (S, api, $, esc, money, toast, route,
   PAGE_ENTER, NAV, renderNav, syncModules) until a function runs. The money maths is /pos-calc.js (PosCalc), the same file the
   server uses, so the preview always matches what is sent. */

const POS = {
  setup: null, itemsById: new Map(), counterId: null, cart: [], mode: 1, buyer: { name: '', pntn: '', cnic: '', phone: '' },
  cat: '', q: '', busy: false, result: null, detail: null,
  sales: { from: '', to: '', state: '', q: '' }, items: [], itemQ: '', branches: [], profile: null, pctTimer: null,
};
const POS_STATES = {
  AWAITING_FISCALIZATION: ['Waiting for PRA', 'bg-amber-100 text-amber-800'],
  FISCALIZED: ['Fiscalized', 'bg-emerald-100 text-emerald-800'],
  REJECTED: ['Refused by PRA', 'bg-red-100 text-red-800'],
  OUTCOME_UNKNOWN: ['Outcome unknown', 'bg-red-600 text-white'],
  CANCELLED: ['Cancelled', 'bg-slate-200 text-slate-600'],
  DRAFT: ['Draft', 'bg-slate-100 text-slate-600'],
};
const posChip = st => { const [t, c] = POS_STATES[st] || [st, 'bg-slate-100']; return `<span class="px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${c}">${t}</span>`; };
const posWhen = d => (d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—');
const posWhenShort = d => (d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
const posDay = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' }); // YYYY-MM-DD
const posCan = (...roles) => roles.includes(S.tenantRole || 'OWNER');
const posModeName = id => (POS.setup && POS.setup.paymentModes ? POS.setup.paymentModes : PosCalc.PAYMENT_MODES).find(m => m.id === Number(id))?.label || '';
const posBlankBuyer = () => ({ name: '', pntn: '', cnic: '', phone: '' });
const posBtn = (label, onclick, kind = 'plain') => {
  const k = { primary: 'bg-emerald-700 text-white hover:bg-emerald-800', danger: 'border border-red-300 text-red-700 hover:bg-red-50', plain: 'border hover:border-emerald-600' }[kind];
  return `<button type="button" onclick="${onclick}" class="px-4 py-3 sm:py-2.5 rounded-lg text-sm font-medium ${k}">${label}</button>`;
};
const posBanner = (tone, html) => `<div class="rounded-lg border px-3 py-2 text-sm ${{ warn: 'bg-amber-50 border-amber-300 text-amber-900', bad: 'bg-red-50 border-red-300 text-red-800', info: 'bg-sky-50 border-sky-200 text-sky-900' }[tone]}">${html}</div>`;

/* ---------- start ---------- */
async function initPos() {
  try {
    if (!S.meta) { S.meta = await api('/api/meta'); renderNav(); }
    S.settings = await api('/api/client/settings');
    if (syncModules()) return;
    if (S.settings.tenantRole && S.settings.tenantRole !== S.tenantRole) { S.tenantRole = S.settings.tenantRole; saveSession(); renderNav(); }
  } catch (err) { toast(err.message); }
  $('#envBadge').classList.add('hidden'); // the FBR environment badge belongs to Digital Invoicing
  const host = $('#clientView');
  host.querySelectorAll('[data-page^="p-"]').forEach(el => el.remove());
  host.insertAdjacentHTML('beforeend', posPagesHtml());
  posEnsureModals();
  Object.assign(PAGE_ENTER, { 'p-dashboard': posEnterDashboard, 'p-sale': posEnterSale, 'p-sales': posEnterSales, 'p-items': posEnterItems, 'p-settings': posEnterSettings });
  route();
}

function posPagesHtml() {
  const page = (id, inner) => `<div data-page="${id}" class="page hidden space-y-4">${inner}</div>`;
  return [
    page('p-dashboard', '<div id="pDash"></div>'),
    page('p-sale', `
      <div class="pb-24 md:pb-0 space-y-4">
        <div id="pSaleBanner" class="space-y-2"></div>
        <div class="grid grid-cols-1 md:grid-cols-5 gap-4 items-start">
          <section class="min-w-0 md:col-span-3 space-y-3">
            <div class="bg-white rounded-xl shadow p-3 space-y-2">
              <input id="pSearch" type="search" placeholder="Search items…" autocomplete="off" oninput="posSearch(this.value)" class="!text-base">
              <div id="pCats" class="flex flex-wrap gap-1.5"></div>
            </div>
            <div id="pGrid" class="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2"></div>
          </section>
          <aside id="pCartPanel" class="min-w-0 md:col-span-2 md:sticky md:top-20 scroll-mt-20">
            <div class="bg-white rounded-xl shadow p-4 space-y-3">
              <div class="flex items-center justify-between gap-2"><h2 class="font-semibold">Current sale</h2>
                <button type="button" onclick="posToItems()" class="md:hidden text-sm text-emerald-700 underline px-1 min-h-[2.5rem] whitespace-nowrap">+ Add items</button></div>
              <select id="pCounter" onchange="posPickCounter(this.value)" class="w-full !text-sm"></select>
              <div id="pCart" class="space-y-2 md:max-h-[42vh] md:overflow-y-auto"></div>
              <div id="pTotals"></div>
              <div><div class="text-xs text-slate-600 mb-1">Paid by</div><div id="pPay" class="grid grid-cols-3 gap-2"></div></div>
              <details class="text-sm"><summary class="cursor-pointer text-slate-600 py-2">Buyer details (optional)</summary>
                <div class="grid grid-cols-2 gap-2 mt-2">
                  <label class="col-span-2"><span>Name</span><input id="pbName" maxlength="150" oninput="posBuyer('name', this.value)" autocomplete="off"></label>
                  <label><span>PNTN</span><input id="pbPntn" maxlength="9" placeholder="1234567-8" oninput="posBuyer('pntn', this.value)" autocomplete="off"></label>
                  <label><span>CNIC</span><input id="pbCnic" maxlength="15" placeholder="13 digits" oninput="posBuyer('cnic', this.value)" inputmode="numeric" autocomplete="off"></label>
                  <label class="col-span-2"><span>Phone</span><input id="pbPhone" maxlength="20" oninput="posBuyer('phone', this.value)" inputmode="tel" autocomplete="off"></label>
                </div></details>
              <div class="flex gap-2">
                <button type="button" onclick="posClear()" class="px-4 min-h-[3rem] rounded-lg border">Clear</button>
                <button id="pGo" type="button" onclick="posFinalize()" class="flex-1 px-4 min-h-[3rem] rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-base font-semibold disabled:opacity-50 disabled:cursor-not-allowed">Finalize &amp; send to PRA</button>
              </div>
              <p class="text-xs text-slate-500">The receipt prints once PRA gives the fiscal invoice number.</p>
              <div id="pResult"></div>
            </div>
          </aside>
        </div>
        <div id="pBar" class="hidden md:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t shadow-lg px-3 py-2 flex items-center gap-3">
          <div class="flex-1 min-w-0"><div id="pBarCount" class="text-xs text-slate-500"></div><div id="pBarTotal" class="text-lg font-semibold truncate"></div></div>
          <button type="button" onclick="posToCart()" class="px-5 min-h-[3rem] rounded-lg bg-emerald-700 text-white font-semibold whitespace-nowrap">Review &amp; pay</button>
        </div>
      </div>`),
    page('p-sales', `
      <div class="bg-white rounded-xl shadow p-4">
        <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3 mb-3">
          <label><span>From</span><input id="psFrom" type="date" onchange="posSalesFilter()"></label>
          <label><span>To</span><input id="psTo" type="date" onchange="posSalesFilter()"></label>
          <label><span>Status</span><select id="psState" onchange="posSalesFilter()"><option value="">All</option>
            ${Object.entries(POS_STATES).filter(([k]) => k !== 'DRAFT').map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}</select></label>
          <div class="flex items-end gap-2">
            <button type="button" onclick="posSalesToday()" class="flex-1 sm:flex-none px-3 min-h-[2.5rem] rounded border text-sm">Today</button>
            <button type="button" onclick="posLoadSales()" class="flex-1 sm:flex-none px-3 min-h-[2.5rem] rounded border text-sm">Refresh</button></div>
          <label class="col-span-2 sm:flex-1 sm:min-w-[12rem]"><span>Search</span><input id="psQ" type="search" placeholder="Invoice no., PRA no. or buyer" oninput="posSalesSearch()" autocomplete="off"></label>
        </div>
        <div id="psNote" class="text-xs text-slate-500 mb-2"></div>
        <div id="psCards" class="md:hidden space-y-2"></div>
        <div class="hidden md:block overflow-x-auto"><table class="w-full text-sm">
          <thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Time</th><th>Invoice</th><th>Buyer</th><th class="text-right">Total</th><th>Status</th><th>PRA invoice no.</th></tr></thead>
          <tbody id="psRows"></tbody></table></div>
      </div>`),
    page('p-items', `
      <div class="bg-white rounded-xl shadow p-4">
        <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
          <h2 class="font-semibold">Items</h2>
          <div class="flex gap-2 w-full sm:w-auto"><input id="piQ" type="search" placeholder="Search items…" oninput="posItemSearch(this.value)" class="flex-1 sm:!w-52" autocomplete="off">
            <button type="button" onclick="posItemForm()" class="bg-emerald-700 text-white rounded px-3 min-h-[2.5rem] text-sm whitespace-nowrap">+ Add item</button></div>
        </div>
        <div id="piForm"></div>
        <div id="piCards" class="md:hidden space-y-2"></div>
        <div class="hidden md:block overflow-x-auto"><table class="w-full text-sm">
          <thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Code</th><th>Item</th><th>Category</th><th>PCT code</th><th class="text-right">Tax %</th><th class="text-right">Tax % on card</th><th class="text-right">Price</th><th></th></tr></thead>
          <tbody id="piRows"></tbody></table></div>
      </div>`),
    page('p-settings', '<div id="pSettings"></div>'),
  ].join('');
}

function posEnsureModals() {
  if ($('#posModal')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="posModal" class="hidden fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-y-auto p-2 sm:p-4" onclick="if (event.target === this) posCloseModal()">
      <div id="posModalBody" class="bg-white rounded-xl shadow-xl w-full max-w-3xl mt-2 sm:mt-6 p-4 sm:p-5"></div></div>
    <div id="posReceiptModal" class="hidden fixed inset-0 z-[60] bg-black/50 flex items-start justify-center overflow-y-auto p-2 sm:p-4" onclick="if (event.target === this) posCloseReceipt()">
      <div class="bg-white rounded-xl shadow-xl p-4 sm:p-5 mt-2 sm:mt-6 space-y-3">
        <div class="flex items-center justify-between gap-4"><h2 class="font-semibold">Receipt</h2>
          <div class="flex gap-2"><button type="button" onclick="posPrintReceipt()" class="bg-emerald-700 text-white rounded px-4 py-2 text-sm">Print</button>
            <button type="button" onclick="posCloseReceipt()" class="border rounded px-4 py-2 text-sm">Close</button></div></div>
        <div class="flex justify-center overflow-x-auto"><div id="posReceipt"></div></div></div></div>`);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { posCloseReceipt(); posCloseModal(); } });
}
const posShowModal = html => { $('#posModalBody').innerHTML = html; $('#posModal').classList.remove('hidden'); };
function posCloseModal() { const m = $('#posModal'); if (m) m.classList.add('hidden'); POS.detail = null; }

/* ---------- the cashier ---------- */
async function posLoadSetup() {
  POS.setup = await api('/api/pos/setup');
  POS.itemsById = new Map(POS.setup.items.map(i => [i.id, i]));
  if (!POS.setup.counters.some(c => c.id === POS.counterId)) {
    let last = null; try { last = localStorage.getItem('posCounter'); } catch { /* per-browser convenience only */ }
    POS.counterId = (POS.setup.counters.find(c => c.id === last) || POS.setup.counters[0] || {}).id || null;
  }
  POS.cart = POS.cart.filter(c => POS.itemsById.has(c.itemId));
}
async function posEnterSale() {
  try { await posLoadSetup(); } catch (err) { return toast(err.message); }
  posRenderSale();
}
function posRenderSale() { posRenderBanner(); posRenderCounters(); posRenderCats(); posRenderGrid(); posRenderCart(); posRenderPay(); posRenderResult(); }
const posCounter = () => (POS.setup ? POS.setup.counters.find(c => c.id === POS.counterId) : null);

function posRenderBanner() {
  const s = POS.setup, c = posCounter(), out = [];
  if (s.testMode) out.push(posBanner('warn', '<b>Test mode.</b> Sales are not sent to PRA and get fake invoice numbers (starting MOCK-). Nothing here is a real fiscal invoice.'));
  if (!s.counters.length) out.push(posBanner('bad', 'No counter is set up yet. Ask the account owner to add one in <b>Settings</b> (it needs the POS ID PRA gave you).'));
  else if (c && !c.hasToken && !s.testMode) out.push(posBanner('bad', `Counter <b>${esc(c.name)}</b> has no PRA token yet, so sales cannot be sent. Ask the account owner to add it in Settings.`));
  if (c && c.breaker && c.breaker.open) out.push(posBanner('warn', `The connection to PRA has failed several times, so it is resting for about ${Math.ceil(c.breaker.retryInMs / 1000)} seconds.`));
  if (!s.items.length) out.push(posBanner('info', 'There are no items yet. A manager adds them under <b>Items</b>.'));
  $('#pSaleBanner').innerHTML = out.join('');
}
function posRenderCounters() {
  const sel = $('#pCounter'), cs = POS.setup.counters;
  sel.innerHTML = cs.length ? cs.map(c => `<option value="${c.id}" ${c.id === POS.counterId ? 'selected' : ''}>${esc(c.branch)} · ${esc(c.name)}${c.env === 'SANDBOX' ? ' (sandbox)' : ''}</option>`).join('') : '<option>No counter</option>';
  sel.classList.toggle('hidden', cs.length < 2);
}
function posPickCounter(id) {
  POS.counterId = id;
  try { localStorage.setItem('posCounter', id); } catch { /* per-browser convenience only */ }
  posRenderBanner(); posRenderGo();
}
function posRenderCats() {
  const cats = [...new Set(POS.setup.items.map(i => i.category || '__none'))].sort();
  const chip = (v, label) => `<button type="button" onclick="posCategory('${esc(v)}')" class="px-3 py-1.5 rounded-full border text-sm ${POS.cat === v ? 'bg-emerald-700 border-emerald-700 text-white' : 'bg-white hover:border-emerald-600'}">${esc(label)}</button>`;
  $('#pCats').innerHTML = cats.length > 1 ? chip('', 'All') + cats.map(c => chip(c, c === '__none' ? 'Other' : c)).join('') : '';
}
function posCategory(v) { POS.cat = v; posRenderCats(); posRenderGrid(); }
function posSearch(v) { POS.q = v.trim().toLowerCase(); posRenderGrid(); }
function posRenderGrid() {
  const list = POS.setup.items.filter(i => (!POS.cat || (i.category || '__none') === POS.cat) && (!POS.q || (i.name + ' ' + i.code + ' ' + i.category).toLowerCase().includes(POS.q)));
  $('#pGrid').innerHTML = list.map(i => `<button type="button" onclick="posAdd('${i.id}')" class="text-left bg-white border rounded-xl p-3 min-h-[5rem] shadow-sm hover:border-emerald-600 active:bg-emerald-50">
    <div class="font-medium leading-tight">${esc(i.name)}</div><div class="text-xs text-slate-500 mt-1">${i.openPrice ? 'Enter the price' : money(i.unitPrice)}</div></button>`).join('')
    || `<p class="col-span-full text-sm text-slate-500 p-3">${POS.setup.items.length ? 'No item matches.' : ''}</p>`;
}

function posAdd(itemId) {
  const item = POS.itemsById.get(itemId);
  const same = !item.openPrice && POS.cart.find(c => c.itemId === itemId && !c.disc);
  if (same) same.qty = String(Number(same.qty || 0) + 1); else POS.cart.push({ itemId, qty: '1', price: '', disc: '' });
  POS.result = null; posRenderResult(); posRenderCart();
}
function posQty(i, d) { const c = POS.cart[i]; const n = Math.max(0, Math.round((Number(c.qty || 0) + d) * 10000) / 10000); if (n <= 0) POS.cart.splice(i, 1); else c.qty = String(n); posRenderCart(); }
function posSetQty(i, v) { POS.cart[i].qty = String(v).trim(); posRenderCart(); }
function posSetPrice(i, v) { POS.cart[i].price = String(v).trim(); posRenderCart(); }
function posSetDisc(i, v) { POS.cart[i].disc = String(v).trim(); posRenderCart(); }
function posRemove(i) { POS.cart.splice(i, 1); posRenderCart(); }
function posMode(id) { POS.mode = id; posRenderPay(); posRenderCart(); }
function posBuyer(k, v) { POS.buyer[k] = v; }
function posClear() {
  POS.cart = []; POS.buyer = posBlankBuyer(); POS.mode = 1; POS.result = null;
  for (const [id, k] of [['pbName', 'name'], ['pbPntn', 'pntn'], ['pbCnic', 'cnic'], ['pbPhone', 'phone']]) $('#' + id).value = POS.buyer[k];
  posRenderPay(); posRenderCart(); posRenderResult();
}
function posRenderPay() {
  $('#pPay').innerHTML = POS.setup.paymentModes.map(m => `<button type="button" onclick="posMode(${m.id})" class="px-2 py-3 rounded-lg border text-sm ${m.id === POS.mode ? 'bg-emerald-700 border-emerald-700 text-white' : 'bg-white hover:border-emerald-600'}">${esc(m.label)}</button>`).join('');
}

// What each line comes to, and the totals, worked out with the server's own maths
function posPreview() {
  const lines = [], errors = [];
  POS.cart.forEach((c, i) => {
    const item = POS.itemsById.get(c.itemId);
    try {
      const base = { quantity: c.qty, unitPrice: item.openPrice ? c.price : item.unitPrice };
      if (item.openPrice && String(c.price).trim() === '') throw new Error('Enter the price.');
      let discount = String(c.disc || '').trim();
      if (discount.endsWith('%')) discount = PosCalc.discountFromPercent(base, discount.slice(0, -1).trim());
      lines[i] = { ...base, discount: discount || 0, taxRate: PosCalc.rateFor(item, POS.mode) };
      PosCalc.calcSale([lines[i]]);
    } catch (e) { errors[i] = e.message; lines[i] = null; }
  });
  const ok = POS.cart.length > 0 && !errors.some(Boolean);
  let sale = null;
  if (ok) { try { sale = PosCalc.calcSale(lines); } catch (e) { errors[0] = e.message; } }
  return { lines, errors, ok: ok && Boolean(sale), sale, each: lines.map(l => { try { return l ? PosCalc.calcSale([l]).lines[0] : null; } catch { return null; } }) };
}
function posRenderCart() {
  const el = $('#pCart');
  if (!POS.cart.length) { el.innerHTML = '<p class="text-sm text-slate-500 py-6 text-center">Tap an item to add it to the sale.</p>'; $('#pTotals').innerHTML = ''; posRenderBar(null); posRenderGo(); return; }
  const pv = posPreview();
  el.innerHTML = POS.cart.map((c, i) => {
    const item = POS.itemsById.get(c.itemId), r = pv.each[i];
    return `<div class="border rounded-lg p-2">
      <div class="flex items-start justify-between gap-2"><div class="font-medium text-sm leading-tight pt-1 min-w-0 break-words">${esc(item.name)}</div>
        <button type="button" onclick="posRemove(${i})" aria-label="Remove ${esc(item.name)}" class="shrink-0 w-11 h-11 -mt-1 -mr-1 flex items-center justify-center text-slate-400 hover:text-red-600 text-2xl leading-none">×</button></div>
      <div class="mt-1 flex flex-wrap items-center gap-2">
        <div class="inline-flex items-center border rounded-lg overflow-hidden">
          <button type="button" onclick="posQty(${i}, -1)" class="w-11 h-11 text-xl hover:bg-slate-50" aria-label="Less">−</button>
          <input value="${esc(c.qty)}" inputmode="decimal" onchange="posSetQty(${i}, this.value)" class="!w-14 !h-11 text-center !border-0 !rounded-none" aria-label="Quantity">
          <button type="button" onclick="posQty(${i}, 1)" class="w-11 h-11 text-xl hover:bg-slate-50" aria-label="More">+</button></div>
        ${item.openPrice ? `<input value="${esc(c.price)}" placeholder="Price" inputmode="decimal" onchange="posSetPrice(${i}, this.value)" class="!w-24 !h-11" aria-label="Price">` : `<span class="text-xs text-slate-500">× ${money(item.unitPrice)}</span>`}
        <input value="${esc(c.disc)}" placeholder="Discount Rs or %" onchange="posSetDisc(${i}, this.value)" class="!w-32 !h-11 !text-sm" aria-label="Discount">
        <div class="ml-auto font-semibold">${r ? money(r.totalAmount) : '—'}</div></div>
      ${r ? `<div class="text-xs text-slate-500 mt-1">Tax ${r.taxRate}%: ${money(r.taxCharged)}${r.discount ? ` · discount ${money(r.discount)}` : ''}</div>` : ''}
      ${pv.errors[i] ? `<div class="text-xs text-red-600 mt-1">${esc(pv.errors[i])}</div>` : ''}</div>`;
  }).join('');
  const t = pv.sale && pv.sale.totals;
  $('#pTotals').innerHTML = t ? `<div class="border-t pt-2 space-y-1 text-sm">
      <div class="flex justify-between"><span>Sale value</span><span>${money(t.saleValue)}</span></div>
      ${t.discount ? `<div class="flex justify-between text-slate-500"><span>Discount given</span><span>${money(t.discount)}</span></div>` : ''}
      <div class="flex justify-between"><span>Sales tax</span><span>${money(t.tax)}</span></div>
      <div class="flex justify-between text-xl font-semibold pt-1"><span>Total</span><span>${money(t.bill)}</span></div></div>` : '';
  posRenderBar(pv);
  posRenderGo();
}
// On a phone the cart is below the items: a bar at the bottom always shows the total and jumps to it
function posRenderBar(pv) {
  const bar = $('#pBar'); if (!bar) return;
  if (!POS.cart.length) { bar.classList.add('hidden'); return; }
  const n = POS.cart.length;
  $('#pBarCount').textContent = `${n} ${n === 1 ? 'item' : 'items'}${pv && pv.errors.some(Boolean) ? ' · needs attention' : ''}`;
  $('#pBarTotal').textContent = pv && pv.sale ? money(pv.sale.totals.bill) : '—';
  bar.classList.remove('hidden');
}
const posToCart = () => $('#pCartPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
const posToItems = () => window.scrollTo({ top: 0, behavior: 'smooth' });
function posRenderGo() {
  const go = $('#pGo'); if (!go) return;
  const pv = POS.cart.length ? posPreview() : { ok: false };
  go.disabled = POS.busy || !pv.ok || !POS.counterId;
  go.textContent = POS.busy ? 'Sending to PRA…' : 'Finalize & send to PRA';
}

async function posFinalize() {
  if (POS.busy) return;
  const pv = posPreview();
  if (!pv.ok || !POS.counterId) return;
  POS.busy = true; posRenderGo();
  try {
    const lines = POS.cart.map(c => {
      const item = POS.itemsById.get(c.itemId), d = String(c.disc || '').trim();
      return { itemId: c.itemId, quantity: c.qty, unitPrice: item.openPrice ? c.price : undefined, ...(d.endsWith('%') ? { discountPercent: d.slice(0, -1).trim() } : d ? { discount: d } : {}) };
    });
    const r = await api('/api/pos/sales', { method: 'POST', body: { counterId: POS.counterId, paymentMode: POS.mode, buyer: POS.buyer, lines } });
    POS.cart = []; POS.buyer = posBlankBuyer(); POS.mode = 1;
    for (const id of ['pbName', 'pbPntn', 'pbCnic', 'pbPhone']) $('#' + id).value = '';
    POS.result = r.result.outcome === 'FISCALIZED' ? null : r;
    posRenderPay(); posRenderCart(); posRenderResult();
    if (r.result.outcome === 'FISCALIZED') { toast(`Sale ${r.sale.usin} fiscalized`, true); await posShowReceipt(r.sale.id); }
    posLoadSetup().then(() => { posRenderBanner(); posRenderCounters(); }).catch(() => {});
  } catch (err) { toast(err.message); }
  POS.busy = false; posRenderGo();
}

// A sale that is made but not fiscalized stays on screen until someone deals with it
function posRenderResult() {
  const el = $('#pResult'); if (!el) return;
  const r = POS.result;
  if (!r) { el.innerHTML = ''; return; }
  const o = r.result.outcome, s = r.sale;
  const head = { REJECTED: 'PRA refused this sale', NOT_SENT: 'Not sent to PRA', UNKNOWN: 'Outcome unknown: do not ring this sale up again' }[o] || 'Not fiscalized';
  const tone = o === 'UNKNOWN' || o === 'REJECTED' ? 'border-red-400 bg-red-50' : 'border-amber-300 bg-amber-50';
  el.innerHTML = `<div class="rounded-lg border-2 ${tone} p-3 text-sm space-y-2">
    <div class="flex items-start justify-between gap-2"><div class="font-semibold">${esc(head)}</div><button type="button" onclick="POS.result = null; posRenderResult()" class="text-slate-400 text-lg leading-none px-1" aria-label="Dismiss">×</button></div>
    <div>Invoice ${esc(s.usin)}, ${money(s.totalBill)}. ${esc(r.result.message)}</div>
    ${o === 'UNKNOWN' ? '<div class="font-medium">PRA may already have this sale. Tell a manager: they check PRA\'s report and record what they find. It will not be sent again by itself.</div>' : ''}
    <div class="flex flex-wrap gap-2">${o === 'NOT_SENT' ? posBtn('Try again', `posRetry('${s.id}')`, 'primary') : ''}${o === 'REJECTED' ? posBtn('Correct and send again', `posOpenSale('${s.id}')`, 'primary') : ''}${posBtn('Open the sale', `posOpenSale('${s.id}')`)}</div></div>`;
}

/* ---------- receipt ---------- */
async function posShowReceipt(id) {
  try {
    const rc = await api(`/api/pos/sales/${id}/receipt`);
    posEnsureModals();
    $('#posReceipt').innerHTML = posReceiptHtml(rc);
    $('#posReceiptModal').classList.remove('hidden');
    if (typeof QRCode !== 'undefined') new QRCode($('#posQr'), { text: rc.sale.verifyUrl, width: 96, height: 96, correctLevel: QRCode.CorrectLevel.L });
  } catch (err) { toast(err.message); }
}
function posReceiptHtml(rc) {
  const s = rc.sale, b = rc.business, credit = s.invoiceType === 3, rule = '<div style="border-top:1px dashed #000;margin:4px 0"></div>';
  const row = (l, r, bold) => `<div style="display:flex;justify-content:space-between;gap:6px;${bold ? 'font-weight:bold;' : ''}"><span>${l}</span><span>${r}</span></div>`;
  const buyer = [s.buyer.name, s.buyer.pntn && 'PNTN ' + s.buyer.pntn, s.buyer.cnic && 'CNIC ' + s.buyer.cnic, s.buyer.phone].filter(Boolean);
  return `<div style="text-align:center">
      ${s.mock ? '<div style="border:2px solid #000;padding:2px;font-weight:bold;margin-bottom:4px">TEST MODE: NOT A FISCAL INVOICE</div>' : ''}
      <div style="font-weight:bold;font-size:13px">${esc(b.name)}</div>
      ${rc.branch ? `<div>${esc(rc.branch.name)}${rc.branch.address ? ', ' + esc(rc.branch.address) : ''}</div>` : ''}
      ${b.address ? `<div>${esc(b.address)}</div>` : ''}${b.phone ? `<div>Tel: ${esc(b.phone)}</div>` : ''}
      <div>PNTN / NTN: ${esc(b.pntn || '—')}</div></div>${rule}
    <div style="text-align:center;font-weight:bold;font-size:12px">${credit ? 'CREDIT NOTE' : 'TAX INVOICE'}</div>
    ${credit ? `<div style="text-align:center">Returns invoice ${esc(s.refUsin || '')}</div>` : ''}
    ${row('PRA invoice no.', `<b style="word-break:break-all">${esc(s.fiscalNumber)}</b>`)}${row('Invoice no. (USIN)', esc(s.usin))}
    ${row('Date', esc(posWhen(s.at)))}${row('Counter', `${esc(rc.counter.name)} (POS ${esc(rc.counter.posId)})`)}${row('Cashier', esc(s.cashier || ''))}
    ${buyer.length ? `<div>Buyer: ${buyer.map(esc).join(' · ')}</div>` : ''}${rule}
    ${s.lines.map(l => `<div style="margin-bottom:3px"><div style="font-weight:bold">${esc(l.itemName)}</div>
      ${row(`${l.quantity} × ${money(l.unitPrice)}${l.discount ? ` − disc ${money(l.discount)}` : ''}`, money(l.saleValue))}
      ${row(`Sales tax ${l.taxRate}%`, money(l.taxCharged))}${row('Item total', money(l.totalAmount))}</div>`).join('')}${rule}
    ${row('Value before tax', money(s.totals.saleValue))}${s.totals.discount ? row('Discount given', money(s.totals.discount)) : ''}${row('Sales tax', money(s.totals.tax))}
    ${row(credit ? 'TOTAL RETURNED' : 'TOTAL', money(s.totals.bill), true)}${row('Paid by', esc(posModeName(s.paymentMode)))}${rule}
    <div style="text-align:center"><div id="posQr" class="posqr" style="display:inline-block;padding:.12in;background:#fff"></div>
      <div style="font-size:10px">Scan to verify this invoice with PRA</div>
      ${b.footer ? `<div style="margin-top:4px">${esc(b.footer)}</div>` : ''}</div>`;
}
function posPrintReceipt() {
  document.body.classList.add('print-pos');
  let st = document.getElementById('pageStyle');
  if (!st) { st = document.createElement('style'); st.id = 'pageStyle'; document.head.appendChild(st); }
  st.textContent = '@page { size: 80mm auto; margin: 3mm; }';
  window.print();
  setTimeout(() => document.body.classList.remove('print-pos'), 500);
}
function posCloseReceipt() { const m = $('#posReceiptModal'); if (m) m.classList.add('hidden'); }

/* ---------- sales and receipts ---------- */
async function posEnterSales() {
  if (!POS.sales.from) POS.sales.from = POS.sales.to = posDay(new Date());
  $('#psFrom').value = POS.sales.from; $('#psTo').value = POS.sales.to; $('#psState').value = POS.sales.state; $('#psQ').value = POS.sales.q;
  if (!POS.setup) { try { await posLoadSetup(); } catch { /* the list still loads */ } }
  await posLoadSales();
}
function posSalesFilter() { POS.sales = { from: $('#psFrom').value, to: $('#psTo').value, state: $('#psState').value, q: $('#psQ').value.trim() }; posLoadSales(); }
let posSalesTimer = null;
function posSalesSearch() { clearTimeout(posSalesTimer); posSalesTimer = setTimeout(posSalesFilter, 350); }
function posSalesToday() { POS.sales = { from: posDay(new Date()), to: posDay(new Date()), state: '', q: '' }; posEnterSales(); }
async function posLoadSales() {
  try {
    const f = POS.sales, qs = new URLSearchParams({ ...(f.from ? { from: f.from } : {}), ...(f.to ? { to: f.to } : {}), ...(f.state ? { state: f.state } : {}), ...(f.q ? { q: f.q } : {}), limit: '200' });
    const r = await api('/api/pos/sales?' + qs);
    $('#psNote').textContent = r.total > r.sales.length ? `Showing the latest ${r.sales.length} of ${r.total}. Narrow the dates or search to see the rest.` : `${r.total} ${r.total === 1 ? 'sale' : 'sales'}`;
    const tags = s => `${s.invoiceType === 3 ? ' <span class="text-xs px-1.5 py-0.5 rounded bg-slate-200">Credit note</span>' : ''}${s.mock ? ' <span class="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">test</span>' : ''}`;
    $('#psRows').innerHTML = r.sales.map(s => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer" onclick="posOpenSale('${s.id}')">
      <td class="py-2 pr-2 whitespace-nowrap">${esc(posWhenShort(s.createdAt))}</td>
      <td><span class="font-medium">${esc(s.usin)}</span>${tags(s)}</td>
      <td class="pr-2">${esc(s.buyerName || '—')}</td><td class="text-right whitespace-nowrap pr-3">${money(s.totalBill)}</td><td>${posChip(s.state)}</td>
      <td class="font-mono text-xs break-all pl-2">${esc(s.fiscalNumber || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="py-6 text-center text-slate-500">No sales for this choice.</td></tr>';
    $('#psCards').innerHTML = r.sales.map(s => `<button type="button" onclick="posOpenSale('${s.id}')" class="w-full text-left border rounded-lg p-3 hover:bg-slate-50 active:bg-slate-100">
      <div class="flex items-start justify-between gap-2"><div class="min-w-0"><span class="font-semibold">${esc(s.usin)}</span>${tags(s)}</div>${posChip(s.state)}</div>
      <div class="flex items-baseline justify-between gap-3 mt-1"><span class="text-sm text-slate-600 truncate">${esc(s.buyerName || '—')}</span><span class="font-semibold whitespace-nowrap">${money(s.totalBill)}</span></div>
      <div class="text-xs text-slate-500 mt-1 break-all">${esc(posWhenShort(s.createdAt))}${s.fiscalNumber ? ' · PRA ' + esc(s.fiscalNumber) : ''}</div></button>`).join('') || '<p class="py-6 text-center text-sm text-slate-500">No sales for this choice.</p>';
  } catch (err) { toast(err.message); }
}

async function posOpenSale(id) {
  try { POS.detail = await api(`/api/pos/sales/${id}`); posShowModal(posSaleHtml(POS.detail)); } catch (err) { toast(err.message); }
}
function posSaleHtml(d) {
  const credit = d.invoiceType === 3, mgr = posCan('OWNER', 'ACCOUNTANT');
  const note = {
    AWAITING_FISCALIZATION: posBanner('warn', `<b>Not fiscalized yet.</b> ${esc(d.lastError || 'It has not been sent to PRA.')}`),
    REJECTED: posBanner('bad', `<b>PRA refused this sale.</b> ${esc(d.lastError || '')} Correct the buyer details if needed and send it again, or cancel it.`),
    OUTCOME_UNKNOWN: `<div class="rounded-lg border-2 border-red-500 bg-red-50 text-red-900 p-3 text-sm space-y-1"><b>Outcome unknown.</b> ${esc(d.lastError || '')}
      <div>PRA may or may not have this sale, so it is <b>never sent again by itself</b>. Open PRA IRIS (e.pra.punjab.gov.pk), choose <b>IMS Fiscal Report</b> and look for invoice number <b>${esc(d.usin)}</b>, then record what you found below.</div></div>`,
    CANCELLED: posBanner('info', `<b>Cancelled.</b> ${esc(d.note || '')}`),
  }[d.state] || '';
  const acts = [];
  if (d.state === 'FISCALIZED') { acts.push(posBtn('Print receipt', `posShowReceipt('${d.id}')`, 'primary')); if (mgr && !credit) acts.push(posBtn('Return items…', `posCreditForm('${d.id}')`)); }
  if (d.state === 'AWAITING_FISCALIZATION' || d.state === 'REJECTED') {
    acts.push(posBtn('Send to PRA again', `posRetry('${d.id}')`, 'primary'), posBtn('Correct buyer details', `posBuyerForm('${d.id}')`));
    if (mgr) acts.push(posBtn('Cancel sale', `posCancelForm('${d.id}')`, 'danger'));
  }
  if (d.state === 'OUTCOME_UNKNOWN' && mgr) acts.push(posBtn('Record what I found at PRA…', `posResolveForm('${d.id}')`, 'primary'));
  const th = c => `<th class="py-1 px-1 ${c || ''}">`;
  return `<div class="space-y-3">
    <div class="flex items-start justify-between gap-3"><div><h2 class="text-lg font-semibold">${credit ? 'Credit note' : 'Sale'} ${esc(d.usin)} ${posChip(d.state)}</h2>
      <div class="text-xs text-slate-500">${esc(d.counterName)} (POS ${esc(d.counterPosId)}, ${d.env === 'PRODUCTION' ? 'production' : 'sandbox'}) · ${esc(posWhen(d.finalizedAt || d.createdAt))} · by ${esc(d.createdBy)}${credit ? ` · returns invoice ${esc(d.refUsin)}` : ''}</div></div>
      <button type="button" onclick="posCloseModal()" class="text-2xl leading-none text-slate-400 px-2" aria-label="Close">×</button></div>
    ${note}
    ${d.fiscalNumber ? `<div class="text-sm">PRA invoice no. <b class="font-mono break-all">${esc(d.fiscalNumber)}</b>${d.mock ? ' <span class="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">test mode</span>' : ''}${d.resolvedBy ? ` <span class="text-xs text-slate-500">(confirmed by hand by ${esc(d.resolvedBy)})</span>` : ''}</div>` : ''}
    <div class="text-sm text-slate-700">Paid by <b>${esc(posModeName(d.paymentMode))}</b>${d.buyer.name || d.buyer.pntn || d.buyer.cnic || d.buyer.phone ? ` · Buyer: ${[d.buyer.name, d.buyer.pntn && 'PNTN ' + d.buyer.pntn, d.buyer.cnic && 'CNIC ' + d.buyer.cnic, d.buyer.phone].filter(Boolean).map(esc).join(' · ')}` : ''}</div>
    <div class="hidden md:block overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr>${th()}Item</th>${th('text-right')}Qty</th>${th('text-right')}Price</th>${th('text-right')}Discount</th>${th('text-right')}Value</th>${th('text-right')}Tax</th>${th('text-right')}Total</th>${credit ? '' : th('text-right') + 'Returned</th>'}</tr></thead><tbody>
      ${d.lines.map(l => `<tr class="border-b last:border-0"><td class="py-1 px-1">${esc(l.itemName)}<div class="text-[11px] text-slate-400">${esc(l.itemCode)} · PCT ${esc(l.pctCode)}</div></td><td class="text-right px-1">${l.quantity}</td><td class="text-right px-1">${money(l.unitPrice)}</td><td class="text-right px-1">${l.discount ? money(l.discount) : ''}</td><td class="text-right px-1">${money(l.saleValue)}</td><td class="text-right px-1">${money(l.taxCharged)} <span class="text-[11px] text-slate-400">${l.taxRate}%</span></td><td class="text-right px-1 font-medium">${money(l.totalAmount)}</td>${credit ? '' : `<td class="text-right px-1">${l.returned && l.returned.quantity ? l.returned.quantity : ''}</td>`}</tr>`).join('')}
      <tr class="font-semibold"><td class="py-1 px-1" colspan="4">Total</td><td class="text-right px-1">${money(d.totals.saleValue)}</td><td class="text-right px-1">${money(d.totals.tax)}</td><td class="text-right px-1">${money(d.totals.bill)}</td>${credit ? '' : '<td></td>'}</tr></tbody></table></div>
    <div class="md:hidden space-y-2">${d.lines.map(l => `<div class="border rounded-lg p-2.5 text-sm">
        <div class="font-medium break-words">${esc(l.itemName)}</div><div class="text-[11px] text-slate-400">${esc(l.itemCode)} · PCT ${esc(l.pctCode)}</div>
        <div class="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-slate-600">
          <span>${l.quantity} × ${money(l.unitPrice)}</span><span class="text-right">Value ${money(l.saleValue)}</span>
          <span>${l.discount ? `Discount ${money(l.discount)}` : ''}</span><span class="text-right">Tax ${l.taxRate}%: ${money(l.taxCharged)}</span>
          <span>${!credit && l.returned && l.returned.quantity ? `Returned ${l.returned.quantity}` : ''}</span><span class="text-right text-sm font-semibold text-slate-900">${money(l.totalAmount)}</span></div></div>`).join('')}
      <div class="flex justify-between font-semibold px-1 pt-1"><span>Total</span><span>${money(d.totals.bill)}</span></div></div>
    ${d.creditNotes.length ? `<div class="text-sm">Credit notes: ${d.creditNotes.map(c => `<a href="#" onclick="event.preventDefault(); posOpenSale('${c.id}')" class="underline text-emerald-700">${esc(c.usin)}</a> (${POS_STATES[c.state] ? POS_STATES[c.state][0] : c.state}, ${money(c.totalBill)})`).join(' · ')}</div>` : ''}
    <div class="flex flex-wrap gap-2">${acts.join('')}</div>
    <div id="posForm"></div>
    <details class="text-sm"><summary class="cursor-pointer text-slate-600">History (${d.events.length} changes, ${d.tries.length} ${d.tries.length === 1 ? 'call' : 'calls'} to PRA)</summary>
      <ul class="mt-2 space-y-1 text-xs">${d.events.map(e => `<li><span class="text-slate-400">${esc(posWhen(e.at))}</span> · ${e.from && e.from !== e.to ? `${esc(e.from)} → ` : ''}<b>${esc(e.to)}</b> · ${esc(e.by)}${e.note ? ' · ' + esc(e.note) : ''}</li>`).join('')}</ul>
      ${d.tries.length ? `<table class="mt-2 text-xs w-full"><thead class="text-left text-slate-400"><tr><th>Sent</th><th>Took</th><th>Result</th><th>PRA said</th></tr></thead><tbody>${d.tries.map(t => `<tr><td>${esc(posWhen(t.at))}</td><td>${t.durationMs} ms</td><td>${esc(t.outcome)}${t.httpStatus ? ' (HTTP ' + t.httpStatus + ')' : ''}</td><td>${esc(t.message)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${mgr && d.payload ? `<details class="mt-2"><summary class="cursor-pointer text-slate-500">What was sent to PRA</summary><pre class="text-[11px] bg-slate-50 border rounded p-2 overflow-x-auto">${esc(JSON.stringify(d.payload, null, 2))}</pre></details>` : ''}</details></div>`;
}
const posForm = html => { $('#posForm').innerHTML = html; $('#posForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
async function posRefreshAfter(r, id) {
  // r is a { sale, result } from a send; show what happened, then the sale as it now stands
  if (r && r.result) {
    if (r.result.outcome === 'FISCALIZED') { toast(`Fiscalized: PRA invoice no. ${r.result.fiscalNumber}`, true); posOpenSale(id); posShowReceipt(id); }
    else { toast(r.result.message); posOpenSale(id); }
  } else posOpenSale(id);
  if (S.page === 'p-sales') posLoadSales();
  if (S.page === 'p-dashboard') posEnterDashboard();
}
async function posRetry(id) {
  try { toast('Sending to PRA…', true); posRefreshAfter(await api(`/api/pos/sales/${id}/retry`, { method: 'POST', body: {} }), id); } catch (err) { toast(err.message); }
}
function posBuyerForm(id) {
  const b = POS.detail.buyer;
  posForm(`<div class="border rounded-lg p-3 space-y-2"><div class="font-medium text-sm">Correct the buyer details</div>
    <div class="grid sm:grid-cols-4 gap-2">
      <label class="sm:col-span-2"><span>Name</span><input id="fbName" value="${esc(b.name)}" maxlength="150"></label>
      <label><span>PNTN</span><input id="fbPntn" value="${esc(b.pntn)}" maxlength="9" placeholder="1234567-8"></label>
      <label><span>CNIC</span><input id="fbCnic" value="${esc(b.cnic)}" maxlength="15" inputmode="numeric"></label>
      <label class="sm:col-span-2"><span>Phone</span><input id="fbPhone" value="${esc(b.phone)}" maxlength="20" inputmode="tel"></label></div>
    <div class="flex gap-2">${posBtn('Save', `posBuyerSave('${id}')`, 'primary')}${posBtn('Not now', "$('#posForm').innerHTML = ''")}</div></div>`);
}
async function posBuyerSave(id) {
  try {
    await api(`/api/pos/sales/${id}`, { method: 'PATCH', body: { buyer: { name: $('#fbName').value, pntn: $('#fbPntn').value, cnic: $('#fbCnic').value, phone: $('#fbPhone').value } } });
    toast('Buyer details saved. Send the sale to PRA again.', true); posOpenSale(id);
  } catch (err) { toast(err.message); }
}
function posCancelForm(id) {
  posForm(`<div class="border border-red-200 rounded-lg p-3 space-y-2"><div class="font-medium text-sm">Cancel this sale</div>
    <p class="text-xs text-slate-600">PRA does not have this sale, so it can be cancelled. The record stays, with your reason.</p>
    <label><span>Why is it being cancelled?</span><input id="fcReason" maxlength="300" autocomplete="off"></label>
    <div class="flex gap-2">${posBtn('Cancel the sale', `posCancel('${id}')`, 'danger')}${posBtn('Keep it', "$('#posForm').innerHTML = ''")}</div></div>`);
}
async function posCancel(id) {
  try { await api(`/api/pos/sales/${id}/cancel`, { method: 'POST', body: { reason: $('#fcReason').value } }); toast('Sale cancelled', true); posOpenSale(id); if (S.page === 'p-sales') posLoadSales(); }
  catch (err) { toast(err.message); }
}
function posResolveForm(id) {
  posForm(`<div class="border border-red-300 rounded-lg p-3 space-y-2"><div class="font-medium text-sm">What did PRA's report show?</div>
    <label class="flex items-start gap-2 text-sm"><input type="radio" name="frResult" value="FISCALIZED" style="width:auto" class="mt-1" onchange="$('#frNoWrap').classList.remove('hidden')"> <span><b>The sale is there.</b> PRA recorded it under an invoice number.</span></label>
    <div id="frNoWrap" class="hidden ml-6"><label><span>PRA invoice number, exactly as the report shows it</span><input id="frNo" maxlength="40" autocomplete="off"></label></div>
    <label class="flex items-start gap-2 text-sm"><input type="radio" name="frResult" value="NOT_FOUND" style="width:auto" class="mt-1" onchange="$('#frNoWrap').classList.add('hidden')"> <span><b>It is not there.</b> PRA did not record it, so it can be sent again or cancelled.</span></label>
    <label class="flex items-start gap-2 text-sm"><input type="radio" name="frResult" value="STILL_UNKNOWN" style="width:auto" class="mt-1" onchange="$('#frNoWrap').classList.add('hidden')"> <span><b>I could not tell yet.</b> Leave it as it is and add a note.</span></label>
    <label><span>How did you check? (this is kept with the sale)</span><input id="frNote" maxlength="300" autocomplete="off" placeholder="e.g. Found in the IMS Fiscal Report on 19 Oct"></label>
    <div class="flex gap-2">${posBtn('Save', `posResolve('${id}')`, 'primary')}${posBtn('Not now', "$('#posForm').innerHTML = ''")}</div></div>`);
}
async function posResolve(id) {
  const result = (document.querySelector('input[name=frResult]:checked') || {}).value;
  if (!result) return toast('Choose what the report showed.');
  try {
    await api(`/api/pos/sales/${id}/resolve`, { method: 'POST', body: { result, fiscalNumber: $('#frNo').value, note: $('#frNote').value } });
    toast('Recorded', true); posOpenSale(id); if (S.page === 'p-sales') posLoadSales(); if (S.page === 'p-dashboard') posEnterDashboard();
  } catch (err) { toast(err.message); }
}
function posCreditForm(id) {
  const d = POS.detail;
  posForm(`<div class="border rounded-lg p-3 space-y-2"><div class="font-medium text-sm">Return items (credit note)</div>
    <table class="w-full text-sm"><thead class="text-left text-slate-500"><tr><th>Item</th><th class="text-right">Sold</th><th class="text-right">Already returned</th><th class="text-right">Return now</th></tr></thead><tbody>
      ${d.lines.map(l => { const left = Math.round((l.quantity - (l.returned.quantity || 0)) * 10000) / 10000; return `<tr class="border-t"><td class="py-1">${esc(l.itemName)}</td><td class="text-right">${l.quantity}</td><td class="text-right">${l.returned.quantity || ''}</td>
        <td class="text-right">${left > 0 ? `<input data-line="${l.id}" data-max="${left}" inputmode="decimal" placeholder="0" class="!w-20 text-right" aria-label="Return quantity of ${esc(l.itemName)}">` : '<span class="text-slate-400">all returned</span>'}</td></tr>`; }).join('')}</tbody></table>
    <label><span>Reason for the return</span><input id="fcnReason" maxlength="300" autocomplete="off"></label>
    <p class="text-xs text-slate-600">The credit note is sent to PRA at the price and tax of the original sale. Print it for the customer once PRA accepts it.</p>
    <div class="flex gap-2">${posBtn('Send credit note to PRA', `posCredit('${id}')`, 'primary')}${posBtn('Not now', "$('#posForm').innerHTML = ''")}</div></div>`);
}
async function posCredit(id) {
  const lines = [...document.querySelectorAll('#posForm input[data-line]')].map(i => ({ lineId: i.dataset.line, quantity: i.value.trim() })).filter(l => l.quantity && Number(l.quantity) > 0);
  if (!lines.length) return toast('Enter how many of each item are returned.');
  try {
    toast('Sending the credit note to PRA…', true);
    const r = await api(`/api/pos/sales/${id}/credit-note`, { method: 'POST', body: { lines, reason: $('#fcnReason').value } });
    if (r.result.outcome === 'FISCALIZED') { toast(`Credit note ${r.sale.usin} fiscalized`, true); await posShowReceipt(r.sale.id); } else toast(`Credit note ${r.sale.usin}: ${r.result.message}`);
    posOpenSale(r.result.outcome === 'FISCALIZED' ? id : r.sale.id); if (S.page === 'p-sales') posLoadSales();
  } catch (err) { toast(err.message); }
}

/* ---------- items ---------- */
async function posEnterItems() { await posLoadItems(); }
async function posLoadItems() {
  try { POS.items = await api('/api/pos/items' + (POS.itemQ ? '?q=' + encodeURIComponent(POS.itemQ) : '')); posRenderItems(); } catch (err) { toast(err.message); }
}
let posItemTimer = null;
function posItemSearch(v) { POS.itemQ = v.trim(); clearTimeout(posItemTimer); posItemTimer = setTimeout(posLoadItems, 300); }
function posRenderItems() {
  const pct = i => i.pctCode.slice(0, 4) + '.' + i.pctCode.slice(4);
  $('#piRows').innerHTML = POS.items.map(i => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer ${i.active ? '' : 'opacity-50'}" onclick="posItemForm('${i.id}')">
    <td class="py-2 font-mono text-xs">${esc(i.code)}</td><td class="font-medium">${esc(i.name)}${i.openPrice ? ' <span class="text-xs text-slate-500">(price typed on each sale)</span>' : ''}${i.active ? '' : ' <span class="text-xs">(switched off)</span>'}</td>
    <td>${esc(i.category)}</td><td class="font-mono text-xs">${esc(pct(i))}</td><td class="text-right">${i.taxRate}</td><td class="text-right">${i.taxRateCard === null ? '<span class="text-slate-400">same</span>' : i.taxRateCard}</td>
    <td class="text-right">${i.openPrice ? '—' : money(i.unitPrice)}</td><td class="text-right text-emerald-700 text-xs">Edit</td></tr>`).join('') || '<tr><td colspan="8" class="py-6 text-center text-slate-500">No items yet. Add the services you sell.</td></tr>';
  $('#piCards').innerHTML = POS.items.map(i => `<button type="button" onclick="posItemForm('${i.id}')" class="w-full text-left border rounded-lg p-3 hover:bg-slate-50 ${i.active ? '' : 'opacity-50'}">
    <div class="flex items-start justify-between gap-3"><div class="font-medium break-words min-w-0">${esc(i.name)}</div><div class="font-semibold whitespace-nowrap">${i.openPrice ? 'price on sale' : money(i.unitPrice)}</div></div>
    <div class="text-xs text-slate-500 mt-0.5">${esc(i.code)}${i.category ? ' · ' + esc(i.category) : ''} · PCT ${esc(pct(i))}</div>
    <div class="text-xs mt-1">Tax ${i.taxRate}%${i.taxRateCard === null ? '' : ` · on card ${i.taxRateCard}%`}${i.openPrice ? ' · price typed on each sale' : ''}${i.active ? '' : ' · switched off'}</div></button>`).join('') || '<p class="py-6 text-center text-sm text-slate-500">No items yet. Add the services you sell.</p>';
}
function posItemForm(id) {
  const i = id ? POS.items.find(x => x.id === id) : { code: '', name: '', category: '', pctCode: '', taxRate: '', taxRateCard: null, unitPrice: '', openPrice: false, active: true };
  const cats = [...new Set(POS.items.map(x => x.category).filter(Boolean))];
  $('#piForm').innerHTML = `<div class="border rounded-lg p-4 mb-4 bg-slate-50 space-y-3">
    <div class="font-medium">${id ? `Edit ${esc(i.name)} <span class="text-xs text-slate-500">(code ${esc(i.code)} stays the same)</span>` : 'Add an item'}</div>
    <div class="grid sm:grid-cols-4 gap-3">
      <label class="sm:col-span-2"><span>Name (printed on the receipt)</span><input id="fiName" value="${esc(i.name)}" maxlength="150" autocomplete="off"></label>
      <label><span>Category</span><input id="fiCat" value="${esc(i.category)}" maxlength="60" list="fiCats" autocomplete="off"><datalist id="fiCats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label><span>Price before tax</span><input id="fiPrice" value="${i.unitPrice === '' ? '' : esc(i.unitPrice)}" inputmode="decimal" ${i.openPrice ? 'disabled' : ''}></label>
      <label><span>PCT code (8 digits)</span><input id="fiPct" value="${esc(i.pctCode ? i.pctCode.slice(0, 4) + '.' + i.pctCode.slice(4) : '')}" placeholder="9801.2000" oninput="posPctSearch(this.value)" autocomplete="off"></label>
      <label><span>Sales tax %</span><input id="fiRate" value="${esc(i.taxRate)}" inputmode="decimal"></label>
      <label><span>Sales tax % when paid by card <span class="text-slate-400">(optional)</span></span><input id="fiRateCard" value="${i.taxRateCard === null ? '' : esc(i.taxRateCard)}" inputmode="decimal" placeholder="same as above"></label>
      <div class="flex flex-col justify-end gap-1 text-sm">
        <label class="flex items-center gap-2"><input id="fiOpen" type="checkbox" style="width:auto" ${i.openPrice ? 'checked' : ''} onchange="$('#fiPrice').disabled = this.checked"> The cashier types the price on each sale</label>
        <label class="flex items-center gap-2"><input id="fiActive" type="checkbox" style="width:auto" ${i.active ? 'checked' : ''}> On sale (untick to hide it from the cashier)</label></div></div>
    <div id="fiPctHits" class="text-sm"></div>
    <div class="text-xs text-slate-600 space-y-1">
      <div>Services (PRA's Second Schedule): <a href="#" class="underline text-emerald-700" onclick="event.preventDefault(); posPctSearch('9801')">hotels, restaurants, marriage halls, lawns, clubs, caterers (9801)</a>. Type a word such as <i>restaurant</i> to search.</div>
      <div>The tax rate must follow the current PRA notification for your service. Restaurants are charged a different rate when the customer pays by card, mobile wallet or QR: enter that in the card box. <a class="underline text-emerald-700" href="https://pra.punjab.gov.pk/Downloads/Updated-2nd-Schedule-of-PSTS-Act-2012.pdf" target="_blank" rel="noopener">PRA Second Schedule</a></div></div>
    <div class="flex gap-2"><button type="button" onclick="posItemSave('${id || ''}')" class="bg-emerald-700 text-white rounded px-4 py-2 text-sm">Save item</button>
      <button type="button" onclick="$('#piForm').innerHTML = ''" class="border rounded px-4 py-2 text-sm">Close</button></div></div>`;
  $('#piForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function posPctSearch(v) {
  clearTimeout(POS.pctTimer);
  POS.pctTimer = setTimeout(async () => {
    const box = $('#fiPctHits'); if (!box) return;
    if (String(v).trim().length < 2) { box.innerHTML = ''; return; }
    try {
      const rows = await api('/api/pos/pct?q=' + encodeURIComponent(v));
      box.innerHTML = rows.length ? `<div class="border rounded-lg bg-white divide-y max-h-56 overflow-y-auto">${rows.map(r => `<button type="button" class="block w-full text-left px-3 py-1.5 hover:bg-emerald-50" onclick="posPctPick('${r.code}')"><span class="font-mono">${esc(r.code)}</span> <span class="text-slate-600">${esc(r.description)}</span></button>`).join('')}</div>` : '<span class="text-slate-500">No service heading matches.</span>';
    } catch { /* the code can still be typed */ }
  }, 250);
}
function posPctPick(code) { $('#fiPct').value = code; $('#fiPctHits').innerHTML = ''; }
async function posItemSave(id) {
  const body = {
    name: $('#fiName').value, category: $('#fiCat').value, pctCode: $('#fiPct').value, taxRate: $('#fiRate').value, taxRateCard: $('#fiRateCard').value,
    unitPrice: $('#fiPrice').value, openPrice: $('#fiOpen').checked, active: $('#fiActive').checked,
  };
  try {
    await api(id ? `/api/pos/items/${id}` : '/api/pos/items', { method: id ? 'PUT' : 'POST', body });
    toast('Item saved', true); $('#piForm').innerHTML = ''; await posLoadItems();
  } catch (err) { toast(err.message); }
}

/* ---------- dashboard ---------- */
async function posEnterDashboard() {
  try { posRenderDash(await api('/api/pos/overview')); } catch (err) { toast(err.message); }
}
function posRenderDash(o) {
  const card = (title, big, sub, tone = '') => `<div class="bg-white rounded-xl shadow p-4"><div class="text-xs text-slate-500">${title}</div><div class="text-xl sm:text-2xl font-semibold mt-1 break-words ${tone}">${big}</div><div class="text-xs text-slate-500 mt-1">${sub || ''}</div></div>`;
  const alerts = [];
  if (o.outcomeUnknown) alerts.push(`<div class="rounded-lg border-2 border-red-500 bg-red-50 text-red-900 p-3 text-sm flex flex-wrap items-center justify-between gap-2"><span><b>${o.outcomeUnknown} ${o.outcomeUnknown === 1 ? 'sale has' : 'sales have'} an unknown outcome.</b> PRA may or may not have ${o.outcomeUnknown === 1 ? 'it' : 'them'}. Check PRA's report and record what you find.</span>${posBtn('Show them', "posShowState('OUTCOME_UNKNOWN')", 'danger')}</div>`);
  if (o.rejected) alerts.push(posBanner('bad', `<b>${o.rejected} ${o.rejected === 1 ? 'sale was' : 'sales were'} refused by PRA.</b> <a href="#" class="underline" onclick="event.preventDefault(); posShowState('REJECTED')">Correct and send again, or cancel</a>.`));
  if (o.awaiting) alerts.push(posBanner('warn', `<b>${o.awaiting} ${o.awaiting === 1 ? 'sale is' : 'sales are'} waiting for PRA</b> (not sent yet). <a href="#" class="underline" onclick="event.preventDefault(); posShowState('AWAITING_FISCALIZATION')">Send ${o.awaiting === 1 ? 'it' : 'them'}</a>.`));
  if (o.testMode) alerts.push(posBanner('warn', '<b>Test mode.</b> Nothing is sent to PRA; receipts get fake invoice numbers. The server is set live when the business is ready.'));
  if (!o.profileComplete) alerts.push(posBanner('warn', 'The business name, address and PNTN are not complete. They are printed on every receipt and are needed before production sales. The account owner adds them in <b>Settings</b>.'));
  $('#pDash').innerHTML = `<div class="space-y-4">${alerts.join('')}
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
      ${card('Sales today', money(o.todaySales.total), `${o.todaySales.count} fiscal ${o.todaySales.count === 1 ? 'invoice' : 'invoices'}, tax ${money(o.todaySales.tax)}`)}
      ${card('Returns today', money(o.todayReturns.total), `${o.todayReturns.count} credit ${o.todayReturns.count === 1 ? 'note' : 'notes'}`)}
      ${card('Last fiscal invoice', o.lastFiscalizedAt ? esc(posWhen(o.lastFiscalizedAt)) : 'none yet', '').replace('text-xl sm:text-2xl', 'text-base')}
      ${card('Needs attention', o.outcomeUnknown + o.rejected + o.awaiting, `${o.outcomeUnknown} unknown · ${o.rejected} refused · ${o.awaiting} waiting`, o.outcomeUnknown ? 'text-red-700' : o.rejected + o.awaiting ? 'text-amber-700' : 'text-emerald-700')}</div>
    <div class="bg-white rounded-xl shadow p-4"><div class="flex flex-wrap items-center justify-between gap-2 mb-2"><h2 class="font-semibold">Counters and the connection to PRA</h2>
      <div class="flex gap-2">${posBtn('New sale', "go('p-sale')", 'primary')}${posBtn('Sales & receipts', "go('p-sales')")}</div></div>
      <div>${o.counters.map(c => `<div class="border-t py-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 ${c.active ? '' : 'opacity-50'}">
          <div class="min-w-0"><b>${esc(c.branch)} · ${esc(c.name)}</b>${c.active ? '' : ' (off)'} ${c.env === 'PRODUCTION' ? '<span class="text-xs font-semibold text-emerald-800">Production</span>' : '<span class="text-xs text-slate-500">Sandbox</span>'}
            <div class="text-xs text-slate-500">Token ${c.hasToken ? 'saved' : '<span class="text-red-700">missing</span>'}${c.pending ? ` · <span class="text-amber-700">${c.pending} waiting for PRA</span>` : ''}</div></div>
          <div class="text-sm">${c.breaker.open ? `<span class="text-amber-700">connection resting (${Math.ceil(c.breaker.retryInMs / 1000)} s)</span>` : c.breaker.fails ? `<span class="text-amber-700">${c.breaker.fails} failed in a row</span>` : '<span class="text-emerald-700">connection ok</span>'}</div></div>`).join('') || '<div class="border-t py-4 text-center text-slate-500 text-sm">No counter yet. The account owner adds one in Settings.</div>'}</div></div></div>`;
}
function posShowState(state) { POS.sales = { from: '', to: '', state, q: '' }; go('p-sales'); }

/* ---------- settings (account owner) ---------- */
async function posEnterSettings() {
  try {
    [POS.profile, POS.branches] = await Promise.all([api('/api/pos/profile'), api('/api/pos/branches')]);
    posRenderSettings();
    api('/api/pos/egress-ip').then(r => { const el = $('#pIp'); if (el) el.innerHTML = `<b class="font-mono">${esc(r.ip)}</b>${r.viaProxy ? ' (through the static-IP proxy)' : ' <span class="text-amber-700">(no static-IP proxy: this address can change)</span>'}`; }).catch(() => { const el = $('#pIp'); if (el) el.textContent = 'could not be checked'; });
  } catch (err) { toast(err.message); }
}
function posRenderSettings() {
  const p = POS.profile;
  $('#pSettings').innerHTML = `<div class="space-y-4">
    <div class="bg-white rounded-xl shadow p-5"><h2 class="font-semibold">Business details <span class="text-xs font-normal text-slate-500">printed on every receipt</span></h2>
      <div class="grid sm:grid-cols-3 gap-3 mt-3">
        <label class="sm:col-span-2"><span>Business name</span><input id="sfName" value="${esc(p.businessName)}" maxlength="150"></label>
        <label><span>PNTN / NTN</span><input id="sfPntn" value="${esc(p.pntn)}" maxlength="20" placeholder="1234567-8"></label>
        <label class="sm:col-span-2"><span>Address</span><input id="sfAddr" value="${esc(p.address)}" maxlength="250"></label>
        <label><span>Phone</span><input id="sfPhone" value="${esc(p.phone)}" maxlength="30"></label>
        <label class="sm:col-span-3"><span>Receipt footer <span class="text-slate-400">(optional)</span></span><input id="sfFoot" value="${esc(p.receiptFooter)}" maxlength="200" placeholder="Thank you for dining with us"></label></div>
      <div class="mt-3">${posBtn('Save business details', 'posSaveProfile()', 'primary')}</div></div>
    <div class="bg-white rounded-xl shadow p-5 space-y-4"><div class="flex flex-wrap items-center justify-between gap-2"><h2 class="font-semibold">Branches and counters</h2>${posBtn('+ Add branch', 'posBranchForm()')}</div>
      <div id="sfForm"></div>
      ${POS.branches.map(b => `<div class="border rounded-lg p-3 ${b.active ? '' : 'opacity-60'}">
        <div class="flex flex-wrap items-start justify-between gap-2"><div><div class="font-medium">${esc(b.name)}${b.active ? '' : ' (off)'}</div><div class="text-xs text-slate-500">${esc([b.address, b.city, b.phone].filter(Boolean).join(' · ') || 'no address yet')}</div></div>
          <div class="flex gap-2">${posBtn('Edit branch', `posBranchForm('${b.id}')`)}${posBtn('+ Add counter', `posCounterForm('', '${b.id}')`)}</div></div>
        <div class="mt-2">${b.counters.map(c => `<div class="border-t py-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 ${c.active ? '' : 'opacity-50'}">
          <div class="min-w-0"><div><b>${esc(c.name)}</b>${c.active ? '' : ' (off)'} ${c.env === 'PRODUCTION' ? '<span class="text-xs font-semibold text-emerald-800">Production</span>' : '<span class="text-xs text-slate-500">Sandbox</span>'}</div>
            <div class="text-xs text-slate-500">POS ID ${esc(c.posId)} · ${c.hasToken ? `token ${esc(c.tokenMasked)}` : '<span class="text-red-700">no token</span>'}</div>${c.pending ? `<div class="text-xs text-amber-700">${c.pending} waiting for PRA</div>` : ''}</div>
          <div class="flex flex-wrap gap-2 text-sm">
            <button type="button" class="px-3 min-h-[2.5rem] rounded-lg border text-emerald-700" onclick="posCounterForm('${c.id}', '${b.id}')">Edit</button>
            <button type="button" class="px-3 min-h-[2.5rem] rounded-lg border text-emerald-700" onclick="posTokenForm('${c.id}')">${c.hasToken ? 'Replace token' : 'Add token'}</button>
            ${c.active ? `<button type="button" class="px-3 min-h-[2.5rem] rounded-lg border border-red-300 text-red-700" onclick="posDecommission('${c.id}')">Decommission</button>` : ''}</div></div>`).join('') || '<div class="border-t py-2 text-slate-500 text-sm">No counter in this branch yet.</div>'}</div></div>`).join('') || '<p class="text-sm text-slate-500">No branch yet. Add the first one, then a counter with the POS ID PRA gave you.</p>'}</div>
    <div class="bg-white rounded-xl shadow p-5 text-sm space-y-2"><h2 class="font-semibold">Getting a POS ID and token from PRA</h2>
      <ol class="list-decimal ml-5 space-y-1 text-slate-700">
        <li>Log in at <a class="underline text-emerald-700" href="https://reg.pra.punjab.gov.pk/" target="_blank" rel="noopener">reg.pra.punjab.gov.pk</a> and open <b>Registration → POS Client Registration</b>. Add the branch and the counter (its name must be unique).</li>
        <li><b>Testing:</b> generate a <i>Test POS ID</i> there and add it here as a <b>Sandbox</b> counter, with the token PRA shows for it.</li>
        <li><b>Live:</b> use the real POS ID and its token (POS Details tab), as a <b>Production</b> counter. Then email <a class="underline text-emerald-700" href="mailto:eims@pra.punjab.gov.pk">eims@pra.punjab.gov.pk</a> your PNTN, business name, POS ID, <b>server IP</b> and server location, so PRA whitelists this server.</li></ol>
      <div>Server IP to give PRA: <span id="pIp" class="text-slate-500">checking…</span></div></div></div>`;
}
async function posSaveProfile() {
  try {
    POS.profile = await api('/api/pos/profile', { method: 'PUT', body: { businessName: $('#sfName').value, pntn: $('#sfPntn').value, address: $('#sfAddr').value, phone: $('#sfPhone').value, receiptFooter: $('#sfFoot').value } });
    toast('Business details saved', true); posRenderSettings();
  } catch (err) { toast(err.message); }
}
function posBranchForm(id) {
  const b = id ? POS.branches.find(x => x.id === id) : { name: '', address: '', city: '', phone: '', active: true };
  $('#sfForm').innerHTML = `<div class="border rounded-lg p-3 bg-slate-50 space-y-2"><div class="font-medium text-sm">${id ? 'Edit branch' : 'Add a branch'}</div>
    <div class="grid sm:grid-cols-4 gap-2"><label><span>Branch name</span><input id="sbName" value="${esc(b.name)}" maxlength="80"></label><label class="sm:col-span-2"><span>Address</span><input id="sbAddr" value="${esc(b.address)}" maxlength="250"></label>
      <label><span>City</span><input id="sbCity" value="${esc(b.city)}" maxlength="60"></label><label><span>Phone</span><input id="sbPhone" value="${esc(b.phone)}" maxlength="30"></label>
      ${id ? `<label class="flex items-end gap-2 text-sm pb-2"><input id="sbActive" type="checkbox" style="width:auto" ${b.active ? 'checked' : ''}> Branch is open</label>` : ''}</div>
    <div class="flex gap-2">${posBtn('Save', `posBranchSave('${id || ''}')`, 'primary')}${posBtn('Close', "$('#sfForm').innerHTML = ''")}</div></div>`;
}
async function posBranchSave(id) {
  const body = { name: $('#sbName').value, address: $('#sbAddr').value, city: $('#sbCity').value, phone: $('#sbPhone').value, ...(id ? { active: $('#sbActive').checked } : {}) };
  try { POS.branches = await api(id ? `/api/pos/branches/${id}` : '/api/pos/branches', { method: id ? 'PUT' : 'POST', body }); toast('Branch saved', true); posRenderSettings(); } catch (err) { toast(err.message); }
}
function posCounterForm(id, branchId) {
  const c = id ? POS.branches.flatMap(b => b.counters).find(x => x.id === id) : { name: '', posId: '', env: 'SANDBOX', active: true };
  $('#sfForm').innerHTML = `<div class="border rounded-lg p-3 bg-slate-50 space-y-2"><div class="font-medium text-sm">${id ? 'Edit counter' : 'Add a counter'}</div>
    <div class="grid sm:grid-cols-4 gap-2"><label><span>Counter name (unique)</span><input id="scName" value="${esc(c.name)}" maxlength="60" placeholder="Till 1"></label>
      <label><span>POS ID from PRA</span><input id="scPosId" value="${esc(c.posId)}" inputmode="numeric" maxlength="15"></label>
      <label><span>Environment</span><select id="scEnv"><option value="SANDBOX" ${c.env === 'SANDBOX' ? 'selected' : ''}>Sandbox (testing)</option><option value="PRODUCTION" ${c.env === 'PRODUCTION' ? 'selected' : ''}>Production (live)</option></select></label>
      ${id ? `<label class="flex items-end gap-2 text-sm pb-2"><input id="scActive" type="checkbox" style="width:auto" ${c.active ? 'checked' : ''}> Counter is in use</label>`
        : '<label><span>PRA token (can be added later)</span><input id="scToken" type="password" autocomplete="new-password" placeholder="paste the token PRA shows"></label>'}</div>
    <div class="flex gap-2">${posBtn('Save', `posCounterSave('${id || ''}', '${branchId}')`, 'primary')}${posBtn('Close', "$('#sfForm').innerHTML = ''")}</div></div>`;
}
async function posCounterSave(id, branchId) {
  const body = { name: $('#scName').value, posId: $('#scPosId').value, env: $('#scEnv').value, ...(id ? { active: $('#scActive').checked } : { branchId, token: $('#scToken').value || undefined }) };
  try { POS.branches = await api(id ? `/api/pos/counters/${id}` : '/api/pos/counters', { method: id ? 'PUT' : 'POST', body }); toast('Counter saved', true); posRenderSettings(); } catch (err) { toast(err.message); }
}
function posTokenForm(id) {
  $('#sfForm').innerHTML = `<div class="border rounded-lg p-3 bg-slate-50 space-y-2"><div class="font-medium text-sm">PRA token</div>
    <p class="text-xs text-slate-600">Paste the token PRA shows for this POS ID. It is stored encrypted and is never shown again. A sale being sent right now keeps the old token; the new one is used from the next send.</p>
    <label><span>Token</span><input id="stToken" type="password" autocomplete="new-password"></label>
    <div class="flex gap-2">${posBtn('Save token', `posTokenSave('${id}')`, 'primary')}${posBtn('Close', "$('#sfForm').innerHTML = ''")}</div></div>`;
  $('#sfForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
async function posTokenSave(id) {
  try { POS.branches = await api(`/api/pos/counters/${id}/token`, { method: 'POST', body: { token: $('#stToken').value } }); toast('Token saved', true); posRenderSettings(); } catch (err) { toast(err.message); }
}
async function posDecommission(id) {
  const c = POS.branches.flatMap(b => b.counters).find(x => x.id === id);
  if (!confirm(`Decommission counter "${c.name}"?\n\nIts token is removed and it is switched off. Its sales stay.${c.pending ? `\n\n${c.pending} sale(s) on it are still waiting for PRA.` : ''}`)) return;
  try { const r = await api(`/api/pos/counters/${id}/decommission`, { method: 'POST', body: {} }); POS.branches = r.branches; toast('Counter decommissioned', true); posRenderSettings(); } catch (err) { toast(err.message); }
}
