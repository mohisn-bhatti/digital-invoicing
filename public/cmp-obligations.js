'use strict';
/* Compliance & Deadlines: obligations (SRS 4), their reminders (SRS 5) and their periods. The list shows one row per period with
   filters (SRS 10); a period opens in a window with its dates, its step, its reminders and WhatsApp. */

const CMP_OB = { status: 'OPEN', country: '', q: '', from: '', to: '', assignee: '', archived: false, timer: null, form: null, period: null };
CMP_RESETS.push(() => Object.assign(CMP_OB, { status: 'OPEN', country: '', q: '', from: '', to: '', assignee: '', archived: false, form: null, period: null }));
const cmpObQuery = () => cmpQs({ status: CMP_OB.status, country: CMP_OB.country, q: CMP_OB.q, from: CMP_OB.from, to: CMP_OB.to, assignee: CMP_OB.assignee, archived: CMP_OB.archived ? '1' : '' });

const CMP_OB_STATUSES = [['OPEN', 'Open (not completed)'], ['OVERDUE', 'Overdue'], ['UPCOMING', 'Upcoming'], ['PERIOD_CLOSED', 'Period closed'], ['DATA_COLLECTED', 'Data collected'],
  ['FILED', 'Filed'], ['PAID', 'Paid'], ['COMPLETED', 'Completed'], ['CONFIRM', 'Dates to confirm'], ['ALL', 'Everything']];
function cmpObligationsFilter(over) { Object.assign(CMP_OB, over); const s = document.getElementById('cmObStatus'); if (s) s.value = CMP_OB.status; }

CMP_PAGES.push({
  id: 'cm-obligations',
  html: () => `<div class="bg-white rounded-xl shadow p-4">
    <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3 mb-3">
      <label><span>Status</span><select id="cmObStatus" onchange="CMP_OB.status = this.value; cmpLoadObligations()">${CMP_OB_STATUSES.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label><span>Country</span><select onchange="CMP_OB.country = this.value; cmpLoadObligations()">${cmpCountryOptions('', 'All countries')}</select></label>
      <label><span>Due from</span><input type="date" onchange="CMP_OB.from = this.value; cmpLoadObligations()"></label>
      <label><span>Due to</span><input type="date" onchange="CMP_OB.to = this.value; cmpLoadObligations()"></label>
      <label class="col-span-2 sm:flex-1 sm:min-w-[12rem]"><span>Search</span><input type="search" placeholder="Client, code or obligation" autocomplete="off"
        oninput="clearTimeout(CMP_OB.timer); CMP_OB.timer = setTimeout(() => { CMP_OB.q = this.value; cmpLoadObligations(); }, 350)"></label>
      <label><span>Assigned to</span><select id="cmObWho" onchange="CMP_OB.assignee = this.value; cmpLoadObligations()"></select></label>
      <label class="flex items-center gap-2 text-sm min-h-[2.5rem]"><input type="checkbox" onchange="CMP_OB.archived = this.checked; cmpLoadObligations()"> Archived</label>
      <div class="flex items-end gap-2"><span id="cmObExport"></span>${cmpBtn('Print / PDF', 'cmpPrintTable("Obligations", "cmObTable")')}</div>
    </div>
    <div id="cmObBulk" class="hidden flex flex-wrap items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-2"></div>
    <div id="cmObNote" class="text-xs text-slate-500 mb-2"></div>
    <div id="cmObCards" class="md:hidden space-y-2"></div>
    <div class="hidden md:block overflow-x-auto"><table id="cmObTable" class="w-full text-sm">
      <thead class="text-left text-slate-500 border-b"><tr><th class="py-2 w-8"><input type="checkbox" aria-label="Select all" onchange="cmpOccSelectAll(this)"></th><th></th><th>Due date</th><th>Client</th><th>Obligation</th><th>Period</th><th>Status</th><th>Reminders</th><th>Assigned to</th></tr></thead>
      <tbody id="cmObRows"></tbody></table></div></div>`,
  enter: () => {
    const s = document.getElementById('cmObStatus'); if (s) s.value = CMP_OB.status;
    $('#cmObWho').innerHTML = cmpTeamFilter(); $('#cmObWho').value = CMP_OB.assignee;
    $('#cmObExport').innerHTML = cmpCan('EXPORT') ? cmpBtn('Download (Excel)', "cmpDownload('/api/cmp/export/obligations?' + cmpObQuery(), 'obligations.csv')") : '';
    cmpLoadObligations();
  },
});

