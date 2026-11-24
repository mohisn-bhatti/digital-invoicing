'use strict';
/* Compliance & Deadlines: the Reports page (SRS 13; the CA's "Deadline Tracker - Reports" sheet, 24 Nov 2026). The reports come in
   categories (src/compliance/reportsCatalog.js says which ones this user may see): pick a category, then a report; each has its own
   filters (dates: this calendar year by default; country; client…), its table with the totals per currency, a download for Excel and
   Print / PDF. The category and report chosen last are remembered on this computer. A row about a client, an obligation period or an
   invoice opens it. */

const CMP_RPT = { cats: null, cat: '', key: '', country: '', clientId: '', days: 30, user: '', opts: {}, clients: null, data: null, seq: 0, userTimer: null, exportUrl: '' };
CMP_RESETS.push(() => Object.assign(CMP_RPT, { cats: null, cat: '', key: '', country: '', clientId: '', days: 30, user: '', opts: {}, clients: null, data: null, exportUrl: '' }));
// an old link to one of the seven reports of the earlier page (e.g. the dashboard's "Invoice aging") opens its place in the catalogue
const CMP_RPT_OLD = { overdue: 'obligations-overdue', upcoming: 'obligations-upcoming', invoices: 'invoice-register', receipts: 'receipt-register', clients: 'obligation-performance', aging: 'receivables-aging' };
// remembered on this computer (a private window may refuse: then for this visit only)
function cmpRptMem(k, v) {
  try { if (v === undefined) return localStorage.getItem(k) || ''; localStorage.setItem(k, v); } catch { /* for this visit only */ }
  return '';
}
const cmpRptLast = () => { try { return JSON.parse(cmpRptMem('cmpRepLast') || '{}') || {}; } catch { return {}; } };

CMP_PAGES.push({
  id: 'cm-reports',
  html: () => `<div class="space-y-4">
    <section class="bg-white rounded-xl shadow p-4">
      <div id="cmRptCats" role="tablist" aria-label="Report categories" class="flex flex-wrap gap-1.5"></div>
      <div id="cmRptList" class="flex flex-wrap gap-1.5 mt-3 pt-3 border-t"></div>
    </section>
    <section class="bg-white rounded-xl shadow p-4 min-w-0">
      <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div id="cmRptFilters" class="flex flex-wrap items-end gap-3"></div>
        <div class="flex gap-2"><span id="cmRptExport"></span>${cmpBtn('Print / PDF', 'cmpRptPrint()')}</div></div>
      <h2 id="cmRptTitle" class="font-semibold"></h2>
      <p id="cmRptInfo" class="text-xs text-slate-500 mt-0.5 mb-3"></p>
      <div id="cmRptBody"></div>
    </section></div>`,
  enter: cmpRptEnter,
});

async function cmpRptEnter() {
  try { CMP_RPT.cats = (await api('/api/cmp/catalog')).categories; } catch (err) { $('#cmRptBody').innerHTML = cmpEmpty(esc(err.message)); return; }
  const all = CMP_RPT.cats.flatMap(c => c.reports.map(r => ({ ...r, cat: c.id })));
  const old = typeof CMP_REP !== 'undefined' && CMP_REP.report !== 'obligations' ? CMP_RPT_OLD[CMP_REP.report] : '';
  if (typeof CMP_REP !== 'undefined') CMP_REP.report = 'obligations';
  const found = all.find(r => r.key === (old || CMP_RPT.key || cmpRptMem('cmpRepKey'))) || all.find(r => r.cat === (CMP_RPT.cat || cmpRptMem('cmpRepCat'))) || all[0];
  if (!found) {
    ['#cmRptCats', '#cmRptList', '#cmRptFilters', '#cmRptExport', '#cmRptTitle', '#cmRptInfo'].forEach(s => { $(s).innerHTML = ''; });
    $('#cmRptBody').innerHTML = cmpEmpty('There are no reports for your permissions. Ask the ETAX administrator.');
    return;
  }
  CMP_RPT.cat = found.cat; CMP_RPT.key = found.key;
  cmpRptDraw();
}
const cmpRptCategory = () => (CMP_RPT.cats || []).find(c => c.id === CMP_RPT.cat);
const cmpRptReport = () => { const c = cmpRptCategory(); return c ? c.reports.find(r => r.key === CMP_RPT.key) : null; };
function cmpRptSave() {
  cmpRptMem('cmpRepCat', CMP_RPT.cat); cmpRptMem('cmpRepKey', CMP_RPT.key);
  const m = cmpRptLast(); m[CMP_RPT.cat] = CMP_RPT.key; cmpRptMem('cmpRepLast', JSON.stringify(m));
}
// a category opens at the report last used in it
function cmpRptCat(id) {
  const cat = (CMP_RPT.cats || []).find(c => c.id === id); if (!cat) return;
  const last = cmpRptLast()[id];
  CMP_RPT.cat = id; CMP_RPT.key = (cat.reports.find(r => r.key === last) || cat.reports[0]).key;
  cmpRptSave(); cmpRptDraw();
}
function cmpRptPick(key) { CMP_RPT.key = key; cmpRptSave(); cmpRptDraw(); }
function cmpRptOpt(k, v) { const r = cmpRptReport(); if (!r) return; (CMP_RPT.opts[r.key] || (CMP_RPT.opts[r.key] = {}))[k] = v; cmpRptLoad(); }

