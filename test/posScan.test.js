// The scan reader shared by the server and the cashier's screen (public/pos-scan.js): what a scan is, which item it names, and how a
// barcode scanner (which types like a very fast keyboard) is told from a person typing.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../public/pos-scan');
const praReal = require('../src/pos/pra');

test('scan: a bare code is itself, whatever the scanner added round it', () => {
    assert.deepStrictEqual(S.parse('ITM0003'), { raw: 'ITM0003', codes: ['ITM0003'], invoice: null, usin: null, tooLong: false });
    assert.deepStrictEqual(S.parse('  8964000123456\r\n').codes, ['8964000123456'], 'a scanner adds a newline');
    assert.deepStrictEqual(S.parse('\u0000\u001b[AITM1\u007f').codes, ['[AITM1'], 'control characters never get through');
    assert.deepStrictEqual(S.parse('*CODE39*').codes, ['*CODE39*', 'CODE39'], 'Code 39 readers wrap the code in stars');
    assert.deepStrictEqual(S.parse('*').codes, ['*']);
    for (const nothing of ['', '   ', null, undefined, '\n']) assert.deepStrictEqual(S.parse(nothing).codes, []);
});

test('scan: the address on a PRA receipt\'s QR is an invoice number, not an item code', () => {
    const p = S.parse(praReal.verifyUrl('PRA-123/45'));
    assert.strictEqual(p.invoice, 'PRA-123/45', 'the number comes back as it was written');
    assert.deepStrictEqual(p.codes, []);
    assert.strictEqual(S.parse('https://x.example/?a=1&praInvNo=abc123&b=2#top').invoice, 'abc123', 'any capitals, anywhere in the query');
    assert.strictEqual(S.parse('https://x.example/?PRAInvNo=%E0%A4%A').invoice, '%E0%A4%A', 'a broken escape is kept as it came');
    assert.strictEqual(S.parse('https://shop.example/item/ITM1').invoice, null, 'some other address is just text');
});

test('scan: a short number is also a sale number written out in full', () => {
    assert.strictEqual(S.parse('123').usin, '000123');
    assert.strictEqual(S.parse('000123').usin, '000123');
    assert.strictEqual(S.parse('1234567').usin, null, 'seven digits is not one of our numbers (it can still be a barcode)');
    assert.strictEqual(S.parse('12A').usin, null);
});

test('scan: far too much text is not looked up', () => {
    const p = S.parse('x'.repeat(S.MAX + 1));
    assert.deepStrictEqual([p.tooLong, p.codes, p.invoice], [true, [], null]);
    assert.strictEqual(S.parse('x'.repeat(S.MAX)).tooLong, false);
});

test('scan: an item is the barcode first, then the code, capitals ignored', () => {
    const items = [{ id: 1, code: 'ITM0001', barcode: '8964000123456' }, { id: 2, code: 'itm0002', barcode: null }, { id: 3, code: 'TEA', barcode: 'ITM0002X' }];
    assert.strictEqual(S.findItem(items, '8964000123456').id, 1);
    assert.strictEqual(S.findItem(items, 'ITM0001').id, 1);
    assert.strictEqual(S.findItem(items, 'ITM0002').id, 2, 'by code, in any case');
    assert.strictEqual(S.findItem(items, 'itm0002x').id, 3, 'by barcode, in any case');
    assert.strictEqual(S.findItem(items, '*TEA*').id, 3, 'with the stars of a Code 39 reader');
    assert.strictEqual(S.findItem(items, 'nothing'), null);
    assert.strictEqual(S.findItem(items, ''), null);
    assert.strictEqual(S.findItem(items, praReal.verifyUrl('ITM0001')), null, 'a receipt address is not an item');
    assert.strictEqual(S.findItem(null, 'ITM0001'), null);
    assert.strictEqual(S.findItem(items, S.parse('ITM0001')).id, 1, 'an already read scan can be passed too');
    // the barcode beats a code that happens to be the same text
    const clash = [{ id: 10, code: 'X1', barcode: '555' }, { id: 11, code: '555', barcode: null }];
    assert.strictEqual(S.findItem(clash, '555').id, 10);
    // two items that both answer: no guess
    assert.strictEqual(S.findItem([{ id: 1, code: 'A', barcode: null }, { id: 2, code: 'a', barcode: null }], 'A'), null);
});

