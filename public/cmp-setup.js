'use strict';
/* Compliance & Deadlines setup: message templates (SRS 7), custom fields (SRS 3.3) and the module's settings. */

const CMP_SET = { templates: [], fields: [], editTpl: null, clients: null, tc: null, tcClient: '', tcOcc: '', logo: '', letterhead: '', type: null, doc: 'INVOICE', saved: null };
CMP_RESETS.push(() => Object.assign(CMP_SET, { templates: [], fields: [], editTpl: null, clients: null, tc: null, tcClient: '', tcOcc: '', logo: '', letterhead: '', type: null, doc: 'INVOICE', saved: null }));

/* ---------- message templates (the CA, 24 Nov 2026): first the country (or all, remembered), then a client of it, then the category; the
   choices stay at the top. The client's details and every obligation of it are listed in groups, closed until opened; a line clicked puts
   its placeholder in the message. ---------- */
const CMP_TPL_KEY = k => `cmpTpl${k}:${S.company || ''}`;
const cmpTplPref = (k, dflt) => { try { return localStorage.getItem(CMP_TPL_KEY(k)) ?? dflt; } catch { return dflt; } };
const cmpTplRemember = (k, v) => { try { localStorage.setItem(CMP_TPL_KEY(k), v); } catch { /* for this visit only */ } };
CMP_PAGES.push({
  id: 'cm-templates',
  html: () => `<div class="space-y-4">
    <section class="bg-white rounded-xl shadow p-3 sticky top-16 z-20 border border-slate-100">
      <div class="grid sm:grid-cols-3 gap-3">
        <label><span>1. Country</span><select id="cmTcCountry" onchange="cmpTplCountry(this.value)"></select></label>
        <label><span>2. Client <span class="text-slate-400">— its real details fill the placeholders</span></span><select id="cmTcClient" onchange="CMP_SET.tcClient = this.value; CMP_SET.tcOcc = ''; cmpTplCtxLoad()"></select></label>
        <label><span>3. Category</span><select id="cmTcCat" onchange="cmpTplRemember('Cat', this.value); CMP_SET.editTpl = null; cmpTplList()"></select></label>
      </div></section>
    <div class="grid lg:grid-cols-5 gap-4 items-start">
      <div class="min-w-0 lg:col-span-2 space-y-4">
        <section class="bg-white rounded-xl shadow p-4"><div class="flex items-center justify-between mb-3"><h2 class="font-semibold">Templates <span id="cmTplCount" class="text-sm font-normal text-slate-500"></span></h2>
          <label class="flex items-center gap-2 text-xs"><input type="checkbox" id="cmTplAll" onchange="cmpLoadTemplates()"> Show retired</label></div>
          <div id="cmTplList" class="space-y-2"></div></section>
        <section class="bg-white rounded-xl shadow p-4"><h2 class="font-semibold mb-1">A client's details</h2>
          <p class="text-xs text-slate-500 mb-2">Open a group to see each placeholder with this client's real value; click a line to put its placeholder in the message.</p>
          <div id="cmTcGroups"></div></section>
      </div>
      <section class="min-w-0 lg:col-span-3 bg-white rounded-xl shadow p-4 lg:sticky lg:top-40" id="cmTplEdit"></section></div></div>`,
  enter: async () => {
    const cc = cmpTplPref('Country', '');
    $('#cmTcCountry').innerHTML = cmpCountryOptions(cc, 'All countries');
    $('#cmTcCat').innerHTML = `<option value="ALL">All templates</option>${Object.entries(CmpRules.TEMPLATE_PURPOSES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}`;
    $('#cmTcCat').value = cmpTplPref('Cat', 'ALL'); if (!$('#cmTcCat').value) $('#cmTcCat').value = 'ALL';
    await cmpLoadTemplates();
    cmpTplCtxInit();
  },
});
const cmpTplCountryNow = () => (document.getElementById('cmTcCountry') || {}).value || '';
const cmpTplCatNow = () => (document.getElementById('cmTcCat') || {}).value || 'ALL';
function cmpTplCountry(cc) {
  cmpTplRemember('Country', cc);
  const c = (CMP_SET.clients || []).find(x => x.id === CMP_SET.tcClient);
  if (c && cc && c.country !== cc) { CMP_SET.tcClient = ''; CMP_SET.tcOcc = ''; }
  CMP_SET.editTpl = null;
  cmpTplCtxInit(); cmpTplList();
}
// A template that a client of the country chosen can use (that country's, or every country's), of the category chosen
const cmpTplShown = t => { const cc = cmpTplCountryNow(), cat = cmpTplCatNow(); return (!cc || !t.country || t.country === cc) && (cat === 'ALL' || CmpRules.templateFits({ ...t, country: '' }, cat, '')); };
// The placeholders in groups, with the client's own fields (the country's, when no client is chosen)
const cmpPlaceholderGroups = () => {
  const cc = cmpTplCountryNow(), g = CmpRules.PLACEHOLDER_GROUPS.map(([t, n]) => [t, n]);
  g.splice(1, 0, ['Additional information', CMP_SET.fields.filter(f => f.active && (!cc || f.allCountries || f.countries.includes(cc))).map(f => f.name)]);
  return g;
};
async function cmpTplCtxInit() {
  if (!CMP_SET.clients) { try { CMP_SET.clients = (await api('/api/cmp/clients')).clients; } catch { CMP_SET.clients = []; } }
  const cc = cmpTplCountryNow(), list = CMP_SET.clients.filter(c => !cc || c.country === cc);
  $('#cmTcClient').innerHTML = `<option value="">— ${list.length ? 'choose a client' : cc ? `no ${esc(cmpCountry(cc).name)} clients yet` : 'no clients yet'} (a sample is shown) —</option>` + list.map(c => `<option value="${c.id}">${cmpCountry(c.country).flag} ${esc(c.name)} (${esc(c.code)})</option>`).join('');
  if (!list.some(c => c.id === CMP_SET.tcClient)) CMP_SET.tcClient = '';
  $('#cmTcClient').value = CMP_SET.tcClient;
  cmpTplCtxLoad();
}
// One group of placeholders, closed until opened (the CA: "at start it should be minimised"); each line puts its placeholder in the message
function cmpTcGroup(title, items, { open = false, extra = '' } = {}) {
  const can = cmpCan('SETUP');
  return `<details class="border rounded-lg mb-2 group" ${open ? 'open' : ''}><summary class="cursor-pointer select-none px-3 py-2 text-sm font-medium flex items-center justify-between gap-2"><span>${esc(title)}</span><span class="text-xs text-slate-400">${items.length}</span></summary>
    <div class="px-3 pb-2">${extra}${items.map(i => `<${can ? `button type="button" data-ph="${esc(i.name)}" onclick="cmpTemplateInsert('[' + this.dataset.ph + ']')"` : 'div'} class="w-full flex gap-3 justify-between text-left text-sm py-1 border-b last:border-0 ${can ? 'hover:bg-emerald-50' : ''}">
      <span class="text-slate-500 shrink-0">[${esc(i.name)}]</span><span class="min-w-0 truncate text-right">${i.value ? esc(i.value) : '<span class="text-slate-300">—</span>'}</span></${can ? 'button' : 'div'}>`).join('') || '<p class="text-xs text-slate-400 py-1">None.</p>'}</div></details>`;
}
async function cmpTplCtxLoad() {
  if (!CMP_SET.tcClient) {
    CMP_SET.tc = null;
    $('#cmTcGroups').innerHTML = cmpPlaceholderGroups().filter(([, n]) => n.length).map(([t, names]) => cmpTcGroup(t, names.map(name => ({ name, value: '' })))).join('');
    return cmpTemplatePreview();
  }
  try { CMP_SET.tc = await api('/api/cmp/templates/context?' + cmpQs({ clientId: CMP_SET.tcClient })); } catch (err) { return toast(err.message); }
  const t = CMP_SET.tc;
  if (!CMP_SET.tcOcc || !t.obligations.some(o => o.occurrenceId === CMP_SET.tcOcc)) CMP_SET.tcOcc = t.occurrenceId || (t.obligations[0] || {}).occurrenceId || '';
  const groups = t.groups.filter(g => g.title !== 'Obligation');
  const obs = t.obligations.length ? `<details class="border rounded-lg mb-2"><summary class="cursor-pointer select-none px-3 py-2 text-sm font-medium flex items-center justify-between gap-2"><span>Obligations</span><span class="text-xs text-slate-400">${t.obligations.length}</span></summary>
      <div class="px-3 pb-2">${t.obligations.map(o => cmpTcGroup(`${o.name} · ${o.period}`, o.items, { extra: `<label class="flex items-center gap-2 text-xs text-slate-600 py-1"><input type="radio" name="cmTcOcc" value="${o.occurrenceId}" ${o.occurrenceId === CMP_SET.tcOcc ? 'checked' : ''} onchange="CMP_SET.tcOcc = this.value; cmpTemplatePreview()"> The preview uses this obligation</label>` })).join('')}</div></details>`
    : cmpTcGroup('Obligation', ((t.groups.find(g => g.title === 'Obligation') || {}).items || []).map(i => ({ name: i.name, value: '' })), { extra: '<p class="text-xs text-slate-500 py-1">This client has no obligations yet.</p>' });
  $('#cmTcGroups').innerHTML = groups.slice(0, 2).map(g => cmpTcGroup(g.title, g.items)).join('') + obs + groups.slice(2).map(g => cmpTcGroup(g.title, g.items)).join('');
  cmpTemplatePreview();
}
async function cmpLoadTemplates() {
  try {
    CMP_SET.templates = await api('/api/cmp/templates' + ($('#cmTplAll').checked ? '?all=1' : ''));
    CMP_SET.fields = await api('/api/cmp/fields?all=1');
  } catch (err) { return toast(err.message); }
  CMP.templates = CMP_SET.templates.filter(t => t.active);
  cmpTplList();
}
function cmpTplList() {
  const shown = CMP_SET.templates.filter(cmpTplShown), cc = cmpTplCountryNow(), cat = cmpTplCatNow();
  $('#cmTplCount').textContent = `· ${shown.length}${cc ? ` for ${cmpCountry(cc).name}` : ''}${cat !== 'ALL' ? ` · ${CmpRules.TEMPLATE_PURPOSES[cat]}` : ''}`;
  const used = t => t.reminders + t.docLinks;
  $('#cmTplList').innerHTML = (cmpCan('SETUP') ? `<button type="button" onclick="cmpTemplateEdit()" class="needs-write w-full text-left border-2 border-dashed rounded-lg p-3 text-sm text-emerald-700 hover:border-emerald-600">+ New template${cat !== 'ALL' ? ` (${esc(CmpRules.TEMPLATE_PURPOSES[cat])})` : ''}${cc ? ` for ${esc(cmpCountry(cc).name)}` : ''}</button>` : '')
    + (shown.map(t => `<button type="button" onclick="cmpTemplateEdit('${t.id}')" class="w-full text-left border rounded-lg p-3 hover:border-emerald-600 ${t.active ? '' : 'opacity-60'} ${CMP_SET.editTpl === t.id ? 'ring-2 ring-emerald-300' : ''}">
      <div class="flex justify-between gap-2"><span class="font-medium">${esc(t.name)}</span><span class="flex gap-1 shrink-0">${t.country ? `<span class="text-[11px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-800 whitespace-nowrap" title="${esc(cmpCountry(t.country).name)}">${cmpCountry(t.country).flag} ${esc(t.country)}</span>` : ''}
        <span class="text-[11px] px-2 py-0.5 rounded-full ${t.purpose === 'REMINDER' ? 'bg-amber-100 text-amber-900' : 'bg-slate-100'} whitespace-nowrap">${esc(CmpRules.templateCategory(t.purpose))}</span></span></div>
      <div class="text-xs text-slate-500 mt-1 line-clamp-2">${esc(t.body)}</div>
      <div class="text-[11px] text-slate-400 mt-1">${t.active ? `used by ${used(t)} obligation link${used(t) === 1 ? '' : 's'}` : 'retired'}</div></button>`).join('') || cmpEmpty(CMP_SET.templates.length ? 'No template of this country and category yet.' : 'No templates yet.'));
  const cur = CMP_SET.editTpl && shown.find(t => t.id === CMP_SET.editTpl);
  if (!cur) cmpTemplateEdit(shown[0] ? shown[0].id : null, true);
}
function cmpTemplateEdit(id, quiet) {
  const t = id ? CMP_SET.templates.find(x => x.id === id) : null, can = cmpCan('SETUP'), cat = cmpTplCatNow(), cc = cmpTplCountryNow();
  CMP_SET.editTpl = t ? t.id : null;
  if (!quiet) document.querySelectorAll('#cmTplList button').forEach(b => b.classList.remove('ring-2', 'ring-emerald-300'));
  if (!t && !can) { $('#cmTplEdit').innerHTML = cmpEmpty('Choose a template to read it.'); return; }
  // (a "Data collection" or "Obligation completed" template of before is an Others one: saved as such)
  const purpose = t ? (['DATA_COLLECTION', 'COMPLETION'].includes(t.purpose) ? 'OTHER' : t.purpose) : (cat !== 'ALL' ? cat : 'REMINDER_1');
  const cats = Object.entries(CmpRules.TEMPLATE_PURPOSES).concat(CmpRules.TEMPLATE_PURPOSES[purpose] ? [] : [[purpose, CmpRules.templateCategory(purpose)]]);
  const sample = { REMINDER_1: 'Dear [Client Name], your [Obligation] for the period [Period Start] to [Period End] is due on [Due Date] ([Days Left] left). Kindly share the required documents.\n\nRegards,\n[Firm Name]',
    ADVANCE: 'Dear [Client Name], we have received your advance payment of [Advance Amount] on [Advance Date] (receipt [Advance Number]). Thank you.\n\nRegards,\n[Firm Name]',
    INVOICE: 'Dear [Client Name], please find invoice [Invoice Number] of [Invoice Amount], due on [Payment Due].\n\nRegards,\n[Firm Name]',
    RECEIPT: 'Dear [Client Name], we have received [Receipt Amount] on [Receipt Date] (receipt [Receipt Number]). Thank you.\n\nRegards,\n[Firm Name]' }[purpose] || 'Dear [Client Name], …\n\nRegards,\n[Firm Name]';
  $('#cmTplEdit').innerHTML = `<h2 class="font-semibold mb-3">${t ? esc(t.name) : 'New template'}</h2>
    ${t && t.purpose === 'REMINDER' ? '<p class="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3">Made before reminders were told apart: choose its category (1st, 2nd or 3rd reminder) and save. Until then it is offered for all three.</p>' : ''}
    <form id="cmTplForm" onsubmit="event.preventDefault(); cmpTemplateSave()" class="space-y-3">
      <div class="grid sm:grid-cols-3 gap-3">
        <label><span>Name</span><input name="name" required maxlength="80" value="${t ? esc(t.name) : ''}" ${can ? '' : 'disabled'}></label>
        <label><span>Category</span><select name="purpose" ${can ? '' : 'disabled'}>${cats.map(([k, v]) => `<option value="${k}" ${purpose === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label><span>For clients of</span><select name="country" ${can ? '' : 'disabled'}>${cmpCountryOptions(t ? t.country : cc, 'Every country')}</select></label>
      </div>
      <label><span>Message</span><textarea id="cmTplBody" name="body" rows="9" maxlength="4000" required oninput="cmpTemplatePreview()" ${can ? '' : 'disabled'}>${esc(t ? t.body : sample)}</textarea></label>
      ${can ? '<p class="text-xs text-slate-500">To put a detail in the message, click its line under <b>A client\'s details</b> (each is replaced by that client\'s real value when the message is sent).</p>' : ''}
      ${t && t.active && t.reminders + t.docLinks ? `<p class="text-xs text-slate-500">A changed message is used at once by the obligations that use this template; a <b>locked</b> obligation keeps its version and asks to accept the new one (in its obligations window).</p>` : ''}
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
  const cc = cmpTplCountryNow() || 'AE';
  const fields = Object.fromEntries(CMP_SET.fields.filter(f => f.active).map(f => [f.name, f.type === 'DATE' ? '31 Dec 2027' : f.type === 'NUMBER' ? '12345' : `(${f.name})`]));
  const s = CMP.settings || {}, real = CMP_SET.tc, cur = cmpCurOf(cc);
  let ctx;
  if (real) {
    const ob = real.obligations.find(o => o.occurrenceId === CMP_SET.tcOcc);
    ctx = ob ? { ...real.ctx, ...ob.part } : real.ctx;
  } else ctx = {
    client: { name: 'Al Noor Trading LLC', code: 'CL0001', registrationNo: '100123456700003', email: 'accounts@alnoor.example', contactNumber: '+971501234567', address: 'Office 12, Deira', reference: 'Mr Khan' },
    countryName: cmpCountry(cc).name, obligationName: 'VAT Return', portalUrl: 'https://eservices.tax.gov.ae', daysLeft: 12, occurrence: { periodStart: '2027-01-01', periodEnd: '2027-03-31', dueDate: '2027-04-28' },
    fields, invoice: { number: 'INV-2027-0001', amountText: `${cur} 1,500.00`, date: '2027-04-30', dueDate: '2027-05-15', outstandingText: `${cur} 1,500.00` }, receipt: { number: 'RCT-2027-0001', date: '2027-05-10', amountText: `${cur} 1,500.00` },
    advance: { number: 'ADV-2027-0001', date: '2027-03-01', amountText: `${cur} 500.00`, description: 'Advance for VAT return', balanceText: `${cur} 500.00` },
    firm: { name: s.firmName || 'Your firm', phone: s.firmPhone || '+92 300 0000000', email: s.firmEmail || 'office@yourfirm.example', address: s.firmAddress || '', website: s.firmWebsite || '' },
  };
  const who = document.getElementById('cmTplPrevFor');
  if (who) who.textContent = real ? `Preview for ${real.client.name} (${real.client.code})${ctx.obligationName ? ` · ${ctx.obligationName}` : ''}` : 'Preview with a sample client (choose a real one at the top)';
  const r = CmpRules.render($('#cmTplBody').value, ctx);
  box.innerHTML = esc(r.text) + (r.missing.length ? `<div class="mt-2 text-xs text-amber-800">Not known (left as typed): ${r.missing.map(x => `[${esc(x)}]`).join(' ')}</div>` : '');
}
async function cmpTemplateSave() {
  const f = $('#cmTplForm'), body = { name: f.name.value, purpose: f.purpose.value, country: f.country.value, body: f.body.value }, id = CMP_SET.editTpl;
  try {
    const t = await api(id ? `/api/cmp/templates/${id}` : '/api/cmp/templates', { method: id ? 'PUT' : 'POST', body });
    CMP_SET.editTpl = t.id;
    toast(t.kept ? `Template saved. ${t.kept} locked obligation link${t.kept === 1 ? ' keeps' : 's keep'} the earlier version until accepted (unlock it in the obligations window).` : 'Template saved', true);
    // a saved template shows in the list even when the filters at the top were for something else
    if (!cmpTplShown(t)) { $('#cmTcCat').value = 'ALL'; cmpTplRemember('Cat', 'ALL'); }
    cmpLoadTemplates();
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
    <div class="flex flex-wrap items-start justify-between gap-3 mb-3"><div><h2 class="font-semibold">Additional information</h2>
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
        <label><span>Type</span><select name="type">${Object.entries(CMP_FIELD_TYPES).map(([k, v]) => `<option value="${k}" ${(f ? f.type : 'TEXT') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      </div>
      <div class="text-sm space-y-1"><div class="font-medium text-slate-700">Show it for</div>
        <label class="flex items-center gap-2"><input type="radio" name="scope" value="some" ${scope === 'some' ? 'checked' : ''} onchange="$('#cmFldCountries').disabled = false"> These countries</label>
        <label class="flex items-center gap-2"><input type="radio" name="scope" value="all" ${scope === 'all' ? 'checked' : ''} onchange="$('#cmFldCountries').disabled = true"> All countries</label>
        <select id="cmFldCountries" multiple size="8" ${scope === 'all' ? 'disabled' : ''}>${CmpCountries.list.map(c => `<option value="${c.code}" ${f && f.countries.includes(c.code) ? 'selected' : ''}>${c.flag} ${esc(c.name)}</option>`).join('')}</select>
        <p class="text-xs text-slate-500">Hold Ctrl (or ⌘ on a Mac) to choose several.</p></div>
      ${f ? `<p class="text-xs text-slate-500">Renaming a field does not change templates that use its old name in [brackets]: update them too.${f.values ? ` A new type keeps the ${f.values} value${f.values === 1 ? '' : 's'} already typed (a date becomes text like "1 Jun 2023"; text becomes a date or a number only where it reads as one).` : ''}</p>` : ''}
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseModal()')}<button class="px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">${f ? 'Save' : 'Add field'}</button></div>
    </form>`);
  CMP_SET.editField = id || null;
}
async function cmpFieldSave() {
  const form = $('#cmFldForm'), all = form.scope.value === 'all', id = CMP_SET.editField;
  const body = { name: form.name.value, allCountries: all, countries: all ? [] : [...$('#cmFldCountries').selectedOptions].map(o => o.value) };
  body.type = form.type.value;
  try { await api(id ? `/api/cmp/fields/${id}` : '/api/cmp/fields', { method: id ? 'PUT' : 'POST', body }); cmpCloseModal(); toast('Field saved', true); cmpLoadFields(); }
  catch (err) { toast(err.message); }
}
async function cmpFieldActive(id, active) {
  if (!active && !confirm('Retire this field? Its values are kept but hidden, and it stops showing as missing.')) return;
  try { await api(`/api/cmp/fields/${id}`, { method: 'PUT', body: { active } }); cmpLoadFields(); } catch (err) { toast(err.message); }
}

/* ---------- Settings (the CA's "Deadline Tracker - Settings" sheet, 24 Nov 2026): general, the firm's profile, reminders (weekends and public
   holidays), WhatsApp numbers, notifications, users and access, security. What is about invoices and receipts has its own page. ---------- */
const CMP_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
CMP_PAGES.push({
  id: 'cm-settings',
  html: () => `<div class="grid lg:grid-cols-[13rem_minmax(0,1fr)] gap-4 items-start">
    <nav class="bg-white rounded-xl shadow p-2 lg:sticky lg:top-20 text-sm" id="cmSetNav"></nav>
    <div id="cmSettings" class="space-y-4 max-w-4xl min-w-0"></div></div>`,
  enter: async () => {
    let s;
    try { s = await api('/api/cmp/settings'); } catch (err) { return toast(err.message); }
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = [s.timeZone]; }
    if (!zones.includes(s.timeZone)) zones.unshift(s.timeZone);
    const can = cmpCan('FULL'), dis = can ? '' : 'disabled';
    CMP_SET.logo = s.logo || ''; CMP_SET.saved = s;
    const sec = (id, title, sub, inner) => `<section id="cmSet-${id}" class="bg-white rounded-xl shadow p-4 scroll-mt-20"><h2 class="font-semibold">${title}</h2>${sub ? `<p class="text-xs text-slate-500 mb-3">${sub}</p>` : '<div class="mb-3"></div>'}${inner}</section>`;
    const sections = [['general', 'General settings'], ['firm', 'Firm profile'], ['reminders', 'Reminder settings'], ['whatsapp', 'WhatsApp settings'], ['notify', 'Notification settings'], ['users', 'Users and access'], ['security', 'Security']];
    $('#cmSetNav').innerHTML = sections.map(([id, t]) => `<a href="#" class="block px-3 py-2 rounded-lg hover:bg-emerald-50" onclick="event.preventDefault(); document.getElementById('cmSet-${id}').scrollIntoView({ behavior: 'smooth' })">${t}</a>`).join('');
    const notifyHtml = typeof cmpNotifySettingsHtml === 'function' ? cmpNotifySettingsHtml(s, can) : '<p class="text-sm text-slate-500">The notifications are set on the Notifications page (the bell at the top right).</p>';
    $('#cmSettings').innerHTML = `<form id="cmGenForm" onsubmit="event.preventDefault(); cmpSettingsSave()" class="space-y-4">
      ${sec('general', 'General settings', 'Essential: how times, dates and numbers are shown on every screen, document and report.', `<div class="grid sm:grid-cols-3 gap-3">
        <label><span>Firm time zone <span class="text-slate-400">— the times in the logs and lists</span></span><select name="timeZone" ${dis}>${zones.map(z => `<option value="${esc(z)}" ${z === s.timeZone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select></label>
        <label><span>Date format</span><select name="dateFormat" ${dis}>${Object.entries(CmpRules.DAY_FORMATS).map(([k, v]) => `<option value="${esc(k)}" ${k === s.dateFormat ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label><span>Number format</span><select name="numberFormat" ${dis}>${Object.entries(CmpRules.NUMBER_FORMATS).map(([k, v]) => `<option value="${esc(k)}" ${k === s.numberFormat ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label></div>`)}
      ${sec('firm', 'Firm profile', 'Shown on your documents and in messages: [Firm Name], [Firm Phone], [Firm Email], [Firm Address], [Firm Website].', `<div class="grid sm:grid-cols-2 gap-3">
        <label class="sm:col-span-2"><span>Firm name</span><input name="firmName" maxlength="200" value="${esc(s.firmName)}" ${dis}></label>
        <label class="sm:col-span-2"><span>Firm address</span><textarea name="firmAddress" rows="2" maxlength="500" ${dis}>${esc(s.firmAddress)}</textarea></label>
        <label><span>Country</span><select name="firmCountry" ${dis}>${cmpCountryOptions(s.firmCountry, '—')}</select></label>
        <label><span>City</span><input name="firmCity" maxlength="80" value="${esc(s.firmCity || '')}" ${dis}></label>
        <label><span>Contact number</span><input name="firmPhone" maxlength="40" inputmode="tel" value="${esc(s.firmPhone)}" ${dis}></label>
        <label><span>Email address</span><input name="firmEmail" type="email" maxlength="200" value="${esc(s.firmEmail)}" ${dis}></label>
        <label class="sm:col-span-2"><span>Website</span><input name="firmWebsite" maxlength="200" placeholder="www.yourfirm.com" value="${esc(s.firmWebsite || '')}" ${dis}></label>
        <div class="sm:col-span-2"><span class="block text-sm font-medium text-slate-700 mb-1">Firm logo</span>
          <div class="flex flex-wrap items-center gap-3"><div id="cmLogoBox" class="h-16 min-w-[4rem] border rounded-lg bg-slate-50 flex items-center justify-center p-1">${s.logo ? `<img src="${esc(s.logo)}" alt="Logo" class="max-h-14 max-w-[12rem]">` : '<span class="text-xs text-slate-400 px-2">No logo</span>'}</div>
            ${can ? `<label class="px-3 min-h-[2.5rem] inline-flex items-center rounded-lg text-sm border bg-white hover:border-emerald-600 cursor-pointer">Choose a picture…<input type="file" accept="image/png,image/jpeg,image/webp" class="hidden" onchange="cmpLogoPick(this)"></label>
              <button type="button" class="text-sm text-red-600 underline" onclick="CMP_SET.logo = ''; $('#cmLogoBox').innerHTML = '<span class=&quot;text-xs text-slate-400 px-2&quot;>No logo</span>'">Remove</button>` : ''}</div></div></div>`)}
      ${sec('reminders', 'Reminder settings', 'A reminder comes due at this hour on the client\'s own clock. When the firm says so, a reminder that falls on a weekend day or a public holiday moves to a working day.', `<div class="space-y-3">
        <label class="max-w-xs"><span>Reminders come due at</span><select name="reminderHour" ${dis}>${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === s.reminderHour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label>
        <div><span class="block text-sm font-medium text-slate-700 mb-1">Weekend days</span><div class="flex flex-wrap gap-3">${CMP_WEEKDAYS.map((d, i) => `<label class="flex items-center gap-1.5 text-sm"><input type="checkbox" class="cmWkd" value="${i}" ${(s.weekendDays || []).includes(i) ? 'checked' : ''} ${dis}> ${d}</label>`).join('')}</div></div>
        <label class="max-w-md"><span>A reminder on a weekend day or a public holiday</span><select name="holidayMode" ${dis}>${[['NONE', 'Stays on its day'], ['BEFORE', 'Moves to the working day before'], ['AFTER', 'Moves to the next working day']].map(([k, v]) => `<option value="${k}" ${k === (s.holidayMode || 'NONE') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <div><div class="flex items-center justify-between"><span class="text-sm font-medium text-slate-700">Public holidays</span>${can ? '<button type="button" class="text-sm text-emerald-700 underline" onclick="cmpHolidayRow()">+ Add a holiday</button>' : ''}</div>
          <div id="cmHolidays" class="space-y-2 mt-2"></div></div></div>`)}
      ${sec('whatsapp', 'WhatsApp settings', 'The firm\'s numbers that messages go from. WhatsApp always sends from the account open where the message opens: say how each is opened here (WhatsApp Web: log in to web.whatsapp.com with that number in this browser; WhatsApp Business app). An inactive number is not offered in the send window.', `
        <div id="cmSenders" class="space-y-2"></div>
        ${can ? '<button type="button" class="text-sm text-emerald-700 underline mt-2" onclick="cmpSenderRow()">+ Add a WhatsApp number</button>' : ''}`)}
      ${sec('notify', 'Notification settings', 'In-app notifications for your team: which are made, and when. Their trigger days are on the Notifications page (the bell at the top right).', notifyHtml)}
      ${sec('security', 'Security', '', `<div class="space-y-3">
        <div class="flex flex-wrap items-end gap-3"><label class="w-56"><span>Session timeout <span class="text-slate-400">— signed out after</span></span><select name="sessionMinutes" ${dis}>${[15, 30, 60, 120, 240, 480].map(m => `<option value="${m}" ${m === (s.sessionMinutes || 30) ? 'selected' : ''}>${m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`} without activity</option>`).join('')}</select></label></div>
        <div class="flex flex-wrap gap-2">${cmpBtn('Change my password', 'openPw(false)')}${cmpBtn('Sign out my other sessions', 'cmpSignOutOthers()')}</div>
        <p class="text-xs text-slate-500">Two-factor sign-in is not available yet. "Sign out my other sessions" ends every other place where you are signed in (another computer, a phone); this one stays.</p>
        <div><div class="flex items-center justify-between"><h3 class="text-sm font-semibold">Login activity</h3>${cmpBtn('Show', 'cmpLoginActivity()')}</div><div id="cmLogins" class="mt-2"></div></div></div>`)}
      ${can ? '<div class="sticky bottom-2 z-10 flex justify-end"><button class="needs-write px-5 min-h-[2.75rem] rounded-lg bg-emerald-700 text-white text-sm font-medium shadow-lg">Save settings</button></div>' : '<p class="text-xs text-slate-500">Only a user with full access changes these settings.</p>'}
    </form>
    ${sec('users', 'Users and access', 'Your firm\'s users. What each may do in Compliance &amp; Deadlines (roles and permissions, access restrictions) is set by the ETAX administrator: ask them to change it.', '<div id="cmUsers"><p class="text-sm text-slate-500">Loading…</p></div>')}`;
    // (Users and access is outside the form: its changes are made at once, one user at a time)
    const usersSec = document.getElementById('cmSet-users'); document.getElementById('cmSet-security').before(usersSec);
    (s.holidays || []).forEach(h => cmpHolidayRow(h, can));
    (s.waSenders || []).forEach(x => cmpSenderRow(x, can));
    cmpUsersLoad();
  },
});
function cmpHolidayRow(h = { date: '', name: '' }, can = true) {
  const dis = can ? '' : 'disabled';
  $('#cmHolidays').insertAdjacentHTML('beforeend', `<div class="cmHoliday flex flex-wrap items-end gap-2"><label class="w-44"><span class="sr-only">Date</span><input type="date" class="hdDate" value="${esc(h.date)}" ${dis}></label>
    <label class="flex-1 min-w-[10rem]"><span class="sr-only">Name</span><input class="hdName" maxlength="80" placeholder="e.g. National Day" value="${esc(h.name || '')}" ${dis}></label>
    ${can ? '<button type="button" class="px-2 min-h-[2.5rem] text-red-600" onclick="this.closest(\'.cmHoliday\').remove()" aria-label="Remove">✕</button>' : ''}</div>`);
}
function cmpSenderRow(x = { label: 'Business WhatsApp', phone: '', open: 'WEB', isDefault: !document.querySelector('#cmSenders .cmSender'), active: true }, can = true) {
  const dis = can ? '' : 'disabled';
  $('#cmSenders').insertAdjacentHTML('beforeend', `<div class="cmSender flex flex-wrap items-end gap-2 bg-slate-50 border rounded-lg p-2" data-id="${esc(x.id || '')}">
    <label class="flex-1 min-w-[9rem]"><span>Account name</span><input class="snLabel" maxlength="60" value="${esc(x.label)}" ${dis}></label>
    <label class="w-48"><span>WhatsApp number</span><input class="snPhone" maxlength="20" inputmode="tel" placeholder="+92 333 1234567" value="${esc(x.phone)}" ${dis}></label>
    <label class="w-56"><span>Opens with</span><select class="snOpen" ${dis}>${Object.entries(CmpRules.SENDER_OPEN).map(([k, v]) => `<option value="${k}" ${x.open === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
    <label class="flex items-center gap-1 text-sm min-h-[2.5rem]"><input type="radio" name="snDefault" class="snDefault" ${x.isDefault ? 'checked' : ''} ${dis}> Default</label>
    <label class="flex items-center gap-1 text-sm min-h-[2.5rem]"><input type="checkbox" class="snActive" ${x.active !== false ? 'checked' : ''} ${dis}> Active</label>
    ${can ? '<button type="button" class="px-2 min-h-[2.5rem] text-red-600" onclick="this.closest(\'.cmSender\').remove()" aria-label="Remove">✕</button>' : ''}</div>`);
}
async function cmpSettingsSave() {
  const f = $('#cmGenForm');
  const body = {
    ...Object.fromEntries(['timeZone', 'dateFormat', 'numberFormat', 'firmName', 'firmAddress', 'firmCountry', 'firmCity', 'firmPhone', 'firmEmail', 'firmWebsite', 'holidayMode'].map(k => [k, f[k].value])),
    reminderHour: Number(f.reminderHour.value), sessionMinutes: Number(f.sessionMinutes.value), logo: CMP_SET.logo,
    weekendDays: [...document.querySelectorAll('.cmWkd:checked')].map(el => Number(el.value)),
    holidays: [...document.querySelectorAll('#cmHolidays .cmHoliday')].map(r => ({ date: r.querySelector('.hdDate').value, name: r.querySelector('.hdName').value })).filter(h => h.date || h.name),
    waSenders: [...document.querySelectorAll('#cmSenders .cmSender')].map(r => ({ id: r.dataset.id || undefined, label: r.querySelector('.snLabel').value, phone: r.querySelector('.snPhone').value, open: r.querySelector('.snOpen').value, isDefault: r.querySelector('.snDefault').checked, active: r.querySelector('.snActive').checked })),
    ...(typeof cmpNotifySettingsRead === 'function' ? cmpNotifySettingsRead() : {}),
  };
  try {
    CMP.settings = await api('/api/cmp/settings', { method: 'PUT', body });
    if (CMP.me) CMP.me.settings = CMP.settings;
    cmpApplyFormats();
    PAGE_ENTER['cm-settings']();
    toast('Settings saved', true);
  } catch (err) { toast(err.message); }
}
// The firm's users (the owner sees and changes them: add, enable or disable, role, password); what each may do in this module is the
// ETAX administrator's to set, and shows here read-only
async function cmpUsersLoad() {
  const box = document.getElementById('cmUsers'); if (!box) return;
  let list;
  try { list = await api('/api/client/users'); } catch {
    box.innerHTML = `<p class="text-sm text-slate-500">Only the firm's owner manages its users. Ask them, or the ETAX administrator.</p>${(CMP.me && CMP.me.team || []).length ? `<ul class="text-sm mt-2 list-disc pl-5">${CMP.me.team.map(u => `<li>${esc(u.name || u.email)} <span class="text-slate-500">${esc(u.email)}</span></li>`).join('')}</ul>` : ''}`;
    return;
  }
  CMP_SET.users = list;
  const role = r => ({ OWNER: 'Owner', ACCOUNTANT: 'Accountant', CASHIER: 'Cashier' }[r] || r);
  const perms = u => (u.cmpPerms || []).length ? u.cmpPerms.map(p => `<span class="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 mr-1 whitespace-nowrap">${esc(((CmpPerms.PERMS || []).find(x => x.id === p) || {}).label || p)}</span>`).join('') : '<span class="text-xs text-slate-400">no access to this module</span>';
  box.innerHTML = `<div class="flex justify-end mb-2">${cmpBtn('+ Add user', 'cmpUserAdd()', 'primary', 'needs-write')}</div>
    <div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-1">User</th><th>Role</th><th>Compliance permissions</th><th>Last login</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(u => `<tr class="border-b last:border-0 ${u.active ? '' : 'opacity-60'}"><td class="py-1.5"><b>${esc(u.name || '—')}</b><div class="text-xs text-slate-500">${esc(u.email)}</div></td>
      <td><select class="!w-auto !py-1 text-sm" onchange="cmpUserSet('${u.id}', { tenantRole: this.value }, 'Role changed (the user is signed out to take it)')" ${u.pendingApproval ? 'disabled' : ''}>${['OWNER', 'ACCOUNTANT', 'CASHIER'].map(r => `<option value="${r}" ${r === u.tenantRole ? 'selected' : ''}>${role(r)}</option>`).join('')}</select></td>
      <td class="max-w-[18rem]">${perms(u)}</td><td class="text-xs whitespace-nowrap">${u.lastLoginAt ? esc(cmpAt(u.lastLoginAt)) : '—'}</td>
      <td class="text-xs">${u.pendingApproval ? '<span class="text-amber-700">waiting for the administrator</span>' : u.locked ? '<span class="text-red-700">locked</span>' : u.active ? 'Active' : 'Inactive'}</td>
      <td class="text-right whitespace-nowrap">${u.pendingApproval ? '' : `${cmpBtn(u.active ? 'Deactivate' : 'Activate', `cmpUserActive('${u.id}', ${!u.active})`, u.active ? 'danger' : 'plain', 'needs-write')} ${cmpBtn('Reset password', `cmpUserReset('${u.id}')`, 'plain', 'needs-write')}`}</td></tr>`).join('')}</tbody></table></div>
    <p class="text-xs text-slate-500 mt-2">A new user waits for the ETAX administrator's approval before signing in. Deactivating signs the user out at once and keeps their history; deleting a user is done by the ETAX administrator.</p>`;
}
async function cmpUserSet(id, body, msg) {
  try { await api(`/api/client/users/${id}`, { method: 'PATCH', body }); toast(msg, true); } catch (err) { toast(err.message); }
  cmpUsersLoad();
}
function cmpUserActive(id, active) {
  const u = (CMP_SET.users || []).find(x => x.id === id); if (!u) return;
  if (!active && !confirm(`Deactivate ${u.email}? They are signed out at once and cannot sign in until activated again. Their history stays.`)) return;
  cmpUserSet(id, { active }, active ? 'User activated' : 'User deactivated');
}
function cmpUserAdd() {
  cmpShowModal(`${cmpModalHead('Add a user', 'They wait for the ETAX administrator\'s approval, then sign in with this password and choose their own.')}
    <form id="cmUserForm" onsubmit="event.preventDefault(); cmpUserAddSave()" class="space-y-3">
      <div class="grid sm:grid-cols-2 gap-3"><label><span>Name</span><input name="name" maxlength="100" required></label><label><span>Email (their login)</span><input name="email" type="email" required maxlength="200"></label>
        <label><span>Role</span><select name="tenantRole"><option value="ACCOUNTANT">Accountant</option><option value="CASHIER">Cashier</option><option value="OWNER">Owner</option></select></label>
        <label><span>First password</span><input name="password" type="text" required minlength="8" maxlength="100" autocomplete="new-password"></label></div>
      <div class="flex justify-end gap-2">${cmpBtn('Cancel', 'cmpCloseModal()')}<button class="needs-write px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">Add user</button></div></form>`);
}
async function cmpUserAddSave() {
  const f = $('#cmUserForm');
  try { await api('/api/client/users', { method: 'POST', body: { name: f.name.value, email: f.email.value, tenantRole: f.tenantRole.value, password: f.password.value } }); cmpCloseModal(); toast('User added: waiting for the administrator\'s approval', true); cmpUsersLoad(); }
  catch (err) { toast(err.message); }
}
async function cmpUserReset(id) {
  const u = (CMP_SET.users || []).find(x => x.id === id); if (!u) return;
  const pw = prompt(`A new password for ${u.email} (they choose their own at the next sign-in):`); if (!pw) return;
  try { await api(`/api/client/users/${id}/reset-password`, { method: 'POST', body: { password: pw } }); toast('Password reset', true); } catch (err) { toast(err.message); }
}
async function cmpSignOutOthers() {
  if (!confirm('Sign out of every other session (other computers and phones)? This one stays signed in.')) return;
  try { const r = await api('/api/cmp/security/signout-others', { method: 'POST' }); S.token = r.token; saveSession(); toast('Every other session is signed out', true); } catch (err) { toast(err.message); }
}
async function cmpLoginActivity() {
  const box = $('#cmLogins');
  let d;
  try { d = await api('/api/cmp/security/logins'); } catch (err) { box.innerHTML = cmpEmpty(esc(err.message)); return; }
  const what = { 'auth.login': 'Signed in', 'auth.login_failed': 'Failed sign-in', 'auth.locked': 'Locked (too many tries)' };
  box.innerHTML = `<p class="text-xs text-slate-500 mb-1">${d.all ? 'Your firm\'s users' : 'Your own'} · the last ${d.rows.length}</p><div class="overflow-x-auto max-h-80"><table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-1">When</th><th>User</th><th>What</th><th>From</th></tr></thead><tbody>
    ${d.rows.map(r => `<tr class="border-b last:border-0 ${r.action === 'auth.login' ? '' : 'text-red-700'}"><td class="py-1 whitespace-nowrap">${esc(CmpRules.fmtAt(new Date(r.createdAt), d.timeZone))}</td><td>${esc(r.userEmail)}</td><td>${esc(what[r.action] || r.action)}</td><td class="text-xs text-slate-500">${esc(r.ip || '')}</td></tr>`).join('') || `<tr><td colspan="4">${cmpEmpty('Nothing yet.')}</td></tr>`}</tbody></table></div>`;
}

/* ---------- Invoice and Receipt Format (the CA, 24 Nov 2026): the country first (as when a client is added), then its Advance Payment, Invoice
   and Receipt formats, each in its own list with the standard format at the top. A format opens in its own window: what it says on the left
   (the client's details and the automatic information ticked one by one, extra information dragged anywhere), how it looks on the right. ---------- */
const CMP_FMT_KINDS = [['ADVANCE', 'Advance Payment Formats', 'advance payment'], ['INVOICE', 'Invoice Formats', 'invoice'], ['RECEIPT', 'Receipt Formats', 'receipt']];
const cmpFmtPref = (k, dflt) => { try { return localStorage.getItem(`cmpFmt${k}:${S.company || ''}`) || dflt; } catch { return dflt; } };
const cmpFmtRemember = (k, v) => { try { localStorage.setItem(`cmpFmt${k}:${S.company || ''}`, v); } catch { /* for this visit only */ } };
CMP_PAGES.push({
  id: 'cm-formats',
  html: () => `<div class="space-y-4">
    <section class="bg-white rounded-xl shadow p-4"><div class="flex flex-wrap items-end gap-3">
      <label class="w-full sm:w-72"><span>1. Country</span><select id="cmFmtCountry" onchange="cmpFmtRemember('Country', this.value); cmpFmtList()"></select></label>
      <div><span class="block text-sm font-medium text-slate-700 mb-1">2. Documents</span><div role="tablist" id="cmFmtTabs" class="flex flex-wrap bg-slate-100 rounded-xl p-1"></div></div>
      <label class="flex-1 min-w-[12rem]"><span>Search</span><input id="cmFmtQ" type="search" placeholder="Search the formats: name, title, country" oninput="clearTimeout(CMP_SET.typeT); CMP_SET.typeT = setTimeout(cmpFmtList, 250)"></label>
    </div></section>
    <section id="cmFmtList" class="bg-white rounded-xl shadow p-4"></section></div>`,
  enter: async () => {
    let s;
    try { [s] = await Promise.all([api('/api/cmp/settings'), cmpInvoiceTypes(null, true), CMP_SET.fields.length ? null : api('/api/cmp/fields?all=1').then(f => { CMP_SET.fields = f; })]); } catch (err) { return toast(err.message); }
    CMP_SET.saved = s; CMP_SET.logo = s.logo || ''; CMP_SET.letterhead = s.letterhead || '';
    const used = (CMP_INV.types || []).map(t => t.country);
    $('#cmFmtCountry').innerHTML = cmpCountryOptions(cmpFmtPref('Country', used[0] || ''), 'Choose a country…');
    cmpFmtList();
  },
});
const cmpFmtKind = () => cmpFmtPref('Kind', 'INVOICE');
function cmpFmtList() {
  const box = document.getElementById('cmFmtList'); if (!box) return;
  const cc = $('#cmFmtCountry').value, kind = cmpFmtKind(), [, kindTitle, word] = CMP_FMT_KINDS.find(k => k[0] === kind), can = cmpCan('FULL');
  $('#cmFmtTabs').innerHTML = CMP_FMT_KINDS.map(([k, label]) => `<button type="button" class="seg-btn ${k === kind ? 'on' : ''}" onclick="cmpFmtRemember('Kind', '${k}'); cmpFmtList()">${esc(label)}</button>`).join('');
  if (!cc) { box.innerHTML = cmpEmpty('Choose a country first: its formats show here (as when a client is added, the country comes first).'); return; }
  const q = CmpRules.keyOf($('#cmFmtQ').value || '');
  const titleOf = t => (kind === 'ADVANCE' ? t.layout.advanceTitle : kind === 'RECEIPT' ? t.layout.receiptTitle : t.layout.invoiceTitle) || '';
  const list = (CMP_INV.types || []).filter(t => (t.kind || 'INVOICE') === kind && t.country === cc && (!q || [t.name, titleOf(t), cmpCountry(t.country).name].some(x => CmpRules.keyOf(x).includes(q))));
  box.innerHTML = `<div class="flex flex-wrap items-start justify-between gap-2 mb-3"><div><h2 class="font-semibold">${esc(kindTitle)} · ${cmpFlagName(cc)}</h2>
      <p class="text-xs text-slate-500 max-w-2xl">Any number for ${esc(cmpCountry(cc).name)}, e.g. "UAE - Dubai" and "UAE - Sharjah", one of them the default: a${kind === 'INVOICE' || kind === 'ADVANCE' ? 'n' : ''} ${esc(word)} of a client of ${esc(cmpCountry(cc).name)} starts with it. Click a format to change it.</p></div>
      ${can ? cmpBtn(`+ Add ${esc(word)} format`, `cmpTypeEdit(null, '${kind}')`, 'primary', 'needs-write') : ''}</div>
    <div class="space-y-2">
      <button type="button" class="w-full text-left border rounded-lg px-3 py-2 hover:border-emerald-600 bg-slate-50" onclick="cmpFmtStdOpen('${kind}')"><b>The standard format</b> <span class="text-xs text-slate-500">— used when ${esc(cmpCountry(cc).name)} has no ${esc(word)} format of its own: the logo, the header or letterhead, the firm's details, bank details, footer and the number formats</span></button>
      ${list.map(t => `<div class="flex flex-wrap items-center justify-between gap-2 border rounded-lg px-3 py-2 ${t.active ? '' : 'opacity-60'}">
        <button type="button" class="text-left text-sm flex-1 min-w-0 hover:underline" onclick="cmpTypeEdit('${t.id}')"><b>${esc(t.name)}</b>${t.isDefault ? ' <span class="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">default</span>' : ''}${t.active ? '' : ' <span class="text-xs text-slate-500">(retired)</span>'} <span class="text-xs text-slate-500">· ${esc(titleOf(t) || kind)} · ${(t.layout.blocks || []).length} extra</span></button>
        <span class="flex gap-2">${cmpBtn(can ? 'Edit' : 'See', `cmpTypeEdit('${t.id}')`)}${can && !t.isDefault && t.active ? cmpBtn('Make default', `cmpTypeDefault('${t.id}')`, 'plain', 'needs-write') : ''}${can ? cmpBtn('Delete', `cmpTypeDelete('${t.id}')`, 'danger', 'needs-write') : ''}</span></div>`).join('')
      || `<p class="text-xs text-slate-500 px-1">${q ? 'None matches.' : `No ${esc(word)} format for ${esc(cmpCountry(cc).name)} yet: every ${esc(word)} there uses the standard format.`}</p>`}</div>`;
}
// A sample client of the country (with a value in each of its additional fields) and sums in its currency, to show a format
function cmpSampleClient(country) {
  const fields = CMP_SET.fields.filter(f => f.active && (f.allCountries || f.countries.includes(country)));
  return { client: { name: 'Al Noor Trading LLC', code: 'CL0001', country, address: 'Office 12, Al Rigga Road, Deira', registrationNo: '100123456700003', contactNumber: '+971501234567', email: 'accounts@alnoor.example', reference: 'Mr Khan' },
    clientFields: fields.map(f => ({ id: f.id, name: f.name, value: f.type === 'DATE' ? CmpRules.fmtDay('2027-12-31') : f.type === 'NUMBER' ? '123456' : `(${f.name})` })) };
}
function cmpSampleInvoice(country) {
  const cur = cmpCurOf(country), today = CmpRules.dayIn(cmpTz());
  return { ...cmpSampleClient(country), currency: cur, number: 'INV-2026-0042', status: 'SENT', issueDate: today, dueDate: CmpRules.addDays(today, 15), createdAt: new Date().toISOString(),
    lines: [{ description: 'VAT Return Q1 — Jan – Mar 2026', amount: 1500 }, { description: 'Bookkeeping (quarter)', amount: 900 }], discount: 100, charges: 50,
    taxes: [{ name: 'VAT', rate: 5, amount: 117.5 }], subtotal: 2400, total: 2467.5, advanceAdjusted: 500, advanceDetails: [{ amount: 1000, adjusted: 500, used: 500, receivedOn: today, description: 'Advance' }],
    received: 0, outstanding: 1967.5, notes: '' };
}
function cmpSampleDoc(kind, country) {
  const inv = cmpSampleInvoice(country), today = inv.issueDate;
  if (kind === 'RECEIPT') return { inv: { ...inv, received: 1967.5, outstanding: 0, status: 'RECEIVED' }, receipt: { number: 'RCT-2026-0007', receivedOn: today, amount: 1967.5, method: 'BANK', reference: 'TT-1234', paidToDate: 1967.5, paymentStatus: 'PAID', clientBalanceAfter: 0, createdAt: inv.createdAt } };
  if (kind === 'ADVANCE') return { ...cmpSampleClient(country), number: 'ADV-2026-0003', receivedOn: today, description: 'Advance for the VAT return Q1', currency: inv.currency, amount: 1000, used: 0, available: 1000, method: 'BANK', reference: 'TT-5678', status: 'ACTIVE', clientTotal: 1500, clientOutstanding: 1500, createdAt: inv.createdAt };
  return inv;
}
// The standard format as it is typed (the preview follows it before it is saved)
function cmpSetNow() {
  const f = document.getElementById('cmSetForm'); if (!f) return { ...(CMP.settings || {}), ...(CMP_SET.saved || {}) };
  const style = (f.querySelector('input[name="headerStyle"]:checked') || {}).value || 'LOGO';
  return { ...(CMP_SET.saved || {}), logo: CMP_SET.logo, letterhead: CMP_SET.letterhead, headerStyle: style,
    ...Object.fromEntries(['firmName', 'firmAddress', 'firmPhone', 'firmEmail', 'firmTaxNo', 'bankDetails', 'invoiceFooter', 'invoiceHeader'].map(k => [k, f[k].value])) };
}
function cmpSetPreviewSoon() { clearTimeout(CMP_SET.prevTimer); CMP_SET.prevTimer = setTimeout(cmpSetPreview, 150); }
// The document of the window open (a format being edited, or the standard format), drawn on the right
function cmpSetPreview() {
  const box = document.getElementById('cmSetPrev'); if (!box) return;
  const t = CMP_SET.type, kind = t ? t.kind || 'INVOICE' : CMP_SET.stdKind || 'INVOICE', cc = t ? t.country : $('#cmFmtCountry') ? $('#cmFmtCountry').value || 'AE' : 'AE';
  box.innerHTML = cmpDocRender(kind, cmpSampleDoc(kind, cc), cmpSetNow(), { layout: t ? t.layout : {}, edit: Boolean(t) });
  cmpFitDocs(box.parentElement.parentElement);
  if (t) cmpDragBind(box);
}
const cmpFmtWindow = (title, sub, left) => `${cmpModalHead(title, sub)}
  <div class="grid xl:grid-cols-[minmax(0,34rem)_minmax(0,1fr)] gap-5 items-start">
    <div class="min-w-0 max-h-[78vh] overflow-y-auto pr-1">${left}</div>
    <aside class="min-w-0 xl:sticky xl:top-2"><div class="text-xs text-slate-500 mb-1">How it looks — a sample client and sums${CMP_SET.type ? '; drag the extra information (dashed boxes) to place it' : ''}</div>
      <div class="border rounded-lg bg-slate-50 overflow-auto max-h-[78vh] p-2"><div id="cmSetPrev" class="cmpDocFit bg-white shadow mx-auto" style="width:max-content"></div></div></aside></div>`;
// The standard format (the firm's own details for every document), in its window, shown as the kind of document chosen
function cmpFmtStdOpen(kind) {
  const s = CMP_SET.saved || {}, can = cmpCan('FULL'), dis = can ? '' : 'disabled';
  CMP_SET.type = null; CMP_SET.stdKind = kind;
  cmpShowModal(cmpFmtWindow('The standard format', 'Every invoice, receipt and advance payment receipt, unless a format of its country says otherwise', `
    <form id="cmSetForm" onsubmit="event.preventDefault(); cmpFmtStdSave()" oninput="cmpSetPreviewSoon()" onchange="cmpSetPreviewSoon()" class="space-y-4">
      <div class="grid sm:grid-cols-2 gap-3">
        <div class="sm:col-span-2"><span class="block text-sm font-medium text-slate-700 mb-1">Logo <span class="text-slate-400 font-normal">(PNG or JPEG; shown at the top left)</span></span>
          <div class="flex flex-wrap items-center gap-3"><div id="cmLogoBox" class="h-16 min-w-[4rem] border rounded-lg bg-slate-50 flex items-center justify-center p-1">${CMP_SET.logo ? `<img src="${esc(CMP_SET.logo)}" alt="Logo" class="max-h-14 max-w-[12rem]">` : '<span class="text-xs text-slate-400 px-2">No logo</span>'}</div>
            ${can ? `<label class="px-3 min-h-[2.5rem] inline-flex items-center rounded-lg text-sm border bg-white hover:border-emerald-600 cursor-pointer">Choose a picture…<input type="file" accept="image/png,image/jpeg,image/webp" class="hidden" onchange="cmpLogoPick(this)"></label>
              <button type="button" class="text-sm text-red-600 underline" onclick="CMP_SET.logo = ''; $('#cmLogoBox').innerHTML = '<span class=&quot;text-xs text-slate-400 px-2&quot;>No logo</span>'; cmpSetPreview()">Remove</button>` : ''}</div></div>
        <label class="sm:col-span-2"><span>Header <span class="text-slate-400">(a line or two across the top)</span></span><textarea name="invoiceHeader" rows="2" maxlength="300" ${dis}>${esc(s.invoiceHeader || '')}</textarea></label>
        <div class="sm:col-span-2 border rounded-lg p-3 space-y-2"><span class="block text-sm font-medium text-slate-700">Top of the documents</span>
          <label class="flex items-center gap-2 text-sm"><input type="radio" name="headerStyle" value="LOGO" ${s.headerStyle !== 'LETTERHEAD' ? 'checked' : ''} ${dis}> The logo, the header line and the firm's details</label>
          <label class="flex items-center gap-2 text-sm"><input type="radio" name="headerStyle" value="LETTERHEAD" ${s.headerStyle === 'LETTERHEAD' ? 'checked' : ''} ${dis}> A full letterhead picture across the top</label>
          <div class="flex flex-wrap items-center gap-3"><div id="cmLhBox" class="min-h-[3rem] w-full max-w-md border rounded-lg bg-slate-50 flex items-center justify-center p-1">${CMP_SET.letterhead ? `<img src="${esc(CMP_SET.letterhead)}" alt="Letterhead" class="max-h-24 w-full object-contain">` : '<span class="text-xs text-slate-400 px-2">No letterhead picture</span>'}</div>
            ${can ? `<label class="px-3 min-h-[2.5rem] inline-flex items-center rounded-lg text-sm border bg-white hover:border-emerald-600 cursor-pointer">Choose the letterhead…<input type="file" accept="image/png,image/jpeg,image/webp" class="hidden" onchange="cmpLetterheadPick(this)"></label>
              <button type="button" class="text-sm text-red-600 underline" onclick="CMP_SET.letterhead = ''; $('#cmLhBox').innerHTML = '<span class=&quot;text-xs text-slate-400 px-2&quot;>No letterhead picture</span>'; cmpSetPreview()">Remove</button>` : ''}</div></div>
        <label class="sm:col-span-2"><span>Firm name</span><input name="firmName" maxlength="200" value="${esc(s.firmName)}" ${dis}></label>
        <label class="sm:col-span-2"><span>Address</span><textarea name="firmAddress" rows="2" maxlength="500" ${dis}>${esc(s.firmAddress)}</textarea></label>
        <label><span>Phone</span><input name="firmPhone" maxlength="40" value="${esc(s.firmPhone)}" ${dis}></label>
        <label><span>Email</span><input name="firmEmail" maxlength="200" value="${esc(s.firmEmail)}" ${dis}></label>
        <label class="sm:col-span-2"><span>Your tax registration number <span class="text-slate-400">(e.g. TRN)</span></span><input name="firmTaxNo" maxlength="60" value="${esc(s.firmTaxNo)}" ${dis}></label>
        <label class="sm:col-span-2"><span>Bank / payment details</span><textarea name="bankDetails" rows="3" maxlength="800" ${dis}>${esc(s.bankDetails)}</textarea></label>
        <label class="sm:col-span-2"><span>Footer line</span><textarea name="invoiceFooter" rows="2" maxlength="500" ${dis}>${esc(s.invoiceFooter)}</textarea></label>
        <label><span>Invoice numbers</span><input name="invoiceFormat" maxlength="40" value="${esc(s.invoiceFormat)}" ${dis}></label>
        <label><span>Receipt numbers</span><input name="receiptFormat" maxlength="40" value="${esc(s.receiptFormat)}" ${dis}></label>
        <label><span>Advance payment receipt numbers</span><input name="advanceFormat" maxlength="40" value="${esc(s.advanceFormat || 'ADV-{YYYY}-{NNNN}')}" ${dis}></label>
      </div>
      <p class="text-xs text-slate-500">The phone, email and address are also what [Firm Phone], [Firm Email] and [Firm Address] say in messages (Settings → Firm profile). In the number formats, {NNNN} is the running number and {YYYY}, {YY}, {MM} the date: INV-{YYYY}-{NNNN} → INV-2027-0042. Numbers are never reused.</p>
      <div class="flex justify-end gap-2">${cmpBtn('Close', 'cmpCloseModal()')}${can ? '<button class="needs-write px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">Save the standard format</button>' : ''}</div>
    </form>`), { xl: true });
  cmpSetPreview();
}
// One format of the country, in its window
const CMP_POS = [['tl', 'Top left'], ['tc', 'Top centre'], ['tr', 'Top right'], ['ml', 'Middle left'], ['mc', 'Centre'], ['mr', 'Middle right'], ['bl', 'Bottom left'], ['bc', 'Bottom centre'], ['br', 'Bottom right']];
function cmpTypeEdit(id, kind = 'INVOICE') {
  const t = id ? (CMP_INV.types || []).find(x => x.id === id) : null, s = CMP_SET.saved || {}, cc = t ? t.country : $('#cmFmtCountry').value;
  if (!cc) return toast('Choose the country first.');
  kind = t ? t.kind || 'INVOICE' : kind;
  const first = !(CMP_INV.types || []).some(x => (x.kind || 'INVOICE') === kind && x.country === cc);
  CMP_SET.type = t ? JSON.parse(JSON.stringify(t)) : { id: null, name: '', kind, country: cc, isDefault: first, active: true,
    layout: { invoiceTitle: 'TAX INVOICE', receiptTitle: 'RECEIPT', advanceTitle: 'ADVANCE PAYMENT RECEIPT', headerStyle: 'DEFAULT', showBank: true, showClientTaxNo: true, taxLabel: 'TRN', blocks: [] } };
  const L = CMP_SET.type.layout, can = cmpCan('FULL'), dis = can ? '' : 'disabled', word = CMP_FMT_KINDS.find(k => k[0] === kind)[2];
  L.blocks = L.blocks || [];
  // the ticks: those saved on the format, else what a format of before showed
  L.clientFields = L.clientFields || (L.showClientTaxNo === false ? CMP_CLIENT_DEFAULT.filter(k => k !== 'registrationNo') : [...CMP_CLIENT_DEFAULT]);
  L.autoFields = L.autoFields || [...CMP_AUTO_DEFAULT[kind]];
  const inp = (k, label, ph = '', max = 200) => `<label><span>${label}</span><input data-l="${k}" maxlength="${max}" value="${esc(L[k] || '')}" placeholder="${esc(ph)}" ${dis}></label>`;
  const area = (k, label, ph = '', max = 800) => `<label class="sm:col-span-2"><span>${label}</span><textarea data-l="${k}" rows="2" maxlength="${max}" placeholder="${esc(ph)}" ${dis}>${esc(L[k] || '')}</textarea></label>`;
  const fields = CMP_SET.fields.filter(f => f.active && (f.allCountries || f.countries.includes(cc)));
  const tick = (group, key, label) => `<label class="flex items-center gap-2 text-sm"><input type="checkbox" data-tick="${group}" value="${esc(key)}" ${L[group].includes(key) ? 'checked' : ''} ${dis}> ${esc(label)}</label>`;
  cmpShowModal(cmpFmtWindow(t ? `${esc(t.name)}` : `A new ${esc(word)} format`, `${cmpFlagName(cc)} · ${esc(CMP_FMT_KINDS.find(k => k[0] === kind)[1])}`, `
    <form id="cmTypeForm" onsubmit="event.preventDefault(); cmpTypeSave()" oninput="cmpTypeRead()" onchange="cmpTypeRead()" class="space-y-4">
      <div class="grid sm:grid-cols-2 gap-3">
        <label><span>Name *</span><input name="name" required maxlength="60" placeholder="e.g. ${esc(cc)} - Dubai" value="${esc(CMP_SET.type.name)}" ${dis}></label>
        <label class="flex items-center gap-2 text-sm pt-6"><input type="checkbox" name="isDefault" ${CMP_SET.type.isDefault ? 'checked' : ''} ${dis}> The default for ${esc(cmpCountry(cc).name)}</label>
        ${kind === 'INVOICE' ? inp('invoiceTitle', 'Invoice title', 'e.g. TAX INVOICE', 40) : kind === 'RECEIPT' ? inp('receiptTitle', 'Receipt title', 'e.g. RECEIPT VOUCHER', 40) : inp('advanceTitle', 'Title', 'e.g. ADVANCE PAYMENT RECEIPT', 40)}
        <label><span>Top of the page</span><select data-l="headerStyle" ${dis}>${[['DEFAULT', 'As in the standard format'], ['LOGO', 'The logo, the header line and the firm\'s details'], ['LETTERHEAD', 'The letterhead picture (standard format)'], ['NONE', 'Only the title (printed letterhead paper)']].map(([k, v]) => `<option value="${k}" ${L.headerStyle === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        ${inp('firmName', 'Firm name on this format', s.firmName || 'as in the standard format')}${inp('taxLabel', 'Tax number called', 'e.g. TRN', 40)}
        ${area('firmAddress', 'Address on this format', s.firmAddress || 'as in the standard format', 500)}${inp('taxNo', 'Tax registration number on this format', s.firmTaxNo || 'as in the standard format', 60)}
        ${kind === 'INVOICE' ? `<label class="flex items-center gap-2 text-sm pt-6"><input type="checkbox" data-l="showBank" ${L.showBank !== false ? 'checked' : ''} ${dis}> Show the bank details</label>${area('bankDetails', 'Bank details on this format', s.bankDetails || 'as in the standard format')}`
          : area(kind === 'RECEIPT' ? 'receiptNote' : 'advanceNote', 'A note on it', kind === 'RECEIPT' ? 'e.g. This receipt is valid subject to the realisation of the cheque.' : 'e.g. This advance will be adjusted against the final invoice.', 500)}
        ${area('footer', 'Footer on this format', s.invoiceFooter || 'as in the standard format', 500)}
      </div>
      <fieldset class="border rounded-lg p-3"><legend class="text-sm font-semibold px-1">The client's details on it</legend>
        <p class="text-xs text-slate-500 mb-2">Tick what shows under "${kind === 'INVOICE' ? 'Bill to' : 'Received from'}". The additional information of ${esc(cmpCountry(cc).name)} clients is listed too: a field added later on Additional Information shows here to tick.</p>
        <div class="grid sm:grid-cols-2 gap-1">${CMP_CLIENT_KEYS.map(([k, v]) => tick('clientFields', k, v)).join('')}</div>
        ${fields.length ? `<div class="text-[11px] uppercase tracking-wide text-slate-500 font-semibold mt-2 mb-1">Additional information</div><div class="grid sm:grid-cols-2 gap-1">${fields.map(f => tick('clientFields', 'f:' + f.id, f.name)).join('')}</div>` : ''}</fieldset>
      <fieldset class="border rounded-lg p-3"><legend class="text-sm font-semibold px-1">Automatic information</legend>
        <p class="text-xs text-slate-500 mb-2">Made by the system on each ${esc(word)}${kind === 'ADVANCE' ? ' receipt' : ''}: tick what it shows.</p>
        <div class="grid sm:grid-cols-2 gap-1">${CMP_AUTO[kind].map(([k, v]) => tick('autoFields', k, v)).join('')}</div></fieldset>
      <div><div class="flex items-center justify-between gap-2"><h4 class="text-sm font-semibold">Extra information <span class="font-normal text-slate-500">— anything, placed anywhere: drag it on the preview</span></h4>
        ${can ? `<button type="button" class="text-sm text-emerald-700 underline" onclick="cmpBlockAdd()">+ Add information</button>` : ''}</div>
        <p class="text-xs text-slate-500">Placeholders such as [Client Name], ${kind === 'ADVANCE' ? '[Advance Number], [Advance Amount]' : kind === 'RECEIPT' ? '[Receipt Number], [Receipt Amount]' : '[Invoice Number], [Invoice Amount]'} or [Firm Name] are filled in on each one.</p>
        <div id="cmBlocks" class="space-y-2 mt-2"></div></div>
      <div class="flex flex-wrap justify-between gap-2">${can && t ? cmpBtn('Delete this format', `cmpTypeDelete('${t.id}')`, 'danger', 'needs-write') : '<span></span>'}
        <div class="flex gap-2">${cmpBtn('Close', "CMP_SET.type = null; cmpCloseModal(); cmpFmtList()")}${can ? '<button class="needs-write px-4 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm font-medium">Save format</button>' : ''}</div></div></form>`), { xl: true });
  cmpBlocksDraw();
  cmpSetPreview();
}
function cmpBlocksDraw() {
  const L = CMP_SET.type.layout, kind = CMP_SET.type.kind || 'INVOICE', dis = cmpCan('FULL') ? '' : 'disabled', num = (b, k, label, min, max, step = 1) => `<label class="w-20"><span class="text-xs">${label}</span><input type="number" data-b="${k}" min="${min}" max="${max}" step="${step}" value="${b[k]}" ${dis}></label>`;
  // (an invoice format made before kept the extra information of its receipts too: it shows here with "on the receipt")
  $('#cmBlocks').innerHTML = L.blocks.length ? L.blocks.map((b, i) => `<div class="cmBlock border rounded-lg bg-white p-2 space-y-2" data-i="${i}">
      <textarea data-b="text" rows="2" maxlength="500" placeholder="e.g. Trade License No. 123456 · Stamp and signature" ${dis}>${esc(b.text)}</textarea>
      <div class="flex flex-wrap items-end gap-2">
        ${(b.doc || 'INVOICE') !== kind ? `<span class="text-xs text-amber-800 min-h-[2.5rem] flex items-center">on the ${b.doc === 'RECEIPT' ? 'receipt' : b.doc === 'ADVANCE' ? 'advance receipt' : 'invoice'}</span>` : ''}
        <label class="w-36"><span class="text-xs">Place it</span><select data-pos ${dis}><option value="">…</option>${CMP_POS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        ${num(b, 'x', 'From left %', 0, 100, 0.5)}${num(b, 'y', 'From top %', 0, 100, 0.5)}${num(b, 'w', 'Width %', 5, 100)}${num(b, 'size', 'Text size', 6, 32)}
        <label class="w-24"><span class="text-xs">Text</span><select data-b="align" ${dis}>${['left', 'center', 'right'].map(x => `<option value="${x}" ${b.align === x ? 'selected' : ''}>${x === 'center' ? 'centred' : x}</option>`).join('')}</select></label>
        <label class="flex items-center gap-1 text-xs min-h-[2.5rem]"><input type="checkbox" data-b="bold" ${b.bold ? 'checked' : ''} ${dis}> Bold</label>
        <label class="flex items-center gap-1 text-xs min-h-[2.5rem]"><input type="checkbox" data-b="border" ${b.border ? 'checked' : ''} ${dis}> Box</label>
        ${dis ? '' : `<button type="button" class="px-2 min-h-[2.5rem] text-red-600" onclick="CMP_SET.type.layout.blocks.splice(${i}, 1); cmpBlocksDraw(); cmpSetPreview()" aria-label="Remove">✕</button>`}</div></div>`).join('')
    : '<p class="text-xs text-slate-500">None yet.</p>';
}
function cmpBlockAdd() {
  const L = CMP_SET.type.layout;
  L.blocks.push({ id: 'b' + Math.random().toString(36).slice(2, 9), doc: CMP_SET.type.kind || 'INVOICE', text: 'Your text here', x: 5, y: 80, w: 40, size: 11, bold: false, align: 'left', border: false });
  cmpBlocksDraw(); cmpSetPreview();
}
// What is typed in the format's form, into the format being edited (then the preview)
function cmpTypeRead() {
  const t = CMP_SET.type, f = document.getElementById('cmTypeForm'); if (!t || !f) return;
  t.name = f.name.value; t.isDefault = f.isDefault.checked;
  f.querySelectorAll('[data-l]').forEach(el => { t.layout[el.dataset.l] = el.type === 'checkbox' ? el.checked : el.value; });
  for (const g of ['clientFields', 'autoFields']) t.layout[g] = [...f.querySelectorAll(`input[data-tick="${g}"]:checked`)].map(el => el.value);
  f.querySelectorAll('.cmBlock').forEach(row => {
    const b = t.layout.blocks[Number(row.dataset.i)]; if (!b) return;
    row.querySelectorAll('[data-b]').forEach(el => { const k = el.dataset.b; b[k] = el.type === 'checkbox' ? el.checked : ['x', 'y', 'w', 'size'].includes(k) ? Number(el.value) || 0 : el.value; });
    const pos = row.querySelector('[data-pos]');
    if (pos.value) { cmpBlockPlace(b, pos.value); pos.value = ''; ['x', 'y'].forEach(k => { row.querySelector(`[data-b="${k}"]`).value = b[k]; }); }
  });
  cmpSetPreviewSoon();
}
// The nine places (the CA: top centre, centre, …): from the block's width, so it sits exactly there
function cmpBlockPlace(b, pos) {
  const w = Math.min(100, Math.max(5, Number(b.w) || 40));
  b.x = pos[1] === 'l' ? 0 : pos[1] === 'c' ? Math.round((100 - w) / 2 * 10) / 10 : Math.round((100 - w) * 10) / 10;
  b.y = pos[0] === 't' ? 0 : pos[0] === 'm' ? 46 : 92;
  b.align = pos[1] === 'l' ? 'left' : pos[1] === 'c' ? 'center' : 'right';
  const row = document.querySelector(`.cmBlock[data-i="${CMP_SET.type.layout.blocks.indexOf(b)}"] [data-b="align"]`); if (row) row.value = b.align;
}
// Drag and drop on the preview: a block follows the pointer; where it is let go becomes its place (in % of the page, so it prints there)
function cmpDragBind(box) {
  if (!cmpCan('FULL')) return;
  box.querySelectorAll('[data-block]').forEach(el => {
    el.onpointerdown = e => {
      const page = el.closest('.cmpDoc'), b = CMP_SET.type.layout.blocks.find(x => x.id === el.dataset.block); if (!page || !b) return;
      e.preventDefault(); el.setPointerCapture(e.pointerId);
      const r = page.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, x0 = b.x, y0 = b.y;
      const at = ev => ({ x: Math.round(Math.min(100 - Math.min(b.w, 100), Math.max(0, x0 + (ev.clientX - sx) / r.width * 100)) * 10) / 10, y: Math.round(Math.min(99, Math.max(0, y0 + (ev.clientY - sy) / (r.width * CMP_PAGE.h / CMP_PAGE.w) * 100)) * 10) / 10 });
      el.onpointermove = ev => { const p = at(ev); el.style.left = `${(CMP_PAGE.w * p.x / 100).toFixed(1)}mm`; el.style.top = `${(CMP_PAGE.h * p.y / 100).toFixed(1)}mm`; };
      el.onpointerup = ev => {
        el.onpointermove = null; el.onpointerup = null;
        const p = at(ev); b.x = p.x; b.y = p.y;
        const row = document.querySelector(`.cmBlock[data-i="${CMP_SET.type.layout.blocks.indexOf(b)}"]`);
        if (row) { row.querySelector('[data-b="x"]').value = b.x; row.querySelector('[data-b="y"]').value = b.y; }
        cmpSetPreview();
      };
    };
  });
}
async function cmpTypeSave() {
  cmpTypeRead();
  const t = CMP_SET.type;
  try {
    const saved = await api(t.id ? `/api/cmp/invoice-types/${t.id}` : '/api/cmp/invoice-types', { method: t.id ? 'PUT' : 'POST', body: { name: t.name, kind: t.kind || 'INVOICE', country: t.country, isDefault: t.isDefault, layout: t.layout } });
    await cmpInvoiceTypes(null, true);
    toast(`${CMP_FMT_KINDS.find(k => k[0] === (saved.kind || 'INVOICE'))[2].replace(/^./, c => c.toUpperCase())} format "${saved.name}" saved`, true);
    CMP_SET.type = null; cmpCloseModal(); cmpFmtList();
  } catch (err) { toast(err.message); }
}
async function cmpTypeDefault(id) {
  try { await api(`/api/cmp/invoice-types/${id}`, { method: 'PUT', body: { isDefault: true } }); await cmpInvoiceTypes(null, true); cmpFmtList(); toast('Default changed', true); } catch (err) { toast(err.message); }
}
async function cmpTypeDelete(id) {
  const t = (CMP_INV.types || []).find(x => x.id === id);
  if (!confirm(`Delete the format "${t ? t.name : ''}"? The documents already made keep it as it was; new ones use the country's default (or the standard format).`)) return;
  try { await api(`/api/cmp/invoice-types/${id}`, { method: 'DELETE' }); await cmpInvoiceTypes(null, true); if (CMP_SET.type && CMP_SET.type.id === id) { CMP_SET.type = null; cmpCloseModal(); } cmpFmtList(); toast('Format deleted', true); }
  catch (err) { toast(err.message); }
}

// The letterhead: a wide picture, made at most 1800 pixels wide before it is saved (the CA: a full letterhead option)
function cmpLetterheadPick(input) {
  const file = input.files && input.files[0]; input.value = '';
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast('Choose a PNG, JPEG or WebP picture.');
  const img = new Image(), url = URL.createObjectURL(file);
  img.onload = () => {
    const k = Math.min(1, 1800 / img.width, 900 / img.height), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    let data = c.toDataURL('image/png');
    for (const q of [0.9, 0.8, 0.65]) if (data.length > 1100000) data = c.toDataURL('image/jpeg', q);
    if (data.length > 1100000) return toast('That picture is too large even when made smaller. Choose a simpler one.');
    CMP_SET.letterhead = data;
    $('#cmLhBox').innerHTML = `<img src="${data}" alt="Letterhead" class="max-h-24 w-full object-contain">`;
    const lh = document.querySelector('input[name="headerStyle"][value="LETTERHEAD"]'); if (lh) lh.checked = true;
    cmpSetPreview();
    toast('Letterhead ready: press Save settings to keep it.', true);
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast('That picture could not be read.'); };
  img.src = url;
}
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
    cmpSetPreview();
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
  const f = $('#cmGenForm');
  try {
    CMP.settings = await api('/api/cmp/settings', { method: 'PUT', body: { timeZone: f.timeZone.value, reminderHour: Number(f.reminderHour.value),
      waSenders: [...document.querySelectorAll('#cmSenders .cmSender')].map(r => ({ id: r.dataset.id || undefined, label: r.querySelector('.snLabel').value, phone: r.querySelector('.snPhone').value, open: r.querySelector('.snOpen').value, isDefault: r.querySelector('.snDefault').checked })) } });
    if (CMP.me) CMP.me.settings = CMP.settings;
    PAGE_ENTER['cm-settings']();
    toast('Settings saved', true);
  } catch (err) { toast(err.message); }
}
// The standard format of invoices and receipts (Invoice and Receipt Format)
async function cmpFmtStdSave() {
  const f = $('#cmSetForm');
  try {
    const style = (f.querySelector('input[name="headerStyle"]:checked') || {}).value || 'LOGO';
    if (style === 'LETTERHEAD' && !CMP_SET.letterhead) return toast('Choose the letterhead picture first, or keep the logo and header line.');
    CMP.settings = await api('/api/cmp/settings', { method: 'PUT', body: { logo: CMP_SET.logo, letterhead: CMP_SET.letterhead, headerStyle: style,
      ...Object.fromEntries(['firmName', 'firmAddress', 'firmPhone', 'firmEmail', 'firmTaxNo', 'bankDetails', 'invoiceFooter', 'invoiceHeader', 'invoiceFormat', 'receiptFormat', 'advanceFormat'].map(k => [k, f[k].value])) } });
    if (CMP.me) CMP.me.settings = CMP.settings;
    CMP_SET.saved = CMP.settings;
    toast('The standard format is saved', true); cmpSetPreview();
  } catch (err) { toast(err.message); }
}
