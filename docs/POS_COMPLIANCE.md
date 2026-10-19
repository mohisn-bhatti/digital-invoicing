# Point of Sale (PRA): the build against its requirements, and the code review

_2026-10-19 · branch `pos-module` · what the module is and how it works: [POS_MODULE.md](POS_MODULE.md)_

Legend: ✅ built and tested · 🟡 built, but only PRA's sandbox can confirm it · ⬜ not built (out of scope, or later)

## 1. In one paragraph

Every requirement in the SRS v1.7 that can be met without PRA is met and tested, in test mode. What is left before real clients is
not code: a **run against PRA's sandbox** (a Test POS ID and token from the PRA portal), the answers PRA alone can give (listed in
section 5), PRA whitelisting the server's IP for production, and a written plan for the hours PRA is down. An independent review of
the code found 23 real problems. Most only mattered in rare timing (two people acting at the same moment) or after an unusual step
(a counter re-pointed, an odd category name), but a few could have left a wrong record at PRA (an item credited twice, a sale
cancelled here that PRA had recorded). All are fixed, and each has a test that fails without the fix (section 4).

## 2. The SRS v1.7, requirement by requirement

| ID | Requirement (short) | | Where and how |
|---|---|---|---|
| FR-1.1 | Store POS ID, Bearer token, Sandbox/Production | ✅ | Per counter; token encrypted, only a masked tail is ever shown |
| FR-1.2 | Several branches and counters, each with its POS ID | ✅ | Settings → branches and counters |
| FR-1.3 | Rotate the token; in-flight requests; log it | ✅ | A send in progress keeps the token it started with; the new one is used from the next send; the change is audited (never the token) |
| FR-1.4 | Decommission or reassign a POS ID, revoke the token | ✅ | *Decommission* removes the token and switches the counter off; its sales stay. A POS ID or environment can be changed only with no sale waiting, and earlier sales keep the ID they were made with |
| FR-2.1 | Items, quantity, discount, PaymentMode 1–6 | ✅ | New Sale screen; discount in rupees or % per line |
| FR-2.2 | Exact field names, POST with Bearer token | ✅ 🟡 | [payload.js](../src/pos/payload.js), [pra.js](../src/pos/pra.js); nothing leaves unless the invoice reconciles to the paisa |
| FR-2.3 | Fiscalized only on Code "100" | ✅ | HTTP 200 alone is never success; Code "100" **and** an invoice number |
| FR-2.4 | InvoiceType 1, 2, 3 | ✅ ⬜ | New and credit have screens; debit (2) is in the model and payload only |
| FR-2.5 | Optional buyer fields with format checks | ✅ | PNTN `1234567-8`, CNIC 13 digits, phone 7–20 digits; letters and control characters refused. **Above Rs 50,000 before tax name + CNIC/NTN are required** (e-IMS rule 6) |
| FR-2.6 | USIN once, never reused; ambiguous timeout → Outcome Unknown, no automatic retry; manual resolution; no exactly-once claim | ✅ | USIN from a per-business counter inside the sale's own transaction; unknown outcomes are never retried; a manager records what PRA's report shows; alert on every page |
| FR-2.7 | USIN uniqueness scope, enforced by the database | ✅ | Unique per business (`@@unique([tenantId, usin])`) — the stricter reading; PRA's own scope 🟡 |
| FR-4.1 | Receipt content | ✅ | Business, address, PNTN/NTN, counter and POS ID, USIN, PRA number, items, tax, total quantity, total, payment mode, QR |
| FR-4.2 | QR = PRA's verification URL; confirm it is current | ✅ 🟡 | Same address as the Technical Specification; confirm it opens for new invoices |
| FR-4.3 | Section 30 particulars | ✅ | Checked against the Act (17th ed. 2026–27): serial number, date, provider, registration number, recipient, service, value, tax, total |
| FR-4.4 | Reprint never re-submits | ✅ | Tested: a reprint makes no call to PRA |
| FR-5.1 | Credit note: InvoiceType 3 + RefUSIN | ✅ 🟡 | RefUSIN always sent; PRA's validation of it 🟡 |
| FR-5.2 | Partial and multiple returns | ✅ | Up to what was sold, checked under a lock; amounts never negative and add up to the sale |
| FR-5.3 | Cancel un-fiscalized sales with an audit record; credit notes after | ✅ | Cancel with a reason (manager); a fiscalized sale can only be returned by credit note |
| FR-6.1 | PRA/internet unreachable: block new sales, clear message | ✅ | 503 with a countdown; none is made; after the rest one sale tests the connection (see decision 7 in POS_MODULE.md about PRA's fault rule) |
| FR-6.2 | Recovery buffer for submitted sales whose answer was lost | ✅ | The sale is written first; Outcome Unknown keeps it; the screen's lost-answer card and the sale key give the same sale back |
| FR-6.3 | Every non-success is recoverable, no silent drops | ✅ | Refused / not sent / unknown each have a way out; nothing is deleted |
| FR-6.4 | Hard timeout, configurable | ✅ | 8 s by default (`POS_PRA_TIMEOUT_MS`); the screen lets go after 35 s |
| FR-6.5 | Unknown outcomes excluded from retry; operators alerted | ✅ | No code path sends an Outcome Unknown sale; the alert strip polls once a minute while the tab is visible |
| FR-6.6 | Rate-limit operator retries | ✅ | One retry of a sale every 3 s; a sale in flight cannot be sent again |
| FR-6.7 | Original, submission and response times kept apart | ✅ | `finalizedAt` (sent to PRA), `submittedAt`, `respondedAt`, `fiscalizedAt`; timestamp tolerance 🟡 |
| FR-7.1 | Append-only audit trail, access controls | ✅ | The platform's audit log (database trigger forbids update and delete); POS actions and state changes recorded, never tokens |
| FR-7.2 | Pending, Outcome Unknown, last fiscalization, breaker state, alerts | ✅ | Dashboard and the alert strip |
| NFR-1 | Touch-optimized | ✅ | Checked at phone, tablet and laptop widths: no sideways scrolling, finger-sized controls, a *Review & pay* bar on phones |
| NFR-2 | Plain, actionable errors | ✅ | Messages say what happened and what to do |
| NFR-3 | No indefinite freeze | ✅ | Screen watchdog (35 s) and server cap (8 s); tested with a slow PRA |
| NFR-4 | Tokens encrypted, never in browser code | ✅ | AES-256-GCM at rest; the browser only sees `••••1234` |
| NFR-5 | Role-based access | ✅ | Cashier / Manager / Administrator, enforced on the server |
| NFR-6 | HTTPS everywhere | ✅ | PRA calls are HTTPS with certificate checks (a failing certificate is reported as such, not as "no internet") |
| NFR-7 | Tenant isolation | ✅ | Every query is scoped by business; tested against a second business |
| NFR-8 | Multi-year retention | 🟡 | Nothing is ever deleted; the exact period and backups are a policy decision (backups are not scheduled) |
| §3 | Sale states and transitions | ✅ | One guarded transition for every change; the SRS table plus "cancel a sale that was never delivered" |
| §4.3 | Calculation baseline | ✅ 🟡 | Decimal (BigInt) maths, half-up. The discount reading differs from the SRS on purpose (POS_MODULE.md); both are built |
| §5 | Endpoints, JSON structure | ✅ | Same names, order and sizes as the published model |
| §7 | Open confirmation items | 🟡 | Listed in section 5 below |

### Section 8, the acceptance criteria

| Criterion | |  |
|---|---|---|
| Sample invoices (new sale, credit note, mixed payment) fiscalize via the cloud API | 🟡 | Works against the stand-in for PRA; the real run needs the sandbox |
| Header totals reconcile with line totals | ✅ | A check before every send; tested across many shapes of sale and return |
| Receipts carry the fiscal number and a scannable QR | ✅ | QR drawn from PRA's address; fallback prints the address if the drawing library cannot load |
| Internet or cloud unreachable: new sales blocked, clear message | ✅ | |
| Ambiguous timeout → Outcome Unknown; no retry; operators alerted | ✅ | |
| Rejected invoices, printer failures and restarts recoverable without duplicates | ✅ | Refused: correct and send again. Printer: reprint from Sales & Receipts. Restart: an interrupted send is swept to Outcome Unknown |
| Cashier UI responsive under simulated latency | ✅ | `MOCK-SLOW` buyer name |

## 3. Against PRA's own documents

| Check | | Note |
|---|---|---|
| Field names, order, sizes (InvoiceNumber 30, USIN/RefUSIN 50, names 150, PNTN 9, CNIC 13, phone 20, ItemCode 50, PCTCode 8) | ✅ | Validated on entry and in a test that builds a maximum-size invoice |
| Payment modes 1–6, invoice types 1–3 | ✅ | |
| Endpoints, Bearer token, IP whitelisting by email | ✅ | The email text is generated in Settings |
| Rates from 1 July 2026 (restaurants and hotels 16% / 8% on card, wallet or QR; halls, caterers 8%) | ✅ | Hints and demo follow the Act; the module holds whatever rate is entered |
| e-IMS rule 6 (above Rs 50,000: name and CNIC or NTN) | ✅ | Enforced on the server and on the screen |
| e-IMS rule 8 (faults: report at once; invoices issued by hand are keyed in within a week) | ⬜ | No screen; needs a written outage procedure (POS_MODULE.md, decision 7) |
| Section 7(5) (trade discount: tax on the discounted price) | ✅ | The default basis; PRA's sample receipt (p.34) does it differently: a sandbox question |
| PRA's POS component features: invoice list with dates, CSV export, activity log, catalogue sync, logo upload | ✅ ⬜ | List with filters and CSV (with or without items) built; catalogue sync, logo and a heartbeat call are not |
| Discount, product catalogue, buyer format, mixed payment, FurtherTax | 🟡 | Open questions for PRA, section 5 |

## 4. The code review

An independent review looked at the whole module from five directions (line by line, behaviour the new code removed, cross-file
effects, language traps, and the wrapper and proxy layer), plus separate passes for simplicity, reuse and efficiency. **Each finding
was then reproduced against the real code** (some with a real browser) before it was accepted. Twenty-three held up; they are fixed,
and each fix has a regression test that fails without it (checked by removing the fix and running the test).

| # | What was wrong | Fix |
|---|---|---|
| 1 | A sale found "not recorded" after an interrupted send could never be sent again: it flipped back to unknown | The sweep ends the interrupted send; recording the result does too |
| 2 | A refused credit note could be revived after a newer note returned the same quantity (twice returned); two returns at once could both pass | The quantity is re-checked when a refused note is sent again, and read under a lock when a note is made |
| 3 | An item category with an apostrophe killed its chip, and a crafted one could run script (stored XSS by a manager) | Category goes in an attribute, never into script |
| 4 | Retry, cancel, resolve and buyer-correction acted on a stale read: two people at once, or a cancel during a send, could overwrite each other and lose PRA's answer | One guarded transition: the write names the state it expects; losers are told |
| 5 | The alert links ("Show them") listed only today's sales | They list that status on every date |
| 6 | The cashier maths script was served only by Express, so a static host (Vercel) answered 404 and the screen broke | The file lives in `public/` |
| 7 | Typing a full PCT code with its dot found nothing | The dot is put back before searching |
| 8 | A cart and buyer details survived a logout or module switch; the sale key survived *Clear*, so the next identical sale returned the previous sale | Everything resets on login, logout, switch and workspace change; *Clear* starts a new key |
| 9 | Re-pointing a counter (POS ID / environment) changed what credit notes and re-sends used for earlier sales | Sales keep the environment and POS ID they were made with; changed counters refuse to send or return them |
| 10 | Printing a POS receipt could also print a Digital Invoicing receipt seen earlier | Print rules follow the receipt that is open; verified in Chrome's print mode |
| 11 | A Sandbox counter's receipts looked real when the server was live | A *PRA SANDBOX TEST* banner |
| 12 | Dashboard and reports added test and real sales together | Figures cover one environment; the report names what it left out |
| 13 | An unreadable proxy address ended in "outcome unknown" though nothing was sent | Reported as "nothing was sent" |
| 14 | The documented proxy would block PRA's host; a proxy's own 403 read as "token or IP refused" | Documentation fixed; a non-PRA 403/407 is "nothing was sent" |
| 15 | An impossible date (month 13, 31 February) or a huge offset gave a 500 | A plain 400 |
| 16 | Returning a line one unit at a time could make the last note's tax or discount negative | Cumulative rounding; tested on awkward cases |
| 17 | After the rest, every caller passed the connection check at once, not one | Exactly one trial; the rest wait for its answer |
| 18 | A stored module list with only unknown ids sent the browser into an endless request loop | Falls back to Digital Invoicing |
| 19 | Unticking Digital Invoicing for a client hid the menu but the server still filed invoices | Filing needs the module |
| 20 | Polling continued after "Back to admin"; a receipt window stayed over the login screen | Timers stop and windows close when the screen is rebuilt |
| 21 | A refused "send again" had already changed the sale's state and history | Everything that can refuse is checked first |
| 22 | A `null` line in a sale body gave a 500 | A plain 400 |
| 23 | A long staff e-mail on the receipt shrank or cut it | A short cashier name; rows wrap on 80 mm paper |

Also fixed from the review: the documentation (breaker numbers, a leftover module name, "reports not built"); the alert strip now
asks a one-query endpoint, only while the tab is visible; an index for the dashboard queries (migration 0041); the CSV reads only the
columns it writes; the response-time query is skipped in test mode.

**Left as it is, on purpose:** the second discount reading stays built (the sandbox may need it); POS has its own error class
and its own small CSV helper rather than touching Digital Invoicing's code; the receipt keeps its own markup (Digital Invoicing's
carries a QR with a logo and an A4 form, the POS one does not); the `DRAFT` value stays in the database enum (nothing is ever
stored in it; removing a Postgres enum value is not worth a migration).

