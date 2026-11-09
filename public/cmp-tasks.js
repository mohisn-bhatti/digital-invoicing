'use strict';
/* Compliance & Deadlines team work (SRS 10): "My Tasks", the team member pickers, and the bulk actions of the obligations and clients
   lists (next period for several clients of one country, the step, assignment, archive). */

const CMP_SEL = { occ: new Map(), occClient: new Map(), cl: new Set() }; // occurrence id → its obligation id (and its client id); client ids
CMP_RESETS.push(() => { CMP_SEL.occ.clear(); CMP_SEL.occClient.clear(); CMP_SEL.cl.clear(); });

// The firm's team (from /api/cmp/me): a name for an id, and a picker
const cmpWho = id => { if (!id) return ''; const u = ((CMP.me && CMP.me.team) || []).find(x => x.id === id); return u ? (u.name || u.email) : 'someone no longer active'; };
const cmpTeamOptions = (selected, blank = 'Nobody') => `<option value="">${esc(blank)}</option>` + ((CMP.me && CMP.me.team) || []).map(u => `<option value="${u.id}" ${u.id === selected ? 'selected' : ''}>${esc(u.name || u.email)}</option>`).join('');
const cmpTeamFilter = () => `<option value="">Everyone</option><option value="me">Me</option><option value="none">Nobody</option>` + ((CMP.me && CMP.me.team) || []).map(u => `<option value="${u.id}">${esc(u.name || u.email)}</option>`).join('');

/* ---------- My Tasks ---------- */
CMP_PAGES.push({
  id: 'cm-tasks',
  html: () => `<div class="space-y-4"><div class="bg-white rounded-xl shadow p-4">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-2"><h2 class="font-semibold">My obligations</h2>
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="cmTaskDone" onchange="cmpLoadTasks()"> Include completed</label></div>
      <p class="text-xs text-slate-500 mb-3">The open periods of obligations given to you, and of every obligation of the clients given to you (unless the obligation is given to someone else).</p>
      <div id="cmTaskRows" class="space-y-2"></div></div>
    <div class="bg-white rounded-xl shadow p-4"><h2 class="font-semibold mb-2">My clients</h2><div id="cmTaskClients"></div></div></div>`,
  enter: () => cmpLoadTasks(),
});
async function cmpLoadTasks() {
  let d;
  try { d = await api('/api/cmp/my-tasks' + ($('#cmTaskDone').checked ? '?status=ALL' : '')); } catch (err) { $('#cmTaskRows').innerHTML = cmpEmpty(esc(err.message)); return; }
  $('#cmTaskRows').innerHTML = d.rows.map(r => `<button type="button" onclick="cmpOpenPeriod('${r.obligation.id}', '${r.id}', cmpLoadTasks)" class="w-full text-left border rounded-lg border-l-4 ${CMP_BAR[r.view.colour]} p-3 hover:bg-slate-50">
    <div class="flex flex-wrap justify-between gap-2"><span><b>${esc(r.obligation.name)}</b> · ${esc(CmpRules.periodName(r))}</span>${cmpStatusChip(r.view.status)}</div>
    <div class="text-sm">${cmpCountry(r.client.country).flag} ${esc(r.client.name)} <span class="text-xs text-slate-500">${esc(r.client.code)}</span> · due ${cmpDay(r.dueDate)} · <span class="${r.view.overdue ? 'text-red-700 font-medium' : 'text-slate-600'}">${cmpDaysLeft(r.view)}</span>
      ${r.view.actionable ? ' · <span class="text-amber-800 font-medium">a reminder is ready to send</span>' : ''}</div></button>`).join('')
    || cmpEmpty(S.adminSession ? 'The administrator has no tasks of their own here.' : 'Nothing is given to you right now.');
  $('#cmTaskClients').innerHTML = d.clients.length ? `<div class="flex flex-wrap gap-2">${d.clients.map(c => `<button type="button" onclick="cmpOpenClient('${c.id}')" class="border rounded-lg px-3 py-2 text-sm hover:border-emerald-600">${cmpCountry(c.country).flag} ${esc(c.name)}
    ${c.overdueCount ? `<span class="text-red-700 font-semibold"> · ${c.overdueCount} overdue</span>` : ''}</button>`).join('')}</div>` : cmpEmpty('No clients are given to you.');
}

