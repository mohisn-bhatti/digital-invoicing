// Input checks of the Compliance & Deadlines module (SRS 15): every value is cleaned and checked here before it is saved, and a
// problem comes back as one plain sentence (CmpError 400).
const crypto = require('crypto');
const C = require('../../public/cmp-countries');
const R = require('../../public/cmp-rules');
const { bad } = require('./common');

// control characters (NUL included) cannot be stored or would garble a message; tabs and line breaks are kept where they belong
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// One line of text: spaces squashed
function line(v, max, what, { required = false } = {}) {
    const s = String(v === undefined || v === null ? '' : v).replace(CONTROL, '').replace(/[\t\r\n]+/g, ' ').trim().replace(/\s+/g, ' ');
    if (required && !s) throw bad(`${what} is required.`);
    if (s.length > max) throw bad(`${what} is too long (${max} characters at most).`);
    return s;
}
// Several lines (an address, a note, a message): line breaks kept, trailing spaces and long runs of empty lines removed
function multiline(v, max, what, { required = false } = {}) {
    const s = String(v === undefined || v === null ? '' : v).replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
    if (required && !s) throw bad(`${what} is required.`);
    if (s.length > max) throw bad(`${what} is too long (${max} characters at most).`);
    return s;
}
// A secret (portal password, PIN): kept exactly as typed, apart from characters that cannot be stored
function secret(v, max, what) {
    const s = String(v === undefined || v === null ? '' : v).replace(CONTROL, '');
    if (s.length > max) throw bad(`${what} is too long (${max} characters at most).`);
    return s;
}
function email(v) {
    const s = line(v, 200, 'Email').toLowerCase();
    if (s && !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/i.test(s)) throw bad('Enter a valid email address, e.g. name@company.com.');
    return s;
}
function day(v, what) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!R.ymdOk(s)) throw bad(`${what}: enter a valid date.`);
    return s;
}
function int(v, min, max, what) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw bad(`${what} must be a whole number from ${min} to ${max}.`);
    return n;
}
function country(v) {
    const c = C.get(v);
    if (!c) throw bad("Choose the client's country first.");
    return c;
}
function zone(v, what = 'Time zone') {
    if (!C.zoneOk(v)) throw bad(`${what}: choose a time zone from the list.`);
    return v;
}
const idOf = v => line(v, 64, 'Id');

// SRS 3.2. Mandatory: the country, the name, the contact number (WhatsApp goes to it) and the portal username and password, unless
// "no online portal" is ticked for a client that has none (the CA: so nobody types "NA").
// creating = false: a password or PIN left empty keeps the saved one.
function cleanClient(b, { creating }) {
    const c = country(b.country);
    const contact = line(b.contactNumber, 30, 'Contact number', { required: true });
    const e164 = R.toE164(contact, c.dial);
    if (!e164) throw bad(`Enter the contact number with its country code, e.g. +${c.dial} … (8 to 15 digits).`);
    const data = {
        country: c.code,
        timeZone: zone(b.timeZone || c.zones[0], "The client's time zone"),
        name: line(b.name, 200, 'Client name', { required: true }),
        address: multiline(b.address, 500, 'Address'),
        contactNumber: e164,
        email: email(b.email),
        registrationNo: line(b.registrationNo, 60, 'Registration No.'),
        reference: line(b.reference, 200, 'Reference'),
        noPortal: b.noPortal === true,
        noWhatsApp: b.noWhatsApp === true,
    };
    data.portalUsername = data.noPortal ? '' : line(b.portalUsername, 200, 'Username', { required: true });
    const password = data.noPortal ? '' : secret(b.portalPassword, 200, 'Password');
    if (creating && !data.noPortal && !password) throw bad('Password is required.');
    const pin = data.noPortal ? '' : secret(b.pinCode, 30, 'Pin code');
    return { data, password, pin, removePin: b.removePin === true || data.noPortal };
}

