// Rebuild data/hs-codes-pct-2017.json from the PCT First Schedule PDF.
// 1) PDF -> text, one page after another, e.g.:  pdftotext -layout "hs codes list.pdf" pct.txt
//    (this file was built from pypdf text with "<<<PAGE n>>>" separators; either works)
// 2) node scripts/pct-pdf-to-json.js pct.txt data/hs-codes-pct-2017.json
// 3) npm run seed   (refreshes PCT rows, never overwrites codes synced from FBR)
const fs = require('fs');
const lines = fs.readFileSync(process.argv[2], 'utf8').split('\n');

const HEADER = /^(<<<PAGE|PCT( CODE)?\b|CODE\s*$|Heading|Sub-\s*$|heading\s*$|Statistical|suffix|\(1\)|Description CD|DESCRIPTION)/i;
const clean = s => s.replace(/\s+/g, ' ').replace(/\s+([,.;:)])/g, '$1').replace(/\(\s+/g, '(').replace(/(\w)- (\w)/g, '$1-$2').trim();
const stripRate = s => s.replace(/\s+(\d+(\.\d+)?%?|Exempt|Free)\s*$/i, '').trim();
const dashes = s => { const m = s.match(/^((?:-\s*)+)/); return m ? { depth: (m[1].match(/-/g) || []).length, text: s.slice(m[1].length) } : { depth: 0, text: s }; };

let heading = '', levels = [], last = null; // last = {kind, ref}
let curHeading = ''; // e.g. "4009"
let inNotes = false; // inside section/chapter notes (between chapters)
const out = new Map();

for (let raw of lines) {
  const line = raw.trim();
  // The tariff table header ("(1) (2) (3)") marks the end of a notes block; chapter 98 uses "Heading Description"
  if (/^\(1\)\s*\(2\)|^Heading Description|^PCT( CODE)?\b/.test(line)) { inNotes = false; last = null; continue; }
  if (/^(SECTION|Section)\s+[IVXL]+\.?$|^(CHAPTER|Chapter)\s+\d+\.?$|^(Section |Sub-?heading |Additional )?Notes?\.?$/.test(line)) { inNotes = true; last = null; continue; }
  if (inNotes) continue;
  if (!line || HEADER.test(line) || /^\d{1,3}$/.test(line) || /^\d+(\.\d+)?%?$/.test(line)) continue;

  let m;
  // Heading "01.02 Live bovine animals." — text must start with a word, and headings only move forward
  if ((m = line.match(/^(\d{2})\.(\d{2})\s+(["'(]?[A-Z][a-z].*)$/)) && (!curHeading || m[1] + m[2] > curHeading)) {
    heading = clean(stripRate(m[3])).replace(/[.:]$/, '');
    curHeading = m[1] + m[2];
    levels = []; last = { kind: 'heading' };
    continue;
  }
  // Code line. Codes quoted inside a description (e.g. "8701.2020, 8701.2090" in chapter 40) are not rows:
  // a real row stays in the current heading's chapter and never goes back before the current heading.
  if ((m = line.match(/^(\d{4})\.(\d{4})\s+(-.*|["'(]?[A-Z][A-Za-z].*)$/)) && (!curHeading || m[1] >= curHeading)) {
    if (m[1] > curHeading) { curHeading = m[1]; if (!/^-/.test(m[3])) { heading = ''; levels = []; } } // 4-digit code with no heading line
    const code = `${m[1]}.${m[2]}`;
    const { depth, text } = dashes(stripRate(m[3]));
    const own = clean(text).replace(/[.:]$/, '');
    const parents = levels.slice(1, depth).filter(Boolean);
    const rec = { code, heading, parents, own };
    if (!out.has(code)) out.set(code, rec);
    last = { kind: 'code', ref: out.get(code) === rec ? rec : null };
    continue;
  }
  if (line.startsWith('-')) {                                      // sub-level without code
    const { depth, text } = dashes(line);
    levels[depth] = clean(stripRate(text)).replace(/[.:]$/, '');
    levels.length = depth + 1;
    last = { kind: 'level', depth };
    continue;
  }
  // Section / chapter titles and notes sit between chapters: stop attaching text until the next heading/code
  if (/^(SECTION|Section)\s+[IVXL]+\.?$|^(CHAPTER|Chapter)\s+\d+\.?$|^(Section |Sub-?heading |Additional )?Notes?\.?$/.test(line)) { last = null; continue; }
  // continuation of the previous line (descriptions wrap over at most a few lines)
  if (!last || (last.joins = (last.joins || 0) + 1) > 4) { last = null; continue; }
  const extra = clean(stripRate(line));
  if (!extra) continue;
  if (last?.kind === 'heading') heading = clean(heading + ' ' + extra).replace(/[.:]$/, '');
  else if (last?.kind === 'level') levels[last.depth] = clean(levels[last.depth] + ' ' + extra).replace(/[.:]$/, '');
  else if (last?.kind === 'code' && last.ref) last.ref.own = clean(last.ref.own + ' ' + extra).replace(/[.:]$/, '');
}

const result = [...out.values()]
  .filter(r => Number(r.code.slice(0, 2)) <= 98)                  // chapter 99 = concessions, not goods/services codes
  .map(r => {
    const parts = [r.heading, ...r.parents, r.own].filter(Boolean);
    // drop a generic leaf like "Other" only when combined with parents, keep the chain readable
    return { code: r.code, description: parts.join(' › ') };
  })
  .sort((a, b) => a.code.localeCompare(b.code));

fs.writeFileSync(process.argv[3], JSON.stringify(result));
console.log('codes:', result.length);
