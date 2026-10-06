# Raseed — FBR Digital Invoicing

Website: `/` landing page, `/contact` contact form (enquiries appear for the super admin under *Website enquiries*), `/app` the application.
Set `CONTACT_WHATSAPP`, `CONTACT_PHONE`, `CONTACT_EMAIL`, `CONTACT_CITY` in `.env` to show contact details (empty = hidden).

Multi-tenant web app that files invoices with FBR through the **PRAL Digital Invoicing (DI) API v1.12**
(spec: [docs/FBR-DI-API-Technical-Spec-v1.12.pdf](docs/FBR-DI-API-Technical-Spec-v1.12.pdf)).
Flow per invoice: calculate tax → save → `validateinvoicedata` → `postinvoicedata` → store the FBR invoice number → print receipt with QR.

## Setup
```bash
npm install
cp .env.example .env
npm run gen:keys            # paste JWT_SECRET and ENCRYPTION_KEY into .env
npm run db:local            # local Postgres in Docker (localhost:54329) — development uses this
npm run db:deploy           # create tables from prisma/migrations
npm run seed                # super admin + first tenant user + HS codes
npm run dev                 # http://localhost:3000 (website) · http://localhost:3000/app (app)
npm test                    # tax engine + FBR response handling
```
Supabase is only updated when you decide: put its URLs in `SUPABASE_DATABASE_URL` / `SUPABASE_DIRECT_URL` and run
`npm run supabase:deploy` (migrations + seed).

Keep `FBR_MOCK=true` until the IP is whitelisted; invoices get a fake FBR number so you can test the UI.

## Who does what
| Super admin (CA firm) | Client |
|---|---|
| Create clients; per client **Manage**: FBR settings (NTN, STRN, token, environment, business nature/sector, further tax %), HS sync | New invoices, receipts, retry / debit note / mark cancelled / "found in IRIS" |
| Go-live checklist; **sandbox scenario tests via "Open workspace"** (works inside the client screen; logged under the admin) | Bulk import (Excel/CSV) |
| Annex-C report per client; activity log for all clients | Saved products & buyers |

Clients can't change FBR settings or see the activity log, checklist or Annex-C. While a client is in **Sandbox** the
client can't file invoices (the screen says it is being tested); invoicing opens when the admin switches it to Production.

## Going live (per tenant/NTN)
1. **IRIS → Digital Invoicing → API Integration → PRAL.** Business Nature + Sector decide which sandbox scenarios you must pass (spec §10).
2. **IP whitelisting** (max 3 IPs): your dev machine's public IP, and the static proxy IP (see [docs/static-ip-proxy.md](docs/static-ip-proxy.md)). Approval ≈ 2 working hours.
3. Super admin → client → **Manage** → FBR settings: sandbox token (environment = Sandbox), seller NTN, name, province, address, business nature + sector.
4. Set `FBR_MOCK=false`. **Open workspace**, and for each assigned scenario (see the checklist) pick it in the **Sandbox scenario** dropdown and submit a matching invoice.
5. When IRIS issues the **production token**, save it in Manage and switch the environment to **Production** — the client can now invoice.

## Invoice statuses & duplicate protection
| Status | Meaning | What you can do |
|---|---|---|
| SUBMITTED | Filed; FBR invoice number received | Receipt |
| FAILED | FBR definitely did **not** record it (validation error, rejected token, nothing sent) | Retry |
| UNCERTAIN | Connection broke **after** sending — FBR may have it | Check IRIS → "Found in IRIS" (enter its number) or "Not in IRIS — resubmit" |
| QUEUED | Waiting for the background sender: FBR was unreachable (auto-retry after 30s, 2m, 10m, 30m, 2h, then FAILED) or from a bulk import | "Send now", or "Stop" |
| SUBMITTING | Being sent right now (acts as a lock) | Wait; shows as UNCERTAIN if stuck > 3 min |
| CANCELLED | Was filed, then cancelled **in IRIS** and recorded here | Left out of reports |

Each invoice form carries a `clientRequestId`; resending the same form (double-click, network retry) returns the
existing invoice instead of filing again. Only one submission per invoice can run at a time.
Test the failure screens with `FBR_MOCK=true FBR_MOCK_RESULT=invalid` or `FBR_MOCK_RESULT=uncertain`.

