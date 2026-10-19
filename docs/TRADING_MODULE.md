# Trading & Accounts module

_Branch `trading-module` · started 2026-10-19 · status: Phase 0 built, the rest planned_

A second product on the same platform, next to FBR Digital Invoicing. A client can have one or both; a user whose
client has both **picks which to open after logging in** (and can switch from the menu).

Reference software: **TechnoTrading** by TechnoloJenny (`technotrading.technolojenny.com.pk`), read on 2026-10-19 with
the login the owner supplied. The SRS the owner shared (a Google Doc) is private and could not be opened from the link:
it needs to be exported (PDF / Word) or shared as "anyone with the link". **Everything below about the reference
software comes from its screens and code, not from the SRS. Check it against the SRS before building Phase 1.**

## 1. What is built now (Phase 0)

| Piece | Where |
|---|---|
| Module list (Digital Invoicing, Trading & Accounts) | `src/modules.js` |
| Which modules a client has | `Tenant.modules` (migration `0038_tenant_modules`; every existing client keeps Digital Invoicing) |
| Admin switches modules on per client | Manage client → **Modules** card; audited as "Modules" |
| Login returns the client's modules | `loginPayload`, `/api/client/settings`, `/api/meta` |
| Chooser after login (only when there are 2+) | `#moduleView` in `public/app.html` |
| "Using … Switch ⇄" at the top of the menu | `renderNav()` |
| Trading menu and "coming soon" screens | `NAV.trading`, `initTrading()` |
| Tests | `test/modules.test.js` (rules), plus a simulated-browser run of the whole flow (29 + 5 checks) |

