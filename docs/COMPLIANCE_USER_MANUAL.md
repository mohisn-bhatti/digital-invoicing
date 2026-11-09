# Compliance & Deadlines — User Manual

_ETAX · November 2026_

Compliance & Deadlines keeps your firm's clients anywhere in the world in one place, along with their statutory deadlines every year, the reminders you send them on WhatsApp, and the fee invoices for the work. It is part of ETAX (etaxcloud.net), next to FBR Digital Invoicing and the Point of Sale.

---

## 1. Getting started

**Who can use it.** The ETAX administrator switches the module on for your firm. The administrator also decides what each of your users may do (see section 9). Your firm's owner gets full access the first time the module is switched on.

**Logging in.** Go to **etaxcloud.net/app** and log in with your ETAX email and password. If your firm uses more than one ETAX product, choose **Compliance & Deadlines** on the next screen. To change product later, click **Switch** at the top of the menu.

**The work in one minute:**

1. Add a **client**: choose the country first, then fill in the details.
2. Add the client's **obligations**, such as a VAT return or corporate tax, with their dates and **reminders**.
3. When a reminder comes due, it is **highlighted**. Click **WhatsApp**, check the message, and press Send in WhatsApp.
4. Move the period through its **steps** (Data collected, Filed, Paid).
5. **Complete** it: either **generate an invoice** for your fee, or **close it without an invoice**.
6. Record the **payment** and send the **receipt**.
7. The next period is prepared for you, and the cycle starts again.

**The menu:**

| Page | What it is for |
|---|---|
| Dashboard | Overdue items, items due in the next 7, 30 or 60 days, and fees not yet paid |
| Notifications | Every obligation whose reminders are running, with its WhatsApp buttons |
| My Tasks | What is assigned to you |
| Obligations | Every period of every obligation, with filters and bulk actions |
| Clients | Your clients and their 360° page |
| Calendar | Every due date of the month |
| Invoices | Fee invoices and receipts |
| Reports | Overdue list, upcoming deadlines, invoice aging |
| Logs | The WhatsApp log and the activity log |
| Setup | Message templates, custom fields, invoice taxes, settings |

You see only the pages your permissions allow. For safety, you are signed out after 30 minutes without activity.

---

## 2. First-time setup (do this once)

Open **Setup → Settings**. Only a user with full access can change these.

- **Your firm's time zone.** The times shown in the logs and lists use it.
- **Reminders come due at.** The hour at which a reminder becomes active, on each client's own clock. The default is 09:00.
- **Turn amber this many days before the due date.** The default is 7.
- **Prepare the next period by itself.** When a period ends, the next one is created with the same dates one period later, for you to confirm.
- **Your WhatsApp numbers.** Add the number(s) your firm sends from, for example "Business WhatsApp" with its full number including the country code. Choose how it opens:
  - **WhatsApp Web.** Log in at web.whatsapp.com with that number in the browser you use for ETAX. This is the best choice on a computer.
  - **WhatsApp Business app.** On an Android phone it opens the Business app directly.
  - **WhatsApp app**, or **Let the device choose**.

  Tick one number as the **Default**.
- **On your invoices and receipts:** your firm's name, address, phone, email, tax registration number (if registered), bank details and a footer line. Also set the number formats. For example, `INV-{YYYY}-{NNNN}` gives INV-2027-0001. Numbers are taken when an invoice is issued and never reused.

**Setup → Message Templates.** Write the messages you send. Words in square brackets are replaced with the client's real details when you send:

> Dear [Client Name], your VAT return for the period [Period Start] to [Period End] is due on [Due Date]. Kindly share the required documents.

| Placeholder | Becomes |
|---|---|
| [Client Name], [Email], [Contact Number], [Address], [Reference], [Country], [Registration No.] | The client's details |
| [Obligation], [Period Start], [Period End], [Due Date] | The obligation period |
| [Invoice Number], [Invoice Amount], [Receipt Number] | The invoice or receipt |
| [Any custom field name] | That field's value, e.g. [Trade License Number] |

Click a placeholder under the message box to insert it. The preview shows the message with a sample client. Give each template a purpose (Reminder, Data collection, Obligation completed, Invoice, Receipt or Other), so the right one is offered first. Passwords and PINs are never put in messages.

**Setup → Custom Fields.** Add extra client details, such as a Trade License Number, UDIN or License Expiry Date. Choose a type (text, number, date or multi-line text) and the countries the field is for: one country, several, or all. The field then shows on every client of those countries. It is marked **Missing** until filled in, and it never shows on clients of other countries.

**Setup → Invoice Taxes.** Taxes you add to fee invoices, such as VAT 5% for the UAE. Each tax is suggested on the invoices of clients of its countries. The same name can have different rates in different countries, for example VAT 5% in the UAE and 15% in Saudi Arabia. You can also add a tax while writing an invoice (section 6).

---

## 3. Clients

**Add a client:** go to **Clients**, then **+ Add client**.

