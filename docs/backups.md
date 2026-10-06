# Backups

FBR requires invoice records and logs to be kept for **6 years** (Sales Tax Act s.24, Rule 150S). Supabase's free plan
has no backups, so take your own.

## One-off
```bash
# in .env: BACKUP_PASSPHRASE="a long passphrase"  (store it separately — without it a backup can't be opened)
npm run backup                 # Supabase → backups/raseed-supabase-YYYY-MM-DD-HHmm.sql.gz.enc
npm run backup -- --local      # the local dev database instead
npm run backup -- --prune      # also tidy up: keep the last 30 days + the first backup of every month
```
- pg_dump runs from Docker (`postgres:<server version>-alpine`) if it isn't installed, so Docker Desktop must be running.
- `backups/` is in `.gitignore`. **Never commit or upload backups to GitHub**: the repo is public and backups contain
  every client's data.
- Copy the encrypted files somewhere off this computer as well, e.g. Google Drive or an external disk.

## Check that a backup really restores (do this once a month)
```bash
docker exec fbr-local-db psql -U postgres -c "CREATE DATABASE restore_check"
npm run backup:restore -- backups/<file>.sql.gz.enc --to "postgresql://postgres:postgres@localhost:54329/restore_check"
docker exec fbr-local-db psql -U postgres -d restore_check -c 'select count(*) from "Invoice"'
docker exec fbr-local-db psql -U postgres -c "DROP DATABASE restore_check"
```
The restore refuses to write over the Supabase database unless you add `--i-know-this-overwrites`.

## Every day, automatically

**On this Mac (launchd).** It only runs while the Mac is on. Save the following as
`~/Library/LaunchAgents/pk.raseed.backup.plist`, then run `launchctl load ~/Library/LaunchAgents/pk.raseed.backup.plist`.
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>pk.raseed.backup</string>
  <key>WorkingDirectory</key><string>/Users/muhammadwaqas/Documents/digital-invoice</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>npm run backup -- --prune</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>/tmp/raseed-backup.log</string>
  <key>StandardErrorPath</key><string>/tmp/raseed-backup.log</string>
</dict></plist>
```

**On the Oracle proxy VM (always on, recommended once it exists).** Install `postgresql-client` and Node, clone the
repo, put `SUPABASE_DIRECT_URL` and `BACKUP_PASSPHRASE` in `.env`, then add a crontab line:
`0 2 * * * cd ~/digital-invoice && npm run backup -- --prune >> ~/backup.log 2>&1`
