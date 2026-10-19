const test = require('node:test');
const assert = require('node:assert');
const { MODULES, cleanModules, tenantModules, DEFAULT_MODULES } = require('../src/modules');

test('modules: only known ids, no repeats, always in the registry order', () => {
    assert.deepStrictEqual(cleanModules(['POS', 'INVOICING', 'POS', 'BOGUS']), ['INVOICING', 'POS']);
    assert.deepStrictEqual(cleanModules(['BOGUS']), []);
    assert.deepStrictEqual(cleanModules(undefined), []);
    assert.deepStrictEqual(cleanModules('POS'), []); // a single string is not a list
});

test('modules: a client with none stored (older rows) has Digital Invoicing', () => {
    assert.deepStrictEqual(tenantModules({ modules: [] }), DEFAULT_MODULES);
    assert.deepStrictEqual(tenantModules({}), DEFAULT_MODULES);
    assert.deepStrictEqual(tenantModules(null), DEFAULT_MODULES);
    assert.deepStrictEqual(tenantModules({ modules: ['POS'] }), ['POS']);
    assert.deepStrictEqual(tenantModules({ modules: ['POS', 'INVOICING'] }), ['INVOICING', 'POS']);
});

test('modules: every product has a name and a one-line description for the chooser', () => {
    for (const m of MODULES) assert.ok(m.id && m.label && m.blurb, m.id);
});
