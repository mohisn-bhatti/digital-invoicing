'use strict';
/* Sending receipt bytes straight to a thermal printer from the browser, with no print dialog: over Bluetooth (Web Bluetooth: Chrome on
   Android and on computers) or over USB (WebUSB: Chrome on Android with an OTG cable, and on computers). iPhones and iPads cannot do either:
   the ordinary Print button is what they use. Both need a secure page (https) and a tap by the person: the browser asks which printer.
   The connection is kept in memory for as long as the page stays open; after a reload the printer is chosen again.
   Written to the common specification and tried with stand-in devices only: it has not been tried on a real printer yet. */

// What a Bluetooth printer's writable channel is called differs by maker; these are the usual ones, and any writable channel found is used
const POS_BT_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb', '0000ffe0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '0000fff0-0000-1000-8000-00805f9b34fb',
];
const PosPrinter = {
  conn: null, // { kind: 'bluetooth' | 'usb', name, send(bytes) }
  supports: () => ({ bluetooth: typeof navigator !== 'undefined' && Boolean(navigator.bluetooth), usb: typeof navigator !== 'undefined' && Boolean(navigator.usb) }),
  available() { const s = this.supports(); return s.bluetooth || s.usb; },
  name() { return this.conn ? `${this.conn.name} (${this.conn.kind === 'usb' ? 'USB' : 'Bluetooth'})` : ''; },
  forget() { try { if (this.conn && this.conn.close) this.conn.close(); } catch { /* it was closing anyway */ } this.conn = null; },

  async connectBluetooth() {
    if (!navigator.bluetooth) throw new Error('This browser cannot talk to a Bluetooth printer. Use Chrome on Android or on a computer.');
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: POS_BT_SERVICES });
    const open = async () => {
      const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
      for (const service of await server.getPrimaryServices()) {
        for (const c of await service.getCharacteristics()) if (c.properties.write || c.properties.writeWithoutResponse) return c;
      }
      throw new Error('This device has no channel a printer takes data on. Is it a receipt printer?');
    };
    let channel = await open();
    this.conn = {
      kind: 'bluetooth', name: device.name || 'Bluetooth printer',
      async send(bytes) {
        if (!device.gatt.connected) channel = await open(); // it went to sleep: wake it
        // small pieces with a short rest between them: a printer's buffer is small and drops what comes too fast
        for (let i = 0; i < bytes.length; i += 100) {
          const piece = bytes.slice(i, i + 100);
          if (channel.properties.writeWithoutResponse) await channel.writeValueWithoutResponse(piece); else await channel.writeValue(piece);
          await new Promise(r => setTimeout(r, 25));
        }
      },
      close() { if (device.gatt.connected) device.gatt.disconnect(); },
    };
    return this.name();
  },

  async connectUsb() {
    if (!navigator.usb) throw new Error('This browser cannot talk to a USB printer. Use Chrome on Android (with an OTG cable) or on a computer.');
    const device = await navigator.usb.requestDevice({ filters: [] }); // every USB device is offered: not every printer announces itself as one, and the person knows which is theirs
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    let out = null;
    for (const iface of device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        const ep = alt.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
        if (ep) { out = { interfaceNumber: iface.interfaceNumber, endpointNumber: ep.endpointNumber }; break; }
      }
      if (out) break;
    }
    if (!out) { await device.close(); throw new Error('This USB device has no place to send print data. Is it a receipt printer?'); }
    await device.claimInterface(out.interfaceNumber);
    this.conn = {
      kind: 'usb', name: device.productName || 'USB printer',
      async send(bytes) { for (let i = 0; i < bytes.length; i += 4096) await device.transferOut(out.endpointNumber, bytes.slice(i, i + 4096)); },
      close() { device.close().catch(() => {}); },
    };
    return this.name();
  },

  async send(bytes) {
    if (!this.conn) throw new Error('Connect a printer first (Settings, or the printer button on the receipt).');
    try { await this.conn.send(bytes); } catch (e) { this.forget(); throw new Error(`The printer did not take the receipt (${e.message || e}). Connect it again.`); }
  },
};
