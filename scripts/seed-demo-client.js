// Demo data for ONE existing client, so it can be shown to prospects: a restaurant-and-banquet business with a manager and a cashier,
// two branches and three counters, a menu, saved customers, two weeks of sales (every way of paying, discounts, returns, a bill that
// needs the buyer's details, one sale PRA refused and one cancelled). Everything goes through the real sale service in test mode, so
// nothing is sent to PRA and the invoice numbers start with MOCK-. Sale times run over the last 14 days (Pakistan time).
//
//   node scripts/seed-demo-client.js --owner someone@example.com               dry run: says what it would do and writes nothing
//   node scripts/seed-demo-client.js --owner someone@example.com --yes         does it
//   node scripts/seed-demo-client.js --owner someone@example.com --wipe --yes  removes what a run made: that client's Point of Sale data and
//                                                                              the two demo logins (nothing else, in no other client)
//
// DATABASE_URL says where to write: the local database from .env, or another one only if it is set on purpose for the run (this script
// prints the host and the client it found before it does anything, and writes nothing without --yes). DEMO_PASSWORD is the password of the
// two demo logins: it is read from the environment and never stored. The logins are manager@ and cashier@ <client name without spaces>-demo
// .example.com (DEMO_LOGIN_DOMAIN changes that). Needs the owner to exist, the client to have the Point of Sale module, and that client to
// have no Point of Sale data yet (--wipe first if a run was cut short, or to make the fortnight end today again before a demo).
require('dotenv').config({ quiet: true }); // (never replaces a variable that is already set)
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { encrypt, decrypt, mask } = require('../src/crypto');
const pra = require('../src/pos/pra');
const { createBreaker } = require('../src/pos/breaker');
const { createPosService } = require('../src/pos/service');

const args = process.argv.slice(2);
const flag = n => args.includes(`--${n}`);
const value = n => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const OWNER = String(value('owner') || '').trim().toLowerCase();
let LOGINS = []; // made once the client is known: manager@ and cashier@ <its name without spaces>-demo.example.com
const loginsFor = tenantName => {
    const domain = process.env.DEMO_LOGIN_DOMAIN || `${String(tenantName).toLowerCase().replace(/[^a-z0-9]+/g, '') || 'client'}-demo.example.com`;
    return [
        { key: 'manager', email: `manager@${domain}`, name: 'Demo Manager', tenantRole: 'ACCOUNTANT' },
        { key: 'cashier', email: `cashier@${domain}`, name: 'Demo Cashier', tenantRole: 'CASHIER' },
    ];
};
const DAYS = 14;

const die = msg => { console.error(`\nSTOPPED: ${msg}\n`); process.exit(1); };
if (!OWNER || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(OWNER)) die('say whose client this is: --owner someone@example.com (the e-mail of the client\'s owner login)');
if (!pra.isMock()) die('the server is set live (PRA_MOCK=false): demo data is made in test mode only');
if (!process.env.DATABASE_URL) die('DATABASE_URL is not set');
const dbUrl = new URL(process.env.DATABASE_URL);
const prisma = new PrismaClient({ log: [] });

// ---------- a small steady random number generator, so two runs make the same fortnight ----------
const mulberry32 = a => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const rng = mulberry32(20261019);
const pick = list => list[Math.floor(rng() * list.length)];
const between = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const chance = p => rng() < p;
const weighted = pairs => { let r = rng() * pairs.reduce((t, [, w]) => t + w, 0); for (const [v, w] of pairs) { if ((r -= w) < 0) return v; } return pairs[0][0]; };
const ean13 = body12 => { const d = String(body12).split('').map(Number); const sum = d.reduce((t, x, i) => t + x * (i % 2 ? 3 : 1), 0); return `${body12}${(10 - (sum % 10)) % 10}`; };
const pkDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---------- the menu ----------
// (the names are chosen so that, listed alphabetically, the dishes come first on the cashier's screen)
const FOOD = 'Dining', DRINKS = 'Drinks', BANQUET = 'Events & catering', SHOP = 'Shop';
const MENU = [
    // [key, name, category, price, extras]
    ['buffet', 'Lunch buffet', FOOD, 1500], ['karahiFull', 'Chicken karahi (full)', FOOD, 2200], ['karahiHalf', 'Chicken karahi (half)', FOOD, 1150],
    ['muttonBiryani', 'Mutton biryani', FOOD, 950], ['chickenBiryani', 'Chicken biryani', FOOD, 650], ['kabab', 'Seekh kabab (4 pieces)', FOOD, 780],
    ['daal', 'Daal mash', FOOD, 420], ['naan', 'Naan', FOOD, 40], ['roghni', 'Roghni naan', FOOD, 60], ['raita', 'Raita', FOOD, 80],
    ['jamun', 'Gulab jamun (2 pieces)', FOOD, 180], ['kheer', 'Kheer', FOOD, 220],
    ['cola', 'Soft drink', DRINKS, 120, { barcode: ean13('896100100001') }], ['water', 'Mineral water 1.5 L', DRINKS, 90, { barcode: ean13('896100100002') }],
    ['chai', 'Doodh patti chai', DRINKS, 100], ['lime', 'Fresh lime', DRINKS, 150], ['lassi', 'Sweet lassi', DRINKS, 200],
    ['cake', 'Birthday cake (1 lb)', SHOP, 1800, { barcode: ean13('896100100003') }], ['dates', 'Dates gift box', SHOP, 1400, { barcode: ean13('896100100004') }],
    ['soup', 'Winter special soup', FOOD, 350, { off: true }],
];

