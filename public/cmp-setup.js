'use strict';
/* Compliance & Deadlines setup: message templates (SRS 7), custom fields (SRS 3.3) and the module's settings. */

const CMP_SET = { templates: [], fields: [], editTpl: null };
CMP_RESETS.push(() => Object.assign(CMP_SET, { templates: [], fields: [], editTpl: null }));

/* ---------- message templates ---------- */
CMP_PAGES.push({
  id: 'cm-templates',
  html: () => `<div class="grid lg:grid-cols-5 gap-4 items-start">
    <section class="min-w-0 lg:col-span-2 bg-white rounded-xl shadow p-4"><div class="flex items-center justify-between mb-3"><h2 class="font-semibold">Templates</h2>
      <label class="flex items-center gap-2 text-xs"><input type="checkbox" id="cmTplAll" onchange="cmpLoadTemplates()"> Show retired</label></div>
      <div id="cmTplList" class="space-y-2"></div></section>
    <section class="min-w-0 lg:col-span-3 bg-white rounded-xl shadow p-4" id="cmTplEdit"></section></div>`,
  enter: () => cmpLoadTemplates(),
});
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
  const names = [...CmpRules.PLACEHOLDERS, ...CMP_SET.fields.filter(f => f.active).map(f => f.name)];
  $('#cmTplEdit').innerHTML = `<h2 class="font-semibold mb-3">${t ? esc(t.name) : 'New template'}</h2>
    <form id="cmTplForm" onsubmit="event.preventDefault(); cmpTemplateSave()" class="space-y-3">
      <div class="grid sm:grid-cols-2 gap-3">
        <label><span>Name</span><input name="name" required maxlength="80" value="${t ? esc(t.name) : ''}" ${can ? '' : 'disabled'}></label>
        <label><span>Used for</span><select name="purpose" ${can ? '' : 'disabled'}>${Object.entries(CmpRules.TEMPLATE_PURPOSES).map(([k, v]) => `<option value="${k}" ${(t ? t.purpose : 'REMINDER') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      <label><span>Message</span><textarea id="cmTplBody" name="body" rows="8" maxlength="4000" required oninput="cmpTemplatePreview()" ${can ? '' : 'disabled'}>${t ? esc(t.body) : 'Dear [Client Name], your [Obligation] for the period [Period Start] to [Period End] is due on [Due Date]. Kindly share the required documents.'}</textarea></label>
      ${can ? `<div><div class="text-xs text-slate-600 mb-1">Click to insert (each is replaced by the client's real details when the message is sent):</div>
        <div class="flex flex-wrap gap-1">${names.map(n => `<button type="button" class="text-xs px-2 py-1 rounded border bg-slate-50 hover:border-emerald-600" onclick="cmpTemplateInsert(this.textContent)">[${esc(n)}]</button>`).join('')}</div></div>` : ''}
      <div><div class="text-xs text-slate-600 mb-1">Preview with a sample client</div><div id="cmTplPreview" class="whitespace-pre-wrap text-sm bg-[#e7fbe9] border border-emerald-100 rounded-lg p-3"></div></div>
      ${can ? `<div class="flex flex-wrap justify-between gap-2">
        <div class="flex gap-2">${t ? (t.active ? cmpBtn('Retire', `cmpTemplateActive('${t.id}', false)`, 'plain', 'needs-write') + cmpBtn('Delete', `cmpTemplateDelete('${t.id}')`, 'danger', 'needs-write') : cmpBtn('Use again', `cmpTemplateActive('${t.id}', true)`, 'plain', 'needs-write')) : ''}</div>
        <button class="needs-write px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">${t ? 'Save template' : 'Add template'}</button></div>` : ''}
    </form>`;
  cmpTemplatePreview();
}
function cmpTemplateInsert(text) {
  const ta = $('#cmTplBody'), a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
  ta.focus(); ta.selectionStart = ta.selectionEnd = a + text.length;
  cmpTemplatePreview();
}
function cmpTemplatePreview() {
  const box = document.getElementById('cmTplPreview'); if (!box) return;
  const fields = Object.fromEntries(CMP_SET.fields.filter(f => f.active).map(f => [f.name, f.type === 'DATE' ? '31 Dec 2027' : f.type === 'NUMBER' ? '12345' : `(${f.name})`]));
  const r = CmpRules.render($('#cmTplBody').value, {
    client: { name: 'Al Noor Trading LLC', registrationNo: '100123456700003', email: 'accounts@alnoor.ae', contactNumber: '+971501234567', address: 'Office 12, Deira, Dubai', reference: 'Mr Khan' },
    countryName: 'United Arab Emirates', obligationName: 'VAT Return', occurrence: { periodStart: '2027-01-01', periodEnd: '2027-03-31', dueDate: '2027-04-28' },
    fields, invoice: { number: 'INV-2027-0001', amountText: 'AED 1,500.00' }, receipt: { number: 'RCT-2027-0001' },
  });
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
        <label><span>Turn amber this many days before the due date</span><input name="amberDays" type="number" min="0" max="90" value="${s.amberDays}" ${can ? '' : 'disabled'}></label>
        <label class="flex items-start gap-2 text-sm"><input type="checkbox" name="autoNextYear" ${s.autoNextYear ? 'checked' : ''} ${can ? '' : 'disabled'}><span>Prepare the next period of a recurring obligation by itself when the current period ends (its dates are a copy for you to confirm)</span></label>
        <h3 class="font-semibold pt-3 border-t">Your WhatsApp numbers <span class="text-slate-500 font-normal text-sm">— that messages go from</span></h3>
        <p class="text-xs text-slate-500">WhatsApp always sends from the account that is open where the message opens. Add your business number and say how it is opened here:
          with <b>WhatsApp Web</b>, log in to web.whatsapp.com with that number in this browser; with the <b>WhatsApp Business app</b> (on an Android phone it opens that app directly).
          The send window then lets you pick the number, reminds you which account must be open, and the log keeps the number used.</p>
        <div id="cmSenders" class="space-y-2"></div>
        ${can ? '<button type="button" class="text-sm text-emerald-700 underline" onclick="cmpSenderRow()">+ Add a WhatsApp number</button>' : ''}
        <h3 class="font-semibold pt-3 border-t">On your invoices and receipts</h3>
        <div class="grid sm:grid-cols-2 gap-3">
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
  },
});
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
    CMP.settings = await api('/api/cmp/settings', { method: 'PUT', body: { timeZone: f.timeZone.value, reminderHour: Number(f.reminderHour.value), amberDays: Number(f.amberDays.value), autoNextYear: f.autoNextYear.checked,
      ...Object.fromEntries(['firmName', 'firmAddress', 'firmPhone', 'firmEmail', 'firmTaxNo', 'bankDetails', 'invoiceFooter', 'invoiceFormat', 'receiptFormat'].map(k => [k, f[k].value])),
      waSenders: [...document.querySelectorAll('#cmSenders .cmSender')].map(r => ({ id: r.dataset.id || undefined, label: r.querySelector('.snLabel').value, phone: r.querySelector('.snPhone').value, open: r.querySelector('.snOpen').value, isDefault: r.querySelector('.snDefault').checked })) } });
    if (CMP.me) CMP.me.settings = CMP.settings;
    PAGE_ENTER['cm-settings']();
    toast('Settings saved', true);
  } catch (err) { toast(err.message); }
}
