// HS code → suggested sale type / rate (Sales Tax Act schedules). Rules live in the HsTaxRule table, edited by the admin.
// Every rule whose prefix matches the code's digits is returned, most specific first: one code can fall under several
// entries (e.g. 0401 milk: 3rd Schedule if branded retail packing, 6th Schedule exempt if not), and a broad heading rule
// must not be hidden by a narrower conditional one (3402 detergents vs 3402.9000 pesticide ingredients).

// Section 3(1): anything not in a schedule is taxed at the standard rate
const STANDARD = { saleType: 'Goods at standard rate (default)', rate: '18%', sroScheduleNo: '', sroItemSerialNo: '', note: 'Standard rate — Section 3(1)' };

const digitsOf = code => String(code || '').replace(/\D/g, '');

function matchRules(rules, hsCode) {
    const d = digitsOf(hsCode);
    return rules.filter(r => d.startsWith(r.prefix)).sort((a, b) => b.prefix.length - a.prefix.length);
}

// The rule to fill in without asking: the most specific match, if it has no condition and nothing else is equally specific
function autoRule(matches) {
    const top = matches[0];
    if (!top || top.condition) return null;
    return matches.filter(r => r.prefix.length === top.prefix.length).length === 1 ? top : null;
}

// Rules change rarely and are read on every HS pick: keep them in memory, reload after an admin edit
let cache = null;
async function loadRules(prisma) {
    if (!cache) cache = await prisma.hsTaxRule.findMany({ orderBy: { prefix: 'asc' } });
    return cache;
}
function clearCache() { cache = null; }

module.exports = { STANDARD, digitsOf, matchRules, autoRule, loadRules, clearCache };
