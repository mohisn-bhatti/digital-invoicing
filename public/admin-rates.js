'use strict';
/* Service tax rates (super admin): the rate schedule of each tax authority, heading by heading, with the date each rate starts and where it comes
   from. A rate is never edited: a change is a new rate from its own date (the old one stays for invoices before it), and a wrong row is voided with a
   reason. The point of sale reads this table: an item that follows the schedule is sold at the rate of the day of the sale.
   Loaded after app.html's own helpers (api, $, esc, toast) are defined and after pos.js (posDownloadFile). */

const arState = { authority: 'PRA', q: '', date: '', rows: [], total: 0, authorityName: '', day: '', timer: null, history: null };
const AR_DEFAULT_SOURCE = 'Punjab Sales Tax on Services Act 2012, Second Schedule (17th edition, 2026-27)';
const AR_AUTHORITIES = { PRA: 'PRA (Punjab)', SRB: 'SRB (Sindh)', KPRA: 'KPRA (Khyber Pakhtunkhwa)', BRA: 'BRA (Balochistan)' };
const arDay = d => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const arPct = n => (n === null || n === undefined ? '<span class="text-slate-300">same</span>' : `${n}%`);
const arBtn = (label, onclick, kind = 'plain') => `<button type="button" onclick="${onclick}" class="px-4 py-2.5 rounded-lg text-sm font-medium ${kind === 'primary' ? 'bg-emerald-700 text-white hover:bg-emerald-800' : kind === 'danger' ? 'border border-red-300 text-red-700 hover:bg-red-50' : 'border hover:border-emerald-600'}">${label}</button>`;