function cmpRptDraw() {
  const cat = cmpRptCategory(); if (!cat) return;
  $('#cmRptCats').innerHTML = CMP_RPT.cats.map(c => `<button type="button" role="tab" aria-selected="${c.id === cat.id}" onclick="cmpRptCat('${c.id}')"
    class="px-3 py-1.5 rounded-lg text-sm font-medium border ${c.id === cat.id ? 'bg-emerald-700 border-emerald-700 text-white' : 'bg-white text-slate-700 hover:border-emerald-600'}">${esc(c.title)} <span class="text-xs opacity-70">${c.reports.length}</span></button>`).join('');
  $('#cmRptList').innerHTML = cat.reports.map(r => `<button type="button" title="${esc(r.info)}" onclick="cmpRptPick('${r.key}')"
    class="px-3 py-1.5 rounded-lg text-sm border ${r.key === CMP_RPT.key ? 'bg-emerald-50 border-emerald-600 text-emerald-900 font-medium' : 'bg-slate-50 border-transparent text-slate-700 hover:border-slate-300'}">${esc(r.title)}</button>`).join('');
  cmpRptFilters();
  cmpRptLoad();
}

/* ---------- the filters of the report chosen ---------- */
function cmpRptFilters() {
  const r = cmpRptReport(), f = r.filters || {}, o = CMP_RPT.opts[r.key] || {}, parts = [];
  if (f.range) parts.push(cmpRangeBar('rep', cmpRptLoad));
  if (f.days) parts.push(`<label><span>Window</span><select onchange="CMP_RPT.days = Number(this.value); cmpRptLoad()">${[7, 30, 60, 90].map(n => `<option value="${n}" ${n === CMP_RPT.days ? 'selected' : ''}>Next ${n} days</option>`).join('')}</select></label>`);
  for (const [k, label, blank] of [['status', 'Status', ''], ['group', 'Show', ''], ['module', 'Module', 'Every module']]) {
    if (!f[k]) continue;
    const cur = o[k] !== undefined ? o[k] : blank ? '' : f[k][0][0];
    parts.push(`<label><span>${label}</span><select onchange="cmpRptOpt('${k}', this.value)">${blank ? `<option value="">${blank}</option>` : ''}${f[k].map(([v, t]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`);
  }
  if (f.country) parts.push(`<label><span>Country</span><select onchange="CMP_RPT.country = this.value; cmpRptLoad()">${cmpCountryOptions(CMP_RPT.country, 'All countries')}</select></label>`);
  if (f.client) parts.push(`<label><span>Client</span><select id="cmRptClient" class="max-w-[16rem]" onchange="CMP_RPT.clientId = this.value; cmpRptLoad()"><option value="">All clients</option></select></label>`);
  if (f.user) parts.push(`<label><span>User</span><input type="search" class="!w-48" placeholder="Email contains…" value="${esc(CMP_RPT.user)}"
    oninput="clearTimeout(CMP_RPT.userTimer); const v = this.value.trim(); CMP_RPT.userTimer = setTimeout(() => { CMP_RPT.user = v; cmpRptLoad(); }, 400)"></label>`);
  $('#cmRptFilters').innerHTML = parts.join('');
  if (f.client) cmpRptClients();
}
// the clients for the client filter (read once per visit)
async function cmpRptClients() {
  if (!CMP_RPT.clients) { try { CMP_RPT.clients = (await api('/api/cmp/clients')).clients; } catch { CMP_RPT.clients = []; } }
  const sel = document.getElementById('cmRptClient'); if (!sel) return;
  sel.innerHTML = '<option value="">All clients</option>' + CMP_RPT.clients.map(c => `<option value="${c.id}" ${c.id === CMP_RPT.clientId ? 'selected' : ''}>${esc(c.name)} (${esc(c.code)})</option>`).join('');
}
function cmpRptQuery(r) {
  const f = r.filters || {}, o = CMP_RPT.opts[r.key] || {};
  return { ...(f.range ? cmpRangeDates('rep') : {}), ...(f.days ? { days: CMP_RPT.days } : {}), ...(f.country ? { country: CMP_RPT.country } : {}), ...(f.client ? { clientId: CMP_RPT.clientId } : {}),
    ...(f.status ? { status: o.status } : {}), ...(f.group ? { group: o.group } : {}), ...(f.module ? { module: o.module } : {}), ...(f.user ? { user: CMP_RPT.user } : {}) };
}
// the filters in words (the heading of a printout)
function cmpRptFilterText(r) {
  const f = r.filters || {}, o = CMP_RPT.opts[r.key] || {}, bits = [];
  if (f.range) bits.push(`${f.range[0].toUpperCase()}${f.range.slice(1)}: ${cmpRangeText('rep')}`);
  if (f.days) bits.push(`Next ${CMP_RPT.days} days`);
  for (const k of ['status', 'group', 'module']) if (f[k] && o[k]) { const x = f[k].find(([v]) => v === o[k]); if (x) bits.push(x[1]); }
  if (f.country && CMP_RPT.country) bits.push(cmpCountry(CMP_RPT.country).name);
  if (f.client && CMP_RPT.clientId) { const c = (CMP_RPT.clients || []).find(x => x.id === CMP_RPT.clientId); if (c) bits.push(`${c.name} (${c.code})`); }
  if (f.user && CMP_RPT.user) bits.push(`User: ${CMP_RPT.user}`);
  return bits.join(' · ');
}