const FIELD_TYPES = { TEXT: 'Text', NUMBER: 'Number', DATE: 'Date', MULTILINE: 'Multi-line text' };
// SRS 3.3: a name, a type, and the countries it is for (by default the country of the client being edited)
// keepKey: the field's own name as it is now (a field made before a name became a basic detail can keep it)
function cleanFieldDef(b, { defaultCountry, keepKey } = {}) {
    const name = line(b.name, 60, 'Field name', { required: true });
    const key = R.keyOf(name);
    if (R.RESERVED.has(key) && key !== keepKey) throw bad(`"${name}" is already one of the basic details of every client. Choose another name.`);
    const type = String(b.type || 'TEXT').toUpperCase();
    if (!FIELD_TYPES[type]) throw bad('Choose the type of the field: text, number, date or multi-line text.');
    const allCountries = b.allCountries === true;
    let countries = [];
    if (!allCountries) {
        const given = Array.isArray(b.countries) ? b.countries : (b.countries ? [b.countries] : []);
        countries = [...new Set(given.map(x => country(x).code))];
        if (!countries.length && defaultCountry) countries = [country(defaultCountry).code];
        if (!countries.length) throw bad('Choose the countries this field is for (or all countries).');
    }
    return { name, key, type, allCountries, countries };
}
// One value of a field, as its type wants it. '' = no value (the field shows as missing).
function cleanFieldValue(def, v) {
    const label = def.name;
    if (def.type === 'MULTILINE') return multiline(v, 2000, label);
    if (def.type === 'DATE') { const s = String(v === undefined || v === null ? '' : v).trim(); return s ? day(s, label) : ''; }
    if (def.type === 'NUMBER') {
        const s = line(v, 40, label).replace(/[,\s]/g, '');
        if (s && !/^-?\d+(\.\d+)?$/.test(s)) throw bad(`${label} must be a number.`);
        return s;
    }
    return line(v, 500, label);
}

