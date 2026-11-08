'use strict';
/* Compliance & Deadlines screens: the shell, shared helpers, the WhatsApp window, the pop-up and the notifications dashboard (SRS 6, 8, 11).
   The clients, obligations, setup and logs pages are in cmp-*.js and register themselves in CMP_PAGES. Loaded before app.html's own
   script, so nothing here touches that script's globals (S, api, $, esc, toast, route, PAGE_ENTER, renderNav, syncModules, logout) until a
   function runs. The rules (states, colours, dates) are /cmp-rules.js, the same file the server uses. */

const CMP = {
  me: null, perms: new Set(), settings: null, templates: null, alerts: null, alertTimer: null, idleTimer: null, lastActive: Date.now(), watching: false,
  clientId: null, notify: { show: 'all', country: '', q: '' }, searchTimer: null,
};
// Pages the other compliance scripts add: each pushes { id, html(), enter() }
const CMP_PAGES = [];
// What each of those scripts forgets when the login, the module or the workspace changes
const CMP_RESETS = [];
function cmpReset() {
  clearInterval(CMP.alertTimer); clearInterval(CMP.idleTimer);
  Object.assign(CMP, { me: null, perms: new Set(), settings: null, templates: null, alerts: null, clientId: null, notify: { show: 'all', country: '', q: '' } });
  cmpCloseModal();
  const pop = document.getElementById('cmpPopup'); if (pop) pop.remove();
  CMP_RESETS.forEach(f => f());
}

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
  document.addEventListener('keydown', e => { if (e.key === 'Escape') cmpCloseModal(); });
}
function cmpShowModal(html, { wide = false } = {}) {
  cmpEnsureModal();
  const body = document.getElementById('cmpModalBody');
  body.classList.toggle('max-w-5xl', wide); body.classList.toggle('max-w-3xl', !wide);
  body.innerHTML = html;
  document.getElementById('cmpModal').classList.remove('hidden');
}
function cmpCloseModal() { const m = document.getElementById('cmpModal'); if (m) m.classList.add('hidden'); }
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
    S.cmpPerms = CMP.me.perms; renderNav();
  } catch (err) { toast(err.message); }
  $('#envBadge').classList.add('hidden'); // (the FBR environment badge belongs to Digital Invoicing)
  const host = $('#clientView');
  host.querySelectorAll('[data-page^="cm-"]').forEach(el => el.remove());
  host.insertAdjacentHTML('beforeend', cmpPagesHtml());
  cmpEnsureModal();
  Object.assign(PAGE_ENTER, { 'cm-notify': cmpEnterNotify }, Object.fromEntries(CMP_PAGES.map(x => [x.id, x.enter])));
  clearInterval(CMP.alertTimer); CMP.alertTimer = setInterval(cmpPollAlerts, 5 * 60000);
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
    page('cm-notify', '<div id="cmNotify"></div>'),
    ...CMP_PAGES.map(x => page(x.id, x.html())),
  ].join('');
}

/* ---------- alerts, the menu badge and the pop-up (SRS 6) ---------- */
async function cmpPollAlerts() {
  if (!S.token || S.module !== 'COMPLIANCE') { clearInterval(CMP.alertTimer); return; }
  if (document.hidden || !cmpCan('VIEW')) return;
  try { CMP.alerts = await api('/api/cmp/alerts'); cmpBadge(); cmpPopup(); } catch { /* the pages report problems themselves */ }
}
function cmpBadge() {
  const a = CMP.alerts, link = document.querySelector('#nav [data-nav="cm-notify"]');
  if (!a || !link) return;
  link.querySelector('.cmp-badge')?.remove();
  const n = a.overdue + a.ready;
  if (n) link.insertAdjacentHTML('beforeend', `<span class="cmp-badge ml-auto text-[11px] font-semibold px-1.5 rounded-full ${a.overdue ? 'bg-red-600' : 'bg-amber-500'} text-white">${n}</span>`);
}
// Once per session for the same numbers: "N reminders are ready to send, M obligations are overdue"
function cmpPopup() {
  const a = CMP.alerts; if (!a || !(a.overdue + a.ready) || !cmpCan('REPORTS', 'WHATSAPP')) return;
  const key = `cmpPopup:${S.company}:${a.overdue}:${a.ready}`;
  try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch { /* shown again next time: harmless */ }
  document.getElementById('cmpPopup')?.remove();
  const bits = [a.ready && `<b>${a.ready}</b> reminder${a.ready === 1 ? ' is' : 's are'} ready to send`, a.overdue && `<b class="text-red-700">${a.overdue}</b> obligation${a.overdue === 1 ? ' is' : 's are'} overdue`].filter(Boolean);
  document.body.insertAdjacentHTML('beforeend', `<div id="cmpPopup" role="alert" class="fixed bottom-4 right-4 z-40 max-w-sm bg-white rounded-xl shadow-2xl border-l-4 ${a.overdue ? 'border-red-600' : 'border-amber-500'} p-4">
    <div class="flex items-start gap-3"><span class="text-xl" aria-hidden="true">🔔</span><div class="flex-1 text-sm"><div class="font-semibold mb-1">Compliance reminders</div>${bits.join('<br>')}
      <div class="flex gap-2 mt-3">${cmpBtn('Open notifications', "document.getElementById('cmpPopup').remove(); go('cm-notify')", 'primary')}${cmpBtn('Later', "document.getElementById('cmpPopup').remove()")}</div></div></div></div>`);
}

