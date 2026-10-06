# Roadmap

_Last updated: 2026-10-07_ · summary: [GUIDE.md](GUIDE.md)

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
- Raseed landing page (`/`), contact page (`/contact`) with WhatsApp; enquiries → admin "Website enquiries" (spam honeypot,
  per-IP limit); app moved to `/app`. To do: buy domain (check raseed.pk at PKNIC), set CONTACT_* in .env, real screenshots.

**Before go-live set (done 2026-10-07)**
- Users and roles (Owner / Accountant / Cashier), change and reset password, forced change at first login
- Login lockout and IP limit, security headers, tokens revoked on password, role or status change
- A4 tax invoice print (with amount in words), next to the thermal receipt
- Encrypted backup and restore scripts, tested end-to-end against both the local DB and Supabase (docs/backups.md)
- Stock entries and the Annex-H1 stock statement

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

## Phase 2 — remaining
- **Buyer check.** Look up NTN status and registration type through FBR's STATL / Get_Reg_Type. Code can be written now;
  live testing needs the token.
- **FBR dropdowns** for sale type → rate and SRO schedule/items (SaleTypeToRate, SroSchedule, SROItem). Needs the token.

## Saved for later (needed before going live)
1. **Products import.** Upload products from Excel/CSV.

## Before go-live (deployment)
- ✅ Render test deploy is live at https://digital-invoicing.onrender.com (FBR_MOCK on) and uses the Supabase database.
- ✅ Supabase final push done: 13 migrations, HS codes loaded, test data cleaned out.
- An Oracle Cloud Always Free VM proxy for the static IP (docs/static-ip-proxy.md). The user needs to create the Oracle account.
- Vercel and a domain: later. Render serves everything for now.
- Backups: the scripts are ready but **not scheduled**. Turn them on before the first real client (docs/backups.md).
- Remove the brother's GitHub account from this Mac when it's no longer needed (`gh auth logout -u mohisn-bhatti`).

## Later phases
- **Stock:** CSV import of purchases; refund (Annex-H) specifics for exporters, once the CA confirms who needs them.
- **Subscription billing** for clients.
- **Offline POS** for retail counters. This is a separate, larger product.