Validation was audited against PRA's field sizes and the Act's rules, and now refuses letters in PNTN/CNIC/phone, POS IDs that are
not digits, a manual PRA number longer than 30, non-numeric payment modes, control characters, and extra decimals
([test/posValidation.test.js](../test/posValidation.test.js)).

## 5. What only PRA can settle (before the first real client)

1. **Discount**: which of the three readings PRA's sandbox accepts (POS_MODULE.md, "Calculation, and the discount").
2. **Product catalogue**: whether `PostData` rejects an item that is not in the business's PRA catalogue.
3. **Buyer formats**: dashed or plain CNIC and PNTN.
4. **Mixed payments** (cash + card): how the 16% and 8% parts are to be reported.
5. **Error codes**, timestamp tolerance, `RefUSIN` and `TotalQuantity` validation, duplicate-USIN behaviour.
6. **Outage rule**: whether blocking sales while PRA is down is acceptable for a cloud POS, or a manual-invoice path is expected.
7. **IP whitelisting** and the MAC / IP fields on registration.
8. **FurtherTax** with the CA (the Punjab Act has none; the module sends 0).

## 6. The TechnoTrading reference

Taken as inspiration: the overall shape of a working POS (items, a sale screen, returns, receipts, per-user privileges). Deliberately
not included, as the SRS puts them out of scope: purchases and vendors, cash and bank accounting, stock, payroll.