## Bulk import (Excel / CSV)
*Bulk import* → **Download template** → fill one row per item (rows with the same *Invoice Ref* form one invoice) →
choose the file → preview shows every invoice as Ready / Error (with the reason) / Already imported → **Send to FBR**.
Valid invoices are queued and filed one by one in the background; *Recent imports* shows progress.
- Up to 1,000 invoices / 5,000 rows per file. Dates: YYYY-MM-DD, DD-MM-YYYY, 31-Aug-2025 or Excel dates.
- Buyer Type: Registered / Unregistered / End consumer. Rate: 18, 18% or 0.18.
- The same file (same Invoice Ref + date) imported twice is never filed twice.
- On Render free the background sender pauses while the service sleeps and continues on the next visit.

## Users, roles & login security
- Each client has users with a role:
  - **Owner:** everything, plus managing users.
  - **Accountant:** invoices, debit notes, "cancelled in IRIS", import, products, buyers and stock.
  - **Cashier:** creates and prints invoices only.
- Owners manage their staff on the *Users* page. The super admin manages any client's users under *Clients → Manage*.
- New users and reset passwords must be changed at the next login. Changing a password, changing a role or disabling a
  user signs that user out everywhere (tokens carry a version that is checked on every request).
- After 5 wrong passwords an account locks for 15 minutes (an admin or owner reset unlocks it). One connection may fail
  20 times per 15 minutes. Security headers are sent on every response.

## Printing: thermal or A4
The invoice popup switches between an **80mm thermal receipt** and an **A4 tax invoice**. The A4 version has a
letterhead, a buyer block, an item table with HS codes, totals, the amount in words (lakh/crore), the FBR number, the
QR code and logo, "Integrated with FBR" and a signature line. The chosen format is remembered on each device.

## Stock & Annex-H1
On the *Stock* page (Owner/Accountant) record opening balances, local purchases, imports (GD) and adjustments.
Sales come automatically from invoices filed with FBR: taxable, exempt and zero-rated are counted separately, and debit
notes count as returns. *Reports → Annex-H1* (super admin) gives the HS-code-wise stock statement for a month:
opening → purchased → adjustments → supplies → closing, with a CSV download. Quantities are exact. Supplies are valued
at sale value, and opening/closing stock at weighted average cost. **Confirm this valuation with the CA.**

## Backups
`npm run backup` writes an encrypted dump of Supabase. See [docs/backups.md](docs/backups.md) for restore checks and
daily scheduling.

## Activity log (audit)
Every important action is recorded with user, IP and time:
- logins, including failed ones
- settings changes (before → after; the FBR token itself is never logged)
- each invoice: created, filed, queued, failed, uncertain, retried, resolved, cancelled, stopped
- imports, products and buyers, Annex-C downloads, new clients

Background-sender actions show as `system`. Clients see their own log, and the super admin sees everyone's. Both can filter,
search and download a CSV. The `AuditLog` table is **append-only**: a database trigger rejects UPDATE, DELETE and TRUNCATE,
so entries can't be changed through the app or through SQL.

## Debit notes & cancellation
- **Debit note:** in *Recent invoices*, "Debit note" on a filed sale invoice prefills the form (reference no., buyer, items).
  Choose a reason, change quantities/values to the adjusted amount, submit. Checked before sending (when the original was
  filed from this app): same buyer, date not before the original and within **180 days**, and all debit notes together not
  more than the original's value or sales tax. The `reason` / `reasonRemarks` payload field names are not in the v1.12
  sample JSON — confirm in sandbox.
- **Cancel:** the DI API has no cancel/edit call; do it in IRIS, then "Mark cancelled in IRIS" here. Within
  **72 hours** of filing (STGO 1 of 2026 — confirm with the CA; `IRIS_EDIT_WINDOW_HOURS` in server.js) a note is optional;
  after that, a Commissioner approval reference is required. Invoices with debit notes can't be cancelled.

## Annex-C report
*Annex-C report* → pick month + environment → **Show** (totals + first 50 lines) or **Download Excel (CSV)**: one row per
item of every invoice filed with FBR, same columns as the IRIS Annex-C, for reconciling with the sales tax return.

## Saved products & buyers
- **Products:** in an item row, "★ Save as product" stores name, HS code, UOM, rate, sale type, price, SRO. Typing in
  *Description* then offers saved products and fills the whole row.
