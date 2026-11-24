'use strict';
/* Compliance & Deadlines screens: the shell, shared helpers, the WhatsApp window, the pop-up and the notifications dashboard (SRS 6, 8, 11).
   The clients, obligations, setup and logs pages are in cmp-*.js and register themselves in CMP_PAGES. Loaded before app.html's own
   script, so nothing here touches that script's globals (S, api, $, esc, toast, route, PAGE_ENTER, renderNav, syncModules, logout) until a
   function runs. The rules (states, colours, dates) are /cmp-rules.js, the same file the server uses. */

const CMP = {
  me: null, perms: new Set(), settings: null, templates: null, alerts: null, alertTimer: null, idleTimer: null, lastActive: Date.now(), watching: false,
  clientId: null, notify: { show: 'all', country: '', q: '' }, searchTimer: null, ranges: {},
};
// Pages the other compliance scripts add: each pushes { id, html(), enter() }
const CMP_PAGES = [];
// What each of those scripts forgets when the login, the module or the workspace changes
const CMP_RESETS = [];
function cmpReset() {
  clearInterval(CMP.alertTimer); clearInterval(CMP.idleTimer);
  Object.assign(CMP, { me: null, perms: new Set(), settings: null, templates: null, alerts: null, clientId: null, notify: { show: 'all', country: '', q: '' }, ranges: {} });
  cmpCloseModal();
  const pop = document.getElementById('cmpPopup'); if (pop) pop.remove();
  document.getElementById('cmpBell')?.remove();
  CMP_RESETS.forEach(f => f());
  CmpRules.setDayFormat(''); CmpRules.setNumberFormat(''); // (the standard ones, until the next firm's are read)
}
// The firm's date and number formats (Settings → General), on every screen of the module
function cmpApplyFormats() { const s = CMP.settings || {}; CmpRules.setDayFormat(s.dateFormat); CmpRules.setNumberFormat(s.numberFormat); }

/* ---------- helpers ---------- */
const cmpCan = (...p) => p.some(x => CMP.perms.has(x));
const cmpCountry = cc => CmpCountries.get(cc) || { code: cc, name: cc, flag: '', dial: '', zones: [] };
const cmpFlagName = cc => `<span class="whitespace-nowrap">${cmpCountry(cc).flag} ${esc(cmpCountry(cc).name)}</span>`;
const cmpDay = v => CmpRules.fmtDay(v) || '—';
const cmpTz = () => (CMP.settings && CMP.settings.timeZone) || 'Asia/Karachi';
const cmpAt = t => (t ? CmpRules.fmtAt(new Date(t), cmpTz()) : '—'); // a moment on the firm's clock
const cmpClientAt = (t, tz) => `${CmpRules.fmtAt(new Date(t), tz)} <span class="text-slate-400">(${esc(CmpCountries.zoneCity(tz))})</span>`;
const cmpCountryOptions = (selected, blank) => (blank ? `<option value="">${esc(blank)}</option>` : '') +
  CmpCountries.list.map(c => `<option value="${c.code}" ${c.code === selected ? 'selected' : ''}>${c.flag} ${esc(c.name)}</option>`).join('');