// SRS 4. frequency: how often it comes back, fixed once added. The CA (9 Nov 2026): no list to choose from, the three dates say it
// (a one-month period every month, three months every quarter, six months every six months, else every year: R.detectFrequency);
// "YEARLY" can still be asked for a shorter period that comes back once a year.
// yearsTotal ("How many years"): '' / null / 0 = unlimited; otherwise 1 to 100 years in all (the first one included).
// amberDays and autoNext: set on each obligation (the CA), no longer one setting for the whole firm.
function cleanObligation(b, { partial = false } = {}) {
    const out = {};
    if (!partial || b.name !== undefined) out.name = line(b.name, 120, 'Obligation name', { required: true });
    if (!partial) {
        out.frequency = b.frequency ? String(b.frequency).toUpperCase() : R.detectFrequency(b.periodStart, b.periodEnd);
        if (!R.FREQUENCIES[out.frequency]) throw bad('Choose how often the obligation comes back: every month, every quarter, every six months or every year.');
    }
    if (!partial || b.amberDays !== undefined) out.amberDays = b.amberDays === undefined || b.amberDays === null || b.amberDays === '' ? 7 : int(b.amberDays, 0, 90, 'The number of days before the due date it turns amber');
    if (!partial || b.autoNext !== undefined) out.autoNext = b.autoNext === undefined ? true : b.autoNext === true;
    if (!partial || b.portalUrl !== undefined) {
        const url = line(b.portalUrl, 500, 'Portal link');
        if (url) { let ok = false; try { const u = new URL(url); ok = ['http:', 'https:'].includes(u.protocol) && Boolean(u.hostname); } catch { /* not a link */ } if (!ok) throw bad('The portal link must be a web address starting with https://'); }
        out.portalUrl = url;
    }
    if (!partial || b.yearsTotal !== undefined) out.yearsTotal = b.yearsTotal === null || b.yearsTotal === '' || b.yearsTotal === undefined || Number(b.yearsTotal) === 0 ? null : int(b.yearsTotal, 1, 100, 'The number of years');
    if (!partial || b.notes !== undefined) out.notes = multiline(b.notes, 1000, 'Notes');
    if (!partial || b.periodStart !== undefined || b.periodEnd !== undefined || b.dueDate !== undefined) Object.assign(out, cleanDates(b));
    return out;
}
function cleanDates(b) {
    const d = { periodStart: String(b.periodStart || '').trim(), periodEnd: String(b.periodEnd || '').trim(), dueDate: String(b.dueDate || '').trim() };
    const problem = R.datesProblem(d.periodStart, d.periodEnd, d.dueDate);
    if (problem) throw bad(problem);
    return d;
}
// SRS 5: any number of days before (negative), on (0) or after the due date; one reminder per day; at most 20
function cleanReminders(list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) throw bad('Reminders must be a list.');
    if (list.length > 20) throw bad('At most 20 reminders per obligation.');
    const seen = new Set();
    return list.map(r => {
        const offsetDays = int(r && r.offsetDays, -366, 366, 'A reminder\'s number of days');
        if (seen.has(offsetDays)) throw bad(`Two reminders fall on the same day (${R.offsetLabel(offsetDays).toLowerCase()}). Keep one.`);
        seen.add(offsetDays);
        const templateId = line(r && r.templateId, 64, 'Template');
        if (!templateId) throw bad('Choose a message template for each reminder.');
        return { offsetDays, templateId };
    }).sort((a, b) => a.offsetDays - b.offsetDays);
}
function cleanTemplate(b, { partial = false } = {}) {
    const out = {};
    if (!partial || b.name !== undefined) out.name = line(b.name, 80, 'Template name', { required: true });
    if (!partial || b.purpose !== undefined) {
        const purpose = String(b.purpose || 'REMINDER').toUpperCase();
        if (!R.TEMPLATE_PURPOSES[purpose]) throw bad('Choose what the template is for.');
        out.purpose = purpose;
    }
    if (!partial || b.body !== undefined) out.body = multiline(b.body, 4000, 'Message', { required: true });
    if (b.active !== undefined) out.active = b.active === true;
    return out;
}
function cleanSettings(b) {
    const out = {};
    if (b.timeZone !== undefined) out.timeZone = zone(b.timeZone, "The firm's time zone");
    if (b.reminderHour !== undefined) out.reminderHour = int(b.reminderHour, 0, 23, 'The reminder hour');
    if (b.amberDays !== undefined) out.amberDays = int(b.amberDays, 0, 90, 'The number of days');
    if (b.autoNextYear !== undefined) out.autoNextYear = b.autoNextYear === true;
    // what the firm's invoices and receipts say about it (SRS 9)
    for (const [k, max, label] of [['firmName', 200, 'Firm name'], ['firmPhone', 40, 'Phone'], ['firmEmail', 200, 'Email'], ['firmTaxNo', 60, 'Tax registration number']]) if (b[k] !== undefined) out[k] = line(b[k], max, label);
    if (out.firmEmail) out.firmEmail = email(out.firmEmail);
    for (const [k, max, label] of [['firmAddress', 500, 'Address'], ['bankDetails', 800, 'Bank details'], ['invoiceFooter', 500, 'Invoice footer']]) if (b[k] !== undefined) out[k] = multiline(b[k], max, label);
    // the firm's WhatsApp numbers that messages go from (up to 10), each with how it opens; one is the default
    if (b.waSenders !== undefined) {
        if (!Array.isArray(b.waSenders) || b.waSenders.length > 10) throw bad('Up to 10 WhatsApp numbers.');
        const seen = new Set();
        out.waSenders = b.waSenders.map(x => {
            const label = line(x && x.label, 60, 'The name of a WhatsApp number', { required: true });
            const raw = String((x && x.phone) || '');
            const phone = /^\s*(\+|00)/.test(raw) ? R.toE164(raw, '') : null; // with its country code: a local number could be anyone's
            if (!phone) throw bad(`${label}: enter the number with its country code, e.g. +92 300 1234567.`);
            if (seen.has(phone)) throw bad(`${phone} is there twice.`);
            seen.add(phone);
            return { id: /^[a-f0-9]{10}$/.test(String((x && x.id) || '')) ? x.id : crypto.randomBytes(5).toString('hex'), label, phone,
                open: R.SENDER_OPEN[x && x.open] ? x.open : 'ANY', isDefault: Boolean(x && x.isDefault) };
        });
        const first = out.waSenders.findIndex(s => s.isDefault);
        out.waSenders.forEach((s, i) => { s.isDefault = i === (first < 0 ? 0 : first); });
    }
    if (b.invoiceHeader !== undefined) out.invoiceHeader = multiline(b.invoiceHeader, 300, 'Header');
    // the logo: a small picture as a data: URL (the screen shrinks it before it is sent), PNG, JPEG or WebP, at most 300 KB
    if (b.logo !== undefined) {
        const l = String(b.logo || '');
        if (l && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(l)) throw bad('The logo must be a PNG, JPEG or WebP picture.');
        if (l.length > 400000) throw bad('The logo is too large: choose a smaller picture (at most 300 KB).');
        out.logo = l;
    }
    for (const k of ['invoiceFormat', 'receiptFormat']) {
        if (b[k] === undefined) continue;
        const f = line(b[k], 40, 'Number format');
        if (!/\{N+\}/.test(f)) throw bad('A number format must contain {NNNN} (the running number), e.g. INV-{YYYY}-{NNNN}.');
        out[k] = f;
    }
    return out;
}

module.exports = { line, multiline, secret, email, day, int, country, zone, idOf, cleanClient, FIELD_TYPES, cleanFieldDef, cleanFieldValue, cleanObligation, cleanDates, cleanReminders, cleanTemplate, cleanSettings };