async function loadRates() {
  if (!$('#arModal')) document.body.insertAdjacentHTML('beforeend', `<div id="arModal" class="hidden fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-y-auto p-2 sm:p-4" onclick="if (event.target === this) arClose()"><div id="arModalBody" class="bg-white rounded-xl shadow-xl w-full max-w-3xl mt-2 sm:mt-6 p-4 sm:p-5"></div></div>`);
  arShell(); await arRun();
}
const arClose = () => { const m = $('#arModal'); if (m) m.classList.add('hidden'); };
const arShow = html => { $('#arModalBody').innerHTML = html; $('#arModal').classList.remove('hidden'); };
function arShell() {
  $('#arBox').innerHTML = `<div class="bg-white rounded-xl shadow p-5 space-y-4 text-sm">
    <div><h2 class="font-semibold">Service tax rates <span class="text-xs font-normal text-slate-500">the rate schedule of each tax authority, by heading and date</span></h2>
      <p class="text-xs text-slate-500 mt-1">A rate is never edited. When a rate changes, add the new one <b>from the date it changes</b>: invoices before that date keep the old rate, invoices from it use the new one. Every rate says where it comes from. A wrong entry is voided (with a reason), not deleted. Point-of-sale items that <i>follow the schedule</i> pick up a change by themselves.</p></div>
    <div id="arAuth" class="text-sm">${typeof Authorities !== 'undefined' ? Authorities.badge(arState.authority, { size: 'md' }) : ''}</div>
    <div class="flex flex-wrap items-end gap-3">
      <label><span>Authority</span><select id="arAuthority" onchange="arFilter()">${Object.entries(AR_AUTHORITIES).map(([k, v]) => `<option value="${k}" ${k === arState.authority ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="min-w-[14rem] flex-1"><span>Search</span><input id="arQ" type="search" value="${esc(arState.q)}" placeholder="A heading (9801) or a word (restaurant)…" oninput="arSearch(this.value)" autocomplete="off"></label>
      <label><span>Rates in force on</span><input id="arDate" type="date" value="${esc(arState.date)}" onchange="arFilter()"></label>
      <div class="flex flex-wrap gap-2">${arBtn('+ Set a rate', 'arForm()', 'primary')}${arBtn('Import from a spreadsheet', 'arImportForm()')}${arBtn('Download CSV', 'arCsv()')}</div></div>
    <div id="arNote" class="text-xs text-slate-500"></div>
    <div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Heading</th><th>Service</th><th class="text-right">Rate</th><th class="text-right">Card / wallet</th><th>In force from</th><th class="hidden lg:table-cell">Next change</th><th class="hidden xl:table-cell">Source</th></tr></thead><tbody id="arRows"></tbody></table></div></div>`;
}
let arTimer = null;
function arSearch(v) { arState.q = v.trim(); clearTimeout(arTimer); arTimer = setTimeout(arRun, 300); }
function arFilter() { arState.authority = $('#arAuthority').value; arState.date = $('#arDate').value; const a = $('#arAuth'); if (a && typeof Authorities !== 'undefined') a.innerHTML = Authorities.badge(arState.authority, { size: 'md' }); arRun(); }
async function arRun() {
  try {
    const q = new URLSearchParams({ authority: arState.authority, ...(arState.q ? { q: arState.q } : {}), ...(arState.date ? { date: arState.date } : {}), limit: '1000' });
    const r = await api('/api/admin/rates?' + q);
    Object.assign(arState, { rows: r.rates, total: r.total, authorityName: r.authorityName, day: r.date });
    arRender();
  } catch (err) { toast(err.message); }
}
function arRender() {
  $('#arNote').textContent = `${arState.total} ${arState.total === 1 ? 'heading' : 'headings'} for ${arState.authorityName}. Showing the rate in force on ${arDay(arState.day)}.`;
  $('#arRows').innerHTML = arState.rows.map(r => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer ${r.inForce ? '' : 'opacity-60'}" onclick="arHistory('${r.authority}', '${r.code}')">
      <td class="py-2 font-mono text-xs whitespace-nowrap">${esc(r.heading)}</td><td>${esc(r.label)}${r.conditions ? `<div class="text-xs text-slate-500">${esc(r.conditions)}</div>` : ''}</td>
      <td class="text-right font-medium">${r.inForce ? `${r.rate}%` : '<span class="text-xs text-slate-400">not yet</span>'}</td><td class="text-right">${r.inForce ? arPct(r.cardRate) : ''}</td>
      <td class="whitespace-nowrap text-xs">${esc(arDay(r.effectiveFrom))}${r.inForce ? '' : ' <span class="text-amber-700">(starts later)</span>'}</td>
      <td class="hidden lg:table-cell text-xs">${r.next ? `<span class="text-amber-800">${r.next.rate}%${r.next.cardRate === null ? '' : ` / ${r.next.cardRate}%`} from ${esc(arDay(r.next.effectiveFrom))}</span>` : '<span class="text-slate-300">—</span>'}</td>
      <td class="hidden xl:table-cell text-xs text-slate-500 max-w-[16rem]">${esc([r.sourceName, r.sourceRef].filter(Boolean).join(', '))}</td></tr>`).join('')
    || `<tr><td colspan="7" class="py-6 text-center text-slate-500">${arState.q ? 'No heading matches.' : 'No rates yet. Add one, or import a spreadsheet.'}</td></tr>`;
}
function arCsv() { return posDownloadFile('/api/admin/rates/export?authority=' + encodeURIComponent(arState.authority), 'tax-rates.csv'); }

/* ---------- one heading's history ---------- */
async function arHistory(authority, code) {
  try {
    const rows = await api(`/api/admin/rates/history?authority=${authority}&code=${code}`);
    arState.history = { authority, code, rows };
    const live = rows.filter(r => !r.voided);
    arShow(`<div class="space-y-3 text-sm">
      <div class="flex items-start justify-between gap-3"><div><h2 class="text-lg font-semibold">${esc(rows[0] ? rows[0].heading : code)} <span class="text-sm font-normal text-slate-500">${esc(AR_AUTHORITIES[authority] || authority)}</span></h2>
        <div class="text-slate-600">${esc(rows[0] ? rows[0].label : '')}</div></div><button type="button" onclick="arClose()" class="text-2xl leading-none text-slate-400 px-2" aria-label="Close">×</button></div>
      <div class="border rounded-lg divide-y">${rows.map(r => `<div class="p-3 ${r.voided ? 'opacity-50' : ''}">
        <div class="flex flex-wrap items-center justify-between gap-2"><div class="${r.voided ? 'line-through' : ''}"><b>${r.rate}%</b>${r.cardRate === null ? '' : ` · <b>${r.cardRate}%</b> on card, wallet or QR`} <span class="text-slate-500">from ${esc(arDay(r.effectiveFrom))}</span>
          ${r.inForce ? '<span class="ml-1 text-xs px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">in force today</span>' : ''}${r.future ? '<span class="ml-1 text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">starts later</span>' : ''}${r.voided ? '<span class="ml-1 text-xs px-1.5 py-0.5 rounded bg-slate-200 text-slate-600">voided</span>' : ''}</div>
          ${r.voided ? '' : `<button type="button" onclick="arVoidForm('${r.id}')" class="text-xs text-red-700 underline">Void…</button>`}</div>
        ${r.conditions ? `<div class="text-xs text-slate-600 mt-1">${esc(r.conditions)}</div>` : ''}
        <div class="text-xs text-slate-500 mt-1">Source: ${esc([r.sourceName, r.sourceRef].filter(Boolean).join(', ') || '—')}${r.sourceUrl ? ` · <a class="underline text-emerald-700" href="${esc(r.sourceUrl)}" target="_blank" rel="noopener noreferrer">link</a>` : ''}${r.note ? ' · ' + esc(r.note) : ''}</div>
        <div class="text-xs text-slate-400">Entered by ${esc(r.createdBy)}${r.voided ? ` · voided by ${esc(r.voidedBy)}: ${esc(r.voidReason)}` : ''}</div></div>`).join('')}</div>
      <div class="flex flex-wrap gap-2">${arBtn('Set a new rate for this heading…', `arForm('${authority}', '${code}')`, 'primary')}${arBtn('Close', 'arClose()')}</div>
      ${live.length ? '' : '<p class="text-xs text-slate-500">Every rate for this heading is voided, so items that follow the schedule use their own rate.</p>'}</div>`);
  } catch (err) { toast(err.message); }
}

