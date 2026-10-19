// A throw-away business for the Point of Sale tests that need a database: a branch, a counter, three items, a stand-in for PRA that
// answers from a queue, and a clock the test moves by hand. It only runs against a database on this computer and removes everything it
// made. (This folder is not called test/ so that `node --test` does not take it for a test file.)
require('dotenv').config({ quiet: true });
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { encrypt, decrypt, mask } = require('../src/crypto');
const praReal = require('../src/pos/pra');
const { createBreaker } = require('../src/pos/breaker');
const { createPosService, PosError } = require('../src/pos/service');
const { PosCalcError } = require('../src/pos/calc');
const { PosValidationError } = require('../src/pos/validate');
const { PosStateError } = require('../src/pos/states');

const local = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '');
const statusOf = e => (e instanceof PosError ? e.status : e instanceof PosCalcError || e instanceof PosValidationError || e instanceof PosStateError ? 400 : undefined);

function createWorld(label, { start = '2026-10-19T08:00:00Z' } = {}) {
    const prisma = new PrismaClient();
    const W = { ok: false, prisma, tenants: [], emails: [], audits: [], clock: Date.parse(start) };
    let fiscalSeq = 0;
    const accepted = () => ({ outcome: 'FISCALIZED', httpStatus: 200, code: '100', invoiceNumber: `${label.slice(0, 3).toUpperCase()}${++fiscalSeq}00000${fiscalSeq}`, message: 'ok', errors: [], raw: { Code: '100' }, durationMs: 5, mock: false });
    W.answer = (outcome, message, extra = {}) => ({ outcome, httpStatus: null, code: null, errors: [], raw: null, durationMs: 5, message, ...extra });
    // PRA: mock = test mode; queue = the next answers (or functions that make one); calls = what was sent
    W.pra = { mock: false, calls: [], queue: [] };
    W.praApi = {
        isMock: () => W.pra.mock, timeoutMs: () => 8000, verifyUrl: praReal.verifyUrl,
        async submit(args) {
            W.pra.calls.push(args);
            const next = W.pra.queue.shift();
            return next ? (typeof next === 'function' ? next(args) : next) : accepted();
        },
    };
    W.models = ['posCounter', 'posBranch', 'posItem', 'posCustomer', 'posProfile']; // what to empty, in order, besides the sales (more are added as the module grows)
    W.now = () => new Date(W.clock);
    W.advance = ms => { W.clock += ms; };
    W.ctxFor = (tenantId, email = 'cashier@test') => ({ tenantId, email, req: null });
    W.rejects = async (p, status, re) => { await assert.rejects(p, e => { assert.ok(statusOf(e), String(e)); if (status) assert.strictEqual(statusOf(e), status, e.message); if (re) assert.match(e.message, re); return true; }); };

    // Makes the business. Call it from the first test: it skips the whole file when there is no database on this computer.
    W.setup = async (t, { modules = ['INVOICING', 'POS'], pctCode = '9801.2000' } = {}) => {
        if (!local) { t.skip('this test only runs against a database on this computer'); return false; }
        try { await Promise.race([prisma.$queryRaw`SELECT 1`, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]); } catch { t.skip('no local database'); return false; }
        if (!process.env.ENCRYPTION_KEY) { t.skip('no ENCRYPTION_KEY'); return false; }
        W.ok = true;
        W.tag = crypto.randomBytes(4).toString('hex');
        const audit = async (req, e) => { W.audits.push(`${e.action}: ${e.summary}`); };
        W.tenantId = (await prisma.tenant.create({ data: { companyName: `TEST ${label} ${W.tag}`, modules } })).id;
        W.otherTenantId = (await prisma.tenant.create({ data: { companyName: `TEST ${label} other ${W.tag}`, modules: ['POS'] } })).id;
        W.tenants.push(W.tenantId, W.otherTenantId);
        W.ctx = W.ctxFor(W.tenantId); W.ctxOther = W.ctxFor(W.otherTenantId);
        W.svc = createPosService({ prisma, audit, encrypt, decrypt, mask, pra: W.praApi, breaker: createBreaker({ threshold: 1000, now: () => W.clock }), now: W.now });
        await W.svc.saveProfile(W.ctx, { businessName: 'Test Restaurant', pntn: '1234567-8', address: 'MM Alam Road, Lahore', phone: '042111', receiptFooter: 'Thank you' });
        await W.svc.createBranch(W.ctx, { name: 'Main', address: 'MM Alam Road', city: 'Lahore' });
        const branch = (await W.svc.listBranches(W.tenantId))[0];
        W.branch = branch;
        await W.svc.createCounter(W.ctx, { branchId: branch.id, name: 'Till 1', posId: '900001', env: 'SANDBOX', token: 'sandbox-token-1234567890' });
        W.counter = (await W.svc.listBranches(W.tenantId))[0].counters[0];
        W.items = {
            lunch: await W.svc.createItem(W.ctx, { name: 'Lunch buffet', pctCode, taxRate: 16, taxRateCard: 5, unitPrice: 1500, category: 'Food' }),
            drink: await W.svc.createItem(W.ctx, { name: 'Soft drink', pctCode, taxRate: 16, unitPrice: 120.5, category: 'Drinks' }),
            hall: await W.svc.createItem(W.ctx, { name: 'Hall booking', pctCode: '9801.3000', taxRate: 5, unitPrice: 0, openPrice: true, category: 'Halls' }),
        };
        return true;
    };
    W.sellOne = (over = {}, ctx = W.ctx) => W.svc.createSale(ctx, { counterId: W.counter.id, paymentMode: 1, buyer: {}, lines: [{ itemId: W.items.lunch.id, quantity: 2 }], ...over });
    // a test that needs the business: skipped when there is none
    W.run = (name, fn) => test(name, async t => { if (!W.ok) return t.skip('no local database'); await fn(t); });
    W.teardown = async () => {
        if (W.ok) {
            for (const id of W.tenants) {
                await prisma.posSale.deleteMany({ where: { tenantId: id } }); // lines, events and attempts go with them
                for (const model of W.models) { try { await prisma[model].deleteMany({ where: { tenantId: id } }); } catch { /* a table this test never used */ } }
                await prisma.user.deleteMany({ where: { tenantId: id } });
                await prisma.tenant.delete({ where: { id } }).catch(e => console.log('cleanup:', e.message));
            }
            if (W.emails.length) await prisma.user.deleteMany({ where: { email: { in: W.emails } } });
        }
        await prisma.$disconnect();
    };
    return W;
}

module.exports = { createWorld, statusOf };