/* ---------- bulk: the obligations list ---------- */
function cmpOccSelect(box, occId, obId, clientId) { if (box.checked) { CMP_SEL.occ.set(occId, obId); CMP_SEL.occClient.set(occId, clientId); } else { CMP_SEL.occ.delete(occId); CMP_SEL.occClient.delete(occId); } cmpOccBar(); }
function cmpOccSelectAll(box) { document.querySelectorAll('#cmObRows input.cmSel').forEach(b => { b.checked = box.checked; cmpOccSelect(b, b.dataset.id, b.dataset.ob, b.dataset.client); }); }
// The sheet narrowed to the clients of the ticked rows (the CA: tick a client to see only that client, for the dates chosen)
function cmpOccOnlyClients() { const ids = [...new Set([...CMP_SEL.occ.keys()].map(k => CMP_SEL.occClient.get(k)).filter(Boolean))]; CMP_SEL.occ.clear(); CMP_SEL.occClient.clear(); cmpObOnly(ids.join(',')); }
function cmpOccBar() {
  const bar = document.getElementById('cmObBulk'); if (!bar) return;
  const n = CMP_SEL.occ.size;
  bar.classList.toggle('hidden', !n);
  if (!n) return;
  const clients = new Set([...CMP_SEL.occ.keys()].map(k => CMP_SEL.occClient.get(k))).size;
  bar.innerHTML = `<span class="text-sm font-medium">${n} selected</span>
    ${cmpBtn(clients === 1 ? 'Only this client' : `Only these ${clients} clients`, 'cmpOccOnlyClients()', 'primary')}
    ${cmpCan('OBLIGATION_EDIT') ? cmpBtn('Next period', 'cmpBulkNext()', 'plain', 'needs-write') : ''}
    ${cmpCan('COMPLETE') ? `<select class="!w-auto !text-sm needs-write" onchange="if (this.value) cmpBulkStage(this.value); this.value = ''"><option value="">Set step…</option>${[['OPEN', 'Open'], ['DATA_COLLECTED', 'Data collected'], ['FILED', 'Filed'], ['PAID', 'Paid']].map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>` : ''}
    ${cmpCan('OBLIGATION_EDIT') ? `<select class="!w-auto !text-sm needs-write" onchange="if (this.value !== '-') cmpBulkAssign('obligationIds', this.value); this.value = '-'"><option value="-">Assign to…</option>${cmpTeamOptions('-', 'Nobody')}</select>` : ''}
    ${cmpCan('ARCHIVE') ? cmpBtn('Archive', "cmpBulkArchive('obligationIds')", 'danger', 'needs-write') : ''}
    <button type="button" class="text-sm underline text-slate-600" onclick="CMP_SEL.occ.clear(); CMP_SEL.occClient.clear(); cmpLoadObligations()">Clear</button>`;
}
const cmpBulkReport = (what, r) => {
  const skipped = r.skipped || [];
  if (!skipped.length) return toast(`${what}: ${Array.isArray(r.done) ? r.done.length : r.done} done`, true);
  cmpShowModal(`${cmpModalHead(what)}<p class="text-sm mb-2">${Array.isArray(r.done) ? r.done.length : r.done} done, ${skipped.length} skipped:</p>
    <ul class="text-sm list-disc pl-5 space-y-1">${skipped.map(s => `<li>${esc(s.name)} — ${esc(s.reason)}</li>`).join('')}</ul><div class="flex justify-end mt-4">${cmpBtn('OK', 'cmpCloseModal()', 'primary')}</div>`);
};
async function cmpBulkNext() {
  const ids = [...new Set(CMP_SEL.occ.values())];
  if (!confirm(`Prepare the next period of ${ids.length} obligation(s)? They must all be for clients of one country. The new periods' dates are copies for you to confirm.`)) return;
  try { const r = await api('/api/cmp/bulk/next-period', { method: 'POST', body: { obligationIds: ids } }); CMP_SEL.occ.clear(); cmpLoadObligations(); cmpBulkReport('Next period', r); } catch (err) { toast(err.message); }
}
async function cmpBulkStage(stage) {
  try { const r = await api('/api/cmp/bulk/stage', { method: 'POST', body: { occurrenceIds: [...CMP_SEL.occ.keys()], stage } }); CMP_SEL.occ.clear(); cmpLoadObligations(); cmpBulkReport('Step', r); } catch (err) { toast(err.message); }
}
async function cmpBulkAssign(kind, userId) {
  const ids = kind === 'clientIds' ? [...CMP_SEL.cl] : [...new Set(CMP_SEL.occ.values())];
  try {
    const r = await api('/api/cmp/bulk/assign', { method: 'POST', body: { [kind]: ids, userId: userId || null } });
    toast(`${r.done} assigned to ${userId ? cmpWho(userId) : 'nobody'}`, true);
    if (kind === 'clientIds') { CMP_SEL.cl.clear(); cmpLoadClients(); } else { CMP_SEL.occ.clear(); cmpLoadObligations(); }
  } catch (err) { toast(err.message); }
}
async function cmpBulkArchive(kind) {
  const ids = kind === 'clientIds' ? [...CMP_SEL.cl] : [...new Set(CMP_SEL.occ.values())];
  if (!confirm(`Archive ${ids.length} ${kind === 'clientIds' ? 'client(s)' : 'obligation(s)'}? They leave the lists, dashboards and reminders, and can be restored.`)) return;
  try {
    const r = await api('/api/cmp/bulk/archive', { method: 'POST', body: { [kind]: ids } });
    toast(`${r.done} archived`, true);
    if (kind === 'clientIds') { CMP_SEL.cl.clear(); cmpLoadClients(); } else { CMP_SEL.occ.clear(); cmpLoadObligations(); }
  } catch (err) { toast(err.message); }
}

/* ---------- bulk: the clients list ---------- */
function cmpClSelect(box, id) { if (box.checked) CMP_SEL.cl.add(id); else CMP_SEL.cl.delete(id); cmpClBar(); }
function cmpClSelectAll(box) { document.querySelectorAll('#cmClRows input.cmSel').forEach(b => { b.checked = box.checked; cmpClSelect(b, b.dataset.id); }); }
function cmpClBar() {
  const bar = document.getElementById('cmClBulk'); if (!bar) return;
  const n = CMP_SEL.cl.size;
  bar.classList.toggle('hidden', !n);
  if (!n) return;
  bar.innerHTML = `<span class="text-sm font-medium">${n} selected</span>
    ${cmpCan('CLIENT_EDIT') ? `<select class="!w-auto !text-sm needs-write" onchange="if (this.value !== '-') cmpBulkAssign('clientIds', this.value); this.value = '-'"><option value="-">Assign to…</option>${cmpTeamOptions('-', 'Nobody')}</select>` : ''}
    ${cmpCan('ARCHIVE') && !CMP_CL.archived ? cmpBtn('Archive', "cmpBulkArchive('clientIds')", 'danger', 'needs-write') : ''}
    <button type="button" class="text-sm underline text-slate-600" onclick="CMP_SEL.cl.clear(); cmpLoadClients()">Clear</button>`;
}
