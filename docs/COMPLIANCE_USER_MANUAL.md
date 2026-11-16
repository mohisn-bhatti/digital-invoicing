# Compliance & Deadlines — User Manual

_ETAX · November 2026 (updated 16 November 2026 with the CA's "Deadline Tracker - 1")_

Compliance & Deadlines keeps your firm's clients anywhere in the world in one place, along with their statutory deadlines every year, the reminders you send them on WhatsApp, and the fee invoices for the work. It is part of ETAX (etaxcloud.net), next to FBR Digital Invoicing and the Point of Sale.

---

## 1. Getting started

**Who can use it.** The ETAX administrator switches the module on for your firm. The administrator also decides what each of your users may do (see section 10). Your firm's owner gets full access the first time the module is switched on.

**Logging in.** Go to **etaxcloud.net/app** and log in with your ETAX email and password. If your firm uses more than one ETAX product, choose **Compliance & Deadlines** on the next screen. To change product later, click **Switch** at the top of the menu.

**The work in one minute:**

1. Add a **client**: choose the country first, then fill in the details.
2. Add the client's **obligations**, such as a VAT return or an income tax return, with their three dates (period start, period end and due date) and their **1st, 2nd and 3rd reminder** (each a day and its message). Each comes back every year on the same dates.
3. Work from the **tracker** (My Obligations, or the client's page): on a reminder's day its button shows **Due**. Click it, check the message, and press Send in WhatsApp.
4. When the client's data comes in, click **Data collection** and choose the day. When the work is done, click **Task** and choose the day.
5. **Invoice created**: make the invoice (or mark "no invoice" for free work). Take off any **advance payment**.
6. **Invoice issued**: send it on WhatsApp. **Receipt**: record the money, then send the receipt.
7. The next period is prepared for you, and the cycle starts again.

**The menu:**

| Page | What it is for |
|---|---|
| Dashboard | Overdue items, items due in the next 7, 30 or 60 days, and fees not yet paid |
| My Obligations | The tracker: every period of the year for every client, with every action in its own column |
| Clients | Your clients and their 360° page (with the same tracker for that client) |
| Calendar | Every due date of a month, including the periods still to come |
| Invoices Created | Invoices made but not yet given to the client (drafts, and issued ones not sent yet) |
| Invoices Issued | Invoices sent to the client (or already paid) |
| Receipts Booked | Every receipt; a new receipt is always made against an invoice |
| Reports | Every report: obligations, overdue, upcoming, invoices, receipts, a summary per client, invoice aging |
| Logs | The WhatsApp log and the activity log |
| Setup | Message templates, custom fields, invoice taxes and items, settings and invoice formats |

**Notifications** open from the **bell at the top right** of the window. Its number shows how many obligations are overdue or have a reminder ready to send.

**Which dates a list shows.** My Obligations, a client's page, Invoices, Receipts and Reports show **this calendar year** (1 January to 31 December) by default. Use **Show** to choose last year, next year, several years side by side (to compare), any dates, or all history.

You see only the pages your permissions allow. For safety, you are signed out after 30 minutes without activity.

---

## 2. First-time setup (do this once)

Open **Setup → Settings**. Only a user with full access can change these.

- **Your firm's time zone.** The times shown in the logs and lists use it.
- **Reminders come due at.** The hour at which a reminder becomes active, on each client's own clock. The default is 09:00.
- **Your WhatsApp numbers.** Add the number(s) your firm sends from, for example "Business WhatsApp" with its full number including the country code. Choose how it opens:
  - **WhatsApp Web.** Log in at web.whatsapp.com with that number in the browser you use for ETAX. This is the best choice on a computer.
  - **WhatsApp Business app.** On an Android phone it opens the Business app directly.
  - **WhatsApp app**, or **Let the device choose**.

  Tick one number as the **Default**.
- **On your invoices and receipts:**
  - your **logo** (a PNG or JPEG picture: it is made small automatically) and a **header** line or two across the top, e.g. "Chartered Accountants · Tax Advisors";
  - your firm's name, address, phone, email, tax registration number (if registered), bank details and a footer line;
  - the number formats. For example, `INV-{YYYY}-{NNNN}` gives INV-2027-0001. Numbers are taken when an invoice is issued and never reused.
- **Top of invoices and receipts:** either **the logo, the header line and the firm's details**, or **a full letterhead picture** across the top (choose the picture: it is made smaller automatically; your letterhead already shows the firm's name and address).
- **How it looks:** the invoice (or, with **Receipt**, the receipt) is drawn on the right **as you type**, with a sample client.

**Invoice formats by country** (under the settings). Add one or more for each country, for example **UAE - Dubai** and **UAE - Sharjah**, and tick one as the country's **default**. An invoice of a client of that country offers them, its default first. Each format has:
- the **invoice title** (e.g. TAX INVOICE), the **receipt title** and a **note on the receipts**;
- the **top of the page** (as in the settings, the logo and details, the letterhead picture, or only the title for printed letterhead paper);
- the firm's name, address, **tax number** (and what it is called, e.g. TRN) and bank details **for this format** (empty = as in the settings);
- **extra information**: as many pieces as you like (e.g. "Trade License No. 778899", "Stamp and signature"). **Drag** each one anywhere on the preview, or place it exactly: **top left, top centre, top right, centre, bottom right …**, or its distance from the left and the top in %. Choose its size, bold, alignment and a box, and whether it is on the invoice or the receipt. It prints exactly where it shows. Placeholders such as [Client Name] or [Invoice Number] are filled in.

When an invoice is issued, its format is kept with it: a later change to the format does not change invoices already issued.

When an obligation turns amber, and whether its next period is prepared by itself, are set **on each obligation** (section 4), not here.

**Setup → Message Templates.** Write the messages you send. Words in square brackets are replaced with the real details when you send:

> Dear [Client Name], your [Obligation] for the period [Period Start] to [Period End] is due on [Due Date]. Kindly share the required documents.

| Group | Placeholders |
|---|---|
| Client details | [Client Name], [Client Code], [Registration No.], [Contact Number], [WhatsApp Number], [Email], [Address], [Reference], [Country] |
| Additional information | Every custom field, e.g. [Trade License Number], [VAT Registration Number] |
| Obligation | [Obligation], [Period Start], [Period End], [Due Date], [Days Left], [Portal Link] |
| Invoice | [Invoice Number], [Invoice Date], [Invoice Amount], [Payment Due], [Amount Outstanding] |
| Receipt | [Receipt Number], [Receipt Date], [Receipt Amount] |
| Your firm | [Firm Name], [Firm Phone], [Firm Email] |

1. Click **+ New template**, give it a name and a purpose (Reminder, Data collection, Obligation completed, Invoice, Receipt or Other), so the right one is offered first.
2. On the left, under **A client's details**, choose a **client** (and one of its obligation periods). Every placeholder shows with that client's real value, grouped as in the table above.
3. Click a line (or a placeholder under the message box) to put it in the message.
4. The **preview** shows the message exactly as that client would receive it.

Passwords and PINs are never put in messages.

**Setup → Custom Fields.** Add extra client details, such as a Trade License Number, UDIN or License Expiry Date. Choose a type (text, number, date or multi-line text) and the countries the field is for: one country, several, or all. The field then shows on every client of those countries. It is marked **Missing** until filled in, and it never shows on clients of other countries.

The **type can be changed later**, also when clients have values: a date becomes text like "1 Jun 2023"; text becomes a date or a number only where it reads as one (if some do not, you are told which clients' values to change first).

**Setup → Invoice Taxes** has two lists:
- **Taxes** you add to fee invoices, such as VAT 5% for the UAE. Each tax is suggested on the invoices of clients of its countries. The same name can have different rates in different countries, for example VAT 5% in the UAE and 15% in Saudi Arabia.
- **Items and services** you bill, with their price, suggested on the invoices of clients of their countries.

You can also add taxes and items while writing an invoice (section 7).

---

## 3. Clients

**Add a client:** go to **Clients**, then **+ Add client**.

1. **Choose the country first.** Its flag appears, and everything after follows that country: the time zone, the dialling code, the currency, and which extra fields show.
2. Fill in the **client name** and **contact number**. Add the email, address, registration no. and reference if you have them.
3. If the client has **no WhatsApp**, tick **This client has no WhatsApp**. No WhatsApp buttons show for it. When its reminder comes due, remind it by phone or email and click **✓ Reminded by phone / email** (section 6).
4. **Online portal login:** the username and password are required. If the client has no online portal, tick **This client has no online portal** instead of typing "NA". The PIN is optional.
5. **Time zone.** It is set from the country. Where a country has several (e.g. the USA), pick the right one. Due dates and reminders follow the client's own clock.
6. **Assigned to** (optional): the team member who looks after this client.
7. **Additional information:** the custom fields for this country. With setup permission you can add a new field right here, and change a heading with the ✎ next to it: its **name and its type** (e.g. a date field that should be text).

Every text and number box **suggests the values typed before** for other clients (for example "01 January to 31 December"): pick one, or type another. The Reference does the same.

**Changing a heading changes it for every client** of its countries, and a warning says so. Values already typed are kept. Templates that use the old name in [brackets] keep it: change them too.

**Passwords are safe.** The portal password and PIN are stored encrypted and never shown in lists. On the client's page, **Show password** displays them for one minute, only to users allowed to see passwords, and each time is written in the activity log.

**The client's 360° page** (click a client) shows everything in one place, for the dates chosen under **Show** (this calendar year by default):
- details and additional information (missing items marked);
- its obligations as the **tracker** (the same columns as My Obligations, section 5), for those dates, with the **planned** periods still to come; archived obligations are listed under it, to restore or delete;
- invoices and receipts;
- every WhatsApp message;
- the client's **history**, closed until you click it.

**Archive** a client you no longer serve. It disappears from the lists, dashboards and reminders, but nothing is deleted. Tick **Archived clients** on the Clients page to find it, and **Restore** it at any time.

---

## 4. Obligations and periods

**Add an obligation:** on the client's page, click **+ Obligation**. Each obligation is one row:

1. **Obligation:** e.g. Income Tax Return, VAT Return Q1. Names used before are suggested. If other clients of the same country already have it, a blue box offers their dates and reminders: click **Use these dates and reminders**, then check the dates. If **this client already has it**, the window says so in red: a client cannot have the same obligation twice (open the existing one with **Edit** instead).
2. **Period start, period end and due date:** you type them, nothing is calculated. For example, a Pakistan income tax return: period 1 Jul 2026 – 30 Jun 2027, due 30 Sep 2027. It comes back **every year on the same dates**.
3. **1st reminder, 2nd reminder, 3rd reminder** (optional): choose the **day** of each, then click **✉ Message** under it. A window opens with the message (it starts from your reminder template), the placeholders **in groups** (Client details, Additional information, Obligation, Your firm; each shows this client's real value when you point at it) and, on the right, **how it looks** for this client with this obligation's dates. You can start from a saved template, use the message for the same reminder of every obligation in the window, or keep it as a new template. Each obligation has its own messages. Every year the reminder comes the same number of days before the due date.
4. **Several at once:** click **+ Add another obligation** for each one more. For quarterly VAT, add four obligations, Q1 to Q4: after Q1, it proposes **Q2** with the next quarter's dates, reminder days and messages, to check. If one of them has a mistake, none is added until it is put right.
5. **How many years:** type a number, or tick **Unlimited**.
6. **Turn amber this many days before the due date** (7 by default) and **Prepare the next period by itself when this one ends** (ticked by default), for these obligations only.
7. **Portal link** (optional; the links used before are suggested). **Assigned to** (optional): otherwise the client's person.
8. **Add obligations.** If a due date has **already passed**, you are asked first: **Yes, add for the past date** (it shows as overdue until completed), **Move to the next year ahead** (the dates and reminders move on a year, for you to check and save), or **Go back**.

**Edit an obligation:** click **✎ Edit** on its row in the tracker (or its name). The same window opens, for that period: its name, dates and three reminders. New dates apply to that period, and to the ones after it if **Also use these dates for the periods after this one** is ticked. A **planned** period (still to come) opens the same window: new dates become the pattern from that period on.

**Periods and their dates.** Each repetition is a period. The next period is proposed with the same dates one year later, and shows **dates to confirm** until you check it (click **dates to confirm ✓** on its row when they are right). Periods further ahead show as **Planned** (dashed).

**Deleting an obligation.** **Delete** (on its row) removes the obligation with its periods and reminders, for good. If a WhatsApp message was already sent (or an invoice issued) for it, a red warning shows and a **note** saying why is required. The messages and invoices stay in their logs and lists, and the note is kept in the activity log. To keep an obligation but hide it, **Archive** it instead.

**Statuses:**

| Status | Meaning |
|---|---|
| Planned | A period still to come, shown ahead of time |
| Upcoming | The period has not ended yet |
| Period closed | The period has ended; the work can start |
| Data collected | The client's data came in (the tracker's Data collection) |
| Overdue | The due date has passed and it is not completed. It stays overdue until it is completed |
| Completed | The task is done (the tracker's Task) |

**Colours:** green = safe, amber = approaching or a reminder to send, red = overdue, grey = completed, dashed = planned.

The due date is the client's own calendar day. A UAE obligation becomes overdue at midnight in Dubai.

---

## 5. My Obligations: the tracker

**My Obligations** shows every period due in the dates chosen (this calendar year by default) for **every client**, sorted by **due date**, and by **client name** when two dates are the same. The client's page shows the same table for that client only. Every action is done in its own column, without opening anything:

| Column | What it shows and does |
|---|---|
| Due date | The date and how many days are left (or overdue), with its colour |
| Client name · Obligation · Period | Click the obligation to edit it |
| Portal | Opens the e-filing portal |
| Overall status | How many of the period's actions are done, e.g. **2/7**, with a bar and the status (Upcoming, Overdue …) |
| 1st, 2nd, 3rd reminder | The reminder's date and its WhatsApp button: **Due** on its day, **Pending** after it until sent, then **Sent**, **Sent twice** … **Send again** sends it once more; **↶** takes one send off the count when WhatsApp did not really send it. "not needed" when the task was done first |
| Data collection | **Pending** until you click it and choose the day the data came in (↶ undo) |
| Task | **Pending** until you click it and choose the day the work was done. It can only be done once the data is collected (↶ reopen) |
| Advance payment | **+ Add**: the date, a description (the ones typed before are suggested) and the amount. Shows the total, and how much was adjusted on an invoice |
| Invoice created | **Pending · Create** once the task is done (or **no invoice** for free work); **Draft** while it is being written; then its **number** |
| Invoice issued | **Pending** with a WhatsApp button to send the invoice, or **mark sent**; then **Sent**, **Sent twice** …, **Send again**, **↶** |
| Receipt | **Pending** once the invoice is sent: **+ Receipt** records the money; then the receipt's WhatsApp button (Sent, Sent twice …) |
| Edit · Archive · Delete | The obligation's window, archive (or restore), delete |
| Remarks | Notes on this period for the team: click to write |

**The overall status counts:** each reminder (one no longer needed because the task was done first is not counted), the data collection, the task, and (unless closed without an invoice) the invoice created, sent and paid.

**One client, or a few:** click a client's name, or tick rows and click **Only this client** (or **Only these clients**). **Show all clients** brings everyone back. The **Client** filter does the same.

**Ticking a row: two ways.** Tick **Ticking a row shows only that client** (above the list) and a tick shows that client's periods at once. Leave it unticked and ticks select rows for the actions on several rows (section 8). The choice is remembered on this computer.

Filters: **Show** (dates), **Status**, **Client**, **Country**, **Search**, **Assigned to**, and **Archived**. The table scrolls sideways for the columns on the right.

---

## 6. Reminders and WhatsApp

**Notifications** (the bell at the top right) show every obligation from the end of its period until it is completed. Overdue ones come first, then those with a reminder to send. Each reminder appears in one of these states:

| Shown as | Meaning |
|---|---|
| **Send now** (amber, green WhatsApp button) | Its time has come: send it |
| Not sent (amber outline) | Its time came and went without a message; you can still send it |
| ✓ Sent | A message went for it (with the date) |
| Grey "activates on …" | Its time has not come; the button appears then |

A pop-up when you open the module also tells you when reminders are ready.

**Sending a message:**

1. Click a reminder's **Due** or **Pending** button on the tracker (or **WhatsApp** on a reminder in the notifications), or **Other message** for anything else (e.g. asking for documents).
2. The window shows the **number** it goes to, the **template**, **Send from** (your firm's number), and the **message** filled in with the client's details. Change anything you like.
3. Click **Open WhatsApp**. WhatsApp opens with the text ready. Press **Send** in WhatsApp.

**Important:**
- **Messages are not sent automatically.** ETAX tells you when, prepares the message and opens WhatsApp, but a person presses Send.
- WhatsApp always sends from the account that is open on your computer or phone. Choose your business number under **Send from**, and make sure WhatsApp Web (or the app) is logged in with that number. The window reminds you which one.
- The message goes to the client's **WhatsApp Number** custom field if there is one, otherwise to the contact number. A client ticked **no WhatsApp** gets no WhatsApp buttons.

**Reminded by phone or email.** For a client with **no WhatsApp**, a due reminder shows **✓ Reminded by phone / email** (on its row of My Obligations and in the period window). Remind the client, click it, choose **Phone call**, **Email** or **Another way**, add a note if you like, and save. The reminder counts as done, and the log keeps how it was given. Any other client can also be marked this way: **or mark done another way** under its reminder.

**WhatsApp Log** (Logs → WhatsApp Log) records every message:
- the time, client, obligation period or invoice, and template;
- the to and from numbers;
- the final text and who sent it.

Reminders given by phone or email are in the same log, marked **Phone call**, **Email** or **Another way**.

If you did not actually send a message after WhatsApp opened (or marked a reminder by mistake), click **Mark not sent**. It stays in the log crossed out, and its reminder becomes due again.

---

## 7. Invoices and receipts

**Invoice a period.** Once its **Task** is done, the tracker's **Invoice created** shows **Pending · Create**: click it and a draft opens with the client and the period's obligation filled in (or click **no invoice** for free work for family, friends or goodwill). A new invoice from scratch: **Invoices Created → + New invoice**.

**The draft invoice** (the invoice is drawn on the right **as you type**):
- **Currency:** the client's country's currency (e.g. AED for the UAE). You can change it to any other.
- **Invoice type:** the formats of the client's country (e.g. UAE - Dubai, UAE - Sharjah), its default first (section 2).
- **Completed obligations:** the client's completed tasks not billed yet. Click **+ Add** on each one to bill (as many as you like); it comes with the price billed before for that obligation. Once on an invoice, a period is not offered again.
- **Other items and services:** type to **search** what you billed before: every price shows with its date (e.g. "VAT Amendment · AED 250 · 10 Nov 2026" and "VAT Amendment · AED 200 · 12 Mar 2026"); pick one, or type a new item and its amount. **Keep** saves a new item or a new price **beside the old ones, with its date** (the price bank, also under Setup → Invoice Taxes).
- **Taxes:** pick a saved tax, or click **+ New tax** and type its name and rate (e.g. VAT, 5%). Each is worked out on the subtotal. Tick **Keep for [country] clients** to have it suggested next time.
- **Advance payments:** the client's advances in this currency, with what is left of each. Tick one and type how much to take off (or **+ Record an advance**). The invoice then shows **Gross amount**, **Advance received**, **Advance payment adjustment** and **Net amount**, and the advance kept for later.
- Optionally set the **invoice date** (empty = the day you issue it), the **payment due** date and notes.
- **Save draft** to finish later, or **Save and issue**. Issuing gives the invoice its number, and it can no longer be changed. The advance is taken off then (never more than is left); if the invoice is cancelled later, the advance can be used again. An invoice fully paid by advance is **Received** at once.

**Invoices Created and Invoices Issued.** **Invoices Created** lists the invoices not yet given to the client (drafts, and issued ones not sent yet); once sent on WhatsApp or marked sent (or paid), an invoice moves to **Invoices Issued**. Click an invoice in either list: it shows **beside the list**, with everything that can be done to it:
- **Print / PDF:** an A4 invoice with your logo, header, firm details and bank details. Choose "Save as PDF" in the print window. The print's footer shows the invoice's **own web address** (e.g. etaxcloud.net/app#/cm-invoices/INV-2026-0001); opening that address shows that invoice.
- **WhatsApp:** sends it using an "Invoice" template, and marks it **Sent**.
- **Mark as sent**, and **↶ Undo "sent"** if it was marked by mistake.
- **+ Receipt:** the receipt form opens in place: amount, date, how it was paid and a reference. This creates a numbered **receipt**. The status becomes **Partially received** or **Received**. You cannot record more than is still owed. If the client has **credit**, **Paid by: Client credit** pays from it.
- **Cancel invoice:** at any stage, with a reason. It keeps its number and stays in the list as cancelled. If money was received, you are told how much and which receipts, and you choose what becomes of it:
  - **Refund it to the client:** the date, how it was paid back and a reference. The receipts stay, marked **Refunded**.
  - **Keep it as the client's credit:** it pays the client's next invoices in that currency (**Paid by: Client credit**). The receipts stay, marked **Kept as credit**, and the client's page shows its credit.
  - **Void the receipts:** the money was never really received (entered by mistake, a bounced cheque). The receipts stay, crossed out.

The list itself also has **+ Receipt**, **Mark sent** and **↶ Not sent** on each row.

**Receipts Booked** lists every receipt for the dates chosen. **+ New receipt** asks which invoice was paid (a receipt is always made against an invoice). Each receipt can be printed, sent on WhatsApp, or **↶ Undone** (voided) with a reason, e.g. "Entered by mistake" or a bounced cheque. An undone receipt stays in the list crossed out, and the money is owed again. A receipt marked **Refunded** or **Kept as credit** stays as it is, and is not counted in the totals (credit is counted when it pays an invoice). A receipt paid from credit gives the credit back if it is undone.

**Invoice statuses:** Draft → Issued → Sent → Partially received → Received, or Cancelled.

---

## 8. Team work

- **Assign** a client (on its form) or an obligation (on its form) to a team member. An obligation with no person of its own follows the client's person.
- On **My Obligations**, choose **Assigned to: Me** to see your own work.
- **Bulk actions on My Obligations:** tick the rows, then choose:
  - **Only these clients** (see section 5);
  - **Data collection:** collected (today) or pending, for all of them;
  - **Assign to**;
  - **Archive**.

  Anything that cannot be done is listed with the reason, for example "the last period's dates are not confirmed yet".
- **Bulk actions on the Clients page:** assign or archive several clients at once.

---

## 9. Dashboard, calendar, reports and downloads

- **Dashboard:** overdue items, due in the next **7, 30 or 60 days**, reminders to send, dates to confirm, completed this month, open and overdue items by country, and fees not yet paid per currency. Click any number to see the list behind it.
- **Calendar:** every due date of a month, coloured by status, and the **planned** periods still to come (dashed), for as long as each obligation repeats. Choose the **Month** directly, use ‹ ›, or **Go to a date** to jump there (the day is marked). Filter by country or team member, and click an item to open it.
- **Reports** (choose the dates under **Show**):
  - **Obligations:** every period of those dates, with a count per status (filter by status);
  - **Overdue**;
  - **Upcoming** deadlines in the next 7, 30, 60 or 90 days;
  - **Invoices** and **Receipts** of those dates, with totals per currency;
  - **Clients summary:** per client, the periods due, completed, open and overdue, and what was invoiced, received and is outstanding;
  - **Invoice aging:** unpaid invoices by days since the invoice date (0–30, 31–60, 61–90, 90+), with totals per currency.
- **Downloads:** **Download (Excel)** gives a spreadsheet of what is on the screen, with the same filters. It works for clients, obligations, invoices, receipts, the reports and the logs. **Print / PDF** prints the list on A4.

---

## 10. Who can do what

Only the **ETAX administrator** sets each user's permissions, under Manage → Users. Your firm cannot change them. Ready-made sets are Full access, Preparer, Billing and Viewer, and each box can also be ticked separately.

| Permission | Allows |
|---|---|
| View clients and obligations | See clients, obligations and the calendar (every other permission includes this) |
| Create and edit clients | Add and change clients |
| Create and edit obligations and reminders | Add and change obligations, dates and reminders |
| Send WhatsApp messages | The WhatsApp buttons |
| Issue invoices and generate receipts | Invoices, receipts, advance payments, invoice taxes and items (and the money columns of the tracker) |
| Change the status of obligations | Data collection, task completed, reopen, "no invoice" |
| Manage message templates and custom fields | Setup pages, renaming headings |
| View the notifications dashboard and reports | Dashboard, Notifications, Reports |
| View and export the logs | WhatsApp log and activity log |
| Export data | The Excel downloads |
| Archive and restore | Archive and restore clients and obligations, and delete obligations |
| See portal passwords and PIN codes | Show password |
| Full access | Everything, including Settings and the invoice formats |

**Activity Log** (Logs → Activity Log) shows who did what and when in this module:
- clients added and changed;
- data collection, task and dates of obligations;
- reminders changed;
- invoices issued, sent and cancelled (with what became of the money), and receipts recorded and undone;
- reminders given by phone or email;
- custom fields changed;
- archiving, restoring and deleting (with the note);
- downloads and passwords shown.

You can search it and download it.

---

## 11. Good to know

**Do clients see anything?** No. Your clients never log in. They only receive your WhatsApp messages.

**Are reminders sent automatically?** No. ETAX works out when each reminder is due, highlights it and prepares the message, and a person presses Send in WhatsApp. Fully automatic sending would need the WhatsApp Business Platform (Meta approval and per-message fees). It can be added later if you want it.

**Why is something overdue when the client is in another country?** The due date is the client's own calendar day, in its time zone.

**What about quarterly or monthly returns?** Add one obligation per quarter (VAT Return Q1 to Q4) or per month, in one go with **+ Add another obligation**. Each comes back every year on its own dates, with its own reminders.

**Which year does a period belong to?** To the year of its **due date**. The income tax return for 1 Jul 2026 – 30 Jun 2027, due 30 Sep 2027, shows under 2027.

**Can I change one period's dates without affecting the rest?** Yes. Open the period and change its dates. Tick "Also use these dates for the periods after this one" only if the change applies to later periods too.

**Can something be undone?** Yes. Messages can be marked not sent, "sent" on an invoice undone, receipts undone (voided), invoices cancelled and periods reopened; each keeps its record and number. Clients are archived, not deleted. An obligation can be deleted, but once a message was sent for it only with a note, kept in the activity log.

**What if our access period with ETAX ends?** You can still log in, look, print and download, but you cannot make changes until ETAX renews it.

**Who do we ask?** Contact the ETAX administrator for access, permissions and renewals.

---

## For the ETAX administrator: switch the module on and give access

Only the ETAX administrator does this. A firm cannot switch the module on, or change anyone's permissions, by itself.

1. Log in to **etaxcloud.net/app** with the administrator login.
2. Open **Clients**, find the firm and click **Manage**.
3. On the **Overview** tab, under **Modules**, tick **Compliance & Deadlines** and save. The firm's owner now has **Full access** (only the first time the module is switched on).
4. Open the **Users** tab. Under each user's role you see **Compliance: …** with an **Edit** link.
5. Click **Edit**, choose a ready-made set (**Full access**, **Preparer**, **Billing**, **Viewer**, **No access**) or tick the boxes one by one, then click **Save**.

A change applies on the user's next click; they do not need to log in again.
