'use strict';
/* Point of Sale: bulk import of items, customers and vendors from Excel or CSV (managers and the owner), and the history of imports with Undo.
   The browser reads the file and maps its headings onto the names the server knows; the SERVER checks every row (src/pos/import.js) and nothing is saved
   while the file has a problem. Where a row is something already saved, the uploader chooses which value to keep (the same pop-up as FBR's import).
   Loaded after pos.js; uses app.html's loadSheetJs, loadExcelJs, saveExcel, chooseConflicts, xKey. */

const posImp = { kind: 'items', file: null, result: null, last: null, batches: [] };
POS_RESETS.push(() => Object.assign(posImp, { kind: 'items', file: null, result: null, last: null, batches: [] }));

// What each kind understands: the canonical key, the heading in the template, whether it is required, and what to put there
const POS_IMPORT = {
  items: {
    sheet: 'Items', one: 'item', many: 'items', go: 'p-items',
    blurb: 'The things you sell. A row that has the code or barcode of a saved item (or, with neither, its name) is that item: what it is missing is filled in, and you choose where the file differs.',
    columns: [
      ['name', 'Name', true, 'What is printed on the receipt.'], ['code', 'Item code', false, 'What PRA gets as the item code. Leave empty for an automatic one (ITM0001…).'], ['barcode', 'Barcode', false, 'What the scanner reads, if not the code.'],
      ['category', 'Category', false, 'For the buttons and the reports.'], ['pct', 'PCT code', false, 'The 8-digit heading, like 9801.2000. Empty = the default in Settings ("A new item starts with").'],
      ['taxRate', 'Sales tax %', false, 'Like 16. Empty = the default in Settings.'], ['taxRateCard', 'Sales tax % on card', false, 'If card, wallet or QR payments have a lower rate.'], ['price', 'Price', false, 'Before tax (or with tax, if "Price includes tax" is yes).'],
      ['openPrice', 'Price typed on each sale', false, 'yes or no.'], ['taxInclusive', 'Price includes tax', false, 'yes or no.'], ['followSchedule', 'Follows the rate schedule', false, 'yes or no (the schedule must have a rate for the heading).'], ['active', 'On sale', false, 'yes or no; empty means yes.'],
    ],
    heads: { name: ['name', 'itemname', 'productname', 'product', 'item', 'servicename', 'service', 'menuitem'], code: ['code', 'itemcode', 'sku', 'productcode', 'itemid', 'itemno'], barcode: ['barcode', 'ean', 'upc', 'barcodeno', 'barcodenumber'],
      category: ['category', 'group', 'itemgroup', 'department', 'itemcategory', 'type'], pct: ['pct', 'pctcode', 'hscode', 'heading', 'pctheading', 'pcthscode'],
      taxRate: ['taxrate', 'salestaxrate', 'salestax', 'gst', 'tax', 'taxpercent', 'taxpct', 'taxrate%'], taxRateCard: ['salestaxoncard', 'taxoncard', 'cardtaxrate', 'taxratecard', 'cardrate', 'salestaxratecard', 'taxcard', 'walletrate'],
      price: ['price', 'unitprice', 'sellingprice', 'saleprice', 'retailprice', 'amount', 'mrp'], openPrice: ['openprice', 'pricetypedoneachsale', 'priceonsale', 'variableprice'],
      taxInclusive: ['taxinclusive', 'priceincludestax', 'inclusiveoftax', 'taxincluded', 'priceincludingtax', 'inclusive'], followSchedule: ['followschedule', 'followstherateschedule', 'followtherateschedule', 'followstheschedule', 'followtheschedule', 'followratesschedule'],
      active: ['active', 'onsale', 'inuse', 'enabled', 'status'] },
  },
  customers: {
    sheet: 'Customers', one: 'customer', many: 'customers', go: 'p-customers',
    blurb: 'The people and companies you sell to. A row with the PNTN, CNIC or code of a saved customer (or the same name and phone) is that customer. An opening balance is only used for a NEW customer.',
    columns: [
      ['name', 'Name', true, 'Printed on the invoice.'], ['pntn', 'PNTN', false, 'Like 1234567-8.'], ['cnic', 'CNIC', false, '13 digits.'], ['phone', 'Phone', false, 'A mobile like 0300 1234567, or with +92.'], ['address', 'Address', false, ''], ['notes', 'Notes', false, 'For your staff only.'],
      ['openingBalance', 'Opening balance', false, 'What they owe you today (minus if you hold their money). Rupees. Only for new customers.'], ['code', 'Code', false, 'Only to find a saved customer (CUS0001). New ones get the next code.'], ['active', 'In use', false, 'yes or no; empty means yes.'],
    ],
    heads: { name: ['name', 'customername', 'customer', 'fullname', 'businessname', 'party', 'partyname', 'clientname'], code: ['code', 'customercode', 'customerid', 'id', 'partycode'], pntn: ['pntn', 'ntn', 'ntnpntn', 'pntnntn', 'taxnumber', 'ntnno'], cnic: ['cnic', 'nic', 'idcard', 'cnicno'],
      phone: ['phone', 'mobile', 'mobileno', 'phonenumber', 'contact', 'cell', 'mobilenumber', 'phoneno'], address: ['address', 'location'], notes: ['notes', 'note', 'remarks', 'comment', 'comments'], openingBalance: ['openingbalance', 'balance', 'opening', 'receivable', 'outstanding'], active: ['active', 'inuse', 'enabled', 'status'] },
  },
  vendors: {
    sheet: 'Vendors', one: 'vendor', many: 'vendors', go: 'p-vendors',
    blurb: 'The people and companies you buy from. A row with the NTN or code of a saved vendor (or, with neither, its name) is that vendor. An opening balance is only used for a NEW vendor.',
    columns: [
      ['name', 'Name', true, ''], ['ntn', 'NTN', false, 'Like 1234567-8.'], ['phone', 'Phone', false, 'A mobile like 0300 1234567, a landline like 042 35761234, or with +92.'], ['address', 'Address', false, ''], ['notes', 'Notes', false, ''],
      ['openingBalance', 'Opening balance', false, 'What you owe them today (minus if you paid in advance). Rupees. Only for new vendors.'], ['code', 'Code', false, 'Only to find a saved vendor (VEN0001).'], ['active', 'In use', false, 'yes or no; empty means yes.'],
    ],
    heads: { name: ['name', 'vendorname', 'vendor', 'supplier', 'suppliername', 'party', 'partyname'], code: ['code', 'vendorcode', 'vendorid', 'id', 'suppliercode'], ntn: ['ntn', 'pntn', 'taxnumber', 'ntnno', 'ntnpntn'],
      phone: ['phone', 'mobile', 'mobileno', 'phonenumber', 'contact', 'cell', 'mobilenumber', 'phoneno'], address: ['address', 'location'], notes: ['notes', 'note', 'remarks', 'comment', 'comments'], openingBalance: ['openingbalance', 'balance', 'opening', 'payable', 'outstanding'], active: ['active', 'inuse', 'enabled', 'status'] },
  },
};
// a column heading as the file wrote it → the key the server knows ("Item Name *", "ITEM_NAME", "Sales Tax (%)" all work)
function posImpKey(kind, heading) {
  const k = xKey(String(heading).replace(/\*/g, '')).replace(/%/g, '');
  const heads = POS_IMPORT[kind].heads;
  for (const [key, names] of Object.entries(heads)) if (names.some(n => n.replace(/%/g, '') === k)) return key;
  return null;
}

