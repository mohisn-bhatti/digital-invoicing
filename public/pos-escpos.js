'use strict';
/* Receipt bytes for a thermal printer (ESC/POS, the language of almost every 58 and 80 mm roll printer), built from the same receipt the
   screen prints. Pure functions, no browser: the same file is tested on the server's side. What is sent to the printer (Bluetooth or USB
   from a phone) is in pos-extras.js.
   - Text is plain ASCII: the printer's own code page cannot be relied on, so accents are dropped and anything else becomes "?".
   - The QR code uses the printer's built-in QR command (GS ( k); the address is printed under it as well, for printers without one.
   - The logo, if there is one, is sent as a black-and-white picture (GS v 0), made in the browser by logoRaster(). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PosEscpos = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ESC = 0x1b, GS = 0x1d, LF = 0x0a;
  const COLS = { 58: 32, 80: 48 }; // characters per line in the printer's normal font
  const DOTS = { 58: 384, 80: 576 }; // printable dots across the roll

  const ascii = v => String(v === undefined || v === null ? '' : v)
    .replace(/[×]/g, 'x').replace(/[−–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/·/g, '|').replace(/…/g, '...')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?');
  const money = n => Number(n || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Cuts text into lines of at most `cols` characters, at spaces where it can, never losing a character
  function wrap(text, cols) {
    const out = [];
    for (const para of ascii(text).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        if (!word) continue;
        let w = word;
        while (w.length > cols) { if (line) { out.push(line); line = ''; } out.push(w.slice(0, cols)); w = w.slice(cols); }
        if (!line) line = w;
        else if (line.length + 1 + w.length <= cols) line += ' ' + w;
        else { out.push(line); line = w; }
      }
      out.push(line);
    }
    return out;
  }

  class Builder {
    constructor(cols) { this.cols = cols; this.bytes = []; }
    raw(...b) { for (const x of b.flat()) this.bytes.push(x & 0xff); return this; }
    init() { return this.raw(ESC, 0x40); }
    align(a) { return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[a]); }
    bold(on) { return this.raw(ESC, 0x45, on ? 1 : 0); }
    size(w, h) { return this.raw(GS, 0x21, ((w - 1) << 4) | (h - 1)); } // 1 to 8 times as wide and as high
    text(s) { for (const ch of ascii(s)) this.bytes.push(ch.charCodeAt(0)); return this; }
    line(s = '') { return this.text(s).raw(LF); }
    lines(s, cols) { for (const l of wrap(s, cols || this.cols)) this.line(l); return this; }
    rule(ch = '-') { return this.line(ch.repeat(this.cols)); }
    // a label at the left and an amount at the right; a label too long for the line goes first, the amount alone under it
    row(l, r) {
      l = ascii(l); r = ascii(r);
      if (l.length + r.length + 1 <= this.cols) return this.line(l + ' '.repeat(this.cols - l.length - r.length) + r);
      const parts = wrap(l, this.cols);
      const last = parts[parts.length - 1];
      for (const p of parts.slice(0, -1)) this.line(p);
      if (last.length + r.length + 1 <= this.cols) return this.line(last + ' '.repeat(this.cols - last.length - r.length) + r);
      this.line(last);
      return this.line(' '.repeat(Math.max(0, this.cols - r.length)) + r.slice(-this.cols));
    }
    qr(data, moduleSize) {
      const d = Buffer_from(ascii(data)), n = d.length + 3;
      this.raw(GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0); // model 2
      this.raw(GS, 0x28, 0x6b, 3, 0, 49, 67, moduleSize); // size of one square
      this.raw(GS, 0x28, 0x6b, 3, 0, 49, 69, 48); // error correction L
      this.raw(GS, 0x28, 0x6b, n & 0xff, n >> 8, 49, 80, 48, d); // store
      return this.raw(GS, 0x28, 0x6b, 3, 0, 49, 81, 48); // print
    }
    // raster: { width (dots), height, bytes } from logoRaster()
    image(r) { return this.raw(GS, 0x76, 0x30, 0, (r.width / 8) & 0xff, (r.width / 8) >> 8, r.height & 0xff, r.height >> 8, Array.from(r.bytes)); }
    feed(n) { return this.raw(ESC, 0x64, n); }
    cut() { return this.raw(GS, 0x56, 66, 0); } // feed a little, then cut (a printer with no cutter ignores it)
    done() { return Uint8Array.from(this.bytes); }
  }
  const Buffer_from = s => Array.from(s, ch => ch.charCodeAt(0));

  // RGBA pixels (from a canvas, already the size wanted) → a 1-bit picture. A pixel is black when it is dark and not see-through.
  function logoRaster(rgba, width, height) {
    const w = Math.ceil(width / 8) * 8, bytes = new Uint8Array((w / 8) * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4, a = rgba[i + 3] / 255;
        const lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * a + 255 * (1 - a); // see-through counts as white paper
        if (lum < 140) bytes[y * (w / 8) + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return { width: w, height, bytes };
  }

  // rc: the receipt from /api/pos/sales/:id/receipt. opts.logo: a logoRaster() picture to print at the top. Returns the bytes to send.
  function encodeReceipt(rc, opts = {}) {
    const width = rc.look && rc.look.width === 58 ? 58 : 80, cols = COLS[width];
    const s = rc.sale, b = rc.business, look = rc.look || {}, credit = s.invoiceType === 3, debit = s.invoiceType === 2;
    const p = new Builder(cols).init();
    p.align('center');
    if (opts.logo) p.image(opts.logo).line();
    const test = s.mock ? 'TEST MODE: NOT A FISCAL INVOICE' : s.env === 'SANDBOX' ? 'PRA SANDBOX TEST: NOT A REAL INVOICE' : '';
    if (test) { p.bold(true).lines(test).bold(false).line(); }
    p.bold(true).size(1, 2).lines(b.name, cols).size(1, 1).bold(false);
    if (look.header) p.lines(look.header);
    if (rc.branch) p.lines(rc.branch.name + (rc.branch.address ? ', ' + rc.branch.address : ''));
    if (b.address) p.lines(b.address);
    if (b.phone) p.lines('Tel: ' + b.phone);
    p.lines('PNTN / NTN: ' + (b.pntn || '-'));
    p.rule();
    p.bold(true).line(credit ? 'CREDIT NOTE' : debit ? 'DEBIT NOTE' : 'TAX INVOICE').bold(false);
    if (credit) p.lines('Returns invoice ' + (s.refUsin || ''));
    if (debit) p.lines('Adds to invoice ' + (s.refUsin || ''));
    p.align('left');
    p.row('PRA invoice no.', s.fiscalNumber).row('Invoice no. (USIN)', s.usin);
    p.row('Date', fmtDate(s.at)).row('Counter', `${rc.counter.name} (POS ${rc.counter.posId})`);
    if (look.showCashier !== false && s.cashier) p.row('Cashier', s.cashier);
    const buyer = [s.buyer.name, s.buyer.pntn && 'PNTN ' + s.buyer.pntn, s.buyer.cnic && 'CNIC ' + s.buyer.cnic, s.buyer.phone].filter(Boolean);
    if (buyer.length) p.lines('Buyer: ' + buyer.join(' | '));
    p.rule();
    for (const l of s.lines) {
      p.bold(true).lines(l.itemName).bold(false);
      p.row(`${l.quantity} x ${money(l.unitPrice)}${l.taxInclusive ? ' (incl. tax)' : ''}${l.discount ? ` - disc ${money(l.discount)}` : ''}`, money(l.saleValue));
      p.row(`Sales tax ${l.taxRate}%`, money(l.taxCharged)).row('Item total', money(l.totalAmount));
    }
    p.rule();
    p.row('Total quantity', String(s.totals.quantity)).row('Value before tax', money(s.totals.saleValue));
    if (s.totals.discount) p.row('Discount given', money(s.totals.discount));
    p.row('Sales tax', money(s.totals.tax));
    p.bold(true).size(1, 2).row(credit ? 'TOTAL RETURNED' : 'TOTAL', money(s.totals.bill)).size(1, 1).bold(false);
    p.row('Paid by', opts.modeName || String(s.paymentMode));
    p.rule().align('center');
    p.qr(s.verifyUrl, width === 58 ? 5 : 6).line();
    p.lines('Scan to verify this invoice with PRA').lines(s.verifyUrl);
    if (b.footer) p.line().lines(b.footer);
    return p.feed(4).cut().done();
  }
  // 19 Oct 2026, 14:30 in Pakistan time (what the screen shows, without seconds)
  const fmtDate = d => (d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '-');

  // A short slip to prove the printer is the right one and the paper the right width
  function encodeTest(width) {
    const w = width === 58 ? 58 : 80, p = new Builder(COLS[w]).init();
    p.align('center').bold(true).size(2, 2).line('TEST').size(1, 1).bold(false).line('Point of Sale printer test').align('left').rule('=');
    p.line('0123456789'.repeat(Math.ceil(COLS[w] / 10)).slice(0, COLS[w])).row('Left', 'Right').rule('=');
    return p.feed(3).cut().done();
  }

  return { COLS, DOTS, ascii, wrap, encodeReceipt, encodeTest, logoRaster };
});
