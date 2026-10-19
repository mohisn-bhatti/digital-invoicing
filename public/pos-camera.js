'use strict';
/* Point of Sale scanning: the camera window, the barcode scanner that types like a keyboard, what a scan does on each screen, and the
   printable QR labels. Loaded after pos.js and pos-scan.js, so it can use their helpers (POS, posAdd, posBtn, PosScan ...) when its
   functions run.

   What can be scanned (see public/pos-scan.js): an item's barcode or code, the QR on one of our receipts, a sale's own number.
   Where: a USB or Bluetooth scanner anywhere on the sale screen, or the camera of the phone, tablet or laptop. */

const POS_SCAN_FORMATS = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar']; // names the browser's own detector uses
const POS_SCAN_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js'; // for browsers with no detector of their own (Safari)
const posScan = { open: false, stream: null, lib: null, timer: null, handler: null, continuous: false, last: '', seenAt: 0, busy: false, torch: false };
const POS_SCAN_GONE_MS = 1200; // a code must be out of the camera's sight this long before it counts again: one code held in front of it is one scan

// A short beep and a buzz when a code is read (not every device has either)
function posBeep(ok = true) {
  try { if (navigator.vibrate) navigator.vibrate(ok ? 40 : [60, 40, 60]); } catch { /* no vibration here */ }
  try {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ac = POS.audio || (POS.audio = new AC()), o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = ok ? 880 : 220; g.gain.value = 0.06; o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + (ok ? 0.08 : 0.25));
  } catch { /* no sound here */ }
}

// Why the camera would not start, in words the cashier can act on
function posCameraError(err) {
  const name = (err && err.name) || String(err || '').split(':')[0];
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'The camera only works on a secure (https) connection.';
  if (/NotAllowed|PermissionDenied|Security/i.test(name)) return 'The camera is blocked. Allow the camera for this site in the browser settings, then try again.';
  if (/NotFound|DevicesNotFound|Overconstrained/i.test(name)) return 'No camera was found on this device.';
  if (/NotReadable|TrackStart/i.test(name)) return 'The camera is being used by another app. Close it and try again.';
  return `The camera could not be started${err && err.message ? ' (' + String(err.message).slice(0, 120) + ')' : ''}.`;
}

