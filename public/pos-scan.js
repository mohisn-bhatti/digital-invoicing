// Reading what a scanner or a camera hands over, for the Point of Sale. Plain functions that run in Node (the server looks things up
// the same way) and in the browser (the cashier's screen finds an item in the catalogue it already has).
//
// What can be scanned:
//   an item's code or barcode (a bare code: ITM0003, an EAN)        → the item, with the price and tax rate it is set to
//   the QR on one of our receipts (PRA's verification address)       → the sale, to open it or to return something
//   a sale's own number (the USIN), or the PRA invoice number        → the same
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.PosScan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MAX = 600; // a QR can carry a lot of text; nothing we look for is anywhere near this
    const clean = v => String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim();

    // What was scanned, as the things to look for:
    //   codes    what an item could be called: the text as read, and without the stars some Code 39 readers wrap round it
    //   invoice  the PRA invoice number, when the text is the address a PRA receipt's QR opens (…?PRAInvNo=…)
    //   usin     the sale number written out in full (123 → 000123): our own numbers have six digits
    function parse(input) {
        const raw = clean(input);
        const out = { raw: raw.slice(0, MAX), codes: [], invoice: null, usin: null, tooLong: raw.length > MAX };
        if (!raw || out.tooLong) return out;
        const m = /[?&]PRAInvNo=([^&#\s]+)/i.exec(raw);
        if (m) {
            let n = m[1]; try { n = decodeURIComponent(n); } catch { /* keep it as it came */ }
            out.invoice = clean(n);
            return out; // an address is not an item code
        }
        out.codes.push(raw);
        const bare = /^\*(.+)\*$/.exec(raw);
        if (bare) out.codes.push(bare[1]);
        if (/^\d{1,6}$/.test(raw)) out.usin = raw.padStart(6, '0');
        return out;
    }

    // The item a scan names, from a catalogue: its barcode first, then its code (no matter the capitals). null when there is none, or
    // when two items answer to it (which the server refuses to save, so only a catalogue that is out of date can show it).
    function findItem(items, input) {
        const p = typeof input === 'string' ? parse(input) : input;
        for (const field of ['barcode', 'code']) {
            for (const c of p.codes) {
                const want = c.toLowerCase();
                const hits = (items || []).filter(i => i[field] && String(i[field]).toLowerCase() === want);
                if (hits.length === 1) return hits[0];
                if (hits.length > 1) return null;
            }
        }
        return null;
    }

    // A barcode scanner types like a very fast keyboard: the characters arrive a few milliseconds apart and Enter ends the code.
    // This tells a scan from a person typing by the gap between keys, so the cashier does not have to click a box first.
    //   const w = PosScan.wedge();  on every keydown: const code = w.key(event.key, Date.now());  (a string when a scan has just ended)
    // A scan is at least two characters, each within maxGap of the one before, and Enter within enterGap of the last. (Shorter codes are
    // allowed because the Enter of a scan that is not recognised would otherwise press whatever button has the focus.)
    function wedge({ minLength = 2, maxGap = 70, enterGap = 250 } = {}) {
        let buf = '', last = 0;
        return {
            key(k, at) {
                if (k === 'Enter') { const s = buf, fresh = at - last <= enterGap; buf = ''; return s.length >= minLength && fresh ? s : null; }
                if (typeof k !== 'string' || k.length !== 1) return null; // Shift, arrows, F-keys …
                if (buf && at - last > maxGap) buf = ''; // too slow for a scanner: a person is typing, begin again
                buf += k; last = at;
                if (buf.length > MAX) buf = '';
                return null;
            },
            reset() { buf = ''; },
            pending() { return buf; },
        };
    }

    return { parse, findItem, wedge, MAX };
});
