# Hosting, domain and accounts

_Last updated: 2026-11-09_

This page records where the live site runs, what each account is for, what it costs, what needs renewing and when, and
what to do when something breaks.

**This repository is public. No passwords, card details or keys go in this file.** Keep them in a password manager.

---

## 1. How a visit reaches the app

```
Visitor ──► etaxcloud.net ──► Render: web service "digital-invoicing" (Singapore, Starter plan)
            (DNS records      ├─ the website (/), the app (/app) and the API (/api)
             kept at Vercel)  ├─► Supabase Postgres (free plan): all the data
                              └─► static-IP proxy ──► FBR / PRA   (when it is set up: static-ip-proxy.md)
```

Since 2026-11-09 the site is served **straight from Render**. Vercel is no longer in the path: it only keeps the DNS
records of etaxcloud.net (section 5).

---

## 2. The accounts

| Service | What it does for ETAX | Plan and cost | Notes |
|---|---|---|---|
| **etaxcloud.net** (the domain) | The address clients type | Paid yearly. **Expires 2027-10-21** | The registrar is Name.com and the DNS is at Vercel. See section 4. |
| **Render** (dashboard.render.com) | Runs the app: website, app, API and background jobs | **Starter, $7/month** since 2026-11-09 (0.5 CPU, 512 MB RAM). Paid by the card on the Render account. | It never sleeps now. Every push to `main` on GitHub deploys automatically. |
| **Vercel** (vercel.com, team "finance", Hobby) | **Only the DNS records** of etaxcloud.net | Free | The Vercel project `digital-invoicing` no longer serves the site. |
| **Supabase** (supabase.com) | The database | **Free** (500 MB) | 22 MB was used on 2026-11-09. See section 7. |
| **GitHub** (`mohisn-bhatti/digital-invoicing`) | The code | Free, **public** repository | A push to `main` deploys the code to Render. |
| **https certificates** | The padlock for etaxcloud.net and www | Free, automatic | Render issues them from Google Trust Services. The current one is valid until 2027-02-07, and Render renews it by itself. |

The domain has **no email set up**: there are no MX records. If email `@etaxcloud.net` is wanted later, the email
provider's records go into the same Vercel DNS page (section 5).

---

## 3. Calendar: what renews when

| What | When | Renewed by | What you do |
|---|---|---|---|
| **Domain etaxcloud.net** | **2027-10-21**, then every year | **You** (or auto-renew, if it is on) | **Set a reminder for 2027-09-21.** Then follow section 4. |
| https certificate | About every 2–3 months | Render, automatically | Nothing to do. If Render shows "Certificate Error", see section 8. |
| Render Starter | Monthly | Automatic (card) | Keep the card on the Render account valid. |
| Vercel Hobby | Free | – | Fill in the billing address Vercel asks for, especially if the domain renews through Vercel (section 4). |
| Supabase free | – | – | Watch the database size (section 7). |

---

## 4. Renewing the domain

**Do this once, now: find out where the domain was bought.**

WHOIS lists **Name.com** as the registrar. The domain was registered on 2026-10-21 and used Vercel's nameservers from
the first day, so it may well have been bought **through Vercel's "Buy" button**. Vercel sells domains through a
partner registrar.

1. **Vercel** → click the team name **finance** (top left) → **Domains** → **etaxcloud.net**.
   - If the page shows the **expiry date** and a **Renew / Auto Renew** option, the domain was bought through Vercel.
     Renewal happens in Vercel, charged to the card on the Vercel account.
2. Otherwise it is in a **Name.com** account → **My Domains** → **etaxcloud.net**.

**Then, wherever it is:**

1. Turn **Auto Renew on**.
2. Make sure the **card and billing address** on that account are valid. Vercel was already asking for a billing
   address on 2026-11-09.
3. Around **2027-09-21**, check that it renewed, or renew it by hand for one year or more.
4. After renewing, check that nothing else changed:
   - The nameservers are still `ns1.vercel-dns.com` and `ns2.vercel-dns.com`.
   - The DNS records still match section 5.
   - To see the new expiry date: `whois etaxcloud.net | grep -i expir`.

