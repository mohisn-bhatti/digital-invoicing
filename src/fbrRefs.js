// Copy FBR's public lists of the Sales Tax Act and Rules, SROs, circulars, general orders and notices into LegalReference, so the
// Tax Rules page can search them (CA's Final Outlook, step 3 point 5). Read from fbr.gov.pk the same way its own pages do;
// these are public pages, so this does not go through the FBR_PROXY_URL static-IP proxy.
const axios = require('axios');

const BASE = 'https://www.fbr.gov.pk';
const http = axios.create({ timeout: 90000, headers: { 'User-Agent': 'Mozilla/5.0 (ETAX)', 'X-Requested-With': 'XMLHttpRequest' } });
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

// "Sales Tax Act 1990 amended upto 30-06-2026", "... updated upto 31st July, 2026" → that date (the edition), else null
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function editionDate(title) {
    const t = String(title).replace(/^.*?\bup\s*to\b/i, '');
    let m = /(\d{1,2})[-./](\d{1,2})[-./](\d{4})/.exec(t);
    if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    m = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*,?\s+(\d{4})/i.exec(t);
    if (m && MONTHS.includes(m[2].toLowerCase())) return new Date(Date.UTC(+m[3], MONTHS.indexOf(m[2].toLowerCase()), +m[1]));
    return null;
}

// The notice board and the Sales Tax Act / Rules pages are plain HTML tables: S.No | title (link to the PDF). No dates.
async function fetchTable(path, source) {
    const res = await http.get(`${BASE}${path}`, { responseType: 'text' });
    const out = [];
    for (const tr of String(res.data).match(/<tr[\s\S]*?<\/tr>/g) || []) {
        const url = (/href="([^"]+\.pdf)"/i.exec(tr) || [])[1];
        const cells = (tr.match(/<td[\s\S]*?<\/td>/g) || []).map(clean);
        const title = cells[1] || cells[0];
        if (url && cells.length >= 2) out.push({ source, refNo: '', title, issuedOn: source === 'NOTICE' ? null : editionDate(title), url: url.startsWith('http') ? url : BASE + url });
    }
    return out;
}

// Returns counts per source; a source that fails keeps its previous rows
async function sync(prisma) {
    const jobs = {
        ACT: () => fetchTable('/categ/sales-tax-act/301', 'ACT'), RULES: () => fetchTable('/categ/sales-tax-rules-2006/302', 'RULES'),
        SRO: fetchSros, CIRCULAR: () => fetchOrders(180, 'CIRCULAR'), GENERAL_ORDER: () => fetchOrders(151, 'GENERAL_ORDER'),
        NOTICE: () => fetchTable('/categ/admin-notice-board/444', 'NOTICE'),
    };
    const result = {};
    for (const [source, job] of Object.entries(jobs)) {
        try {
            const rows = (await job()).filter(r => r.url && r.title);
            const seen = new Map(rows.map(r => [r.url, r])); // FBR lists a few documents twice
            // Only new or changed rows are written: the database is far from the server, so 3,000 upserts a day are slow
            const now = new Date(), title = r => r.title.slice(0, 500);
            const have = new Map((await prisma.legalReference.findMany({ where: { source }, select: { id: true, url: true, refNo: true, title: true, issuedOn: true } })).map(x => [x.url, x]));
            const fresh = [], changed = [];
            for (const r of seen.values()) {
                const old = have.get(r.url);
                if (!old) fresh.push({ ...r, title: title(r), fetchedAt: now });
                else if (old.refNo !== r.refNo || old.title !== title(r) || String(old.issuedOn) !== String(r.issuedOn)) changed.push({ id: old.id, refNo: r.refNo, title: title(r), issuedOn: r.issuedOn });
            }
            for (let i = 0; i < fresh.length; i += 500) await prisma.legalReference.createMany({ data: fresh.slice(i, i + 500), skipDuplicates: true });
            for (const c of changed) await prisma.legalReference.update({ where: { id: c.id }, data: { refNo: c.refNo, title: c.title, issuedOn: c.issuedOn } });
            await prisma.legalReference.updateMany({ where: { source }, data: { fetchedAt: now } });
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

module.exports = { sync, referenceText, msDate, editionDate };