/* ---------- the report ---------- */
async function cmpRptLoad() {
  const r = cmpRptReport(); if (!r) return;
  const qs = cmpQs(cmpRptQuery(r)).toString();
  CMP_RPT.exportUrl = `/api/cmp/catalog/${r.key}/export${qs ? '?' + qs : ''}`;
  $('#cmRptExport').innerHTML = cmpCan('EXPORT') ? cmpBtn('Download (Excel)', 'cmpRptDownload()') : '';
  $('#cmRptTitle').textContent = r.title;
  $('#cmRptInfo').textContent = r.info;
  $('#cmRptBody').innerHTML = '<div class="text-sm text-slate-400 py-6 text-center">Loading…</div>';
  const seq = ++CMP_RPT.seq;
  let d;
  try { d = await api(`/api/cmp/catalog/${r.key}${qs ? '?' + qs : ''}`); } catch (err) { if (seq === CMP_RPT.seq) $('#cmRptBody').innerHTML = cmpEmpty(esc(err.message)); return; }
  if (seq !== CMP_RPT.seq) return; // (a newer choice is on its way)
  CMP_RPT.data = d;
  const when = r.filters.range ? ` — ${cmpRangeText('rep')}` : r.filters.days ? ` — next ${CMP_RPT.days} days` : '';
  $('#cmRptTitle').textContent = `${d.title}${when} (${d.rows.length})`;
  $('#cmRptInfo').innerHTML = `${esc(d.info)}${d.note ? `<br><span class="text-slate-600">${esc(d.note)}</span>` : ''}`;
  $('#cmRptBody').innerHTML = cmpRptCards(d) + cmpRptTable(d)
    + (d.truncated ? '<p class="text-xs text-amber-700 mt-2">Only the first 5,000 rows are read: choose fewer dates, a country or a client.</p>' : '');
}
function cmpRptDownload() { const r = cmpRptReport(); if (r && CMP_RPT.exportUrl) cmpDownload(CMP_RPT.exportUrl, `compliance-${r.key}.csv`); }
function cmpRptPrint() {
  const r = cmpRptReport(), d = CMP_RPT.data;
  if (!r || !d || !d.rows.length || !document.getElementById('cmRptTable')) return toast('Nothing to print.');
  const note = [cmpRptFilterText(r), d.note].filter(Boolean).map(esc).join('<br>');
  cmpPrintTable($('#cmRptTitle').textContent, 'cmRptTable', note);
}
// a row about something opens it: an invoice, an obligation period, a client
function cmpRptOpen(i) {
  const l = ((CMP_RPT.data && CMP_RPT.data.rows[i]) || {})._link; if (!l) return;
  if (l.invoice) return cmpInvoiceOpen(l.invoice, cmpRptLoad);
  if (l.period) return cmpOpenPeriod(l.period[0], l.period[1], cmpRptLoad);
  if (l.client) return cmpOpenClient(l.client);
}

