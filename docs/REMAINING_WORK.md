# Remaining work

_Written 21 October 2026, at the end of a long session. Nothing here contains a password or a token._

> **This is a snapshot from 21 October 2026.** Some items have been done since:
> - Client read-only access after expiry is built.
> - The local commits were published.
> - Compliance & Deadlines went live on 2026-11-08.
> - **The hosting changed on 2026-11-09:** etaxcloud.net now points straight at Render, and Vercel only keeps the DNS
>   records.
>
> For the current state, see [ROADMAP.md](ROADMAP.md) and [HOSTING.md](HOSTING.md).

## Where things stand

- **Live (21 October):**
  - The website and app were at https://etaxcloud.net/, served by Vercel, with `/api` forwarded to the Render service
    (`digital-invoicing.onrender.com`). Since 2026-11-09 Render serves it all: see [HOSTING.md](HOSTING.md).
  - Render uses the Supabase database.
  - Everything runs in **test mode** (`FBR_MOCK` and `PRA_MOCK`): nothing real goes to FBR or PRA.
- **On production:** FBR Digital Invoicing, Point of Sale (PRA) phase 1 and phase 2, plans with enforced limits, client access periods, website pricing.
- **Demo client on production:** "My CA Firm" has two weeks of demo Point of Sale data and two logins, a manager and a
  cashier. The login names and the password were given in chat and are not stored in this public repository.
- **Report for the CA:** a private claude.ai artifact (the link is not kept here).

## Ready locally, not published (2 commits on `main`)

1. `42b78d1` Report tables: the "Invoices ›" link sits under each row's name (at 1280 px the live version clips it).
2. `84f0e5c` `scripts/seed-demo-client.js` (demo data for one existing client, with a test) and its docs.

To publish: `git push origin main` (the last pushes were made with the `mohisn-bhatti` GitHub account: `gh auth switch --user mohisn-bhatti`, push, then switch back to `waqasakhtar3562`). Render and Vercel redeploy by themselves.

## Do first

- [x] ~~Clean up the domains in Vercel. Check `/api` through the new domain.~~ No longer needed: since 2026-11-09 the
  Vercel project serves no domain, and etaxcloud.net points straight at Render ([HOSTING.md](HOSTING.md)).
- [ ] **Publish the two local commits** (above).
- [ ] **Refresh the demo before each showing:** `node scripts/seed-demo-client.js --owner <owner e-mail> --wipe --yes`, then without `--wipe`. For production, `DATABASE_URL` has to be set on purpose for that run.

## PRA

- [ ] Register on the PRA portal, then *POS Client Registration → Generate Test POS*: get a **test POS ID and token**. Add them as a Sandbox counter and run PRA's test system. This settles: the discount method, whether items must be in PRA's product catalogue first, error codes, time tolerance, duplicate invoice numbers.
- [ ] For production: production POS ID and token, and PRA whitelisting the server's fixed address by e-mail (Settings has the e-mail text ready). MAC and IP fields are required at registration.
- [ ] A **fixed internet address** for the server (free Oracle Cloud server as a proxy: `docs/static-ip-proxy.md`; the account is not yet created). Needed by both PRA and FBR.
- [ ] Try a real thermal printer, a phone camera and a tablet. Nothing was tried on real equipment.

## Answers from the CA (the sheet pasted on 21 October)

Not yet worked through against the system. The ones that change something:

- [ ] **Q36 token entry:** clients may send the token by WhatsApp, or give their PRA portal login so we do it for them. Decide how to take and store tokens (never keep a client's portal password in the repo; prefer entering the token in Settings).
- [ ] **Q32 subscription expiry:** keep **read-only access** to old invoices after a client expires, so they can meet record-keeping duties. Today an expired client is switched off completely.
- [ ] **Q33 reminders:** in-app and optional WhatsApp reminders before expiry.
- [ ] **Q34 receipts:** logo upload (Urdu and A4 are optional).
- [ ] **Q35 launch scope:** restaurants and marriage halls first.
- [ ] **Q38 backups:** automated backups plus a tested restore **before the first production client** (scripts exist in `docs/backups.md`, not scheduled).
- [ ] **Q31 / Q14:** the CA found no rule that allows manual invoices during an outage, and blocking sales is our choice. Our docs call this "Rule 8"; reword it. Sales stay blocked while PRA cannot be reached.
- [ ] **Q27:** no Rs 50,000 buyer threshold was found in the POS manual (the e-IMS Rules, rule 6, is what we used). Confirm with the CA before real use.
- [ ] **Q30:** whether Further Tax applies to unregistered buyers under PRA tax is not confirmed (we send 0).
- [ ] **Q20:** clubs' rate is unclear; confirm in the Second Schedule.
- [ ] **Q19:** banks deduct 8% on digital payments as collecting agents; decide if the app must show this.
- [ ] **Q23:** a mandatory service charge is part of the price (taxable), a voluntary tip is not: check this matches what the app does.
- [ ] **Q24 / Q25:** banquet advances and tax-inclusive prices (Rule 45) are not covered by the POS manual: not built.

## Decisions waiting

- [ ] **The accounts side:** Receive Cash, Purchase Invoice, Pay Cash to Vendor. The SRS leaves accounting out. If wanted, build a small optional "Accounts" section; first get the CA's rules on credit sales and tax withheld.
- [ ] **Pricing page** ticks features that are not built: offline POS terminal, multi-branch stock and transfers, scheduled reports, and for PRA Excel upload, stock, CSV product upload. Build them or untick them.
- [ ] The Digital Invoicing 80 mm receipt still asks for a page size Chrome ignores (`size: 80mm auto`). The POS receipts no longer do.

## Not built (known gaps in Point of Sale)

Only product-catalogue sync with PRA is still not built (nothing in PRA's documents describes it; the sandbox will show). Debit notes, tax-inclusive prices, the logo, the record-keeping period, direct printing and the register of hand-written slips are built on branch `feature/pos-accounts` (direct printing is untried on a real printer).

## Housekeeping

- The local database container was stopped at the end of the session: `npm run db:local` starts it again. Inside it, drop the rehearsal database `fbr_demoseed_rehearsal` and the stale test client "Scan Cafe (TMP …)".
- The old brother's GitHub login can be removed from this Mac when no longer needed (`gh auth logout -u mohisn-bhatti`); pushes for production have used it this week.
- Never run `prisma/seed.js` on production: it resets the super admin's and the seed client's passwords. Production updates: fingerprint the data read-only, rehearse on a copy, run `node scripts/supabase-deploy.js --no-seed`, then push (see `docs/POS_MODULE.md`, "Phase 2 went to production").
