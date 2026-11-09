'use strict';
/* Compliance & Deadlines: obligations (SRS 4), their reminders (SRS 5) and their periods.
   "My Obligations" is the main sheet (the CA, 9 Nov 2026): one row per period of the dates chosen (the calendar year by default,
   with the periods still to come shown as Planned), sorted by due date and then by client, with every action on the row itself
   (send the reminder, the step, close, the invoice, the receipt). A period opens in a window only to change its dates.
   An obligation is added with its three dates; how often it comes back follows from them, for as many years as said (or unlimited). */

const CMP_OB = { status: 'ALL', country: '', clientId: '', q: '', assignee: '', archived: false, timer: null, form: null, period: null, clients: null };
CMP_RESETS.push(() => Object.assign(CMP_OB, { status: 'ALL', country: '', clientId: '', q: '', assignee: '', archived: false, form: null, period: null, clients: null }));
const cmpObQuery = () => cmpQs({ status: CMP_OB.status, country: CMP_OB.country, clientId: CMP_OB.clientId, q: CMP_OB.q, assignee: CMP_OB.assignee, archived: CMP_OB.archived ? '1' : '', ...cmpRangeDates('ob') });

const CMP_OB_STATUSES = [['ALL', 'Everything'], ['OPEN', 'Open (not completed)'], ['OVERDUE', 'Overdue'], ['UPCOMING', 'Upcoming'], ['PERIOD_CLOSED', 'Period closed'], ['DATA_COLLECTED', 'Data collected'],
  ['FILED', 'Filed'], ['PAID', 'Paid'], ['COMPLETED', 'Completed'], ['CONFIRM', 'Dates to confirm'], ['PLANNED', 'Planned (still to come)']];
const CMP_STEPS = [['OPEN', 'Open'], ['DATA_COLLECTED', 'Data collected'], ['FILED', 'Filed'], ['PAID', 'Paid']];
// From the dashboard or the notifications: a status over all dates (an overdue period of last year is still overdue)
function cmpObligationsFilter(over) {
  Object.assign(CMP_OB, over);
  if (over.status) { cmpRange('ob'); CMP.ranges.ob.r = { ...CMP.ranges.ob.r, mode: 'all' }; }
  const s = document.getElementById('cmObStatus'); if (s) s.value = CMP_OB.status;
}

CMP_PAGES.push({
  id: 'cm-obligations',
  html: () => `<div class="bg-white rounded-xl shadow p-4">
    <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3 mb-3">
      <div id="cmObRange" class="contents"></div>
      <label><span>Status</span><select id="cmObStatus" onchange="CMP_OB.status = this.value; cmpLoadObligations()">${CMP_OB_STATUSES.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <label><span>Client</span><select id="cmObClient" onchange="CMP_OB.clientId = this.value; cmpLoadObligations()"></select></label>
      <label><span>Country</span><select onchange="CMP_OB.country = this.value; cmpLoadObligations()">${cmpCountryOptions('', 'All countries')}</select></label>
      <label class="col-span-2 sm:flex-1 sm:min-w-[12rem]"><span>Search</span><input type="search" placeholder="Client, code or obligation" autocomplete="off"
        oninput="clearTimeout(CMP_OB.timer); CMP_OB.timer = setTimeout(() => { CMP_OB.q = this.value; cmpLoadObligations(); }, 350)"></label>
      <label><span>Assigned to</span><select id="cmObWho" onchange="CMP_OB.assignee = this.value; cmpLoadObligations()"></select></label>
      <label class="flex items-center gap-2 text-sm min-h-[2.5rem]"><input type="checkbox" onchange="CMP_OB.archived = this.checked; cmpLoadObligations()"> Archived</label>
      <div class="flex items-end gap-2"><span id="cmObExport"></span>${cmpBtn('Print / PDF', 'cmpPrintTable("My Obligations — " + cmpRangeText("ob"), "cmObTable")')}</div>
    </div>
    <div id="cmObBulk" class="hidden flex flex-wrap items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-2"></div>
    <div id="cmObNote" class="text-xs text-slate-500 mb-2"></div>
    <div id="cmObCards" class="md:hidden space-y-2"></div>
    <div class="hidden md:block overflow-x-auto"><table id="cmObTable" class="w-full text-sm">
      <thead class="text-left text-slate-500 border-b"><tr><th class="py-2 w-8"><input type="checkbox" aria-label="Select all" onchange="cmpOccSelectAll(this)"></th><th></th><th>Due date</th><th>Client</th><th>Obligation</th><th>Period</th><th>Status</th><th>Reminders</th><th>Actions</th><th>Assigned to</th></tr></thead>
      <tbody id="cmObRows"></tbody></table></div></div>`,
  enter: async () => {
    const s = document.getElementById('cmObStatus'); if (s) s.value = CMP_OB.status;
    $('#cmObRange').innerHTML = cmpRangeBar('ob', cmpLoadObligations);
    $('#cmObWho').innerHTML = cmpTeamFilter(); $('#cmObWho').value = CMP_OB.assignee;
    $('#cmObExport').innerHTML = cmpCan('EXPORT') ? cmpBtn('Download (Excel)', "cmpDownload('/api/cmp/export/obligations?' + cmpObQuery(), 'obligations.csv')") : '';
    await cmpObClients();
    cmpLoadObligations();
  },
});
// The client picker of the sheet (filled once; a client added later appears on the next visit)
async function cmpObClients() {
  if (!CMP_OB.clients) { try { CMP_OB.clients = (await api('/api/cmp/clients')).clients; } catch { CMP_OB.clients = []; } }
  const sel = document.getElementById('cmObClient'); if (!sel) return;
  sel.innerHTML = '<option value="">All clients</option>' + CMP_OB.clients.map(c => `<option value="${c.id}">${cmpCountry(c.country).flag} ${esc(c.name)} (${esc(c.code)})</option>`).join('');
  if (CMP_OB.clientId && !CMP_OB.clients.some(c => c.id === CMP_OB.clientId)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(CMP_OB.clientId)}">(${CMP_OB.clientId.split(',').length} clients ticked)</option>`);
  sel.value = CMP_OB.clientId;
}
// The sheet for one client (the CA: tick a client to see only that client, for the dates chosen)
function cmpObOnly(clientId) { CMP_OB.clientId = clientId; CMP_SEL.occ.clear(); cmpObClients(); cmpLoadObligations(); }

