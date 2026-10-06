# Static IP for FBR calls (free option)

FBR/PRAL only accepts API calls from whitelisted IPs (max 3 per taxpayer in IRIS).
Render's free plan sends traffic from shared, changing IPs, so FBR calls go through a small proxy with one fixed IP.
TLS to `gw.fbr.gov.pk` is end-to-end through the proxy tunnel; the proxy cannot see invoice data or tokens.

## Option A — Oracle Cloud "Always Free" VM + tinyproxy ($0)
1. Sign up at cloud.oracle.com (card needed for verification; Always Free resources are not charged).
   Pick a home region near Pakistan if offered (e.g. Mumbai / Hyderabad / Dubai / Jeddah).
2. Create a Compute instance: **VM.Standard.E2.1.Micro** (Always Free), image **Ubuntu 24.04**.
3. Networking → the instance's VNIC → IPv4 → make the public IP **Reserved** so it never changes.
4. VCN → Security List → add Ingress rule: TCP **8888** from `0.0.0.0/0`.
5. SSH in and run:
```bash
sudo apt update && sudo apt install -y tinyproxy
PASS=$(openssl rand -hex 24); echo "Proxy password: $PASS"

sudo tee /etc/tinyproxy/tinyproxy.conf >/dev/null <<EOF
User tinyproxy
Group tinyproxy
Port 8888
Listen 0.0.0.0
Timeout 60
MaxClients 50
LogLevel Warning
BasicAuth fbr $PASS
ConnectPort 443
FilterDefaultDeny Yes
FilterExtended On
Filter "/etc/tinyproxy/filter"
DisableViaHeader Yes
EOF

# Only these hosts can be reached through the proxy
printf '^gw\\.fbr\\.gov\\.pk$\n^api\\.ipify\\.org$\n' | sudo tee /etc/tinyproxy/filter

# Oracle's Ubuntu image blocks ports with iptables by default
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8888 -j ACCEPT
sudo netfilter-persistent save

sudo systemctl restart tinyproxy && sudo systemctl enable tinyproxy
curl -s https://api.ipify.org; echo   # this is the IP to whitelist in IRIS
```
6. On Render set `FBR_PROXY_URL=http://fbr:<PASS>@<RESERVED_IP>:8888`.
7. Log in as super admin → **Check** "IP for FBR whitelisting" → it should show the Oracle IP "(via static proxy)".

## Option B — paid, zero maintenance
QuotaGuard Static (~$29/month), or Render Dedicated IPs ($100/month, then leave `FBR_PROXY_URL` empty).

## Sandbox testing without any proxy
While only testing scenarios, run the app on your own machine (`FBR_MOCK=false npm run dev`) and whitelist your
home/office public IP in IRIS. Home connections (PTCL, etc.) often get a new IP after a router restart — update IRIS if it changes.
