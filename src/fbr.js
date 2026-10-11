// PRAL Digital Invoicing API v1.12 client (docs/FBR-DI-API-Technical-Spec-v1.12.pdf)
const axios = require('axios');
const { errorHint } = require('./fbrErrors');
const { HttpsProxyAgent } = require('https-proxy-agent');

const DI_BASE = 'https://gw.fbr.gov.pk/di_data/v1/di';
const REF_URLS = {
    provinces: 'https://gw.fbr.gov.pk/pdi/v1/provinces',
    uom: 'https://gw.fbr.gov.pk/pdi/v1/uom',
    doctypecode: 'https://gw.fbr.gov.pk/pdi/v1/doctypecode',
    transtypecode: 'https://gw.fbr.gov.pk/pdi/v1/transtypecode',
    itemdesccode: 'https://gw.fbr.gov.pk/pdi/v1/itemdesccode',
};

function isMock() {
    return process.env.FBR_MOCK === 'true';
}

function endpoint(method, fbrEnv) {
    return `${DI_BASE}/${method}${fbrEnv === 'SANDBOX' ? '_sb' : ''}`;
}

// FBR only accepts whitelisted IPs. On Render/Vercel the outbound IP is shared and changes,
// so FBR traffic can be tunnelled through a static-IP proxy (e.g. QuotaGuard Static).
// TLS stays end-to-end through the CONNECT tunnel; the proxy cannot read the token.
const proxyAgent = process.env.FBR_PROXY_URL ? new HttpsProxyAgent(process.env.FBR_PROXY_URL) : undefined;

function client(token) {
    return axios.create({
        timeout: 20000,
        httpsAgent: proxyAgent,
        proxy: false, // use the agent above, not axios' built-in env proxy handling
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        validateStatus: () => true, // inspect every status ourselves
    });
}

// invoice: header fields as stored; lines: item rows as stored/calculated
function buildPayload(tenant, invoice, lines) {
    const payload = {
        invoiceType: invoice.invoiceType,
        invoiceDate: invoice.invoiceDate,
        sellerNTNCNIC: tenant.sellerNtnCnic,
        sellerBusinessName: tenant.sellerBusinessName,
        sellerProvince: tenant.sellerProvince,
        sellerAddress: tenant.sellerAddress,
        buyerNTNCNIC: invoice.buyerNtnCnic || '',
        buyerBusinessName: invoice.buyerBusinessName,
        buyerProvince: invoice.buyerProvince,
        buyerAddress: invoice.buyerAddress,
        buyerRegistrationType: invoice.buyerRegistrationType,
        invoiceRefNo: invoice.invoiceRefNo || '',
        items: lines.map(l => ({
            hsCode: l.hsCode,
            productDescription: l.productDescription,
            rate: l.rate,
            uoM: l.uoM,
            quantity: Number(l.quantity),
            totalValues: Number(l.totalValues),
            valueSalesExcludingST: Number(l.valueSalesExcludingST),
            fixedNotifiedValueOrRetailPrice: Number(l.fixedNotifiedValueOrRetailPrice),
            salesTaxApplicable: Number(l.salesTaxApplicable),
            salesTaxWithheldAtSource: Number(l.salesTaxWithheldAtSource),
            // IRIS "Invoice Format" sends "" when there is no extra tax; FBR error 0091 wants it empty for some sale types
            extraTax: Number(l.extraTax) > 0 ? Number(l.extraTax) : '',
            furtherTax: Number(l.furtherTax),
            sroScheduleNo: l.sroScheduleNo || '',
            fedPayable: Number(l.fedPayable),
            discount: Number(l.discount),
            saleType: l.saleType,
            sroItemSerialNo: l.sroItemSerialNo || '',
        })),
    };
    if (invoice.fbrEnv === 'SANDBOX') payload.scenarioId = invoice.scenarioId;
    // Debit note reason (DI errors 0027/0028). Field names not in the v1.12 sample — confirm in sandbox.
    if (invoice.invoiceType === 'Debit Note') {
        payload.reason = invoice.reason || '';
        payload.reasonRemarks = invoice.reasonRemarks || '';
    }
    return payload;
}

