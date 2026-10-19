// The products a client can use on this platform. The administrator switches them on for each client (Manage client →
// Modules); a user whose client has more than one picks which to open after logging in.
const MODULES = [
    { id: 'INVOICING', label: 'FBR Digital Invoicing', blurb: 'File sale invoices with FBR, debit notes, Annex-C report, stock statement.' },
    { id: 'POS', label: 'Point of Sale (PRA)', blurb: 'A cashier screen for restaurants, banquet halls and other Punjab service businesses: every sale is sent to PRA and printed with its fiscal number and QR code.' },
];
const MODULE_IDS = MODULES.map(m => m.id);
const DEFAULT_MODULES = ['INVOICING'];

// Only known modules, no repeats, always in the order above
const cleanModules = list => MODULE_IDS.filter(id => (Array.isArray(list) ? list : []).map(String).includes(id));

// What a client has switched on. A row with nothing usable stored (older rows, the administrator, ids that no longer exist) gets invoicing.
const tenantModules = tenant => {
    const list = cleanModules(tenant && tenant.modules);
    return list.length ? list : DEFAULT_MODULES;
};

module.exports = { MODULES, MODULE_IDS, DEFAULT_MODULES, cleanModules, tenantModules };
