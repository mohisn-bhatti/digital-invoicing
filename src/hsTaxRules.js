// HS code → suggested sale type / rate (CA's Document 1). Rules live in the HsTaxRule table, edited by the admin.
// The longest prefix that matches the code's digits wins, so "23091000" (pet food, 18%) beats "2309" (feed, 10%).

// Section 3(1): anything not in a schedule is taxed at the standard rate
const STANDARD = { saleType: 'Goods at standard rate (default)', rate: '18%', sroScheduleNo: '', sroItemSerialNo: '', note: 'Standard rate — Section 3(1)' };

const digitsOf = code => String(code || '').replace(/\D/g, '');

function matchRule(rules, hsCode) {
    const d = digitsOf(hsCode);
    let best = null;
    for (const r of rules) if (d.startsWith(r.prefix) && (!best || r.prefix.length > best.prefix.length)) best = r;
    return best;
}

// Rules change rarely and are read on every HS pick: keep them in memory, reload after an admin edit
let cache = null;
async function loadRules(prisma) {
    if (!cache) cache = await prisma.hsTaxRule.findMany({ orderBy: { prefix: 'asc' } });
    return cache;
}
function clearCache() { cache = null; }

module.exports = { STANDARD, digitsOf, matchRule, loadRules, clearCache };