// Collect every error message FBR put in a validationResponse
function describeErrors(vr) {
    if (!vr) return 'No validationResponse in FBR reply';
    const msgs = [];
    // FBR's reply plus the spec's plain description of the code (§7), e.g. "[0052] … — HS code doesn't match the sale type"
    const hint = code => { const h = errorHint(code); return h ? ` — ${h}` : ''; };
    if (vr.error) msgs.push(`${vr.errorCode ? `[${vr.errorCode}] ` : ''}${vr.error}${hint(vr.errorCode)}`);
    for (const s of vr.invoiceStatuses || []) {
        if (s.statusCode !== '00') msgs.push(`Item ${s.itemSNo}: ${s.errorCode ? `[${s.errorCode}] ` : ''}${s.error}${hint(s.errorCode)}`);
    }
    return msgs.join('; ') || `FBR status: ${vr.status}`;
}

// Valid only if header says 00/Valid AND every item says 00 (spec §4.1.5 shows a "00" header with an invalid item)
function isValid(vr) {
    if (!vr || vr.statusCode !== '00' || String(vr.status).toLowerCase() !== 'valid') return false;
    return (vr.invoiceStatuses || []).every(s => s.statusCode === '00');
}

function httpError(res) {
    // FBR's gateway: 900901 "Invalid Credentials" = the token itself is wrong / not issued yet
    if (res.status === 401 && /900901|invalid credentials/i.test(JSON.stringify(res.data || ''))) return 'FBR says the token is wrong (401 Invalid Credentials). Paste the Security Token shown in IRIS → Digital Invoicing → API Integration — IRIS shows "N/A" until PRAL issues it.';
    if (res.status === 401) return 'FBR rejected the token (401). Check the token and that this server\'s IP is whitelisted in IRIS.';
    if (res.status >= 500) return `FBR server error (${res.status}). Try again shortly.`;
    return `FBR returned HTTP ${res.status}: ${typeof res.data === 'string' ? res.data.slice(0, 300) : JSON.stringify(res.data).slice(0, 300)}`;
}

// uncertain = we can't tell whether FBR processed the request (no reply, timeout, 5xx, unreadable body).
// Only matters for postinvoicedata: a lost reply there may mean the invoice IS recorded at FBR.
async function call(http, url, payload) {
    try {
        const res = await http.post(url, payload);
        if (res.status !== 200) return { ok: false, error: httpError(res), raw: res.data, uncertain: res.status >= 500 };
        if (!res.data || typeof res.data !== 'object') {
            return { ok: false, error: 'FBR sent an unreadable reply.', raw: res.data, uncertain: true };
        }
        return { ok: true, data: res.data };
    } catch (err) {
        const reason = err.code === 'ECONNABORTED' ? 'timed out' : err.message;
        return { ok: false, error: `Could not reach FBR (${reason}).`, raw: null, uncertain: true };
    }
}

const UNCERTAIN_MSG = 'The connection to FBR broke after the invoice was sent, so FBR may have recorded it. ' +
    'Check IRIS (Digital Invoicing → invoices) before resubmitting, to avoid a duplicate.';

// FBR_MOCK=true fakes FBR. FBR_MOCK_RESULT=invalid|uncertain|transient fakes failures for testing.
function mockResult(payload) {
    const mode = process.env.FBR_MOCK_RESULT || 'ok';
    if (mode === 'transient') return { ok: false, uncertain: false, transient: true, error: 'Could not reach FBR (mock outage).', raw: { mock: true, stage: 'validate' } };
    if (mode === 'invalid') return { ok: false, uncertain: false, error: '[0052] Provide proper HS Code (mock)', raw: { mock: true, stage: 'validate' } };
    if (mode === 'uncertain') return { ok: false, uncertain: true, error: `Could not reach FBR (timed out, mock). ${UNCERTAIN_MSG}`, raw: { mock: true, stage: 'post' } };
    const invoiceNumber = `${(payload.sellerNTNCNIC || '0000000').slice(0, 7)}DI${Date.now()}`;
    return { ok: true, invoiceNumber, dated: new Date().toISOString(), raw: { mock: true, invoiceNumber } };
}

