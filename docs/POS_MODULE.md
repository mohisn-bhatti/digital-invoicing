# Point of Sale (PRA) module

_Branch `pos-module` · started 2026-10-19 · updated 2026-10-19 · status: built, independently reviewed and tested in test mode;
**not yet run against PRA's sandbox**_ · requirement-by-requirement check: [POS_COMPLIANCE.md](POS_COMPLIANCE.md)

A second product on the same platform, next to FBR Digital Invoicing. It is a cashier screen for restaurants, banquet halls,
hotels and other Punjab service businesses: **every sale is sent to PRA (Punjab Revenue Authority)** and the receipt is printed
with the fiscal invoice number PRA returns and a QR code. A client can have Digital Invoicing, the POS, or both; a user whose
client has both picks one after logging in and can switch from the menu.

It is **separate from Digital Invoicing**: its own tables, its own business details and counters, its own PRA connection and
its own screens. Only the login, the roles, the audit log, the encryption key and the static-IP proxy are shared.

## 1. Sources

| Source | What it gave |
|---|---|
| **PRA eIMS POS SRS v1.7** (the requirements the owner supplied, Oct 2026) | Scope, user classes, sale states, functional rules |
| PRAL, *Technical Specification for Data Sharing through Software Fiscal Device* v1.2 (PRA's eIMS page) | The invoice model, the cloud address, IP whitelisting, the QR address |
| PRAL, *POS Component – User Manual* v1.0 (Jan 2026, same page) | Field sizes and formats, registration steps, the FAQ, a sample receipt |
| *The Punjab Sales Tax on Services Act 2012*, consolidated, **17th edition 2026–27** (PRA's site) | The Second Schedule rates in force from 1 July 2026; section 7(5) (a trade discount lowers the taxable value); section 30 and the e-IMS Rules 2019 (what an invoice must show, rule 6; faults, rule 8); the credit-note rule |
| The reference software the owner pointed to (TechnoTrading) | What a working POS of this kind looks like: items, sale screen, returns, receipts, per-user privileges |

PRA's sandbox has **not** been called yet: that needs a Test POS ID and token from the PRA portal. Everything below that depends
on PRA's behaviour is marked.

## 2. Scope (from the SRS)

In: capture sales, build PRA's invoice, send it to the cloud IMS API, keep the fiscal number, print the receipt with its QR code,
returns by credit note, an audit trail, and monitoring of what is waiting.
Out (SRS 1.2): the local Software Fiscal Device, offline fiscalization, full accounting, complex inventory, payroll, multi-province,
split bills and table sharing, delivery-app workflows.

So the earlier idea of a trading-and-accounts system (vendors, purchases, cash and bank, stock) is **not** part of this module.
It can come later as its own module if wanted.

## 3. What PRA's documents settled (the SRS's open items)

| SRS open item | What PRA's papers say | What the code does |
|---|---|---|
| Cloud addresses | `https://ims.pral.com.pk/ims/{sandbox,production}/api/Live/PostData`, Bearer token | Same ([src/pos/pra.js](../src/pos/pra.js)) |
| Token process | Sandbox: test POS IDs (each with its own token) come from the *Generate Test POS* tab of the PRA portal. Production: the token is on the POS Details tab | The owner pastes the **token** (not the access code, which is for PRA's own desktop program) per counter; stored encrypted; never sent back to the browser |
| IP whitelist | Production needs the server IP whitelisted: email eims@pra.punjab.gov.pk with PNTN, business name, POS ID, server IP, server location | Settings shows the server's IP, the steps and a copy-ready email; `PRA_PROXY_URL` (or `FBR_PROXY_URL`) gives a static IP |
| `TotalQuantity` | Present in PRA's sample JSON and .NET example | Always sent |
| Calculation, rounding | **Not specified.** Their example: SaleValue 1,298 at 17% shows tax 221 (17% is 220.66) | 2 decimals, half-up, in one place ([public/pos-calc.js](../public/pos-calc.js)). **Check in the sandbox** |
| Timestamp | Sample `2018-11-01 00:00:00.000`; tolerance not published | The sale's own time, Pakistan time, `yyyy-MM-dd HH:mm:ss`; the same time on a resend |
| `RefUSIN` | Optional in the model; the FAQ says a credit invoice is always against an original | Always sent on a credit note; checked before sending |
| USIN scope | Not published | Unique per business, enforced by the database (the stricter reading) |
| Error codes | **No catalogue in either document.** Only `Code "100"` is defined | Anything else is shown as PRA wrote it; HTTP 401/403 get a plain explanation (token or IP); a 403/407 that is not PRA's JSON (proxy or firewall) is "nothing was sent" |
| Field sizes | InvoiceNumber 30, USIN and RefUSIN 50, names 150, BuyerPNTN 9 (`1234567-8`), CNIC 13, phone 20, ItemCode 50, PCTCode 8 | Checked as data is entered, and again in [test/posValidation.test.js](../test/posValidation.test.js) |
| `PCTCode` | 8 characters from the Second Schedule | Service headings (9801.xxxx) searchable from the item form, with or without the dot; stored as 8 digits |

### Calculation, and the discount

The code follows PRA's manual and the Act (`SALE_VALUE_BASIS = 'NET'` in [public/pos-calc.js](../public/pos-calc.js)): `SaleValue` is
**after** the discount, `Discount` is shown alongside, `TaxCharged = SaleValue × rate`, `TotalAmount = SaleValue + tax`. Section 7(5)
of the Act says the same: for a trade discount the taxable value is the discounted price. Money is whole paisa (BigInt), half-up,
and nothing is rounded behind the user's back: more decimals than a field holds are refused (quantity 4, price and discount 2).

**Three readings exist, and PRA has not said which one its system expects. Settle it in the sandbox before going live:**

1. *NET* (the default): PRA's manual table, `SaleValue` 1,298 + tax 221 = 1,519, `Discount` 380 shown on the side.
2. *GROSS*: the SRS (4.3): `SaleValue` before the discount, tax on `SaleValue − Discount`. Built and tested; a one-word change.
3. *PRA's own sample receipt* (manual p.34): 20 × Rs 1,000 at 18% shows Sales Tax 3,600, Discount 2,360, Net total 21,240: tax on
   the **full** value, then 10% of the tax-inclusive 23,600 taken off. It is not built, because it taxes more than the Act's
   section 7(5) allows; if PRA's sandbox insists on it, `calcLine` is the one place to change.

Plan: post one discounted sale each way to the sandbox and see which PRA accepts. Without a discount the readings are identical.

### Tax rates (Second Schedule, from 1 July 2026)

The tax rate is **per item**, and an item can have a second rate **for card payments**. The module holds whatever the client enters
and never decides a rate itself, but its hints and the demo follow the current schedule:

- Restaurants (9801.2000) and hotels (9801.1000): **16%**, or **8%** (it was 5% until 30 June 2026, Punjab Finance Act 2026) when
  the customer pays by debit or credit card, **mobile wallet or QR**. Choose *Card* for all of these: PRA's payment-mode list has no
  wallet or QR entry.
- Marriage halls and lawns (9801.3000), caterers (9801.5000) and event management: a flat **8%**. Beauty parlours: 5%.
- Prices are entered **before** tax. (The Act's rules for restaurants say menu prices are before tax; hotels and clubs price
  tax-inclusive, which the module does not do yet.)
- **Mixed** payments (cash + card) use the standard rate, so the card part may be taxed at 16% instead of 8%. Ask PRA or the CA how
  a mixed bill is to be split before relying on it.
- Rates change with each Finance Act: the account owner confirms them against PRA's current schedule.

### Who must give their details: Rs 50,000

The e-IMS Rules 2019, **rule 6**: when the bill excluding sales tax is more than Rs 50,000, the invoice must also carry the
customer's **name and CNIC** (an individual) **or NTN** (a business). The server refuses such a sale without them (400, in plain
words) and the cashier screen opens the buyer box and keeps *Finalize* off until they are filled in. The bill after discount is what
counts. The limit is one constant, `BUYER_REQUIRED_ABOVE` in [public/pos-calc.js](../public/pos-calc.js).

### The receipt

Shows the business name, address, PNTN/NTN, branch, counter and POS ID, the USIN, PRA's invoice number, date and time, cashier, the
buyer if given, each item with its value, tax rate and tax, the total quantity, the totals, how it was paid, and a QR code to PRA's
verification page (`https://reg.pra.punjab.gov.pk/IMSFiscalReport/SearchPOSInvoice_Report.aspx?PRAInvNo=…`). That covers what
section 30 of the Act and rule 6 ask of a tax invoice. A receipt from test mode says **TEST MODE: NOT A FISCAL INVOICE**, and one
from a Sandbox counter on a live server says **PRA SANDBOX TEST: NOT A REAL INVOICE**. Printing again never sends anything to PRA, and
printing prints only the receipt that is open (the Digital Invoicing receipt windows are kept apart).

## 4. How it works

**A sale's life** ([states.js](../src/pos/states.js), [service.js](../src/pos/service.js)):

```
AWAITING_FISCALIZATION ─► FISCALIZED          only when PRA answers Code "100" with an invoice number
      │        ▲               └─ a credit note is a new sale that points at this one
      │        └─ REJECTED ◄─ PRA answered with an error: correct the buyer and send again, or cancel
      └──────► OUTCOME_UNKNOWN              no usable answer: NEVER sent again by itself
```

(A sale is written already finalized: there is no half-made draft in the database.)

- **Every change of state goes through one guarded step.** The update names the state it expects, so of two people acting at the
  same moment only one succeeds and the other is told the sale was just changed; the history line is written in the same
  transaction. A sale being sent right now ("in flight") cannot be cancelled, corrected or sent again by anyone.
- **Outcome unknown** (timeout, broken connection, PRA server error, or the server stopped mid-send) means PRA may or may not
  have the sale. It is never retried automatically. A manager looks it up in PRA's IMS Fiscal Report (IRIS, e.pra.punjab.gov.pk:
  type the USIN in the **USIN** box, set the dates and the Mode) and records what they found: *found* (with PRA's number), *not
  found* (the sale can then be sent again or cancelled) or *still unknown*. Each is kept with who and why. An alert shows on every
  page while any exist.
- **No connection** (nothing could reach PRA) leaves the sale waiting; it can be sent again, or cancelled with a reason. A bad proxy
  address, a certificate PRA's server fails, or a block by the proxy or firewall also count as "nothing was sent".
- **A double click or two screens** cannot send one sale twice: a send is claimed atomically. Each new sale carries a key, so a
  lost answer followed by pressing *Finalize* again gives back the sale already made. *Clear* starts a new sale with a new key.
- **While PRA is unreachable, new sales are blocked** (SRS 2.1/FR-6.1; no sale is made, with a clear message and a countdown). The
  default is 1 failed call, then a 15 second rest (`POS_BREAKER_FAILS`, `POS_BREAKER_REST_SECONDS`); after the rest **exactly one**
  sale is let through to test the connection and the others wait for its answer. Operator retries of one sale are limited to one
  every 3 seconds. The wait for PRA is capped (8 s by default, `POS_PRA_TIMEOUT_MS`) and the screen lets go after 35 s.
- **Credit notes**: partial and repeated returns are allowed up to what was sold; every amount is worked out as "returned up to and
  including this note" less what was returned before, so the notes add up to the sale to the paisa and none is ever negative. Two
  returns at the same moment cannot take the same quantity (checked under a lock). A refused note can only be sent again while its
  quantity is still free. **A sale keeps the environment and POS ID it was made with**: after a counter is re-pointed (going
  live), earlier sales can no longer be sent again or returned from it.
- The USIN is handed out once, when the sale is finalized, and never reused.
- **Test mode is the default.** Unless the server has `PRA_MOCK=false`, nothing is sent to PRA and receipts get fake `MOCK-`
  numbers and a banner. A Production counter refuses to sell in test mode. A buyer name of `MOCK-REJECT`, `MOCK-TIMEOUT`,
  `MOCK-OFFLINE` or `MOCK-SLOW` rehearses each failure.
- **Figures and reports cover one kind of sale at a time**: the test (Sandbox) sales while the server is in test mode, the real
  (Production) sales once it is live, and the report says how many of the other kind it left out. The sales list and the CSV
  hold everything, with the environment in each row.
- Sales are never deleted. Every change of state, every call to PRA and every administrative action is recorded.

**Who can do what** (the SRS's three user classes, on the business's own roles):

| | Cashier | Manager (accountant role) | Administrator (owner role) |
|---|---|---|---|
| Make a sale, send again, correct the buyer, reprint, see sales | ✅ | ✅ | ✅ |
| Items, credit notes, cancel, record a manual PRA check, dashboard, totals, CSV | | ✅ | ✅ |
| Business details, branches, counters, PRA tokens, decommission | | | ✅ |

**Where the code is:** [src/pos/](../src/pos/) (`payload` PRA's JSON, `pra` the connection, `service` the rules, `routes` the API,
`states`, `breaker`, `validate`; `calc.js` only re-exports the money maths), [public/pos-calc.js](../public/pos-calc.js) (the money
maths, the same file for the server and the browser, so the cashier's preview always equals what is sent),
[public/pos.js](../public/pos.js) (the screens), tables `Pos*` in [schema.prisma](../prisma/schema.prisma), migrations `0038`–`0041`.
Settings (env): `PRA_MOCK`, `PRA_PROXY_URL`, `POS_PRA_TIMEOUT_MS`, `POS_BREAKER_FAILS`, `POS_BREAKER_REST_SECONDS` (see `.env.example`).

## 5. Decisions made (please confirm)

1. The discount follows PRA's manual and section 7(5) of the Act, not the SRS (see above); the sandbox settles it.
2. Card, mobile-wallet and QR payments are all entered as *Card*, which uses the item's card rate. Mixed payments use the standard rate.
3. The owner role is the SRS's "Administrator", so POS setup (counters, tokens) is done by the client's owner. Digital
   Invoicing keeps FBR settings with the ETAX administrator; the administrator can still open a client's workspace and do the
   POS setup there.
4. A sale still waiting (never delivered) can be cancelled. The SRS's state table does not list it, but FR-5.3 allows cancelling
   anything not yet fiscalized.
5. A server error from PRA (HTTP 500/502/504) is *outcome unknown*, not a refusal, because PRA may have saved the sale. HTTP 503,
   failed connections and a block in front of PRA count as *not sent*.
6. Prices are before tax; there is no tax-inclusive pricing (hotels and clubs may need it).
7. **Sales are blocked while PRA is unreachable**, as the SRS locks (cloud-dependent only). The e-IMS Rules (rule 8) expect a
   business to report a fault at once and to enter invoices issued by hand during it within a week of the fix. The module has no
   screen for that: a business needs a written fallback (a numbered invoice book) for outages, and a way to key those invoices in
   afterwards if PRA asks. To be confirmed with PRA and the owner.
8. A bill above Rs 50,000 before tax cannot be finalized without the buyer's name and CNIC or NTN (rule 6).
9. Credit notes have no time limit against the sale. (The Adjustment of Tax Rules, rule 8, asks for a credit note within 90 days of
   the tax period in which the correction is needed, which a note made when the goods come back meets.)
10. Figures and reports show test and real sales separately (see above).

## 6. Not built yet / still open

**Settle in PRA's sandbox before going live** (needs a Test POS ID and token):
- The **discount reading** (above), and the **rounding**.
- Does PRA reject an `ItemCode`, `PCTCode` or rate that is not in the business's *product catalogue* (the PRA portal has a Product
  Catalogue tab and PRA's own client syncs items from it)? If yes, items must be registered or loaded there first, and ours need
  a UOM.
- Buyer formats: the manual's own sample posts a dashed CNIC to its local component while the form says "without dashes". We send
  `BuyerPNTN` as `1234567-8` and the CNIC and phone as digits. Test both.
- Whether `TotalQuantity` and `RefUSIN` are validated, the timestamp tolerance, PRA's real error codes, duplicate-USIN behaviour.
- `FurtherTax` is always 0 (the Punjab Act has no further tax on unregistered buyers): confirm with the CA.
- Mixed payments: how PRA and the CA want a cash + card bill split (see rates).
- That the QR address above is still PRA's current verification page for new invoices (the IMS Fiscal Report moved to IRIS for
  invoices from September 2024).
- The MAC and IP fields PRA asks for when a counter is registered: what a cloud server should enter.

**Going live** needs `PRA_MOCK=false`, the production POS ID and token, and PRA to whitelist the server's IP (the static-IP proxy,
see [static-ip-proxy.md](static-ip-proxy.md); the proxy must allow `ims.pral.com.pk`).

**Not built:** service charge and tips (the SRS says their tax treatment must be configurable; the Act's restaurant rules put service
charge and hall rental in the taxable value, so they belong on the invoice as items, and tips off it); a screen for debit notes
(InvoiceType 2 is in the model); tax-inclusive pricing; logo upload; product-catalogue sync with PRA; direct thermal-printer support
from a phone (the receipt prints through the browser to an 80 mm printer); a retention policy for sales and the audit trail (the SRS
says "multi-year, set from the law": nothing is deleted today); a screen to key in invoices issued by hand during an outage.

**Checked in a real browser, not on a real tablet or printer.** The screens were checked at phone, tablet and laptop widths, and
the receipt's print layout in Chrome's print mode.

## 7. Try it locally

1. `npm run db:local`, then `npx prisma migrate deploy`, then `npm run dev` (the app is at `/app`).
2. **Demo business:** `node scripts/seed-pos-demo.js` makes "Al-Noor Restaurant & Banquet (DEMO)" with an owner, a manager and a
   cashier, a counter, eight items, four sales (one cash, one card with a discount, a banquet booking with a buyer, one more cash
   sale) and a credit note. It only runs against a database on this computer and in test mode, and prints the password once (or
   uses `DEMO_PASSWORD`). `--reset` makes it again with fresh times (the dashboard counts today's sales).
3. Or by hand: Admin → Clients → **Manage** a client → **Modules** → tick **Point of Sale** → Save settings. Log in as that
   client's owner; in **Settings** add the business details, a branch and a counter (any POS ID and token in test mode), then add
   items under **Items**, then sell from **New Sale**.

Tests: `npm test` runs the maths, the validation tables, PRA's reply handling, the states and the breaker, the cashier screens'
own logic (the real `pos.js` in a sandbox), and the whole sale life against the local database (it makes its own business and
removes it, and only runs against a database on this computer).
