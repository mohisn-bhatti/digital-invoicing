'use strict';
/* Compliance & Deadlines: the firm's clients (SRS 3), adding and editing one (country first, then the fields for that country), and the
   client's 360° view (SRS 11: details, extra fields, obligations, messages, history). */

const CMP_CL = { q: '', country: '', assignee: '', missing: false, archived: false, list: [], fields: null, form: null, timer: null };
CMP_RESETS.push(() => Object.assign(CMP_CL, { q: '', country: '', assignee: '', missing: false, archived: false, list: [], fields: null, form: null }));
const cmpClQuery = () => cmpQs({ q: CMP_CL.q, country: CMP_CL.country, assignee: CMP_CL.assignee, missing: CMP_CL.missing ? '1' : '', archived: CMP_CL.archived ? '1' : '' });

CMP_PAGES.push({
  id: 'cm-clients',
  html: () => `<div class="bg-white rounded-xl shadow p-4">
    <div class="flex flex-wrap items-end justify-between gap-3 mb-3">
      <div class="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3 flex-1">
        <label class="col-span-2 sm:min-w-[14rem]"><span>Search</span><input id="cmClQ" type="search" placeholder="Name, code, email, registration no." autocomplete="off"
          oninput="clearTimeout(CMP_CL.timer); CMP_CL.timer = setTimeout(() => { CMP_CL.q = this.value; cmpLoadClients(); }, 350)"></label>
        <label><span>Country</span><select id="cmClCountry" onchange="CMP_CL.country = this.value; cmpLoadClients()">${cmpCountryOptions('', 'All countries')}</select></label>
        <label><span>Assigned to</span><select id="cmClWho" onchange="CMP_CL.assignee = this.value; cmpLoadClients()"></select></label>
        <label class="flex items-center gap-2 text-sm min-h-[2.5rem]"><input type="checkbox" onchange="CMP_CL.missing = this.checked; cmpLoadClients()"> Missing details only</label>
        <label class="flex items-center gap-2 text-sm min-h-[2.5rem]"><input type="checkbox" onchange="CMP_CL.archived = this.checked; cmpLoadClients()"> Archived clients</label>
      </div>
      <div class="flex flex-wrap gap-2"><span id="cmClExport"></span>${cmpBtn('Print / PDF', 'cmpPrintTable("Clients", "cmClTable")')}<span id="cmClAdd"></span></div>
    </div>
    <div id="cmClBulk" class="hidden flex flex-wrap items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-2"></div>
    <div id="cmClNote" class="text-xs text-slate-500 mb-2"></div>
    <div id="cmClCards" class="md:hidden space-y-2"></div>
    <div class="hidden md:block overflow-x-auto"><table id="cmClTable" class="w-full text-sm">
      <thead class="text-left text-slate-500 border-b"><tr><th class="py-2 w-8"><input type="checkbox" aria-label="Select all" onchange="cmpClSelectAll(this)"></th><th>Code</th><th>Client</th><th>Country</th><th>Contact</th><th class="text-right">Open</th><th class="text-right">Overdue</th><th>Missing details</th><th>Assigned to</th></tr></thead>
      <tbody id="cmClRows"></tbody></table></div></div>`,
  enter: () => {
    $('#cmClAdd').innerHTML = cmpCan('CLIENT_EDIT') ? cmpBtn('+ Add client', 'cmpClientForm()', 'primary', 'needs-write') : '';
    $('#cmClExport').innerHTML = cmpCan('EXPORT') ? cmpBtn('Download (Excel)', "cmpDownload('/api/cmp/export/clients?' + cmpClQuery(), 'clients.csv')") : '';
    $('#cmClWho').innerHTML = cmpTeamFilter(); $('#cmClWho').value = CMP_CL.assignee;
    cmpLoadClients();
  },
});

