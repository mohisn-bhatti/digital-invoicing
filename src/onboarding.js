// Per-tenant go-live checklist: seller details → IRIS profile → token → sandbox scenarios → production → first live invoice
const { assignedScenarios } = require('./activityScenarios');
const { SCENARIOS } = require('./scenarios');

// Scenario ids with a SUBMITTED sandbox invoice, split by whether FBR really saw it or it was mock mode
async function scenarioResults(prisma, tenantId) {
    const rows = await prisma.$queryRaw`
        SELECT "scenarioId" AS id,
               bool_or(COALESCE(("fbrResponse"->>'mock')::boolean, false) = false) AS real
        FROM "Invoice"
        WHERE "tenantId" = ${tenantId} AND "fbrEnv" = 'SANDBOX' AND status = 'SUBMITTED' AND "scenarioId" IS NOT NULL
        GROUP BY "scenarioId"`;
    return new Map(rows.map(r => [r.id, r.real]));
}

async function checklist(prisma, tenant) {
    const assigned = assignedScenarios(tenant.businessActivities, tenant.sector);
    const results = await scenarioResults(prisma, tenant.id);
    const scenarios = assigned.map(id => ({
        id,
        desc: SCENARIOS.find(s => s.id === id)?.desc || id,
        passed: results.get(id) === true,
        mockOnly: results.get(id) === false,
    }));
    const passed = scenarios.filter(s => s.passed).length;
    const live = await prisma.invoice.count({ where: { tenantId: tenant.id, fbrEnv: 'PRODUCTION', status: 'SUBMITTED' } });
    const sellerDone = Boolean(tenant.sellerNtnCnic && tenant.sellerBusinessName && tenant.sellerProvince && tenant.sellerAddress);

    const steps = [
        { key: 'seller', label: 'Seller details: NTN, name, province, address', done: sellerDone },
        { key: 'authLetter', label: 'Signed authorization letter (Form STR-13) on file', done: Boolean(tenant.authLetterAt) },
        { key: 'profile', label: 'Business nature & sector, same as chosen in IRIS', done: tenant.businessActivities.length > 0 && Boolean(tenant.sector) },
        { key: 'token', label: 'PRAL sandbox token saved', done: Boolean(tenant.fbrTokenEnc) },
        { key: 'scenarios', label: `Sandbox scenarios passed: ${passed} of ${assigned.length}`, done: assigned.length > 0 && passed === assigned.length },
        { key: 'production', label: 'Production token saved and environment set to Production', done: tenant.fbrEnv === 'PRODUCTION' && Boolean(tenant.fbrTokenEnc) },
        { key: 'live', label: 'First live invoice filed with FBR', done: live > 0 },
    ];
    return { steps, done: steps.filter(s => s.done).length, total: steps.length, scenarios, scenariosPassed: passed, scenariosAssigned: assigned.length };
}

module.exports = { checklist };
