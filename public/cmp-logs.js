'use strict';
/* Compliance & Deadlines logs: every WhatsApp message (SRS 8) and the module's activity log (SRS 12), each with filters and a download. */

const CMP_LOG = { msg: { q: '', kind: '', from: '', to: '' }, act: { q: '', action: '', month: '' }, timer: null, msgs: [], acts: [] };
CMP_RESETS.push(() => Object.assign(CMP_LOG, { msg: { q: '', kind: '', from: '', to: '' }, act: { q: '', action: '', month: '' }, msgs: [], acts: [] }));
const cmpQs = o => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v)));

/* ---------- the WhatsApp log ---------- */
CMP_PAGES.push({
  id: 'cm-messages',
  html: () => `<div class="bg-white rounded-xl shadow p-4">
    <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3 mb-3">
      <label class="col-span-2 sm:flex-1 sm:min-w-[12rem]"><span>Search</span><input type="search" placeholder="Client, code, template or text" autocomplete="off"
        oninput="clearTimeout(CMP_LOG.timer); CMP_LOG.timer = setTimeout(() => { CMP_LOG.msg.q = this.value; cmpLoadMessages(); }, 350)"></label>
      <label><span>About</span><select onchange="CMP_LOG.msg.kind = this.value; cmpLoadMessages()"><option value="">Everything</option>${Object.entries(CmpRules.MESSAGE_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label><span>From</span><input type="date" onchange="CMP_LOG.msg.from = this.value; cmpLoadMessages()"></label>
      <label><span>To</span><input type="date" onchange="CMP_LOG.msg.to = this.value; cmpLoadMessages()"></label>
      <div class="flex items-end gap-2">${cmpBtn('Download (Excel)', "cmpDownload('/api/cmp/messages?format=csv&' + cmpQs(CMP_LOG.msg), 'whatsapp-log.csv')")}</div>
    </div>
    <p class="text-xs text-slate-500 mb-3">Every message handed to WhatsApp, with its final text. A message the person did not send after all can be marked "not sent": it stays in the log, and its reminder becomes due again.</p>
    <div id="cmMsgList" class="space-y-2"></div><div id="cmMsgMore" class="mt-3"></div></div>`,
  enter: () => cmpLoadMessages(),
});
async function cmpLoadMessages(more) {
  const qs = cmpQs({ ...CMP_LOG.msg, ...(more && CMP_LOG.msgs.length ? { before: CMP_LOG.msgs[CMP_LOG.msgs.length - 1].createdAt } : {}) });
  let d;
  try { d = await api('/api/cmp/messages?' + qs); } catch (err) { $('#cmMsgList').innerHTML = cmpEmpty(esc(err.message)); return; }
  CMP_LOG.msgs = more ? CMP_LOG.msgs.concat(d.messages) : d.messages;
  $('#cmMsgList').innerHTML = CMP_LOG.msgs.map(m => `<div class="border rounded-lg p-3 ${m.voidedAt ? 'bg-slate-50 opacity-70' : ''}">
    <div class="flex flex-wrap items-start justify-between gap-2 text-sm">
      <div><a href="#" onclick="event.preventDefault(); cmpOpenClient('${m.client.id}')" class="font-medium hover:underline">${cmpCountry(m.client.country).flag} ${esc(m.client.name)}</a> <span class="text-xs text-slate-500">${esc(m.client.code)}</span>
        <div class="text-xs text-slate-500">${esc(cmpAt(m.createdAt))}${m.channel && m.channel !== 'WHATSAPP' ? ` · <span class="px-1.5 rounded bg-amber-100 text-amber-900 font-medium">${esc(CmpRules.CHANNELS[m.channel])}</span>` : ''} · ${esc(CmpRules.MESSAGE_KINDS[m.kind] || m.kind)}${m.obligation ? ` · ${esc(m.obligation.name)} ${esc(CmpRules.periodName(m.obligation))}` : ''}${m.reminder ? ` · ${esc(m.reminder.toLowerCase())}` : ''}${m.templateName ? ` · template “${esc(m.templateName)}”` : ''}${m.phone ? ` · to +${esc(m.phone)}` : ''}${m.fromPhone ? ` · from ${esc(m.fromLabel)} ${esc(m.fromPhone)}` : ''} · by ${esc(m.userEmail)}</div></div>
      ${m.voidedAt ? `<span class="text-xs text-slate-600">Marked not sent ${esc(cmpAt(m.voidedAt))} by ${esc(m.voidedBy || '')}</span>` : cmpCan('WHATSAPP') ? `<button type="button" class="needs-write text-xs underline text-slate-600" onclick="cmpVoidMessage('${m.id}')">Mark not sent</button>` : ''}
    </div>
    <div class="whitespace-pre-wrap text-sm mt-2 ${m.voidedAt ? 'line-through' : ''}">${esc(m.body)}</div></div>`).join('') || cmpEmpty('No messages match.');
  $('#cmMsgMore').innerHTML = d.more ? cmpBtn('Show older messages', 'cmpLoadMessages(true)') : '';
}
async function cmpVoidMessage(id) {
  if (!confirm('Mark this message as not sent? It stays in the log, crossed out; if it was a reminder, that reminder becomes due again.')) return;
  try { await api(`/api/cmp/messages/${id}/void`, { method: 'POST' }); toast('Marked as not sent', true); cmpLoadMessages(); } catch (err) { toast(err.message); }
}

