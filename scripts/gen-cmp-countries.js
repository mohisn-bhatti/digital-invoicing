// Builds public/cmp-countries.js, the country table of the Compliance & Deadlines module: for every country its dialling code, its
// usual currency and its time zone(s). Run by hand when the table needs a refresh (node scripts/gen-cmp-countries.js > public/cmp-countries.js);
// the output is committed, so nothing here runs on the server.
//   time zones: the system's tz database (/usr/share/zoneinfo/zone.tab), in its own order (the main zone of a country first)
//   dialling codes: the same list as the phone boxes of the app (DIAL_CODES in public/app.html)
//   currencies: typed below (ISO 4217)
const fs = require('fs');

const DIAL = 'AF93 AL355 DZ213 AS1684 AD376 AO244 AI1264 AG1268 AR54 AM374 AW297 AU61 AT43 AZ994 BS1242 BH973 BD880 BB1246 BY375 BE32 BZ501 BJ229 BM1441 BT975 BO591 BA387 BW267 BR55 VG1284 BN673 BG359 BF226 BI257 KH855 CM237 CA1 CV238 KY1345 CF236 TD235 CL56 CN86 CO57 KM269 CG242 CD243 CK682 CR506 CI225 HR385 CU53 CW599 CY357 CZ420 DK45 DJ253 DM1767 DO1809 EC593 EG20 SV503 GQ240 ER291 EE372 SZ268 ET251 FK500 FO298 FJ679 FI358 FR33 GF594 PF689 GA241 GM220 GE995 DE49 GH233 GI350 GR30 GL299 GD1473 GP590 GU1671 GT502 GN224 GW245 GY592 HT509 HN504 HK852 HU36 IS354 IN91 ID62 IR98 IQ964 IE353 IL972 IT39 JM1876 JP81 JO962 KZ7 KE254 KI686 XK383 KW965 KG996 LA856 LV371 LB961 LS266 LR231 LY218 LI423 LT370 LU352 MO853 MG261 MW265 MY60 MV960 ML223 MT356 MH692 MQ596 MR222 MU230 YT262 MX52 FM691 MD373 MC377 MN976 ME382 MS1664 MA212 MZ258 MM95 NA264 NR674 NP977 NL31 NC687 NZ64 NI505 NE227 NG234 NU683 KP850 MK389 MP1670 NO47 OM968 PK92 PW680 PS970 PA507 PG675 PY595 PE51 PH63 PL48 PT351 PR1787 QA974 RE262 RO40 RU7 RW250 KN1869 LC1758 VC1784 WS685 SM378 ST239 SA966 SN221 RS381 SC248 SL232 SG65 SX1721 SK421 SI386 SB677 SO252 ZA27 KR82 SS211 ES34 LK94 SD249 SR597 SE46 CH41 SY963 TW886 TJ992 TZ255 TH66 TL670 TG228 TO676 TT1868 TN216 TR90 TM993 TC1649 TV688 UG256 UA380 AE971 GB44 US1 UY598 UZ998 VU678 VE58 VN84 VI1340 YE967 ZM260 ZW263';

const CURRENCY = Object.fromEntries(('AF:AFN AL:ALL DZ:DZD AS:USD AD:EUR AO:AOA AI:XCD AG:XCD AR:ARS AM:AMD AW:AWG AU:AUD AT:EUR AZ:AZN BS:BSD BH:BHD BD:BDT BB:BBD BY:BYN ' +
    'BE:EUR BZ:BZD BJ:XOF BM:BMD BT:BTN BO:BOB BA:BAM BW:BWP BR:BRL VG:USD BN:BND BG:EUR BF:XOF BI:BIF KH:KHR CM:XAF CA:CAD CV:CVE KY:KYD CF:XAF TD:XAF ' +
    'CL:CLP CN:CNY CO:COP KM:KMF CG:XAF CD:CDF CK:NZD CR:CRC CI:XOF HR:EUR CU:CUP CW:XCG CY:EUR CZ:CZK DK:DKK DJ:DJF DM:XCD DO:DOP EC:USD EG:EGP SV:USD ' +
    'GQ:XAF ER:ERN EE:EUR SZ:SZL ET:ETB FK:FKP FO:DKK FJ:FJD FI:EUR FR:EUR GF:EUR PF:XPF GA:XAF GM:GMD GE:GEL DE:EUR GH:GHS GI:GIP GR:EUR GL:DKK GD:XCD ' +
    'GP:EUR GU:USD GT:GTQ GN:GNF GW:XOF GY:GYD HT:HTG HN:HNL HK:HKD HU:HUF IS:ISK IN:INR ID:IDR IR:IRR IQ:IQD IE:EUR IL:ILS IT:EUR JM:JMD JP:JPY JO:JOD ' +
    'KZ:KZT KE:KES KI:AUD XK:EUR KW:KWD KG:KGS LA:LAK LV:EUR LB:LBP LS:LSL LR:LRD LY:LYD LI:CHF LT:EUR LU:EUR MO:MOP MG:MGA MW:MWK MY:MYR MV:MVR ML:XOF ' +
    'MT:EUR MH:USD MQ:EUR MR:MRU MU:MUR YT:EUR MX:MXN FM:USD MD:MDL MC:EUR MN:MNT ME:EUR MS:XCD MA:MAD MZ:MZN MM:MMK NA:NAD NR:AUD NP:NPR NL:EUR NC:XPF ' +
    'NZ:NZD NI:NIO NE:XOF NG:NGN NU:NZD KP:KPW MK:MKD MP:USD NO:NOK OM:OMR PK:PKR PW:USD PS:ILS PA:USD PG:PGK PY:PYG PE:PEN PH:PHP PL:PLN PT:EUR PR:USD ' +
    'QA:QAR RE:EUR RO:RON RU:RUB RW:RWF KN:XCD LC:XCD VC:XCD WS:WST SM:EUR ST:STN SA:SAR SN:XOF RS:RSD SC:SCR SL:SLE SG:SGD SX:XCG SK:EUR SI:EUR SB:SBD ' +
    'SO:SOS ZA:ZAR KR:KRW SS:SSP ES:EUR LK:LKR SD:SDG SR:SRD SE:SEK CH:CHF SY:SYP TW:TWD TJ:TJS TZ:TZS TH:THB TL:USD TG:XOF TO:TOP TT:TTD TN:TND TR:TRY ' +
    'TM:TMT TC:USD TV:AUD UG:UGX UA:UAH AE:AED GB:GBP US:USD UY:UYU UZ:UZS VU:VUV VE:VES VN:VND VI:USD YE:YER ZM:ZMW ZW:ZWG').split(' ').map(p => p.split(':')));

