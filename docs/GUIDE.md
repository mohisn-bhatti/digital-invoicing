# Raseed — complete guide

_Last updated: 2026-10-07_

Raseed is a multi-tenant FBR Digital Invoicing app. A CA firm (the **admin**) onboards its clients. Each client
(a **tenant**, one NTN) issues invoices, and Raseed sends them to FBR through the PRAL DI API v1.12. The receipt or
A4 tax invoice then carries the FBR invoice number and QR code.

This page covers where things stand, how to use the app, and what is left. The finer details are in
[README.md](../README.md) and the other files in this folder.

---

## 1. Where things stand

| Part | Status |
|---|---|
| Code (all of phase 1, most of phases 2–3) | ✅ Done, tested, pushed to GitHub |
| Live test site | ✅ https://digital-invoicing.onrender.com (Render free) |
| Database | ✅ Supabase (13 migrations, 7,484 HS codes, 1 admin + 1 client, no invoices) |
| FBR connection | ⏳ **Mock mode.** Nothing goes to FBR yet: invoice numbers are fake |
| PRAL sandbox token | ⏳ Requested in IRIS on 2026-10-06, waiting |
| Static IP for FBR whitelisting | ⏳ Oracle proxy not created yet |
| Domain / Vercel front | ⏳ Later (Render serves everything for now) |
| Backups | ⏸ Script is ready; **not running** until we decide to turn it on |

**The live site right now is for testing only.** Any invoice made there gets a fake FBR number, so test freely.
Don't give it to real clients yet.

---

## 2. Using the app

Open https://digital-invoicing.onrender.com/app. On the free plan the site sleeps after 15 minutes without visitors,
so the first page can take about a minute to load.

### Admin (the CA firm)
| Menu | What it does |
|---|---|
| Dashboard | Go-live progress for every client, this month's invoices and totals, invoices that need attention |
| Clients | Add a client (business details + its first login), open a client to manage it |
| Client page | FBR settings in three groups (must match IRIS · received from FBR · entered in Raseed), Business Nature / Sector → scenarios, go-live checklist, users |
| Workspace (inside a client) | "Enter" the client's account for 2 hours, e.g. to run sandbox scenarios on their behalf |
| Reports | Annex-C (sales) CSV and Annex-H1 (stock statement) per client and month |
| Activity | Audit log of every action. It can't be edited or deleted. CSV export |
| Enquiries | Messages sent from the website's contact form |
| System | HS code sync with FBR, server egress IP, client guideline buttons, FBR references (copied from fbr.gov.pk daily; "Refresh now") |

