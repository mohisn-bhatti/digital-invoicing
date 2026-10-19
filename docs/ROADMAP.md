# Roadmap

_Last updated: 2026-10-19 (Point of Sale phase 2 built on branch `pos-phase2`, not deployed; access periods, plans and limits)_ · summary: [GUIDE.md](GUIDE.md)

## Done
**Phase 1: filing invoices with FBR**
- Multi-tenant login, FBR settings (token encrypted, STRN)
- Invoices sent to the DI API v1.12: validate, then post
- Tax engine with the CA's rules
- 80mm receipt with QR code and DI logo
- Sandbox scenarios SN001–SN028
- Static-IP proxy support
- Render, Vercel and Supabase configs

**Phase 2 (first part)**
- Duplicate protection: request id, submit lock, UNCERTAIN state, "Found in IRIS" and resubmit
- Saved products and buyers: pickers, forms, edit
- HS code search: PCT 2017 list, FBR sync, UOM per HS code
- Annex-C report (CSV)
- Debit notes (180 days, same buyer, value limits)
- Recording cancellations done in IRIS, with the 72-hour window
- End consumers: no further tax
- Go-live checklist for each client: Business Nature and Sector from IRIS → the assigned scenarios (spec §10), scenarios
  passed X/Y (mock-mode invoices don't count), production, first live invoice
- Super admin dashboard: go-live progress, this month's invoices and totals, invoices needing attention,
  last invoice, checklist per client, Annex-C download per client

**Phase 3 (started)**
- Background queue: automatic retries when FBR is down (30s, 2m, 10m, 30m, 2h); "Send now" and "Stop"
- Bulk invoice import from Excel/CSV: template, preview with errors, queued sending, progress per import, re-import safe
- Audit log: append-only (database trigger), client and admin views, filters, CSV export

**Website**
- ETAX landing page (`/`), contact page (`/contact`) with WhatsApp; enquiries → admin "Website enquiries" (spam honeypot,
  per-IP limit); app moved to `/app`. To do: buy domain (check etax.pk at PKNIC), set CONTACT_* in .env, real screenshots.

**Before go-live set (done 2026-10-07)**
- Users and roles (Owner / Accountant / Cashier), change and reset password, forced change at first login
- Login lockout and IP limit, security headers, tokens revoked on password, role or status change
- A4 tax invoice print (with amount in words), next to the thermal receipt
- Encrypted backup and restore scripts, tested end-to-end against both the local DB and Supabase (docs/backups.md)
- Stock entries and the Annex-H1 stock statement

**CA feedback, Phase 1 sheet (done 2026-10-07)**
- Admin FBR settings in three groups: must match IRIS / received from FBR / entered in ETAX. STRN first,
  "(Sent to FBR)" in red, invoice number format explained as a note, "Check registration with FBR" for the seller
- Tax Rules (admin): HS code → sale type, rate and SRO reference from the CA's Document 1 (50 starting rules,
  longest prefix wins, standard 18% otherwise). The invoice form fills them in when an HS code is chosen and shows why
- HS code box lists the codes the client already invoiced (with last sale type / rate / UOM) before the HS list
- Invoice drafts (no invoice number used until filed); "Add new customer" at the top of the invoice
- Left menu shows modules only; New invoice, Drafts and Bulk import are tabs inside Sales Invoices
- Invoice form headings follow FBR's Annex-C; each item has an Item box and a "More" box (SRO, extra / further tax)
- Amount boxes start empty (no 0 to delete); whole-number quantity for counted units (pieces, dozen, …), decimals for KG etc.
- Suggestion-list boxes (UOM, rate, SRO) always show their arrow

**Website pricing (done 2026-10-19)**
- Pricing section on the landing page: Starter / Pro / Enterprise, annual only at 50% off, the same prices for FBR Digital Invoicing
  and PRA Point of Sale, feature table by plan (every feature a plan includes is shown with a tick); PRA features added; plan
  chosen on the site is carried into the contact form (data in `public/plans.js`)
- Change-password dialog: one new password (with the eye to see it), no "repeat" box

**Admin console (done 2026-10-19)**
- Access period per client: integration date, months or years allowed, countdown, grace (3 days monthly, 7 days yearly),
  automatic switch-off, renew; shown in the Clients list and on the dashboard
- Plan per client (Starter / Pro / Enterprise, or none), chosen when registering or under Manage → Overview, shown in the Clients
  list with a filter. **The plan's limits are enforced**: branches, terminals (counters), products and users are checked when
  something is added or switched back on, with a clear message, a usage panel for the administrator and one-line notes for the
  client; lowering a plan never removes anything; no plan = no limits (`src/limits.js`, `public/plans.js`)
- Clients list: filters (search, status, access period, product, plan, FBR environment) and sorting
- Manage client in tabs (Overview · Digital Invoicing · Point of Sale · Users); a client without Digital Invoicing never sees FBR
  settings, and the dashboard counts FBR figures for FBR clients only

**Point of Sale, phase 2 (built 2026-10-19 on branch `pos-phase2`, tested locally, not pushed or deployed)**
- Saved customers (Customers menu, found on the sale screen); a sale keeps its own copy of the buyer's details
- Scanning: item barcodes, a barcode scanner or the camera adds an item with the price and tax rate it is set to; a receipt's QR
  opens the sale; QR labels to print; the server answers `GET /api/pos/lookup`
