// Sending bytes to a printer from the browser, with stand-ins for Web Bluetooth and WebUSB (no real printer is involved).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load(navigator) {
    const ctx = vm.createContext({ navigator, setTimeout: (fn) => { fn(); return 0; }, console, Uint8Array, Promise, Error });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'pos-printer.js'), 'utf8') + '\nthis.PosPrinter = PosPrinter;', ctx);
    return ctx.PosPrinter;
}
const bytes = n => Uint8Array.from({ length: n }, (_, i) => i % 256);

test('printer connection: nothing to connect to in a browser without Bluetooth or USB, and a clear message', async () => {
    const P = load({});
    assert.strictEqual(P.available(), false);
    await assert.rejects(P.connectBluetooth(), /Bluetooth printer/);
    await assert.rejects(P.connectUsb(), /USB printer/);
    await assert.rejects(P.send(bytes(3)), /Connect a printer first/);
});

test('printer connection: Bluetooth finds a writable channel and sends in small pieces, in order', async () => {
    const written = [];
    const channel = { properties: { write: false, writeWithoutResponse: true }, writeValueWithoutResponse: async v => written.push(Array.from(v)) };
    const dead = { properties: { write: false, writeWithoutResponse: false } };
    const device = { name: 'RPP02N', gatt: { connected: false, async connect() { this.connected = true; return { getPrimaryServices: async () => [{ getCharacteristics: async () => [dead, channel] }] }; }, disconnect() { this.connected = false; } } };
    const P = load({ bluetooth: { requestDevice: async opts => { assert.ok(opts.optionalServices.length > 3, 'the usual printer services are asked for'); return device; } } });
    assert.strictEqual(P.available(), true);
    assert.strictEqual(await P.connectBluetooth(), 'RPP02N (Bluetooth)');
    await P.send(bytes(250));
    assert.deepStrictEqual(written.map(p => p.length), [100, 100, 50], 'pieces of at most 100 bytes');
    assert.deepStrictEqual(written.flat(), Array.from(bytes(250)), 'in order, nothing lost');
    // the printer went to sleep: it is woken, not given up on
    device.gatt.connected = false;
    await P.send(bytes(10));
    assert.strictEqual(device.gatt.connected, true);
    P.forget();
    assert.strictEqual(P.conn, null);
    assert.strictEqual(device.gatt.connected, false, 'forgetting disconnects');
});

test('printer connection: a Bluetooth device with no writable channel is not taken for a printer', async () => {
    const device = { name: 'Headphones', gatt: { connected: true, getPrimaryServices: async () => [{ getCharacteristics: async () => [{ properties: { read: true } }] }] } };
    const P = load({ bluetooth: { requestDevice: async () => device } });
    await assert.rejects(P.connectBluetooth(), /no channel a printer takes data on/);
    assert.strictEqual(P.conn, null);
});

test('printer connection: USB finds the bulk-out endpoint of the printer and sends in blocks', async () => {
    const sent = []; let claimed = null;
    const device = {
        productName: 'POS-58', configuration: { interfaces: [{ interfaceNumber: 0, alternates: [{ endpoints: [{ direction: 'in', type: 'bulk', endpointNumber: 1 }] }] }, { interfaceNumber: 1, alternates: [{ endpoints: [{ direction: 'out', type: 'bulk', endpointNumber: 3 }] }] }] },
        async open() {}, async selectConfiguration() {}, async claimInterface(n) { claimed = n; }, async transferOut(ep, data) { sent.push([ep, data.length]); }, async close() {},
    };
    const P = load({ usb: { requestDevice: async () => device } });
    assert.strictEqual(await P.connectUsb(), 'POS-58 (USB)');
    assert.strictEqual(claimed, 1, 'the interface that has the out endpoint');
    await P.send(bytes(9000));
    assert.deepStrictEqual(sent, [[3, 4096], [3, 4096], [3, 808]]);
});

test('printer connection: a failed send forgets the printer and says to connect it again', async () => {
    const channel = { properties: { write: true }, writeValue: async () => { throw new Error('GATT operation failed'); } };
    const device = { name: 'X', gatt: { connected: true, getPrimaryServices: async () => [{ getCharacteristics: async () => [channel] }], disconnect() {} } };
    const P = load({ bluetooth: { requestDevice: async () => device } });
    await P.connectBluetooth();
    await assert.rejects(P.send(bytes(5)), /did not take the receipt \(GATT operation failed\)\. Connect it again/);
    assert.strictEqual(P.conn, null);
});