async function cmpLoadClients() {
  let d;
  try { d = await api('/api/cmp/clients?' + cmpClQuery()); } catch (err) { $('#cmClRows').innerHTML = `<tr><td colspan="9">${cmpEmpty(esc(err.message))}</td></tr>`; return; }
  for (const id of [...CMP_SEL.cl]) if (!d.clients.some(c => c.id === id)) CMP_SEL.cl.delete(id);
  CMP_CL.list = d.clients;
  $('#cmClNote').textContent = `${d.clients.length}${d.total > d.clients.length ? ` of ${d.total}` : ''} ${CMP_CL.archived ? 'archived ' : ''}client${d.total === 1 ? '' : 's'}`;
  const missing = c => (c.missing.length ? `<span class="px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-800" title="${esc(c.missing.join(', '))}">${c.missing.length} missing</span>` : '<span class="text-xs text-emerald-700">complete</span>');
  const open = id => `cmpOpenClient('${id}')`;
  $('#cmClRows').innerHTML = d.clients.map(c => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer" onclick="${open(c.id)}">
    <td class="py-2" onclick="event.stopPropagation()"><input type="checkbox" class="cmSel" data-id="${c.id}" ${CMP_SEL.cl.has(c.id) ? 'checked' : ''} onchange="cmpClSelect(this, '${c.id}')" aria-label="Select"></td>
    <td class="text-slate-500">${esc(c.code)}</td><td><div class="font-medium">${esc(c.name)}</div><div class="text-xs text-slate-500">${esc(c.email)}</div></td>
    <td>${cmpFlagName(c.country)}</td><td class="whitespace-nowrap">${esc(c.contactNumber)}</td>
    <td class="text-right">${c.openCount}</td><td class="text-right ${c.overdueCount ? 'text-red-700 font-semibold' : ''}">${c.overdueCount}</td><td>${missing(c)}</td><td class="text-xs">${esc(cmpWho(c.assignedToId))}</td></tr>`).join('')
    || `<tr><td colspan="9">${cmpEmpty(CMP_CL.q || CMP_CL.country || CMP_CL.missing ? 'No client matches.' : CMP_CL.archived ? 'No archived clients.' : 'No clients yet. Add the first one: choose its country, then fill in its details.')}</td></tr>`;
  $('#cmClCards').innerHTML = d.clients.map(c => `<button type="button" onclick="${open(c.id)}" class="w-full text-left border rounded-lg p-3">
    <div class="flex justify-between gap-2"><span class="font-medium">${cmpCountry(c.country).flag} ${esc(c.name)}</span><span class="text-xs text-slate-500">${esc(c.code)}</span></div>
    <div class="text-xs text-slate-600 mt-1">${c.openCount} open${c.overdueCount ? ` · <span class="text-red-700 font-semibold">${c.overdueCount} overdue</span>` : ''} · ${missing(c)}</div></button>`).join('') || cmpEmpty('No clients.');
  cmpClBar();
}

/* ---------- add or edit a client (SRS 3.1–3.3) ---------- */
async function cmpClientForm(id) {
  let current = null;
  if (id) { try { current = await api(`/api/cmp/clients/${id}`); } catch (err) { return toast(err.message); } }
  CMP_CL.form = { id: id || null, current };
  const c = current ? current.client : null;
  cmpShowModal(`${cmpModalHead(c ? `Edit ${esc(c.name)}` : 'Add a client', c ? esc(c.code) : 'Choose the country first: the flag shows, and every extra field and suggestion follows that country.')}
    <form id="cmClForm" onsubmit="event.preventDefault(); cmpClientSave()" class="space-y-4">
      <div class="flex items-end gap-3">
        <label class="flex-1"><span>Country *</span><select id="cfCountry" required onchange="cmpClientCountry()">${cmpCountryOptions(c ? c.country : '', 'Choose the country…')}</select></label>
        <div id="cfFlag" class="text-5xl leading-none pb-0.5" aria-hidden="true">${c ? cmpCountry(c.country).flag : ''}</div>
      </div>
      <div id="cfRest" class="${c ? '' : 'hidden'} space-y-4">
        <div class="grid sm:grid-cols-2 gap-3">
          <label class="sm:col-span-2"><span>Client name *</span><input name="name" required maxlength="200" value="${c ? esc(c.name) : ''}"></label>
          <label><span>Contact number * <span id="cfDial" class="text-slate-400"></span></span><input name="contactNumber" required maxlength="30" inputmode="tel" value="${c ? esc(c.contactNumber) : ''}"></label>
          <label><span>Email</span><input name="email" type="email" maxlength="200" value="${c ? esc(c.email) : ''}"></label>
          <label class="sm:col-span-2"><span>Address</span><textarea name="address" rows="2" maxlength="500">${c ? esc(c.address) : ''}</textarea></label>
          <label><span>Registration No.</span><input name="registrationNo" maxlength="60" value="${c ? esc(c.registrationNo) : ''}"></label>
          <label><span>Reference</span><input name="reference" maxlength="200" value="${c ? esc(c.reference) : ''}"></label>
          <label><span>Time zone <span class="text-slate-400">— due dates and reminders follow it</span></span><select name="timeZone" id="cfZone"></select></label>
          <label><span>Assigned to <span class="text-slate-400">— their "My Tasks"</span></span><select name="assignedToId">${cmpTeamOptions(c ? c.assignedToId : '', 'Nobody')}</select></label>
        </div>
        <fieldset class="border rounded-lg p-3 space-y-3"><legend class="text-sm font-medium px-1">Online portal login</legend>
          <label class="flex items-center gap-2 text-sm"><input type="checkbox" name="noPortal" ${c && c.noPortal ? 'checked' : ''} onchange="cmpClientPortal()"> This client has no online portal</label>
          <div id="cfPortal" class="grid sm:grid-cols-3 gap-3">
            <label><span>Username *</span><input name="portalUsername" maxlength="200" autocomplete="off" value="${c ? esc(c.portalUsername) : ''}"></label>
            <label><span>Password * ${c && c.hasPassword ? '<span class="text-slate-400">— leave empty to keep</span>' : ''}</span><input name="portalPassword" type="password" maxlength="200" autocomplete="new-password"></label>
            <label><span>Pin code <span class="text-slate-400">(optional${c && c.hasPin ? ', empty keeps it' : ''})</span></span><input name="pinCode" type="password" maxlength="30" autocomplete="new-password"></label>
            ${c && c.hasPin ? '<label class="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" name="removePin"> Remove the saved PIN</label>' : ''}
          </div>
          <p class="text-xs text-slate-500">Stored encrypted. Only users allowed to see portal passwords can show them, and each time is written in the activity log.</p>
        </fieldset>
        <div><div class="flex items-center justify-between gap-2 mb-2"><h3 class="text-sm font-medium">Additional information <span id="cfFieldsFor" class="text-slate-400 font-normal"></span></h3>
          ${cmpCan('SETUP') ? '<button type="button" class="text-sm text-emerald-700 underline" onclick="cmpFieldInline()">+ Add a field</button>' : ''}</div>
          <div id="cfFieldNew"></div><div id="cfFields" class="grid sm:grid-cols-2 gap-3"></div></div>
        <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseModal()')}<button class="px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">${c ? 'Save changes' : 'Add client'}</button></div>
      </div>
    </form>`);
  if (c) { cmpClientCountry(true); cmpClientPortal(); }
}
// The country decides the flag, the dialling code, the time zones and which extra fields show
async function cmpClientCountry(keepZone) {
  const code = $('#cfCountry').value, f = CMP_CL.form, c = f.current ? f.current.client : null;
  $('#cfRest').classList.toggle('hidden', !code);
  if (!code) { $('#cfFlag').textContent = ''; return; }
  const country = cmpCountry(code);
  $('#cfFlag').textContent = country.flag;
  $('#cfDial').textContent = `— with the code, e.g. +${country.dial} …`;
  const zone = keepZone && c ? c.timeZone : country.zones[0];
  const zones = [...new Set([...country.zones, zone])];
  $('#cfZone').innerHTML = zones.map(z => `<option value="${esc(z)}" ${z === zone ? 'selected' : ''}>${esc(CmpCountries.zoneCity(z))} (${esc(z)})</option>`).join('')
    + '<option value="__other">Another time zone…</option>';
  $('#cfZone').onchange = e => { if (e.target.value === '__other') cmpOtherZone(e.target); };
  $('#cfFieldsFor').textContent = `for ${country.name}`;
  await cmpClientFields(code);
}
function cmpOtherZone(sel) {
  let all = [];
  try { all = Intl.supportedValuesOf('timeZone'); } catch { /* an old browser: the country's zones only */ }
  sel.innerHTML = all.map(z => `<option value="${esc(z)}">${esc(z)}</option>`).join('');
  sel.onchange = null; sel.focus();
}
function cmpClientPortal() {
  const off = $('#cmClForm').noPortal.checked;
  $('#cfPortal').classList.toggle('opacity-40', off);
  $('#cfPortal').querySelectorAll('input').forEach(i => { i.disabled = off; });
}
async function cmpClientFields(code) {
  let defs = [];
  try { defs = await api('/api/cmp/fields?country=' + code); } catch (err) { return toast(err.message); }
  const f = CMP_CL.form, saved = new Map(((f.current && f.current.client.country === code && f.current.fields) || []).map(x => [x.id, x.value]));
  // values typed before the country changed stay in the boxes that are still there
  document.querySelectorAll('#cfFields [data-field]').forEach(el => { if (el.value) saved.set(el.dataset.field, el.value); });
  const box = d => {
    const v = esc(saved.get(d.id) || ''), miss = !saved.get(d.id) ? ' <span class="text-amber-700">· missing</span>' : '';
    const input = d.type === 'MULTILINE' ? `<textarea data-field="${d.id}" rows="2" maxlength="2000">${v}</textarea>`
      : `<input data-field="${d.id}" type="${d.type === 'DATE' ? 'date' : 'text'}" ${d.type === 'NUMBER' ? 'inputmode="decimal"' : ''} maxlength="${d.type === 'NUMBER' ? 40 : 500}" value="${v}">`;
    return `<label class="${d.type === 'MULTILINE' ? 'sm:col-span-2' : ''}"><span>${esc(d.name)}${miss}</span>${input}</label>`;
  };
  $('#cfFields').innerHTML = defs.length ? defs.map(box).join('') : `<p class="text-sm text-slate-500 sm:col-span-2">No extra fields for ${esc(cmpCountry(code).name)} yet.${cmpCan('SETUP') ? ' Add one (e.g. Trade License Number): it will then show for every client of this country.' : ''}</p>`;
}
// SRS 3.3: a new field from the client's form, for its country by default (or several countries, or all)
function cmpFieldInline() {
  const code = $('#cfCountry').value, country = cmpCountry(code);
  $('#cfFieldNew').innerHTML = `<div class="bg-slate-50 border rounded-lg p-3 mb-3 space-y-3">
    <div class="grid sm:grid-cols-3 gap-3">
      <label class="sm:col-span-2"><span>Field name</span><input id="cfnName" maxlength="60" placeholder="e.g. Trade License Number"></label>
      <label><span>Type</span><select id="cfnType">${Object.entries({ TEXT: 'Text', NUMBER: 'Number', DATE: 'Date', MULTILINE: 'Multi-line text' }).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
    </div>
    <div class="text-sm space-y-1"><div class="font-medium text-slate-700">Show it for</div>
      <label class="flex items-center gap-2"><input type="radio" name="cfnScope" value="one" checked onchange="cmpScope()"> ${country.flag} ${esc(country.name)} only</label>
      <label class="flex items-center gap-2"><input type="radio" name="cfnScope" value="some" onchange="cmpScope()"> Several countries</label>
      <label class="flex items-center gap-2"><input type="radio" name="cfnScope" value="all" onchange="cmpScope()"> All countries</label>
      <select id="cfnCountries" multiple size="6" class="hidden mt-1">${CmpCountries.list.map(c => `<option value="${c.code}" ${c.code === code ? 'selected' : ''}>${c.flag} ${esc(c.name)}</option>`).join('')}</select>
      <p id="cfnHint" class="hidden text-xs text-slate-500">Hold Ctrl (or ⌘ on a Mac) to choose several.</p></div>
    <div class="flex gap-2">${cmpBtn('Add field', 'cmpFieldInlineSave()', 'primary')}${cmpBtn('Cancel', "$('#cfFieldNew').innerHTML = ''")}</div></div>`;
  $('#cfnName').focus();
}
function cmpScope() {
  const some = document.querySelector('input[name="cfnScope"]:checked').value === 'some';
  $('#cfnCountries').classList.toggle('hidden', !some); $('#cfnHint').classList.toggle('hidden', !some);
}
async function cmpFieldInlineSave() {
  const code = $('#cfCountry').value, scope = document.querySelector('input[name="cfnScope"]:checked').value;
  const body = { name: $('#cfnName').value, type: $('#cfnType').value, defaultCountry: code, allCountries: scope === 'all',
    countries: scope === 'some' ? [...$('#cfnCountries').selectedOptions].map(o => o.value) : scope === 'one' ? [code] : [] };
  try {
    await api('/api/cmp/fields', { method: 'POST', body });
    $('#cfFieldNew').innerHTML = ''; toast(`Field added. It now shows for every ${scope === 'all' ? '' : 'matching '}client, and as missing where it has no value.`, true);
    await cmpClientFields(code);
  } catch (err) { toast(err.message); }
}
async function cmpClientSave() {
  const form = $('#cmClForm'), fd = new FormData(form), f = CMP_CL.form;
  const body = Object.fromEntries(['name', 'contactNumber', 'email', 'address', 'registrationNo', 'reference', 'timeZone', 'portalUsername', 'portalPassword', 'pinCode'].map(k => [k, fd.get(k) ?? '']));
  body.assignedToId = fd.get('assignedToId') || null;
  body.country = $('#cfCountry').value;
  body.noPortal = form.noPortal.checked;
  if (form.removePin) body.removePin = form.removePin.checked;
  if (body.timeZone === '__other') delete body.timeZone;
  body.fields = Object.fromEntries([...document.querySelectorAll('#cfFields [data-field]')].map(el => [el.dataset.field, el.value]));
  try {
    const r = await api(f.id ? `/api/cmp/clients/${f.id}` : '/api/cmp/clients', { method: f.id ? 'PUT' : 'POST', body });
    cmpCloseModal(); toast(f.id ? 'Client saved' : `Client ${r.client.code} added`, true);
    cmpOpenClient(r.client.id);
  } catch (err) { toast(err.message); }
}

/* ---------- the client's 360° view ---------- */
CMP_PAGES.push({ id: 'cm-client', html: () => '<div id="cmClient"></div>', enter: () => cmpLoadClient() });
async function cmpLoadClient() {
  const box = $('#cmClient');
  if (!CMP.clientId) return go('cm-clients');
  let d;
  try { d = await api(`/api/cmp/clients/${CMP.clientId}`); } catch (err) { box.innerHTML = cmpEmpty(esc(err.message)); return; }
  const c = d.client, country = cmpCountry(c.country), archived = Boolean(c.archivedAt);
  $('#pageTitle').textContent = c.name;
  const row = (k, v) => `<div class="flex gap-3 py-1 border-b last:border-0"><dt class="w-36 shrink-0 text-slate-500">${k}</dt><dd class="min-w-0 break-words">${v || '<span class="text-slate-400">—</span>'}</dd></div>`;
  const live = d.obligations.filter(o => !o.archivedAt), gone = d.obligations.filter(o => o.archivedAt);
  box.innerHTML = `
    ${archived ? `<div class="rounded-lg border px-3 py-2 text-sm bg-slate-100 border-slate-300 mb-4">Archived on ${esc(cmpAt(c.archivedAt))} by ${esc(c.archivedBy || '')}: hidden from the lists, dashboards and reminders. ${cmpCan('ARCHIVE') ? `<button class="underline text-emerald-700 needs-write" onclick="cmpClientArchive('${c.id}', false)">Restore</button>` : ''}</div>` : ''}
    <div class="bg-white rounded-xl shadow p-4 mb-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex items-center gap-3"><span class="text-5xl leading-none" aria-hidden="true">${country.flag}</span>
          <div><div class="text-xl font-semibold">${esc(c.name)}</div><div class="text-sm text-slate-500">${esc(c.code)} · ${esc(country.name)} · ${esc(CmpCountries.zoneCity(c.timeZone))} time${c.assignedToId ? ` · looked after by ${esc(cmpWho(c.assignedToId))}` : ''}</div></div></div>
        <div class="flex flex-wrap gap-2">
          ${!archived && cmpCan('OBLIGATION_EDIT') ? cmpBtn('+ Obligation', `cmpObligationForm('${c.id}')`, 'primary', 'needs-write') : ''}
          ${!archived && cmpCan('WHATSAPP') ? cmpBtn(`${CMP_WA_ICON} WhatsApp`, `cmpClientMessage('${c.id}')`, 'plain', 'needs-write') : ''}
          ${!archived && cmpCan('INVOICE') ? cmpBtn('+ Invoice', `cmpInvoiceNew('${c.id}')`, 'plain', 'needs-write') : ''}
          ${!archived && cmpCan('CLIENT_EDIT') ? cmpBtn('Edit', `cmpClientForm('${c.id}')`, 'plain', 'needs-write') : ''}
          ${!archived && cmpCan('ARCHIVE') ? cmpBtn('Archive', `cmpClientArchive('${c.id}', true)`, 'danger', 'needs-write') : ''}
        </div>
      </div>
    </div>
    <div class="grid lg:grid-cols-2 gap-4 mb-4">
      <section class="min-w-0 bg-white rounded-xl shadow p-4"><h2 class="font-semibold mb-2">Details</h2><dl class="text-sm">
        ${row('Contact number', esc(c.contactNumber))}${row('Email', c.email ? `<a class="text-emerald-700 underline" href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '')}
        ${row('Address', esc(c.address).replace(/\n/g, '<br>'))}${row('Registration No.', esc(c.registrationNo))}${row('Reference', esc(c.reference))}
        ${c.noPortal ? row('Online portal', 'No online portal') : row('Portal username', esc(c.portalUsername)) + row('Password', `<span id="cmSecPw">${c.hasPassword ? '••••••••' : ''}</span>`) + row('Pin code', `<span id="cmSecPin">${c.hasPin ? '••••' : ''}</span>`)}
        </dl>${!c.noPortal && cmpCan('SECRETS') && (c.hasPassword || c.hasPin) ? `<div class="mt-2">${cmpBtn('Show password', `cmpShowSecrets('${c.id}')`)} <span class="text-xs text-slate-500">(written in the activity log)</span></div>` : ''}</section>
      <section class="min-w-0 bg-white rounded-xl shadow p-4"><h2 class="font-semibold mb-2">Additional information</h2><dl class="text-sm">
        ${d.fields.length ? d.fields.map(f => row(esc(f.name), f.missing ? '<span class="px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-800">Missing</span>' : esc(f.type === 'DATE' ? CmpRules.fmtDay(f.value) : f.value).replace(/\n/g, '<br>'))).join('') : `<p class="text-slate-500">No extra fields for ${esc(country.name)}.</p>`}</dl></section>
    </div>
    <section class="bg-white rounded-xl shadow p-4 mb-4"><h2 class="font-semibold mb-3">Obligations</h2>
      ${live.length ? live.map(o => cmpSeriesCard(o, c)).join('') : cmpEmpty('No obligations yet.')}
      ${gone.length ? `<details class="mt-3"><summary class="cursor-pointer text-sm text-slate-600">Archived obligations (${gone.length})</summary><div class="mt-2">${gone.map(o => cmpSeriesCard(o, c)).join('')}</div></details>` : ''}</section>
    ${d.invoices ? `<section class="bg-white rounded-xl shadow p-4 mb-4"><h2 class="font-semibold mb-3">Invoices and receipts</h2>${d.invoices.length ? `<table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-1">Number</th><th>Date</th><th>For</th><th class="text-right">Total</th><th class="text-right">Outstanding</th><th>Status</th></tr></thead><tbody>
      ${d.invoices.map(i => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer" onclick="cmpInvoiceOpen('${i.id}', cmpLoadClient)"><td class="py-1.5">${i.number ? esc(i.number) : '<span class="text-slate-400">(draft)</span>'}</td><td>${cmpDay(i.issueDate)}</td>
        <td class="text-xs">${i.obligation ? `${esc(i.obligation.name)} · ${esc(CmpRules.periodName(i.obligation))}` : ''}</td><td class="text-right">${cmpMoney(i.total, i.currency)}</td><td class="text-right">${['DRAFT', 'CANCELLED'].includes(i.status) ? '—' : cmpMoney(i.outstanding, i.currency)}</td><td>${cmpInvChip(i.status)}</td></tr>`).join('')}</tbody></table>` : cmpEmpty('No invoices yet.')}</section>` : ''}
    ${d.messages ? `<section class="bg-white rounded-xl shadow p-4 mb-4"><h2 class="font-semibold mb-3">WhatsApp messages</h2>${d.messages.length ? `<div class="space-y-2">${d.messages.map(m => `<div class="border rounded-lg p-2 text-sm ${m.voidedAt ? 'opacity-60' : ''}">
        <div class="text-xs text-slate-500">${esc(cmpAt(m.createdAt))} · ${esc(CmpRules.MESSAGE_KINDS[m.kind] || m.kind)}${m.obligation ? ` · ${esc(m.obligation)}` : ''}${m.templateName ? ` · ${esc(m.templateName)}` : ''} · ${esc(m.userEmail)}${m.voidedAt ? ' · <b>marked not sent</b>' : ''}</div>
        <div class="whitespace-pre-wrap mt-1">${esc(m.body)}</div></div>`).join('')}</div>` : cmpEmpty('No messages yet.')}</section>` : ''}
    ${d.activity ? `<section class="bg-white rounded-xl shadow p-4"><h2 class="font-semibold mb-3">History</h2>${d.activity.length ? `<ul class="text-sm divide-y">${d.activity.map(a => `<li class="py-1.5"><span class="text-xs text-slate-500">${esc(cmpAt(a.createdAt))} · ${esc(a.userEmail)}</span><div>${esc(a.summary)}</div></li>`).join('')}</ul>` : cmpEmpty('Nothing yet.')}</section>` : ''}`;
}
async function cmpShowSecrets(id) {
  try {
    const s = await api(`/api/cmp/clients/${id}/secrets`);
    $('#cmSecPw').innerHTML = `<code class="bg-slate-100 px-1 rounded">${esc(s.portalPassword)}</code> <button type="button" class="text-xs underline text-emerald-700" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent).then(() => toast('Copied', true))">Copy</button>`;
    if (s.pinCode) $('#cmSecPin').innerHTML = `<code class="bg-slate-100 px-1 rounded">${esc(s.pinCode)}</code>`;
    setTimeout(() => { const pw = document.getElementById('cmSecPw'); if (pw) pw.textContent = '••••••••'; const pin = document.getElementById('cmSecPin'); if (pin && s.pinCode) pin.textContent = '••••'; }, 60000); // hidden again after a minute
  } catch (err) { toast(err.message); }
}
async function cmpClientArchive(id, archive) {
  if (archive && !confirm('Archive this client? It disappears from the lists, dashboards and reminders, and can be restored from "Archived clients".')) return;
  try { await api(`/api/cmp/clients/${id}/${archive ? 'archive' : 'restore'}`, { method: 'POST' }); toast(archive ? 'Client archived' : 'Client restored', true); cmpLoadClient(); }
  catch (err) { toast(err.message); }
}
// One obligation in the client's view: how it repeats, its reminders and every period
function cmpSeriesCard(o, c) {
  const rem = o.reminders.length ? o.reminders.map(r => `${esc(CmpRules.offsetLabel(r.offsetDays))} (${esc(r.templateName)})`).join(' · ') : 'no reminders';
  return `<div class="border rounded-lg p-3 mb-3 ${o.archivedAt ? 'bg-slate-50' : ''}">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div><div class="font-medium">${esc(o.name)}</div><div class="text-xs text-slate-500">${esc(CmpRules.repeatsLabel(o.frequency, o.yearsTotal))} · reminders: ${rem}</div></div>
      <div class="flex flex-wrap gap-2">
        ${o.portalUrl ? `<a href="${esc(o.portalUrl)}" target="_blank" rel="noopener noreferrer" class="px-3 min-h-[2.25rem] inline-flex items-center rounded-lg text-sm border bg-white hover:border-emerald-600">Portal ↗</a>` : ''}
        ${!o.archivedAt && cmpCan('OBLIGATION_EDIT') ? cmpBtn('Edit', `cmpObligationForm('${c.id}', '${o.id}')`, 'plain', 'needs-write') : ''}
        ${!o.archivedAt && cmpCan('OBLIGATION_EDIT') ? cmpBtn('+ Next period', `cmpNextPeriod('${o.id}')`, 'plain', 'needs-write') : ''}
        ${cmpCan('ARCHIVE') && !c.archivedAt ? cmpBtn(o.archivedAt ? 'Restore' : 'Archive', `cmpObligationArchive('${o.id}', ${!o.archivedAt})`, o.archivedAt ? 'plain' : 'danger', 'needs-write') : ''}
      </div>
    </div>
    <div class="overflow-x-auto mt-2"><table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-1"></th><th>Period</th><th>Due date</th><th>Status</th><th></th></tr></thead><tbody>
      ${[...o.occurrences].reverse().map(p => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer" onclick="cmpOpenPeriod('${o.id}', '${p.id}', cmpLoadClient)">
        <td class="py-1.5 w-5">${cmpDot(p.view.colour)}</td><td>${esc(CmpRules.periodName(p))}${p.datesConfirmed ? '' : ' <span class="text-xs text-sky-700">dates to confirm</span>'}${p.overridden ? ' <span class="text-xs text-slate-500">(own dates)</span>' : ''}</td>
        <td class="whitespace-nowrap">${cmpDay(p.dueDate)} <span class="text-xs text-slate-500">${cmpDaysLeft(p.view)}</span></td><td>${cmpStatusChip(p.view.status)}</td><td class="text-right text-emerald-700">Open ›</td></tr>`).join('')}
    </tbody></table></div></div>`;
}
