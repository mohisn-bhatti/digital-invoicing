// Copy FBR's public lists of sales tax SROs, circulars, general orders and notices into LegalReference, so the
// Tax Rules page can search them (CA's Final Outlook, step 3 point 5). Read from fbr.gov.pk the same way its own pages do;
// these are public pages, so this does not go through the FBR_PROXY_URL static-IP proxy.
const axios = require('axios');

const BASE = 'https://www.fbr.gov.pk';
const http = axios.create({ timeout: 90000, headers: { 'User-Agent': 'Mozilla/5.0 (Raseed)', 'X-Requested-With': 'XMLHttpRequest' } });
const form = o => new URLSearchParams(o).toString();
const FORM = { headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' } };

// "/Date(1791313200000)/" → Date
const msDate = v => { const m = /\/Date\((-?\d+)\)\//.exec(String(v || '')); return m ? new Date(Number(m[1])) : null; };
const clean = v => String(v ?? '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// DataTables server-side paging, 500 at a time (≈1,500 SROs)
async function fetchSros() {
    const out = [];
    for (let start = 0; ; start += 500) {
        const res = await http.post(`${BASE}/Home/LoadSROs`, form({
            draw: 1, start, length: 500, department: 'Sales Tax', 'search[value]': '', 'search[regex]': 'false',
            'order[0][column]': 2, 'order[0][dir]': 'desc',
            ...Object.fromEntries(['SRONumber', 'Title', 'CreationDate', 'CategoryTitle', 'UploadedFile1'].flatMap((c, i) => [[`columns[${i}][data]`, c], [`columns[${i}][name]`, c]])),
        }), FORM);
        const rows = res.data?.data || [];
        for (const r of rows) out.push({ source: 'SRO', refNo: clean(r.SRONumber), title: clean(r.Title), issuedOn: msDate(r.CreationDate), url: String(r.UploadedFile1 || '').trim() });
        if (rows.length < 500 || out.length >= (res.data?.recordsTotal || 0)) break;
    }
    return out;
}

// Circulars (category 180) and general orders (151) come back whole
async function fetchOrders(categoryId, source) {
    const res = await http.post(`${BASE}/Home/ShowOrdersFiltered`, form({ CategoryID: categoryId, Parent: 'true' }), FORM);
    const rows = Array.isArray(res.data) ? res.data : res.data?.data || [];
    return rows.map(r => ({ source, refNo: clean(r.DocumentNumber), title: clean(r.DocumentTitle), issuedOn: msDate(r.CreationDate), url: String(r.UploadedFile1 || '').trim() }));
}

// The notice board is a plain HTML table: S.No | title (link to the PDF). No dates.
async function fetchNotices() {
    const res = await http.get(`${BASE}/categ/admin-notice-board/444`, { responseType: 'text' });
    const out = [];
    for (const tr of String(res.data).match(/<tr[\s\S]*?<\/tr>/g) || []) {
        const url = (/href="([^"]+\.pdf)"/i.exec(tr) || [])[1];
        const cells = (tr.match(/<td[\s\S]*?<\/td>/g) || []).map(clean);
        if (url && cells.length >= 2) out.push({ source: 'NOTICE', refNo: '', title: cells[1] || cells[0], issuedOn: null, url: url.startsWith('http') ? url : BASE + url });
    }
    return out;
}

// Returns counts per source; a source that fails keeps its previous rows
async function sync(prisma) {
    const jobs = { SRO: fetchSros, CIRCULAR: () => fetchOrders(180, 'CIRCULAR'), GENERAL_ORDER: () => fetchOrders(151, 'GENERAL_ORDER'), NOTICE: fetchNotices };
    const result = {};
    for (const [source, job] of Object.entries(jobs)) {
        try {
            const rows = (await job()).filter(r => r.url && r.title);
            const seen = new Map(rows.map(r => [r.url, r])); // FBR lists a few documents twice
            const now = new Date(), ops = [...seen.values()].map(r => prisma.legalReference.upsert({
                where: { source_url: { source, url: r.url } },
                update: { refNo: r.refNo, title: r.title.slice(0, 500), issuedOn: r.issuedOn, fetchedAt: now },
                create: { ...r, title: r.title.slice(0, 500), fetchedAt: now },
            }));
            for (let i = 0; i < ops.length; i += 200) await prisma.$transaction(ops.slice(i, i + 200));
            result[source] = seen.size;
        } catch (err) {
            result[source] = `failed: ${err.message}`;
        }
    }
    return result;
}

// Number to write on the invoice / tax rule, e.g. "SRO 1751(I)/2026"
function referenceText(r) {
    if (r.source === 'SRO') return /^SRO/i.test(r.refNo) ? r.refNo : `SRO ${r.refNo}`;
    return r.refNo || r.title;
}

module.exports = { sync, referenceText, msDate };
