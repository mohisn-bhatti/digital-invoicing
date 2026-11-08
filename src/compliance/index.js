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

function createCompliance({ prisma, audit, encrypt, decrypt, now = () => new Date() }) {
    const common = createCommon({ prisma });
    const clients = createClients({ prisma, audit, encrypt, decrypt, common, now });
    const obligations = createObligations({ prisma, audit, common, now });
    const invoices = createInvoices({ prisma, audit, common, now });
    const comms = createComms({ prisma, audit, common, clients, obligations, invoices, now });
    const bulk = createBulk({ prisma, audit, common, obligations, now });
    const reports = createReports({ prisma, audit, common, clients, obligations, comms, invoices, now });
    const { sweep } = createSweep({ prisma, audit, obligations, now });
    return { common, clients, obligations, comms, invoices, bulk, reports, sweep };
}

module.exports = { createCompliance };
