// Apply migrations + seed to Supabase using SUPABASE_DATABASE_URL / SUPABASE_DIRECT_URL from .env.
// Development normally runs against the local database; run this once when local testing is done.
require('dotenv').config({ quiet: true });
const { execSync } = require('child_process');

const db = process.env.SUPABASE_DATABASE_URL;
const direct = process.env.SUPABASE_DIRECT_URL;
if (!db || !direct) {
    console.error('Set SUPABASE_DATABASE_URL and SUPABASE_DIRECT_URL in .env');
    process.exit(1);
}

const env = { ...process.env, DATABASE_URL: db, DIRECT_URL: direct };
const run = cmd => execSync(cmd, { stdio: 'inherit', env });

console.log('→ Supabase: applying migrations');
run('npx prisma migrate deploy');
if (!process.argv.includes('--no-seed')) {
    console.log('→ Supabase: seeding logins + HS codes');
    run('node prisma/seed.js');
}
console.log('✔ Supabase is up to date');
