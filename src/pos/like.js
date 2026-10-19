// Prisma's case-insensitive comparisons (mode: 'insensitive') are ILIKE underneath, and the value is not escaped: "_" matches any one
// character and "%" any run of them, so "MILK_1L" would be taken for "MILK-1L" and a search for "%" for everything. These put a backslash
// (ILIKE's escape) before the characters that mean something, so a value is matched as it was typed. A test pins this down: if Prisma ever
// escapes the value itself, the tests fail rather than the matching going quietly wrong.
const escapeLike = s => String(s === undefined || s === null ? '' : s).replace(/[\\%_]/g, '\\$&');

const ciEquals = v => ({ equals: escapeLike(v), mode: 'insensitive' });
const ciContains = v => ({ contains: escapeLike(v), mode: 'insensitive' });
// (the same for a case-sensitive "contains", which is LIKE)
const contains = v => ({ contains: escapeLike(v) });

module.exports = { escapeLike, ciEquals, ciContains, contains };
