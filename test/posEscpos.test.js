// The bytes sent to a thermal printer: the right commands in the right order, text that fits the roll, and nothing a printer cannot print.
const test = require('node:test');
const assert = require('node:assert');
const E = require('../public/pos-escpos.js');

const rc = (over = {}, sale = {}) => ({
    look: { width: 58, header: 'Fine dining', showCashier: true, ...over.look }, business: { name: 'Café Müller & Sons Restaurant', pntn: '1234567-8', address: 'MM Alam Road, Lahore', phone: '', footer: 'Thank you', logo: '' }, branch: null,
    counter: { name: 'Till 1', posId: '900001' },
    sale: {
        usin: '000001', fiscalNumber: 'PRA-1', verifyUrl: 'https://reg.pra.punjab.gov.pk/x?PRAInvNo=PRA-1', invoiceType: 1, paymentMode: 1, mock: false, env: 'PRODUCTION', at: '2026-10-19T08:00:00Z', cashier: 'ali',
        buyer: { name: '', pntn: '', cnic: '', phone: '' }, totals: { quantity: 2, saleValue: 862.07, discount: 0, tax: 137.93, bill: 1000 },
        lines: [{ itemName: 'Biryani — full plate (large size)', quantity: 2, unitPrice: 500, discount: 0, taxRate: 16, saleValue: 862.07, taxCharged: 137.93, totalAmount: 1000, taxInclusive: true }], ...sale,
    },
});
const text = bytes => Buffer.from(bytes).toString('latin1');
// What a printer would print: the commands are read and skipped, the readable lines are kept
function printed(bytes) {
    const b = [...bytes], out = []; let line = '';
    for (let i = 0; i < b.length;) {
        const x = b[i];
        if (x === 0x1b) { i += { 0x40: 2, 0x61: 3, 0x45: 3, 0x64: 3 }[b[i + 1]] || 2; continue; }
        if (x === 0x1d) {
            if (b[i + 1] === 0x21) { i += 3; continue; }
            if (b[i + 1] === 0x56) { i += 4; continue; }
            if (b[i + 1] === 0x28) { i += 5 + (b[i + 3] + b[i + 4] * 256) - 0; continue; } // GS ( k pL pH + pL/pH bytes
            if (b[i + 1] === 0x76) { i += 8 + (b[i + 4] + b[i + 5] * 256) * (b[i + 6] + b[i + 7] * 256); continue; }
            i += 2; continue;
        }
        if (x === 0x0a) { out.push(line); line = ''; } else line += String.fromCharCode(x);
        i++;
    }
    if (line) out.push(line);
    return out;
}

test('printer: a receipt starts by resetting the printer and ends by feeding and cutting', () => {
    const b = E.encodeReceipt(rc());
    assert.deepStrictEqual([...b.slice(0, 2)], [0x1b, 0x40], 'ESC @');
    assert.deepStrictEqual([...b.slice(-4)], [0x1d, 0x56, 66, 0], 'GS V 66 0: feed and cut');
    assert.ok(b instanceof Uint8Array);
    assert.ok([...b].every(x => x >= 0 && x <= 255));
});

test('printer: no line is wider than the roll, and an amount is at the right edge', () => {
    for (const width of [58, 80]) {
        const cols = E.COLS[width];
        for (const l of printed(E.encodeReceipt(rc({ look: { width } })))) assert.ok(l.length <= cols, `${width} mm: "${l}" is ${l.length} wide`);
        const total = printed(E.encodeReceipt(rc({ look: { width } }))).find(l => /TOTAL\s+1,000\.00/.test(l));
        assert.ok(total, 'the total row is there');
        assert.ok(total.endsWith('1,000.00'));
    }
});

test('printer: a long label wraps without losing a letter, and a very long word is cut at the line', () => {
    assert.deepStrictEqual(E.wrap('Biryani full plate (large size)', 28), ['Biryani full plate (large', 'size)']);
    assert.deepStrictEqual(E.wrap('A'.repeat(70), 32), ['A'.repeat(32), 'A'.repeat(32), 'A'.repeat(6)]);
    assert.strictEqual(E.wrap('one two  three', 40).join(' '), 'one two three');
    assert.strictEqual(E.wrap('', 10).length, 1);
});

test('printer: only plain letters go out (accents are dropped, anything else is a question mark)', () => {
    assert.strictEqual(E.ascii('Café Müller × 2 — “ok” …'), 'Cafe Muller x 2 - "ok" ...');
    assert.strictEqual(E.ascii('چائے 100'), '????? 100');
    assert.strictEqual(E.ascii(null), '');
    const b = E.encodeReceipt(rc({}, { buyer: { name: 'اللہ بخش', pntn: '', cnic: '', phone: '' } }));
    assert.ok(!/[^\x00-\x7f]/.test(text(b).replace(/[\x80-\xff]/g, '')), 'nothing but ASCII from the text');
    assert.ok(!text(b).includes('Café'), 'no raw accented bytes');
});

