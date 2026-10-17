const test = require('node:test');
const assert = require('node:assert');
const { assignedScenarios } = require('../src/activityScenarios');

test('several sectors (as IRIS allows): scenarios are the union over all ticked sectors', () => {
    const one = assignedScenarios(['Service Provider'], ['All Other Sectors']);
    const many = assignedScenarios(['Service Provider'], ['All Other Sectors', 'Services', 'Textile', 'Steel']);
    assert.ok(many.length > one.length);
    for (const sn of one) assert.ok(many.includes(sn));
    assert.deepStrictEqual(assignedScenarios(['Service Provider'], []), []);
});
