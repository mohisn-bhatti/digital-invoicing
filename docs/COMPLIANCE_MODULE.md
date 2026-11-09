# Compliance & Deadlines module

A third product of the ETAX platform, next to FBR Digital Invoicing and the PRA Point of Sale. A consulting firm keeps its own
clients, anywhere in the world, with their statutory obligations, reminders sent on WhatsApp, fee invoices and receipts.
Source requirement: "Global Statutory Deadline, Compliance, Invoice & Communication Module" (SRS, November 2026), plus the CA's
answers of 8 November 2026. Requirement-by-requirement check: [COMPLIANCE_SRS_CHECK.md](COMPLIANCE_SRS_CHECK.md).

"Clients" here are **the firm's own clients** (`CmpClient`), not the businesses that use ETAX.

## 1. Who may do what

- The ETAX administrator switches the module on for a business (Manage → Overview → Modules). The first time, that business's
  active owners get full access.
- Each user's permissions are ticked by the **administrator** under Manage → Users (Compliance: … Edit). The firm cannot change
  them, not even through the API. Presets: Full access, Preparer, Billing, Viewer, No access.
- Permissions (`public/cmp-perms.js`): VIEW, CLIENT_EDIT, OBLIGATION_EDIT, WHATSAPP, INVOICE, COMPLETE, SETUP, REPORTS, LOGS,
  EXPORT, ARCHIVE, SECRETS (see portal passwords; ours, the SRS says "at minimum"), FULL. Any permission includes VIEW.
- Every route checks the module and one permission on the server (`src/compliance/routes.js`). `test/cmpRouteGuards.test.js`
  holds each route to its permission: a route cannot be added without one.
- A business whose access period is over can only look (the platform rule): every change is refused.
- The firm sees **only its own compliance actions** in its activity log. The ETAX log stays with the administrator.
- A session left alone for 30 minutes signs out (in the browser); the server's own 12-hour token and lockout apply as everywhere.

## 2. Clients and fields

- A client starts with its **country** (flag shown). The country sets its time zone (one can be picked where a country has several,
  or any zone), its dialling code and currency, and which extra fields show.
- Basic details: name, address, contact number (stored with its country code), email, registration no., reference, portal
  username, password and PIN. **Mandatory:** country, name, contact number, username and password, unless "This client has no online
  portal" is ticked (the CA: so nobody types "NA").
- The portal password and PIN are **encrypted** (AES-256-GCM, the platform key) and never listed. "Show password" needs SECRETS,
  hides itself again after a minute, and is written in the activity log.