/* ---------- the activity log (only this module's actions of this firm) ---------- */
const CMP_ACTIONS = [['', 'Everything'], ['cmp.client.', 'Clients'], ['cmp.obligation.', 'Obligations'], ['cmp.occurrence.', 'Periods (dates, steps, completion)'], ['cmp.reminder.', 'Reminders'],
  ['cmp.template.', 'Templates'], ['cmp.field.', 'Custom fields'], ['cmp.message.', 'WhatsApp log'], ['cmp.settings.', 'Settings'], ['cmp.log.', 'Downloads']];
CMP_PAGES.push({
  id: 'cm-activity',
  html: () => `<div class="bg-white rounded-xl shadow p-4">
    <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3 mb-3">
      <label class="col-span-2 sm:flex-1 sm:min-w-[12rem]"><span>Search</span><input type="search" placeholder="Words in the entry, or a user's email" autocomplete="off"
        oninput="clearTimeout(CMP_LOG.timer); CMP_LOG.timer = setTimeout(() => { CMP_LOG.act.q = this.value; cmpLoadActivity(); }, 350)"></label>
      <label><span>About</span><select onchange="CMP_LOG.act.action = this.value; cmpLoadActivity()">${CMP_ACTIONS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label><span>Month</span><input type="month" onchange="CMP_LOG.act.month = this.value; cmpLoadActivity()"></label>
      <div class="flex items-end">${cmpBtn('Download (Excel)', "cmpDownload('/api/cmp/activity?format=csv&' + cmpQs(CMP_LOG.act), 'compliance-activity-log.csv')")}</div>
    </div>
    <p class="text-xs text-slate-500 mb-3">Who did what and when in Compliance &amp; Deadlines: clients, obligations and their steps, invoices, reminders, custom fields, archiving and restoring.</p>
    <ul id="cmActList" class="divide-y text-sm"></ul><div id="cmActMore" class="mt-3"></div></div>`,
  enter: () => cmpLoadActivity(),
});
async function cmpLoadActivity(more) {
  const qs = cmpQs({ ...CMP_LOG.act, ...(more && CMP_LOG.acts.length ? { before: CMP_LOG.acts[CMP_LOG.acts.length - 1].createdAt } : {}) });
  let d;
  try { d = await api('/api/cmp/activity?' + qs); } catch (err) { $('#cmActList').innerHTML = `<li>${cmpEmpty(esc(err.message))}</li>`; return; }
  CMP_LOG.acts = more ? CMP_LOG.acts.concat(d.entries) : d.entries;
  $('#cmActList').innerHTML = CMP_LOG.acts.map(a => `<li class="py-2"><div class="text-xs text-slate-500">${esc(cmpAt(a.createdAt))} · ${esc(a.userEmail)}</div><div>${esc(a.summary)}</div></li>`).join('') || `<li>${cmpEmpty('Nothing matches.')}</li>`;
  $('#cmActMore').innerHTML = d.more ? cmpBtn('Show older entries', 'cmpLoadActivity(true)') : '';
}