// Countries the tz database files under another code
const ZONE_FALLBACK = { XK: ['Europe/Belgrade'] };

const zones = {};
for (const line of fs.readFileSync('/usr/share/zoneinfo/zone.tab', 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [cc, , tz] = line.split('\t');
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { continue; } // a name this Node does not know
    (zones[cc] = zones[cc] || []).push(tz);
}

const rows = DIAL.split(' ').map(x => {
    const cc = x.slice(0, 2), dial = x.slice(2), cur = CURRENCY[cc], tz = zones[cc] || ZONE_FALLBACK[cc];
    if (!cur) throw new Error('no currency for ' + cc);
    if (!tz) throw new Error('no time zone for ' + cc);
    return `${cc}|${dial}|${cur}|${tz.join(',')}`;
});

process.stdout.write(`/* Countries for the Compliance & Deadlines module: ISO code | dialling code | usual currency | time zones (the main one first).
   Made by scripts/gen-cmp-countries.js (do not edit by hand). Shared by the server (require) and the browser (window.CmpCountries).
   Names come from the browser's own list (Intl.DisplayNames) and the flags are the emoji made from the two letters. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CmpCountries = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const RAW = '${rows.join(';')}';
  // The currencies a firm's invoices usually need come first in the pickers; then every other one in the table, by name
  const TOP_CURRENCIES = ['AED', 'USD', 'EUR', 'GBP', 'SAR', 'QAR', 'OMR', 'KWD', 'BHD', 'PKR', 'INR', 'CAD', 'AUD', 'CHF', 'CNY', 'JPY', 'SGD', 'MYR', 'TRY', 'EGP'];
  const TOP_COUNTRIES = ['AE', 'PK', 'SA', 'QA', 'OM', 'KW', 'BH', 'GB', 'US', 'CA'];

  let regionNames = null, currencyNames = null;
  try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { /* an old browser: the codes are shown */ }
  try { currencyNames = new Intl.DisplayNames(['en'], { type: 'currency' }); } catch (e) { /* idem */ }

  const flag = cc => (/^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map(c => 0x1F1A5 + c.charCodeAt(0))) : '');
  const all = RAW.split(';').map(r => {
    const [code, dial, currency, zones] = r.split('|');
    return { code, dial, currency, zones: zones.split(','), name: (regionNames && regionNames.of(code)) || code, flag: flag(code) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const byCode = new Map(all.map(c => [c.code, c]));
  const list = [...TOP_COUNTRIES.map(c => byCode.get(c)), ...all.filter(c => !TOP_COUNTRIES.includes(c.code))];

  const get = code => byCode.get(String(code || '').toUpperCase()) || null;
  // "Asia/Dubai" → "Dubai"
  const zoneCity = tz => String(tz || '').split('/').pop().replace(/_/g, ' ');
  const zoneOk = tz => { if (!tz || typeof tz !== 'string' || tz.length > 64) return false; try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch (e) { return false; } };

  const currencyDecimals = code => { try { return new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits; } catch (e) { return 2; } };
  const currencyName = code => (currencyNames && currencyNames.of(code)) || code;
  const otherCurrencies = [...new Set(all.map(c => c.currency))].filter(c => !TOP_CURRENCIES.includes(c)).sort((a, b) => currencyName(a).localeCompare(currencyName(b)));
  const currencies = [...TOP_CURRENCIES, ...otherCurrencies].map(code => ({ code, name: currencyName(code), decimals: currencyDecimals(code) }));
  const currencyOk = code => currencies.some(c => c.code === code);

  return { list, get, flag, zoneCity, zoneOk, currencies, currencyOk, currencyDecimals, currencyName };
});
`);