const CMP_STATUS_TONE = {
  UPCOMING: 'bg-slate-100 text-slate-700', PERIOD_CLOSED: 'bg-sky-100 text-sky-800', DATA_COLLECTED: 'bg-indigo-100 text-indigo-800', FILED: 'bg-violet-100 text-violet-800',
  PAID: 'bg-teal-100 text-teal-800', COMPLETED: 'bg-emerald-100 text-emerald-800', OVERDUE: 'bg-red-600 text-white',
};
const cmpStatusChip = st => `<span class="px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${CMP_STATUS_TONE[st] || 'bg-slate-100'}">${esc(CmpRules.STATUS[st] || st)}</span>`;
// The colour of an obligation period (SRS 6): green safe, amber approaching, red overdue; grey once completed
const CMP_BAR = { green: 'border-l-emerald-500', amber: 'border-l-amber-500', red: 'border-l-red-600', done: 'border-l-slate-300' };
const CMP_DOT = { green: 'bg-emerald-500', amber: 'bg-amber-500', red: 'bg-red-600', done: 'bg-slate-300' };
const cmpDot = c => `<span class="inline-block w-2.5 h-2.5 rounded-full ${CMP_DOT[c] || 'bg-slate-300'}" title="${c === 'red' ? 'Overdue' : c === 'amber' ? 'Approaching' : c === 'done' ? 'Completed' : 'Safe'}"></span>`;
const cmpDaysLeft = v => (v.status === 'COMPLETED' ? '' : v.daysLeft > 1 ? `${v.daysLeft} days left` : v.daysLeft === 1 ? 'due tomorrow' : v.daysLeft === 0 ? 'due today' : `${-v.daysLeft} day${v.daysLeft === -1 ? '' : 's'} overdue`);
const cmpBtn = (label, onclick, kind = 'plain', extra = '') => {
  const k = { primary: 'bg-emerald-700 text-white hover:bg-emerald-800', danger: 'border border-red-300 text-red-700 hover:bg-red-50', plain: 'border bg-white hover:border-emerald-600', wa: 'bg-[#25D366] text-white hover:bg-[#1ebe5a]' }[kind];
  return `<button type="button" onclick="${onclick}" class="px-3 min-h-[2.5rem] rounded-lg text-sm font-medium whitespace-nowrap ${k} ${extra}">${label}</button>`;
};
const CMP_WA_ICON = '<svg viewBox="0 0 24 24" class="w-4 h-4 inline -mt-0.5" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 00-8.6 15.1L2 22l5-1.3A10 10 0 1012 2zm0 18.2a8.2 8.2 0 01-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1112 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 01-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 00-.7.3 3 3 0 00-.9 2.2 5.2 5.2 0 001.1 2.7 11.8 11.8 0 004.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 001.8-1.2 2.2 2.2 0 00.1-1.2c0-.1-.2-.2-.4-.3z"/></svg>';
const cmpEmpty = text => `<div class="text-sm text-slate-500 py-6 text-center">${text}</div>`;

/* ---------- which dates a list shows (the CA: the calendar year by default, 1 January to 31 December; other years, several years
   side by side, any dates, or the whole history). Each list keeps its own choice under a name. ---------- */
const cmpThisYear = () => Number(CmpRules.dayIn(cmpTz()).slice(0, 4));
const cmpRangeNew = () => ({ mode: 'year', y1: cmpThisYear(), y2: cmpThisYear(), from: '', to: '' });
const cmpRange = name => (CMP.ranges[name] || (CMP.ranges[name] = { r: cmpRangeNew(), go: null })).r;
function cmpRangeDates(name) {
  const r = cmpRange(name);
  if (r.mode === 'all') return { from: '', to: '' };
  if (r.mode === 'dates') return { from: r.from, to: r.to };
  return { from: `${Math.min(r.y1, r.y2)}-01-01`, to: `${Math.max(r.y1, r.y2)}-12-31` };
}
function cmpRangeText(name) {
  const r = cmpRange(name);
  if (r.mode === 'all') return 'all history';
  if (r.mode === 'dates') return `${CmpRules.fmtDay(r.from) || '…'} – ${CmpRules.fmtDay(r.to) || '…'}`;
  return r.y1 === r.y2 ? `1 Jan – 31 Dec ${r.y1}` : `${Math.min(r.y1, r.y2)} – ${Math.max(r.y1, r.y2)}`;
}
function cmpRangeBar(name, onChange) {
  cmpRange(name); CMP.ranges[name].go = onChange;
  return `<div id="cmR_${name}" class="contents">${cmpRangeInner(name)}</div>`;
}
function cmpRangeInner(name) {
  const r = cmpRange(name), y = cmpThisYear();
  const pick = r.mode !== 'year' ? r.mode : r.y1 !== r.y2 ? 'years' : r.y1 === y ? 'this' : r.y1 === y - 1 ? 'last' : r.y1 === y + 1 ? 'next' : 'years';
  const opt = (v, t) => `<option value="${v}" ${pick === v ? 'selected' : ''}>${t}</option>`;
  return `<label><span>Show</span><select onchange="cmpRangePick('${name}', this.value)">${opt('this', `This year (${y})`)}${opt('last', `Last year (${y - 1})`)}${opt('next', `Next year (${y + 1})`)}${opt('years', 'Choose years…')}${opt('dates', 'Choose dates…')}${opt('all', 'All history')}</select></label>
    ${pick === 'years' ? `<label class="w-24"><span>From year</span><input type="number" min="1990" max="2200" value="${r.y1}" onchange="cmpRangeSet('${name}', 'y1', this.value)"></label><label class="w-24"><span>To year</span><input type="number" min="1990" max="2200" value="${r.y2}" onchange="cmpRangeSet('${name}', 'y2', this.value)"></label>` : ''}
    ${pick === 'dates' ? `<label><span>From</span><input type="date" value="${r.from}" onchange="cmpRangeSet('${name}', 'from', this.value)"></label><label><span>To</span><input type="date" value="${r.to}" onchange="cmpRangeSet('${name}', 'to', this.value)"></label>` : ''}`;
}
function cmpRangeRedraw(name) { const box = document.getElementById('cmR_' + name); if (box) box.innerHTML = cmpRangeInner(name); const st = CMP.ranges[name]; if (st.go) st.go(); }
function cmpRangePick(name, v) {
  const st = CMP.ranges[name], y = cmpThisYear(), k = { this: 0, last: -1, next: 1 }[v];
  if (k !== undefined) st.r = { ...st.r, mode: 'year', y1: y + k, y2: y + k };
  else if (v === 'years') st.r = { ...st.r, mode: 'year', y1: y - 1, y2: y }; // two years side by side, to compare
  else if (v === 'dates') st.r = { ...st.r, mode: 'dates', from: st.r.from || `${y}-01-01`, to: st.r.to || `${y}-12-31` };
  else st.r = { ...st.r, mode: 'all' };
  cmpRangeRedraw(name);
}
function cmpRangeSet(name, key, v) {
  const st = CMP.ranges[name];
  if (key === 'y1' || key === 'y2') { const n = Number(v); if (!Number.isInteger(n) || n < 1990 || n > 2200) return toast('Type a year, e.g. 2026.'); st.r[key] = n; }
  else st.r[key] = v;
  cmpRangeRedraw(name);
}
// Files from the server need the login: fetched with it, then saved
async function cmpDownload(url, filename) {
  try {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + S.token } });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `Download failed (${r.status})`); }
    const blob = await r.blob(), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (err) { toast(err.message); }
}
async function cmpTemplates(force) {
  if (!CMP.templates || force) CMP.templates = await api('/api/cmp/templates');
  return CMP.templates;
}