### Client (each NTN)
| Menu | What it does |
|---|---|
| Dashboard | Today / this month's totals, latest invoices |
| + New Invoice | Customer, then items (click the box for the list of items with a tax rule; picking one fills the tax; the item's rates are tick boxes), quantity; new items go on top; one discount for the whole invoice; live totals; save as draft or submit to FBR (the form then clears) |
| Draft Invoices | Invoices saved but not filed yet: open, finish and submit, or delete |
| Issued Invoices | Filed with FBR (status "Issued"). Filters show Pending Submission, Submission Failed and Check IRIS too; print, retry, debit note, mark cancelled |
| Bulk Import | Many invoices from Excel/CSV: preview errors, then queue them |
| Items with Tax Rules | One page, one form: the item (HS code, description, UOM and as many prices as needed, named A, B, C … or anything; marked Official or Customer-created HS code) together with its tax rule. The client sets the item's sale type, rate (box or 0–100% slider), reference searched from FBR's SROs, circulars, general orders and notices, SRO / schedule and serial no. Date/time and industry are recorded automatically; old rules stay as history. Guideline buttons open the Sales Tax Act (30-06-2026) schedules, SROs, circulars and the HS code list. Raseed does not decide the tax (Phase 1) More taxes (optional): any number, each named, % or a fixed Rs amount (once per line, not × quantity), applied on the value before tax, the value after tax, the sales tax or a tax listed above it, and added into the FBR box chosen (Extra Tax, FED Payable, Further Tax or Sales Tax); receipts list them by name. Excel: template (Items, More taxes, all HS codes to search, Lists with dropdowns, How to fill), import (checked first — every problem listed by sheet and row, nothing saved until the file is clean; only adds new items; the same HS code + sale type can't be used twice) and export. Only items with a tax rule appear on invoices |
| Buyers / Customers | NTN (max 9 digits), CNIC and STRN (max 13) kept separately, plus mobile, email and a note; Excel template, import and export; (FBR gets the NTN, else the CNIC); "Check registration with FBR"; the same number can't be saved twice |
| Stock | Opening stock, purchases, imports and adjustments (feeds Annex-H1) |
| Users | Owner adds Accountant / Cashier logins |

Roles inside a client:
- **Owner:** can do everything.
- **Accountant:** everything except managing users.
- **Cashier:** makes and prints invoices only.

A client can't file real invoices while it is in **SANDBOX**. Only the admin switches it to production.

### Invoice statuses
- **SUBMITTED:** FBR accepted it (it has an FBR number).
- **FAILED:** FBR rejected it. The FBR error is shown; fix the invoice and retry.
- **QUEUED:** FBR was unreachable. Raseed keeps retrying for up to 24 hours (offline mode, Rule 150XC).
- **UNCERTAIN:** we don't know whether FBR received it. Check IRIS first. Then either press "Found in IRIS" or resubmit.
  This avoids filing the same invoice twice.
- **CANCELLED:** recorded after it was cancelled in IRIS. IRIS allows this within 72 hours of filing.

### Tax rules built in (from the CA's DI Rules and Q&A sheets)
- Discount is subtracted before tax.
- Further tax (4%) applies only to unregistered business buyers and to non-ATL registered buyers. It never applies to
  end consumers, exempt, zero-rated or 3rd-schedule items.
- 3rd schedule items: tax is charged on the retail price.
- The buyer's CNIC/NTN is required for B2B sales and for consumer invoices above Rs 100,000.
- Exempt and reduced-rate lines need an SRO schedule and item serial number.
- Debit note reasons follow the IRIS list. Each client has its own internal invoice numbering.
- The receipt shows "Integrated with FBR", the software registration number and the Tax Asaan / SMS 9966 line.

---

## 3. What is left

### A. Waiting on others (nothing to code until these arrive)
1. **PRAL sandbox token and assigned scenarios** (from IRIS).
   - Then: put the token in the client's FBR settings and run each assigned scenario until IRIS shows "Completed".
   - After that, IRIS gives the **production token**.
2. **Static IP.** Create the Oracle Cloud Always Free VM proxy ([static-ip-proxy.md](static-ip-proxy.md)), whitelist
   its IP in IRIS, then set `FBR_PROXY_URL` on Render.
3. **CA's remaining answers:**
   - Invoice and QR format: POS style or DI style?
   - Is a credit note needed, or is a debit note enough?
   - Withholding: 1/10 or 1/5?
   - Services: head of account and provincial sales tax.
   - Exporter clients: refund / Annex-H details.
   - Stock valuation method. Weighted average is used for now.

### B. Still to build
- **Buyer check in the form.** The code is ready (STATL / Get_Reg_Type). Testing it needs the token.
- **FBR dropdowns:** sale type → rate, SRO schedule and SRO items. These need the token.
- **Products import** from Excel/CSV.
- Later: purchases CSV import for stock, subscription billing for clients, branches in different provinces, offline
  POS (a separate, bigger product).

### C. Going live with the first real client
1. Sandbox scenarios completed in IRIS and the production token received (A1).
2. Static IP whitelisted (A2).
3. On Render, set `FBR_MOCK=false`. **Do this only after steps 1 and 2.**
4. Admin switches the client to PRODUCTION and saves the production token.
5. File one real invoice, then check it in IRIS / Tax Asaan.
6. **Turn on backups.** FBR requires records to be kept for 6 years ([backups.md](backups.md)).
7. Optional: buy a domain (e.g. raseed.pk), connect it through Vercel, set `TRUST_PROXY_HOPS=2` on Render, and fill in the
   `CONTACT_*` details for the website.

### D. Housekeeping
- Remove the brother's GitHub login from this Mac once it's no longer needed: `gh auth logout -u mohisn-bhatti`.
- Clear test data from Supabase before real clients start. Invoices can be deleted; audit log rows can't.

---

## 4. For the developer

```bash
npm run db:local          # start local Postgres (Docker)
npm run dev               # app on http://localhost:3000 (FBR_MOCK=true in .env)
npm test                  # all tests
npm run db:migrate        # new migration (local)
npm run supabase:deploy   # apply migrations to Supabase. Only when we decide to.
npm run backup            # encrypted Supabase backup. Only when we decide to.
```

Rules we follow:
- **Test locally first.** Push to Supabase only once a change is final.
- **The GitHub repo is public.** Never commit `.env`, `render.env` or `backups/`, and check for secrets before every push.
- Don't log in to or create test data on the live site from scripts.
- Admin work and client work stay separate.
- Render redeploys automatically on every push to `main`. Migrations run during the build.

| Doc | About |
|---|---|
| [README.md](../README.md) | Full feature reference and deployment steps |
| [ROADMAP.md](ROADMAP.md) | Detailed done / to-do list |
| [static-ip-proxy.md](static-ip-proxy.md) | Oracle VM proxy for the FBR IP whitelist |
| [backups.md](backups.md) | Backup and restore |
| FBR-DI-API-Technical-Spec-v1.12.pdf, FBR-DI-User-Manual-v1.5.pdf | FBR's own documents |
