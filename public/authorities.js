'use strict';
/* Tax authorities and other bodies the app works with: their names, and their logos where an official logo file has been put in /authorities/.
   Until a logo file is there (or if it cannot be loaded) a plain badge with the authority's short name is shown instead, so a missing file is
   never a broken picture. A logo is shown as the authority publishes it, with its name beside it. Loaded by the app and by the website. */
const Authorities = (() => {
  // inUse: the app connects to it today. The others are listed so their logo can be dropped in the day they are used: they are shown nowhere else.
  const LIST = [
    { id: 'FBR', name: 'Federal Board of Revenue', inUse: true },
    { id: 'PRA', name: 'Punjab Revenue Authority', inUse: true },
    { id: 'SRB', name: 'Sindh Revenue Board', inUse: false },
    { id: 'KPRA', name: 'Khyber Pakhtunkhwa Revenue Authority', inUse: false },
    { id: 'BRA', name: 'Balochistan Revenue Authority', inUse: false },
    { id: 'PSW', name: 'Pakistan Single Window', inUse: false },
    { id: 'SECP', name: 'Securities and Exchange Commission of Pakistan', inUse: false },
    { id: 'EOBI', name: "Employees' Old-Age Benefits Institution", inUse: false },
    { id: 'ESSI', name: "Employees' Social Security Institution", inUse: false },
  ];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const missing = new Set(); // logos that did not load: not asked for again in this page
  const byId = id => LIST.find(a => a.id === String(id || '').toUpperCase()) || null;
  const logoUrl = id => `/authorities/${String(id).toLowerCase()}.png`;
  const SIZES = { sm: ['h-7 min-w-[1.75rem] text-[10px]', 'h-7'], md: ['h-10 min-w-[2.5rem] text-xs', 'h-10'], lg: ['h-14 min-w-[3.5rem] text-sm', 'h-14'] };
  // the plain badge: the short name on a neutral tile (no colours or shapes borrowed from anyone's logo)
  const tile = (a, size) => `<span class="inline-flex items-center justify-center rounded-lg bg-slate-800 px-2 font-bold tracking-wide text-white ${SIZES[size][0]}" aria-hidden="true">${esc(a.id)}</span>`;
  // html for an authority: its logo (or the plain badge) and, unless name is false, its full name. size: sm, md or lg
  function badge(id, { size = 'md', name = true } = {}) {
    const a = byId(id); if (!a) return '';
    if (!SIZES[size]) size = 'md';
    const mark = missing.has(a.id)
      ? tile(a, size)
      : `<img src="${logoUrl(a.id)}" alt="" class="${SIZES[size][1]} w-auto max-w-[7rem] object-contain" data-authority="${esc(a.id)}" data-size="${size}" onerror="Authorities.noLogo(this)">`;
    return `<span class="inline-flex items-center gap-2 align-middle">${mark}${name ? `<span class="leading-tight"><span class="block font-medium">${esc(a.name)}</span></span>` : `<span class="sr-only">${esc(a.name)}</span>`}</span>`;
  }
  // an image that would not load becomes the plain badge, and the authority is remembered as having no logo file
  function noLogo(img) {
    const a = byId(img && img.dataset && img.dataset.authority); if (!a) return;
    missing.add(a.id);
    const holder = document.createElement('span'); holder.innerHTML = tile(a, SIZES[img.dataset.size] ? img.dataset.size : 'md');
    img.replaceWith(holder.firstElementChild);
  }
  // Everything on a page that asks for a badge: <span data-authority-badge="PRA" data-size="sm"></span>
  function fill(root = document) {
    root.querySelectorAll('[data-authority-badge]').forEach(el => { el.innerHTML = badge(el.dataset.authorityBadge, { size: el.dataset.size || 'md', name: el.dataset.name !== 'false' }); });
  }
  return { LIST, byId, badge, noLogo, fill, logoUrl, missing };
})();