**If the domain expires, etaxcloud.net stops working for everyone.** The app itself keeps running at
https://digital-invoicing.onrender.com/app. For a `.net` domain there is usually a grace period of about 30–45 days to
renew at the normal price. Then comes a redemption period of about 30 days with a large fee. After that, anyone can
register the name. Don't let it get that far.

---

## 5. DNS records (Vercel → Domains → etaxcloud.net → DNS Records)

| Name | Type | Value | Why |
|---|---|---|---|
| *(empty = the root)* | **ALIAS** | `digital-invoicing.onrender.com` | etaxcloud.net → Render. **Added by us.** |
| `www` | **CNAME** | `digital-invoicing.onrender.com` | www.etaxcloud.net → Render, which redirects it to etaxcloud.net. **Added by us.** |
| 🔒 *(empty)* | ALIAS | `cname.vercel-dns-017.com` | Vercel's automatic default. Ours overrides it, and it can't be deleted. |
| 🔒 `*` | ALIAS | `cname.vercel-dns-017.com` | Vercel's default for any other subdomain. |
| 🔒 *(empty)* | CAA | `letsencrypt.org`, `pki.goog`, `sectigo.com` | The certificate authorities allowed to issue for the domain. Render uses Google Trust Services (`pki.goog`). |

**Rules**

- **Use the ALIAS for the root, not an A record.** Render's setup screen suggests an A record of `216.24.57.1`.
  On 2026-11-09 that address could not be reached from our internet connection in Pakistan (the connection was reset),
  while the addresses behind `digital-invoicing.onrender.com` (`216.24.57.16` / `.18`) loaded fine. The ALIAS always
  follows Render's own name, so it gets the working addresses.
- **Don't add etaxcloud.net back to the Vercel project** under Project → Settings → Domains. That would send visitors
  through Vercel again.
- **Don't delete etaxcloud.net from the Vercel team.** That deletes these DNS records, and the site goes offline.
- Records are copied around the internet within minutes (they are set to last 60 seconds). An internet provider can
  keep an old answer for up to its old lifetime: Vercel's old defaults were 30 minutes.

**On Render** (digital-invoicing → **Settings → Custom Domains**):

- `etaxcloud.net`: Verified, Certificate Issued.
- `www.etaxcloud.net`: "redirects to etaxcloud.net", Verified, Certificate Issued.

---

## 6. Render

- **Service:** `digital-invoicing`, Node, region Singapore. **Starter** since 2026-11-09. Before that it was on the free
  plan, which slept after 15 idle minutes and took up to a minute to wake.
- **Deploys:** every push to `main` builds and starts the new version automatically. The build runs the database
  migrations ([render.yaml](../render.yaml) shows the commands). Migrations are applied to Supabase first, and
  **never with the seed** (the seed resets passwords).
- **Health checks:**
  - `/healthz` answers as long as the server runs. Render uses it, and it does not touch the database.
  - `/api/health` also checks the database.
- **Environment variables** live in the Render dashboard, never in the repo: `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`,
  `ENCRYPTION_KEY`, `FBR_MOCK`, `FBR_PROXY_URL`, `PRA_MOCK`, `PRA_PROXY_URL`, `TRUST_PROXY_HOPS` and `CONTACT_*`.
  - **Never change `ENCRYPTION_KEY`.** Saved FBR/PRA tokens and portal passwords would become unreadable.
  - **`TRUST_PROXY_HOPS` must be `1`** now that only Render is in front of the app. (`2` was only for the time a Vercel
    domain forwarded to Render.) A wrong value would let someone fake their IP address in the login lock-out.
- **Outgoing IP:** Render's outgoing addresses are shared and can change. That is why FBR and PRA need the static-IP
  proxy ([static-ip-proxy.md](static-ip-proxy.md)).

---

## 7. Supabase (database)

**Free-plan limits**