/* ---------- the camera window ---------- */
function posEnsureScanModal() {
  if (document.getElementById('posScanModal')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="posScanModal" class="hidden fixed inset-0 z-[70] bg-black/70 flex items-start sm:items-center justify-center p-2 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="posScanTitle">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-4 space-y-3 mt-2 sm:mt-0">
        <div class="flex items-start justify-between gap-3"><div class="min-w-0"><h2 id="posScanTitle" class="font-semibold"></h2><p id="posScanHint" class="text-xs text-slate-500"></p></div>
          <button type="button" onclick="posScanClose()" class="text-2xl leading-none text-slate-400 px-2 -mt-1" aria-label="Close the camera">×</button></div>
        <div class="relative bg-black rounded-lg overflow-hidden" style="aspect-ratio:4/3">
          <video id="posScanVideo" class="w-full h-full object-cover" playsinline muted autoplay></video>
          <div id="posScanRegion" class="hidden w-full h-full"></div>
          <div class="absolute inset-0 pointer-events-none flex items-center justify-center"><div class="w-2/3 border-2 border-emerald-400 rounded-xl" style="aspect-ratio:1/1"></div></div></div>
        <div id="posScanStatus" class="text-sm min-h-[1.5rem]" aria-live="polite"></div>
        <div class="flex gap-2"><input id="posScanType" placeholder="…or type or paste the code" class="flex-1 min-w-0" autocomplete="off" onkeydown="if (event.key === 'Enter') { event.preventDefault(); posScanTyped(); }">
          <button type="button" onclick="posScanTyped()" class="px-4 rounded-lg border">Use</button></div>
        <div class="flex items-center justify-between gap-2"><button type="button" id="posScanTorch" onclick="posScanTorch()" class="hidden px-3 min-h-[2.5rem] rounded-lg border text-sm">Light</button>
          <button type="button" onclick="posScanClose()" class="ml-auto px-5 min-h-[2.5rem] rounded-lg bg-emerald-700 text-white text-sm">Done</button></div>
      </div></div>`);
}
function posScanStatus(text, bad) {
  const el = document.getElementById('posScanStatus'); if (!el) return;
  el.className = `text-sm min-h-[1.5rem] ${bad ? 'text-red-700' : 'text-emerald-800'}`;
  el.textContent = text || '';
}

// Opens the camera. onCode(text) is called for each code read and answers { ok, message }: single mode closes the window after the first
// good one, continuous mode (the sale screen) stays open for the next item.
async function posScanOpen({ title, hint, onCode, continuous = false }) {
  posScanClose();
  posEnsureScanModal();
  Object.assign(posScan, { open: true, handler: onCode, continuous, last: '', seenAt: 0, busy: false, torch: false });
  document.getElementById('posScanTitle').textContent = title || 'Scan';
  document.getElementById('posScanHint').textContent = hint || 'Hold the code in the frame.';
  document.getElementById('posScanVideo').classList.remove('hidden'); document.getElementById('posScanRegion').classList.add('hidden');
  document.getElementById('posScanTorch').classList.add('hidden');
  posScanStatus('Starting the camera…');
  document.getElementById('posScanModal').classList.remove('hidden');
  try {
    if ('BarcodeDetector' in window) await posScanNative(); else await posScanLibrary();
    if (posScan.open) posScanStatus('Ready: hold a barcode or QR code in the frame.');
  } catch (err) {
    if (!posScan.open) return; // closed meanwhile
    posScanStatus(`${posCameraError(err)} You can type the code below instead.`, true);
    const t = document.getElementById('posScanType'); if (t) t.focus();
  }
}

// The browser's own detector: quick, and nothing to download
async function posScanNative() {
  let formats = POS_SCAN_FORMATS;
  try { const known = await BarcodeDetector.getSupportedFormats(); formats = POS_SCAN_FORMATS.filter(f => known.includes(f)); } catch { /* use the whole list */ }
  if (!formats.length) return posScanLibrary(); // a detector that reads none of the formats we need
  const detector = new BarcodeDetector({ formats });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  if (!posScan.open) { stream.getTracks().forEach(t => t.stop()); return; } // closed while the permission box was showing
  posScan.stream = stream;
  const video = document.getElementById('posScanVideo');
  video.srcObject = stream;
  try { await video.play(); } catch { /* autoplay is on anyway */ }
  try { const caps = stream.getVideoTracks()[0].getCapabilities && stream.getVideoTracks()[0].getCapabilities(); if (caps && caps.torch) document.getElementById('posScanTorch').classList.remove('hidden'); } catch { /* no light control */ }
  const tick = async () => {
    if (!posScan.open || posScan.stream !== stream) return;
    try { if (video.readyState >= 2) { const found = await detector.detect(video); if (found.length) await posScanGot(found[0].rawValue); } } catch { /* a frame that could not be read: the next one will do */ }
    posScan.timer = setTimeout(tick, 120);
  };
  tick();
}

// Safari has no detector: a decoder library from the CDN (like the QR drawing library the receipts use)
function posLoadScanLib() {
  if (window.Html5Qrcode) return Promise.resolve();
  return (POS.libLoading = POS.libLoading || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = POS_SCAN_LIB; s.onload = resolve;
    s.onerror = () => { POS.libLoading = null; reject(new Error('The scanner could not be loaded: check the internet connection')); };
    document.head.appendChild(s);
  }));
}
async function posScanLibrary() {
  await posLoadScanLib();
  if (!posScan.open) return;
  document.getElementById('posScanVideo').classList.add('hidden'); document.getElementById('posScanRegion').classList.remove('hidden');
  const F = Html5QrcodeSupportedFormats;
  const reader = new Html5Qrcode('posScanRegion', { verbose: false, formatsToSupport: ['QR_CODE', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128', 'CODE_39', 'CODE_93', 'ITF', 'CODABAR'].map(n => F[n]).filter(v => v !== undefined) });
  posScan.lib = reader;
  try {
    await reader.start({ facingMode: 'environment' }, { fps: 10, qrbox: (w, h) => { const m = Math.floor(Math.min(w, h) * 0.7); return { width: m, height: m }; } }, text => { posScanGot(text); }, () => {});
  } catch (err) { posScan.lib = null; throw (err && err.name ? err : Object.assign(new Error(String(err)), { name: String(err).split(':')[0] })); }
}

// A code was read (by the camera or typed). The camera reports a code over and over while it is in view, so a code seen again within
// POS_SCAN_GONE_MS of the last sighting is the same scan, however long it stays there: every sighting counts as "still there".
async function posScanGot(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text || !posScan.open) return;
  const at = Date.now(), held = text === posScan.last && at - posScan.seenAt < POS_SCAN_GONE_MS;
  if (text === posScan.last) posScan.seenAt = at;
  if (held || posScan.busy) return;
  posScan.last = text; posScan.seenAt = at; posScan.busy = true;
  try {
    const r = (await posScan.handler(text)) || {};
    posBeep(r.ok !== false);
    posScanStatus(r.message || (r.ok === false ? 'Not recognised' : 'Scanned'), r.ok === false);
    if (r.ok !== false && !posScan.continuous) { posScan.busy = false; posScanClose(); return; }
  } catch (err) { posBeep(false); posScanStatus(err.message || 'Something went wrong', true); }
  posScan.busy = false; posScan.seenAt = Date.now(); // (the code is most likely still in front of the camera)
}
function posScanTyped() {
  const box = document.getElementById('posScanType'); if (!box) return;
  const text = box.value.trim(); box.value = '';
  posScan.last = ''; // a typed code is always meant
  posScanGot(text);
}
async function posScanTorch() {
  try {
    const track = posScan.stream && posScan.stream.getVideoTracks()[0]; if (!track) return;
    posScan.torch = !posScan.torch;
    await track.applyConstraints({ advanced: [{ torch: posScan.torch }] });
  } catch { posScan.torch = false; }
}
function posScanClose() {
  posScan.open = false; clearTimeout(posScan.timer);
  if (posScan.stream) { posScan.stream.getTracks().forEach(t => t.stop()); posScan.stream = null; }
  if (posScan.lib) { const l = posScan.lib; posScan.lib = null; Promise.resolve().then(() => l.stop()).catch(() => {}).finally(() => { try { l.clear(); } catch { /* nothing to clear */ } }); }
  const m = document.getElementById('posScanModal'); if (m) m.classList.add('hidden');
  const v = document.getElementById('posScanVideo'); if (v) v.srcObject = null;
}

POS_RESETS.push(posScanClose); // a new login must not find the camera still on

/* ---------- the barcode scanner that types like a keyboard ---------- */
// A scanner "types" the code a few milliseconds per character and presses Enter. On the sale screen that is recognised wherever the
// cursor is (not in a box the cashier is typing in), so nobody has to click a field before scanning.
function posInstallScanner() {
  if (POS.wedgeOn) return;
  POS.wedgeOn = true;
  const wedge = PosScan.wedge();
  document.addEventListener('keydown', ev => {
    if (S.page !== 'p-sale' || S.module !== 'POS' || POS.busy || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) { wedge.reset(); return; } // the cashier is typing: the box's own handler does the work
    const open = id => { const e = document.getElementById(id); return e && !e.classList.contains('hidden'); };
    if (open('posModal') || open('posReceiptModal') || open('posScanModal')) { wedge.reset(); return; }
    // A list (the counter) is not a typing box: left alone, its own "type to pick" would take the letters of a scan and change the counter
    // the next sale goes to. Letters never choose from it here; the arrows, Space and Enter still work for a person.
    if (tag === 'SELECT' && ev.key.length === 1 && ev.key !== ' ') ev.preventDefault();
    const code = wedge.key(ev.key, Date.now());
    if (code) { ev.preventDefault(); posScanSale(code).then(r => { posBeep(!r || r.ok !== false); if (r && r.ok === false) toast(r.message); }); }
    else if (ev.key.length === 1 && ev.key !== ' ' && wedge.pending().length > 1) ev.preventDefault(); // no button reacts to the letters of a scan
  });
}

/* ---------- what a scan does on each screen ---------- */
// The line shown after an item is scanned: what it is set to, which is the point of scanning it instead of adding it by hand
function posScanLine(item) {
  const inSale = POS.cart.filter(c => c.itemId === item.id).reduce((t, c) => t + Number(c.qty || 0), 0);
  const price = item.openPrice ? 'enter the price' : money(item.unitPrice);
  const tax = item.taxRateCard !== null && item.taxRateCard !== undefined ? `tax ${item.taxRate}% (${item.taxRateCard}% when paid by card)` : `tax ${item.taxRate}%`;
  return `${item.name}: ${price} · ${tax}${inSale ? ` · ${inSale} in this sale` : ''}`;
}
function posScanNote(item) {
  const el = document.getElementById('pScanNote'); if (!el) return;
  el.innerHTML = `<div class="rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-900 px-3 py-2 text-sm"><b>${esc(item.name)}</b> added · ${item.openPrice ? 'type the price in the sale' : money(item.unitPrice)} · tax ${item.taxRate}%${item.taxRateCard !== null && item.taxRateCard !== undefined ? ` (${item.taxRateCard}% by card)` : ''}</div>`;
  clearTimeout(POS.scanNoteTimer); POS.scanNoteTimer = setTimeout(() => { el.innerHTML = ''; }, 6000);
}
function posScanNoteHtml(html, tone) {
  const el = document.getElementById('pScanNote'); if (!el) return;
  const c = tone === 'bad' ? 'border-red-300 bg-red-50 text-red-900' : 'border-sky-300 bg-sky-50 text-sky-900';
  el.innerHTML = `<div class="rounded-lg border ${c} px-3 py-2 text-sm">${html}</div>`;
  clearTimeout(POS.scanNoteTimer); POS.scanNoteTimer = setTimeout(() => { el.innerHTML = ''; }, 12000);
}

// A code was scanned (or typed) on the sale screen
async function posScanSale(raw) {
  if (POS.busy) return { ok: false, message: 'A sale is being sent: wait a moment.' };
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return { ok: false, message: 'Nothing was read.' };
  const add = item => {
    posAdd(item.id); posScanNote(item);
    if (item.openPrice && !(document.getElementById('posScanModal') && !document.getElementById('posScanModal').classList.contains('hidden'))) { const boxes = document.querySelectorAll('#pCart input[aria-label="Price"]'); if (boxes.length) boxes[boxes.length - 1].focus(); }
    return { ok: true, message: posScanLine(item) };
  };
  const item = PosScan.findItem(POS.setup.items, text);
  if (item) return add(item);
  // not in the list this screen has: a receipt (to look at or to return), or an item that was added a moment ago
  let found;
  try { found = await api('/api/pos/lookup?code=' + encodeURIComponent(text)); } catch (err) { return { ok: false, message: err.message }; }
  if (found.item && found.item.active) { await posLoadSetup(); posRenderGrid(); if (POS.itemsById.has(found.item.id)) return add(found.item); }
  if (found.sale) {
    const s = found.sale;
    posScanNoteHtml(`That code is <b>sale ${esc(s.usin)}</b> (${esc(POS_STATES[s.state] ? POS_STATES[s.state][0] : s.state)}, ${money(s.totalBill)}). ${posBtn('Open it', `posOpenSale('${s.id}')`)}`, 'info');
    return { ok: true, message: `That is a receipt: sale ${s.usin}` };
  }
  posScanNoteHtml(`Nothing matches <b>${esc(text.slice(0, 60))}</b>. ${canManage() ? 'Add it under Items (the Scan button there starts a new item with this code).' : 'Ask a manager to add it under Items.'}`, 'bad');
  return { ok: false, message: `Nothing matches "${text.slice(0, 40)}"` };
}
function posScanForSale() {
  if (!POS.setup) return toast('The sale screen is still loading.');
  return posScanOpen({ title: 'Scan items', hint: 'Hold a barcode or QR code in the frame: each scan adds one to the sale. Press Done when finished.', continuous: true, onCode: posScanSale });
}

// Items page: scan to find an item and change it, or to start a new one with the code already in (the usual way to add a product that has a barcode)
function posScanForItems() {
  return posScanOpen({
    title: 'Scan an item', hint: 'An item that is already here opens for changing; a new code starts a new item.',
    onCode: async raw => {
      const text = String(raw).trim();
      const r = await api('/api/pos/lookup?code=' + encodeURIComponent(text));
      if (r.item) {
        if (!POS.items.some(i => i.id === r.item.id)) { POS.itemQ = ''; const q = document.getElementById('piQ'); if (q) q.value = ''; await posLoadItems(); }
        setTimeout(() => posItemForm(r.item.id), 0);
        return { ok: true, message: `${r.item.name}: opened for changing` };
      }
      if (PosScan.parse(text).invoice) return { ok: false, message: 'That is a receipt, not an item.' };
      setTimeout(() => posItemForm(null, { barcode: text.slice(0, 50) }), 0);
      return { ok: true, message: 'New code: fill in the item' };
    },
  });
}
// Fill a box from the camera (the barcode box of the item form)
function posScanIntoField(id) {
  return posScanOpen({ title: 'Scan the barcode', hint: 'Hold the barcode or QR code in the frame.', onCode: raw => { const box = document.getElementById(id); if (box) box.value = String(raw).trim().slice(0, 50); return { ok: true, message: 'Filled in' }; } });
}
// Sales page: scan a receipt (its QR) to open the sale: to look at it, reprint it, or return something
function posScanForSales() {
  return posScanOpen({
    title: 'Scan a receipt', hint: 'Hold the QR code at the bottom of the receipt in the frame.',
    onCode: async raw => {
      const r = await api('/api/pos/lookup?code=' + encodeURIComponent(String(raw).trim()));
      if (!r.sale) return { ok: false, message: 'No sale of this business matches that code.' };
      setTimeout(() => posOpenSale(r.sale.id), 0);
      return { ok: true, message: `Sale ${r.sale.usin}` };
    },
  });
}

/* ---------- printable QR labels ---------- */
function posLabelsDialog() {
  const items = (POS.items || []).filter(i => i.active);
  if (!items.length) return toast('There are no items on sale to print labels for.');
  posShowModal(`<div class="space-y-3"><div class="flex items-start justify-between gap-3"><h2 class="text-lg font-semibold">Print QR labels</h2>
      <button type="button" onclick="posCloseModal()" class="text-2xl leading-none text-slate-400 px-2" aria-label="Close">×</button></div>
    <p class="text-sm text-slate-600">One label for each of the <b>${items.length}</b> items on sale in the list${POS.itemQ ? ' (those that match your search)' : ''}. The QR code holds the item's barcode, or its code when it has none. Scanning it on the sale screen adds the item at the price and tax rate it is set to.</p>
    <div class="grid sm:grid-cols-2 gap-3 text-sm">
      <label><span>Paper</span><select id="lbSize"><option value="sheet">A4 sheet: 21 labels a page, cut by hand</option><option value="roll">Label roll: 50 × 30 mm</option></select></label>
      <label><span>Copies of each</span><input id="lbCopies" type="number" min="1" max="20" value="1" inputmode="numeric"></label>
      <label class="flex items-center gap-2 sm:col-span-2"><input id="lbPrice" type="checkbox" checked style="width:auto"> Print the price on the label</label></div>
    <div class="flex gap-2">${posBtn('Print', 'posLabelsPrint()', 'primary')}${posBtn('Cancel', 'posCloseModal()')}</div></div>`);
}
// One label: the QR, the name, the price and the code. mm sizes are for the paper, not the screen.
function posLabelHtml(i, { price, roll }) {
  const code = i.barcode || i.code;
  const p = !price ? '' : i.openPrice ? 'price on sale' : money(i.unitPrice);
  const box = roll ? 'width:50mm;height:30mm;page-break-after:always;padding:1.5mm' : 'width:62mm;height:36mm;padding:2mm;border:0.2mm dashed #aaa';
  return `<div style="${box};box-sizing:border-box;display:flex;gap:2mm;align-items:center;overflow:hidden;break-inside:avoid">
    <div class="lblqr" data-code="${esc(code)}" style="flex:none;width:${roll ? 22 : 27}mm;height:${roll ? 22 : 27}mm"></div>
    <div style="min-width:0;font-family:Arial,Helvetica,sans-serif;color:#000"><div style="font-weight:bold;font-size:${roll ? 9 : 11}pt;line-height:1.15;max-height:3.5em;overflow:hidden;overflow-wrap:anywhere">${esc(i.name)}</div>
      ${p ? `<div style="font-size:${roll ? 9 : 10}pt;margin-top:1mm">${esc(p)}</div>` : ''}<div style="font-family:ui-monospace,Menlo,monospace;font-size:7pt;margin-top:1mm;overflow-wrap:anywhere">${esc(code)}</div></div></div>`;
}
function posLabelsPrint() {
  const items = (POS.items || []).filter(i => i.active);
  const roll = $('#lbSize').value === 'roll', price = $('#lbPrice').checked;
  const copies = Math.max(1, Math.min(20, Math.round(Number($('#lbCopies').value) || 1)));
  const labels = items.flatMap(i => Array.from({ length: copies }, () => posLabelHtml(i, { price, roll })));
  posCloseModal();
  const html = roll ? labels.join('') : `<div style="display:grid;grid-template-columns:repeat(3,62mm);gap:2mm;justify-content:start">${labels.join('')}</div>`;
  posPrint(html, roll ? '@page { size: 50mm 30mm; margin: 0; }' : '@page { size: A4; margin: 8mm; }', area => {
    const missing = typeof QRCode === 'undefined';
    area.querySelectorAll('.lblqr').forEach(el => {
      if (missing) { el.textContent = el.dataset.code; el.style.fontSize = '8pt'; return; }
      new QRCode(el, { text: el.dataset.code, width: 128, height: 128, correctLevel: QRCode.CorrectLevel.M });
      el.querySelectorAll('img, canvas').forEach(x => { x.style.width = '100%'; x.style.height = '100%'; });
    });
    if (missing) toast('The QR code could not be drawn (no connection to the library): the code is printed as text.');
  });
}
