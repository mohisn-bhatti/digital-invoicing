// The server must start: catches mistakes a syntax check can't (e.g. using a constant before it is defined)
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('server.js starts and listens', { timeout: 30000 }, async () => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: '0', FBR_MOCK: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const started = await new Promise(resolve => {
        const done = ok => { clearTimeout(timer); resolve(ok); };
        const timer = setTimeout(() => done(false), 25000);
        child.stdout.on('data', d => { out += d; if (/FBR billing app on/.test(out)) done(true); });
        child.stderr.on('data', d => { out += d; });
        child.on('exit', () => done(false));
    });
    child.kill();
    assert.ok(started, `server did not start:\n${out.slice(-1500)}`);
});