POS_PAGES.push({
  id: 'p-import', enter: () => posEnterImport(),
  html: () => `
    <div class="bg-white rounded-xl shadow p-4 space-y-4">
      <div><h2 class="font-semibold">Import data <span class="text-xs font-normal text-slate-500">move items, customers and vendors in from another system</span></h2>
        <p class="text-xs text-slate-500 mt-1">The file is checked <b>completely</b> before anything is saved: every problem is listed with its row, and nothing is saved until the file is clean. A row that is already saved never overwrites it: you choose what to keep. Every import can be <b>undone</b>.</p></div>
      <div id="imTabs" class="flex flex-wrap gap-2"></div>
      <div id="imPanel"></div>
      <div id="imOut"></div>
    </div>
    <div class="bg-white rounded-xl shadow p-4 space-y-2"><h2 class="font-semibold">Earlier imports</h2><p class="text-xs text-slate-500">Undo removes what an import added (what has been used since is only switched off) and puts back what it changed, unless it was changed again since.</p>
      <div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-2">When</th><th>What</th><th>File</th><th class="text-right">Added</th><th class="text-right">Changed</th><th>By</th><th></th></tr></thead><tbody id="imHist"></tbody></table></div></div>`,
});

// the Import buttons on the Items, Customers and Vendors pages open this page on the right tab
function posImpGo(kind) { posImp.kind = kind; posImp.file = null; posImp.result = null; go('p-import'); }