async function cmpLoadObligations() {
  let d;
  try { d = await api('/api/cmp/occurrences?' + cmpObQuery()); } catch (err) { $('#cmObRows').innerHTML = `<tr><td colspan="9">${cmpEmpty(esc(err.message))}</td></tr>`; return; }
  for (const id of [...CMP_SEL.occ.keys()]) if (!d.rows.some(r => r.id === id)) CMP_SEL.occ.delete(id); // (what is no longer shown is no longer selected)
  $('#cmObNote').textContent = `${d.rows.length}${d.total > d.rows.length ? ` of ${d.total}` : ''} period${d.total === 1 ? '' : 's'}`;
  const remText = v => {
    const h = v.reminders.find(r => r.state === 'HIGHLIGHTED'), missed = v.reminders.filter(r => r.state === 'MISSED').length, next = v.reminders.find(r => r.state === 'BLEAK');
    if (h) return '<span class="text-amber-800 font-medium">Send now</span>';
    if (missed) return `<span class="text-amber-800">${missed} not sent</span>`;
    if (next) return `<span class="text-slate-500">next ${esc(CmpRules.fmtDay(new Date(next.fireAt).toISOString().slice(0, 10)))}</span>`;
    return v.reminders.length ? '<span class="text-slate-400">all sent</span>' : '<span class="text-slate-400">—</span>';
  };
  const open = r => `cmpOpenPeriod('${r.obligation.id}', '${r.id}', cmpLoadObligations)`;
  $('#cmObRows').innerHTML = d.rows.map(r => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer" onclick="${open(r)}">
    <td class="py-2" onclick="event.stopPropagation()"><input type="checkbox" class="cmSel" data-id="${r.id}" data-ob="${r.obligation.id}" ${CMP_SEL.occ.has(r.id) ? 'checked' : ''} onchange="cmpOccSelect(this, '${r.id}', '${r.obligation.id}')" aria-label="Select"></td>
    <td class="w-5">${cmpDot(r.view.colour)}</td><td class="whitespace-nowrap">${cmpDay(r.dueDate)}<div class="text-xs ${r.view.overdue ? 'text-red-700' : 'text-slate-500'}">${cmpDaysLeft(r.view)}</div></td>
    <td>${cmpCountry(r.client.country).flag} ${esc(r.client.name)} <span class="text-xs text-slate-500">${esc(r.client.code)}</span></td>
    <td>${esc(r.obligation.name)}</td><td class="whitespace-nowrap">${esc(CmpRules.periodName(r))}${r.datesConfirmed ? '' : '<div class="text-xs text-sky-700">dates to confirm</div>'}</td>
    <td>${cmpStatusChip(r.view.status)}</td><td class="text-xs">${remText(r.view)}</td><td class="text-xs">${esc(cmpWho(r.assignedToId))}</td></tr>`).join('')
    || `<tr><td colspan="9">${cmpEmpty('Nothing matches. Obligations are added from a client\'s page.')}</td></tr>`;
  cmpOccBar();
  $('#cmObCards').innerHTML = d.rows.map(r => `<button type="button" onclick="${open(r)}" class="w-full text-left border rounded-lg border-l-4 ${CMP_BAR[r.view.colour]} p-3">
    <div class="flex justify-between gap-2"><span class="font-medium">${esc(r.obligation.name)}</span>${cmpStatusChip(r.view.status)}</div>
    <div class="text-sm">${cmpCountry(r.client.country).flag} ${esc(r.client.name)}</div>
    <div class="text-xs text-slate-600">${esc(CmpRules.periodName(r))} · due ${cmpDay(r.dueDate)} · ${cmpDaysLeft(r.view)} · ${remText(r.view)}</div></button>`).join('') || cmpEmpty('Nothing matches.');
}

/* ---------- add or edit an obligation ---------- */
async function cmpObligationForm(clientId, obligationId) {
  let client, ob = null, templates = [], suggestions = [];
  try {
    client = (await api(`/api/cmp/clients/${clientId}`)).client;
    templates = await cmpTemplates(true);
    if (obligationId) ob = await api(`/api/cmp/obligations/${obligationId}`);
    else suggestions = await api('/api/cmp/suggest/obligations?country=' + client.country);
  } catch (err) { return toast(err.message); }
  CMP_OB.form = { clientId, obligationId: obligationId || null, suggestions, templates, client };
  const country = cmpCountry(client.country);
  const years = ob ? ob.yearsTotal : null;
  const yearOpts = [['', 'No end'], ['1', '1 year'], ['2', '2 years'], ['3', '3 years'], ['5', '5 years'], ['10', '10 years']];
  const custom = years && !yearOpts.some(([v]) => v === String(years));
  cmpShowModal(`${cmpModalHead(ob ? `Edit ${esc(ob.name)}` : 'Add an obligation', `${country.flag} ${esc(client.name)} · ${esc(client.code)}`)}
    <form id="cmObForm" onsubmit="event.preventDefault(); cmpObligationSave()" class="space-y-4">
      ${!ob && suggestions.length ? `<label><span>Start from what other ${esc(country.name)} clients have <span class="text-slate-400">(optional)</span></span>
        <select onchange="cmpObligationSuggest(this.value)"><option value="">—</option>${suggestions.map((s, i) => `<option value="${i}">${esc(s.name)} · ${esc(CmpRules.repeatsLabel(s.frequency, s.yearsTotal).toLowerCase())} · due ${esc(cmpDay(s.dueDate))} (${s.clients} client${s.clients === 1 ? '' : 's'})</option>`).join('')}</select></label>` : ''}
      <div class="grid sm:grid-cols-3 gap-3">
        <label class="sm:col-span-3"><span>Obligation *</span><input name="name" required maxlength="120" placeholder="e.g. VAT Return, Corporate Tax, Trade License renewal" value="${ob ? esc(ob.name) : ''}"></label>
        <label><span>Comes back</span><select name="frequency" ${ob ? 'disabled' : ''}>${Object.entries(CmpRules.FREQUENCIES).map(([k, f]) => `<option value="${k}" ${(ob ? ob.frequency : 'YEARLY') === k ? 'selected' : ''}>${f.label}</option>`).join('')}</select></label>
        <label><span>For</span><select name="yearsSel" onchange="$('#cmYearsWrap').classList.toggle('hidden', this.value !== 'custom')">
          ${yearOpts.map(([v, l]) => `<option value="${v}" ${String(years || '') === v ? 'selected' : ''}>${l}</option>`).join('')}<option value="custom" ${custom ? 'selected' : ''}>Another number of years…</option></select></label>
        <label id="cmYearsWrap" class="${custom ? '' : 'hidden'}"><span>Years</span><input name="yearsCustom" type="number" min="1" max="100" value="${custom ? years : ''}"></label>
      </div>
      ${ob ? `<p class="text-xs text-slate-500">Dates are changed period by period: open a period to change its dates (and, if you like, the periods after it). How often it comes back is fixed once added.</p>` : `
      <div class="grid sm:grid-cols-3 gap-3">
        <label><span>Period start *</span><input name="periodStart" type="date" required></label>
        <label><span>Period end *</span><input name="periodEnd" type="date" required></label>
        <label><span>Due date * <span class="text-slate-400">(${esc(CmpCountries.zoneCity(client.timeZone))})</span></span><input name="dueDate" type="date" required></label>
      </div>
      <p class="text-xs text-slate-500">Typed by you: nothing is calculated. The next period is proposed with the same dates one period on, and waits for you to confirm it.</p>`}
      <div class="grid sm:grid-cols-3 gap-3">
        <label class="sm:col-span-2"><span>Portal link <span class="text-slate-400">(optional — opens the e-filing portal)</span></span><input name="portalUrl" type="url" maxlength="500" placeholder="https://" value="${ob ? esc(ob.portalUrl) : ''}"></label>
        <label><span>Assigned to <span class="text-slate-400">(else the client's person)</span></span><select name="assignedToId">${cmpTeamOptions(ob ? ob.assignedToId : '', 'Nobody')}</select></label>
      </div>
      <div><div class="flex items-center justify-between mb-2"><h3 class="text-sm font-medium">Reminders <span class="text-slate-400 font-normal">— every period, each with its message template</span></h3>
        <button type="button" class="text-sm text-emerald-700 underline" onclick="cmpReminderRow()">+ Add reminder</button></div>
        ${templates.length ? '' : `<p class="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-2">There are no message templates yet. ${cmpCan('SETUP') ? '<a href="#/cm-templates" onclick="cmpCloseModal()" class="underline">Add one</a> first.' : 'Ask someone who manages templates to add one.'}</p>`}
        <div id="cmRemRows" class="space-y-2"></div></div>
      <label><span>Notes</span><textarea name="notes" rows="2" maxlength="1000">${ob ? esc(ob.notes) : ''}</textarea></label>
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseModal()')}<button class="px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">${ob ? 'Save changes' : 'Add obligation'}</button></div>
    </form>`);
  (ob ? ob.reminders : []).sort((a, b) => a.offsetDays - b.offsetDays).forEach(r => cmpReminderRow(r));
}
function cmpReminderRow(r = { offsetDays: -7, templateId: '' }) {
  const t = CMP_OB.form.templates, when = r.offsetDays < 0 ? 'before' : r.offsetDays > 0 ? 'after' : 'on';
  const pref = r.templateId || (t.find(x => x.purpose === 'REMINDER') || t[0] || {}).id || '';
  $('#cmRemRows').insertAdjacentHTML('beforeend', `<div class="cmRem flex flex-wrap items-end gap-2 bg-slate-50 border rounded-lg p-2">
    <label class="w-20"><span>Days</span><input type="number" min="0" max="366" value="${Math.abs(r.offsetDays)}" class="remDays"></label>
    <label class="w-44"><span>When</span><select class="remWhen" onchange="this.closest('.cmRem').querySelector('.remDays').disabled = this.value === 'on'">
      <option value="before" ${when === 'before' ? 'selected' : ''}>days before the due date</option><option value="on" ${when === 'on' ? 'selected' : ''}>on the due date</option><option value="after" ${when === 'after' ? 'selected' : ''}>days after the due date</option></select></label>
    <label class="flex-1 min-w-[12rem]"><span>Template</span><select class="remTpl">${t.map(x => `<option value="${x.id}" ${x.id === pref ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
      ${r.templateId && !t.some(x => x.id === r.templateId) ? `<option value="${r.templateId}" selected>${esc(r.templateName || 'retired template')}</option>` : ''}</select></label>
    <button type="button" class="px-3 min-h-[2.5rem] text-red-600" onclick="this.closest('.cmRem').remove()" aria-label="Remove reminder">✕</button></div>`);
  const row = $('#cmRemRows').lastElementChild; row.querySelector('.remDays').disabled = when === 'on';
}
function cmpObligationSuggest(i) {
  const s = CMP_OB.form.suggestions[Number(i)]; if (!s) return;
  const f = $('#cmObForm');
  f.name.value = s.name; f.frequency.value = s.frequency || 'YEARLY'; f.portalUrl.value = s.portalUrl || '';
  f.periodStart.value = s.periodStart; f.periodEnd.value = s.periodEnd; f.dueDate.value = s.dueDate;
  f.yearsSel.value = s.yearsTotal ? (['1', '2', '3', '5', '10'].includes(String(s.yearsTotal)) ? String(s.yearsTotal) : 'custom') : '';
  $('#cmYearsWrap').classList.toggle('hidden', f.yearsSel.value !== 'custom');
  if (f.yearsSel.value === 'custom') f.yearsCustom.value = s.yearsTotal;
  $('#cmRemRows').innerHTML = ''; s.reminders.forEach(r => cmpReminderRow(r));
  toast('Filled in from another client of this country: check the dates.', true);
}
async function cmpObligationSave() {
  const f = $('#cmObForm'), form = CMP_OB.form;
  const yearsTotal = f.yearsSel.value === 'custom' ? Number(f.yearsCustom.value) || null : f.yearsSel.value ? Number(f.yearsSel.value) : null;
  const reminders = [...document.querySelectorAll('#cmRemRows .cmRem')].map(row => {
    const n = Number(row.querySelector('.remDays').value) || 0, when = row.querySelector('.remWhen').value;
    return { offsetDays: when === 'on' ? 0 : when === 'before' ? -n : n, templateId: row.querySelector('.remTpl').value };
  });
  const body = { name: f.name.value, portalUrl: f.portalUrl.value, notes: f.notes.value, yearsTotal, assignedToId: f.assignedToId.value || null };
  try {
    let ob;
    if (form.obligationId) {
      await api(`/api/cmp/obligations/${form.obligationId}`, { method: 'PUT', body });
      ob = await api(`/api/cmp/obligations/${form.obligationId}/reminders`, { method: 'PUT', body: { reminders } });
    } else {
      ob = await api(`/api/cmp/clients/${form.clientId}/obligations`, { method: 'POST', body: { ...body, frequency: f.frequency.value, periodStart: f.periodStart.value, periodEnd: f.periodEnd.value, dueDate: f.dueDate.value, reminders } });
    }
    cmpCloseModal(); toast(form.obligationId ? 'Obligation saved' : `${ob.name} added${ob.occurrences.length > 1 ? ' (next period prepared too: its period is already over)' : ''}`, true);
    if (S.page === 'cm-client') cmpLoadClient(); else cmpOpenClient(form.clientId);
  } catch (err) { toast(err.message); }
}
async function cmpNextPeriod(id) {
  try { await api(`/api/cmp/obligations/${id}/next`, { method: 'POST' }); toast('Next period added: check its dates', true); if (S.page === 'cm-client') cmpLoadClient(); }
  catch (err) { toast(err.message); }
}
async function cmpObligationArchive(id, archive) {
  if (archive && !confirm('Archive this obligation? Its periods leave the lists, dashboards and reminders. It can be restored from the client\'s page.')) return;
  try { await api(`/api/cmp/obligations/${id}/${archive ? 'archive' : 'restore'}`, { method: 'POST' }); toast(archive ? 'Obligation archived' : 'Obligation restored', true); if (S.page === 'cm-client') cmpLoadClient(); }
  catch (err) { toast(err.message); }
}

/* ---------- one period: dates, step, completion, reminders ---------- */
async function cmpOpenPeriod(obligationId, occurrenceId, refresh) {
  let ob;
  try { ob = await api(`/api/cmp/obligations/${obligationId}`); } catch (err) { return toast(err.message); }
  const p = ob.occurrences.find(x => x.id === occurrenceId);
  if (!p) return toast('That period is not there any more. Reload the page.');
  CMP_OB.period = { ob, p, refresh };
  const v = p.view, done = p.stage === 'COMPLETED', live = !ob.archivedAt && !ob.client.archivedAt, item = { ...p, client: ob.client };
  const editDates = live && cmpCan('OBLIGATION_EDIT'), steps = live && cmpCan('COMPLETE');
  cmpShowModal(`${cmpModalHead(`${esc(ob.name)} · ${esc(CmpRules.periodName(p))}`, `${cmpCountry(ob.client.country).flag} ${esc(ob.client.name)} · ${esc(ob.client.code)} · ${esc(CmpRules.repeatsLabel(ob.frequency, ob.yearsTotal))}`)}
    <div class="space-y-4">
      <div class="flex flex-wrap items-center gap-3 rounded-lg border-l-4 ${CMP_BAR[v.colour]} bg-slate-50 px-3 py-2">${cmpStatusChip(v.status)}
        <span class="text-sm">Due <b>${cmpDay(p.dueDate)}</b> (${esc(CmpCountries.zoneCity(ob.client.timeZone))})${cmpDaysLeft(v) ? ` · <span class="${v.overdue ? 'text-red-700 font-medium' : ''}">${cmpDaysLeft(v)}</span>` : ''}</span>
        ${done ? `<span class="text-xs text-slate-500">Completed ${esc(cmpAt(p.closedAt))} by ${esc(p.closedBy || '')}</span>` : ''}</div>
      <section><h3 class="text-sm font-medium mb-2">Dates ${p.datesConfirmed ? '' : '<span class="text-sky-700 font-normal">— copied from the period before: check and confirm them</span>'}</h3>
        <div class="grid sm:grid-cols-3 gap-3">
          <label><span>Period start</span><input id="cpStart" type="date" value="${p.periodStart}" ${editDates ? '' : 'disabled'}></label>
          <label><span>Period end</span><input id="cpEnd" type="date" value="${p.periodEnd}" ${editDates ? '' : 'disabled'}></label>
          <label><span>Due date</span><input id="cpDue" type="date" value="${p.dueDate}" ${editDates ? '' : 'disabled'}></label>
        </div>
        ${editDates ? `<div class="flex flex-wrap items-center gap-3 mt-2">
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="cpFuture"> Also use these dates for the periods after this one</label>
          <div class="flex gap-2 ml-auto">${p.datesConfirmed ? '' : cmpBtn('Dates are right', 'cmpPeriodConfirm()', 'plain', 'needs-write')}${cmpBtn('Save dates', 'cmpPeriodDates()', 'primary', 'needs-write')}</div></div>` : ''}
      </section>
      ${steps ? `<section><h3 class="text-sm font-medium mb-2">Step</h3><div class="flex flex-wrap items-end gap-2">
        ${done ? cmpBtn('Reopen', 'cmpPeriodReopen()', 'plain', 'needs-write') : `<label class="w-52"><span class="sr-only">Step</span><select id="cpStage" class="needs-write" onchange="cmpPeriodStage(this.value)">
          ${[['OPEN', 'Open'], ['DATA_COLLECTED', 'Data collected'], ['FILED', 'Filed'], ['PAID', 'Paid']].map(([k, l]) => `<option value="${k}" ${p.stage === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          ${cmpBtn('✓ Complete', 'cmpPeriodComplete()', 'primary', 'needs-write')}`}</div>
        <p class="text-xs text-slate-500 mt-1">Upcoming, Period closed and Overdue follow from the dates. It stays overdue until it is completed.</p></section>` : ''}
      <section><h3 class="text-sm font-medium mb-2">Reminders</h3><div class="flex flex-col gap-1.5">${v.reminders.length ? v.reminders.map(r => cmpReminderPill(r, item, 'cmpPeriodRefresh')).join('') : '<p class="text-sm text-slate-500">No reminders. Add them with Edit obligation.</p>'}</div></section>
      ${editDates ? `<label><span>Notes for this period</span><textarea id="cpNotes" rows="2" maxlength="1000" onchange="cmpPeriodNotes(this.value)">${esc(p.notes)}</textarea></label>` : (p.notes ? `<p class="text-sm whitespace-pre-wrap">${esc(p.notes)}</p>` : '')}
      <div class="flex flex-wrap justify-between gap-2 pt-2 border-t">
        <div class="flex flex-wrap gap-2">
          ${ob.portalUrl ? `<a href="${esc(ob.portalUrl)}" target="_blank" rel="noopener noreferrer" class="px-3 min-h-[2.5rem] inline-flex items-center rounded-lg text-sm border bg-white hover:border-emerald-600">Open portal ↗</a>` : ''}
          ${live && cmpCan('WHATSAPP') ? cmpBtn(`${CMP_WA_ICON} Other message`, `cmpClientMessage('${ob.client.id}', '${p.id}')`, 'plain', 'needs-write') : ''}
          ${live && cmpCan('OBLIGATION_EDIT') ? cmpBtn('Edit obligation', `cmpObligationForm('${ob.client.id}', '${ob.id}')`, 'plain', 'needs-write') : ''}
        </div>${cmpBtn('Close', 'cmpCloseModal()')}</div>
    </div>`);
}
async function cmpPeriodRefresh() {
  const c = CMP_OB.period; if (!c) return;
  if (c.refresh) c.refresh();
  if (!document.getElementById('cmpModal').classList.contains('hidden')) cmpOpenPeriod(c.ob.id, c.p.id, c.refresh);
}
// reopen = false: the caller shows its own window next (e.g. "Completed ✓"), so the period is not drawn again over it
async function cmpPeriodCall(url, body, msg, { reopen = true } = {}) {
  const c = CMP_OB.period;
  try {
    const ob = await api(url, { method: url.endsWith(c.p.id) ? 'PUT' : 'POST', body });
    if (msg) toast(msg, true);
    if (c.refresh) c.refresh();
    if (reopen && ob.occurrences.some(x => x.id === c.p.id)) await cmpOpenPeriod(ob.id, c.p.id, c.refresh);
    return ob;
  } catch (err) { toast(err.message); return null; }
}
const cmpPeriodDates = () => cmpPeriodCall(`/api/cmp/occurrences/${CMP_OB.period.p.id}`, { periodStart: $('#cpStart').value, periodEnd: $('#cpEnd').value, dueDate: $('#cpDue').value, applyFuture: $('#cpFuture').checked }, 'Dates saved');
const cmpPeriodConfirm = () => cmpPeriodCall(`/api/cmp/occurrences/${CMP_OB.period.p.id}`, { confirm: true }, 'Dates confirmed');
const cmpPeriodNotes = notes => cmpPeriodCall(`/api/cmp/occurrences/${CMP_OB.period.p.id}`, { notes }, 'Notes saved');
const cmpPeriodStage = stage => cmpPeriodCall(`/api/cmp/occurrences/${CMP_OB.period.p.id}/stage`, { stage }, 'Step saved');
const cmpPeriodReopen = () => cmpPeriodCall(`/api/cmp/occurrences/${CMP_OB.period.p.id}/reopen`, null, 'Reopened');
// SRS 9: completing offers two ways: "Generate invoice" (a draft for this period opens) or "Close without invoice" (free work for family,
// friends, goodwill). SRS 8: then a WhatsApp message to the client from any template.
function cmpPeriodComplete() {
  const c = CMP_OB.period;
  cmpShowModal(`${cmpModalHead('Complete this period', `${esc(c.ob.name)} · ${esc(CmpRules.periodName(c.p))} · ${esc(c.ob.client.name)}`)}
    <div class="grid sm:grid-cols-2 gap-3">
      ${cmpCan('INVOICE') ? `<button type="button" onclick="cmpPeriodCompleteGo('INVOICE')" class="needs-write text-left border-2 rounded-xl p-4 hover:border-emerald-600"><div class="font-semibold">Generate invoice</div>
        <div class="text-sm text-slate-600 mt-1">Completes it and opens an invoice with the client's details and this period filled in. You type the fee.</div></button>` : ''}
      <button type="button" onclick="cmpPeriodCompleteGo('FREE')" class="needs-write text-left border-2 rounded-xl p-4 hover:border-emerald-600"><div class="font-semibold">Close without invoice</div>
        <div class="text-sm text-slate-600 mt-1">Completes it with no invoice, e.g. free work for family, friends or goodwill.</div></button>
    </div>
    <div class="flex justify-end mt-4">${cmpBtn('Back', `cmpOpenPeriod('${c.ob.id}', '${c.p.id}', CMP_OB.period.refresh)`)}</div>`);
}
async function cmpPeriodCompleteGo(mode) {
  const c = CMP_OB.period;
  const ob = await cmpPeriodCall(`/api/cmp/occurrences/${c.p.id}/complete`, { mode }, null, { reopen: false });
  if (!ob) return;
  if (ob.invoiceId) { toast('Completed. Enter the fee on the invoice.', true); return cmpInvoiceEdit(ob.invoiceId, c.refresh); }
  const next = ob.occurrences.find(x => x.seq === c.p.seq + 1);
  cmpShowModal(`${cmpModalHead('Completed ✓', `${esc(c.ob.name)} · ${esc(CmpRules.periodName(c.p))} · ${esc(c.ob.client.name)}`)}
    <div class="space-y-3 text-sm">
      ${next ? `<p>The next period (${esc(CmpRules.periodName(next))}, due ${esc(cmpDay(next.dueDate))}) is ready${next.datesConfirmed ? '' : ': check its dates when you can'}.</p>` : ''}
      ${cmpCan('WHATSAPP') ? '<p>Let the client know on WhatsApp?</p>' : ''}
      <div class="flex flex-wrap justify-end gap-2">${cmpBtn('Not now', 'cmpCloseModal()')}${cmpCan('WHATSAPP') ? cmpBtn(`${CMP_WA_ICON} Send a message`, `cmpClientMessage('${c.ob.client.id}', '${c.p.id}', 'COMPLETION')`, 'wa', 'needs-write') : ''}</div>
    </div>`);
}