/* ---------- set a rate ---------- */
function arForm(authority, code) {
  const h = arState.history, last = code && h && h.code === code ? h.rows.find(r => !r.voided) || h.rows[0] : null;
  const row = arState.rows.find(r => r.code === code && r.authority === authority);
  const base = last || row || {}, auth = authority || arState.authority;
  const sourceDefault = base.sourceName || (auth === 'PRA' ? AR_DEFAULT_SOURCE : '');
  arShow(`<div class="space-y-3 text-sm">
    <div class="flex items-start justify-between gap-3"><h2 class="text-lg font-semibold">${code ? 'Set a new rate for this heading' : 'Set a rate'}</h2><button type="button" onclick="arClose()" class="text-2xl leading-none text-slate-400 px-2" aria-label="Close">×</button></div>
    <p class="text-xs text-slate-500">This does not change the old rate: it starts a new one <b>from the date below</b>. Invoices before that date keep the old rate.</p>
    <div class="grid sm:grid-cols-3 gap-3">
      <label><span>Authority</span><select id="frAuth" ${code ? 'disabled' : ''}>${Object.entries(AR_AUTHORITIES).map(([k, v]) => `<option value="${k}" ${k === auth ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label><span>Heading (8 digits)</span><input id="frCode" value="${esc(base.heading || '')}" placeholder="9801.2000" ${code ? 'disabled' : ''} autocomplete="off"></label>
      <label><span>Effective from</span><input id="frFrom" type="date"></label>
      <label class="sm:col-span-3"><span>Service (what the heading is)</span><input id="frLabel" value="${esc(base.label || '')}" maxlength="200" autocomplete="off"></label>
      <label><span>Rate %</span><input id="frRate" inputmode="decimal" value="${base.rate !== undefined ? esc(base.rate) : ''}" autocomplete="off"></label>
      <label><span>Rate % on card, wallet or QR <span class="text-slate-400">(if different)</span></span><input id="frCard" inputmode="decimal" value="${base.cardRate !== null && base.cardRate !== undefined ? esc(base.cardRate) : ''}" autocomplete="off"></label>
      <label><span>Conditions <span class="text-slate-400">(optional)</span></span><input id="frCond" maxlength="400" value="${esc(base.conditions || '')}" autocomplete="off"></label>
      <label class="sm:col-span-3"><span>Where the rate comes from: the document</span><input id="frSrc" maxlength="200" value="${esc(sourceDefault)}" autocomplete="off"></label>
      <label><span>Clause, serial or page</span><input id="frRef" maxlength="200" value="${esc(base.sourceRef || '')}" placeholder="Second Schedule, serial 12" autocomplete="off"></label>
      <label class="sm:col-span-2"><span>Link to it <span class="text-slate-400">(optional)</span></span><input id="frUrl" maxlength="300" value="${esc(base.sourceUrl || '')}" placeholder="https://…" autocomplete="off"></label>
      <label class="sm:col-span-3"><span>Note <span class="text-slate-400">(optional)</span></span><input id="frNote" maxlength="400" autocomplete="off"></label></div>
    <div class="flex gap-2">${arBtn('Save the rate', `arSave('${authority || ''}', '${code || ''}')`, 'primary')}${arBtn('Cancel', code ? `arHistory('${authority}', '${code}')` : 'arClose()')}</div></div>`);
}
async function arSave(authority, code) {
  const body = { authority: authority || $('#frAuth').value, code: code || $('#frCode').value, effectiveFrom: $('#frFrom').value, label: $('#frLabel').value, rate: $('#frRate').value, cardRate: $('#frCard').value, conditions: $('#frCond').value, sourceName: $('#frSrc').value, sourceRef: $('#frRef').value, sourceUrl: $('#frUrl').value, note: $('#frNote').value };
  try { await api('/api/admin/rates', { method: 'POST', body }); toast('Rate saved', true); arClose(); await arRun(); } catch (err) { toast(err.message); }
}
function arVoidForm(id) {
  const h = arState.history;
  arShow(`<div class="space-y-3 text-sm"><div class="flex items-start justify-between gap-3"><h2 class="text-lg font-semibold">Void this rate</h2><button type="button" onclick="arClose()" class="text-2xl leading-none text-slate-400 px-2" aria-label="Close">×</button></div>
    <p class="text-slate-600">Use this only for a rate entered by mistake. It stays in the history, marked as voided, but is no longer used for any invoice. If a rate has simply changed, set a new one from the date it changed instead.</p>
    <label><span>Why</span><input id="fvReason" maxlength="300" autocomplete="off"></label>
    <div class="flex gap-2">${arBtn('Void it', `arVoid('${id}')`, 'danger')}${arBtn('Cancel', `arHistory('${h.authority}', '${h.code}')`)}</div></div>`);
  $('#fvReason').focus();
}
async function arVoid(id) {
  const h = arState.history;
  try { await api(`/api/admin/rates/${id}/void`, { method: 'POST', body: { reason: $('#fvReason').value } }); toast('Voided', true); await arRun(); await arHistory(h.authority, h.code); } catch (err) { toast(err.message); }
}

/* ---------- import from a spreadsheet ---------- */
// A small CSV reader: quoted cells (with commas, quotes and line breaks in them), "" for a quote, the first line as the heading
function arParseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(x => x.trim() !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some(x => x.trim() !== '')) rows.push(row);
  return rows;
}
const AR_COLUMNS = { authority: ['authority'], code: ['code', 'heading', 'pct', 'pctcode'], label: ['label', 'service', 'description'], rate: ['rate', 'rate%', 'tax rate'], cardRate: ['cardrate', 'card rate', 'card', 'card rate%', 'wallet'], effectiveFrom: ['effectivefrom', 'effective from', 'from', 'date', 'effective'], conditions: ['conditions', 'condition'], sourceName: ['sourcename', 'source', 'source name', 'document'], sourceRef: ['sourceref', 'source ref', 'clause', 'serial', 'page'], sourceUrl: ['sourceurl', 'link', 'url'], note: ['note', 'notes'] };
// The cells of a file as the rows the server checks: columns found by their names, whatever order and capitals they are in
function arRowsFromCsv(text) {
  const grid = arParseCsv(text); if (grid.length < 2) throw new Error('The file needs a heading row and at least one rate.');
  const norm = h => String(h).toLowerCase().replace(/[\s%_-]/g, ''); // 'Rate %', 'rate_%' and 'RATE' are all the rate column
  const head = grid[0].map(norm);
  const at = {}; for (const [key, names] of Object.entries(AR_COLUMNS)) { const i = head.findIndex(h => names.map(norm).includes(h)); if (i >= 0) at[key] = i; }
  for (const need of ['code', 'label', 'rate', 'effectiveFrom']) if (at[need] === undefined) throw new Error(`The file has no "${need}" column.`);
  return grid.slice(1).map(r => Object.fromEntries(Object.entries(at).map(([k, i]) => [k, (r[i] || '').trim()])));
}
function arImportForm() {
  arShow(`<div class="space-y-3 text-sm"><div class="flex items-start justify-between gap-3"><h2 class="text-lg font-semibold">Import rates from a spreadsheet</h2><button type="button" onclick="arClose()" class="text-2xl leading-none text-slate-400 px-2" aria-label="Close">×</button></div>
    <p class="text-slate-600">One row per heading and date. Columns (any order, the first line names them): <b>code</b>, <b>label</b>, <b>rate</b>, <b>effectiveFrom</b> (2026-07-01), and optionally <b>cardRate</b>, <b>conditions</b>, <b>sourceName</b>, <b>sourceRef</b>, <b>sourceUrl</b>, <b>note</b>, <b>authority</b> (PRA if left out). Every row must say where it comes from (<b>sourceName</b> or <b>sourceRef</b>). Save the sheet as CSV, or copy the cells and paste them below.</p>
    <div class="flex flex-wrap gap-2 items-center"><input id="fiFile" type="file" accept=".csv,text/csv,text/plain" onchange="arImportFile(this)" class="text-sm"><button type="button" onclick="arTemplate()" class="text-emerald-700 underline text-xs">Download an example file</button></div>
    <textarea id="fiText" rows="8" class="w-full font-mono text-xs" placeholder="code,label,rate,cardRate,effectiveFrom,sourceName,sourceRef&#10;9801.2000,Services provided by restaurants,16,8,2026-07-01,Punjab Sales Tax on Services Act 2012 (17th ed.),Second Schedule" oninput="$('#fiResult').innerHTML = ''"></textarea>
    <div id="fiResult"></div>
    <div class="flex gap-2">${arBtn('Check the file', 'arImportRun(true)')}<span id="fiApply"></span>${arBtn('Cancel', 'arClose()')}</div></div>`);
}
function arImportFile(input) {
  const f = input.files && input.files[0]; if (!f) return;
  if (f.size > 2 * 1024 * 1024) { input.value = ''; return toast('That file is too big (2 MB at most).'); }
  const r = new FileReader(); r.onload = () => { $('#fiText').value = String(r.result); $('#fiResult').innerHTML = ''; }; r.onerror = () => toast('That file could not be read.'); r.readAsText(f);
}
function arTemplate() {
  const csv = '﻿code,label,rate,cardRate,effectiveFrom,conditions,sourceName,sourceRef,sourceUrl\r\n9801.2000,Services provided or rendered by restaurants,16,8,2026-07-01,8% when paid by card or wallet,"Punjab Sales Tax on Services Act 2012, Second Schedule (17th edition, 2026-27)",Second Schedule,\r\n';
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'tax-rates-example.csv'; document.body.appendChild(a); a.click(); a.remove();
}
async function arImportRun(dryRun) {
  const box = $('#fiResult'), apply = $('#fiApply');
  try {
    const rows = arRowsFromCsv($('#fiText').value);
    const r = await api('/api/admin/rates/import', { method: 'POST', body: { rows, dryRun } });
    if (!r.ok) {
      apply.innerHTML = '';
      box.innerHTML = `<div class="rounded-lg border border-red-300 bg-red-50 text-red-800 p-3 text-xs space-y-1"><b>${r.problems.length} ${r.problems.length === 1 ? 'problem' : 'problems'}: nothing was saved.</b>${r.problems.slice(0, 50).map(p => `<div>Row ${p.row}: ${esc(p.message)}</div>`).join('')}${r.problems.length > 50 ? '<div>…and more.</div>' : ''}</div>`;
      return;
    }
    if (!dryRun) { toast(`${r.saved} rates saved`, true); arClose(); await arRun(); return; }
    box.innerHTML = `<div class="rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-900 p-3 text-xs space-y-1"><b>${r.valid} ${r.valid === 1 ? 'rate is' : 'rates are'} ready to import.</b>${r.preview.map(p => `<div class="font-mono">${esc(p.authority)} ${esc(p.code.length === 8 ? p.code.slice(0, 4) + '.' + p.code.slice(4) : p.code)} · ${p.rate}%${p.cardRate === null ? '' : ` / ${p.cardRate}%`} · from ${esc(arDay(p.effectiveFrom))} · ${esc(p.label)}</div>`).join('')}${r.valid > r.preview.length ? `<div>…and ${r.valid - r.preview.length} more.</div>` : ''}</div>`;
    apply.innerHTML = arBtn(`Import ${r.valid} ${r.valid === 1 ? 'rate' : 'rates'}`, 'arImportRun(false)', 'primary');
  } catch (err) { apply.innerHTML = ''; box.innerHTML = `<div class="rounded-lg border border-red-300 bg-red-50 text-red-800 p-3 text-xs">${esc(err.message)}</div>`; }
}
