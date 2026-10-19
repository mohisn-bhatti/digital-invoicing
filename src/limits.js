// What a client's plan allows: branches, terminals (Point of Sale counters), products and users. The numbers are the ones on the
// website (public/plans.js). A client with no plan has no limits (every client from before plans existed).
//
// A limit is checked when something is ADDED, or switched back on. A client that ends up over its limit (its plan was lowered) keeps
// what it has, but cannot add more until it is back under. Only what is in use counts: a switched-off branch, counter or item, or a
// disabled user, gives its place back.
const Plans = require('../public/plans.js');

// kind → what it counts (the number it is held to is Plans.limitOf: [branches, terminals, products, users])
const KINDS = {
    users: { noun: 'users', one: 'user', label: 'Users', count: (db, tenantId) => db.user.count({ where: { tenantId, role: 'CLIENT_USER', OR: [{ active: true }, { pendingApproval: true }] } }) },
    branches: { noun: 'branches', one: 'branch', label: 'Branches', count: (db, tenantId) => db.posBranch.count({ where: { tenantId, active: true } }) },
    terminals: { noun: 'terminals (counters)', one: 'terminal (counter)', label: 'Terminals (counters)', count: (db, tenantId) => db.posCounter.count({ where: { tenantId, active: true } }) },
    products: { noun: 'products', one: 'product', label: 'Products', count: (db, tenantId) => db.product.count({ where: { tenantId } }) },
    items: { noun: 'items', one: 'item', label: 'Items', count: (db, tenantId) => db.posItem.count({ where: { tenantId, active: true } }) },
};
// which of them belong to which product (the screens only show what applies)
const OF_PRODUCT = { INVOICING: ['products'], POS: ['branches', 'terminals', 'items'] };

const number = n => Number(n).toLocaleString('en-US');

function createLimits({ prisma, HttpError }) {
    const planOf = async tenantId => Plans.plan((await prisma.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } }) || {}).plan);
    const limitFor = Plans.limitOf; // null = no limit

    // Throws (403) when adding `adding` more would go over the plan. user: who is asking, so the message tells the right person what to do.
    async function assertRoom(tenantId, kind, { adding = 1, user } = {}) {
        const plan = await planOf(tenantId), limit = limitFor(plan, kind);
        if (limit === null) return;
        const used = await KINDS[kind].count(prisma, tenantId);
        if (used + adding <= limit) return;
        const k = KINDS[kind];
        const now = used > limit ? `you have ${number(used)}` // over it already (the plan was made smaller)
            : used === limit ? `${limit === 1 ? 'it is' : 'all ' + number(limit) + ' are'} in use`
            : `you have ${number(used)} and this would add ${number(adding)}`;
        const todo = user && (user.role === 'SUPER_ADMIN' || user.impersonatedBy) ? ' Change the client\'s plan under Manage → Overview to add more.' : ' Ask ETAX to move you to a bigger plan.';
        throw new HttpError(403, `The ${plan.name} plan allows ${number(limit)} ${limit === 1 ? k.one || k.noun : k.noun} and ${now}.${todo}`);
    }

    // What is used against each limit, for the screens: { plan: { id, name } | null, rows: [{ kind, label, noun, one, used, limit }] }
    async function usage(tenantId, modules = ['INVOICING', 'POS']) {
        const plan = await planOf(tenantId);
        const kinds = ['users', ...modules.flatMap(m => OF_PRODUCT[m] || [])];
        const rows = await Promise.all(kinds.map(async kind => ({ kind, label: KINDS[kind].label + (kind === 'items' ? ' (Point of Sale)' : kind === 'products' ? ' (FBR)' : ''), noun: KINDS[kind].noun, one: KINDS[kind].one, used: await KINDS[kind].count(prisma, tenantId), limit: limitFor(plan, kind) })));
        return { plan: plan ? { id: plan.id, name: plan.name } : null, rows };
    }

    return { planOf, assertRoom, usage };
}

module.exports = { createLimits, KINDS, OF_PRODUCT };