1. **Choose the country first.** Its flag appears, and everything after follows that country: the time zone, the dialling code, the currency, and which extra fields show.
2. Fill in the **client name** and **contact number** (the WhatsApp messages go to it). Add the email, address, registration no. and reference if you have them.
3. **Online portal login:** the username and password are required. If the client has no online portal, tick **This client has no online portal** instead of typing "NA". The PIN is optional.
4. **Time zone.** It is set from the country. Where a country has several (e.g. the USA), pick the right one. Due dates and reminders follow the client's own clock.
5. **Assigned to** (optional): the team member who looks after this client.
6. **Additional information:** the custom fields for this country. With setup permission you can add a new field right here.

**Passwords are safe.** The portal password and PIN are stored encrypted and never shown in lists. On the client's page, **Show password** displays them for one minute, only to users allowed to see passwords, and each time is written in the activity log.

**The client's 360° page** (click a client) shows everything in one place:
- details and additional information (missing items marked);
- every obligation with each period's status;
- invoices and receipts;
- every WhatsApp message;
- the client's history.

**Archive** a client you no longer serve. It disappears from the lists, dashboards and reminders, but nothing is deleted. Tick **Archived clients** on the Clients page to find it, and **Restore** it at any time.

---

## 4. Obligations and periods

**Add an obligation:** on the client's page, click **+ Obligation**.

- **Start from what other clients of this country have.** This optional list offers the obligations you already use for clients of the same country, with their dates and reminders. Pick one, then check the dates.
- **Obligation:** e.g. VAT Return, Corporate Tax Return, Trade License renewal.
- **Comes back:** every year, every quarter or every month. A monthly sales tax return is one obligation that produces a period each month.
- **For:** no end, or a number of years (1, 2, 3, 5, 10 or your own number).
- **Period start, period end and due date:** you type them, nothing is calculated. The period end cannot be before the start, and the due date cannot be before the period end.
- **Portal link** (optional): opens the e-filing portal in one click.
- **Assigned to** (optional): otherwise the client's person.
- **Reminders:** add as many as you need. For each one, choose how many days **before**, **on** or **after** the due date, and the **message template**. The reminders apply to every period of the obligation.

**Periods and their dates.** Each repetition (a year, a quarter or a month) is a period. The next period is proposed with the same dates one period later, and shows **dates to confirm** until you check it. Open a period from any list to:
- **change its dates**: only this period, or tick **Also use these dates for the periods after this one**;
- click **Dates are right** to confirm copied dates;
- add notes for this period.

**Statuses:**

| Status | Meaning |
|---|---|
| Upcoming | The period has not ended yet |
| Period closed | The period has ended; the work can start |
| Data collected / Filed / Paid | Steps you set as the work goes on |
| Overdue | The due date has passed and it is not completed. It stays overdue until it is completed |
| Completed | Done (with or without an invoice) |

**Colours:** green = safe, amber = approaching or a reminder to send, red = overdue, grey = completed.

The due date is the client's own calendar day. A UAE obligation becomes overdue at midnight in Dubai.

---

## 5. Reminders and WhatsApp

**Notifications page.** It shows every obligation from the end of its period until it is completed. Overdue ones come first, then those with a reminder to send. Each reminder appears in one of these states:

| Shown as | Meaning |
|---|---|
| **Send now** (amber, green WhatsApp button) | Its time has come: send it |
| Not sent (amber outline) | Its time came and went without a message; you can still send it |
| ✓ Sent | A message went for it (with the date) |
| Grey "activates on …" | Its time has not come; the button appears then |

A bell number in the menu and a pop-up when you open the module tell you when reminders are ready.

**Sending a message:**

