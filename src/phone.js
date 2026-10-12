// Mobile numbers by country: how many digits come after the country code (the national number, without a leading 0)
// and how a mobile number starts there. Countries not listed: 7 to 12 digits.
// Saved as typed for Pakistan (03001234567) and as +<code><number> for other countries (+971501234567).
// The browser has the same table (public/app.html, MOBILE_RULES).
const MOBILE_RULES = {
    92: { name: 'Pakistan', len: [10, 10], start: /^3/, startText: '3', example: '0300 1234567', local: true },
    971: { name: 'UAE', len: [9, 9], start: /^5/, startText: '5', example: '50 123 4567' },
    966: { name: 'Saudi Arabia', len: [9, 9], start: /^5/, startText: '5', example: '50 123 4567' },
    974: { name: 'Qatar', len: [8, 8], start: /^[3567]/, startText: '3, 5, 6 or 7', example: '3312 3456' },
    968: { name: 'Oman', len: [8, 8], start: /^[79]/, startText: '7 or 9', example: '9212 3456' },
    965: { name: 'Kuwait', len: [8, 8], start: /^[569]/, startText: '5, 6 or 9', example: '5012 3456' },
    973: { name: 'Bahrain', len: [8, 8], start: /^3/, startText: '3', example: '3600 1234' },
    44: { name: 'United Kingdom', len: [10, 10], start: /^7/, startText: '7', example: '7400 123456' },
    1: { name: 'USA / Canada', len: [10, 10], start: /^[2-9]/, startText: '2–9', example: '201 555 0123' },
    86: { name: 'China', len: [11, 11], start: /^1/, startText: '1', example: '131 2345 6789' },
    93: { name: 'Afghanistan', len: [9, 9], start: /^7/, startText: '7', example: '70 123 4567' },
    98: { name: 'Iran', len: [10, 10], start: /^9/, startText: '9', example: '912 345 6789' },
    90: { name: 'Turkey', len: [10, 10], start: /^5/, startText: '5', example: '501 234 5678' },
    60: { name: 'Malaysia', len: [9, 10], start: /^1/, startText: '1', example: '12 345 6789' },
    65: { name: 'Singapore', len: [8, 8], start: /^[89]/, startText: '8 or 9', example: '8123 4567' },
    49: { name: 'Germany', len: [10, 11], start: /^1[5-7]/, startText: '15, 16 or 17', example: '1512 3456789' },
    61: { name: 'Australia', len: [9, 9], start: /^4/, startText: '4', example: '412 345 678' },
    91: { name: 'India', len: [10, 10], start: /^[6-9]/, startText: '6–9', example: '81234 56789' },
    880: { name: 'Bangladesh', len: [10, 10], start: /^1/, startText: '1', example: '1812 345678' },
    94: { name: 'Sri Lanka', len: [9, 9], start: /^7/, startText: '7', example: '71 234 5678' },
};
const ANY = { len: [7, 12] };

/** Problem with a national number for a dialling code, or '' when it fits */
function nationalProblem(code, national) {
    const r = MOBILE_RULES[code] || ANY, n = String(national || '');
    const [min, max] = r.len;
    const digits = min === max ? `${min} digits` : `${min} to ${max} digits`;
    const where = r.name ? `${r.name} mobile numbers` : 'Mobile numbers';
    if (!/^\d+$/.test(n) || n.length < min || n.length > max || (r.start && !r.start.test(n))) {
        return r.local ? `${where} have 11 digits starting with 03 (e.g. ${r.example}).`
            : `${where} have ${digits} after +${code}${r.startText ? `, starting with ${r.startText}` : ''}${r.example ? ` (e.g. ${r.example})` : ''}.`;
    }
    return '';
}

/**
 * A saved mobile ("03001234567", "+923001234567", "+971501234567"): '' when it fits its country's rule, else what is
 * wrong. Empty is fine (the field is optional).
 */
function mobileProblem(value) {
    const v = String(value || '').trim();
    if (!v) return '';
    if (!v.startsWith('+')) {
        const d = v.replace(/\D/g, '');
        return /^03\d{9}$/.test(d) ? '' : nationalProblem(92, d.replace(/^0/, ''));
    }
    const d = v.slice(1).replace(/\D/g, '');
    const code = Object.keys(MOBILE_RULES).filter(c => d.startsWith(c)).sort((a, b) => b.length - a.length)[0];
    if (code) return nationalProblem(code, d.slice(code.length));
    return d.length >= 8 && d.length <= 15 ? '' : 'An international number has 8 to 15 digits including the country code.';
}

module.exports = { MOBILE_RULES, mobileProblem, nationalProblem };
