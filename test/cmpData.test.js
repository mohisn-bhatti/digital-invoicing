// The country table (public/cmp-countries.js) and the permissions (public/cmp-perms.js) of the Compliance & Deadlines module
const test = require('node:test');
const assert = require('node:assert');
const C = require('../public/cmp-countries');
const P = require('../public/cmp-perms');

test('countries: every one has a name, a dialling code, a currency and time zones this Node knows', () => {
    assert.ok(C.list.length > 200);
    const seen = new Set();
    for (const c of C.list) {
        assert.ok(!seen.has(c.code), 'twice: ' + c.code); seen.add(c.code);
        assert.match(c.code, /^[A-Z]{2}$/);
        assert.ok(c.name && c.name !== c.code, c.code);
        assert.match(c.dial, /^\d{1,4}$/, c.code);
        assert.match(c.currency, /^[A-Z]{3}$/, c.code);
        assert.ok(C.currencyOk(c.currency), c.code + ' ' + c.currency);
        assert.ok(c.zones.length >= 1, c.code);
        for (const z of c.zones) assert.ok(C.zoneOk(z), c.code + ' ' + z);
        assert.strictEqual([...c.flag].length, 2, c.code);
    }
    assert.strictEqual(C.list[0].code, 'AE'); // the usual ones first
});

test('countries: the UAE example of the SRS, and currency decimals', () => {
    const ae = C.get('ae');
    assert.deepStrictEqual([ae.name, ae.dial, ae.currency, ae.zones[0], ae.flag], ['United Arab Emirates', '971', 'AED', 'Asia/Dubai', '🇦🇪']);
    assert.strictEqual(C.get('PK').zones[0], 'Asia/Karachi');
    assert.ok(C.get('US').zones.length > 5 && C.get('US').zones[0] === 'America/New_York');
    assert.strictEqual(C.get('ZZ'), null);
    assert.strictEqual(C.currencyDecimals('KWD'), 3);
    assert.strictEqual(C.currencyDecimals('JPY'), 0);
    assert.strictEqual(C.currencyDecimals('AED'), 2);
    assert.strictEqual(C.zoneCity('America/Los_Angeles'), 'Los Angeles');
    assert.strictEqual(C.zoneOk('Mars/Olympus'), false);
    assert.strictEqual(new Set(C.currencies.map(c => c.code)).size, C.currencies.length);
    for (const code of ['AED', 'USD', 'EUR', 'GBP', 'SAR', 'PKR', 'INR', 'JPY', 'CNY', 'CHF']) assert.ok(C.currencyOk(code), code);
});

test('permissions: stored lists are tidied; full access means everything; any permission includes viewing', () => {
    assert.deepStrictEqual(P.clean(['WHATSAPP', 'VIEW', 'bogus', 'VIEW']), ['VIEW', 'WHATSAPP']);
    assert.deepStrictEqual(P.clean(['VIEW', 'FULL']), ['FULL']);
    assert.deepStrictEqual(P.clean(null), []);
    assert.deepStrictEqual([...P.effective(['FULL'])].sort(), [...P.IDS].sort());
    assert.deepStrictEqual([...P.effective(['WHATSAPP'])].sort(), ['VIEW', 'WHATSAPP']);
    assert.strictEqual(P.effective([]).size, 0);
    assert.ok(P.has(['FULL'], 'SECRETS'));
    assert.ok(!P.has(['VIEW', 'WHATSAPP'], 'SECRETS', 'SETUP'));
    assert.ok(P.has(['SETUP'], 'VIEW'));
    for (const p of P.PRESETS) assert.deepStrictEqual(P.clean(p.perms), p.perms, p.id);
    assert.strictEqual(P.summary(['FULL']), 'Full access');
    assert.strictEqual(P.summary([]), 'No access');
    assert.strictEqual(P.summary(['VIEW']), 'Viewer');
    assert.strictEqual(P.summary(['VIEW', 'SETUP']), '2 permissions');
});
