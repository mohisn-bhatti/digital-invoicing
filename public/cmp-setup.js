'use strict';
/* Compliance & Deadlines setup: message templates (SRS 7), custom fields (SRS 3.3) and the module's settings. */

const CMP_SET = { templates: [], fields: [], editTpl: null, clients: null, tc: null, tcClient: '', tcOcc: '', logo: '' };
CMP_RESETS.push(() => Object.assign(CMP_SET, { templates: [], fields: [], editTpl: null, clients: null, tc: null, tcClient: '', tcOcc: '', logo: '' }));

/* ---------- message templates ---------- */
CMP_PAGES.push({
  id: 'cm-templates',
  html: () => `<div class="grid lg:grid-cols-5 gap-4 items-start">
    <div class="min-w-0 lg:col-span-2 space-y-4">
      <section class="bg-white rounded-xl shadow p-4"><div class="flex items-center justify-between mb-3"><h2 class="font-semibold">Templates</h2>
        <label class="flex items-center gap-2 text-xs"><input type="checkbox" id="cmTplAll" onchange="cmpLoadTemplates()"> Show retired</label></div>
        <div id="cmTplList" class="space-y-2"></div></section>
      <section class="bg-white rounded-xl shadow p-4"><h2 class="font-semibold mb-1">A client's details</h2>
        <p class="text-xs text-slate-500 mb-2">Choose a client: every placeholder shows with that client's real value, and the preview uses them. Click a line to put its placeholder in the message.</p>
        <div class="grid grid-cols-2 gap-2"><label><span>Client</span><select id="cmTcClient" onchange="CMP_SET.tcClient = this.value; CMP_SET.tcOcc = ''; cmpTplCtxLoad()"></select></label>
          <label><span>Obligation period</span><select id="cmTcOcc" onchange="CMP_SET.tcOcc = this.value; cmpTplCtxLoad()"></select></label></div>
        <div id="cmTcGroups" class="mt-3"></div></section>
    </div>
    <section class="min-w-0 lg:col-span-3 bg-white rounded-xl shadow p-4 lg:sticky lg:top-20" id="cmTplEdit"></section></div>`,
  enter: () => { cmpLoadTemplates(); cmpTplCtxInit(); },
});
// The placeholders in groups (the CA: the client's details together, the obligation's together...), with the client's own fields
const cmpPlaceholderGroups = () => { const g = CmpRules.PLACEHOLDER_GROUPS.map(([t, n]) => [t, n]); g.splice(1, 0, ['Additional information', CMP_SET.fields.filter(f => f.active).map(f => f.name)]); return g; };
async function cmpTplCtxInit() {
  if (!CMP_SET.clients) { try { CMP_SET.clients = (await api('/api/cmp/clients')).clients; } catch { CMP_SET.clients = []; } }
  $('#cmTcClient').innerHTML = '<option value="">— a sample client —</option>' + CMP_SET.clients.map(c => `<option value="${c.id}">${cmpCountry(c.country).flag} ${esc(c.name)} (${esc(c.code)})</option>`).join('');
  $('#cmTcClient').value = CMP_SET.tcClient;
  cmpTplCtxLoad();
}
async function cmpTplCtxLoad() {
  const can = cmpCan('SETUP');
  if (!CMP_SET.tcClient) {
    CMP_SET.tc = null; $('#cmTcOcc').innerHTML = '<option value="">—</option>'; $('#cmTcOcc').disabled = true;
    $('#cmTcGroups').innerHTML = `<div class="text-sm text-slate-500">${cmpPlaceholderGroups().filter(([, n]) => n.length).map(([t, names]) => `<div class="mt-2"><div class="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">${esc(t)}</div>
      <div class="flex flex-wrap gap-1 mt-1">${names.map(n => `<span class="text-xs px-2 py-0.5 rounded border bg-slate-50">[${esc(n)}]</span>`).join('')}</div></div>`).join('')}</div>`;
    return cmpTemplatePreview();
  }
  try { CMP_SET.tc = await api('/api/cmp/templates/context?' + cmpQs({ clientId: CMP_SET.tcClient, occurrenceId: CMP_SET.tcOcc })); } catch (err) { return toast(err.message); }
  const t = CMP_SET.tc;
  $('#cmTcOcc').disabled = !t.periods.length;
  $('#cmTcOcc').innerHTML = t.periods.length ? t.periods.map(p => `<option value="${p.id}" ${p.id === t.occurrenceId ? 'selected' : ''}>${esc(p.name)} · ${esc(p.period)}</option>`).join('') : '<option value="">No obligations yet</option>';
  $('#cmTcGroups').innerHTML = t.groups.filter(g => g.items.length).map(g => `<div class="mt-2"><div class="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">${esc(g.title)}</div>
    ${g.items.map(i => `<${can ? `button type="button" data-ph="${esc(i.name)}" onclick="cmpTemplateInsert('[' + this.dataset.ph + ']')"` : 'div'} class="w-full flex gap-3 justify-between text-left text-sm py-1 border-b last:border-0 ${can ? 'hover:bg-emerald-50' : ''}">
      <span class="text-slate-500 shrink-0">[${esc(i.name)}]</span><span class="min-w-0 truncate text-right">${i.value ? esc(i.value) : '<span class="text-slate-300">—</span>'}</span></${can ? 'button' : 'div'}>`).join('')}</div>`).join('');
  cmpTemplatePreview();
}
async function cmpLoadTemplates() {
  try {
    CMP_SET.templates = await api('/api/cmp/templates' + ($('#cmTplAll').checked ? '?all=1' : ''));
    CMP_SET.fields = await api('/api/cmp/fields?all=1');
  } catch (err) { return toast(err.message); }
  CMP.templates = CMP_SET.templates.filter(t => t.active);
  $('#cmTplList').innerHTML = (cmpCan('SETUP') ? `<button type="button" onclick="cmpTemplateEdit()" class="needs-write w-full text-left border-2 border-dashed rounded-lg p-3 text-sm text-emerald-700 hover:border-emerald-600">+ New template</button>` : '')
    + (CMP_SET.templates.map(t => `<button type="button" onclick="cmpTemplateEdit('${t.id}')" class="w-full text-left border rounded-lg p-3 hover:border-emerald-600 ${t.active ? '' : 'opacity-60'} ${CMP_SET.editTpl === t.id ? 'ring-2 ring-emerald-300' : ''}">
      <div class="flex justify-between gap-2"><span class="font-medium">${esc(t.name)}</span><span class="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 whitespace-nowrap">${esc(CmpRules.TEMPLATE_PURPOSES[t.purpose])}</span></div>
      <div class="text-xs text-slate-500 mt-1 line-clamp-2">${esc(t.body)}</div>
      <div class="text-[11px] text-slate-400 mt-1">${t.active ? `used by ${t.reminders} reminder${t.reminders === 1 ? '' : 's'}` : 'retired'}</div></button>`).join('') || cmpEmpty('No templates yet.'));
  if (!CMP_SET.editTpl) cmpTemplateEdit(CMP_SET.templates[0] ? CMP_SET.templates[0].id : null, true);
}
function cmpTemplateEdit(id, quiet) {
  const t = id ? CMP_SET.templates.find(x => x.id === id) : null, can = cmpCan('SETUP');
  CMP_SET.editTpl = t ? t.id : null;
  if (!quiet) document.querySelectorAll('#cmTplList button').forEach(b => b.classList.remove('ring-2', 'ring-emerald-300'));
  if (!t && !can) { $('#cmTplEdit').innerHTML = cmpEmpty('Choose a template to read it.'); return; }
  const chip = n => `<button type="button" class="text-xs px-2 py-1 rounded border bg-slate-50 hover:border-emerald-600" onclick="cmpTemplateInsert(this.textContent)">[${esc(n)}]</button>`;
  $('#cmTplEdit').innerHTML = `<h2 class="font-semibold mb-3">${t ? esc(t.name) : 'New template'}</h2>
    <form id="cmTplForm" onsubmit="event.preventDefault(); cmpTemplateSave()" class="space-y-3">
      <div class="grid sm:grid-cols-2 gap-3">
        <label><span>Name</span><input name="name" required maxlength="80" value="${t ? esc(t.name) : ''}" ${can ? '' : 'disabled'}></label>
        <label><span>Used for</span><select name="purpose" ${can ? '' : 'disabled'}>${Object.entries(CmpRules.TEMPLATE_PURPOSES).map(([k, v]) => `<option value="${k}" ${(t ? t.purpose : 'REMINDER') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      <label><span>Message</span><textarea id="cmTplBody" name="body" rows="8" maxlength="4000" required oninput="cmpTemplatePreview()" ${can ? '' : 'disabled'}>${t ? esc(t.body) : 'Dear [Client Name], your [Obligation] for the period [Period Start] to [Period End] is due on [Due Date]. Kindly share the required documents.'}</textarea></label>
      ${can ? `<div><div class="text-xs text-slate-600 mb-1">Click to insert (each is replaced by the real details when the message is sent):</div>
        ${cmpPlaceholderGroups().filter(([, n]) => n.length).map(([title, names]) => `<div class="mb-1.5"><div class="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">${esc(title)}</div><div class="flex flex-wrap gap-1 mt-0.5">${names.map(chip).join('')}</div></div>`).join('')}</div>` : ''}
      <div><div id="cmTplPrevFor" class="text-xs text-slate-600 mb-1"></div><div id="cmTplPreview" class="whitespace-pre-wrap text-sm bg-[#e7fbe9] border border-emerald-100 rounded-lg p-3"></div></div>
      ${can ? `<div class="flex flex-wrap justify-between gap-2">
        <div class="flex gap-2">${t ? (t.active ? cmpBtn('Retire', `cmpTemplateActive('${t.id}', false)`, 'plain', 'needs-write') + cmpBtn('Delete', `cmpTemplateDelete('${t.id}')`, 'danger', 'needs-write') : cmpBtn('Use again', `cmpTemplateActive('${t.id}', true)`, 'plain', 'needs-write')) : ''}</div>
        <button class="needs-write px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">${t ? 'Save template' : 'Add template'}</button></div>` : ''}
    </form>`;
  cmpTemplatePreview();
}
function cmpTemplateInsert(text) {
  const ta = document.getElementById('cmTplBody'); if (!ta || ta.disabled) return;
  const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
  ta.focus(); ta.selectionStart = ta.selectionEnd = a + text.length;
  cmpTemplatePreview();
}
function cmpTemplatePreview() {
  const box = document.getElementById('cmTplPreview'); if (!box) return;
  const fields = Object.fromEntries(CMP_SET.fields.filter(f => f.active).map(f => [f.name, f.type === 'DATE' ? '31 Dec 2027' : f.type === 'NUMBER' ? '12345' : `(${f.name})`]));
  const s = CMP.settings || {}, real = CMP_SET.tc;
  const ctx = real ? real.ctx : {
    client: { name: 'Al Noor Trading LLC', code: 'CL0001', registrationNo: '100123456700003', email: 'accounts@alnoor.ae', contactNumber: '+971501234567', address: 'Office 12, Deira, Dubai', reference: 'Mr Khan' },
    countryName: 'United Arab Emirates', obligationName: 'VAT Return', portalUrl: 'https://eservices.tax.gov.ae', daysLeft: 12, occurrence: { periodStart: '2027-01-01', periodEnd: '2027-03-31', dueDate: '2027-04-28' },
    fields, invoice: { number: 'INV-2027-0001', amountText: 'AED 1,500.00', date: '2027-04-30', dueDate: '2027-05-15', outstandingText: 'AED 1,500.00' }, receipt: { number: 'RCT-2027-0001', date: '2027-05-10', amountText: 'AED 1,500.00' },
    firm: { name: s.firmName || 'Your firm', phone: s.firmPhone || '+92 300 0000000', email: s.firmEmail || 'office@yourfirm.com' },
  };
  const who = document.getElementById('cmTplPrevFor');
  if (who) who.textContent = real ? `Preview for ${real.client.name} (${real.client.code})` : 'Preview with a sample client (choose a real one on the left)';
  const r = CmpRules.render($('#cmTplBody').value, ctx);
  box.innerHTML = esc(r.text) + (r.missing.length ? `<div class="mt-2 text-xs text-amber-800">Not known (left as typed): ${r.missing.map(x => `[${esc(x)}]`).join(' ')}</div>` : '');
}
async function cmpTemplateSave() {
  const f = $('#cmTplForm'), body = { name: f.name.value, purpose: f.purpose.value, body: f.body.value }, id = CMP_SET.editTpl;
  try {
    const t = await api(id ? `/api/cmp/templates/${id}` : '/api/cmp/templates', { method: id ? 'PUT' : 'POST', body });
    CMP_SET.editTpl = t.id; toast('Template saved', true); cmpLoadTemplates();
  } catch (err) { toast(err.message); }
}
async function cmpTemplateActive(id, active) {
  try { await api(`/api/cmp/templates/${id}`, { method: 'PUT', body: { active } }); toast(active ? 'Template back in use' : 'Template retired', true); cmpLoadTemplates(); }
  catch (err) { toast(err.message); }
}
async function cmpTemplateDelete(id) {
  if (!confirm('Delete this template? Messages already sent keep their text.')) return;
  try { await api(`/api/cmp/templates/${id}`, { method: 'DELETE' }); CMP_SET.editTpl = null; toast('Template deleted', true); cmpLoadTemplates(); }
  catch (err) { toast(err.message); }
}

/* ---------- custom fields ---------- */
CMP_PAGES.push({
  id: 'cm-fields',
  html: () => `<div class="bg-white rounded-xl shadow p-4">
    <div class="flex flex-wrap items-start justify-between gap-3 mb-3"><div><h2 class="font-semibold">Custom fields</h2>
      <p class="text-xs text-slate-500 max-w-2xl">Extra client details, each for the countries you choose. A field shows on every client of those countries (as "missing" until filled in) and never on clients of other countries. Its name can be used in templates in [brackets].</p></div>
      <label class="flex items-center gap-2 text-xs"><input type="checkbox" id="cmFldAll" onchange="cmpLoadFields()"> Show retired</label></div>
    <div id="cmFldNew"></div>
    <div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Field</th><th>Type</th><th>Countries</th><th class="text-right">Clients with a value</th><th></th></tr></thead>
      <tbody id="cmFldRows"></tbody></table></div></div>`,
  enter: () => cmpLoadFields(),
});
const CMP_FIELD_TYPES = { TEXT: 'Text', NUMBER: 'Number', DATE: 'Date', MULTILINE: 'Multi-line text' };
async function cmpLoadFields() {
  try { CMP_SET.fields = await api('/api/cmp/fields' + ($('#cmFldAll').checked ? '?all=1' : '')); } catch (err) { return toast(err.message); }
  const can = cmpCan('SETUP');
  $('#cmFldNew').innerHTML = can ? `<div class="mb-3">${cmpBtn('+ Add field', 'cmpFieldForm()', 'primary', 'needs-write')}</div>` : '';
  const where = f => (f.allCountries ? 'All countries' : f.countries.map(c => `<span title="${esc(cmpCountry(c).name)}">${cmpCountry(c).flag} ${esc(c)}</span>`).join(' '));
  $('#cmFldRows').innerHTML = CMP_SET.fields.map(f => `<tr class="border-b last:border-0 ${f.active ? '' : 'opacity-60'}">
    <td class="py-2 font-medium">${esc(f.name)}${f.active ? '' : ' <span class="text-xs text-slate-500">(retired)</span>'}</td><td>${CMP_FIELD_TYPES[f.type]}</td><td>${where(f)}</td><td class="text-right">${f.values}</td>
    <td class="text-right whitespace-nowrap">${can ? `<button class="needs-write text-emerald-700 underline mr-2" onclick="cmpFieldForm('${f.id}')">Edit</button><button class="needs-write ${f.active ? 'text-red-600' : 'text-emerald-700'} underline" onclick="cmpFieldActive('${f.id}', ${!f.active})">${f.active ? 'Retire' : 'Use again'}</button>` : ''}</td></tr>`).join('')
    || `<tr><td colspan="5">${cmpEmpty('No custom fields yet. Add one here, or from a client\'s form (it then starts with that client\'s country).')}</td></tr>`;
}
function cmpFieldForm(id) {
  const f = id ? CMP_SET.fields.find(x => x.id === id) : null;
  const scope = f ? (f.allCountries ? 'all' : 'some') : 'some';
  cmpShowModal(`${cmpModalHead(f ? `Edit ${esc(f.name)}` : 'Add a custom field')}
    <form id="cmFldForm" onsubmit="event.preventDefault(); cmpFieldSave()" class="space-y-3">
      <div class="grid sm:grid-cols-3 gap-3">
        <label class="sm:col-span-2"><span>Field name</span><input name="name" required maxlength="60" value="${f ? esc(f.name) : ''}" placeholder="e.g. Trade License Number"></label>
        <label><span>Type</span><select name="type" ${f && f.values ? 'disabled title="It has values: the type cannot change"' : ''}>${Object.entries(CMP_FIELD_TYPES).map(([k, v]) => `<option value="${k}" ${(f ? f.type : 'TEXT') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      <div class="text-sm space-y-1"><div class="font-medium text-slate-700">Show it for</div>
        <label class="flex items-center gap-2"><input type="radio" name="scope" value="some" ${scope === 'some' ? 'checked' : ''} onchange="$('#cmFldCountries').disabled = false"> These countries</label>
        <label class="flex items-center gap-2"><input type="radio" name="scope" value="all" ${scope === 'all' ? 'checked' : ''} onchange="$('#cmFldCountries').disabled = true"> All countries</label>
        <select id="cmFldCountries" multiple size="8" ${scope === 'all' ? 'disabled' : ''}>${CmpCountries.list.map(c => `<option value="${c.code}" ${f && f.countries.includes(c.code) ? 'selected' : ''}>${c.flag} ${esc(c.name)}</option>`).join('')}</select>
        <p class="text-xs text-slate-500">Hold Ctrl (or ⌘ on a Mac) to choose several.</p></div>
      ${f ? '<p class="text-xs text-slate-500">Renaming a field does not change templates that use its old name in [brackets]: update them too.</p>' : ''}
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseModal()')}<button class="px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">${f ? 'Save' : 'Add field'}</button></div>
    </form>`);
  CMP_SET.editField = id || null;
}
async function cmpFieldSave() {
  const form = $('#cmFldForm'), all = form.scope.value === 'all', id = CMP_SET.editField;
  const body = { name: form.name.value, allCountries: all, countries: all ? [] : [...$('#cmFldCountries').selectedOptions].map(o => o.value) };
  if (!form.type.disabled) body.type = form.type.value;
  try { await api(id ? `/api/cmp/fields/${id}` : '/api/cmp/fields', { method: id ? 'PUT' : 'POST', body }); cmpCloseModal(); toast('Field saved', true); cmpLoadFields(); }
  catch (err) { toast(err.message); }
}
async function cmpFieldActive(id, active) {
  if (!active && !confirm('Retire this field? Its values are kept but hidden, and it stops showing as missing.')) return;
  try { await api(`/api/cmp/fields/${id}`, { method: 'PUT', body: { active } }); cmpLoadFields(); } catch (err) { toast(err.message); }
}

/* ---------- settings ---------- */
CMP_PAGES.push({
  id: 'cm-settings',
  html: () => '<div id="cmSettings" class="bg-white rounded-xl shadow p-4 max-w-2xl"></div>',
  enter: async () => {
    let s;
    try { s = await api('/api/cmp/settings'); } catch (err) { return toast(err.message); }
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = [s.timeZone]; }
    if (!zones.includes(s.timeZone)) zones.unshift(s.timeZone);
    const can = cmpCan('FULL');
    $('#cmSettings').innerHTML = `<h2 class="font-semibold mb-3">Settings</h2>
      <form id="cmSetForm" onsubmit="event.preventDefault(); cmpSettingsSave()" class="space-y-4">
        <label><span>Your firm's time zone <span class="text-slate-400">— the times in the logs and lists</span></span><select name="timeZone" ${can ? '' : 'disabled'}>${zones.map(z => `<option value="${esc(z)}" ${z === s.timeZone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
        <label><span>Reminders come due at <span class="text-slate-400">— on each client's own clock</span></span><select name="reminderHour" ${can ? '' : 'disabled'}>${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === s.reminderHour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label>
        <p class="text-xs text-slate-500">When an obligation turns amber, and whether its next period is prepared by itself, is set on each obligation (Edit obligation).</p>
        <h3 class="font-semibold pt-3 border-t">Your WhatsApp numbers <span class="text-slate-500 font-normal text-sm">— that messages go from</span></h3>
        <p class="text-xs text-slate-500">WhatsApp always sends from the account that is open where the message opens. Add your business number and say how it is opened here:
          with <b>WhatsApp Web</b>, log in to web.whatsapp.com with that number in this browser; with the <b>WhatsApp Business app</b> (on an Android phone it opens that app directly).
          The send window then lets you pick the number, reminds you which account must be open, and the log keeps the number used.</p>
        <div id="cmSenders" class="space-y-2"></div>
        ${can ? '<button type="button" class="text-sm text-emerald-700 underline" onclick="cmpSenderRow()">+ Add a WhatsApp number</button>' : ''}
        <h3 class="font-semibold pt-3 border-t">On your invoices and receipts</h3>
        <div class="grid sm:grid-cols-2 gap-3">
          <div class="sm:col-span-2"><span class="block text-sm font-medium text-slate-700 mb-1">Logo <span class="text-slate-400 font-normal">(PNG or JPEG; shown at the top left)</span></span>
            <div class="flex flex-wrap items-center gap-3"><div id="cmLogoBox" class="h-16 min-w-[4rem] border rounded-lg bg-slate-50 flex items-center justify-center p-1">${s.logo ? `<img src="${esc(s.logo)}" alt="Logo" class="max-h-14 max-w-[12rem]">` : '<span class="text-xs text-slate-400 px-2">No logo</span>'}</div>
              ${can ? `<label class="px-3 min-h-[2.5rem] inline-flex items-center rounded-lg text-sm border bg-white hover:border-emerald-600 cursor-pointer">Choose a picture…<input type="file" accept="image/png,image/jpeg,image/webp" class="hidden" onchange="cmpLogoPick(this)"></label>
                <button type="button" class="text-sm text-red-600 underline" onclick="CMP_SET.logo = ''; $('#cmLogoBox').innerHTML = '<span class=&quot;text-xs text-slate-400 px-2&quot;>No logo</span>'">Remove</button>` : ''}</div></div>
          <label class="sm:col-span-2"><span>Header <span class="text-slate-400">(a line or two across the top, e.g. "Chartered Accountants · Tax Advisors")</span></span><textarea name="invoiceHeader" rows="2" maxlength="300" ${can ? '' : 'disabled'}>${esc(s.invoiceHeader || '')}</textarea></label>
          <label class="sm:col-span-2"><span>Firm name</span><input name="firmName" maxlength="200" value="${esc(s.firmName)}" ${can ? '' : 'disabled'}></label>
          <label class="sm:col-span-2"><span>Address</span><textarea name="firmAddress" rows="2" maxlength="500" ${can ? '' : 'disabled'}>${esc(s.firmAddress)}</textarea></label>
          <label><span>Phone</span><input name="firmPhone" maxlength="40" value="${esc(s.firmPhone)}" ${can ? '' : 'disabled'}></label>
          <label><span>Email</span><input name="firmEmail" maxlength="200" value="${esc(s.firmEmail)}" ${can ? '' : 'disabled'}></label>
          <label class="sm:col-span-2"><span>Your tax registration number <span class="text-slate-400">(e.g. TRN, if registered)</span></span><input name="firmTaxNo" maxlength="60" value="${esc(s.firmTaxNo)}" ${can ? '' : 'disabled'}></label>
          <label class="sm:col-span-2"><span>Bank / payment details</span><textarea name="bankDetails" rows="3" maxlength="800" ${can ? '' : 'disabled'}>${esc(s.bankDetails)}</textarea></label>
          <label class="sm:col-span-2"><span>Footer line</span><textarea name="invoiceFooter" rows="2" maxlength="500" ${can ? '' : 'disabled'}>${esc(s.invoiceFooter)}</textarea></label>
          <label><span>Invoice numbers</span><input name="invoiceFormat" maxlength="40" value="${esc(s.invoiceFormat)}" ${can ? '' : 'disabled'}></label>
          <label><span>Receipt numbers</span><input name="receiptFormat" maxlength="40" value="${esc(s.receiptFormat)}" ${can ? '' : 'disabled'}></label>
        </div>
        <p class="text-xs text-slate-500">In the number formats, {NNNN} is the running number and {YYYY}, {YY}, {MM} the date, e.g. INV-{YYYY}-{NNNN} → INV-2027-0042. Numbers are taken when an invoice is issued and never reused.</p>
        ${can ? '<div class="flex justify-end"><button class="needs-write px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">Save settings</button></div>' : '<p class="text-xs text-slate-500">Only a user with full access changes these.</p>'}
      </form>`;
    (s.waSenders || []).forEach(x => cmpSenderRow(x, can));
    CMP_SET.logo = s.logo || '';
  },
});
// The logo is made small here (at most 600 × 240 pixels) before it is saved, so it stays light on every invoice
function cmpLogoPick(input) {
  const file = input.files && input.files[0]; input.value = '';
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast('Choose a PNG, JPEG or WebP picture.');
  const img = new Image(), url = URL.createObjectURL(file);
  img.onload = () => {
    const k = Math.min(1, 600 / img.width, 240 / img.height), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    let data = c.toDataURL('image/png');
    if (data.length > 380000) data = c.toDataURL('image/jpeg', 0.85);
    if (data.length > 380000) return toast('That picture is too large even when made smaller. Choose a simpler one.');
    CMP_SET.logo = data;
    $('#cmLogoBox').innerHTML = `<img src="${data}" alt="Logo" class="max-h-14 max-w-[12rem]">`;
    toast('Logo ready: press Save settings to keep it.', true);
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast('That picture could not be read.'); };
  img.src = url;
}
function cmpSenderRow(x = { label: 'Business WhatsApp', phone: '', open: 'WEB', isDefault: !document.querySelector('#cmSenders .cmSender') }, can = true) {
  const dis = can ? '' : 'disabled';
  $('#cmSenders').insertAdjacentHTML('beforeend', `<div class="cmSender flex flex-wrap items-end gap-2 bg-slate-50 border rounded-lg p-2" data-id="${esc(x.id || '')}">
    <label class="flex-1 min-w-[9rem]"><span>Name</span><input class="snLabel" maxlength="60" value="${esc(x.label)}" ${dis}></label>
    <label class="w-48"><span>Number (with country code)</span><input class="snPhone" maxlength="20" inputmode="tel" placeholder="+92 333 1234567" value="${esc(x.phone)}" ${dis}></label>
    <label class="w-56"><span>Opens with</span><select class="snOpen" ${dis}>${Object.entries(CmpRules.SENDER_OPEN).map(([k, v]) => `<option value="${k}" ${x.open === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
    <label class="flex items-center gap-1 text-sm min-h-[2.5rem]"><input type="radio" name="snDefault" class="snDefault" ${x.isDefault ? 'checked' : ''} ${dis}> Default</label>
    ${can ? '<button type="button" class="px-2 min-h-[2.5rem] text-red-600" onclick="this.closest(\'.cmSender\').remove()" aria-label="Remove">✕</button>' : ''}</div>`);
}
async function cmpSettingsSave() {
  const f = $('#cmSetForm');
  try {
    CMP.settings = await api('/api/cmp/settings', { method: 'PUT', body: { timeZone: f.timeZone.value, reminderHour: Number(f.reminderHour.value), logo: CMP_SET.logo,
      ...Object.fromEntries(['firmName', 'firmAddress', 'firmPhone', 'firmEmail', 'firmTaxNo', 'bankDetails', 'invoiceFooter', 'invoiceHeader', 'invoiceFormat', 'receiptFormat'].map(k => [k, f[k].value])),
      waSenders: [...document.querySelectorAll('#cmSenders .cmSender')].map(r => ({ id: r.dataset.id || undefined, label: r.querySelector('.snLabel').value, phone: r.querySelector('.snPhone').value, open: r.querySelector('.snOpen').value, isDefault: r.querySelector('.snDefault').checked })) } });
    if (CMP.me) CMP.me.settings = CMP.settings;
    PAGE_ENTER['cm-settings']();
    toast('Settings saved', true);
  } catch (err) { toast(err.message); }
}