// validate → post. Returns { ok, invoiceNumber?, dated?, error?, uncertain, transient, raw }
// transient = FBR unreachable/5xx before anything was recorded: safe to retry automatically later.
async function submit(token, fbrEnv, payload) {
    if (isMock()) return mockResult(payload);
    if (!token) return { ok: false, uncertain: false, error: 'No FBR token saved. Add it in FBR Settings.', raw: null };

    const http = client(token);

    // Nothing is recorded at FBR by validateinvoicedata, so every failure here is safe to retry
    const v = await call(http, endpoint('validateinvoicedata', fbrEnv), payload);
    if (!v.ok) return { ok: false, uncertain: false, transient: v.uncertain, error: v.error, raw: { stage: 'validate', response: v.raw } };
    if (!isValid(v.data.validationResponse)) {
        return { ok: false, uncertain: false, error: describeErrors(v.data.validationResponse), raw: { stage: 'validate', response: v.data } };
    }

    const p = await call(http, endpoint('postinvoicedata', fbrEnv), payload);
    if (!p.ok) {
        return { ok: false, uncertain: p.uncertain, error: p.uncertain ? `${p.error} ${UNCERTAIN_MSG}` : p.error, raw: { stage: 'post', response: p.raw } };
    }
    if (!isValid(p.data.validationResponse) || !p.data.invoiceNumber) {
        return { ok: false, uncertain: false, error: describeErrors(p.data.validationResponse), raw: { stage: 'post', response: p.data } };
    }
    return { ok: true, invoiceNumber: p.data.invoiceNumber, dated: p.data.dated, raw: { stage: 'post', response: p.data } };
}