async function posEnterImport() {
  posPollAlerts();
  posImpTabs(); posImpPanel();
  await posImpHistory();
}
function posImpTabs() {
  $('#imTabs').innerHTML = Object.keys(POS_IMPORT).map(k => `<button type="button" onclick="posImpTab('${k}')" class="px-4 py-2 rounded-lg text-sm font-medium ${k === posImp.kind ? 'bg-emerald-700 text-white' : 'border hover:border-emerald-600'}">${POS_IMPORT[k].sheet}</button>`).join('');
}
function posImpTab(kind) { posImp.kind = kind; posImp.file = null; posImp.result = null; $('#imOut').innerHTML = ''; posImpTabs(); posImpPanel(); }
function posImpPanel() {
  const d = POS_IMPORT[posImp.kind];
  $('#imPanel').innerHTML = `<div class="space-y-3">
    <p class="text-sm text-slate-600">${esc(d.blurb)}</p>
    <ol class="text-sm space-y-2 list-decimal ml-5">
      <li>Download the template (the columns that hold phone numbers, codes and barcodes are set to text, so Excel keeps their leading zeros), or use your own file: columns are found by their names.</li>
      <li>Fill it in. Only <b>${d.columns.filter(c => c[2]).map(c => esc(c[1])).join(', ')}</b> is required${posImp.kind === 'items' ? '; an empty PCT code or tax rate takes the default from Settings' : ''}.</li>
      <li>Upload it (Excel or CSV, up to 2,000 rows). You see the check before anything is saved.</li></ol>
    <div class="flex flex-wrap gap-2 items-center">
      ${posBtn('Download the template', 'posImpTemplate()')}
      <label class="px-4 py-3 sm:py-2.5 rounded-lg text-sm font-medium bg-emerald-700 text-white hover:bg-emerald-800 cursor-pointer">Choose a file to check<input id="imFile" type="file" accept=".xlsx,.xls,.csv,text/csv" class="hidden" onchange="posImpPick(this)"></label></div>
    <details class="text-sm"><summary class="cursor-pointer text-emerald-700">What each column means</summary>
      <table class="mt-2 w-full text-xs"><thead class="text-left text-slate-500"><tr><th class="py-1 pr-3">Column</th><th class="pr-3">Required</th><th>What to put there</th></tr></thead><tbody>
        ${d.columns.map(c => `<tr class="border-t"><td class="py-1 pr-3 font-medium">${esc(c[1])}</td><td class="pr-3">${c[2] ? 'yes' : ''}</td><td>${esc(c[3])}</td></tr>`).join('')}</tbody></table></details></div>`;
}