- **Custom fields**: name, type (text, number, date, multi-line), for one country (the client's, by default), several, or all.
  They show on every client of those countries ("Missing" until filled) and never elsewhere. Retired fields keep their values.
- Archive hides a client (and its obligations) from lists, dashboards and reminders; it stays searchable and can be restored.

## 3. Obligations, periods and dates

- An obligation (VAT return, corporate tax, licence…) has a name, a portal link, **how often it comes back** and **how many years**
  (a number, or unlimited). The CA (9 Nov 2026): no "comes back" list; the three dates say it (`R.detectFrequency`): a period of
  exactly one month comes back every month, three months every quarter, six months every six months, anything else every year. The
  screen can still ask for "once a year" for a shorter period (one of four separate quarterly returns). Fixed once added.
- **Amber days** and **"prepare the next period by itself"** are set on each obligation (`CmpObligation.amberDays`, `autoNext`), not
  firm-wide; migration `0051` copied each firm's old settings onto its obligations.
- **Planned periods**: the periods still to come are not stored; `R.projectPeriods` proposes them, and `GET /api/cmp/occurrences`
  adds them as `projected` rows (status `PLANNED`) when asked (`projected=1`) for a stretch of dates. The calendar, My Obligations,
  the client's page and the obligations report show them, up to the number of years (unlimited: as far as anyone looks).
- **Deleting** an obligation (`POST /api/cmp/obligations/:id/delete`, the archive permission) removes it with its periods and
  reminders; its messages and invoices stay, unlinked. Once a message was sent or an invoice issued for it, a note is required and
  kept in the activity log.
- Each repetition is a **period** with its own dates: period start, end and due date. Dates are always typed or confirmed by a
  person: the next period is proposed as a copy one period on (`public/cmp-rules.js periodDates`) and marked "dates to confirm".
  Month ends stay month ends (31 Jan → 28 Feb → 31 Mar); a due date is never moved later.
- Changing one period's dates affects only it. Ticking "Also use these dates for the periods after this one" makes them the pattern
  from that period on (the obligation's `baseSeq`), and re-proposes later periods nobody has confirmed yet.
- The next period is made by itself when a period ends (setting "Prepare the next period by itself"), when a period is completed,
  by the "+ Next period" button, or in bulk. Made by itself only for a period still ahead, so an obligation typed in with an old year
  does not fill up with past periods that would all be overdue.
- Rules: the period end is not before the start; the due date is on or after the period end (SRS 15).
- Steps a person sets: Open, Data collected, Filed, Paid, then Completed. **Upcoming**, **Period closed** and **Overdue** follow from
  the dates. Overdue = not completed by the end of the due date **in the client's time zone**; it stays overdue until completed
  (CA's answer). Completing offers **Generate invoice** (opens a draft for the period) or **Close without invoice** (free work).
- Suggestions: typing an obligation's name offers the dates and reminders already used for other clients **of the same country**
  under that name (the CA: suggested by country and obligation description).
- **My Obligations** (the main sheet, the CA): one row per period of the dates chosen (the calendar year by default), sorted by due
  date, then client, then obligation; the reminder, the step, close, the invoice and its receipt are done on the row. Filters include
  one or several clients (`clientId=a,b`).

## 4. Reminders, notifications and WhatsApp

- Each obligation has any number of reminders: N days before, on, or after the due date, each with its message template. They
  apply to every period.
- A reminder comes due at the firm's reminder hour (default 09:00) **on the client's clock**. Its state (`reminderStates`):
  bleak (grey, no button) until then; **highlighted** (amber, WhatsApp button) until the next reminder or the due date; then
  "not sent" (still sendable); sent; or closed.
- The **Notifications** page shows every open period from the end of its period (or its first reminder) until it is completed,
  overdue first, then those with a reminder to send. A pop-up and a menu badge tell the user once per session.
- **Templates** have [placeholders]: [Client Name], [Due Date], [Period Start], [Period End], [Registration No.], [Email],
  [Invoice Amount], [Receipt Number], [Obligation], [Invoice Number], [Contact Number], [Address], [Reference], [Country], and every
  custom field by its name. Case and dots do not matter. Passwords and PINs are never placeholders.
- **WhatsApp**: the window fills the template with the client's details; the person can change the text and the number, then
  WhatsApp opens with it (they press Send there). The number is the client's "WhatsApp Number" field if it has one, else its
  contact number. A bleak reminder is refused by the server too.
- **Which WhatsApp sends** (the user's request): a link cannot pick the sender; WhatsApp sends from the account open where the link
  opens. So the firm lists its numbers (Setup → Settings → Your WhatsApp numbers), each with how it opens: WhatsApp Web (logged in
  with that number in the browser), the WhatsApp Business app (opened directly on Android), the WhatsApp app, or the device's
  choice. The send window has "Send from" (the last one used on that computer first) and says which account must be open.
- The **WhatsApp log** keeps every message handed to WhatsApp: time, client, obligation period or document, reminder, template,
  to and from numbers, the final text, the user. "Mark not sent" crosses it out (it is never deleted) and the reminder comes due again.
- Sending is not automatic: the WhatsApp Business Platform (Cloud API) could send by itself from the business number, but needs
  Meta business verification, approved templates and per-message fees. It can be added later if wanted.

## 5. Fee invoices and receipts

- A draft: client details and the obligation period filled in, the fee typed by the user, the **currency of the client's country**
  (any other can be chosen), invoice and payment dates, notes.
- **Taxes** (the CA): any number per invoice (e.g. VAT 5%, a municipality fee 2.5%), each on the subtotal. "Keep for [country]
  clients" saves it; saved taxes are suggested on the invoices of clients of those countries only. Managed under Setup → Invoice
  Taxes. The same name can have different rates in different countries.
- Issuing gives the next number (format in Settings, e.g. INV-{YYYY}-{NNNN}); numbers are never reused, also when several are
  issued at once. An issued invoice no longer changes; it can be cancelled with a reason (it keeps its number).
- Statuses (SRS 9): Draft, Issued, Sent (handed to WhatsApp, or marked), Partially received, Received, Cancelled.
- A **receipt** records money received (amount, date, method, reference) with its own number; it cannot exceed what is owed.
  A receipt is voided with a reason, never deleted. Invoices and receipts print as A4 documents (browser "Save as PDF") with the
  firm's details from Settings, and can be sent on WhatsApp.
- Money is worked out in whole minor units of the currency: 3-decimal currencies (KWD, BHD, OMR) stay exact.

## 6. Team work, views and reports

- Clients and obligations can be **assigned** to a team member; an obligation without its own person follows the client's.
  **My Tasks** lists the user's open periods and clients.
- **Bulk actions** on the obligations list: next period for several clients **of one country** (SRS 10), set the step, assign,
  archive; on the clients list: assign, archive. Each item is done or skipped with its reason.
- **Dashboard**: overdue, due in the next 7/30/60 days, reminders to send, dates to confirm, completed this month, by country with
  flags, and fees not paid by currency.
- **Calendar**: every due date of a month, coloured, with filters.
- **Reports**: overdue list, upcoming deadlines (a window of days), invoice aging (0–30, 31–60, 61–90, 90+ days, totals per currency,
  no exchange rates).
- **Downloads**: clients, obligations, invoices, receipts, the reports, the WhatsApp log and the activity log, as CSV (opens in
  Excel), with the filters on the screen. A download needs EXPORT **and** the permission to see that data. Every list and report
  also prints as a PDF (A4 landscape).

## 7. How it is built

- Tables `Cmp*` (migration `0050_compliance`, additions only): CmpSettings, CmpClient, CmpFieldDef, CmpFieldValue, CmpObligation,
  CmpOccurrence (a period), CmpReminder, CmpTemplate, CmpMessage, CmpTaxRate, CmpInvoice, CmpInvoiceLine, CmpInvoiceTax,
  CmpReceipt; `User.cmpPerms`.
- Server `src/compliance/`: `routes.js` (guards and endpoints), `clients.js`, `obligations.js`, `comms.js` (templates, WhatsApp,
  notifications), `invoices.js`, `bulk.js`, `reports.js` (dashboard, calendar, reports, downloads), `sweep.js` (background job),
  `validate.js`, `common.js`.
- Shared by server and browser: `public/cmp-rules.js` (time zones, reminder states, statuses, recurrence, templates, WhatsApp
  links), `public/cmp-countries.js` (225 countries: dialling code, currency, time zones; made by `scripts/gen-cmp-countries.js`),
  `public/cmp-perms.js`.
- Screens: `public/cmp.js` (shell, WhatsApp window, notifications, pop-up), `cmp-clients.js`, `cmp-obligations.js`, `cmp-invoices.js`,
  `cmp-tasks.js`, `cmp-reports.js`, `cmp-setup.js`, `cmp-logs.js`.
- **Background job** (`sweep.js`, at start-up and every 10 minutes; `CMP_SWEEP_DISABLED=true` turns it off): notes each overdue
  period once in the activity log, and prepares next periods. The screens never depend on it having run.
- Every change is in the activity log as `cmp.*` (clients, fields, obligations, periods, steps, reminders, templates, invoices,
  receipts, taxes, archive/restore, downloads, password views). The administrator's permission changes are `user.cmp_perms`.

## 8. Tests

`test/cmpRules.test.js` (time zones incl. summer-time changes and +5:45/+14/−11 zones, reminder states, statuses, recurrence,
templates, WhatsApp links), `test/cmpData.test.js` (countries, permissions), `test/cmpRouteGuards.test.js` (every route's permission),
`test/cmpApi.test.js` and `test/cmpBilling.test.js` (the real server: permissions, isolation between firms, secrets, reminders,
recurrence, monthly periods, archive, activity log, the administrator's screen, read-only, the background job, invoices, taxes,
receipts, numbering under concurrency, assignment, bulk, dashboard, calendar, reports, downloads, WhatsApp numbers),
`test/cmpFeedback.test.js` (the CA's feedback: the cycle from the dates, years, amber and "by itself" per obligation, planned periods,
sorting and client filters, no WhatsApp, the templates page's client values, deleting with a note, items with prices, undo "sent",
cancelling with receipts, logo and header, the reports by dates).

## 9. The CA's feedback of 9 November 2026

Twenty items from the CA's "Deadline Tracker" sheet; what was done for each, and the open questions, are in
[COMPLIANCE_CA_FEEDBACK.md](COMPLIANCE_CA_FEEDBACK.md). Tests: `test/cmpFeedback.test.js`.

## 10. Not built / later

- Automatic WhatsApp sending (WhatsApp Business Platform): needs Meta set-up; links are used now.
- Exchange rates between currencies in reports (aging is per currency).
- A server-side idle timeout (the browser signs out after 30 minutes).
- Plan limits for this module and its place on the pricing website.
