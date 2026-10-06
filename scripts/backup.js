// Database backup for the FBR 6-year record-keeping requirement (Supabase free has no backups).
//
//   npm run backup                 → backs up Supabase (SUPABASE_DIRECT_URL)
//   npm run backup -- --local      → backs up the local dev database (DIRECT_URL)
//   npm run backup -- --prune      → also deletes old backups (keeps last 30 days + the first backup of every month)
//
// Output: backups/raseed-<db>-YYYY-MM-DD-HHmm.sql.gz.enc  (AES-256-GCM, key from BACKUP_PASSPHRASE)
//         or .sql.gz without a passphrase (a warning is printed — keep such files somewhere private).
// pg_dump runs from the local install if present, otherwise inside Docker (postgres:17-alpine).
// Never commit backups: they contain every client's data (backups/ is in .gitignore).
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'backups');
const MAGIC = Buffer.from('RSDBK1'); // file header for encrypted backups

function stamp(d = new Date()) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
        .formatToParts(d).reduce((a, x) => ({ ...a, [x.type]: x.value }), {});
    return `${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}`;
}

// Encrypted format: MAGIC | salt(16) | iv(12) | ciphertext | tag(16); key = scrypt(passphrase, salt)
function encryptStream(passphrase) {
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(passphrase, salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let headerSent = false;
    const { Transform } = require('stream');
    return new Transform({
        transform(chunk, enc, cb) {
            if (!headerSent) { this.push(Buffer.concat([MAGIC, salt, iv])); headerSent = true; }
            cb(null, cipher.update(chunk));
        },
        flush(cb) {
            if (!headerSent) this.push(Buffer.concat([MAGIC, salt, iv]));
            this.push(cipher.final()); this.push(cipher.getAuthTag()); cb();
        },
    });
}

// Docker: "localhost" inside the container is the container itself
const dockerUrl = url => url.replace(/@(localhost|127\.0\.0\.1)(:\d+)?\//, (m, h, port) => `@host.docker.internal${port || ''}/`);

// pg_dump should match the server's major version (Supabase: 15/17, local: 16)
function serverMajor(url) {
    const r = spawnSync('docker', ['run', '--rm', 'postgres:17-alpine', 'psql', '-tA', '-c', 'show server_version_num', dockerUrl(url)], { encoding: 'utf8' });
    const n = Number(String(r.stdout).trim());
    if (!n) throw new Error(`Could not reach the database: ${String(r.stderr).trim().split('\n').pop()}`);
    return Math.floor(n / 10000);
}

function pgDumpCommand(url) {
    const args = ['--no-owner', '--no-privileges', '--schema=public', '--format=plain'];
    if (spawnSync('pg_dump', ['--version']).status === 0) return ['pg_dump', [...args, url]];
    return ['docker', ['run', '--rm', `postgres:${serverMajor(url)}-alpine`, 'pg_dump', ...args, dockerUrl(url)]];
}

function prune() {
    // keep: everything from the last 30 days, and the oldest backup of each calendar month (monthly archive)
    const files = fs.readdirSync(DIR).filter(f => /^raseed-.+-\d{4}-\d{2}-\d{2}-\d{4}\.sql\.gz(\.enc)?$/.test(f)).sort();
    const keepMonth = new Map();
    for (const f of files) { const m = f.match(/(\d{4}-\d{2})-\d{2}-\d{4}/)[1]; if (!keepMonth.has(m)) keepMonth.set(m, f); }
    const cutoff = Date.now() - 30 * 86400000;
    let removed = 0;
    for (const f of files) {
        const day = f.match(/(\d{4}-\d{2}-\d{2})-\d{4}/)[1];
        if (Date.parse(day) >= cutoff || [...keepMonth.values()].includes(f)) continue;
        fs.unlinkSync(path.join(DIR, f)); removed++;
    }
    console.log(`prune: removed ${removed} old backup(s); kept ${files.length - removed}`);
}

async function main() {
    const local = process.argv.includes('--local');
    const url = local ? process.env.DIRECT_URL : process.env.SUPABASE_DIRECT_URL;
    if (!url) throw new Error(local ? 'Set DIRECT_URL in .env' : 'Set SUPABASE_DIRECT_URL in .env');
    fs.mkdirSync(DIR, { recursive: true });
    const pass = process.env.BACKUP_PASSPHRASE || '';
    const name = `raseed-${local ? 'local' : 'supabase'}-${stamp()}.sql.gz${pass ? '.enc' : ''}`;
    const file = path.join(DIR, name);
    if (!pass) console.warn('⚠ BACKUP_PASSPHRASE is not set — this backup is NOT encrypted. Store it somewhere private.');

    const [cmd, args] = pgDumpCommand(url);
    const dump = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    dump.stderr.on('data', d => { err += d; });
    const out = fs.createWriteStream(file, { mode: 0o600 });
    let stream = dump.stdout.pipe(zlib.createGzip({ level: 9 }));
    if (pass) stream = stream.pipe(encryptStream(pass));
    stream.pipe(out);
    const code = await new Promise(res => dump.on('close', res));
    await new Promise(res => out.on('close', res));
    if (code !== 0) { fs.rmSync(file, { force: true }); throw new Error(`pg_dump failed (${code}): ${err.trim().split('\n').pop()}`); }
    const size = fs.statSync(file).size;
    if (size < 200) { fs.rmSync(file, { force: true }); throw new Error('Backup is unexpectedly small — not kept.'); }
    console.log(`✔ backup written: backups/${name} (${(size / 1024).toFixed(1)} KB)`);
    if (process.argv.includes('--prune')) prune();
}

main().catch(e => { console.error('✖', e.message); process.exit(1); });