/* ---------- the template ---------- */
async function posImpTemplate() {
  const kind = posImp.kind, d = POS_IMPORT[kind];
  try {
    toast('Preparing the template…', true);
    await loadExcelJs();
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet(d.sheet), notes = wb.addWorksheet('How to fill it in');
    ws.columns = d.columns.map(c => ({ header: c[2] ? `${c[1]} *` : c[1], key: c[0], width: Math.max(14, c[1].length + 6) }));
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF065F46' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const yes = ['openPrice', 'taxInclusive', 'followSchedule', 'active'], text = ['code', 'barcode', 'pct', 'pntn', 'cnic', 'ntn', 'phone'];
    d.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      if (text.includes(c[0])) col.numFmt = '@'; // text: Excel keeps 03001234567 and 9801.2000 as typed
      for (let r = 2; r <= 1001; r++) {
        if (text.includes(c[0])) ws.getCell(r, i + 1).numFmt = '@'; // the cells too, not only the column: a cell with no format of its own would be a number again
        if (yes.includes(c[0])) ws.getCell(r, i + 1).dataValidation = { type: 'list', allowBlank: true, formulae: ['"yes,no"'] };
      }
    });
    notes.columns = [{ width: 28 }, { width: 12 }, { width: 90 }];
    notes.addRow(['Column', 'Required', 'What to put there']).font = { bold: true };
    for (const c of d.columns) notes.addRow([c[1], c[2] ? 'yes' : '', c[3]]);
    notes.addRow([]);
    notes.addRow(['Rules']).font = { bold: true };
    for (const t of ['Nothing is saved until the whole file is clean; every problem is listed with its row number.', 'A row that is already saved never overwrites it: you choose what to keep.', 'Up to 2,000 rows in a file. You can undo an import afterwards.', 'Do not rename the first row.']) notes.addRow([t]);
    await saveExcel(wb, `${kind}-import-template.xlsx`);
  } catch (err) { toast(err.message); }
}

