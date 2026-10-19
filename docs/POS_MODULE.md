# Point of Sale (PRA) module

_Branch `pos-module` · started 2026-10-19 · status: built and tested in test mode; not yet run against PRA's sandbox_

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
| PRAL, *Technical Specification for Data Sharing through Software Fiscal Device* v1.2 (published on PRA's eIMS page) | The invoice model, the cloud address, IP whitelisting, the QR address |
| PRAL, *POS Component and eIMS User Manual* v1.0 (Jan 2026, same page) | Field sizes and formats, the FAQ |
| PRA's *Second Schedule* of the Punjab Sales Tax on Services Act 2012 (public PDF) | The PCT headings for restaurants, marriage halls, hotels, clubs, caterers, and that the rate depends on how the customer pays |
| The reference software the owner pointed to (TechnoTrading, by TechnoloJenny) | What a working POS of this kind looks like (items, sale screen, returns, receipts, per-user privileges) |

PRA's sandbox has **not** been called yet: that needs a Test POS ID and token from the PRA portal. Everything below that depends on
PRA's behaviour is marked.

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
| Token process | Sandbox: a Test POS ID is generated on the PRA portal. Production: the token is on the POS Registration screen, POS Details tab | The owner pastes it per counter; stored encrypted; never sent back to the browser |
| IP whitelist | Production needs the server IP whitelisted: email eims@pra.punjab.gov.pk with PNTN, business name, POS ID, server IP, server location | Settings shows the server's IP and the steps; `PRA_PROXY_URL` (or `FBR_PROXY_URL`) gives a static IP |
| `TotalQuantity` | Present in PRA's sample JSON and .NET example | Always sent |
| Calculation, rounding | **Not specified.** Their example: SaleValue 1,298 at 17% shows tax 221 (17% is 220.66) | 2 decimals, half-up, in one place ([calc.js](../src/pos/calc.js)). **Check in the sandbox** |
| Timestamp | Sample `2018-11-01 00:00:00.000`; tolerance not published | The sale's own time, Pakistan time, `yyyy-MM-dd HH:mm:ss`; the same time on a resend |
| `RefUSIN` | Optional in the model; the FAQ says a credit invoice is always against an original | Always sent on a credit note; checked before sending |
| USIN scope | Not published | Unique per business, enforced by the database (the stricter reading) |
| Error codes | **No catalogue in either document.** Only `Code "100"` is defined | Anything else is shown to the user as PRA wrote it; HTTP 401/403 get a plain explanation (token or IP) |
| Buyer formats | PNTN varchar(9) `1234567-8`, CNIC varchar(13), phone varchar(20) | Checked as the customer is entered |
| `PCTCode` | 8 characters from the Second Schedule | Service headings (9801.xxxx) searchable from the item form; stored as 8 digits |

### The one place the SRS and PRA's manual disagree: the discount

The SRS (4.3) says an item's `SaleValue` is the value **before** the discount and tax is charged on `SaleValue − Discount`. PRA's
manual says `SaleValue` is "the price on which tax is calculated, exclusive of tax and discount", and its example only adds up
if the discount is already taken off: 1,298 + 221 = 1,519, with `Discount` 380 shown on the side.

The code follows **PRA's manual** (`SALE_VALUE_BASIS = 'NET'`): `SaleValue` is after the discount, `Discount` is informational,
`TaxCharged = SaleValue × rate`, `TotalAmount = SaleValue + tax`. The SRS reading is built too (`'GROSS'`, tested) and is a
one-word change in [calc.js](../src/pos/calc.js). Without a discount they are identical. **Settle it in the sandbox.**

### Tax rates

The tax rate is **per item**, and an item can have a second rate **for card payments**. The Second Schedule (the 2021–22 edition on
PRA's site) charges restaurants a lower rate when payment is by debit or credit card, mobile wallet or QR, and a higher rate
otherwise; marriage halls, catering and hotels have their own entries. Rates change with each Finance Act, so **the module holds
whatever the client enters** and never decides a rate itself. Mixed payments use the standard rate. Prices are entered before tax.

### The receipt

Shows the business name, address, PNTN/NTN, branch, counter and POS ID, the USIN, PRA's invoice number, date and time, the
buyer if given, each item with its value, tax rate and tax, the totals, how it was paid, and a QR code to PRA's verification page
(`https://reg.pra.punjab.gov.pk/IMSFiscalReport/SearchPOSInvoice_Report.aspx?PRAInvNo=…`). That covers what Section 30 of the
Act asks of a tax invoice as PRA publishes it (a numbered, dated invoice with the provider's name, address and registration
number, the recipient's if any, the service, the value before tax, the tax and the value including tax). The SRS asks for
sector-specific extras to be confirmed with the CA. Printing again never sends anything to PRA.

## 4. How it works

**A sale's life** ([states.js](../src/pos/states.js)):

```
DRAFT ─► AWAITING_FISCALIZATION ─► FISCALIZED          only when PRA answers Code "100" with an invoice number
              │        ▲                 └─ a credit note is a new sale that points at this one
              │        └─ REJECTED ◄─ PRA answered with an error: correct the buyer and send again, or cancel
              └──────► OUTCOME_UNKNOWN              no usable answer: NEVER sent again by itself
```

- **Outcome unknown** (timeout, broken connection, PRA server error, or the server stopped mid-send) means PRA may or may not
  have the sale. It is never retried automatically. A manager looks it up in PRA's IMS Fiscal Report by USIN and records what
  they found: *found* (with PRA's number), *not found* (the sale can then be sent again or cancelled) or *still unknown*.
  Each is kept with who and why. The dashboard shows an alert while any exist.
- **No connection** (nothing could reach PRA) leaves the sale waiting; it can be sent again, or cancelled with a reason.
- **A double click or two screens** cannot send one sale twice: a send is claimed atomically ("in flight").
- Operator retries are limited to one every 3 seconds. After 3 failed connections in a row the counter's connection rests for
  30 seconds and the cashier gets an instant message instead of another wait. The wait for PRA is capped (8 s by default).
- The USIN is handed out once, when the sale is finalized, and never reused.
- **Test mode is the default.** Unless the server has `PRA_MOCK=false`, nothing is sent to PRA and receipts get fake `MOCK-`
  numbers and a "not a fiscal invoice" banner. A Production counter refuses to sell in test mode, so a fake number can never
  reach a real receipt. In test mode a buyer name of `MOCK-REJECT`, `MOCK-TIMEOUT` or `MOCK-OFFLINE` rehearses each failure.
- Sales are never deleted. Every change of state, every call to PRA and every administrative action is recorded.

**Who can do what** (the SRS's three user classes, on the business's own roles):

| | Cashier | Manager (accountant role) | Administrator (owner role) |
|---|---|---|---|
| Make a sale, send again, correct the buyer, reprint, see sales | ✅ | ✅ | ✅ |
| Items, credit notes, cancel, record a manual PRA check, dashboard | | ✅ | ✅ |
| Business details, branches, counters, PRA tokens, decommission | | | ✅ |

**Where the code is:** [src/pos/](../src/pos/) (`calc` the money, `payload` PRA's JSON, `pra` the connection, `service` the rules,
`routes` the API, `states`, `breaker`, `validate`), [public/pos.js](../public/pos.js) (the screens), tables `Pos*` in
[schema.prisma](../prisma/schema.prisma), migration `0039_pos_core`. `/pos-calc.js` serves the same money maths to the browser, so
the cashier's preview always equals what is sent.

## 5. Decisions made (please confirm)

1. The discount follows PRA's manual, not the SRS (see above).
2. Card payments use the item's card rate; mixed payments use the standard rate. Whether mobile-wallet and QR payments should
   count as "Card" (PaymentMode 2) is for the CA to say: PRA's payment-mode list has no wallet entry.
3. The owner role is the SRS's "Administrator", so POS setup (counters, tokens) is done by the client's owner. Digital
   Invoicing keeps FBR settings with the ETAX administrator; the administrator can still open a client's workspace and do the
   POS setup there.
4. A sale still waiting (never delivered) can be cancelled. The SRS's state table does not list it, but FR-5.3 allows cancelling
   anything not yet fiscalized.
5. A server error from PRA (HTTP 500/502/504) is treated as *outcome unknown*, not as a refusal, because PRA may have saved the
   sale. HTTP 503 and failed connections count as *not sent*.
6. Prices are before tax; there is no tax-inclusive pricing.
7. Credit notes return a sold line at its own price and rate; the last return takes exactly what is left, so the notes add up to
   the sale to the paisa. There is no time limit on returns.

## 6. Not built yet / still open

- **A run against PRA's sandbox** (needs a Test POS ID and token): rounding, the discount reading, whether `TotalQuantity` and
  `RefUSIN` are validated, the timestamp tolerance, PRA's real error codes. Until then every figure is checked only against PRA's
  published examples.
- **Going live** needs `PRA_MOCK=false` on the server, the production POS ID and token, and PRA to whitelist the server's IP (the
  static-IP proxy, see [static-ip-proxy.md](static-ip-proxy.md)).
- Service charge and tips (the SRS says their tax treatment must be configurable per merchant: the rule is not known yet).
- Reports beyond the dashboard and the sales list (a daily sales and tax summary, CSV export).
- Direct thermal-printer support from a phone (the receipt prints through the browser to an 80mm printer).
- How long sales and the audit trail are kept (the SRS says "multi-year, set from the law"): nothing is deleted today.
- Debit notes (InvoiceType 2) are in the model and the payload but have no screen.
- The screens were exercised in a simulated browser, not on a real tablet or printer.

## 7. Try it locally

1. `npm run db:local`, then `npx prisma migrate deploy`, then `npm run dev` (the app is at `/app`).
2. Admin → Clients → **Manage** a client → **Modules** → tick **Point of Sale** → Save settings.
3. Log in as that client's owner. In **Settings** add the business details, a branch and a counter (any POS ID and token in test
   mode), then add items under **Items**, then sell from **New Sale**.

Tests: `npm test` runs the maths, PRA's reply handling, the states and the breaker, and the whole sale life against the local
database (it makes its own business and removes it, and only runs against a database on this computer).