1. Click **WhatsApp** on a reminder, or **Other message** for anything else (e.g. asking for documents).
2. The window shows the **number** it goes to, the **template**, **Send from** (your firm's number), and the **message** filled in with the client's details. Change anything you like.
3. Click **Open WhatsApp**. WhatsApp opens with the text ready. Press **Send** in WhatsApp.

**Important:**
- **Messages are not sent automatically.** ETAX tells you when, prepares the message and opens WhatsApp, but a person presses Send.
- WhatsApp always sends from the account that is open on your computer or phone. Choose your business number under **Send from**, and make sure WhatsApp Web (or the app) is logged in with that number. The window reminds you which one.
- The message goes to the client's **WhatsApp Number** custom field if there is one, otherwise to the contact number.

**WhatsApp Log** (Logs → WhatsApp Log) records every message:
- the time, client, obligation period or invoice, and template;
- the to and from numbers;
- the final text and who sent it.

If you did not actually send a message after WhatsApp opened, click **Mark not sent**. It stays in the log crossed out, and its reminder becomes due again.

---

## 6. Completing work, invoices and receipts

**Steps.** In a period's window, set the step (Open, Data collected, Filed or Paid) as the work goes on.

**Complete.** Click **✓ Complete** and choose:
- **Generate invoice:** the period is completed and a draft invoice opens with the client and the period filled in.
- **Close without invoice:** for free work for family, friends or goodwill.

Then you can let the client know on WhatsApp with a "completed" template.

**The draft invoice:**
- **Currency:** the client's country's currency (e.g. AED for the UAE). You can change it to any other.
- **Fee:** type the amount. Add more lines if needed.
- **Taxes:** pick a saved tax, or click **+ New tax** and type its name and rate (e.g. VAT, 5%). You can add as many as needed; each is worked out on the subtotal. Tick **Keep for [country] clients** to have it suggested next time for that country.
- Optionally set the **invoice date** (empty = the day you issue it), the **payment due** date and notes.
- **Save draft** to finish later, or **Save and issue**. Issuing gives the invoice its number, and it can no longer be changed.

**An issued invoice:**
- **Print / PDF:** an A4 invoice with your firm's details and bank details. Choose "Save as PDF" in the print window to get a file.
- **WhatsApp:** sends it using an "Invoice" template, and marks it **Sent**.
- **Record payment:** amount, date, how it was paid and a reference. This creates a numbered **receipt**. The status becomes **Partially received** or **Received**. You cannot record more than is still owed.
- **Cancel invoice:** with a reason. It keeps its number and stays in the list as cancelled. If money was received, void the receipts first.

**Receipts** can be printed, sent on WhatsApp, or **voided** with a reason (e.g. a bounced cheque). A voided receipt stays in the list crossed out, and the money is owed again.

**Invoice statuses:** Draft → Issued → Sent → Partially received → Received, or Cancelled.

---

## 7. Team work

- **Assign** a client (on its form) or an obligation (on its form) to a team member. An obligation with no person of its own follows the client's person.
- **My Tasks** shows the open periods assigned to you, with what is overdue and which reminders are ready, plus your clients.
- **Bulk actions on the Obligations page:** tick the rows, then choose:
  - **Next period:** prepares the next period for all of them in one go (they must be clients of one country);
  - **Set step**;
  - **Assign to**;
  - **Archive**.

  Anything that cannot be done is listed with the reason, for example "the last period's dates are not confirmed yet".
- **Bulk actions on the Clients page:** assign or archive several clients at once.

---

## 8. Dashboard, calendar, reports and downloads

- **Dashboard:** overdue items, due in the next **7, 30 or 60 days**, reminders to send, dates to confirm, completed this month, open and overdue items by country, and fees not yet paid per currency. Click any number to see the list behind it.
- **Calendar:** every due date of the month, coloured by status. Filter by country or team member, and click an item to open it.
- **Reports:**
  - **Overdue list.**
  - **Upcoming deadlines** in the next 7, 30, 60 or 90 days.
  - **Invoice aging:** unpaid invoices by days since the invoice date (0–30, 31–60, 61–90, 90+), with totals per currency.
- **Downloads:** **Download (Excel)** gives a spreadsheet of what is on the screen, with the same filters. It works for clients, obligations, invoices, receipts, the reports and the logs. **Print / PDF** prints the list on A4.

---

## 9. Who can do what

Only the **ETAX administrator** sets each user's permissions, under Manage → Users. Your firm cannot change them. Ready-made sets are Full access, Preparer, Billing and Viewer, and each box can also be ticked separately.

| Permission | Allows |
|---|---|
| View clients and obligations | See clients, obligations, the calendar and My Tasks (every other permission includes this) |
| Create and edit clients | Add and change clients |
| Create and edit obligations and reminders | Add and change obligations, dates and reminders |
| Send WhatsApp messages | The WhatsApp buttons |
| Issue invoices and generate receipts | Invoices, receipts and invoice taxes |
| Change the status of obligations | Steps, complete, reopen |
| Manage message templates and custom fields | Setup pages |
| View the notifications dashboard and reports | Dashboard, Notifications, Reports |
| View and export the logs | WhatsApp log and activity log |
| Export data | The Excel downloads |
| Archive and restore | Archive and restore clients and obligations |
| See portal passwords and PIN codes | Show password |
| Full access | Everything, including Settings |

**Activity Log** (Logs → Activity Log) shows who did what and when in this module:
- clients added and changed;
- obligation steps and dates;
- reminders changed;
- invoices issued and payments recorded;
- custom fields changed;
- archiving and restoring;
- downloads and passwords shown.

You can search it and download it.

---

## 10. Good to know

**Do clients see anything?** No. Your clients never log in. They only receive your WhatsApp messages.

**Are reminders sent automatically?** No. ETAX works out when each reminder is due, highlights it and prepares the message, and a person presses Send in WhatsApp. Fully automatic sending would need the WhatsApp Business Platform (Meta approval and per-message fees). It can be added later if you want it.

**Why is something overdue when the client is in another country?** The due date is the client's own calendar day, in its time zone.

**What about quarterly or monthly returns?** Choose "Every quarter" or "Every month" when adding the obligation. Each period gets its own dates and reminders.

**Can I change one period's dates without affecting the rest?** Yes. Open the period and change its dates. Tick "Also use these dates for the periods after this one" only if the change applies to later periods too.

**Nothing is ever deleted by mistake.** Clients and obligations are archived, not deleted. Messages can be marked not sent, receipts voided, and invoices cancelled; each keeps its record and number.

**What if our access period with ETAX ends?** You can still log in, look, print and download, but you cannot make changes until ETAX renews it.

**Who do we ask?** Contact the ETAX administrator for access, permissions and renewals.
