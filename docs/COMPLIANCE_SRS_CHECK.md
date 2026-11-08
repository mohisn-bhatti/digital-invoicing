# Compliance & Deadlines: the SRS, requirement by requirement

The SRS "Global Statutory Deadline, Compliance, Invoice & Communication Module" (November 2026), checked against what is built.
How it works: [COMPLIANCE_MODULE.md](COMPLIANCE_MODULE.md). ✓ = built and covered by tests; ◐ = built with a stated limit.

| SRS | Requirement | Status | Where / how |
|---|---|---|---|
| 2 | Multiple users, role-based permissions | ✓ | Per-user permissions, set by the ETAX administrator (the user's decision) |
| 2 | The nine permissions listed | ✓ | `public/cmp-perms.js` (+ SECRETS, FULL) |
| 2 | Administrator full access | ✓ | FULL; owners get it when the module is first switched on |
| 2 | Enforced server-side at every action | ✓ | `routes.js`; `test/cmpRouteGuards.test.js` |
| 3.1 | Country first, flag shown at once | ✓ | Client form |
| 3.1 | Later suggestions and fields filtered to that country | ✓ | Fields, obligation suggestions, taxes |
| 3.2 | Basic fields; username and password mandatory; PIN optional | ✓ | Plus "no online portal" (the CA's answer) |
| 3.3 | Unlimited extra fields; default the client's country; several or all countries | ✓ | Custom fields |
| 3.3 | Shown for future clients, "Missing" on existing ones, never elsewhere | ✓ | |
| 3.3 | Text, number, date, multi-line | ✓ | |
| 4 | Any number of obligations per client | ✓ | |
| 4 | Period start, end, due date entered manually; no calculation | ✓ | Next period proposed as a copy, confirmed by a person |
| 4 | Date logic | ✓ | `datesProblem` |
| 4 | Suggestions from other clients of the same country | ✓ | Names, dates, reminders |
| 4 | Portal link per obligation | ✓ | Opens the portal; credentials shown with SECRETS |
| 4 | Repeats yearly by default; limit to N years or unlimited | ✓ | Also quarterly and monthly (the CA) |
| 4 | Individual years can be overridden | ✓ | One period, or "the periods after" |
| 4 | Statuses incl. Overdue | ✓ | Upcoming, Period closed, Data collected, Filed, Paid, Completed, Overdue |
| 4, 10 | Assign obligations and clients to team members | ✓ | My Tasks |
| 5 | Multiple reminders, each with a template; before/on/after; every year | ✓ | |
| 6 | After period end, show the upcoming reminders | ✓ | Notifications page |
| 6 | Next reminder highlighted; later ones bleak until their time | ✓ | `reminderStates` |
| 6 | WhatsApp enabled only when its time arrives; click to send | ✓ | Also refused by the server |
| 6 | Automatically Overdue if not closed by the due date | ✓ | Until completed (the CA) |
| 6 | Green / amber / red / grey | ✓ | |
| 6 | Time-zone aware (client's country or user-defined) | ✓ | Per-client zone; firm zone for logs |
| 7 | Unlimited templates with the listed placeholders and custom fields | ✓ | |
| 7 | Templates for reminders, completion, invoices and receipts | ✓ | |
| 8 | Send WhatsApp on active reminders, invoices, receipts, completion | ✓ | |
| 8 | Opens WhatsApp Web or app, text filled in, editable | ✓ | Plus "Send from" the firm's own numbers (the user's request) |
| 8 | Number from Contact Number or a "WhatsApp Number" field | ✓ | |
| 8 | Complete message log with date, client, document, template, final text | ◐ | Logs what is handed to WhatsApp; "mark not sent" if not sent |
| 9 | Completed → "Generate Invoice" or "Close Without Invoice" | ✓ | |
| 9 | Fee entered manually, rest pre-filled | ✓ | |
| 9 | Currency from the client's country, changeable, major currencies | ✓ | 151 currencies; 3-decimal currencies exact |
| 9 | Draft, Issued, Sent, Partially Received, Received | ✓ | Plus Cancelled |
| 9 | Receipt for an issued invoice | ✓ | Numbered, printable, voidable |
| 9 | WhatsApp on invoice and receipt | ✓ | |
| 9 (CA) | Several taxes per invoice, saved per country and suggested | ✓ | Setup → Invoice Taxes |
| 10 | Search and filters (country, status, due range, overdue, name, assignee) | ✓ | Archived searchable apart |
| 10 | Bulk: next year's obligations for clients of one country | ✓ | Plus step, assign, archive |
| 11 | Compliance dashboard, 7/30/60-day windows, flags | ✓ | |
| 11 | Notifications & popups dashboard | ✓ | |
| 11 | Calendar | ✓ | |
| 11 | Client 360° | ✓ | Details, fields, obligations, invoices, messages, history |
| 11 | My Tasks; message log per client and global | ✓ | |
| 11 | Overdue, upcoming, invoice aging reports | ✓ | Aging per currency |
| 12 | Activity log of the listed actions, viewable and exportable | ✓ | Firm sees only its compliance actions |
| 13 | Export to Excel and/or PDF, respecting permissions and filters | ✓ | CSV for Excel; print to PDF |
| 14 | Archive instead of delete; searchable; restorable | ✓ | |
| 15 | Email, phone, mandatory fields, date logic, other checks | ✓ | `validate.js` |
| 16 | New fields and templates without code changes | ✓ | |
| 16 | Passwords and PINs encrypted | ✓ | AES-256-GCM |
| 16 | Session timeout and secure login | ◐ | 30-minute idle sign-out in the browser; platform login rules |
