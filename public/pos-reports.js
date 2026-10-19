'use strict';
/* Point of Sale reports (managers): the daily closing sheet, sales analysed by day, hour, item, category, cashier, counter, branch,
   how it was paid, tax rate or customer, narrowed by filters, and a tax summary for the monthly return. Each can be printed and
   downloaded. The day-end sheet is also open to a cashier (their own sales only) from the sale screen.
   Loaded after pos.js, which gives it POS, posBtn, posShowModal, posPrint, posDownloadFile ... */

const posRep = {
  tab: 'closing', opts: null, last: null,
  day: '', counter: '', cashier: '',
  from: '', to: '', groupBy: 'day', f: { counter: '', cashier: '', paymentMode: '', invoiceType: '', category: '', taxRate: '', minAmount: '', maxAmount: '' },
};
POS_RESETS.push(() => { Object.assign(posRep, { tab: 'closing', opts: null, last: null, day: '', counter: '', cashier: '', from: '', to: '', groupBy: 'day', f: { counter: '', cashier: '', paymentMode: '', invoiceType: '', category: '', taxRate: '', minAmount: '', maxAmount: '' } }); });

POS_PAGES.push({ id: 'p-reports', enter: () => posEnterReports(), html: () => '<div id="pRep"></div>' });

/* ---------- dates ---------- */
const posDayAdd = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function posRange(name) {
  const today = pkDate(), d = new Date(`${today}T12:00:00Z`);
  const monthStart = day => day.slice(0, 8) + '01';
  if (name === 'today') return [today, today];
  if (name === 'yesterday') { const y = posDayAdd(today, -1); return [y, y]; }
  if (name === 'week') return [posDayAdd(today, -((d.getUTCDay() + 6) % 7)), today]; // Monday to today
  if (name === 'month') return [monthStart(today), today];
  if (name === 'lastmonth') { const first = monthStart(today), end = posDayAdd(first, -1); return [monthStart(end), end]; }
  if (name === '30') return [posDayAdd(today, -29), today];
  return [today, today];
}
const posLong = day => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/* ---------- the page ---------- */
async function posEnterReports() {
  posPollAlerts();
  if (!posRep.day) { posRep.day = pkDate(); [posRep.from, posRep.to] = posRange('month'); }
  try { if (!posRep.opts) posRep.opts = await api('/api/pos/reports/options'); } catch (err) { return toast(err.message); }
  posRepShell();
  posRepRun();
}
const posSel = (id, label, options, value, extra = '') => `<label><span>${label}</span><select id="${id}" onchange="posRepRead()" ${extra}>${options.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
function posRepCounterOptions() {
  const o = posRep.opts, out = [['', 'All counters']];
  for (const b of o.branches) { if (o.branches.length > 1) out.push([`b:${b.id}`, `Branch ${b.name} (all its counters)`]); for (const c of b.counters) out.push([`c:${c.id}`, `${b.name} · ${c.name}${c.active ? '' : ' (off)'}`]); }
  return out;
}
// The filter boxes and the tabs; the figures go in #pRepOut
function posRepShell() {
  const o = posRep.opts, closing = posRep.tab === 'closing', f = posRep.f;
  const presets = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['month', 'This month'], ['lastmonth', 'Last month'], ['30', 'Last 30 days']];
  $('#pRep').innerHTML = `<div class="space-y-4">
    ${o.testMode ? posBanner('warn', '<b>Test mode.</b> These figures are of test sales: nothing was sent to PRA and none of it is real.') : ''}
    <div class="seg flex-wrap" role="tablist">
      ${[['closing', 'Daily closing'], ['analysis', 'Sales analysis'], ['tax', 'Tax summary']].map(([id, t]) => `<button type="button" role="tab" aria-selected="${posRep.tab === id}" class="seg-btn ${posRep.tab === id ? 'on' : ''}" onclick="posRepTab('${id}')">${t}</button>`).join('')}</div>
    <div class="bg-white rounded-xl shadow p-4 space-y-3">
      ${closing ? `<div class="grid sm:grid-cols-4 gap-3 items-end">
          <label><span>Day</span><input id="rpDay" type="date" value="${esc(posRep.day)}" onchange="posRepRead()"></label>
          ${posSel('rpCounter', 'Counter', posRepCounterOptions().filter(([v]) => !v.startsWith('b:')), posRep.counter)}
          ${posSel('rpCashier', 'Cashier', [['', 'Everyone'], ...o.cashiers.map(c => [c.email, c.name])], posRep.cashier)}
          <div class="flex gap-2">${posBtn('Show', 'posRepRun()', 'primary')}<button type="button" onclick="posRepToday()" class="px-3 min-h-[2.5rem] rounded-lg border text-sm">Today</button></div></div>`
      : `<div class="flex flex-wrap items-end gap-3">
          <label><span>From</span><input id="rpFrom" type="date" value="${esc(posRep.from)}" onchange="posRepRead()"></label>
          <label><span>To</span><input id="rpTo" type="date" value="${esc(posRep.to)}" onchange="posRepRead()"></label>
          <div class="flex flex-wrap gap-1.5 pb-0.5">${presets.map(([id, t]) => `<button type="button" onclick="posRepPreset('${id}')" class="px-3 min-h-[2.5rem] rounded-lg border text-sm hover:border-emerald-600 bg-white">${t}</button>`).join('')}</div></div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          ${posRep.tab === 'analysis' ? posSel('rpGroup', 'Group by', o.groupings.map(g => [g.id, g.title]), posRep.groupBy) : ''}
          ${posSel('rpCounter', 'Counter or branch', posRepCounterOptions(), f.counter)}
          ${posSel('rpCashier', 'Cashier', [['', 'Everyone'], ...o.cashiers.map(c => [c.email, c.name])], f.cashier)}
          ${posSel('rpPay', 'Paid by', [['', 'Any way'], ...o.paymentModes.map(m => [m.id, m.label])], f.paymentMode)}
          ${posSel('rpType', 'Show', [['', 'Sales and returns (net)'], ['sale', 'Sales only'], ['return', 'Returns only']], f.invoiceType)}
          ${posSel('rpCategory', 'Category', [['', 'All categories'], ...o.categories.map(c => [c, c]), ['__none', 'No category']], f.category)}
          ${posSel('rpRate', 'Tax rate', [['', 'Any rate'], ...o.taxRates.map(r => [r, r + '%'])], f.taxRate)}
          <label><span>Bill from (Rs)</span><input id="rpMin" value="${esc(f.minAmount)}" inputmode="decimal" placeholder="any" onchange="posRepRead()"></label>
          <label><span>Bill up to (Rs)</span><input id="rpMax" value="${esc(f.maxAmount)}" inputmode="decimal" placeholder="any" onchange="posRepRead()"></label></div>
        <div class="flex flex-wrap gap-2">${posBtn('Show the report', 'posRepRun()', 'primary')}<button type="button" onclick="posRepClear()" class="px-3 min-h-[2.5rem] rounded-lg border text-sm">Clear the filters</button></div>`}
    </div>
    <div id="pRepOut"></div></div>`;
}
function posRepTab(id) { posRepRead(); posRep.tab = id; posRep.last = null; posRepShell(); posRepRun(); }
function posRepToday() { posRep.day = pkDate(); posRepShell(); posRepRun(); }
function posRepPreset(name) { posRepRead(); [posRep.from, posRep.to] = posRange(name); posRepShell(); posRepRun(); }
function posRepClear() { posRep.f = { counter: '', cashier: '', paymentMode: '', invoiceType: '', category: '', taxRate: '', minAmount: '', maxAmount: '' }; posRepShell(); posRepRun(); }
// what the boxes say now, kept (so a tab change or a preset does not lose it)
function posRepRead() {
  const v = id => { const e = document.getElementById(id); return e ? e.value : undefined; };
  if (posRep.tab === 'closing') {
    if (v('rpDay') !== undefined) posRep.day = v('rpDay'); if (v('rpCounter') !== undefined) posRep.counter = v('rpCounter'); if (v('rpCashier') !== undefined) posRep.cashier = v('rpCashier');
  } else {
    if (v('rpFrom') !== undefined) { posRep.from = v('rpFrom'); posRep.to = v('rpTo'); }
    if (v('rpGroup') !== undefined) posRep.groupBy = v('rpGroup');
    const f = posRep.f;
    if (v('rpCounter') !== undefined) { f.counter = v('rpCounter'); f.cashier = v('rpCashier'); f.paymentMode = v('rpPay'); f.invoiceType = v('rpType'); f.category = v('rpCategory'); f.taxRate = v('rpRate'); f.minAmount = v('rpMin').trim(); f.maxAmount = v('rpMax').trim(); }
  }
}
// the filters as the query string the server takes
function posRepQuery() {
  const f = posRep.f, q = new URLSearchParams();
  q.set('from', posRep.from); q.set('to', posRep.to);
  if (f.counter.startsWith('c:')) q.set('counterId', f.counter.slice(2)); else if (f.counter.startsWith('b:')) q.set('branchId', f.counter.slice(2));
  for (const [k, p] of [['cashier', 'cashier'], ['paymentMode', 'paymentMode'], ['invoiceType', 'invoiceType'], ['category', 'category'], ['taxRate', 'taxRate'], ['minAmount', 'minAmount'], ['maxAmount', 'maxAmount']]) if (f[k] !== '') q.set(p, f[k]);
  return q;
}

/* ---------- running a report ---------- */
async function posRepRun() {
  posRepRead();
  const out = $('#pRepOut'); if (!out) return;
  out.innerHTML = '<p class="text-sm text-slate-500 py-6 text-center">Working it out…</p>';
  try {
    if (posRep.tab === 'closing') {
      const q = new URLSearchParams({ date: posRep.day }); if (posRep.counter.startsWith('c:')) q.set('counterId', posRep.counter.slice(2)); if (posRep.cashier) q.set('cashier', posRep.cashier);
      posRep.last = { kind: 'closing', data: await api('/api/pos/reports/closing?' + q) };
      out.innerHTML = posClosingHtml(posRep.last.data, { screen: true });
    } else {
      const groupBy = posRep.tab === 'tax' ? 'taxRate' : posRep.groupBy;
      posRep.last = { kind: posRep.tab, groupBy, data: await api(`/api/pos/reports/by/${groupBy}?` + posRepQuery()) };
      out.innerHTML = posRep.tab === 'tax' ? posTaxHtml(posRep.last.data) : posAnalysisHtml(posRep.last.data);
    }
  } catch (err) { posRep.last = null; out.innerHTML = `<p class="text-sm text-red-700 py-4">${esc(err.message)}</p>`; }
}

const posN = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });
// "Invoices ›" on a row: the invoices that row added up (the data-drill attribute is the row's place in the report that is showing)
const posDrillLink = i => `<button type="button" data-drill="${i}" onclick="posRepDrill(${i})" class="text-emerald-700 underline text-sm min-h-[2rem] px-1 whitespace-nowrap">Invoices ›</button>`;
const posScopeNote = r => `${r.scope === 'TEST' ? '<div class="text-xs"><b class="text-amber-800">Test sales: not real figures.</b></div>' : ''}${r.leftOut ? `<div class="text-xs text-slate-500">${r.leftOut} ${r.scope === 'LIVE' ? 'test' : 'production'} ${r.leftOut === 1 ? 'sale is' : 'sales are'} not counted here.</div>` : ''}`;
const posTile = (title, big, sub, tone = '') => `<div class="border rounded-lg p-3 bg-white"><div class="text-xs text-slate-500">${title}</div><div class="text-lg font-semibold break-words ${tone}">${big}</div><div class="text-xs text-slate-500">${sub || ''}</div></div>`;

// Sales analysis: tiles for the whole, then a row for each group with its share as a bar
function posAnalysisHtml(r) {
  const t = r.totals, avg = t.sales ? t.bill / t.sales : 0;
  const head = `<div class="flex flex-wrap items-start justify-between gap-2"><div><h2 class="font-semibold">Sales by ${esc(r.title.toLowerCase())}</h2>
      <div class="text-xs text-slate-500">${esc(posLong(r.filters.from))} to ${esc(posLong(r.filters.to))}</div>${posScopeNote(r)}</div>
      <div class="flex flex-wrap gap-2">${posBtn('Download CSV', 'posRepCsv()')}${posBtn('Print', 'posRepPrint()')}</div></div>`;
  const tiles = `<div class="grid grid-cols-2 lg:grid-cols-5 gap-2">${posTile('Net total', money(t.netBill), `value ${money(t.netValue)}`)}${posTile('Net sales tax', money(t.netTax), '')}
      ${posTile('Invoices', t.sales, t.returns ? `${t.returns} credit ${t.returns === 1 ? 'note' : 'notes'}` : 'no returns')}${posTile('Average bill', money(avg), 'sales only')}${posTile('Discount given', money(t.discount), '')}</div>`;
  const drill = PosDrill.can(r.groupBy);
  const rows = r.rows.map((x, i) => `<tr class="border-t"><td class="py-2 pr-2 font-medium">${esc(x.label)}</td><td class="text-right px-2">${x.sales}</td><td class="text-right px-2">${posN(x.netQuantity)}</td>
      <td class="text-right px-2">${money(x.saleValue)}</td><td class="text-right px-2">${x.discount ? money(x.discount) : ''}</td><td class="text-right px-2">${money(x.tax)}</td><td class="text-right px-2">${money(x.bill)}</td>
      <td class="text-right px-2 text-slate-500">${x.returnBill ? '−' + money(x.returnBill) : ''}</td><td class="text-right px-2 font-semibold">${money(x.netBill)}</td>
      <td class="pl-2 w-28"><div class="flex items-center gap-1.5"><div class="h-2 rounded bg-slate-100 flex-1 overflow-hidden"><div class="h-full bg-emerald-500" style="width:${Math.min(100, Math.max(0, x.share))}%"></div></div><span class="text-xs text-slate-500 w-10 text-right">${x.share}%</span></div></td>${drill ? `<td class="pl-2 text-right whitespace-nowrap">${posDrillLink(i)}</td>` : ''}</tr>`).join('');
  const foot = `<tr class="border-t-2 font-semibold"><td class="py-2">Total</td><td class="text-right px-2">${t.sales}</td><td class="text-right px-2">${posN(t.netQuantity)}</td><td class="text-right px-2">${money(t.saleValue)}</td><td class="text-right px-2">${t.discount ? money(t.discount) : ''}</td><td class="text-right px-2">${money(t.tax)}</td><td class="text-right px-2">${money(t.bill)}</td><td class="text-right px-2">${t.returnBill ? '−' + money(t.returnBill) : ''}</td><td class="text-right px-2">${money(t.netBill)}</td><td></td>${drill ? '<td></td>' : ''}</tr>`;
  const cards = r.rows.map((x, i) => `<div class="border rounded-lg p-3"><div class="flex items-start justify-between gap-3"><div class="font-medium break-words min-w-0">${esc(x.label)}</div><div class="font-semibold whitespace-nowrap">${money(x.netBill)}</div></div>
      <div class="h-1.5 rounded bg-slate-100 mt-1.5 overflow-hidden"><div class="h-full bg-emerald-500" style="width:${Math.min(100, Math.max(0, x.share))}%"></div></div>
      <div class="text-xs text-slate-500 mt-1">${x.sales} ${x.sales === 1 ? 'invoice' : 'invoices'} · qty ${posN(x.netQuantity)} · tax ${money(x.netTax)}${x.returns ? ` · returned ${money(x.returnBill)}` : ''} · ${x.share}%</div>${drill ? `<div class="mt-1.5">${posDrillLink(i)}</div>` : ''}</div>`).join('');
  return `<div class="bg-white rounded-xl shadow p-4 space-y-3">${head}${tiles}
    ${r.rows.length ? `<div class="hidden md:block overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-slate-500"><tr><th class="py-1">${esc(r.title)}</th><th class="text-right px-2">Invoices</th><th class="text-right px-2">Qty</th><th class="text-right px-2">Value</th><th class="text-right px-2">Discount</th><th class="text-right px-2">Sales tax</th><th class="text-right px-2">Total</th><th class="text-right px-2">Returned</th><th class="text-right px-2">Net total</th><th class="pl-2">Share</th>${drill ? '<th></th>' : ''}</tr></thead><tbody>${rows}${foot}</tbody></table></div>
      <div class="md:hidden space-y-2">${cards}</div>` : '<p class="text-sm text-slate-500 py-6 text-center">No fiscalized sales match these filters.</p>'}</div>`;
}
// Tax summary: what the monthly return needs: the value and the tax at each rate, net of returns
function posTaxHtml(r) {
  const t = r.totals;
  const rows = r.rows.map((x, i) => `<tr class="border-t"><td class="py-2 font-medium">${esc(x.label)}</td><td class="text-right px-2">${money(x.saleValue)}</td><td class="text-right px-2">${money(x.tax)}</td><td class="text-right px-2 text-slate-500">${x.returnValue ? '−' + money(x.returnValue) : ''}</td><td class="text-right px-2 text-slate-500">${x.returnTax ? '−' + money(x.returnTax) : ''}</td><td class="text-right px-2 font-semibold">${money(x.netValue)}</td><td class="text-right px-2 font-semibold">${money(x.netTax)}</td><td class="pl-2 text-right whitespace-nowrap">${posDrillLink(i)}</td></tr>`).join('');
  return `<div class="bg-white rounded-xl shadow p-4 space-y-3">
    <div class="flex flex-wrap items-start justify-between gap-2"><div><h2 class="font-semibold">Sales tax by rate</h2><div class="text-xs text-slate-500">${esc(posLong(r.filters.from))} to ${esc(posLong(r.filters.to))}</div>${posScopeNote(r)}</div>
      <div class="flex flex-wrap gap-2">${posBtn('Download CSV', 'posRepCsv()')}${posBtn('Print', 'posRepPrint()')}</div></div>
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-2">${posTile('Tax to pay (net)', money(t.netTax), 'after returns', 'text-emerald-800')}${posTile('Taxable value (net)', money(t.netValue), '')}${posTile('Tax charged', money(t.tax), `${t.sales} ${t.sales === 1 ? 'invoice' : 'invoices'}`)}${posTile('Tax returned', money(t.returnTax), `${t.returns} credit ${t.returns === 1 ? 'note' : 'notes'}`)}</div>
    ${r.rows.length ? `<div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-slate-500"><tr><th class="py-1">Rate</th><th class="text-right px-2">Value sold</th><th class="text-right px-2">Tax charged</th><th class="text-right px-2">Value returned</th><th class="text-right px-2">Tax returned</th><th class="text-right px-2">Net value</th><th class="text-right px-2">Net tax</th><th></th></tr></thead>
      <tbody>${rows}<tr class="border-t-2 font-semibold"><td class="py-2">Total</td><td class="text-right px-2">${money(t.saleValue)}</td><td class="text-right px-2">${money(t.tax)}</td><td class="text-right px-2">${t.returnValue ? '−' + money(t.returnValue) : ''}</td><td class="text-right px-2">${t.returnTax ? '−' + money(t.returnTax) : ''}</td><td class="text-right px-2">${money(t.netValue)}</td><td class="text-right px-2">${money(t.netTax)}</td><td></td></tr></tbody></table></div>
      <p class="text-xs text-slate-500">A card payment is taxed at the card rate, so the same item can show under two rates. Only fiscalized sales and credit notes are counted. Ask your accountant how these figures go on the return.</p>` : '<p class="text-sm text-slate-500 py-6 text-center">No fiscalized sales in these dates.</p>'}</div>`;
}

// A row's invoices: Sales & Receipts with the filters the report was made with, the row's own group, "fiscalized", and the kind of sale
// (test or real) the figures cover, so the list holds exactly what the row counted. Each of those can be taken away there.
function posRepDrill(i) {
  const l = posRep.last; if (!l || l.kind === 'closing' || !l.data || !l.data.rows[i]) return;
  const row = l.data.rows[i], f = l.data.filters, mine = PosDrill.forRow(l.groupBy, row, { from: f.from, to: f.to });
  if (!mine) return;
  const all = { ...f, ...mine }, str = v => (v === undefined || v === null ? '' : String(v));
  const branch = all.branchId ? ((posRep.opts && posRep.opts.branches.find(b => b.id === all.branchId)) || {}).name || (l.groupBy === 'branch' ? row.label : '') : '';
  POS.sales = posBlankSales({
    from: str(all.from), to: str(all.to), state: 'FISCALIZED', env: l.data.scope === 'TEST' ? 'SANDBOX' : 'PRODUCTION',
    counterId: str(all.counterId), cashier: str(all.cashier), paymentMode: str(all.paymentMode), invoiceType: str(all.invoiceType), minAmount: str(all.minAmount), maxAmount: str(all.maxAmount),
    customerId: str(all.customerId), customerName: l.groupBy === 'customer' ? row.label : '', itemCode: str(all.itemCode), itemName: l.groupBy === 'item' ? row.label : '',
    category: str(all.category), taxRate: str(all.taxRate), branchId: str(all.branchId), branchName: branch,
  });
  if (S.page === 'p-sales') posEnterSales(); else go('p-sales');
}

/* ---------- the closing sheet ---------- */
// One sheet for the screen (a card), the A4 print and the 80 mm slip
function posClosingHtml(c, { screen, paper } = {}) {
  if (screen) posClosingOpen.data = c; // what the Print buttons print: the sheet that is showing
  const slip = paper === 'slip', t = c.totals;
  const test = c.scope === 'TEST' ? 'TEST SALES: NOT REAL FIGURES' : '';
  const row = (l, r, bold) => `<div style="display:flex;justify-content:space-between;gap:8px;${bold ? 'font-weight:bold;' : ''}"><span>${l}</span><span style="text-align:right">${r}</span></div>`;
  const rule = '<div style="border-top:1px dashed #000;margin:6px 0"></div>';
  const who = [c.counter ? `${esc(c.counter.branch)} · ${esc(c.counter.name)} (POS ${esc(c.counter.posId)})` : 'All counters', c.cashier ? `Cashier ${esc(c.cashier.split('@')[0])}` : 'All cashiers'].join(' · ');
  const nf = c.notFiscalized, open = nf.waiting + nf.refused + nf.unknown;
  const pay = c.byPayment.map(p => row(esc(p.label), money(p.netBill) + (p.returnBill ? ` <span style="font-weight:normal">(− ${money(p.returnBill)} returned)</span>` : ''))).join('');
  const rates = c.byTaxRate.map(p => row(`${esc(p.label)} on ${money(p.netValue)}`, money(p.netTax))).join('');
  const people = c.byCashier.length > 1 ? c.byCashier.map(p => row(esc(p.label), `${money(p.netBill)} <span style="font-weight:normal">(${p.sales} ${p.sales === 1 ? 'sale' : 'sales'})</span>`)).join('') : '';
  const sheet = `<div style="${slip ? 'width:100%;max-width:80mm;font-family:ui-monospace,Menlo,monospace;font-size:11px;' : 'font-size:13px;'}color:#000;background:#fff">
    ${test ? `<div style="border:2px solid #000;padding:2px;font-weight:bold;text-align:center;margin-bottom:6px">${test}</div>` : ''}
    <div style="text-align:center"><div style="font-weight:bold;font-size:${slip ? 13 : 16}px">${esc(c.business.name || 'Daily closing')}</div>${c.business.pntn ? `<div>PNTN / NTN: ${esc(c.business.pntn)}</div>` : ''}
      <div style="font-weight:bold;margin-top:4px">DAILY CLOSING</div><div>${esc(posLong(c.date))}</div><div>${who}</div></div>${rule}
    ${row('Sales', `${t.sales} ${t.sales === 1 ? 'invoice' : 'invoices'}`)}${row('Value before tax', money(t.saleValue))}${t.discount ? row('Discount given', money(t.discount)) : ''}${row('Sales tax', money(t.tax))}${row('Total sold', money(t.bill), true)}
    ${t.returns ? `${rule}${row('Returned', `${t.returns} credit ${t.returns === 1 ? 'note' : 'notes'}`)}${row('Value returned', '− ' + money(t.returnValue))}${row('Tax returned', '− ' + money(t.returnTax))}${row('Total returned', '− ' + money(t.returnBill), true)}` : ''}${rule}
    ${row('NET TOTAL', money(t.netBill), true)}${row('Net sales tax', money(t.netTax))}${rule}
    <div style="font-weight:bold">Paid by</div>${pay || '<div>—</div>'}${rule}
    <div style="font-weight:bold">Sales tax by rate</div>${rates || '<div>—</div>'}
    ${people ? `${rule}<div style="font-weight:bold">By cashier</div>${people}` : ''}${rule}
    ${c.firstSale ? row('First sale', `${esc(c.firstSale.usin)} · ${esc(posWhenShort(c.firstSale.at))}`) : ''}${c.lastSale ? row('Last sale', `${esc(c.lastSale.usin)} · ${esc(posWhenShort(c.lastSale.at))}`) : ''}${!c.firstSale ? '<div>No sales on this day.</div>' : ''}${rule}
    <div style="border:2px solid #000;padding:4px 6px;margin:4px 0">${row('CASH THAT SHOULD BE IN THE DRAWER', money(c.cashExpected), true)}<div style="font-size:${slip ? 9 : 11}px">Cash sales less cash given back for returns.${screen ? '' : ' Count the drawer and write it here: ______________'}</div></div>
    ${c.returned.length ? `${rule}<div style="font-weight:bold">Returns made</div>${c.returned.map(r => row(`${esc(r.usin)} for sale ${esc(r.refUsin || '')}`, money(r.bill))).join('')}` : ''}
    ${open ? `${rule}<div style="font-weight:bold;color:#b45309">Not fiscalized yet: ${[nf.waiting && nf.waiting + ' waiting for PRA', nf.refused && nf.refused + ' refused', nf.unknown && nf.unknown + ' of unknown outcome'].filter(Boolean).join(', ')}</div>` : ''}
    ${nf.cancelled ? `<div style="font-size:${slip ? 9 : 11}px">${nf.cancelled} cancelled before fiscalization.</div>` : ''}
    ${c.leftOut ? `<div style="font-size:${slip ? 9 : 11}px">${c.leftOut} ${c.scope === 'LIVE' ? 'test' : 'production'} ${c.leftOut === 1 ? 'sale is' : 'sales are'} not counted.</div>` : ''}
    ${screen ? '' : `<div style="margin-top:16px;display:flex;gap:16px"><div style="flex:1;border-top:1px solid #000;padding-top:2px">Cashier</div><div style="flex:1;border-top:1px solid #000;padding-top:2px">Manager</div></div><div style="margin-top:6px;font-size:9px;text-align:center">Printed ${esc(posWhen(new Date()))}</div>`}</div>`;
  if (!screen) return sheet;
  return `<div class="bg-white rounded-xl shadow p-4 space-y-3"><div class="flex flex-wrap items-center justify-between gap-2"><h2 class="font-semibold">Daily closing</h2>
      <div class="flex flex-wrap gap-2">${posBtn('Print A4', "posClosingPrint('a4')")}${posBtn('Print 80 mm slip', "posClosingPrint('slip')")}</div></div>
    ${open ? posBanner('warn', `<b>${open} ${open === 1 ? 'sale is' : 'sales are'} not fiscalized yet</b> (${nf.waiting} waiting, ${nf.refused} refused, ${nf.unknown} unknown). Sort ${open === 1 ? 'it' : 'them'} out before closing the day. <a href="#" class="underline" onclick="event.preventDefault(); posShowState('${nf.unknown ? 'OUTCOME_UNKNOWN' : nf.refused ? 'REJECTED' : 'AWAITING_FISCALIZATION'}')">Open ${open === 1 ? 'it' : 'them'}</a>.`) : ''}
    <div class="overflow-x-auto"><div style="max-width:34rem;margin:0 auto">${sheet}</div></div></div>`;
}
function posClosingPrint(paper) {
  const c = posClosingOpen.data; if (!c) return;
  // (a roll's page size is the printer's own: Chrome ignores "size: 80mm auto", and the slip is as wide as the roll but never wider than the page)
  posPrint(posClosingHtml(c, { paper }), paper === 'slip' ? '@page { margin: 3mm; }' : '@page { size: A4; margin: 15mm; }');
}
const posClosingOpen = { data: null };

// The day-end sheet for today, from the sale screen: a cashier gets their own sales, a manager the whole till
async function posClosingModal() {
  try {
    const c = await api('/api/pos/reports/closing?' + new URLSearchParams({ date: pkDate(), ...(posCounter() ? { counterId: posCounter().id } : {}) }));
    posShowModal(`<div class="space-y-3"><div class="flex items-start justify-between gap-3"><h2 class="text-lg font-semibold">Day-end sheet</h2>
        <button type="button" onclick="posCloseModal()" class="text-2xl leading-none text-slate-400 px-2" aria-label="Close">×</button></div>
      ${canManage() ? '' : '<p class="text-xs text-slate-500">This is your own sales on this counter today.</p>'}
      <div class="overflow-x-auto"><div style="max-width:34rem;margin:0 auto">${posClosingHtml(c, { screen: true }).replace(/^<div class="bg-white rounded-xl shadow p-4 space-y-3">/, '<div class="space-y-3">')}</div></div></div>`);
  } catch (err) { toast(err.message); }
}

/* ---------- the spreadsheet and the print ---------- */
function posRepCsv() {
  const l = posRep.last; if (!l || l.kind === 'closing') return;
  return posDownloadFile(`/api/pos/export/report/${l.groupBy}?` + posRepQuery(), 'pos-report.csv');
}
function posRepPrint() {
  const l = posRep.last; if (!l || l.kind === 'closing') return;
  const r = l.data, t = r.totals;
  const th = 'text-align:right;padding:3px 6px;border-bottom:1px solid #000';
  const td = 'text-align:right;padding:3px 6px;border-bottom:1px solid #ddd';
  const body = l.kind === 'tax'
    ? `<tr><th style="text-align:left;${th.replace('text-align:right;', '')}">Rate</th>${['Value sold', 'Tax charged', 'Value returned', 'Tax returned', 'Net value', 'Net tax'].map(h => `<th style="${th}">${h}</th>`).join('')}</tr>
       ${r.rows.map(x => `<tr><td style="padding:3px 6px;border-bottom:1px solid #ddd">${esc(x.label)}</td>${[x.saleValue, x.tax, x.returnValue, x.returnTax, x.netValue, x.netTax].map(v => `<td style="${td}">${money(v)}</td>`).join('')}</tr>`).join('')}
       <tr style="font-weight:bold"><td style="padding:3px 6px">Total</td>${[t.saleValue, t.tax, t.returnValue, t.returnTax, t.netValue, t.netTax].map(v => `<td style="${td}">${money(v)}</td>`).join('')}</tr>`
    : `<tr><th style="text-align:left;${th.replace('text-align:right;', '')}">${esc(r.title)}</th>${['Invoices', 'Qty', 'Value', 'Discount', 'Sales tax', 'Total', 'Returned', 'Net total', 'Share'].map(h => `<th style="${th}">${h}</th>`).join('')}</tr>
       ${r.rows.map(x => `<tr><td style="padding:3px 6px;border-bottom:1px solid #ddd">${esc(x.label)}</td><td style="${td}">${x.sales}</td><td style="${td}">${posN(x.netQuantity)}</td><td style="${td}">${money(x.saleValue)}</td><td style="${td}">${x.discount ? money(x.discount) : ''}</td><td style="${td}">${money(x.tax)}</td><td style="${td}">${money(x.bill)}</td><td style="${td}">${x.returnBill ? money(x.returnBill) : ''}</td><td style="${td}">${money(x.netBill)}</td><td style="${td}">${x.share}%</td></tr>`).join('')}
       <tr style="font-weight:bold"><td style="padding:3px 6px">Total</td><td style="${td}">${t.sales}</td><td style="${td}">${posN(t.netQuantity)}</td><td style="${td}">${money(t.saleValue)}</td><td style="${td}">${t.discount ? money(t.discount) : ''}</td><td style="${td}">${money(t.tax)}</td><td style="${td}">${money(t.bill)}</td><td style="${td}">${t.returnBill ? money(t.returnBill) : ''}</td><td style="${td}">${money(t.netBill)}</td><td style="${td}"></td></tr>`;
  const name = (S.company || '').trim();
  posPrint(`<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#000">
      <div style="font-size:15px;font-weight:bold">${esc(name || 'Point of Sale')}: ${l.kind === 'tax' ? 'Sales tax by rate' : 'Sales by ' + esc(r.title.toLowerCase())}</div>
      <div>${esc(posLong(r.filters.from))} to ${esc(posLong(r.filters.to))}${r.scope === 'TEST' ? ' · <b>TEST SALES: NOT REAL FIGURES</b>' : ''}</div>
      <div style="color:#555;margin-bottom:6px">${esc(posRepFilterWords())}</div>
      <table style="width:100%;border-collapse:collapse">${body}</table>
      <div style="margin-top:8px;color:#555;font-size:9px">Printed ${esc(posWhen(new Date()))}. Fiscalized sales and credit notes only.</div></div>`, '@page { size: A4 landscape; margin: 12mm; }');
}
// The filters in words, for the top of a printout
function posRepFilterWords() {
  const f = posRep.f, o = posRep.opts, bits = [];
  if (f.counter) {
    const id = f.counter.slice(2);
    if (f.counter.startsWith('b:')) { const b = o.branches.find(x => x.id === id); if (b) bits.push(`branch ${b.name}`); }
    else for (const b of o.branches) { const c = b.counters.find(x => x.id === id); if (c) bits.push(`${b.name} · ${c.name}`); }
  }
  if (f.cashier) bits.push(`cashier ${(o.cashiers.find(c => c.email === f.cashier) || { name: f.cashier }).name}`);
  if (f.paymentMode) bits.push(`paid by ${(o.paymentModes.find(m => String(m.id) === String(f.paymentMode)) || { label: 'payment type ' + f.paymentMode }).label}`);
  if (f.invoiceType) bits.push(f.invoiceType === 'sale' ? 'sales only' : 'returns only');
  if (f.category) bits.push(f.category === '__none' ? 'no category' : `category ${f.category}`);
  if (f.taxRate !== '') bits.push(`tax rate ${f.taxRate}%`);
  if (f.minAmount) bits.push(`bills from Rs ${f.minAmount}`);
  if (f.maxAmount) bits.push(`bills up to Rs ${f.maxAmount}`);
  return bits.length ? 'Filters: ' + bits.join(', ') : 'No filters';
}
