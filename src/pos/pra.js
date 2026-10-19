// PRA's cloud IMS API (PRAL "Technical Specification … Software Fiscal Device" v1.2, 7.2.2): one POST per invoice with the
// counter's Bearer token. HTTP 200 alone is not success: only Code "100" with an InvoiceNumber makes a fiscal invoice.
//
// Every attempt ends in one of four outcomes:
//   FISCALIZED  PRA answered Code "100" with the fiscal invoice number
//   REJECTED    PRA answered and said no (bad data, bad token, IP not whitelisted…): safe to correct and send again
//   NOT_SENT    nothing reached PRA (no connection, no token, breaker open): safe to try again
//   UNKNOWN     no usable answer after the request may have been sent (timeout, broken connection, server error):
//               PRA may or may not have recorded it, so it is NEVER retried by itself (SRS FR-2.6)
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const ENDPOINTS = {
    SANDBOX: 'https://ims.pral.com.pk/ims/sandbox/api/Live/PostData',
    PRODUCTION: 'https://ims.pral.com.pk/ims/production/api/Live/PostData',
};
// What the receipt's QR code opens (PRA's own verification page: PRAL spec FAQ 4)
const VERIFY_URL = 'https://reg.pra.punjab.gov.pk/IMSFiscalReport/SearchPOSInvoice_Report.aspx?PRAInvNo=';
const verifyUrl = fiscalNumber => VERIFY_URL + encodeURIComponent(fiscalNumber);

// Test mode is the default: nothing is sent to PRA unless PRA_MOCK=false is set on the server
const isMock = () => process.env.PRA_MOCK !== 'false';
const timeoutMs = () => { const n = Number(process.env.POS_PRA_TIMEOUT_MS); return n >= 1000 && n <= 60000 ? n : 8000; }; // SRS FR-6.4: 6–8 s to start

// PRA needs the server's IP whitelisted for production; the static-IP proxy used for FBR does the same job here
let proxyAgent = null;
function agent() {
    const url = process.env.PRA_PROXY_URL || process.env.FBR_PROXY_URL;
    if (!url) return undefined;
    if (!proxyAgent || proxyAgent.url !== url) { proxyAgent = new HttpsProxyAgent(url); proxyAgent.url = url; }
    return proxyAgent;
}

// The reply is read as text first: InvoiceNumber can arrive as a bare 19–20 digit number, which JSON.parse would round
function parseBody(raw) {
    let v = raw;
    for (let i = 0; i < 3; i++) {
        if (v && typeof v === 'object') return v;
        if (typeof v !== 'string' || !v.trim()) return null;
        try { v = JSON.parse(v.trim().replace(/("InvoiceNumber"\s*:\s*)(\d{15,})/g, '$1"$2"')); } catch { return null; }
    }
    return null;
}

const errorTexts = errors => (Array.isArray(errors) ? errors : errors ? [errors] : [])
    .map(e => (typeof e === 'string' ? e : (e && (e.Message || e.message || e.Error || e.error)) || JSON.stringify(e))).filter(Boolean);

function classifyResponse(status, body) {
    const data = parseBody(body);
    const code = data && data.Code !== undefined && data.Code !== null ? String(data.Code).trim() : '';
    const invoiceNumber = data && data.InvoiceNumber !== undefined && data.InvoiceNumber !== null ? String(data.InvoiceNumber).trim() : '';
    const errors = errorTexts(data && data.Errors);
    const said = [data && data.Response, ...errors].filter(Boolean).join(' — ');
    const base = { httpStatus: status, code: code || null, errors, raw: data };
    if (status >= 200 && status < 300 && code === '100' && invoiceNumber && /[1-9A-Za-z]/.test(invoiceNumber)) {
        return { ...base, outcome: 'FISCALIZED', invoiceNumber, message: said || 'Fiscal invoice number received.' };
    }
    if (status >= 200 && status < 300 && code === '100') {
        return { ...base, outcome: 'UNKNOWN', message: 'PRA said it accepted the sale but did not return an invoice number, so it must be checked by hand.' };
    }
    if (status === 401 || status === 403) {
        return { ...base, outcome: 'REJECTED', message: `PRA refused the token or this server's IP address (HTTP ${status}). Check the token, and that PRA has whitelisted the server's IP.${said ? ' PRA said: ' + said : ''}` };
    }
    if (status === 503) return { ...base, outcome: 'NOT_SENT', reason: 'SERVICE_UNAVAILABLE', message: 'PRA\'s service is not available right now. Nothing was recorded; try again in a moment.' };
    if (status >= 500) return { ...base, outcome: 'UNKNOWN', message: `PRA had a server problem (HTTP ${status}), so it is not known whether the sale was recorded.` };
    if (data && (code || said)) return { ...base, outcome: 'REJECTED', message: said || `PRA answered with code ${code}.` };
    if (status >= 400) return { ...base, outcome: 'REJECTED', message: `PRA answered HTTP ${status} without a reason.` };
    return { ...base, outcome: 'UNKNOWN', message: 'PRA answered, but the reply could not be understood, so it is not known whether the sale was recorded.' };
}

