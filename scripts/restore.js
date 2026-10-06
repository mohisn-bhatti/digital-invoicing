// Restore a backup into a database — to check backups really work, or to recover.
//
//   npm run backup:restore -- backups/<file>.sql.gz[.enc] --to "postgresql://…/target_db"
//
// The target should be an EMPTY database (e.g. a fresh local one). It refuses the Supabase URL from .env
// unless --i-know-this-overwrites is given. psql runs locally if installed, otherwise in Docker.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const MAGIC = Buffer.from('RSDBK1');

function decrypt(buf, passphrase) {
    if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a Raseed encrypted backup.');
    const salt = buf.subarray(6, 22), iv = buf.subarray(22, 34), tag = buf.subarray(buf.length - 16), body = buf.subarray(34, buf.length - 16);
    const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(passphrase, salt, 32), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]); // throws if the passphrase is wrong or the file was changed
}

async function main() {
    const file = process.argv[2];
    const to = process.argv[process.argv.indexOf('--to') + 1];
    if (!file || !process.argv.includes('--to') || !to) throw new Error('Usage: npm run backup:restore -- <backup file> --to <postgres url>');
    if ([process.env.SUPABASE_DIRECT_URL, process.env.SUPABASE_DATABASE_URL].includes(to) && !process.argv.includes('--i-know-this-overwrites')) {
        throw new Error('Refusing to restore over Supabase. Add --i-know-this-overwrites if you really mean it.');
    }
    let buf = fs.readFileSync(file);
    if (file.endsWith('.enc')) {
        if (!process.env.BACKUP_PASSPHRASE) throw new Error('Set BACKUP_PASSPHRASE to decrypt this backup.');
        buf = decrypt(buf, process.env.BACKUP_PASSPHRASE);
    }
    // Settings newer pg_dump versions emit that older servers reject (e.g. PG17 dump → PG16 server)
    // and a fresh database already has the public schema
    const sql = Buffer.from(zlib.gunzipSync(buf).toString('utf8')
        .replace(/^SET transaction_timeout = .*$/gm, '')
        .replace(/^CREATE SCHEMA public;$/m, 'CREATE SCHEMA IF NOT EXISTS public;'), 'utf8');
    const local = spawnSync('psql', ['--version']).status === 0;
    const url = local ? to : to.replace(/@(localhost|127\.0\.0\.1)(:\d+)?\//, (m, h, port) => `@host.docker.internal${port || ''}/`);
    const [cmd, args] = local ? ['psql', ['-v', 'ON_ERROR_STOP=1', '-q', url]] : ['docker', ['run', '--rm', '-i', 'postgres:17-alpine', 'psql', '-v', 'ON_ERROR_STOP=1', '-q', url]];
    const p = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'] });
    p.stdin.end(sql);
    const code = await new Promise(res => p.on('close', res));
    if (code !== 0) throw new Error(`psql failed (${code})`);
    console.log(`✔ restored ${file} (${(sql.length / 1024).toFixed(1)} KB of SQL)`);
}

main().catch(e => { console.error('✖', e.message); process.exit(1); });