(async () => {
    // ---------- who, and what is there ----------
    const owner = await prisma.user.findFirst({ where: { email: { equals: OWNER, mode: 'insensitive' }, tenantRole: 'OWNER', tenantId: { not: null } }, include: { tenant: true } });
    if (!owner) die(`no client owner has the e-mail ${OWNER}`);
    const tenant = owner.tenant;
    LOGINS = loginsFor(tenant.companyName);
    const sameName = await prisma.tenant.count({ where: { companyName: tenant.companyName } });
    console.log(`Database : ${dbUrl.hostname}${dbUrl.port ? ':' + dbUrl.port : ''}${dbUrl.pathname}`);
    console.log(`Client   : "${tenant.companyName}" (${tenant.id.slice(0, 8)}…), modules ${tenant.modules.join(' + ')}, plan ${tenant.plan || 'none (no limits)'}, active ${tenant.active}`);
    if (sameName !== 1) die(`${sameName} clients are called "${tenant.companyName}": not guessing which one`);
    if (!tenant.modules.includes('POS')) die('this client does not have the Point of Sale module switched on');
    const count = async () => ({
        profile: await prisma.posProfile.count({ where: { tenantId: tenant.id } }), branches: await prisma.posBranch.count({ where: { tenantId: tenant.id } }),
        counters: await prisma.posCounter.count({ where: { tenantId: tenant.id } }), items: await prisma.posItem.count({ where: { tenantId: tenant.id } }),
        customers: await prisma.posCustomer.count({ where: { tenantId: tenant.id } }), sales: await prisma.posSale.count({ where: { tenantId: tenant.id } }),
    });
    const existing = await count();
    const logins = await prisma.user.findMany({ where: { email: { in: LOGINS.map(l => l.email) } }, select: { email: true, tenantId: true } });
    console.log(`Has now  : ${JSON.stringify(existing)}; demo logins already there: ${logins.length ? logins.map(l => l.email).join(', ') : 'none'}`);

    // ---------- take away what a previous run made ----------
    if (flag('wipe')) {
        if (logins.some(l => l.tenantId !== tenant.id)) die('one of the demo login addresses belongs to another client: not touching it');
        console.log(`\nWOULD REMOVE: all Point of Sale data of this client (${JSON.stringify(existing)}) and the logins ${logins.map(l => l.email).join(', ') || '(none)'}.`);
        if (!flag('yes')) { console.log('Nothing was changed (add --yes to do it).'); return; }
        await prisma.posSale.deleteMany({ where: { tenantId: tenant.id } }); // lines, events and attempts go with them
        await prisma.posCustomer.deleteMany({ where: { tenantId: tenant.id } });
        await prisma.posCounter.deleteMany({ where: { tenantId: tenant.id } });
        await prisma.posBranch.deleteMany({ where: { tenantId: tenant.id } });
        await prisma.posItem.deleteMany({ where: { tenantId: tenant.id } });
        await prisma.posProfile.deleteMany({ where: { tenantId: tenant.id } });
        await prisma.user.deleteMany({ where: { email: { in: LOGINS.map(l => l.email) }, tenantId: tenant.id } });
        await prisma.tenant.update({ where: { id: tenant.id }, data: { posSeq: 0 } });
        console.log('Removed. Now:', JSON.stringify(await count()));
        return;
    }

    if (Object.values(existing).some(n => n > 0)) die('this client already has Point of Sale data; nothing is added to it (use --wipe --yes first if a previous run of this script was cut short)');
    if (logins.length) die(`the login ${logins[0].email} already exists`);
    const password = process.env.DEMO_PASSWORD;
    if (!password || password.length < 8) die('DEMO_PASSWORD (at least 8 characters) is needed for the two demo logins');

    const dryRun = !flag('yes');
    console.log(dryRun ? '\nDRY RUN: nothing will be written.' : '\nWriting…');

    // ---------- the fortnight: when each sale happens (Pakistan time) ----------
    const realNow = Date.now(), today = pkDay(realNow), first = addDays(today, -(DAYS - 1));
    const slots = [];
    for (let i = 0; i < DAYS; i++) {
        const day = addDays(today, -(DAYS - 1 - i)), weekday = new Date(`${day}T12:00:00Z`).getUTCDay(); // 5 = Friday, 6 = Saturday
        const n = weekday === 5 || weekday === 6 ? between(7, 9) : between(4, 6);
        for (let k = 0; k < n; k++) {
            const lunch = chance(0.45), hour = lunch ? between(12, 15) : between(19, 22), minute = between(0, 59);
            const at = new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:00`).getTime();
            if (at < realNow - 20 * 60e3) slots.push(at); // (nothing in the future: today only has what has "already happened")
        }
    }
    slots.sort((a, b) => a - b);
    // a few big bookings at the hall desk, on fixed days
    const events = [
        { day: addDays(today, -11), time: '16:10', who: 'manager', mode: 6, customer: 'khan', hall: 180000, heads: 250, extra: null, label: 'wedding reception' },
        { day: addDays(today, -6), time: '15:40', who: 'owner', mode: 5, customer: 'ali', hall: 60000, heads: 60, extra: null, label: 'birthday party' },
        { day: addDays(today, -2), time: '18:20', who: 'manager', mode: 2, customer: 'sunrise', hall: 0, heads: 120, extra: 'decoration', label: 'corporate dinner' },
    ].map(e => ({ ...e, at: new Date(`${e.day}T${e.time}:00+05:00`).getTime() })).filter(e => e.at < realNow);

    console.log(`Plan     : ${LOGINS.length} logins (${LOGINS.map(l => l.email).join(', ')}), 2 branches, 3 counters, ${MENU.length + 3} menu items, 5 customers,`);
    console.log(`           ${slots.length} restaurant sales + ${events.length} banquet bookings between ${first} and ${today}, a few returns, 1 refused and 1 cancelled sale.`);
    if (dryRun) { console.log('\nNothing was changed (add --yes to do it).'); return; }

    // ---------- the logins ----------
    const hash = await bcrypt.hash(password, 10);
    const people = { owner };
    for (const l of LOGINS) people[l.key] = await prisma.user.create({ data: { email: l.email, name: l.name, password: hash, role: 'CLIENT_USER', tenantRole: l.tenantRole, tenantId: tenant.id, active: true, pendingApproval: false, mustChangePassword: false } });

    // ---------- the service, with a clock this script moves (so sales have the dates they are meant to) ----------
    let clock = new Date(`${first}T09:00:00+05:00`).getTime();
    const svc = createPosService({ prisma, audit: async () => {}, encrypt, decrypt, mask, pra, breaker: createBreaker({ threshold: 1000 }), now: () => new Date(clock) });
    const as = key => ({ tenantId: tenant.id, email: people[key].email, req: { user: { id: people[key].id, email: people[key].email, tenantId: tenant.id }, ip: '127.0.0.1' } });

    await svc.saveProfile(as('owner'), { businessName: 'Al-Noor Restaurant & Banquet', pntn: '1234567-8', address: '12 MM Alam Road, Gulberg III, Lahore', phone: '042-111-000-111', receiptFooter: 'Thank you for dining with us. DEMO DATA, not a real business.' });
    await svc.saveSettings(as('owner'), { defaultPaymentMode: 1, receiptHeader: 'Family dining and banquets, Lahore', receiptWidth: 80, showCashier: true, itemPct: '9801.2000', itemTaxRate: 16, itemTaxRateCard: 8, itemCategory: FOOD });
    await svc.createBranch(as('owner'), { name: 'Gulberg', address: '12 MM Alam Road, Gulberg III', city: 'Lahore', phone: '042-111-000-111' });
    await svc.createBranch(as('owner'), { name: 'Marquee DHA', address: '45 Phase 5, DHA', city: 'Lahore', phone: '042-111-000-222' }); // (sorts after Gulberg, so the cashier's screen starts at the restaurant)
    const branches = await svc.listBranches(tenant.id), gulberg = branches.find(b => b.name === 'Gulberg'), dha = branches.find(b => b.name === 'Marquee DHA');
    for (const [branch, name, posId] of [[gulberg, 'Till 1', '999001'], [gulberg, 'Till 2', '999002'], [dha, 'Hall desk', '999003']]) await svc.createCounter(as('owner'), { branchId: branch.id, name, posId, env: 'SANDBOX', token: 'DEMO-TEST-TOKEN-NOT-REAL' });
    const counterRows = (await svc.listBranches(tenant.id)).flatMap(b => b.counters), till1 = counterRows.find(c => c.name === 'Till 1'), till2 = counterRows.find(c => c.name === 'Till 2'), hall = counterRows.find(c => c.name === 'Hall desk');

    // restaurant: 16%, or 8% when the customer pays by card, mobile wallet or QR (Second Schedule from 1 July 2026). Banquet and catering: 8%.
    const item = {}, PRICE = new Map(); // PRICE: item id -> its price
    for (const [key, name, category, unitPrice, extra = {}] of MENU) {
        item[key] = await svc.createItem(as('manager'), { name, category, pctCode: '9801.2000', taxRate: 16, taxRateCard: 8, unitPrice, ...(extra.barcode ? { barcode: extra.barcode } : {}) });
        PRICE.set(item[key].id, unitPrice);
        if (extra.off) await svc.updateItem(as('manager'), item[key].id, { active: false });
    }
    item.hall = await svc.createItem(as('manager'), { name: 'Banquet hall booking', category: BANQUET, pctCode: '9801.3000', taxRate: 8, openPrice: true });
    item.catering = await svc.createItem(as('manager'), { name: 'Catering per head', category: BANQUET, pctCode: '9801.5000', taxRate: 8, unitPrice: 1200 });
    item.decoration = await svc.createItem(as('manager'), { name: 'Stage and floral decoration', category: BANQUET, pctCode: '9801.3000', taxRate: 8, openPrice: true });

    const customer = {
        khan: await svc.createCustomer(as('manager'), { name: 'Khan Events (Pvt) Ltd', pntn: '1234567-8', phone: '0300-1234567', address: 'Office 12, Gulberg III, Lahore', notes: 'Weddings and corporate events. Pays by cheque.' }),
        ali: await svc.createCustomer(as('manager'), { name: 'Ali Raza', cnic: '35202-1234567-1', phone: '0321-1112233', address: 'Model Town, Lahore', notes: 'Birthday parties' }),
        sunrise: await svc.createCustomer(as('manager'), { name: 'Sunrise Corporate Lunches', pntn: '7654321-0', phone: '042-35761234', address: 'Johar Town, Lahore', notes: 'Monthly lunch orders for an office' }),
        hina: await svc.createCustomer(as('cashier'), { name: 'Mrs. Hina (regular)', phone: '0333-4445566', notes: 'Prefers the corner table' }),
        bashir: await svc.createCustomer(as('manager'), { name: 'Bashir Catering', pntn: '2345678-9', phone: '0301-9998877', address: 'Allama Iqbal Town, Lahore', notes: 'Account closed' }),
    };
    await svc.updateCustomer(as('manager'), customer.bashir.id, { active: false });

    // ---------- the sales ----------
    // One timeline, oldest first: restaurant sales, banquet bookings, the two sales PRA refuses, and the returns that follow some of them
    // (so the invoice numbers run in the order of the dates, as they would have in real life).
    const dishes = ['buffet', 'karahiFull', 'karahiHalf', 'muttonBiryani', 'chickenBiryani', 'kabab', 'daal', 'roghni', 'raita', 'jamun', 'kheer'], drinks = ['cola', 'water', 'chai', 'lime', 'lassi'];
    const basket = () => {
        const lines = [], used = new Set();
        const add = (key, quantity) => { if (!used.has(key)) { used.add(key); lines.push({ itemId: item[key].id, quantity }); } };
        for (let i = 0, n = between(1, 3); i < n; i++) add(pick(dishes), weighted([[1, 5], [2, 3], [3, 1], [4, 1]]));
        if (chance(0.8)) add('naan', between(2, 8));
        if (chance(0.7)) add(pick(drinks), between(1, 4));
        if (chance(0.08)) add(pick(['cake', 'dates']), 1);
        if (chance(0.25)) { // a discount on the first line: a percentage, or a fixed amount when the line is big enough to take it
            const l = lines[0], amount = l.quantity * (PRICE.get(l.itemId) || 0);
            if (chance(0.5) || amount < 400) l.discountPercent = pick([5, 10]); else l.discount = pick([50, 100, 150]);
        }
        return lines;
    };
    const sell = async (at, who, counter, mode, input, expectOutcome = 'FISCALIZED') => {
        clock = at;
        const made = await svc.createSale(as(who), { counterId: counter.id, paymentMode: mode, ...input });
        if (made.result.outcome !== expectOutcome) throw new Error(`a sale ended ${made.result.outcome}, not ${expectOutcome}: ${made.result.message}`);
        return made;
    };
    const modeFor = i => (i % 53 === 11 ? 3 : i % 61 === 20 ? 4 : i % 29 === 7 ? 5 : weighted([[1, 58], [2, 34], [5, 4], [3, 2], [4, 2]]));
    const FORCED = { 4: 3, 9: 4, 14: 5 }; // sale number -> way of paying, so the less usual ways are there whatever the random numbers say
    const timeline = [
        ...slots.map(at => ({ at, kind: 'sale' })), ...events.map(e => ({ at: e.at, kind: 'event', e })),
        ...[['refused', addDays(today, -3), '20:15'], ['toCancel', addDays(today, -1), '21:05']].map(([kind, day, time]) => ({ at: new Date(`${day}T${time}:00+05:00`).getTime(), kind })).filter(x => x.at < realNow - 40 * 60e3),
    ].sort((a, b) => a.at - b.at);
    const waiting = []; // what happens later: returns and the cancellation
    const flush = async upTo => { waiting.sort((a, b) => a.at - b.at); while (waiting.length && waiting[0].at <= upTo) { const w = waiting.shift(); clock = w.at; await w.run(); } };
    const returns = [], planned = { partial1: false, full: false, partial2: false };
    const later = (made, afterMs, label, run) => { const at = new Date(made.sale.createdAt).getTime() + afterMs; if (at < realNow - 5 * 60e3) waiting.push({ at, run: async () => { returns.push(await run()); } }); else console.log(`  (the ${label} would be in the future: skipped)`); };
    const made = [];
    let n = 0;
    for (const step of timeline) {
        await flush(step.at);
        if (step.kind === 'sale') {
            const who = weighted([['cashier', 62], ['manager', 28], ['owner', 10]]);
            const counter = who === 'cashier' ? weighted([[till1, 70], [till2, 30]]) : who === 'manager' ? weighted([[till1, 60], [till2, 40]]) : till1;
            const mode = FORCED[n] || modeFor(n);
            const input = { lines: basket() };
            const r = rng();
            if (r < 0.10) input.customerId = customer[pick(['hina', 'ali', 'sunrise', 'khan'])].id; else if (r < 0.22) input.buyer = { name: `Table ${between(1, 24)}` };
            const m = await sell(step.at, who, counter, mode, input); made.push(m); n++;
            const multi = m.sale.lines.length >= 2;
            if (multi && mode === 1 && n >= 8 && !planned.partial1) { planned.partial1 = true; later(m, 40 * 60e3, 'first return', () => svc.creditNote(as('manager'), m.sale.id, { lines: [{ lineId: m.sale.lines[1].id, quantity: 1 }], reason: 'One dish was sent back: it came cold' })); }
            else if (multi && mode === 2 && n >= 18 && !planned.full) { planned.full = true; later(m, 90 * 60e3, 'full return', () => svc.creditNote(as('manager'), m.sale.id, { lines: m.sale.lines.map(l => ({ lineId: l.id, quantity: l.quantity })), reason: 'Customer unhappy with the order: everything returned' })); }
            else if (multi && mode === 1 && n >= 35 && !planned.partial2) { planned.partial2 = true; later(m, 30 * 60e3, 'second return', () => svc.creditNote(as('manager'), m.sale.id, { lines: [{ lineId: m.sale.lines[0].id, quantity: 1 }], reason: 'Wrong item rung up' })); }
        } else if (step.kind === 'event') {
            // banquet bookings: the bill is far above Rs 50,000 before tax, so the buyer's name and CNIC or NTN are on the invoice
            const e = step.e, lines = [];
            if (e.hall) lines.push({ itemId: item.hall.id, quantity: 1, unitPrice: e.hall });
            if (e.heads) lines.push({ itemId: item.catering.id, quantity: e.heads });
            if (e.extra) lines.push({ itemId: item.decoration.id, quantity: 1, unitPrice: 35000 });
            const m = await sell(e.at, e.who, hall, e.mode, { customerId: customer[e.customer].id, lines }); made.push(m);
            if (e.label === 'wedding reception') later(m, 5 * 3600e3, 'banquet return', () => svc.creditNote(as('owner'), m.sale.id, { lines: [{ lineId: m.sale.lines[m.sale.lines.length - 1].id, quantity: 20 }], reason: 'Final head count: 20 fewer guests than booked' }));
        } else if (step.kind === 'refused') {
            await sell(step.at, 'cashier', till1, 1, { buyer: { name: 'MOCK-REJECT' }, lines: [{ itemId: item.muttonBiryani.id, quantity: 2 }] }, 'REJECTED'); // PRA refuses this one: it shows on the dashboard until it is corrected or cancelled
        } else if (step.kind === 'toCancel') {
            const m = await sell(step.at, 'cashier', till2, 1, { buyer: { name: 'MOCK-REJECT' }, lines: [{ itemId: item.kabab.id, quantity: 1 }] }, 'REJECTED');
            waiting.push({ at: step.at + 15 * 60e3, run: async () => { await svc.cancel(as('manager'), m.sale.id, 'Customer left before paying'); } });
        }
    }
    await flush(realNow);

    // events of every sale carry the time the sale has, not the time of this script's run
    await prisma.$executeRawUnsafe(`UPDATE "PosSaleEvent" e SET "at" = s."createdAt" + (sub.rn * interval '2 seconds')
        FROM "PosSale" s, (SELECT id, row_number() OVER (PARTITION BY "saleId" ORDER BY "at", id) AS rn FROM "PosSaleEvent" WHERE "saleId" IN (SELECT id FROM "PosSale" WHERE "tenantId" = $1)) sub
        WHERE e.id = sub.id AND s.id = e."saleId"`, tenant.id);

    // one line in the activity trail that says what happened and why (the data itself leaves none: it did not happen at the counter)
    const total = await prisma.posSale.count({ where: { tenantId: tenant.id } });
    await prisma.auditLog.create({ data: { tenantId: tenant.id, userEmail: 'system', action: 'admin.demo_data', entityType: 'Tenant', entityId: tenant.id, summary: `Demo Point of Sale data added at the owner's request (${MENU.length + 3} items, ${total} sales and returns, 5 customers) and the logins ${LOGINS.map(l => l.email).join(', ')}` } });

    // ---------- what it came to ----------
    const after = await count();
    const paid = await prisma.posSale.groupBy({ by: ['paymentMode'], where: { tenantId: tenant.id, state: 'FISCALIZED', invoiceType: 1 }, _count: { _all: true } });
    const states = await prisma.posSale.groupBy({ by: ['state', 'invoiceType'], where: { tenantId: tenant.id }, _count: { _all: true } });
    console.log('\nDone.', JSON.stringify(after));
    console.log('Sales by way of paying (1 cash, 2 card, 3 voucher, 4 loyalty, 5 mixed, 6 cheque):', JSON.stringify(Object.fromEntries(paid.map(p => [p.paymentMode, p._count._all]))));
    console.log('Sales by state and type (1 sale, 3 credit note):', JSON.stringify(states.map(s => `${s.state}/${s.invoiceType}: ${s._count._all}`)));
    const overview = await svc.overview(as('owner'));
    console.log(`Dashboard today: ${overview.todaySales.count} sales, Rs ${overview.todaySales.total}; needs attention: ${overview.rejected} refused, ${overview.awaiting} waiting, ${overview.outcomeUnknown} unknown`);
    console.log('\nLogins (the password is the one in DEMO_PASSWORD):');
    console.log(`  OWNER       ${OWNER} (unchanged)`);
    for (const l of LOGINS) console.log(`  ${l.tenantRole.padEnd(11)} ${l.email}`);
})().catch(e => { console.error('\nFAILED:', e && e.message ? e.message : e); console.error('Run it again with --wipe --yes to remove whatever was made, then fix the cause and make it again.'); process.exitCode = 1; }).finally(() => prisma.$disconnect());
