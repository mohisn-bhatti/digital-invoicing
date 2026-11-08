/* What a user may do in the Compliance & Deadlines module (SRS section 2). The ETAX administrator ticks these for each user under
   Manage → Users; the firm itself cannot change them (src/compliance/routes.js checks them on every request, the screens only hide
   what cannot be used). Shared by the server (require) and the browser (window.CmpPerms). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CmpPerms = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // In the order the SRS lists them; SECRETS is ours (the SRS says "at minimum"): seeing a client's portal password is kept apart
  const PERMS = [
    { id: 'VIEW', label: 'View clients and obligations' },
    { id: 'CLIENT_EDIT', label: 'Create and edit clients' },
    { id: 'OBLIGATION_EDIT', label: 'Create and edit obligations and reminders' },
    { id: 'WHATSAPP', label: 'Send WhatsApp messages' },
    { id: 'INVOICE', label: 'Issue invoices and generate receipts' },
    { id: 'COMPLETE', label: 'Change the status of obligations, mark them complete or closed' },
    { id: 'SETUP', label: 'Manage message templates and custom fields' },
    { id: 'REPORTS', label: 'View the notifications dashboard and reports' },
    { id: 'LOGS', label: 'View and export the WhatsApp log and the activity log' },
    { id: 'EXPORT', label: 'Export data' },
    { id: 'ARCHIVE', label: 'Archive and restore clients and obligations' },
    { id: 'SECRETS', label: 'See portal passwords and PIN codes' },
    { id: 'FULL', label: 'Full access (administrator): everything, including the module settings' },
  ];
  const IDS = PERMS.map(p => p.id);
  const ALL = IDS.filter(id => id !== 'FULL');

  // Starting points for the checkboxes (the administrator can still tick or untick each one)
  const PRESETS = [
    { id: 'full', label: 'Full access', perms: ['FULL'] },
    { id: 'preparer', label: 'Preparer', perms: ['VIEW', 'CLIENT_EDIT', 'OBLIGATION_EDIT', 'WHATSAPP', 'COMPLETE', 'REPORTS', 'SECRETS'] },
    { id: 'billing', label: 'Billing', perms: ['VIEW', 'WHATSAPP', 'INVOICE', 'REPORTS'] },
    { id: 'viewer', label: 'Viewer', perms: ['VIEW'] },
    { id: 'none', label: 'No access', perms: [] },
  ];

  // What may be stored: known ids only, no repeats, in the order above. Full access is kept alone (it already means everything).
  function clean(list) {
    const given = new Set((Array.isArray(list) ? list : []).map(String));
    if (given.has('FULL')) return ['FULL'];
    return IDS.filter(id => given.has(id));
  }
  // What a stored list allows: full access = all of them; any permission at all includes seeing the clients (VIEW)
  function effective(list) {
    const stored = clean(list);
    if (stored.includes('FULL')) return new Set(IDS);
    const s = new Set(stored);
    if (s.size) s.add('VIEW');
    return s;
  }
  const has = (list, ...anyOf) => { const e = list instanceof Set ? list : effective(list); return anyOf.some(p => e.has(p)); };
  const label = id => (PERMS.find(p => p.id === id) || { label: id }).label;
  // A short line for a list of users: "Full access", "No access", the preset's name, or "5 permissions"
  function summary(list) {
    const stored = clean(list);
    if (!stored.length) return 'No access';
    const preset = PRESETS.find(p => p.perms.length === stored.length && p.perms.every(x => stored.includes(x)));
    if (preset) return preset.label;
    return `${stored.length} permission${stored.length === 1 ? '' : 's'}`;
  }

  return { PERMS, IDS, ALL, PRESETS, clean, effective, has, label, summary };
});
