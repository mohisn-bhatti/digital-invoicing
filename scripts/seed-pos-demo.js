// Demo data for showing the Point of Sale to a client: a restaurant and banquet business with three people, a branch and a
// counter, a menu, four sales and a credit note. Everything is made through the real sale service in test mode, so nothing is
// sent to PRA and the invoice numbers start with MOCK-.
//
//   node scripts/seed-pos-demo.js            make it (or say that it is already there)
//   node scripts/seed-pos-demo.js --reset    delete the demo business and make it again with fresh times
//
// It only runs against a database on this computer, and only in test mode. The password for the three demo logins is read from
// DEMO_PASSWORD, or made up and printed once: it is never stored in this file.
require('dotenv').config({ quiet: true });
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { createAudit } = require('../src/audit');
const { encrypt, decrypt, mask } = require('../src/crypto');
const pra = require('../src/pos/pra');
const { createBreaker } = require('../src/pos/breaker');
const { createPosService } = require('../src/pos/service');

const NAME = 'Al-Noor Restaurant & Banquet (DEMO)';
const DOMAIN = 'alnoor-demo.example.com';
const PEOPLE = [
    { key: 'owner', email: `owner@${DOMAIN}`, name: 'Demo Owner', tenantRole: 'OWNER' },
    { key: 'manager', email: `manager@${DOMAIN}`, name: 'Demo Manager', tenantRole: 'ACCOUNTANT' },
    { key: 'cashier', email: `cashier@${DOMAIN}`, name: 'Demo Cashier', tenantRole: 'CASHIER' },
];

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) { console.error('Refused: the demo data is only made in a database on this computer.'); process.exit(1); }
if (process.env.PRA_MOCK === 'false' || !pra.isMock()) { console.error('Refused: the server is set live (PRA_MOCK=false). The demo is made in test mode only.'); process.exit(1); }

const prisma = new PrismaClient();

async function wipe(tenantId) {
    await prisma.posSale.deleteMany({ where: { tenantId } }); // lines, events and attempts go with them
    await prisma.posCounter.deleteMany({ where: { tenantId } });
    await prisma.posBranch.deleteMany({ where: { tenantId } });
    await prisma.posItem.deleteMany({ where: { tenantId } });
    await prisma.posProfile.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } }); // the activity log is append-only: its entries stay
}

