const test = require('node:test');
const assert = require('node:assert');
const { mobileProblem } = require('../src/phone');

test('mobile numbers are checked per country: length and how mobiles start', () => {
    for (const ok of ['', '03001234567', '+923001234567', '+971501234567', '+966512345678', '+97433123456', '+447400123456', '+12015550123', '+8613123456789', '+18765551234'])
        assert.strictEqual(mobileProblem(ok), '', ok);
    assert.match(mobileProblem('0300123456'), /Pakistan mobile numbers have 11 digits starting with 03/);   // 10 digits
    assert.match(mobileProblem('04235761234'), /starting with 03/);                                         // Lahore landline
    assert.match(mobileProblem('+97150123456'), /UAE mobile numbers have 9 digits after \+971, starting with 5/);
    assert.match(mobileProblem('+971401234567'), /starting with 5/);                                          // Dubai landline
    assert.match(mobileProblem('+44740012345'), /United Kingdom mobile numbers have 10 digits/);
    assert.match(mobileProblem('+123'), /8 to 15 digits|USA/);
});