/* ---------- reading and checking a file ---------- */
async function posImpPick(input) {
  const f = input.files && input.files[0]; input.value = '';
  if (!f) return;
  const out = $('#imOut'), kind = posImp.kind, d = POS_IMPORT[kind];
  if (f.size > 8 * 1024 * 1024) return toast('That file is too big (8 MB at most).');
  out.innerHTML = `<p class="text-sm text-slate-600">Checking ${esc(f.name)}…</p>`;
  try {
    await loadSheetJs();
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets[d.sheet] || wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error('The file has no sheet to read.');
    const head = (XLSX.utils.sheet_to_json(ws, { header: 1, range: 0, blankrows: false })[0] || []).map(h => [h, posImpKey(kind, h)]);
    const used = new Set(), ignored = [];
    for (const [h, k] of head) { if (k && !used.has(k)) used.add(k); else if (h !== '' && h != null) ignored.push(String(h)); }
    const keys = new Map(); for (const [h, k] of head) if (k && !keys.has(k)) keys.set(k, h); // the first column for a key wins
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true }).map(r => {
      const o = { row: r.__rowNum__ + 1 };
      for (const [k, h] of keys) o[k] = typeof r[h] === 'string' ? r[h].trim() : r[h];
      return o;
    }).filter(o => Object.entries(o).some(([k, v]) => k !== 'row' && v !== '' && v != null));
    posImp.file = { name: f.name, kind, body: { fileName: f.name, headers: [...keys.keys()], rows }, ignored };
    posImpRender(await api(`/api/pos/import/${kind}/check`, { method: 'POST', body: posImp.file.body }));
  } catch (err) { out.innerHTML = `<div class="rounded-lg border border-red-300 bg-red-50 text-red-800 p-3 text-sm">${esc(err.message)}</div>`; posImp.file = null; }
}
const posImpList = (rows, cls) => `<ul class="mt-2 space-y-1 ${cls}">${rows.map(e => `<li><b>${esc(e.sheet)}${e.row ? `, row ${e.row}` : ''}${e.name ? ` (${esc(e.name)})` : ''}:</b> ${e.messages.map(esc).join(' · ')}</li>`).join('')}</ul>`;
function posImpRender(r) {
  const out = $('#imOut'), f = posImp.file, d = POS_IMPORT[f.kind], name = esc(f.name);
  posImp.result = r;
  const warn = r.warnings && r.warnings.length ? `<details class="mt-2 text-amber-800"><summary class="cursor-pointer">${r.warnings.length} note${r.warnings.length === 1 ? '' : 's'} about this file</summary>${posImpList(r.warnings, '')}</details>` : '';
  const ign = f.ignored && f.ignored.length ? `<div class="mt-2 text-xs text-slate-500">Columns not used: ${f.ignored.map(esc).join(', ')}</div>` : '';
  if (r.errors.length) {
    const n = r.errors.reduce((a, e) => a + e.messages.length, 0);
    out.innerHTML = `<div class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm"><b class="text-red-800">${n} problem${n === 1 ? '' : 's'} found in ${name}: nothing was saved.</b> Fix them in the file and choose it again.${posImpList(r.errors.slice(0, 200), 'text-red-800')}${r.errors.length > 200 ? '<div class="text-xs mt-1">…and more: fix these first.</div>' : ''}${warn}${ign}</div>`;
    return;
  }
  const ups = r.updates || [], nCon = ups.filter(u => u.conflicts.length).length;
  const upList = ups.length ? `<ul class="mt-2 space-y-1 text-slate-700">${ups.slice(0, 100).map(u => `<li><b>Row ${u.row} (${esc(u.name)}):</b> already saved${u.existing.name !== u.name ? ` as "${esc(u.existing.name)}"` : ''} (${esc(u.existing.code)}): ${[
    u.fills.length ? `will fill in what is missing: ${u.fills.map(x => esc(x.label)).join(', ')}` : '', u.conflicts.length ? `<span class="text-amber-800">${u.conflicts.length} difference${u.conflicts.length === 1 ? '' : 's'} to choose: ${u.conflicts.map(x => esc(x.label)).join(', ')}</span>` : ''].filter(Boolean).join('; ') || 'nothing new in the file'}</li>`).join('')}${ups.length > 100 ? '<li>…and more.</li>' : ''}</ul>` : '';
  const prev = r.preview && r.preview.length ? `<div class="mt-2 overflow-x-auto"><table class="w-full text-xs"><thead class="text-left text-slate-500"><tr><th class="py-1 pr-3">Row</th><th class="pr-3">Name</th><th>Details</th></tr></thead><tbody>${r.preview.map(p => `<tr class="border-t"><td class="py-1 pr-3">${p.row}</td><td class="pr-3 font-medium">${esc(p.name)}${p.code ? ` <span class="text-slate-400">${esc(p.code)}</span>` : ''}</td><td class="text-slate-600">${esc(p.detail)}</td></tr>`).join('')}</tbody></table>${r.new > r.preview.length ? `<div class="text-xs text-slate-500 mt-1">…and ${r.new - r.preview.length} more new.</div>` : ''}</div>` : '';
  const nothing = !r.new && !ups.length;
  out.innerHTML = `<div class="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm"><b class="text-emerald-800">${r.new} new ${r.new === 1 ? d.one : d.many}${ups.length ? ` and ${ups.length} already saved` : ''} in ${name}. No problems.</b>
    ${nothing ? '' : `<button type="button" onclick="posImpCommit()" class="ml-2 bg-emerald-700 text-white rounded px-3 py-1.5">${nCon ? 'Choose differences and import' : 'Import'}</button>`}
    <button type="button" onclick="posImpCancel()" class="ml-2 text-xs underline">Cancel</button>${prev}${upList}${warn}${ign}</div>`;
}
function posImpCancel() { posImp.file = null; posImp.result = null; $('#imOut').innerHTML = ''; }

/* ---------- saving ---------- */
async function posImpCommit() {
  const f = posImp.file, r = posImp.result; if (!f || !r) return;
  const d = POS_IMPORT[f.kind];
  try {
    let choices = {};
    if ((r.updates || []).some(u => u.conflicts.length)) {
      choices = await chooseConflicts(r.updates, d.one);
      if (!choices) return toast('Import cancelled: nothing was saved');
    }
    $('#imOut').innerHTML = '<p class="text-sm text-slate-600">Saving…</p>';
    const c = await api(`/api/pos/import/${f.kind}/commit`, { method: 'POST', body: { ...f.body, choices } });
    posImp.last = { id: c.batchId, kind: f.kind };
    posImp.file = null; posImp.result = null;
    $('#imOut').innerHTML = `<div class="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm"><b class="text-emerald-800">Imported ${c.added} new ${c.added === 1 ? d.one : d.many}${c.updated ? `, ${c.updated} updated` : ''} from ${esc(f.name)}.</b>
      <button type="button" onclick="posImpUndoAsk('${c.batchId}')" class="ml-2 border border-red-300 text-red-700 rounded px-3 py-1">Undo this import</button> <button type="button" onclick="go('${d.go}')" class="ml-2 underline text-emerald-700">Open ${d.sheet}</button>
      ${c.details && c.details.length ? `<ul class="mt-2 space-y-1 text-slate-700">${c.details.slice(0, 100).map(x => `<li><b>Row ${x.row} (${esc(x.name)}):</b> ${esc(x.message)}</li>`).join('')}</ul>` : ''}</div>`;
    toast('Imported', true); posImpHistory();
  } catch (err) {
    if (err.data && err.data.errors) { posImpRender({ errors: err.data.errors, warnings: err.data.warnings || [] }); toast('The file has problems: nothing was saved'); }
    else { $('#imOut').innerHTML = `<div class="rounded-lg border border-red-300 bg-red-50 text-red-800 p-3 text-sm">${esc(err.message)}</div>`; }
  }
}