(async () => {
    const existing = await prisma.tenant.findFirst({ where: { companyName: NAME } });
    if (existing && !process.argv.includes('--reset')) { console.log(`"${NAME}" is already there. Use --reset to make it again.`); return; }
    if (existing) { await wipe(existing.id); console.log('The old demo business was removed.'); }

    const password = process.env.DEMO_PASSWORD || `Demo#${crypto.randomBytes(5).toString('hex')}Aa1`;
    const hash = await bcrypt.hash(password, 10);
    const tenant = await prisma.tenant.create({ data: { companyName: NAME, modules: ['POS'] } });
    const people = {};
    for (const p of PEOPLE) people[p.key] = await prisma.user.create({ data: { email: p.email, name: p.name, password: hash, role: 'CLIENT_USER', tenantRole: p.tenantRole, tenantId: tenant.id } });

    // sale times run from a few hours ago up to now, all today (Pakistan time), so the dashboard's "today" figures show them
    const real = Date.now(), day = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
    let clock = day(real - 3 * 3600e3) === day(real) ? real - 3 * 3600e3 : real - 20 * 60e3;
    const step = Math.min(35 * 60e3, Math.floor((real - clock) / 6));
    const audit = createAudit(prisma);
    const svc = createPosService({ prisma, audit, encrypt, decrypt, mask, pra, breaker: createBreaker({ threshold: 1000 }), now: () => new Date(clock) });
    const as = key => ({ tenantId: tenant.id, email: people[key].email, req: { user: { id: people[key].id, email: people[key].email, tenantId: tenant.id }, ip: '127.0.0.1' } });

    await svc.saveProfile(as('owner'), { businessName: 'Al-Noor Restaurant & Banquet', pntn: '1234567-8', address: '12 MM Alam Road, Gulberg III, Lahore', phone: '042-111-000-111', receiptFooter: 'Thank you for dining with us. DEMO DATA, not a real business.' });
    await svc.createBranch(as('owner'), { name: 'Gulberg', address: '12 MM Alam Road, Gulberg III', city: 'Lahore', phone: '042-111-000-111' });
    const branch = (await svc.listBranches(tenant.id))[0];
    await svc.createCounter(as('owner'), { branchId: branch.id, name: 'Till 1', posId: '999001', env: 'SANDBOX', token: 'DEMO-TEST-TOKEN-NOT-REAL' });
    const counter = (await svc.listBranches(tenant.id))[0].counters[0];

    // restaurant: 16%, or 8% when the customer pays by card, mobile wallet or QR (Second Schedule, from 1 July 2026). Banquet: 8%.
    const food = (name, category, unitPrice) => svc.createItem(as('manager'), { name, category, pctCode: '9801.2000', taxRate: 16, taxRateCard: 8, unitPrice });
    const item = {
        buffet: await food('Lunch buffet', 'Food', 1500), karahi: await food('Chicken karahi (full)', 'Food', 2200), biryani: await food('Mutton biryani', 'Food', 950),
        naan: await food('Naan', 'Food', 40), cola: await food('Soft drink', 'Drinks', 120), tea: await food('Doodh patti chai', 'Drinks', 100),
        hall: await svc.createItem(as('manager'), { name: 'Banquet hall booking', category: 'Banquet', pctCode: '9801.3000', taxRate: 8, openPrice: true }),
        catering: await svc.createItem(as('manager'), { name: 'Catering per head', category: 'Banquet', pctCode: '9801.5000', taxRate: 8, unitPrice: 1200 }),
    };

    const sale = (who, paymentMode, buyer, lines) => { clock += step; return svc.createSale(as(who), { counterId: counter.id, paymentMode, buyer, lines }); };
    const made = [];
    made.push(await sale('cashier', 1, { name: 'Table 4' }, [{ itemId: item.buffet.id, quantity: 2 }, { itemId: item.cola.id, quantity: 3 }]));
    made.push(await sale('cashier', 2, { name: 'Table 7' }, [{ itemId: item.karahi.id, quantity: 1, discountPercent: 10 }, { itemId: item.naan.id, quantity: 4 }, { itemId: item.tea.id, quantity: 2 }]));
    made.push(await sale('manager', 6, { name: 'Khan Events (Pvt) Ltd', pntn: '1234567-8', phone: '0300-1234567' }, [{ itemId: item.hall.id, quantity: 1, unitPrice: 250000 }, { itemId: item.catering.id, quantity: 200 }]));
    made.push(await sale('cashier', 1, {}, [{ itemId: item.biryani.id, quantity: 5 }, { itemId: item.cola.id, quantity: 5 }]));
    clock += step;
    const credit = await svc.creditNote(as('manager'), made[0].sale.id, { lines: [{ lineId: made[0].sale.lines[0].id, quantity: 1 }], reason: 'Customer did not want the second buffet' });

    const today = await svc.overview(as('owner'));
    console.log(`\nDemo business "${NAME}" is ready (test mode: nothing was sent to PRA).`);
    for (const m of made) console.log(`  sale ${m.sale.usin}  Rs ${String(m.sale.totals.bill).padStart(12)}  ${m.result.outcome}  ${m.sale.fiscalNumber}`);
    console.log(`  credit note ${credit.sale.usin}  Rs ${String(credit.sale.totals.bill).padStart(8)}  ${credit.result.outcome}`);
    console.log(`  dashboard today: ${today.todaySales.count} sales, Rs ${today.todaySales.total}, ${today.todayReturns.count} credit note\n`);
    console.log('Logins (all three use the same password):');
    for (const p of PEOPLE) console.log(`  ${p.tenantRole.padEnd(10)} ${p.email}`);
    console.log(`  password: ${password}\n`);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