test('scan: a scanner types in a burst and presses Enter; a person types slowly', () => {
    const feed = (w, text, gap, start = 1000) => { let t = start; for (const ch of text) { w.key(ch, t); t += gap; } return t; };
    // a burst, then Enter
    let w = S.wedge();
    let t = feed(w, 'ITM0001', 8);
    assert.strictEqual(w.key('Enter', t), 'ITM0001');
    assert.strictEqual(w.key('Enter', t + 10), null, 'the buffer is empty once a scan is taken');
    // slow typing ends up as at most the last character: no scan
    w = S.wedge(); t = feed(w, 'ITM0001', 250); assert.strictEqual(w.key('Enter', t), null);
    // a pause in the middle starts again: only what came after the pause is kept
    w = S.wedge(); t = feed(w, 'AB', 5); t += 500; t = feed(w, 'CDEF', 5, t); assert.strictEqual(w.key('Enter', t), 'CDEF');
    // a stray key and Enter is a person; two or three keys at scanner speed are a short code (its Enter must not press a button)
    w = S.wedge(); w.key('a', 1000); assert.strictEqual(w.key('Enter', 1005), null);
    w = S.wedge(); w.key('a', 1000); w.key('b', 1005); assert.strictEqual(w.key('Enter', 1010), 'ab');
    w = S.wedge(); t = feed(w, 'TEA', 8); assert.strictEqual(w.key('Enter', t), 'TEA');
    w = S.wedge({ minLength: 4 }); t = feed(w, 'TEA', 8); assert.strictEqual(w.key('Enter', t), null, 'a screen can ask for more');
    // Enter long after the last key is not the end of a scan (and it still empties the buffer)
    w = S.wedge(); t = feed(w, 'ITM0001', 8); assert.strictEqual(w.key('Enter', t + 5000), null); assert.strictEqual(w.key('Enter', t + 5010), null);
    w = S.wedge(); t = feed(w, 'ITM0001', 8); assert.strictEqual(w.key('Enter', t + 200), 'ITM0001', 'a scanner that waits a moment before Enter');
    w = S.wedge({ enterGap: 20 }); t = feed(w, 'ITM0001', 8); assert.strictEqual(w.key('Enter', t + 200), null);
    // keys that are not characters are ignored, and do not break a burst
    w = S.wedge(); w.key('I', 1000); w.key('Shift', 1002); w.key('T', 1004); w.key('M', 1006); w.key('1', 1008); w.key('ArrowLeft', 1009);
    assert.strictEqual(w.key('Enter', 1010), 'ITM1');
    // a slower scanner can be allowed for
    w = S.wedge({ maxGap: 150 }); t = feed(w, 'ITM0002', 100); assert.strictEqual(w.key('Enter', t), 'ITM0002');
    w = S.wedge(); t = feed(w, 'ITM0002', 100); assert.strictEqual(w.key('Enter', t), null, 'but the usual limit is tight');
    // reset, pending, and a runaway burst
    w = S.wedge(); feed(w, 'ABCDE', 3); assert.strictEqual(w.pending(), 'ABCDE'); w.reset(); assert.strictEqual(w.pending(), ''); assert.strictEqual(w.key('Enter', 2000), null);
    w = S.wedge(); feed(w, 'x'.repeat(S.MAX + 50), 1); assert.ok(w.pending().length <= S.MAX, 'it never grows without end');
    // a code that contains a space is one scan
    w = S.wedge(); t = feed(w, 'ICE CREAM 2', 6); assert.strictEqual(w.key('Enter', t), 'ICE CREAM 2');
});