test('printer: the QR code uses the printer\'s own command with the address inside it', () => {
    const url = rc().sale.verifyUrl;
    const b = [...E.encodeReceipt(rc())];
    const cmd = (fn) => b.findIndex((x, i) => x === 0x1d && b[i + 1] === 0x28 && b[i + 2] === 0x6b && b[i + 5] === 49 && b[i + 6] === fn); // GS ( k pL pH 49 fn ...
    const store = cmd(80);
    assert.ok(store > 0, 'the store-data command is there');
    const len = b[store + 3] + b[store + 4] * 256;
    assert.strictEqual(len, url.length + 3, 'its length counts the address and 3 bytes');
    assert.strictEqual(Buffer.from(b.slice(store + 8, store + 8 + url.length)).toString('latin1'), url);
    assert.ok(cmd(81) > store, 'and the print command comes after it');
    assert.ok(cmd(65) > 0 && cmd(67) > 0 && cmd(69) > 0, 'model, size and error correction are set first');
    assert.ok(text(E.encodeReceipt(rc())).includes(url), 'the address is also printed in words, for a printer with no QR command');
});

test('printer: credit and debit notes, tax-inclusive lines, a test-mode banner and the cashier all come out in words', () => {
    const lines = x => printed(E.encodeReceipt(x, { modeName: 'Cash' })).join('\n');
    assert.match(lines(rc({}, { invoiceType: 3, refUsin: '000009' })), /CREDIT NOTE[\s\S]*Returns invoice 000009[\s\S]*TOTAL RETURNED/);
    assert.match(lines(rc({}, { invoiceType: 2, refUsin: '000009' })), /DEBIT NOTE[\s\S]*Adds to invoice 000009/);
    assert.match(lines(rc()), /TAX INVOICE/);
    assert.match(lines(rc()), /2 x 500\.00 \(incl\. tax\)\s+862\.07/);
    assert.match(lines(rc({}, { mock: true })), /TEST MODE: NOT A FISCAL INVOICE/);
    assert.match(lines(rc({}, { mock: false, env: 'SANDBOX' })), /PRA SANDBOX TEST/);
    assert.match(lines(rc()), /Cashier\s+ali/);
    assert.ok(!/Cashier/.test(lines(rc({ look: { showCashier: false } }))), 'only when the owner wants the cashier named');
    assert.match(printed(E.encodeReceipt(rc({ look: { width: 80 } }, { buyer: { name: 'Khan Events', pntn: '1234567-8', cnic: '', phone: '0300' } }))).join('\n'), /Buyer: Khan Events \| PNTN 1234567-8 \| 0300/);
});

test('printer: a logo is sent as a black-and-white picture, and see-through counts as white paper', () => {
    // 10 pixels wide, 2 high: the first pixel black, the second see-through black, the rest white
    const px = new Uint8ClampedArray(10 * 2 * 4).fill(255);
    px.set([0, 0, 0, 255], 0); px.set([0, 0, 0, 0], 4);
    px.set([0, 0, 0, 255], (10 + 9) * 4); // the last pixel of the second row
    const r = E.logoRaster(px, 10, 2);
    assert.strictEqual(r.width, 16, 'padded to whole bytes');
    assert.strictEqual(r.height, 2);
    assert.deepStrictEqual([...r.bytes], [0b10000000, 0b00000000, 0b00000000, 0b01000000]);
    const b = [...E.encodeReceipt(rc(), { logo: r })];
    const at = b.findIndex((x, i) => x === 0x1d && b[i + 1] === 0x76 && b[i + 2] === 0x30);
    assert.ok(at > 0);
    assert.deepStrictEqual(b.slice(at, at + 8), [0x1d, 0x76, 0x30, 0, 2, 0, 2, 0], 'GS v 0, 2 bytes wide, 2 high');
    assert.deepStrictEqual(b.slice(at + 8, at + 12), [0b10000000, 0, 0, 0b01000000]);
});

test('printer: the test slip fits the roll it is for', () => {
    for (const width of [58, 80]) {
        const t = text(E.encodeTest(width));
        assert.ok(t.includes('0123456789'.repeat(Math.ceil(E.COLS[width] / 10)).slice(0, E.COLS[width])));
        assert.ok(!t.includes('0123456789'.repeat(Math.ceil(E.COLS[width] / 10) + 1)));
    }
    assert.deepStrictEqual([...E.encodeTest(58).slice(0, 2)], [0x1b, 0x40]);
});