/* ---------- a session left alone signs out (SRS 16: session timeout) ---------- */
const CMP_IDLE_MINUTES = 30;
function cmpWatchIdle() {
  CMP.lastActive = Date.now();
  if (!CMP.idleBound) {
    CMP.idleBound = true;
    for (const ev of ['mousemove', 'keydown', 'click', 'touchstart', 'scroll']) document.addEventListener(ev, () => { CMP.lastActive = Date.now(); }, { passive: true });
  }
  clearInterval(CMP.idleTimer);
  CMP.idleTimer = setInterval(() => {
    if (!S.token || S.module !== 'COMPLIANCE') { clearInterval(CMP.idleTimer); return; }
    if (Date.now() - CMP.lastActive > CMP_IDLE_MINUTES * 60000) { clearInterval(CMP.idleTimer); logout(); toast(`Signed out after ${CMP_IDLE_MINUTES} minutes without activity, to keep your clients' details safe.`); }
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
  const purposeFirst = { REMINDER: 'REMINDER', DATA_COLLECTION: 'DATA_COLLECTION', COMPLETION: 'COMPLETION', OTHER: 'OTHER' }[p.kind];
  const sorted = [...templates].sort((a, b) => (b.purpose === purposeFirst) - (a.purpose === purposeFirst) || a.name.localeCompare(b.name));
  const warn = [p.missing.length && `Not known, left as typed: ${p.missing.map(x => `[${esc(x)}]`).join(' ')}`, p.empty.length && `No value for this client (left empty): ${p.empty.map(x => `[${esc(x)}]`).join(' ')}`].filter(Boolean);
  cmpShowModal(`${cmpModalHead(`${CMP_WA_ICON} Send on WhatsApp`, `${cmpCountry(p.client.country).flag} ${esc(p.client.name)} · ${esc(CmpRules.MESSAGE_KINDS[p.kind])}`)}
    <div class="space-y-3">
      <div class="grid sm:grid-cols-2 gap-3">
        <label><span>WhatsApp number</span><input id="cmWaPhone" value="${p.phone ? '+' + esc(p.phone) : ''}" inputmode="tel" placeholder="+971 50 123 4567"></label>
        <label><span>Template</span><select id="cmWaTpl" onchange="cmpWhatsAppTemplate(this.value)"><option value="">— none —</option>
          ${sorted.map(t => `<option value="${t.id}" ${t.id === p.templateId ? 'selected' : ''}>${esc(t.name)} · ${esc(CmpRules.TEMPLATE_PURPOSES[t.purpose])}</option>`).join('')}</select></label>
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
    const p = await api('/api/cmp/messages/prepare', { method: 'POST', body: { ...CMP.wa.what, templateId: id || undefined } });
    $('#cmWaBody').value = p.body;
    CMP.wa.what.templateId = id || null;
  } catch (err) { toast(err.message); }
}
// The firm's WhatsApp numbers to send from (Setup → Settings), the last one used on this computer first
const cmpSenders = () => ((CMP.settings && CMP.settings.waSenders) || []);
function cmpSenderPicker() {
  const list = cmpSenders();
  if (!list.length) return `<p class="text-xs text-slate-500">It goes from the WhatsApp account open on this computer or phone.${cmpCan('FULL') ? ' To choose your business number, add it under Setup → Settings → Your WhatsApp numbers.' : ''}</p>`;
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
// A message about the client that is not a reminder (e.g. asking for documents): pick a template first
async function cmpClientMessage(clientId, occurrenceId, kind = 'DATA_COLLECTION') {
  let t = [];
  try { t = await cmpTemplates(true); } catch (err) { return toast(err.message); }
  const pref = t.find(x => x.purpose === kind) || t[0];
  cmpWhatsApp({ kind, clientId, occurrenceId: occurrenceId || undefined, templateId: pref ? pref.id : undefined }, () => { if (S.page && PAGE_ENTER[S.page]) PAGE_ENTER[S.page](); });
}

/* ---------- reminders, as pills (SRS 6: highlighted, bleak, missed, sent) ---------- */
function cmpReminderPill(r, item, refresh) {
  const tz = item.client.timeZone, when = cmpClientAt(r.fireAt, tz), label = esc(CmpRules.offsetLabel(r.offsetDays));
  const send = (txt, kind = 'wa') => (cmpCan('WHATSAPP') ? `<button type="button" class="needs-write ml-2 px-2 py-1 rounded-md text-xs font-semibold ${kind === 'wa' ? 'bg-[#25D366] text-white' : 'border border-emerald-600 text-emerald-800'}"
    onclick="cmpWhatsApp({ kind: 'REMINDER', occurrenceId: '${item.id}', reminderId: '${r.id}' }, ${refresh})">${txt}</button>` : '');
  const tpl = `<span class="text-slate-500"> · ${esc(r.templateName || 'no template')}</span>`;
  if (r.state === 'HIGHLIGHTED') return `<div class="flex flex-wrap items-center gap-1 rounded-lg bg-amber-100 border border-amber-300 text-amber-900 px-2.5 py-1.5 text-xs"><b>Send now</b> · ${label}${tpl}<span class="text-amber-800"> · since ${when}</span>${send(`${CMP_WA_ICON} WhatsApp`)}</div>`;
  if (r.state === 'MISSED') return `<div class="flex flex-wrap items-center gap-1 rounded-lg border border-amber-400 text-amber-900 px-2.5 py-1.5 text-xs"><b>Not sent</b> · ${label}${tpl}<span class="text-slate-500"> · came due ${when}</span>${send(`${CMP_WA_ICON} WhatsApp`)}</div>`;
  if (r.state === 'SENT') return `<div class="flex flex-wrap items-center gap-1 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-900 px-2.5 py-1.5 text-xs">✓ Sent ${esc(cmpAt(r.sentAt))} · ${label}${tpl}${item.stage === 'COMPLETED' ? '' : send('Send again', 'plain')}</div>`;
  if (r.state === 'CLOSED') return `<div class="rounded-lg bg-slate-50 border text-slate-400 px-2.5 py-1.5 text-xs">${label}${tpl} · closed</div>`;
  return `<div class="rounded-lg bg-slate-50 border border-dashed text-slate-400 px-2.5 py-1.5 text-xs" title="Becomes active when its time comes">${label}${tpl} · activates ${when}</div>`;
}

/* ---------- notifications dashboard (SRS 6, 11) ---------- */
async function cmpEnterNotify() {
  const box = $('#cmNotify');
  if (!box.dataset.ready) {
    box.dataset.ready = '1';
    box.innerHTML = `
      <div id="cmNSummary" class="grid grid-cols-2 md:grid-cols-4 gap-3"></div>
      <div class="bg-white rounded-xl shadow p-4 mt-4">
        <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3 mb-3">
          <label><span>Show</span><select id="cmNShow" onchange="CMP.notify.show = this.value; cmpLoadNotify()">
            <option value="all">Everything in its reminder period</option><option value="overdue">Overdue</option><option value="ready">Ready to send</option><option value="waiting">Waiting</option></select></label>
          <label><span>Country</span><select id="cmNCountry" onchange="CMP.notify.country = this.value; cmpLoadNotify()">${cmpCountryOptions('', 'All countries')}</select></label>
          <label class="col-span-2 sm:flex-1 sm:min-w-[14rem]"><span>Search</span><input id="cmNQ" type="search" placeholder="Client, code or obligation" autocomplete="off"
            oninput="clearTimeout(CMP.searchTimer); CMP.searchTimer = setTimeout(() => { CMP.notify.q = this.value; cmpLoadNotify(); }, 350)"></label>
          <div class="flex items-end">${cmpBtn('Refresh', 'cmpLoadNotify()')}</div>
        </div>
        <p class="text-xs text-slate-500 mb-3">An obligation shows here from the end of its period (or its first reminder) until it is completed. The reminder whose time has come is highlighted with its WhatsApp button; later reminders stay dimmed until their time.</p>
        <div id="cmNList" class="space-y-3"></div>
      </div>`;
  }
  cmpLoadNotify();
}
async function cmpLoadNotify() {
  const n = CMP.notify, qs = new URLSearchParams({ show: n.show, ...(n.country ? { country: n.country } : {}), ...(n.q ? { q: n.q } : {}) });
  let d;
  try { d = await api('/api/cmp/notifications?' + qs); } catch (err) { $('#cmNList').innerHTML = cmpEmpty(esc(err.message)); return; }
  CMP.settings = d.settings || CMP.settings;
  CMP.alerts = { overdue: d.summary.overdue, ready: d.summary.ready, confirm: d.summary.confirm }; cmpBadge();
  const card = (key, label, n, tone, note) => `<button type="button" onclick="${key === 'confirm' ? "cmpOpenObligations('CONFIRM')" : `CMP.notify.show='${key}'; $('#cmNShow').value='${key}'; cmpLoadNotify()`}"
    class="text-left bg-white rounded-xl shadow p-4 border-l-4 ${tone} hover:ring-2 hover:ring-emerald-200"><div class="text-2xl font-semibold">${n}</div><div class="text-sm font-medium">${label}</div><div class="text-xs text-slate-500">${note}</div></button>`;
  $('#cmNSummary').innerHTML = [
    card('overdue', 'Overdue', d.summary.overdue, 'border-red-600', 'past the due date, not completed'),
    card('ready', 'Ready to send', d.summary.ready, 'border-amber-500', 'a reminder has come due'),
    card('waiting', 'Waiting', d.summary.waiting, 'border-slate-300', 'next reminder not due yet'),
    card('confirm', 'Dates to confirm', d.summary.confirm, 'border-sky-500', 'copied from the period before'),
  ].join('');
  $('#cmNList').innerHTML = d.items.length ? d.items.map(cmpNotifyCard).join('') : cmpEmpty('Nothing here. Obligations show up once their period ends (or their first reminder comes due).');
}
function cmpNotifyCard(x) {
  const v = x.view, refresh = 'cmpLoadNotify';
  return `<div class="border rounded-lg border-l-4 ${CMP_BAR[v.colour]} p-3">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <a href="#" onclick="event.preventDefault(); cmpOpenClient('${x.client.id}')" class="font-medium hover:underline">${cmpCountry(x.client.country).flag} ${esc(x.client.name)}</a> <span class="text-xs text-slate-500">${esc(x.client.code)}</span>
        <div class="text-sm"><b>${esc(x.obligation.name)}</b> · ${esc(CmpRules.periodName(x))} · due <b>${cmpDay(x.dueDate)}</b> <span class="text-slate-500">(${esc(CmpCountries.zoneCity(x.client.timeZone))})</span>
          · <span class="${v.overdue ? 'text-red-700 font-medium' : 'text-slate-600'}">${cmpDaysLeft(v)}</span>${x.datesConfirmed ? '' : ' · <span class="text-sky-700">dates to confirm</span>'}</div>
      </div>
      <div class="flex items-center gap-2">${cmpStatusChip(v.status)}</div>
    </div>
    <div class="mt-2 flex flex-col gap-1.5">${v.reminders.length ? v.reminders.map(r => cmpReminderPill(r, x, refresh)).join('') : '<div class="text-xs text-slate-500">No reminders set for this obligation.</div>'}</div>
    <div class="mt-2 flex flex-wrap gap-2">
      ${cmpBtn('Open', `cmpOpenPeriod('${x.obligation.id}', '${x.id}', ${refresh})`)}
      ${cmpCan('WHATSAPP') ? cmpBtn(`${CMP_WA_ICON} Other message`, `cmpClientMessage('${x.client.id}', '${x.id}')`, 'plain', 'needs-write') : ''}
      ${x.obligation.portalUrl ? `<a href="${esc(x.obligation.portalUrl)}" target="_blank" rel="noopener noreferrer" class="px-3 min-h-[2.5rem] inline-flex items-center rounded-lg text-sm border bg-white hover:border-emerald-600">Portal ↗</a>` : ''}
    </div></div>`;
}
const cmpOpenClient = id => { CMP.clientId = id; go('cm-client'); };
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