// Reference data is the same for everyone; cache it in memory for a day
const refCache = new Map();
async function reference(name, token, { fresh = false } = {}) {
    const url = REF_URLS[name];
    if (!url) throw new Error('Unknown reference list');
    const hit = refCache.get(name);
    if (!fresh && hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.data;
    if (isMock() || !token) return null;
    const res = await client(token).get(url, { timeout: 60000 });
    if (res.status !== 200 || !Array.isArray(res.data)) return null;
    refCache.set(name, { at: Date.now(), data: res.data });
    return res.data;
}

// Valid UOMs for an HS code (spec §5.9). annexure_id 3 = sales annexure.
const uomCache = new Map();
async function hsUom(hsCode, token) {
    if (uomCache.has(hsCode)) return uomCache.get(hsCode);
    if (isMock() || !token) return null;
    const res = await client(token).get('https://gw.fbr.gov.pk/pdi/v2/HS_UOM', { params: { hs_code: hsCode, annexure_id: 3 } });
    if (res.status !== 200 || !Array.isArray(res.data)) return null;
    const list = res.data.map(u => u.description).filter(Boolean);
    uomCache.set(hsCode, list);
    return list;
}

// The chain FBR expects for a line's tax (spec §5.8 → §5.7 → §5.10): the rates allowed for a sale type, the SRO
// schedules for a chosen rate, then the SRO item serials for a chosen schedule. Each returns null when FBR can't be
// asked (mock mode, no token, error) so the screen falls back to typing the value.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = d => `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`; // "24-Feb-2024"
const ymd = d => d.toISOString().slice(0, 10);
const chainCache = new Map();
async function cachedList(key, token, url, params, map) {
    const hit = chainCache.get(key);
    if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.data;
    if (isMock() || !token) return null;
    const res = await client(token).get(url, { params, timeout: 30000 });
    if (res.status !== 200 || !Array.isArray(res.data)) return null;
    const data = res.data.map(map).filter(x => x.id != null && x.desc);
    chainCache.set(key, { at: Date.now(), data });
    return data;
}
// §5.8 SaleTypeToRate: [{ id: ratE_ID, desc: ratE_DESC, value: ratE_VALUE }]
function saleTypeRates(token, { transTypeId, provinceCode, date = new Date() }) {
    return cachedList(`rate:${transTypeId}:${provinceCode}:${ymd(date)}`, token, 'https://gw.fbr.gov.pk/pdi/v2/SaleTypeToRate',
        { date: dmy(date), transTypeId, originationSupplier: provinceCode },
        r => ({ id: r.ratE_ID, desc: String(r.ratE_DESC || '').trim(), value: r.ratE_VALUE }));
}
// §5.7 SroSchedule: [{ id: srO_ID, desc: srO_DESC }]
function sroSchedules(token, { rateId, provinceCode, date = new Date() }) {
    return cachedList(`sro:${rateId}:${provinceCode}:${ymd(date)}`, token, 'https://gw.fbr.gov.pk/pdi/v1/SroSchedule',
        { rate_id: rateId, date: dmy(date), origination_supplier_csv: provinceCode },
        r => ({ id: r.srO_ID, desc: String(r.srO_DESC || '').trim() }));
}
// §5.10 SROItem: [{ id: srO_ITEM_ID, desc: srO_ITEM_DESC }]
function sroItems(token, { sroId, date = new Date() }) {
    return cachedList(`sroitem:${sroId}:${ymd(date)}`, token, 'https://gw.fbr.gov.pk/pdi/v2/SROItem',
        { date: ymd(date), sro_id: sroId },
        r => ({ id: r.srO_ITEM_ID, desc: String(r.srO_ITEM_DESC || '').trim() }));
}

// Buyer status (spec §5.11–5.12): STATL = active taxpayer list, Get_Reg_Type = registered or not.
// Returns { live, registrationType: 'Registered'|'Unregistered'|null, active: true|false|null }
async function checkBuyer(regNo, date, token) {
    if (isMock() || !token) return { live: false, registrationType: null, active: null };
    const http = client(token);
    const [atl, reg] = await Promise.all([
        call(http, 'https://gw.fbr.gov.pk/dist/v1/statl', { regno: regNo, date }),
        call(http, 'https://gw.fbr.gov.pk/dist/v1/Get_Reg_Type', { Registration_No: regNo }),
    ]);
    const regType = reg.ok ? String(reg.data.REGISTRATION_TYPE || '').toLowerCase() : '';
    const atlStatus = atl.ok ? String(atl.data.status || '').toLowerCase().replace(/[^a-z]/g, '') : '';
    return {
        live: atl.ok || reg.ok,
        registrationType: regType === 'registered' ? 'Registered' : regType === 'unregistered' ? 'Unregistered' : null,
        active: atlStatus === 'active' ? true : atlStatus === 'inactive' ? false : null,
        error: atl.ok || reg.ok ? undefined : (atl.error || reg.error),
    };
}

// "Test FBR connection" (admin): one read-only call (provinces list — records nothing at FBR) with the client's
// token, through the static proxy if set. Says in plain words whether FBR answers, the token works and the IP is let in.
async function testConnection(token) {
    const ip = await egressIp().catch(() => ({ ip: null, viaProxy: Boolean(proxyAgent) }));
    const base = { ip: ip.ip, viaProxy: ip.viaProxy };
    if (!token) return { ...base, ok: false, verdict: 'No token saved for this client yet — paste the Security Token from IRIS and save.' };
    const t0 = Date.now();
    try {
        const res = await client(token).get('https://gw.fbr.gov.pk/pdi/v1/provinces', { timeout: 30000 });
        const ms = Date.now() - t0, fault = res.data?.fault, text = JSON.stringify(res.data || '').slice(0, 300);
        if (res.status === 200 && Array.isArray(res.data)) return { ...base, ok: true, ms, status: 200, verdict: `FBR accepted the token and this IP — ${res.data.length} provinces received.` };
        if (fault?.code === 900901 || /invalid credentials/i.test(text)) return { ...base, ok: false, ms, status: res.status, verdict: 'FBR answered: the token is wrong (900901 Invalid Credentials). Paste the Security Token shown in IRIS — IRIS shows "N/A" until PRAL issues it.' };
        if (fault?.code === 900902) return { ...base, ok: false, ms, status: res.status, verdict: 'FBR answered: no token was sent (900902).' };
        if (res.status === 401 || res.status === 403) return { ...base, ok: false, ms, status: res.status, verdict: `FBR refused (HTTP ${res.status}) — the token may be right but this IP${ip.ip ? ` (${ip.ip})` : ''} is not approved yet in IRIS → IP Whitelisting. ${text}` };
        return { ...base, ok: false, ms, status: res.status, verdict: `FBR answered HTTP ${res.status}: ${text}` };
    } catch (err) {
        return { ...base, ok: false, verdict: `No answer from FBR (${err.code === 'ECONNABORTED' ? 'timed out' : err.code || err.message}) — FBR may be down, or blocking this IP.` };
    }
}

// The public IP FBR will see (through FBR_PROXY_URL if set) — this is what goes into IRIS whitelisting
async function egressIp() {
    const res = await axios.get('https://api.ipify.org?format=json', { httpsAgent: proxyAgent, proxy: false, timeout: 10000 });
    return { ip: res.data.ip, viaProxy: Boolean(proxyAgent) };
}

module.exports = { testConnection, buildPayload, submit, reference, hsUom, saleTypeRates, sroSchedules, sroItems, checkBuyer, isValid, describeErrors, endpoint, egressIp, _call: call };