Behaviour worth knowing:
- One module → no chooser, straight in (so nothing changes for today's clients).
- The choice is kept when the page is refreshed; a fresh login asks again, with the last used one marked.
- If the admin removes a module while someone is using it, their next page load moves them to one they still have.
- The super admin never sees the chooser. "Open workspace" (sandbox testing) always opens Digital Invoicing.
- Trading screens will be guarded on the server with the client's module list, not only hidden in the menu.

## 2. The reference software, as read

**How it is built.** A phone-style web app (Cordova): static HTML pages with jQuery, calling a PHP backend on a
different domain. One login per business (it calls a business a "setup"). It runs in a desktop browser too.

**Main menu (9 items):** Profiles · Sale Invoice · Old Sale Invoice · Sale Return Invoice · Receive Cash · Purchase
Invoice · Pay Cash to Vendor · Default Settings · Reports.

**Profiles**
- Change password.
- *Accounts*: cash (opening Dr / Cr), bank accounts (account no., bank, branch, title, description, opening Dr / Cr),
  customers and vendors (name, phone, address, opening Dr / Cr).
- Company info (the brand / maker an item belongs to) · item category.
- *Item*: name, description, picture, company, item type, category, sale price, default discount % and Rs, amount for
  GST, purchase price, opening qty, minimum stock, unit, size, status. HS code is shown in the list. Search, delete,
  bulk update, "Opening Stock/Value Report", "Rate List", "Category Wise Item List", print / Excel.
- Leftovers from the restaurant product it was copied from (deals, tables, kitchens, waiter orders): **not wanted**.

**Sale invoice** (one screen, four variants: plain, banquet/marquee, PRA, FBR + PRA)
- Date · **account** (the debit side: cash, bank, or the customer's own account) · buyer name, phone, address, NTN/CNIC
  (walk-in if blank) · registered / unregistered (PRA and marquee variants) · payment mode cash / card (PRA).
- Items by name or barcode (F2 adds the highlighted one): price, qty, discount Rs and %, total before tax, GST % and Rs,
  item total. Invoice-level discount % / Rs and GST amount. Stock on hand shown while selling.
- Save, edit, delete (each deleted or edited line is reported later), **old invoices** screen, account / invoice /
  cash statements, stock and category / company sale reports, GST report.
- Prints on a thermal printer (USB, serial, Bluetooth; 2-inch and full width). On-screen keyboard layout setting.
- Sends the invoice to **FBR's older POS service** (a fixed POS id) and to **PRA** (Punjab Revenue Authority) when the
  business is set up for them; the response is stored with the invoice.

**Sale return (credit note)** from an earlier invoice, FBR-aware. **Purchase invoice**: vendor, items with discount and
tax, purchase reports by category and company. **Receive cash / Pay cash**: customer or vendor, cash account,
description, amount, with cash and account statements; receive cash can send an SMS.

**Reports:** category inventory, company inventory, company stock, short (low) stock, **edited / deleted transaction**
report, opening stock list.

**Default settings (per business):** may the user change the date on a sale invoice · edit an invoice · delete one ·
change the default price. Plus discount, service charge and GST defaults, print size, and a subscription-expiry warning
at login.

## 3. What we do differently

- FBR tokens are encrypted and stay on the server. Nothing secret goes into a page or into browser storage, and
  passwords are never kept in the browser.
- The business is taken from the signed login token only, never from a number the browser sends.
- Invoices go to FBR from the server through the Digital Invoicing API. The reference software targets FBR's older POS
  service and PRA.

## 4. How it fits what we already have

Already there and reusable: multi-business login, users and roles (Owner / Accountant / Cashier), append-only audit
log, 80mm and A4 printing, Excel import pattern, stock entries and the Annex-H1 stock statement, saved buyers and items,
backups, the admin console.

Not there: customer **and vendor** accounts with opening balances, cash / bank accounts, stock quantity per item with a
purchase price, purchase invoices, receipts and payments, returns against a sale, statements, edited / deleted history.

Our `Product` and `Buyer` tables are built around FBR tax rules (HS code, sale type, NTN / STRN). Trading needs
different fields (purchase price, opening qty, minimum stock, brand, category), so Trading gets **its own tables** and
does not change the Digital Invoicing ones.

## 5. Proposed data (Phase 1–3, to confirm against the SRS)

```
TradeAccount   id, tenantId, kind CASH|BANK|CUSTOMER|VENDOR, name, phone, address,
               bankName, branch, accountNo, openingDr, openingCr, active
TradeCategory / TradeBrand   id, tenantId, name
TradeItem      id, tenantId, name, description, categoryId, brandId, unit, size, hsCode,
               salePrice, purchasePrice, discountPct, discountRs, taxPct, openingQty, minStock, active
TradeInvoice   id, tenantId, kind SALE|PURCHASE|SALE_RETURN|PURCHASE_RETURN, number, date,
               partyId, payAccountId, discountPct, discountRs, taxAmount, total,
               refInvoiceId (returns), status, createdBy, deletedAt/deletedBy
TradeInvoiceLine  invoiceId, itemId, qty, price, discountPct, discountRs, taxPct, lineTotal
TradeCashEntry id, tenantId, kind RECEIPT|PAYMENT, date, partyId, cashAccountId, amount, description
```
- Stock on hand = opening + purchases − sales ± returns (computed, with a stock-move view for audit).
- A statement = opening + invoices + receipts / payments for one account.
- Edit and delete keep the earlier version (soft delete) and write to the existing audit log, feeding the
  "edited / deleted transactions" report.
- Every route is guarded by the client's `TRADING` module and the user's role.

## 6. Phases

| # | What | Notes |
|---|---|---|
| 0 | Module list, admin switch, chooser, switcher, Trading menu | **done on this branch** |
| 1 | Customers, vendors, cash and bank accounts, categories, brands, items with opening stock | forms, lists, Excel import |
| 2 | Sale and purchase invoices with stock effect, discounts, tax, payment account; 80mm and A4 print | the core |
| 3 | Receive / pay cash, sale and purchase returns, account and cash statements | |
| 4 | Reports (stock, short stock, sales by category / brand, tax report, edited / deleted), settings (who may edit / delete / change price) | |
| 5 | File a trading sale with FBR through our Digital Invoicing engine; SMS reminders; subscription expiry warning | needs the owner's decision |

## 7. Questions for the owner

1. **The SRS**: export it (PDF or Word) or share it as "anyone with the link", so Phase 1 follows it exactly.
2. **FBR for trading sales**: file through our Digital Invoicing API (recommended: it is the current FBR system and
   already built), or also the older POS service and PRA that the reference software supports?
3. **Who gets Trading first**: which client, what kind of business (shop, wholesaler, banquet)? The reference software
   has a banquet variant and a PRA variant; we should not build those unless a client needs them.
4. **Roles**: can Owner / Accountant / Cashier cover it, or do trading users need their own privileges (the four
   switches under "Default settings")?
5. **Printing**: browser print to an 80mm or A4 printer is what we have. Is direct Bluetooth / USB thermal printing from
   a phone required?
6. **SMS** for payment reminders: which provider, and is it needed at the start?

## 8. Try it locally

1. `npm run db:local`, then `npx prisma migrate deploy`.
2. Admin → Clients → **Manage** a client → **Modules** → tick both → Save settings.
3. Log in as that client's user: the chooser appears. Pick Trading & Accounts.

On the live site nothing changes until the admin ticks Trading for a client. The only database change is the new
`modules` column, which defaults to Digital Invoicing for everyone.