const cmpRemText = v => {
  const h = v.reminders.find(r => r.state === 'HIGHLIGHTED'), missed = v.reminders.filter(r => r.state === 'MISSED').length, next = v.reminders.find(r => r.state === 'BLEAK');
  if (h) return '<span class="text-amber-800 font-medium">Send now</span>';
  if (missed) return `<span class="text-amber-800">${missed} not sent</span>`;
  if (next) return `<span class="text-slate-500">next ${esc(CmpRules.fmtDay(new Date(next.fireAt).toISOString().slice(0, 10)))}</span>`;
  return v.reminders.length ? '<span class="text-slate-400">all sent</span>' : '<span class="text-slate-400">—</span>';
};
const CMP_PLANNED_CHIP = '<span class="px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap border border-dashed border-slate-400 text-slate-500">Planned</span>';
const cmpOccChip = r => (r.projected ? CMP_PLANNED_CHIP : cmpStatusChip(r.view.status));
const cmpOccDot = r => (r.projected ? '<span class="inline-block w-2.5 h-2.5 rounded-full border border-dashed border-slate-400" title="Planned"></span>' : cmpDot(r.view.colour));

// Everything that can be done to a period, on its row (the CA: the client's window only to change something)
function cmpRowActions(r, refresh) {
  if (r.projected) return cmpCan('OBLIGATION_EDIT') ? `<button type="button" class="needs-write text-xs text-emerald-700 underline" onclick="event.stopPropagation(); cmpOpenPeriod('${r.obligation.id}', '${r.id}', ${refresh})">Prepare…</button>` : '';
  const live = !r.obligation.archivedAt && !r.client.archivedAt, out = [], small = 'px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap';
  const h = r.view.reminders.find(x => x.state === 'HIGHLIGHTED') || r.view.reminders.find(x => x.state === 'MISSED');
  if (live && h && cmpCan('WHATSAPP') && !r.client.noWhatsApp) out.push(`<button type="button" class="needs-write ${small} bg-[#25D366] text-white" title="${esc(CmpRules.offsetLabel(h.offsetDays))} · ${esc(h.templateName || '')}"
    onclick="event.stopPropagation(); cmpWhatsApp({ kind: 'REMINDER', occurrenceId: '${r.id}', reminderId: '${h.id}' }, ${refresh})">${CMP_WA_ICON} Reminder</button>`);
  if (live && r.stage !== 'COMPLETED' && cmpCan('COMPLETE')) {
    out.push(`<select class="needs-write !w-auto !text-xs !py-1 !min-h-0" aria-label="Step" onclick="event.stopPropagation()" onchange="cmpRowStage('${r.id}', this.value, ${refresh})">${CMP_STEPS.map(([k, l]) => `<option value="${k}" ${r.stage === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`);
    out.push(`<button type="button" class="needs-write ${small} bg-emerald-700 text-white" onclick="event.stopPropagation(); cmpRowComplete('${r.obligation.id}', '${r.id}', ${refresh})">✓ Close</button>`);
  }
  if (r.invoice && cmpCan('INVOICE')) {
    out.push(`<button type="button" class="${small} border bg-white hover:border-emerald-600" onclick="event.stopPropagation(); cmpInvoiceOpen('${r.invoice.id}', ${refresh})">${r.invoice.number ? esc(r.invoice.number) : 'Draft invoice'} ${cmpInvChip(r.invoice.status)}</button>`);
    if (['ISSUED', 'SENT', 'PARTIAL'].includes(r.invoice.status)) out.push(`<button type="button" class="needs-write ${small} border border-emerald-600 text-emerald-800" onclick="event.stopPropagation(); cmpQuickReceipt('${r.invoice.id}', ${refresh})">+ Receipt</button>`);
  } else if (r.stage === 'COMPLETED' && r.closeKind === 'FREE') out.push('<span class="text-xs text-slate-500">closed, no invoice</span>');
  else if (live && r.stage === 'COMPLETED' && cmpCan('INVOICE')) out.push(`<button type="button" class="needs-write ${small} border bg-white hover:border-emerald-600" onclick="event.stopPropagation(); cmpInvoiceDraft({ occurrenceId: '${r.id}' })">+ Invoice</button>`);
  return `<div class="flex flex-wrap items-center gap-1">${out.join('')}</div>`;
}
async function cmpRowStage(occId, stage, refresh) {
  try { await api(`/api/cmp/occurrences/${occId}/stage`, { method: 'POST', body: { stage } }); toast('Step saved', true); if (refresh) refresh(); } catch (err) { toast(err.message); if (refresh) refresh(); }
}
async function cmpRowComplete(obId, occId, refresh) {
  let ob;
  try { ob = await api(`/api/cmp/obligations/${obId}`); } catch (err) { return toast(err.message); }
  const p = ob.occurrences.find(x => x.id === occId);
  if (!p) return toast('That period is not there any more. Reload the page.');
  CMP_OB.period = { ob, p, refresh };
  cmpPeriodComplete();
}

async function cmpLoadObligations() {
  let d;
  try { d = await api('/api/cmp/occurrences?' + cmpObQuery() + '&projected=1'); } catch (err) { $('#cmObRows').innerHTML = `<tr><td colspan="10">${cmpEmpty(esc(err.message))}</td></tr>`; return; }
  for (const id of [...CMP_SEL.occ.keys()]) if (!d.rows.some(r => r.id === id)) CMP_SEL.occ.delete(id); // (what is no longer shown is no longer selected)
  const real = d.total - (d.planned || 0);
  $('#cmObNote').innerHTML = `${esc(cmpRangeText('ob'))} · ${real} period${real === 1 ? '' : 's'}${d.planned ? ` and ${d.planned} planned (still to come)` : ''}${d.total > d.rows.length ? ` · first ${d.rows.length} shown` : ''} · by due date, then client`
    + (CMP_OB.clientId ? ` · <button type="button" class="underline text-emerald-700" onclick="cmpObOnly('')">show all clients</button>` : '');
  const open = r => `cmpOpenPeriod('${r.obligation.id}', '${r.id}', cmpLoadObligations)`;
  $('#cmObRows').innerHTML = d.rows.map(r => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer align-top ${r.projected ? 'text-slate-500' : ''}" onclick="${open(r)}">
    <td class="py-2" onclick="event.stopPropagation()">${r.projected ? '' : `<input type="checkbox" class="cmSel" data-id="${r.id}" data-ob="${r.obligation.id}" data-client="${r.client.id}" ${CMP_SEL.occ.has(r.id) ? 'checked' : ''} onchange="cmpOccSelect(this, '${r.id}', '${r.obligation.id}', '${r.client.id}')" aria-label="Select">`}</td>
    <td class="w-5 py-2.5">${cmpOccDot(r)}</td><td class="whitespace-nowrap py-2">${cmpDay(r.dueDate)}<div class="text-xs ${r.view.overdue ? 'text-red-700' : 'text-slate-500'}">${r.projected ? '' : cmpDaysLeft(r.view)}</div></td>
    <td class="py-2 min-w-[11rem]"><a href="#" class="hover:underline" title="Show only this client" onclick="event.preventDefault(); event.stopPropagation(); cmpObOnly('${r.client.id}')">${cmpCountry(r.client.country).flag} ${esc(r.client.name)}</a> <span class="text-xs text-slate-500">${esc(r.client.code)}</span></td>
    <td class="py-2 min-w-[9rem]">${esc(r.obligation.name)}</td><td class="whitespace-nowrap py-2">${esc(CmpRules.periodName(r))}${r.datesConfirmed || r.projected ? '' : '<div class="text-xs text-sky-700">dates to confirm</div>'}</td>
    <td class="py-2">${cmpOccChip(r)}</td><td class="text-xs py-2">${r.projected ? '' : cmpRemText(r.view)}</td><td class="py-1.5">${cmpRowActions(r, 'cmpLoadObligations')}</td><td class="text-xs py-2">${esc(cmpWho(r.assignedToId))}</td></tr>`).join('')
    || `<tr><td colspan="10">${cmpEmpty(`Nothing for ${esc(cmpRangeText('ob'))}. Obligations are added from a client's page; choose other dates above to see other years.`)}</td></tr>`;
  cmpOccBar();
  $('#cmObCards').innerHTML = d.rows.map(r => `<div role="button" tabindex="0" onclick="${open(r)}" class="w-full text-left border rounded-lg border-l-4 ${r.projected ? 'border-l-slate-300 border-dashed' : CMP_BAR[r.view.colour]} p-3 cursor-pointer">
    <div class="flex justify-between gap-2"><span class="font-medium">${esc(r.obligation.name)}</span>${cmpOccChip(r)}</div>
    <div class="text-sm">${cmpCountry(r.client.country).flag} ${esc(r.client.name)}</div>
    <div class="text-xs text-slate-600">${esc(CmpRules.periodName(r))} · due ${cmpDay(r.dueDate)}${r.projected ? '' : ` · ${cmpDaysLeft(r.view)} · ${cmpRemText(r.view)}`}</div>
    <div class="mt-2">${cmpRowActions(r, 'cmpLoadObligations')}</div></div>`).join('') || cmpEmpty('Nothing for these dates.');
}

/* ---------- add or edit an obligation ---------- */
const CMP_CYCLE_WORDS = { MONTHLY: 'every month (the period is one month long)', QUARTERLY: 'every quarter (the period is three months long)', HALF_YEARLY: 'every six months (the period is six months long)', YEARLY: 'every year' };
async function cmpObligationForm(clientId, obligationId) {
  let client, ob = null, templates = [], suggestions = [];
  try {
    client = (await api(`/api/cmp/clients/${clientId}`)).client;
    templates = await cmpTemplates(true);
    if (obligationId) ob = await api(`/api/cmp/obligations/${obligationId}`);
    suggestions = await api('/api/cmp/suggest/obligations?country=' + client.country);
  } catch (err) { return toast(err.message); }
  CMP_OB.form = { clientId, obligationId: obligationId || null, suggestions, templates, client, ob, yearly: false };
  const country = cmpCountry(client.country), years = ob ? ob.yearsTotal : null;
  cmpShowModal(`${cmpModalHead(ob ? `Edit ${esc(ob.name)}` : 'Add an obligation', `${country.flag} ${esc(client.name)} · ${esc(client.code)}`)}
    <form id="cmObForm" onsubmit="event.preventDefault(); cmpObligationSave()" class="space-y-4">
      <label><span>Obligation *</span><input name="name" required maxlength="120" list="cmObNames" autocomplete="off" placeholder="e.g. Income Tax Return, VAT Return, Trade License renewal" value="${ob ? esc(ob.name) : ''}" oninput="cmpObligationNameHint()">
        <datalist id="cmObNames">${suggestions.map(x => `<option value="${esc(x.name)}"></option>`).join('')}</datalist></label>
      <div id="cmObHint"></div>
      ${ob ? `<p class="text-xs text-slate-500">Comes back <b>${esc(CmpRules.freqOf(ob.frequency).label.toLowerCase())}</b>. The dates are changed period by period: open a period to change its dates (and, if you like, the periods after it).</p>` : `
      <div class="grid sm:grid-cols-3 gap-3">
        <label><span>Period start *</span><input name="periodStart" type="date" required oninput="cmpObligationCycle()"></label>
        <label><span>Period end *</span><input name="periodEnd" type="date" required oninput="cmpObligationCycle()"></label>
        <label><span>Due date * <span class="text-slate-400">(${esc(CmpCountries.zoneCity(client.timeZone))})</span></span><input name="dueDate" type="date" required></label>
      </div>
      <p class="text-xs text-slate-500">For example a Pakistan income tax return: period 1 Jul 2026 – 30 Jun 2027, due 30 Sep 2027. Once these three dates are in, the obligation is set: it comes back on the same pattern.</p>
      <div id="cmObCycle" class="text-sm"></div>`}
      <div class="grid sm:grid-cols-3 gap-3 items-end">
        <div><span class="block text-sm font-medium text-slate-700 mb-1">How many years</span>
          <div class="flex items-center gap-3"><input name="years" type="number" min="1" max="100" class="!w-24" value="${years || ''}" ${years ? '' : 'disabled'} placeholder="e.g. 5">
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" name="unlimited" ${years ? '' : 'checked'} onchange="const y = this.form.years; y.disabled = this.checked; if (!this.checked) { y.value = y.value || 1; y.focus(); }"> Unlimited</label></div></div>
        <label><span>Turn amber this many days before the due date</span><input name="amberDays" type="number" min="0" max="90" value="${ob ? ob.amberDays : 7}"></label>
        <label class="flex items-start gap-2 text-sm pb-2"><input type="checkbox" name="autoNext" ${!ob || ob.autoNext ? 'checked' : ''}><span>Prepare the next period by itself when this one ends</span></label>
      </div>
      <div class="grid sm:grid-cols-3 gap-3">
        <label class="sm:col-span-2"><span>Portal link <span class="text-slate-400">(optional — opens the e-filing portal)</span></span><input name="portalUrl" type="url" maxlength="500" placeholder="https://" value="${ob ? esc(ob.portalUrl) : ''}"></label>
        <label><span>Assigned to <span class="text-slate-400">(else the client's person)</span></span><select name="assignedToId">${cmpTeamOptions(ob ? ob.assignedToId : '', 'Nobody')}</select></label>
      </div>
      <div><div class="flex flex-wrap items-center justify-between gap-2 mb-2"><h3 class="text-sm font-medium">Reminders <span class="text-slate-400 font-normal">— optional: now or later; each sends a message template on WhatsApp</span></h3>
        <div class="flex gap-3">${cmpCan('SETUP') ? '<button type="button" class="text-sm text-emerald-700 underline" onclick="cmpTemplateQuick()">+ New template</button>' : ''}<button type="button" class="text-sm text-emerald-700 underline" onclick="cmpReminderRow()">+ Add reminder</button></div></div>
        <div id="cmTplQuick"></div>
        <p id="cmNoTpl" class="${templates.length ? 'hidden' : ''} text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-2">There are no message templates yet. ${cmpCan('SETUP') ? 'Make one here with <b>+ New template</b> (what you have typed above stays), or add the obligation now and its reminders later.' : 'Add the obligation now; someone who manages templates can add its reminders later.'}</p>
        <div id="cmRemRows" class="space-y-2"></div></div>
      <label><span>Notes</span><textarea name="notes" rows="2" maxlength="1000">${ob ? esc(ob.notes) : ''}</textarea></label>
      <div class="flex flex-wrap justify-between gap-2">
        <div>${ob && cmpCan('ARCHIVE') ? cmpBtn('Delete obligation', `cmpObligationDelete('${ob.id}')`, 'danger', 'needs-write') : ''}</div>
        <div class="flex gap-2">${cmpBtn('Cancel', 'cmpCloseModal()')}<button class="px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">${ob ? 'Save changes' : 'Add obligation'}</button></div></div>
    </form>`);
  (ob ? ob.reminders : []).sort((a, b) => a.offsetDays - b.offsetDays).forEach(r => cmpReminderRow(r));
  if (ob) cmpObligationNameHint();
}
// How often it will come back, from the dates (the CA: no list to choose from); a shorter period can still come back once a year
function cmpObligationCycle() {
  const f = $('#cmObForm'), box = document.getElementById('cmObCycle'); if (!f || !box) return;
  const a = f.periodStart.value, b = f.periodEnd.value;
  if (!a || !b) { box.innerHTML = ''; return; }
  const detected = CmpRules.detectFrequency(a, b), freq = CMP_OB.form.yearly ? 'YEARLY' : detected;
  CMP_OB.form.freq = freq;
  box.innerHTML = `<div class="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2">↻ Comes back <b>${CMP_CYCLE_WORDS[freq]}</b>, on the same pattern.
    ${detected !== 'YEARLY' ? `<button type="button" class="underline text-emerald-800 ml-1" onclick="CMP_OB.form.yearly = ${!CMP_OB.form.yearly}; cmpObligationCycle()">${CMP_OB.form.yearly ? `Every ${CmpRules.freqOf(detected).unit} instead` : 'Once a year instead (e.g. one of four quarterly returns)'}</button>` : ''}</div>`;
}
// The same obligation for other clients of this country (the CA: country-sensitive, suggested by country and name): its dates and reminders
function cmpObligationNameHint() {
  const f = $('#cmObForm'), box = document.getElementById('cmObHint'), form = CMP_OB.form; if (!f || !box) return;
  const k = CmpRules.keyOf(f.name.value), i = form.suggestions.findIndex(x => CmpRules.keyOf(x.name) === k);
  if (!k || i < 0) { box.innerHTML = ''; return; }
  const s = form.suggestions[i], country = cmpCountry(form.client.country), rem = s.reminders.length;
  if (form.ob && (!rem || document.querySelector('#cmRemRows .cmRem'))) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-sm flex flex-wrap items-center gap-2">
    <span>${country.flag} ${s.clients} other ${esc(country.name)} client${s.clients === 1 ? ' has' : 's have'} <b>${esc(s.name)}</b>${form.ob ? '' : `: ${esc(CmpRules.periodName(s))}, due ${esc(cmpDay(s.dueDate))}`}${rem ? `, ${rem} reminder${rem === 1 ? '' : 's'} (${s.reminders.map(r => esc(CmpRules.offsetLabel(r.offsetDays).toLowerCase())).join(', ')})` : ''}.</span>
    ${cmpBtn(form.ob ? 'Use their reminders' : 'Use these dates and reminders', `cmpObligationSuggest(${i})`, 'plain')}</div>`;
}
function cmpReminderRow(r = { offsetDays: -7, templateId: '' }) {
  const t = CMP_OB.form.templates, when = r.offsetDays < 0 ? 'before' : r.offsetDays > 0 ? 'after' : 'on';
  if (!t.length && !r.templateId) return toast(cmpCan('SETUP') ? 'Make a message template first: + New template.' : 'There are no message templates yet.');
  const pref = r.templateId || (t.find(x => x.purpose === 'REMINDER') || t[0] || {}).id || '';
  $('#cmRemRows').insertAdjacentHTML('beforeend', `<div class="cmRem flex flex-wrap items-end gap-2 bg-slate-50 border rounded-lg p-2">
    <label class="w-20"><span>Days</span><input type="number" min="0" max="366" value="${Math.abs(r.offsetDays)}" class="remDays"></label>
    <label class="w-44"><span>When</span><select class="remWhen" onchange="this.closest('.cmRem').querySelector('.remDays').disabled = this.value === 'on'">
      <option value="before" ${when === 'before' ? 'selected' : ''}>days before the due date</option><option value="on" ${when === 'on' ? 'selected' : ''}>on the due date</option><option value="after" ${when === 'after' ? 'selected' : ''}>days after the due date</option></select></label>
    <label class="flex-1 min-w-[12rem]"><span>Template</span><select class="remTpl">${cmpTemplateOptions(pref, r)}</select></label>
    <button type="button" class="px-3 min-h-[2.5rem] text-red-600" onclick="this.closest('.cmRem').remove()" aria-label="Remove reminder">✕</button></div>`);
  const row = $('#cmRemRows').lastElementChild; row.querySelector('.remDays').disabled = when === 'on';
}
const cmpTemplateOptions = (pref, r = {}) => CMP_OB.form.templates.map(x => `<option value="${x.id}" ${x.id === pref ? 'selected' : ''}>${esc(x.name)}</option>`).join('')
  + (r.templateId && !CMP_OB.form.templates.some(x => x.id === r.templateId) ? `<option value="${r.templateId}" selected>${esc(r.templateName || 'retired template')}</option>` : '');
function cmpObligationSuggest(i) {
  const s = CMP_OB.form.suggestions[Number(i)]; if (!s) return;
  const f = $('#cmObForm');
  if (!CMP_OB.form.ob) {
    f.name.value = s.name; f.portalUrl.value = f.portalUrl.value || s.portalUrl || '';
    f.periodStart.value = s.periodStart; f.periodEnd.value = s.periodEnd; f.dueDate.value = s.dueDate;
    CMP_OB.form.yearly = s.frequency === 'YEARLY' && CmpRules.detectFrequency(s.periodStart, s.periodEnd) !== 'YEARLY';
    f.unlimited.checked = !s.yearsTotal; f.years.disabled = !s.yearsTotal; f.years.value = s.yearsTotal || '';
    cmpObligationCycle();
  }
  $('#cmRemRows').innerHTML = ''; s.reminders.forEach(r => cmpReminderRow(r));
  $('#cmObHint').innerHTML = '';
  toast(CMP_OB.form.ob ? 'Their reminders are filled in: save to keep them.' : 'Filled in from another client of this country: check the dates.', true);
}
async function cmpObligationSave() {
  const f = $('#cmObForm'), form = CMP_OB.form;
  let yearsTotal = null;
  if (!f.unlimited.checked) { yearsTotal = Number(f.years.value); if (!Number.isInteger(yearsTotal) || yearsTotal < 1 || yearsTotal > 100) return toast('How many years: type a number from 1 to 100, or tick Unlimited.'); }
  const reminders = [...document.querySelectorAll('#cmRemRows .cmRem')].map(row => {
    const n = Number(row.querySelector('.remDays').value) || 0, when = row.querySelector('.remWhen').value;
    return { offsetDays: when === 'on' ? 0 : when === 'before' ? -n : n, templateId: row.querySelector('.remTpl').value };
  });
  const body = { name: f.name.value, portalUrl: f.portalUrl.value, notes: f.notes.value, yearsTotal, assignedToId: f.assignedToId.value || null, amberDays: Number(f.amberDays.value), autoNext: f.autoNext.checked };
  try {
    let ob;
    if (form.obligationId) {
      await api(`/api/cmp/obligations/${form.obligationId}`, { method: 'PUT', body });
      ob = await api(`/api/cmp/obligations/${form.obligationId}/reminders`, { method: 'PUT', body: { reminders } });
    } else {
      const freq = form.yearly ? 'YEARLY' : undefined; // (else the server reads it from the dates, like the screen)
      ob = await api(`/api/cmp/clients/${form.clientId}/obligations`, { method: 'POST', body: { ...body, frequency: freq, periodStart: f.periodStart.value, periodEnd: f.periodEnd.value, dueDate: f.dueDate.value, reminders } });
    }
    cmpCloseModal(); toast(form.obligationId ? 'Obligation saved' : `${ob.name} added, ${CmpRules.repeatsLabel(ob.frequency, ob.yearsTotal).toLowerCase()}${ob.occurrences.length > 1 ? ' (next period prepared too: its period is already over)' : ''}`, true);
    if (S.page === 'cm-client') cmpLoadClient(); else if (S.page === 'cm-obligations') cmpLoadObligations(); else cmpOpenClient(form.clientId);
  } catch (err) { toast(err.message); }
}

/* ---------- a template made inside the obligation's window (the CA: nothing typed is lost) ---------- */
function cmpTemplateQuick() {
  const box = $('#cmTplQuick');
  if (box.innerHTML) { box.innerHTML = ''; return; }
  const chips = ['Client Name', 'Obligation', 'Period Start', 'Period End', 'Due Date', 'Days Left', 'Registration No.', 'Firm Name'];
  box.innerHTML = `<div class="bg-sky-50 border border-sky-200 rounded-lg p-3 mb-2 space-y-2">
    <div class="grid sm:grid-cols-2 gap-2"><label><span>Template name</span><input id="tqName" maxlength="80" placeholder="e.g. VAT reminder"></label>
      <label><span>Used for</span><select id="tqPurpose">${Object.entries(CmpRules.TEMPLATE_PURPOSES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label></div>
    <label><span>Message</span><textarea id="tqBody" rows="4" maxlength="4000">Dear [Client Name], your [Obligation] for the period [Period Start] to [Period End] is due on [Due Date]. Kindly share the required documents.</textarea></label>
    <div class="flex flex-wrap gap-1">${chips.map(n => `<button type="button" class="text-xs px-2 py-1 rounded border bg-white hover:border-emerald-600" onclick="cmpInsertAt('tqBody', '[${n}]')">[${n}]</button>`).join('')}
      <span class="text-xs text-slate-500 self-center">All placeholders: Setup → Message Templates</span></div>
    <div class="flex gap-2">${cmpBtn('Save template', 'cmpTemplateQuickSave()', 'primary', 'needs-write')}${cmpBtn('Cancel', "$('#cmTplQuick').innerHTML = ''")}</div></div>`;
  $('#tqName').focus();
}
function cmpInsertAt(id, text) {
  const ta = document.getElementById(id), a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, a) + text + ta.value.slice(b); ta.focus(); ta.selectionStart = ta.selectionEnd = a + text.length;
  ta.dispatchEvent(new Event('input'));
}
async function cmpTemplateQuickSave() {
  try {
    const t = await api('/api/cmp/templates', { method: 'POST', body: { name: $('#tqName').value, purpose: $('#tqPurpose').value, body: $('#tqBody').value } });
    CMP_OB.form.templates = await cmpTemplates(true);
    document.querySelectorAll('#cmRemRows .remTpl').forEach(sel => { const v = sel.value; sel.innerHTML = cmpTemplateOptions(v); sel.value = v; });
    $('#cmTplQuick').innerHTML = ''; $('#cmNoTpl').classList.add('hidden');
    if (!document.querySelector('#cmRemRows .cmRem')) cmpReminderRow({ offsetDays: -7, templateId: t.id });
    toast(`Template "${t.name}" saved${document.querySelectorAll('#cmRemRows .cmRem').length === 1 ? ' and set on a reminder 7 days before the due date: change the days if you like' : ''}.`, true);
  } catch (err) { toast(err.message); }
}

async function cmpNextPeriod(id, after) {
  try { await api(`/api/cmp/obligations/${id}/next`, { method: 'POST' }); toast('Next period added: check its dates', true); if (after) after(); else if (S.page === 'cm-client') cmpLoadClient(); }
  catch (err) { toast(err.message); }
}
async function cmpObligationArchive(id, archive) {
  if (archive && !confirm('Archive this obligation? Its periods leave the lists, dashboards and reminders. It can be restored from the client\'s page.')) return;
  try { await api(`/api/cmp/obligations/${id}/${archive ? 'archive' : 'restore'}`, { method: 'POST' }); toast(archive ? 'Obligation archived' : 'Obligation restored', true); if (S.page === 'cm-client') cmpLoadClient(); }
  catch (err) { toast(err.message); }
}
// Deleted for good (the CA). Once a WhatsApp message was sent (or an invoice issued) for it: a warning, and a note saying why.
async function cmpObligationDelete(id) {
  let ob;
  try { ob = await api(`/api/cmp/obligations/${id}`); } catch (err) { return toast(err.message); }
  const u = ob.usage || { messages: 0, invoices: 0 }, serious = u.messages || u.invoices;
  CMP_OB.deleting = { id, after: S.page === 'cm-client' ? cmpLoadClient : S.page === 'cm-obligations' ? cmpLoadObligations : null };
  cmpShowModal(`${cmpModalHead(`Delete ${esc(ob.name)}?`, `${cmpCountry(ob.client.country).flag} ${esc(ob.client.name)} · ${ob.occurrences.length} period${ob.occurrences.length === 1 ? '' : 's'}`)}
    <div class="space-y-3 text-sm">
      ${serious ? `<div class="rounded-lg border-2 border-red-300 bg-red-50 px-3 py-2 text-red-900">⚠ <b>${[u.messages && `${u.messages} WhatsApp message${u.messages === 1 ? ' was' : 's were'} sent`, u.invoices && `${u.invoices} invoice${u.invoices === 1 ? ' was' : 's were'} issued`].filter(Boolean).join(' and ')}</b> for this obligation.
        They stay in the WhatsApp log and the invoices, no longer tied to it. Its periods and reminders are removed for good.</div>
        <label><span>Note — why it is deleted *</span><textarea id="cmDelNote" rows="2" maxlength="500" placeholder="e.g. added for the wrong client"></textarea></label>`
      : '<p>Its periods and reminders are removed for good. To keep them but hide them, archive it instead.</p>'}
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseModal()')}${cmpBtn('Delete for good', 'cmpObligationDeleteGo()', 'danger', 'needs-write')}</div></div>`);
}
async function cmpObligationDeleteGo() {
  const d = CMP_OB.deleting, note = document.getElementById('cmDelNote');
  if (note && !note.value.trim()) return toast('Write a note saying why it is deleted.');
  try {
    await api(`/api/cmp/obligations/${d.id}/delete`, { method: 'POST', body: { note: note ? note.value : '' } });
    cmpCloseModal(); toast('Obligation deleted', true); if (d.after) d.after();
  } catch (err) { toast(err.message); }
}

/* ---------- one period: dates, step, completion, reminders ---------- */
async function cmpOpenPeriod(obligationId, occurrenceId, refresh) {
  if (String(occurrenceId).startsWith('plan:')) return cmpOpenPlanned(obligationId, Number(occurrenceId.split(':')[2]), refresh);
  let ob;
  try { ob = await api(`/api/cmp/obligations/${obligationId}`); } catch (err) { return toast(err.message); }
  const p = ob.occurrences.find(x => x.id === occurrenceId);
  if (!p) return toast('That period is not there any more. Reload the page.');
  CMP_OB.period = { ob, p, refresh };
  const v = p.view, done = p.stage === 'COMPLETED', live = !ob.archivedAt && !ob.client.archivedAt, item = { ...p, client: ob.client };
  const editDates = live && cmpCan('OBLIGATION_EDIT'), steps = live && cmpCan('COMPLETE');
  cmpShowModal(`<div class="flex items-start justify-between gap-3 mb-4"><div class="min-w-0"><h2 class="text-lg font-semibold">${esc(ob.name)} · ${esc(CmpRules.periodName(p))}</h2>
      <div class="text-sm text-slate-500">${cmpCountry(ob.client.country).flag} ${esc(ob.client.name)} · ${esc(ob.client.code)} · ${esc(CmpRules.repeatsLabel(ob.frequency, ob.yearsTotal))}</div>
      <div class="flex flex-wrap gap-2 mt-2">${live && cmpCan('OBLIGATION_EDIT') ? cmpBtn('✎ Edit obligation', `cmpObligationForm('${ob.client.id}', '${ob.id}')`, 'plain', 'needs-write') : ''}
        ${cmpCan('ARCHIVE') ? cmpBtn('Delete obligation', `cmpObligationDelete('${ob.id}')`, 'danger', 'needs-write') : ''}
        ${cmpBtn('Client', `cmpCloseModal(); cmpOpenClient('${ob.client.id}')`)}</div></div>
    <button type="button" onclick="cmpCloseModal()" class="text-slate-400 hover:text-slate-700 text-2xl leading-none px-2" aria-label="Close">×</button></div>
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
          ${CMP_STEPS.map(([k, l]) => `<option value="${k}" ${p.stage === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          ${cmpBtn('✓ Complete', 'cmpPeriodComplete()', 'primary', 'needs-write')}`}</div>
        <p class="text-xs text-slate-500 mt-1">Upcoming, Period closed and Overdue follow from the dates. It stays overdue until it is completed.</p></section>` : ''}
      <section><h3 class="text-sm font-medium mb-2">Reminders</h3><div class="flex flex-col gap-1.5">${v.reminders.length ? v.reminders.map(r => cmpReminderPill(r, item, 'cmpPeriodRefresh')).join('') : '<p class="text-sm text-slate-500">No reminders. Add them with Edit obligation.</p>'}</div></section>
      ${editDates ? `<label><span>Notes for this period</span><textarea id="cpNotes" rows="2" maxlength="1000" onchange="cmpPeriodNotes(this.value)">${esc(p.notes)}</textarea></label>` : (p.notes ? `<p class="text-sm whitespace-pre-wrap">${esc(p.notes)}</p>` : '')}
      <div class="flex flex-wrap justify-between gap-2 pt-2 border-t">
        <div class="flex flex-wrap gap-2">
          ${ob.portalUrl ? `<a href="${esc(ob.portalUrl)}" target="_blank" rel="noopener noreferrer" class="px-3 min-h-[2.5rem] inline-flex items-center rounded-lg text-sm border bg-white hover:border-emerald-600">Open portal ↗</a>` : ''}
          ${live && cmpCan('WHATSAPP') && !ob.client.noWhatsApp ? cmpBtn(`${CMP_WA_ICON} Other message`, `cmpClientMessage('${ob.client.id}', '${p.id}')`, 'plain', 'needs-write') : ''}
        </div>${cmpBtn('Close', 'cmpCloseModal()')}</div>
    </div>`);
}
// A period still to come (Planned): its proposed dates; it is made when the one before it ends, or now by hand
async function cmpOpenPlanned(obligationId, seq, refresh) {
  let ob;
  try { ob = await api(`/api/cmp/obligations/${obligationId}`); } catch (err) { return toast(err.message); }
  const d = CmpRules.projectPeriods(ob, seq, '2200-12-31', 1)[0];
  if (!d) return toast('That period is past the number of years of this obligation.');
  const last = ob.occurrences[ob.occurrences.length - 1], live = !ob.archivedAt && !ob.client.archivedAt;
  CMP_OB.plannedRefresh = refresh || null;
  cmpShowModal(`${cmpModalHead(`${esc(ob.name)} · ${esc(CmpRules.periodName(d))}`, `${cmpCountry(ob.client.country).flag} ${esc(ob.client.name)} · ${esc(CmpRules.repeatsLabel(ob.frequency, ob.yearsTotal))}`)}
    <div class="space-y-3 text-sm">
      <div class="rounded-lg border border-dashed border-slate-400 px-3 py-2">${CMP_PLANNED_CHIP} Period <b>${esc(CmpRules.fmtDay(d.periodStart))} – ${esc(CmpRules.fmtDay(d.periodEnd))}</b>, due <b>${esc(CmpRules.fmtDay(d.dueDate))}</b></div>
      <p>A planned period is still to come: it is prepared ${ob.autoNext ? 'by itself when the period before it ends' : 'by hand ("Prepare the next period")'}, then its dates are confirmed, its reminders come due and it can be completed.${last ? ` The latest period there now is ${esc(CmpRules.periodName(last))}.` : ''}</p>
      <div class="flex flex-wrap justify-between gap-2 pt-2 border-t">
        <div class="flex flex-wrap gap-2">${live && cmpCan('OBLIGATION_EDIT') ? cmpBtn('Prepare the next period now', `cmpCloseModal(); cmpNextPeriod('${ob.id}', CMP_OB.plannedRefresh)`, 'primary', 'needs-write') + cmpBtn('✎ Edit obligation', `cmpObligationForm('${ob.client.id}', '${ob.id}')`, 'plain', 'needs-write') : ''}</div>
        ${cmpBtn('Close', 'cmpCloseModal()')}</div></div>`);
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
    <div class="flex justify-end mt-4">${cmpBtn('Back', 'cmpCloseModal()')}</div>`);
}
async function cmpPeriodCompleteGo(mode) {
  const c = CMP_OB.period;
  const ob = await cmpPeriodCall(`/api/cmp/occurrences/${c.p.id}/complete`, { mode }, null, { reopen: false });
  if (!ob) return;
  if (ob.invoiceId) { toast('Completed. Enter the fee on the invoice.', true); return cmpInvoiceEdit(ob.invoiceId, c.refresh); }
  const next = ob.occurrences.find(x => x.seq === c.p.seq + 1), wa = cmpCan('WHATSAPP') && !c.ob.client.noWhatsApp;
  cmpShowModal(`${cmpModalHead('Completed ✓', `${esc(c.ob.name)} · ${esc(CmpRules.periodName(c.p))} · ${esc(c.ob.client.name)}`)}
    <div class="space-y-3 text-sm">
      ${next ? `<p>The next period (${esc(CmpRules.periodName(next))}, due ${esc(cmpDay(next.dueDate))}) is ready${next.datesConfirmed ? '' : ': check its dates when you can'}.</p>` : ''}
      ${wa ? '<p>Let the client know on WhatsApp?</p>' : ''}
      <div class="flex flex-wrap justify-end gap-2">${cmpBtn(wa ? 'Not now' : 'OK', 'cmpCloseModal()')}${wa ? cmpBtn(`${CMP_WA_ICON} Send a message`, `cmpClientMessage('${c.ob.client.id}', '${c.p.id}', 'COMPLETION')`, 'wa', 'needs-write') : ''}</div>
    </div>`);
}