- Reports with filters: daily closing (day-end sheet, a cashier sees only their own), sales analysis by twelve groupings, tax
  summary; filters on the sales list; spreadsheets; Pakistan calendar days
- Defaults and receipt settings (how a sale starts, 58 or 80 mm paper, header, cashier on or off, what a new item starts with) and
  a quick-rate list for the usual kinds of business
- Migrations `0044` and `0045` only add; to go live they need the safe production procedure (fingerprint, rehearsal, no seed), and
  the category backfill of `0044` run once more after the new code is live (see POS_MODULE.md, "Putting phase 2 on production")

## Waiting on others
- **PRAL / IRIS:** sandbox token, assigned scenarios, IP whitelisting. Then run every scenario, then get the production token.
- **CA answers** (list sent 2026-10-06):
  1. Is the 72-hour window right? Does it count from the filing time or the invoice date?
  2. The debit-note reason list, exactly as written in IRIS
  3. Is a debit note only for reductions? Is a credit note needed?
  4. Which Business Nature / Sector was chosen in IRIS? This decides the scenarios.
  5. For a walk-in buyer: send a blank NTN or 9999999997777 (VARIOUS)?
  6. How to tell an end consumer from an unregistered business
  7. SRO schedule / item serial numbers for common exempt items
  8. Which buyers have ST withheld at source?
  9. Services: how provincial sales tax works, and which rates
  10. The first clients: how many, what type, how many invoices a day
  11. Who needs Annex-H1 (stock statement)?
  12. What must a printed invoice show?
  13. Is there a newer PCT / HS code list?
  14. Do branches in different provinces need handling?
- **CA, from the feedback sheet:**
  1. Tax Rules: left out because the heading is too broad or conditional — 2106 (syrups), 9018 (diagnostic kits),
     electric vehicles (8702/8704/8711), hybrid vehicles. Which exact tariff lines should be added?
  2. Further tax on petroleum fuels (SRO 648 serial 3) and utilities: which sale types / HS codes are exempt?
  3. "Quantity should be a round number": whole numbers are now enforced only for counted units (pieces, dozen, pair…).
     Is that right, or should KG / litre also be whole numbers?
  4. Auto-filling seller details from IRIS isn't possible (IRIS has a captcha and FBR's API gives no name/address).
     FBR's API only confirms registered / active — is that enough?
  5. A Purchase Invoice module: is it needed (purchases are recorded under Stock today)?

## Phase 2 — remaining
- **Buyer check.** Look up NTN status and registration type through FBR's STATL / Get_Reg_Type. Code can be written now;
  live testing needs the token.
- **FBR dropdowns** for sale type → rate and SRO schedule/items (SaleTypeToRate, SroSchedule, SROItem). Needs the token.

## Saved for later (needed before going live)
1. **Products import.** Upload products from Excel/CSV.
2. **The accounts side of a trading POS:** Receive Cash, Purchase Invoice, Pay Cash to Vendor (vendors, purchases, payments, a cash
   book). Not in the SRS: the owner decides; the CA's answers on credit sales and withholding are needed first.
3. **The Digital Invoicing 80 mm receipt:** its print page size `80mm auto` is ignored by Chrome (the POS receipt no longer asks for
   one). Sizing the page to the receipt needs a thermal printer to try.

## Before go-live (deployment)
- ✅ Render test deploy is live at https://digital-invoicing.onrender.com (FBR_MOCK on) and uses the Supabase database.
- ✅ Supabase final push done: 13 migrations, HS codes loaded, test data cleaned out.
- An Oracle Cloud Always Free VM proxy for the static IP (docs/static-ip-proxy.md). The user needs to create the Oracle account.
- ✅ 2026-10-19: the Point of Sale, access periods, plans and the new website are on production (Render, merge `d9711e8`). Migrations
  `0038`–`0043` were applied to Supabase first, without the seed (the seed resets the admin's password), then the code was pushed. They
  only add tables and columns; every existing table was fingerprinted before and after and came out identical. Point of Sale runs in
  test mode there (`PRA_MOCK` is not set, so nothing is sent to PRA).
- Vercel and a domain: later. Render serves everything for now.
- Backups: the scripts are ready but **not scheduled**. Turn them on before the first real client (docs/backups.md).
- Remove the brother's GitHub account from this Mac when it's no longer needed (`gh auth logout -u mohisn-bhatti`).

## Later phases
- **Point of Sale (PRA)** (a second product; a client with more than one picks at login): a cashier screen for restaurants,
  banquet halls and other Punjab service businesses, every sale sent to PRA's eIMS. Built, independently reviewed and tested in
  test mode on branch `pos-module` (sales, credit notes, reports and CSV, receipts, roles, the PRA-unreachable rules; on production
  since 2026-10-19), with phase 2 (customers, scanning, reports, defaults) on `pos-phase2`; still to do:
  a run against PRA's sandbox and PRA's answers (discount reading, product catalogue, mixed payments), an outage procedure, going
  live. See [POS_MODULE.md](POS_MODULE.md) and [POS_COMPLIANCE.md](POS_COMPLIANCE.md).
- **Stock:** CSV import of purchases; refund (Annex-H) specifics for exporters, once the CA confirms who needs them.
- **Subscription billing** for clients.
- **Offline POS** for retail counters. This is a separate, larger product.