/* ---------- the window (modal) ---------- */
function cmpEnsureModal() {
  if (document.getElementById('cmpModal')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="cmpModal" class="hidden fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-y-auto p-2 sm:p-4" onclick="if (event.target === this) cmpCloseModal()">
      <div id="cmpModalBody" role="dialog" aria-modal="true" class="bg-white rounded-xl shadow-xl w-full max-w-3xl mt-2 sm:mt-6 p-4 sm:p-5"></div></div>`);
  document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (cmpSubOpen()) cmpCloseSub(); else cmpCloseModal(); });
}
function cmpShowModal(html, { wide = false, xl = false } = {}) {
  cmpEnsureModal();
  const body = document.getElementById('cmpModalBody');
  body.classList.toggle('max-w-[min(100rem,98vw)]', xl); body.classList.toggle('max-w-5xl', wide && !xl); body.classList.toggle('max-w-3xl', !wide && !xl);
  body.innerHTML = html;
  document.getElementById('cmpModal').classList.remove('hidden');
}
function cmpCloseModal() { const m = document.getElementById('cmpModal'); if (m) m.classList.add('hidden'); }
// A second, smaller window over the first (or over the page): a message, a date, a question — what is typed in the first stays
function cmpShowSub(html, { wide = false } = {}) {
  let box = document.getElementById('cmpSub');
  if (!box) {
    document.body.insertAdjacentHTML('beforeend', `<div id="cmpSub" class="hidden fixed inset-0 z-[60] bg-black/40 flex items-start justify-center overflow-y-auto p-2 sm:p-6" onclick="if (event.target === this) cmpCloseSub()">
      <div id="cmpSubBody" role="dialog" aria-modal="true" class="bg-white rounded-xl shadow-2xl w-full mt-4 sm:mt-10 p-4 sm:p-5"></div></div>`);
    box = document.getElementById('cmpSub');
  }
  const body = document.getElementById('cmpSubBody');
  body.classList.toggle('max-w-5xl', wide); body.classList.toggle('max-w-md', !wide);
  body.innerHTML = html;
  box.classList.remove('hidden');
  const first = body.querySelector('input:not([type=hidden]):not([disabled]), textarea, select'); if (first) setTimeout(() => first.focus(), 0);
}
function cmpCloseSub() { const m = document.getElementById('cmpSub'); if (m) m.classList.add('hidden'); }
const cmpSubOpen = () => { const m = document.getElementById('cmpSub'); return Boolean(m && !m.classList.contains('hidden')); };
const cmpSubHead = (title, sub = '') => `<div class="flex items-start justify-between gap-3 mb-3"><div><h2 class="text-base font-semibold">${title}</h2>${sub ? `<div class="text-sm text-slate-500">${sub}</div>` : ''}</div>
  <button type="button" onclick="cmpCloseSub()" class="text-slate-400 hover:text-slate-700 text-2xl leading-none px-2" aria-label="Close">×</button></div>`;
// Asks for a day (the tracker: data collected on, task done on, ...), and a note if wanted (the CA): ok(ymd, note) runs when confirmed
function cmpAskDate(title, note, { value, max, okLabel = 'Save', withNote = false, noteValue = '' } = {}, ok) {
  CMP.askDate = ok;
  cmpShowSub(`${cmpSubHead(title, note)}
    <form onsubmit="event.preventDefault(); const v = this.d.value; if (!v) return toast('Choose the date.'); const n = this.n ? this.n.value : undefined; cmpCloseSub(); CMP.askDate(v, n)" class="space-y-3">
      <label><span>Date</span><input name="d" type="date" required value="${esc(value || CmpRules.dayIn(cmpTz()))}" ${max ? `max="${esc(max)}"` : ''}></label>
      ${withNote ? `<label><span>Note <span class="text-slate-400">(optional)</span></span><textarea name="n" rows="2" maxlength="1000" placeholder="e.g. bank statements still to come">${esc(noteValue)}</textarea></label>` : ''}
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseSub()')}<button class="needs-write px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">${esc(okLabel)}</button></div></form>`);
}
const cmpModalHead = (title, sub = '') => `<div class="flex items-start justify-between gap-3 mb-4"><div><h2 class="text-lg font-semibold">${title}</h2>${sub ? `<div class="text-sm text-slate-500">${sub}</div>` : ''}</div>
  <button type="button" onclick="cmpCloseModal()" class="text-slate-400 hover:text-slate-700 text-2xl leading-none px-2" aria-label="Close">×</button></div>`;

/* ---------- start ---------- */
async function initCmp() {
  try {
    if (!S.meta) { S.meta = await api('/api/meta'); renderNav(); }
    S.settings = await api('/api/client/settings');
    if (syncModules()) return;
    renderReadOnly(); // (the banner, and the menu without what needs a change: app.html)
    CMP.me = await api('/api/cmp/me');
    CMP.perms = new Set(CMP.me.perms); CMP.settings = CMP.me.settings;
    cmpApplyFormats();
    S.cmpPerms = CMP.me.perms; renderNav();
  } catch (err) { toast(err.message); }
  $('#envBadge').classList.add('hidden'); // (the FBR environment badge belongs to Digital Invoicing)
  const host = $('#clientView');
  host.querySelectorAll('[data-page^="cm-"]').forEach(el => el.remove());
  host.insertAdjacentHTML('beforeend', cmpPagesHtml());
  cmpEnsureModal();
  Object.assign(PAGE_ENTER, Object.fromEntries(CMP_PAGES.map(x => [x.id, x.enter])));
  clearInterval(CMP.alertTimer); CMP.alertTimer = setInterval(cmpPollAlerts, 5 * 60000);
  cmpBell();
  cmpWatchIdle();
  if (!CMP.watching) { CMP.watching = true; document.addEventListener('visibilitychange', () => { if (!document.hidden) cmpPollAlerts(); }); }
  cmpPollAlerts();
  route();
}
function cmpPagesHtml() {
  const page = (id, inner) => `<div data-page="${id}" class="page hidden space-y-4">${inner}</div>`;
  return [
    page('cm-none', `<div class="bg-white rounded-xl shadow p-6 max-w-xl"><h2 class="font-semibold mb-2">No access yet</h2>
      <p class="text-sm text-slate-600">Your login can open Compliance &amp; Deadlines, but the ETAX administrator has not given you any permissions in it yet. Ask them to set what you may do.</p></div>`),
    ...CMP_PAGES.map(x => page(x.id, x.html())),
  ].join('');
}

/* ---------- a session left alone signs out (SRS 16: session timeout) ---------- */
// how long: the firm's choice (Settings → Security), 30 minutes unless it says otherwise
const cmpIdleMinutes = () => Number((CMP.settings && CMP.settings.sessionMinutes) || 30);
function cmpWatchIdle() {
  CMP.lastActive = Date.now();
  if (!CMP.idleBound) {
    CMP.idleBound = true;
    for (const ev of ['mousemove', 'keydown', 'click', 'touchstart', 'scroll']) document.addEventListener(ev, () => { CMP.lastActive = Date.now(); }, { passive: true });
  }
  clearInterval(CMP.idleTimer);
  CMP.idleTimer = setInterval(() => {
    if (!S.token || S.module !== 'COMPLIANCE') { clearInterval(CMP.idleTimer); return; }
    if (Date.now() - CMP.lastActive > cmpIdleMinutes() * 60000) { clearInterval(CMP.idleTimer); logout(); toast(`Signed out after ${cmpIdleMinutes()} minutes without activity, to keep your clients' details safe.`); }
  }, 60000);
}

/* ---------- WhatsApp (SRS 8) ---------- */
// what: { kind, clientId, occurrenceId, reminderId, templateId }. The text is filled in by the server, the person reads and changes it,
// then WhatsApp opens with it (Web or the app) and the message goes in the log.
async function cmpWhatsApp(what, after) {
  let p;
  try { p = await api('/api/cmp/messages/prepare', { method: 'POST', body: what }); } catch (err) { return toast(err.message); }
  CMP.wa = { what: { ...what, templateId: p.templateId }, after };
  let templates = [];
  try { templates = await cmpTemplates(); } catch { /* the template stays as prepared */ }
  // only the templates of this message's category for the client's country (the CA, 24 Nov 2026: "on the invoice issuance screen only the
  // templates saved under the category of invoice"); the one set on the obligation comes first, already chosen
  const sorted = templates.filter(t => CmpRules.templateFits(t, p.category, p.client.country)).sort((a, b) => (b.country === p.client.country) - (a.country === p.client.country) || a.name.localeCompare(b.name));
  if (p.templateId && !sorted.some(t => t.id === p.templateId)) sorted.unshift({ id: p.templateId, name: p.templateName || 'template', purpose: '' });
  const warn = [p.missing.length && `Not known, left as typed: ${p.missing.map(x => `[${esc(x)}]`).join(' ')}`, p.empty.length && `No value for this client (left empty): ${p.empty.map(x => `[${esc(x)}]`).join(' ')}`].filter(Boolean);
  cmpShowModal(`${cmpModalHead(`${CMP_WA_ICON} Send on WhatsApp`, `${cmpCountry(p.client.country).flag} ${esc(p.client.name)} · ${esc(CmpRules.MESSAGE_KINDS[p.kind])}`)}
    <div class="space-y-3">
      <div class="grid sm:grid-cols-2 gap-3">
        <label><span>WhatsApp number</span><input id="cmWaPhone" value="${p.phone ? '+' + esc(p.phone) : ''}" inputmode="tel" placeholder="+971 50 123 4567"></label>
        <label><span>Template <span class="text-slate-400">— ${esc(CmpRules.templateCategory(p.category))}</span></span><select id="cmWaTpl" onchange="cmpWhatsAppTemplate(this.value)"><option value="">${sorted.length ? '— none —' : `— no ${esc(CmpRules.templateCategory(p.category))} template yet —`}</option>
          ${!p.templateId && p.templateName ? `<option value="" selected>${esc(p.templateName)} (its own message)</option>` : ''}
          ${sorted.map(t => `<option value="${t.id}" ${t.id === p.templateId ? 'selected' : ''}>${esc(t.name)}${t.country ? ` · ${esc(t.country)}` : ''}</option>`).join('')}</select></label>
      </div>
      ${p.phone ? '' : '<div class="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">This client has no usable WhatsApp number. Type one with its country code.</div>'}
      ${cmpSenderPicker()}
      <label><span>Message <span class="text-slate-400">— you can change it before it opens in WhatsApp</span></span><textarea id="cmWaBody" rows="9" maxlength="4000">${esc(p.body)}</textarea></label>
      ${warn.length ? `<div class="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 space-y-1">${warn.map(w => `<div>${w}</div>`).join('')}</div>` : ''}
      <p class="text-xs text-slate-500">WhatsApp opens with this text; press Send there. The message is saved in the WhatsApp log now. If you do not send it after all, mark it "not sent" in the log.</p>
      <div id="cmWaLink"></div>
      <div class="flex flex-wrap justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseModal()')}${cmpBtn(`${CMP_WA_ICON} Open WhatsApp`, 'cmpWhatsAppGo()', 'wa', 'needs-write')}</div>
    </div>`);
  cmpSenderNote();
}
async function cmpWhatsAppTemplate(id) {
  try {
    const p = await api('/api/cmp/messages/prepare', { method: 'POST', body: { ...CMP.wa.what, templateId: id || undefined, noTemplate: !id } });
    $('#cmWaBody').value = p.body;
    CMP.wa.what.templateId = id || null; CMP.wa.what.noTemplate = !id;
  } catch (err) { toast(err.message); }
}
// The firm's WhatsApp numbers to send from (Setup → Settings), the last one used on this computer first
const cmpSenders = () => ((CMP.settings && CMP.settings.waSenders) || []).filter(x => x.active !== false); // (an inactive number is not offered: the CA's Active / Inactive)
function cmpSenderPicker() {
  const list = cmpSenders();
  if (!list.length) return `<p class="text-xs text-slate-500">It goes from the WhatsApp account open on this computer or phone.${cmpCan('FULL') ? ' To choose your business number, add it under Settings → Your WhatsApp numbers.' : ''}</p>`;
  let last = null; try { last = localStorage.getItem('cmpSender:' + S.company); } catch { /* the default then */ }
  const pick = list.find(x => x.id === last) || list.find(x => x.isDefault) || list[0];
  return `<div><label><span>Send from</span><select id="cmWaFrom" onchange="cmpSenderNote()">${list.map(x => `<option value="${esc(x.id)}" ${x.id === pick.id ? 'selected' : ''}>${esc(x.label)} · ${esc(x.phone)}</option>`).join('')}</select></label>
    <p id="cmWaFromNote" class="text-xs text-sky-800 bg-sky-50 border border-sky-200 rounded px-3 py-2 mt-2"></p></div>`;
}
function cmpSenderChosen() { const sel = document.getElementById('cmWaFrom'); return sel ? cmpSenders().find(x => x.id === sel.value) || null : null; }
function cmpSenderNote() {
  const s = cmpSenderChosen(), box = document.getElementById('cmWaFromNote'); if (!s || !box) return;
  box.innerHTML = { WEB: `Opens <b>WhatsApp Web</b>: it must be logged in with <b>${esc(s.phone)}</b> in this browser (web.whatsapp.com).`,
    BUSINESS: `Opens the <b>WhatsApp Business</b> app${/Android/i.test(navigator.userAgent) ? '' : ' (on a computer or iPhone: the WhatsApp the device has)'}: it must be the one with <b>${esc(s.phone)}</b>.`,
    APP: `Opens the <b>WhatsApp app</b> installed here: it must be logged in with <b>${esc(s.phone)}</b>.`,
    ANY: `The device chooses which WhatsApp opens: make sure it is the one with <b>${esc(s.phone)}</b>.` }[s.open];
}
async function cmpWhatsAppGo() {
  const body = $('#cmWaBody').value, phone = $('#cmWaPhone').value, sender = cmpSenderChosen();
  if (!body.trim()) return toast('Write the message first.');
  const android = /Android/i.test(navigator.userAgent), mode = sender ? sender.open : 'ANY';
  const web = mode === 'WEB' || mode === 'ANY' || (mode === 'BUSINESS' && !android);
  // a web link opens in a window opened inside the click (a pop-up blocker allows that), pointed at WhatsApp once the message is logged;
  // an app link (whatsapp://, Android's WhatsApp Business) is opened from this page
  const w = web ? window.open('', '_blank') : null;
  try {
    const r = await api('/api/cmp/messages', { method: 'POST', body: { ...CMP.wa.what, templateId: CMP.wa.what.templateId || undefined, body, phone, fromId: sender ? sender.id : undefined } });
    if (sender) { try { localStorage.setItem('cmpSender:' + S.company, sender.id); } catch { /* a convenience only */ } }
    const link = CmpRules.waLink(r.to, r.text, r.open, { android }); // (the text as logged)
    if (!web) { location.href = link; cmpCloseModal(); toast('Saved in the log. Press Send in WhatsApp.', true); }
    else if (w) { w.opener = null; w.location.href = link; cmpCloseModal(); toast('Opened in WhatsApp and saved in the log. Press Send in WhatsApp.', true); }
    else $('#cmWaLink').innerHTML = `<a href="${esc(link)}" target="_blank" rel="noopener" class="inline-block px-4 py-2 rounded-lg bg-[#25D366] text-white font-medium" onclick="cmpCloseModal()">Your browser blocked the new window: open WhatsApp</a>`;
    if (CMP.wa.after) CMP.wa.after();
  } catch (err) { if (w) w.close(); toast(err.message); }
}
// A message about the client that is not a reminder (e.g. asking for documents, telling it the work is done): a template of the Others
// category (the CA, 24 Nov 2026: the categories are the three reminders, advance payment, invoice, receipt and others)
async function cmpClientMessage(clientId, occurrenceId) {
  try { await cmpTemplates(true); } catch (err) { return toast(err.message); }
  cmpWhatsApp({ kind: 'OTHER', clientId, occurrenceId: occurrenceId || undefined }, () => { if (S.page && PAGE_ENTER[S.page]) PAGE_ENTER[S.page](); });
}

/* ---------- reminders, as pills (SRS 6: highlighted, bleak, missed, sent) ---------- */
function cmpReminderPill(r, item, refresh) {
  const tz = item.client.timeZone, when = cmpClientAt(r.fireAt, tz), label = esc(CmpRules.offsetLabel(r.offsetDays)), noWa = item.client.noWhatsApp;
  // given another way and marked by hand (the CA: clients with no WhatsApp; anyone may also be called instead)
  const other = noWa => (cmpCan('WHATSAPP', 'COMPLETE') ? `<button type="button" class="needs-write ml-2 ${noWa ? 'px-2 py-1 rounded-md text-xs font-semibold border border-amber-600 bg-white text-amber-900' : 'text-xs underline text-slate-600'}"
    onclick="cmpRemindedForm('${item.id}', '${r.id}', '${refresh}')">${noWa ? '✓ Reminded by phone / email' : 'or mark done another way'}</button>` : '');
  const send = (txt, kind = 'wa') => (noWa ? (kind === 'wa' ? other(true) : '') : cmpCan('WHATSAPP') ? `<button type="button" class="needs-write ml-2 px-2 py-1 rounded-md text-xs font-semibold ${kind === 'wa' ? 'bg-[#25D366] text-white' : 'border border-emerald-600 text-emerald-800'}"
    onclick="cmpWhatsApp({ kind: 'REMINDER', occurrenceId: '${item.id}', reminderId: '${r.id}' }, ${refresh})">${txt}</button>` : '');
  const tpl = `<span class="text-slate-500"> · ${esc(r.templateName || 'no template')}</span>`;
  if (r.state === 'HIGHLIGHTED') return `<div class="flex flex-wrap items-center gap-1 rounded-lg bg-amber-100 border border-amber-300 text-amber-900 px-2.5 py-1.5 text-xs"><b>${noWa ? 'Remind now' : 'Send now'}</b> · ${label}${tpl}<span class="text-amber-800"> · since ${when}</span>${send(`${CMP_WA_ICON} WhatsApp`)}${noWa ? '' : other(false)}</div>`;
  if (r.state === 'MISSED') return `<div class="flex flex-wrap items-center gap-1 rounded-lg border border-amber-400 text-amber-900 px-2.5 py-1.5 text-xs"><b>Not ${noWa ? 'done' : 'sent'}</b> · ${label}${tpl}<span class="text-slate-500"> · came due ${when}</span>${send(`${CMP_WA_ICON} WhatsApp`)}${noWa ? '' : other(false)}</div>`;
  if (r.state === 'SENT') return `<div class="flex flex-wrap items-center gap-1 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 px-2.5 py-1.5 text-xs">✓ Sent ${esc(cmpAt(r.sentAt))} · ${label}${tpl}${item.stage === 'COMPLETED' ? '' : send('Send again', 'plain')}</div>`;
  if (r.state === 'CLOSED') return `<div class="rounded-lg bg-slate-50 border text-slate-400 px-2.5 py-1.5 text-xs">${label}${tpl} · closed</div>`;
  return `<div class="rounded-lg bg-slate-50 border border-dashed text-slate-400 px-2.5 py-1.5 text-xs" title="Becomes active when its time comes">${label}${tpl} · activates ${when}</div>`;
}

// A reminder given by phone, email or another way, marked so it counts as done (the CA)
function cmpRemindedForm(occurrenceId, reminderId, refreshName) {
  CMP.reminded = { occurrenceId, reminderId, refreshName, period: CMP_OB && CMP_OB.period && CMP_OB.period.p && CMP_OB.period.p.id === occurrenceId ? CMP_OB.period : null };
  cmpShowModal(`${cmpModalHead('Reminder given another way', 'It counts as done, and the log keeps how it was given.')}
    <div class="space-y-3"><div class="flex flex-wrap gap-4 text-sm">${['PHONE', 'EMAIL', 'OTHER'].map((k, i) => `<label class="flex items-center gap-2"><input type="radio" name="cmRemHow" value="${k}" ${i ? '' : 'checked'}> ${esc(CmpRules.CHANNELS[k])}</label>`).join('')}</div>
      <label><span>Note <span class="text-slate-400">(optional — e.g. spoke to the accountant, will send the data on Monday)</span></span><textarea id="cmRemNote" rows="2" maxlength="1000"></textarea></label>
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseModal()')}${cmpBtn('✓ Mark as reminded', 'cmpRemindedSave()', 'primary', 'needs-write')}</div></div>`);
}
async function cmpRemindedSave() {
  const c = CMP.reminded, channel = document.querySelector('input[name="cmRemHow"]:checked').value;
  try {
    await api('/api/cmp/messages/manual', { method: 'POST', body: { occurrenceId: c.occurrenceId, reminderId: c.reminderId, channel, note: $('#cmRemNote').value } });
    cmpCloseModal(); toast(`Marked as reminded by ${CmpRules.CHANNELS[channel].toLowerCase()}`, true);
    if (c.period) return cmpOpenPeriod(c.period.ob.id, c.period.p.id, c.period.refresh).then(() => { if (c.period.refresh) c.period.refresh(); });
    const f = window[c.refreshName]; if (typeof f === 'function') f();
  } catch (err) { toast(err.message); }
}

const cmpOpenClient = id => { if (CMP.clientId !== id) Object.assign(CMP, { clTrackQ: '', clTrackS: 'ALL', clTrackOff: 0 }); CMP.clientId = id; go('cm-client'); };
const cmpOpenObligations = status => { if (typeof cmpObligationsFilter === 'function') cmpObligationsFilter({ status }); go('cm-obligations'); };

/* ---------- the administrator: what a user may do here (Manage → Users) ---------- */
function cmpPermsDialog(clientId, userId, email, current) {
  const stored = CmpPerms.clean(current);
  const box = id => `<label class="flex items-start gap-2 py-1"><input type="checkbox" name="cmpPerm" value="${id}" ${stored.includes(id) || (stored.includes('FULL') && id !== 'FULL') ? 'checked' : ''} ${stored.includes('FULL') && id !== 'FULL' ? 'disabled' : ''}
    onchange="cmpPermsFull()"><span class="text-sm">${esc(CmpPerms.label(id))}</span></label>`;
  CMP.permsFor = { clientId, userId };
  cmpShowModal(`${cmpModalHead('Compliance & Deadlines access', esc(email))}
    <div class="flex flex-wrap gap-2 mb-3">${CmpPerms.PRESETS.map(p => cmpBtn(esc(p.label), `cmpPermsPreset('${p.id}')`)).join('')}</div>
    <div id="cmpPermBoxes" class="grid sm:grid-cols-2 gap-x-6">${CmpPerms.IDS.map(box).join('')}</div>
    <p class="text-xs text-slate-500 mt-3">Any permission includes seeing the clients and obligations. The firm cannot change these itself; the user's screens follow on their next click.</p>
    <div class="flex justify-end gap-2 mt-4">${cmpBtn('Cancel', 'cmpCloseModal()')}${cmpBtn('Save', 'cmpPermsSave()', 'primary')}</div>`);
}
function cmpPermsFull() {
  const full = document.querySelector('#cmpPermBoxes input[value="FULL"]').checked;
  document.querySelectorAll('#cmpPermBoxes input[name="cmpPerm"]').forEach(i => { if (i.value !== 'FULL') { i.disabled = full; if (full) i.checked = true; } });
}
function cmpPermsPreset(id) {
  const p = CmpPerms.PRESETS.find(x => x.id === id);
  document.querySelectorAll('#cmpPermBoxes input[name="cmpPerm"]').forEach(i => { i.disabled = false; i.checked = p.perms.includes(i.value); });
  cmpPermsFull();
}
async function cmpPermsSave() {
  const boxes = [...document.querySelectorAll('#cmpPermBoxes input[name="cmpPerm"]')];
  const full = boxes.find(i => i.value === 'FULL').checked;
  const perms = full ? ['FULL'] : boxes.filter(i => i.checked).map(i => i.value);
  try {
    await api(`/api/admin/clients/${CMP.permsFor.clientId}/users/${CMP.permsFor.userId}/cmp-perms`, { method: 'PUT', body: { perms } });
    cmpCloseModal(); toast('Compliance access saved', true);
    if (typeof loadUsers === 'function') loadUsers('a');
  } catch (err) { toast(err.message); }
}