const cmpRptNum = v => (typeof v !== 'number' ? String(v) : CmpRules.fmtNum ? CmpRules.fmtNum(v, Number.isInteger(v) ? 0 : 1) : v.toLocaleString('en-US'));
// one cell, written the firm's way: days with cmpDay, moments on the firm's clock, money in its own currency
function cmpRptCell(c, r) {
  const v = r[c.key];
  if (v === null || v === undefined || v === '') return '<span class="text-slate-300">—</span>';
  if (c.type === 'money') return cmpMoney(v, r[c.cur || 'currency'] || '');
  if (c.type === 'number') return esc(cmpRptNum(v));
  if (c.type === 'day') return esc(cmpDay(v));
  if (c.type === 'at') return esc(cmpAt(v));
  return esc(v);
}
const cmpRptCards = d => (d.cards && d.cards.length ? `<div class="flex flex-wrap gap-2 mb-3">${d.cards.map(c => `<span class="inline-flex items-baseline gap-1.5 px-3 py-1.5 rounded-lg bg-slate-50 border text-sm">
  <span class="text-slate-600">${esc(c.label)}</span><b>${esc(cmpRptNum(c.value))}</b></span>`).join('')}</div>` : '');
function cmpRptTable(d) {
  if (!d.rows.length) return cmpEmpty('Nothing to show for these filters.');
  const cols = d.columns.filter(c => !c.csvOnly), right = c => c.type === 'money' || c.type === 'number';
  const cls = c => `${right(c) ? 'text-right whitespace-nowrap' : ''} ${c.type === 'day' || c.type === 'at' ? 'whitespace-nowrap' : ''} ${c.wide ? 'min-w-[16rem]' : ''}`;
  const head = `<tr>${cols.map(c => `<th class="py-2 pr-3 font-medium ${right(c) ? 'text-right' : ''}">${esc(c.label)}</th>`).join('')}</tr>`;
  const body = d.rows.map((r, i) => `<tr class="border-b last:border-0 ${r._link ? 'hover:bg-slate-50 cursor-pointer' : ''} ${r._void ? 'text-slate-400' : ''}" ${r._link ? `onclick="cmpRptOpen(${i})"` : ''} ${r._void ? 'title="Listed, not counted in the totals"' : ''}>
    ${cols.map(c => `<td class="py-1.5 pr-3 align-top ${cls(c)}">${cmpRptCell(c, r)}</td>`).join('')}</tr>`).join('');
  // the totals: one line per currency (different currencies are never added together)
  const foot = (d.totals || []).map(t => `<tr class="border-t-2 border-slate-300 font-semibold bg-slate-50">${cols.map((c, k) => `<td class="py-1.5 pr-3 ${cls(c)}">${k === 0 ? esc(t.label) : c.key in t ? cmpRptCell(c, t) : ''}</td>`).join('')}</tr>`).join('');
  return `<div class="overflow-x-auto"><table id="cmRptTable" class="w-full text-sm"><thead class="text-left text-slate-500 border-b">${head}</thead><tbody>${body}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table></div>`;
}