- **500 MB of database.** Above that, **the database becomes read-only**: new invoices and sales would fail to save.
- **5 GB of data transfer a month.**
- **No automatic backups.** See [backups.md](backups.md).
- It **pauses after 7 days with no activity**. This won't happen now: the always-on Render server uses the database
  every 10 minutes for its background jobs.

**Size on 2026-11-09: 22.35 MB of 500 MB (4.5%)**

| Part | Size |
|---|---|
| Postgres's own system tables (fixed) | 10.5 MB |
| Reference data (HS codes 4.5 MB, legal references 2.7 MB) | 7.3 MB |
| Supabase's own parts (logins, storage…) | 1.4 MB |
| Business data (sales, activity log, clients, products, sandbox tests) | about 3 MB |

**Growth:** about **1.5 MB a month** so far, mostly testing. Real use grows faster:

- A Point of Sale sale with its lines and events takes roughly **2–5 KB**.
- For example, 10 shops × 100 sales a day ≈ **60–150 MB a month**, which would fill 500 MB in about 3–8 months.

**How to check:**

- Supabase dashboard → your organisation → **Usage**.
- Or in the **SQL Editor**: `select pg_size_pretty(pg_database_size(current_database()));`

**When to upgrade:** at about **350–400 MB**, move to **Pro** ($25/month, 8 GB). Do it before reaching 500 MB.

---

## 8. When something breaks

Open these in order:

1. **https://digital-invoicing.onrender.com/healthz** → `{"ok":true}` means the server is running.
   - If not, go to Render → digital-invoicing → **Events** and **Logs**.
2. **https://etaxcloud.net/api/health** → `{"ok":true}` means the server *and* the database are fine.
   - If (1) works but this fails or hangs, the problem is the database. Check status.supabase.com and the connection
     settings in `DATABASE_URL`.
3. **It works at digital-invoicing.onrender.com but not at etaxcloud.net** → the problem is the domain, the DNS or the
   certificate:
   - `dig +short etaxcloud.net` must give Render addresses (`216.24.57.x`). Vercel addresses (`216.198.79.x`,
     `64.29.17.x`) mean the DNS records were changed (section 5).
   - Check Render → **Custom Domains**: both rows should be Verified and Certificate Issued.
   - `whois etaxcloud.net | grep -i expir`: has the domain expired (section 4)?
4. **Render shows "Certificate Error"**:
   - Click **↻** next to the domain and wait a few minutes.
   - If it stays, click **⋯ → Delete** on that domain and add `etaxcloud.net` again. The DNS needs no change. That is
     what fixed it on 2026-11-09.
5. **The app shows "This page did not start"**: the page's own files did not arrive within 10 seconds. That is the
   network between the visitor and the host, not the server. Compare with https://digital-invoicing.onrender.com/app.
6. **Emergency address for clients:** **https://digital-invoicing.onrender.com/app**. It is the same app, with the same
   data and the same logins.

---

## 9. History

- **2026-10-06:** Supabase, Render (free) and Vercel (free) chosen.
- **2026-10-21:** etaxcloud.net registered. Vercel served the website files and forwarded `/api` to Render.
- **2026-11-08:** the app hung on the loading screen. The causes were the free Render server waking up, a health check
  that waited for the database, and a flaky database connection. Fixed in commit `3a43b76`.
- **2026-11-09:** Render was upgraded to **Starter** ($7/month), but clients still saw "This page did not start" on
  etaxcloud.net.
  - Measured from Pakistan, five loads each, time to the login screen:
    - through Vercel: **13 s, 21 s, 43 s, 57 s and never**;
    - Render directly: **3–6 s**.
  - Vercel answered from Singapore; Render's Cloudflare network answers from Karachi.
  - etaxcloud.net was moved straight to Render:
    1. The domain was removed from the Vercel project.
    2. A root ALIAS and a www CNAME to `digital-invoicing.onrender.com` were added.
    3. Both domains were added under Render → Custom Domains.
    4. The root certificate needed one delete-and-re-add in Render.
  - Afterwards: **2–5 s**.
