// The page's scripts share one global scope: a function or constant defined twice (in two files, or twice in one file) silently replaces
// the first one. That happened once (24 Nov 2026: an old copy of the Settings save, further down the same file, won and dropped most of
// the settings). Every top-level name of the scripts app.html loads must be defined once.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('every top-level function and constant of the page\'s scripts is defined once', () => {
    const root = path.join(__dirname, '..', 'public');
    const html = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
    const files = [...html.matchAll(/<script src="\/([^"]+\.js)"/g)].map(m => m[1]).filter(f => fs.existsSync(path.join(root, f)));
    assert.ok(files.length > 10, 'the scripts were found');
    const seen = new Map(), twice = [];
    for (const f of files) {
        fs.readFileSync(path.join(root, f), 'utf8').split('\n').forEach((line, i) => {
            const m = line.match(/^(?:const|let|class|async function|function)\s+([A-Za-z_$][\w$]*)/);
            if (!m) return;
            if (seen.has(m[1])) twice.push(`${m[1]}: ${seen.get(m[1])} and ${f}:${i + 1}`);
            else seen.set(m[1], `${f}:${i + 1}`);
        });
    }
    assert.deepStrictEqual(twice, []);
});