- **Buyers:** buyers with an NTN/CNIC are saved automatically when an invoice is filed; typing a buyer name or NTN offers them.
- Manage both under *Saved products & buyers* at the bottom of the page.

## HS codes
The item form searches HS/PCT codes by code or words (e.g. `laptop`, `0101`).
- Starts with **7,484 codes** from the PCT First Schedule (Nov 2017 PDF) → [data/hs-codes-pct-2017.json](data/hs-codes-pct-2017.json), loaded by `npm run seed`.
- That list is old; FBR only accepts codes in **its current list**. Once a PRAL token works, *FBR settings → Sync HS codes from FBR*
  (also runs automatically when a token is saved) loads FBR's live `itemdesccode` list. FBR codes are shown first and are never
  overwritten by the PCT import.
- Picking a code also asks FBR (`HS_UOM`) which units are valid for it and sets the UOM — a wrong UOM is a common FBR rejection.
- To rebuild from a newer PDF: [scripts/pct-pdf-to-json.js](scripts/pct-pdf-to-json.js).

## Printing
Receipts are 80mm with a 1×1 inch QR (v2, 25×25) of the FBR invoice number, per spec §6.
The official **FBR Digital Invoicing System logo** is included as `public/fbr-di-logo.jpg`, taken from the DI API v1.12 spec §6 (page 35). It prints next to the QR.

## Deployment (Supabase + Render + Vercel, free plans)
```
Browser ──► Vercel (public/ static)  ──/api/* rewrite──►  Render (Express API) ──► Supabase Postgres
                                                              │
                                                              └─► static-IP proxy ──► gw.fbr.gov.pk
```
1. **Supabase** → Project → Connect: copy the **Transaction pooler** URL (port 6543, add `?pgbouncer=true`) into `DATABASE_URL`
   and the **Session pooler** URL (port 5432) into `DIRECT_URL`. (The "direct" host is IPv6-only; Render needs the pooler.)
2. **Seed once from your machine** (Render free has no Shell): put the Supabase URLs in your local `.env`, then
   `npm run db:deploy && npm run seed`.
3. **GitHub**: push this folder to a private repo.
4. **Render** → New → Blueprint → the repo. It reads [render.yaml](render.yaml) (`plan: free`); fill the `sync: false` env vars.
   Use the **same `ENCRYPTION_KEY`** as your local `.env`. Migrations run in the build step.
5. **Vercel** → New Project → the repo, root directory as-is. [vercel.json](vercel.json) serves `public/` and forwards `/api/*`
   to Render — edit the `destination` if your Render URL differs from `raseed.onrender.com`.
6. **Static IP for FBR** — Render's outbound IPs are shared and change. Free option: an Oracle Cloud Always Free VM proxy,
   see [docs/static-ip-proxy.md](docs/static-ip-proxy.md). Then super admin → **Check** "IP for FBR whitelisting" → put it in IRIS.

### Free-plan limits to know
- **Render free** sleeps after 15 idle minutes; the first request takes up to ~1 minute (the page shows a "server is starting"
  bar and waits). 750 free hours/month is enough for one service running all month. To avoid morning cold starts, an external
  pinger (e.g. cron-job.org, free) can hit `https://<render-url>/healthz` every 10 minutes during shop hours.
- **Vercel Hobby** is for non-commercial use only. Fine while testing; once clients pay you, move to Vercel Pro or serve the
  frontend from Render itself (the Express app already serves `public/`, so just use the Render URL).
- **Supabase free** pauses a project after a week with no activity, has 500 MB storage and no automatic backups.
  FBR requires keeping invoice records for 6 years, so take your own regular backups (`pg_dump` with `DIRECT_URL`).

Every change to `prisma/schema.prisma` needs a migration: `npm run db:migrate -- --name what_changed`, commit the new folder.

## Tax rules (confirmed by the CA, 2026-10-06)
See [src/tax.js](src/tax.js):
- `valueSalesExcludingST = qty × unit price − discount`
- Sales tax = rate% of that value, or of the retail/notified value when "Retail value, line total (3rd sch.)" is filled (total for the line, as in Annex-C "Fixed / notified value")
- Further tax = tenant's rate (default 4%) on **unregistered business** buyers only — not on sales to **end consumers / walk-in**
  ("End consumer" tick under Buyer type, on by default), and not on exempt / zero-rated / 3rd schedule
- Any line's sales tax or further tax can be overridden in "More" for special sale types
