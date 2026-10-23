'use strict';
/* Point of Sale extras: the receipt logo, the record-keeping period and the receipt printer (Settings, owner), printing a receipt straight to a
   thermal printer, and the register of invoices written by hand during an outage.
   Loaded after pos.js, which gives it POS, POS_PAGES, POS_RESETS, posBtn, posBanner, posShowModal ... */

const posExtra = { logo: '', retention: null, slips: [], total: 0, open: null, status: '', q: '', receipt: null };
POS_RESETS.push(() => { PosPrinter.forget(); Object.assign(posExtra, { logo: '', retention: null, slips: [], total: 0, open: null, status: '', q: '', receipt: null }); });

/* ---------- Settings: logo, record-keeping, printer ---------- */
function posSettingsExtras() {
  const sup = PosPrinter.supports();
  return `<div class="bg-white rounded-xl shadow p-5" id="sxLogoCard"><h2 class="font-semibold">Receipt logo <span class="text-xs font-normal text-slate-500">printed at the top of every receipt</span></h2>
      <div class="flex flex-wrap items-center gap-4 mt-3"><div id="sxLogoBox" class="w-40 h-20 border rounded-lg flex items-center justify-center bg-slate-50 text-xs text-slate-400">No logo</div>
        <div class="space-y-2"><input id="sxLogoFile" type="file" accept="image/png,image/jpeg" onchange="posLogoPick(this)" class="text-sm">
          <div class="flex gap-2">${posBtn('Remove the logo', 'posLogoRemove()', 'danger')}</div>
          <p class="text-xs text-slate-500">A PNG or JPEG. It is made smaller and black-and-white friendly here; a plain, dark logo on a white background prints best on a thermal roll.</p></div></div></div>
    <div class="bg-white rounded-xl shadow p-5"><h2 class="font-semibold">Keeping records <span class="text-xs font-normal text-slate-500">how long sales and the activity trail are kept</span></h2>
      <div class="flex flex-wrap items-end gap-3 mt-3"><label><span>Keep for (years)</span><input id="sxYears" inputmode="numeric" class="!w-24" maxlength="2"></label>${posBtn('Save', 'posRetentionSave()', 'primary')}</div>
      <div id="sxRetention" class="text-sm text-slate-600 mt-3 space-y-1">Checking…</div>
      <p class="text-xs text-slate-500 mt-2">Nothing is ever deleted from here: a sale, a credit or debit note, a voucher or a line of the activity trail cannot be removed. The period is when older records <i>may</i> be archived (after a spreadsheet of them has been taken). The law's period is for you to confirm with your accountant.</p></div>
    <div class="bg-white rounded-xl shadow p-5"><h2 class="font-semibold">Receipt printer on this phone or computer <span class="text-xs font-normal text-slate-500">print without the print window</span></h2>
      <div class="text-sm mt-2 space-y-2">
        ${PosPrinter.available() ? `<div id="sxPrinter" class="text-slate-700"></div>
          <div class="flex flex-wrap gap-2">${sup.bluetooth ? posBtn('Connect a Bluetooth printer', "posPrinterConnect('bluetooth')", 'primary') : ''}${sup.usb ? posBtn('Connect a USB printer', "posPrinterConnect('usb')") : ''}${posBtn('Print a test slip', 'posPrinterTest()')}${posBtn('Disconnect', 'posPrinterForget()')}</div>`
          : posBanner('info', 'This browser cannot talk to a printer directly (iPhones and iPads cannot; use Chrome on Android or on a computer). The ordinary <b>Print</b> button on a receipt still works with any printer.')}
        <p class="text-xs text-slate-500">Works with ESC/POS receipt printers (most 58 mm and 80 mm Bluetooth and USB ones). The page must be opened over https, and the browser asks you to choose the printer each time the page is opened. Receipts are printed in plain letters (no Urdu), with the QR code from the printer itself. <b>Not yet tried on a real printer</b>: print the test slip first, and tell us how it came out.</p></div></div>`;
}
async function posSettingsExtrasLoad() {
  try {
    const [logo, ret] = await Promise.all([api('/api/pos/logo'), api('/api/pos/retention')]);
    posExtra.logo = logo.logo; posExtra.retention = ret;
    posLogoShow(); posRetentionShow();
  } catch (err) { toast(err.message); }
  posPrinterShow();
}
function posLogoShow() {
  const box = $('#sxLogoBox'); if (!box) return;
  box.innerHTML = posExtra.logo ? `<img src="${esc(posExtra.logo)}" alt="Logo" class="max-w-full max-h-full">` : 'No logo';
}
// A picked picture is drawn smaller on a white page and sent as a PNG, so what is stored is always small and always a real PNG
function posLogoPick(input) {
  const file = input.files && input.files[0]; if (!file) return;
  if (!/^image\/(png|jpeg)$/.test(file.type)) { input.value = ''; return toast('Choose a PNG or JPEG picture.'); }
  const reader = new FileReader();
  reader.onerror = () => toast('That file could not be read.');
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => toast('That is not a picture this browser can open.');
    img.onload = async () => {
      let side = 384; // dots across a 58 mm roll: plenty for a logo on either paper
      for (let tries = 0; tries < 5; tries++) {
        const k = Math.min(1, side / img.width, (side / 2) / img.height), w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
        const url = c.toDataURL('image/png');
        if (url.length < 190000) {
          try { const r = await api('/api/pos/logo', { method: 'PUT', body: { logo: url } }); posExtra.logo = r.logo; posLogoShow(); toast('Logo saved', true); } catch (err) { toast(err.message); }
          input.value = ''; return;
        }
        side = Math.round(side * 0.7); // still too big to keep: smaller
      }
      toast('That picture is too detailed to keep. Try a simpler one.'); input.value = '';
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
async function posLogoRemove() {
  try { await api('/api/pos/logo', { method: 'DELETE' }); posExtra.logo = ''; posLogoShow(); toast('Logo removed', true); } catch (err) { toast(err.message); }
}
function posRetentionShow() {
  const r = posExtra.retention, el = $('#sxRetention'); if (!r || !el) return;
  $('#sxYears').value = r.years;
  el.innerHTML = `<div>${esc(r.rule)}</div><div class="text-xs text-slate-500">${r.sales} ${r.sales === 1 ? 'sale' : 'sales'} and notes${r.oldestSaleAt ? `, the oldest from ${esc(posWhenShort(r.oldestSaleAt))}` : ''}; ${r.salesOlder} older than the period. ${r.trailEntries} lines in the activity trail, ${r.trailOlder} older than the period.</div>`;
}
async function posRetentionSave() {
  try {
    POS.settings = await api('/api/pos/settings', { method: 'PUT', body: { retentionYears: $('#sxYears').value } });
    posExtra.retention = await api('/api/pos/retention'); posRetentionShow(); toast('Saved', true);
  } catch (err) { toast(err.message); }
}

/* ---------- the printer ---------- */
function posPrinterShow() {
  const el = $('#sxPrinter'); if (!el) return;
  el.innerHTML = PosPrinter.conn ? `Connected: <b>${esc(PosPrinter.name())}</b>` : 'No printer connected.';
}
async function posPrinterConnect(kind) {
  try {
    const name = kind === 'usb' ? await PosPrinter.connectUsb() : await PosPrinter.connectBluetooth();
    toast(`Connected to ${name}`, true); posPrinterShow(); posReceiptButtons();
  } catch (err) { if (err && err.name !== 'NotFoundError') toast(err.message || String(err)); } // "NotFoundError" is the person closing the chooser
}
function posPrinterForget() { PosPrinter.forget(); posPrinterShow(); posReceiptButtons(); toast('Disconnected', true); }
async function posPrinterTest() {
  try { await PosPrinter.send(PosEscpos.encodeTest((POS.settings && POS.settings.receiptWidth) === 58 ? 58 : 80)); toast('Test slip sent', true); } catch (err) { toast(err.message); }
}
// The logo as the printer takes it: black and white, no wider than the roll
async function posLogoForPrinter(dataUrl, width) {
  if (!dataUrl) return null;
  return new Promise(resolve => {
    const img = new Image();
    img.onerror = () => resolve(null); // no logo is better than no receipt
    img.onload = () => {
      const dots = Math.min(PosEscpos.DOTS[width], 300), k = Math.min(1, dots / img.width), w = Math.max(8, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
      resolve(PosEscpos.logoRaster(g.getImageData(0, 0, w, h).data, w, h));
    };
    img.src = dataUrl;
  });
}
// "Print to printer" on the receipt window: the receipt being shown, as bytes, straight to the connected printer
async function posPrintDirect() {
  const rc = posExtra.receipt; if (!rc) return;
  try {
    if (!PosPrinter.conn) { const bt = PosPrinter.supports().bluetooth; await posPrinterConnect(bt ? 'bluetooth' : 'usb'); if (!PosPrinter.conn) return; }
    const width = rc.look && rc.look.width === 58 ? 58 : 80;
    const bytes = PosEscpos.encodeReceipt(rc, { modeName: posModeName(rc.sale.paymentMode), logo: await posLogoForPrinter(rc.business.logo, width) });
    await PosPrinter.send(bytes); toast('Sent to the printer', true);
  } catch (err) { toast(err.message || String(err)); }
}
// pos.js calls this each time a receipt is shown
function posReceiptShown(rc) { posExtra.receipt = rc; posReceiptButtons(); }
function posReceiptButtons() {
  const b = $('#posDirectBtn'); if (!b) return;
  b.classList.toggle('hidden', !PosPrinter.available());
  b.textContent = PosPrinter.conn ? 'Print to printer' : 'Connect printer and print';
}

/* ---------- invoices written by hand during an outage ---------- */
POS_PAGES.push({
  id: 'p-manual', enter: () => posEnterManual(),
  html: () => `
    <div class="bg-white rounded-xl shadow p-4 space-y-3">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div><h2 class="font-semibold">Hand-written slips</h2><p class="text-xs text-slate-500">Slips written on paper while PRA could not be reached, entered here so none is lost or forgotten.</p></div>
        <button type="button" onclick="posManualForm()" class="bg-emerald-700 text-white rounded px-3 min-h-[2.5rem] text-sm whitespace-nowrap">+ Record a slip</button></div>
      ${posBanner('warn', '<b>These are not fiscal invoices.</b> Nothing here is sent to PRA and no PRA number is made up. A sale is only a proper invoice once PRA has given its number. This list keeps track of what was written by hand and what has been done about it: tell your accountant, and mark each slip as reported once it has been dealt with.')}
      <div id="amOpen"></div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <label class="col-span-2"><span class="text-xs text-slate-500">Search</span><input id="amQ" type="search" placeholder="Slip number, buyer, what was sold…" oninput="posManualSearch(this.value)" autocomplete="off"></label>
        <label><span class="text-xs text-slate-500">Show</span><select id="amStatus" onchange="posManualFilter()"><option value="">All</option><option value="OPEN">Not reported yet</option><option value="REPORTED">Reported</option><option value="VOID">Voided</option></select></label></div>
      <div class="overflow-x-auto"><table class="w-full text-sm"><thead class="text-left text-slate-500 border-b"><tr><th class="py-2">Slip</th><th>Written</th><th class="hidden sm:table-cell">What</th><th class="text-right">Total</th><th>Status</th></tr></thead><tbody id="amRows"></tbody></table></div>
      <div class="text-center"><button type="button" id="amMore" onclick="posManualLoad(true)" class="hidden border rounded px-4 min-h-[2.5rem] text-sm">Show more</button></div>
    </div>`,
});
const POS_SLIP = { OPEN: ['Not reported yet', 'bg-amber-100 text-amber-800'], REPORTED: ['Reported', 'bg-emerald-100 text-emerald-800'], VOID: ['Voided', 'bg-slate-200 text-slate-600'] };
const posSlipChip = st => { const [t, c] = POS_SLIP[st] || [st, 'bg-slate-100']; return `<span class="px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${c}">${t}</span>`; };
async function posEnterManual() {
  posPollAlerts();
  $('#amQ').value = posExtra.q; $('#amStatus').value = posExtra.status;
  await posManualLoad(false);
}
let posManualTimer = null;
function posManualSearch(v) { posExtra.q = v.trim(); clearTimeout(posManualTimer); posManualTimer = setTimeout(() => posManualLoad(false), 300); }
function posManualFilter() { posExtra.status = $('#amStatus').value; posManualLoad(false); }
async function posManualLoad(more) {
  try {
    const q = new URLSearchParams({ ...(posExtra.q ? { q: posExtra.q } : {}), ...(posExtra.status ? { status: posExtra.status } : {}), limit: '100', offset: String(more ? posExtra.slips.length : 0) });
    const r = await api('/api/pos/manual?' + q);
    posExtra.slips = more ? posExtra.slips.concat(r.invoices) : r.invoices; posExtra.total = r.total; posExtra.open = r.open;
    posManualRender();
  } catch (err) { toast(err.message); }
}
function posManualRender() {
  const o = posExtra.open;
  $('#amOpen').innerHTML = o && o.count ? posBanner('bad', `<b>${o.count} ${o.count === 1 ? 'slip is' : 'slips are'} not reported yet</b>, ${money(o.total)} in all.`) : '';
  $('#amMore').classList.toggle('hidden', posExtra.slips.length >= posExtra.total);
  $('#amRows').innerHTML = posExtra.slips.map(m => `<tr class="border-b last:border-0 hover:bg-slate-50 cursor-pointer ${m.status === 'VOID' ? 'opacity-60' : ''}" onclick="posManualOpen('${m.id}')">
      <td class="py-2 font-mono text-xs">${esc(m.bookNumber)}</td><td class="text-xs whitespace-nowrap">${esc(posWhenShort(m.writtenAt))}</td>
      <td class="hidden sm:table-cell">${esc(m.description)}${m.buyer.name ? `<div class="text-xs text-slate-500">${esc(m.buyer.name)}</div>` : ''}</td><td class="text-right whitespace-nowrap">${money(m.total)}</td><td>${posSlipChip(m.status)}</td></tr>`).join('')
    || `<tr><td colspan="5" class="py-6 text-center text-slate-500">${posExtra.q || posExtra.status ? 'No slip matches.' : 'No slips recorded.'}</td></tr>`;
}
function posManualOpen(id) {
  const m = posExtra.slips.find(x => x.id === id); if (!m) return;
  const mgr = canManage();
  posShowModal(`<div class="space-y-3">
    <div class="flex items-start justify-between gap-3"><div><h2 class="text-lg font-semibold">Slip ${esc(m.bookNumber)} ${posSlipChip(m.status)}</h2>
      <div class="text-sm text-slate-600">Written ${esc(posWhen(m.writtenAt))} · recorded by ${esc(m.createdBy)} on ${esc(posWhenShort(m.createdAt))}</div></div>
      <button type="button" onclick="posCloseModal()" class="text-2xl leading-none text-slate-400 px-2" aria-label="Close">×</button></div>
    <div class="text-sm">${esc(m.description)}</div>
    <div class="grid grid-cols-3 gap-2 text-sm"><div class="border rounded-lg p-2"><div class="text-xs text-slate-500">Before tax</div><b>${money(m.saleValue)}</b></div><div class="border rounded-lg p-2"><div class="text-xs text-slate-500">Sales tax</div><b>${money(m.tax)}</b></div><div class="border rounded-lg p-2"><div class="text-xs text-slate-500">Total</div><b>${money(m.total)}</b></div></div>
    <div class="text-sm text-slate-600">Paid by ${esc(posModeName(m.paymentMode))}${[m.buyer.name, m.buyer.pntn && 'PNTN ' + m.buyer.pntn, m.buyer.cnic && 'CNIC ' + m.buyer.cnic, m.buyer.phone].filter(Boolean).length ? ' · Buyer: ' + [m.buyer.name, m.buyer.pntn && 'PNTN ' + m.buyer.pntn, m.buyer.cnic && 'CNIC ' + m.buyer.cnic, m.buyer.phone].filter(Boolean).map(esc).join(' · ') : ''}</div>
    <div class="text-sm text-slate-600">Why it was written by hand: ${esc(m.reason)}</div>
    ${m.status === 'REPORTED' ? posBanner('info', `<b>Reported</b> by ${esc(m.reportedBy)} on ${esc(posWhenShort(m.reportedAt))}: ${esc(m.reportNote)}`) : ''}
    ${m.status === 'VOID' ? posBanner('warn', `<b>Voided</b> by ${esc(m.voidedBy)}: ${esc(m.voidReason)}`) : ''}
    <div id="amAct">${mgr && m.status === 'OPEN' ? `<div class="flex flex-wrap gap-2">${posBtn('Mark as reported…', `posManualAsk('report', '${m.id}')`, 'primary')}${posBtn('Void…', `posManualAsk('void', '${m.id}')`, 'danger')}${posBtn('Close', 'posCloseModal()')}</div>` : mgr && m.status === 'REPORTED' ? `<div class="flex gap-2">${posBtn('Void…', `posManualAsk('void', '${m.id}')`, 'danger')}${posBtn('Close', 'posCloseModal()')}</div>` : posBtn('Close', 'posCloseModal()')}</div></div>`);
}
function posManualAsk(what, id) {
  $('#amAct').innerHTML = `<div class="space-y-2"><label><span>${what === 'report' ? 'How was it reported? (PRA\'s reference, or what was done)' : 'Why is it voided?'}</span><input id="amWhy" maxlength="300" autocomplete="off"></label>
    <div class="flex gap-2">${posBtn(what === 'report' ? 'Mark as reported' : 'Void it', `posManualDo('${what}', '${id}')`, what === 'report' ? 'primary' : 'danger')}${posBtn('Cancel', `posManualOpen('${id}')`)}</div></div>`;
  $('#amWhy').focus();
}
async function posManualDo(what, id) {
  try {
    await api(`/api/pos/manual/${id}/${what}`, { method: 'POST', body: what === 'report' ? { note: $('#amWhy').value } : { reason: $('#amWhy').value } });
    toast(what === 'report' ? 'Marked as reported' : 'Voided', true); posCloseModal(); await posManualLoad(false);
  } catch (err) { toast(err.message); }
}
function posManualForm() {
  const now = new Date(), local = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(now).replace(' ', 'T');
  const modes = (POS.setup && POS.setup.paymentModes) || PosCalc.PAYMENT_MODES;
  posShowModal(`<div class="space-y-3">
    <div class="flex items-start justify-between gap-3"><h2 class="text-lg font-semibold">Record a hand-written slip</h2><button type="button" onclick="posCloseModal()" class="text-2xl leading-none text-slate-400 px-2" aria-label="Close">×</button></div>
    ${posBanner('warn', 'This only records the slip. It is <b>not</b> a fiscal invoice and is not sent to PRA.')}
    <div class="grid sm:grid-cols-2 gap-3">
      <label><span>Number on the slip</span><input id="fmBook" maxlength="40" autocomplete="off"></label>
      <label><span>Written (Pakistan time)</span><input id="fmWhen" type="datetime-local" value="${local}" max="${local}"></label>
      <label class="sm:col-span-2"><span>What was sold</span><input id="fmDesc" maxlength="300" autocomplete="off"></label>
      <label><span>Amount before tax</span><input id="fmValue" inputmode="decimal" oninput="posManualTotal()" autocomplete="off"></label>
      <label><span>Sales tax <span class="text-slate-400">(if charged)</span></span><input id="fmTax" inputmode="decimal" oninput="posManualTotal()" placeholder="0.00" autocomplete="off"></label>
      <div class="sm:col-span-2 text-right text-sm" id="fmTotal"></div>
      <label><span>Paid by</span><select id="fmMode">${modes.map(m => `<option value="${m.id}">${esc(m.label)}</option>`).join('')}</select></label>
      <label><span>Buyer's name <span class="text-slate-400">(optional)</span></span><input id="fmName" maxlength="150" autocomplete="off"></label>
      <label><span>Buyer's phone <span class="text-slate-400">(optional)</span></span><input id="fmPhone" inputmode="tel" maxlength="20" oninput="posPhoneCheck(this)" autocomplete="off"></label>
      <label><span>Why by hand</span><input id="fmReason" maxlength="300" value="PRA could not be reached" autocomplete="off"></label></div>
    <div class="flex gap-2">${posBtn('Record the slip', 'posManualSave()', 'primary')}${posBtn('Cancel', 'posCloseModal()')}</div></div>`);
}
function posManualTotal() { const v = Number($('#fmValue').value) || 0, t = Number($('#fmTax').value) || 0; $('#fmTotal').innerHTML = `Total <b>${money(Math.round((v + t) * 100) / 100)}</b>`; }
async function posManualSave() {
  const body = { bookNumber: $('#fmBook').value, writtenAt: $('#fmWhen').value, description: $('#fmDesc').value, saleValue: $('#fmValue').value, tax: $('#fmTax').value, paymentMode: $('#fmMode').value, reason: $('#fmReason').value, buyer: { name: $('#fmName').value, phone: $('#fmPhone').value } };
  try { await api('/api/pos/manual', { method: 'POST', body }); toast('Slip recorded', true); posCloseModal(); if (S.page === 'p-manual') await posManualLoad(false); } catch (err) { toast(err.message); }
}