// Errors that happen before anything can have reached PRA
const NOT_SENT = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN']);
function classifyError(err) {
    const code = err && err.code;
    if (NOT_SENT.has(code)) {
        return { outcome: 'NOT_SENT', reason: 'NO_CONNECTION', code: null, httpStatus: null, errors: [], message: `Could not connect to PRA (${code}). Nothing was sent. Check the internet connection and try again.` };
    }
    const timedOut = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ERR_CANCELED' || (err && (err.name === 'TimeoutError' || err.name === 'CanceledError' || /timeout|aborted/i.test(err.message || '')));
    return {
        outcome: 'UNKNOWN', code: null, httpStatus: null, errors: [],
        message: timedOut ? 'PRA did not answer in time, so it is not known whether the sale was recorded.' : `The connection to PRA broke${code ? ' (' + code + ')' : ''}, so it is not known whether the sale was recorded.`,
    };
}

// Test mode answers by itself. In the buyer name, MOCK-REJECT, MOCK-TIMEOUT and MOCK-OFFLINE rehearse the failures.
function mockSubmit(payload) {
    const name = String(payload.BuyerName || '').trim().toUpperCase();
    if (name === 'MOCK-OFFLINE') return classifyError(Object.assign(new Error('simulated'), { code: 'ECONNREFUSED' }));
    if (name === 'MOCK-TIMEOUT') return classifyError(Object.assign(new Error('simulated'), { code: 'ECONNABORTED' }));
    if (name === 'MOCK-REJECT') return classifyResponse(200, { InvoiceNumber: '', Code: '106', Response: 'Invoice rejected (simulated).', Errors: ['Simulated validation error'] });
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const number = `MOCK-${stamp}-${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    return { ...classifyResponse(200, { InvoiceNumber: number, Code: '100', Response: 'Fiscal invoice number generated (test mode, not sent to PRA).', Errors: null }), mock: true };
}

const defaultPost = (url, body, { token, timeout }) => axios.post(url, body, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    timeout, signal: AbortSignal.timeout(timeout), // a hard cap on the whole call, so the cashier screen never waits forever
    httpsAgent: agent(), proxy: false, validateStatus: () => true, transformResponse: [x => x],
});

// deps.post: replaces the HTTP call (tests)
async function submit({ env, token, payload }, deps = {}) {
    const started = Date.now();
    const finish = r => ({ reason: null, mock: false, ...r, durationMs: Date.now() - started });
    if (isMock()) return finish(mockSubmit(payload));
    const url = ENDPOINTS[env];
    if (!url) return finish({ outcome: 'NOT_SENT', reason: 'NO_ENDPOINT', message: 'This counter has no valid environment (Sandbox or Production).', errors: [] });
    if (!token) return finish({ outcome: 'NOT_SENT', reason: 'NO_TOKEN', message: 'This counter has no PRA token yet. Ask the account owner to add it in Settings.', errors: [] });
    try {
        const res = await (deps.post || defaultPost)(url, payload, { token, timeout: timeoutMs() });
        return finish(classifyResponse(res.status, res.data));
    } catch (err) {
        return finish(classifyError(err));
    }
}

module.exports = { ENDPOINTS, VERIFY_URL, verifyUrl, isMock, timeoutMs, parseBody, classifyResponse, classifyError, mockSubmit, submit };