/* ---------- history and undo ---------- */
async function posImpHistory() {
  try { posImp.batches = await api('/api/pos/import/batches'); } catch (err) { return toast(err.message); }
  const when = d => posWhenShort(d);
  $('#imHist').innerHTML = posImp.batches.map(b => `<tr class="border-b last:border-0 ${b.undone ? 'opacity-60' : ''}"><td class="py-2 whitespace-nowrap text-xs">${esc(when(b.createdAt))}</td><td>${esc(POS_IMPORT[b.kind] ? POS_IMPORT[b.kind].sheet : b.kind)}</td><td class="text-xs">${esc(b.fileName)}</td>
      <td class="text-right">${b.added}</td><td class="text-right">${b.updated}</td><td class="text-xs">${esc(b.createdBy)}</td>
      <td class="text-right">${b.undone ? `<span class="text-xs text-slate-500" title="${esc(b.undoNote)}">undone by ${esc(b.undoneBy)}</span>` : `<button type="button" onclick="posImpUndoAsk('${b.id}')" class="text-xs text-red-700 underline">Undo…</button>`}</td></tr>${b.undone && b.undoNote ? `<tr class="border-b last:border-0"><td></td><td colspan="6" class="pb-2 text-xs text-slate-500">${esc(b.undoNote)}</td></tr>` : ''}`).join('')
    || '<tr><td colspan="7" class="py-4 text-center text-slate-500">No imports yet.</td></tr>';
}
function posImpUndoAsk(id) {
  const b = posImp.batches.find(x => x.id === id) || (posImp.last && posImp.last.id === id ? { id, kind: posImp.last.kind, added: '', updated: '', fileName: '' } : null);
  if (!b) return;
  posShowModal(`<div class="space-y-3"><div class="flex items-start justify-between gap-3"><h2 class="text-lg font-semibold">Undo this import?</h2><button type="button" onclick="posCloseModal()" class="text-2xl leading-none text-slate-400 px-2" aria-label="Close">×</button></div>
    <p class="text-sm text-slate-600">${esc(b.fileName || 'This import')}${b.added !== '' ? `: ${b.added} added, ${b.updated} changed` : ''}.</p>
    <ul class="text-sm text-slate-700 list-disc ml-5 space-y-1"><li>What it <b>added</b> is removed. If something it added has been used since (a sale, a bill, a payment) it is kept and only switched off.</li><li>What it <b>changed</b> is put back, unless it was changed again since: then the newer value stays.</li><li>It can be undone once. You will be told exactly what was done.</li></ul>
    <div class="flex gap-2">${posBtn('Undo the import', `posImpUndo('${id}')`, 'danger')}${posBtn('Keep it', 'posCloseModal()')}</div></div>`);
}
async function posImpUndo(id) {
  try {
    const b = await api(`/api/pos/import/batches/${id}/undo`, { method: 'POST', body: {} });
    posCloseModal(); toast('Undone', true);
    $('#imOut').innerHTML = `<div class="rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm"><b>Undone:</b> ${esc(b.undoNote)}.</div>`;
    await posImpHistory();
  } catch (err) { toast(err.message); }
}
