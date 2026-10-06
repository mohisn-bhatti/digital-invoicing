// Creates (or resets the password of) the super admin and the first tenant user.
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const hs = require('../src/hscodes');

const prisma = new PrismaClient();

async function main() {
    const env = process.env;
    for (const k of ['SUPER_ADMIN_EMAIL', 'SUPER_ADMIN_PASSWORD']) {
        if (!env[k]) throw new Error(`Set ${k} in .env`);
    }

    const adminEmail = env.SUPER_ADMIN_EMAIL.toLowerCase().trim();
    await prisma.user.upsert({
        where: { email: adminEmail },
        update: { password: await bcrypt.hash(env.SUPER_ADMIN_PASSWORD, 10) },
        create: { email: adminEmail, password: await bcrypt.hash(env.SUPER_ADMIN_PASSWORD, 10), role: 'SUPER_ADMIN' },
    });
    console.log(`Super admin: ${adminEmail}`);

    if (env.SEED_TENANT_EMAIL && env.SEED_TENANT_PASSWORD) {
        const email = env.SEED_TENANT_EMAIL.toLowerCase().trim();
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) {
            await prisma.user.update({ where: { email }, data: { password: await bcrypt.hash(env.SEED_TENANT_PASSWORD, 10) } });
        } else {
            await prisma.tenant.create({
                data: {
                    companyName: env.SEED_TENANT_NAME || 'First Client',
                    users: { create: { email, password: await bcrypt.hash(env.SEED_TENANT_PASSWORD, 10), role: 'CLIENT_USER' } },
                },
            });
        }
        console.log(`Tenant user: ${email}`);
    }

    // HS codes from the PCT-2017 list; never overwrites codes already synced from FBR
    const { upserted, removed } = await hs.importPct(prisma);
    console.log(`HS codes (PCT-2017): ${upserted} written, ${removed} stale removed`);
}

main()
    .catch(err => { console.error(err.message); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
