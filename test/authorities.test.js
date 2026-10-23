// The authority badges: names and logos shown as the authority publishes them, a plain badge when there is no logo file, and nothing a name could
// use to break out of the page.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MODULES } = require('../src/modules');

function load(extra = {}) {
    const made = [];
    const document = { createElement: () => { const e = { innerHTML: '', firstElementChild: { tag: 'tile' } }; made.push(e); return e; }, ...extra };
    const ctx = vm.createContext({ document, console });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'authorities.js'), 'utf8') + '\nthis.Authorities = Authorities;', ctx);
    return { A: ctx.Authorities, made };
}

test('authorities: the products say which authority they connect to, and every such authority is in the list with its full name', () => {
    const { A } = load();
    for (const m of MODULES) { assert.ok(m.authority, m.id); assert.ok(A.byId(m.authority), `${m.authority} is known`); assert.strictEqual(A.byId(m.authority).inUse, true, `${m.authority} is marked as in use`); }
    assert.strictEqual(A.byId('pra').name, 'Punjab Revenue Authority', 'ids are not case sensitive');
    assert.strictEqual(A.byId('FBR').name, 'Federal Board of Revenue');
    assert.strictEqual(A.byId('nobody'), null);
    assert.strictEqual(A.byId(undefined), null);
    assert.ok(new Set(A.LIST.map(a => a.id)).size === A.LIST.length, 'no id twice');
    // only the two the app connects to today are marked as in use: the others are not shown anywhere
    assert.deepStrictEqual([...A.LIST.filter(a => a.inUse).map(a => a.id)], ['FBR', 'PRA']);
});

test('authorities: a badge is the logo file with the name beside it, and an unknown authority is nothing at all', () => {
    const { A } = load();
    const html = A.badge('PRA');
    assert.ok(html.includes('src="/authorities/pra.png"'));
    assert.ok(html.includes('Punjab Revenue Authority'));
    assert.ok(html.includes('onerror="Authorities.noLogo(this)"'), 'a logo that will not load is swapped for the plain badge');
    assert.ok(html.includes('alt=""'), 'the name is next to the picture, so the picture is decoration for a screen reader');
    assert.strictEqual(A.badge('XYZ'), '');
    assert.ok(A.badge('PRA', { name: false }).includes('sr-only'), 'without the name on screen it is still there for a screen reader');
    assert.ok(!A.badge('PRA', { name: false }).includes('block font-medium'));
    assert.ok(A.badge('FBR', { size: 'lg' }).includes('h-14') && A.badge('FBR', { size: 'sm' }).includes('h-7'));
    assert.ok(A.badge('FBR', { size: 'nonsense' }).includes('h-10'), 'a size it does not know is the usual one');
    assert.strictEqual(A.logoUrl('KPRA'), '/authorities/kpra.png');
});

test('authorities: no logo file means the short name on a plain badge, remembered so the file is not asked for again', () => {
    const { A, made } = load();
    const replaced = [];
    const img = { dataset: { authority: 'PRA', size: 'md' }, replaceWith: x => replaced.push(x) };
    A.noLogo(img);
    assert.strictEqual(replaced.length, 1, 'the picture is replaced');
    assert.ok(made[0].innerHTML.includes('>PRA<') && made[0].innerHTML.includes('bg-slate-800'), 'by the plain badge');
    assert.ok(A.missing.has('PRA'));
    const again = A.badge('PRA');
    assert.ok(!again.includes('<img'), 'the next badge goes straight to the plain one');
    assert.ok(again.includes('>PRA<'));
    assert.ok(A.badge('FBR').includes('<img'), 'another authority is not affected');
    A.noLogo({ dataset: { authority: 'NOPE' }, replaceWith: () => assert.fail('an unknown authority is left alone') });
    A.noLogo(null);
});

test('authorities: a page asks for badges by marking a place for them', () => {
    const els = [{ dataset: { authorityBadge: 'FBR' }, innerHTML: '' }, { dataset: { authorityBadge: 'PRA', size: 'sm', name: 'false' }, innerHTML: '' }, { dataset: { authorityBadge: 'XYZ' }, innerHTML: 'old' }];
    const { A } = load();
    A.fill({ querySelectorAll: () => els });
    assert.ok(els[0].innerHTML.includes('Federal Board of Revenue'));
    assert.ok(els[1].innerHTML.includes('sr-only') && els[1].innerHTML.includes('h-7'));
    assert.strictEqual(els[2].innerHTML, '', 'an unknown one is emptied, not left half-made');
});

test('authorities: the pages that show them load the script, mark where, and say the logos belong to their owners', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.html'), 'utf8'), site = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.ok(app.includes('<script src="/authorities.js"></script>') && site.includes('<script src="/authorities.js"></script>'));
    assert.ok(/Authorities\.badge\(m\.authority/.test(app), 'the chooser shows each product\'s authority');
    assert.ok(site.includes("if (typeof Authorities !== 'undefined') Authorities.fill()"), 'the site\'s own script does not depend on the logos file loading');
    assert.ok(site.includes('data-authority-badge="FBR"') && site.includes('data-authority-badge="PRA"'));
    assert.ok(/not affiliated with or endorsed by/.test(app) && /not affiliated with or endorsed by/.test(site), 'both say they are independent');
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'authorities', 'README.txt')));
});
