// Compliance & Deadlines (SRS "Global Statutory Deadline, Compliance, Invoice & Communication Module"): the parts, put together.
// now() is passed in so the tests can move the clock.
const { createCommon } = require('./common');
const { createClients } = require('./clients');
const { createObligations } = require('./obligations');
const { createComms } = require('./comms');
const { createSweep } = require('./sweep');
const { createInvoices } = require('./invoices');
const { createBulk } = require('./bulk');
const { createReports } = require('./reports');
const { createNotify } = require('./notify');
const { createReportsCatalog } = require('./reportsCatalog');
const { createDashboard } = require('./dashboard');

function createCompliance({ prisma, audit, encrypt, decrypt, now = () => new Date() }) {
    const common = createCommon({ prisma });
    const clients = createClients({ prisma, audit, encrypt, decrypt, common, now });
    const obligations = createObligations({ prisma, audit, common, now });
    const invoices = createInvoices({ prisma, audit, common, now });
    const comms = createComms({ prisma, audit, common, clients, obligations, invoices, now });
    const bulk = createBulk({ prisma, audit, common, obligations, now });
    const reports = createReports({ prisma, audit, common, clients, obligations, comms, invoices, now });
    // the notifications hear about what happens through common.notify (set here, once everything they may need exists)
    const notify = createNotify({ prisma, audit, common, clients, obligations, invoices, comms, now });
    common.hooks.notify = notify;
    const reportsCatalog = createReportsCatalog({ prisma, audit, common, clients, obligations, comms, invoices, reports, now });
    const dashboard = createDashboard({ prisma, common, clients, obligations, now });
    const { sweep } = createSweep({ prisma, audit, obligations, notify, now });
    return { common, clients, obligations, comms, invoices, bulk, reports, notify, reportsCatalog, dashboard, sweep };
}

module.exports = { createCompliance };
