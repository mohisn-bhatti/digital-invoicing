// The products a client can use on this platform. The administrator switches them on for each client (Manage client →
// Modules); a user whose client has more than one picks which to open after logging in.
const MODULES = [
    { id: 'INVOICING', label: 'FBR Digital Invoicing', blurb: 'File sale invoices with FBR, debit notes, Annex-C report, stock statement.' },
    { id: 'TRADING', label: 'Trading & Accounts', blurb: 'Sale and purchase invoices, stock, customers and vendors, cash and bank, account statements.' },
];
const MODULE_IDS = MODULES.map(m => m.id);
const DEFAULT_MODULES = ['INVOICING'];

// Only known modules, no repeats, always in the order above
const cleanModules = list => MODULE_IDS.filter(id => (Array.isArray(list) ? list : []).map(String).includes(id));

// What a client has switched on (older rows and the administrator have none stored: invoicing)
const tenantModules = tenant => (tenant && tenant.modules && tenant.modules.length ? cleanModules(tenant.modules) : DEFAULT_MODULES);

module.exports = { MODULES, MODULE_IDS, DEFAULT_MODULES, cleanModules, tenantModules };
