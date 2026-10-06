// Append-only activity log. Never throws: a failed audit write must not break filing an invoice.
function createAudit(prisma) {
    const emails = new Map(); // tokens issued before email was in the JWT
    async function emailOf(user) {
        if (!user) return 'system';
        if (user.email) return user.email;
        if (!emails.has(user.id)) {
            const u = await prisma.user.findUnique({ where: { id: user.id }, select: { email: true } });
            emails.set(user.id, u?.email || 'unknown');
        }
        return emails.get(user.id);
    }
    // req: Express request (or { user, ip }), or null for the background sender
    return async function audit(req, { tenantId, action, entityType, entityId, summary, details, userEmail }) {
        try {
            const user = req?.user || null;
            await prisma.auditLog.create({
                data: {
                    tenantId: tenantId !== undefined ? tenantId : (user?.tenantId ?? null),
                    userId: user?.id ?? null,
                    userEmail: String(userEmail || (await emailOf(user))).slice(0, 200),
                    action,
                    entityType: entityType ?? null,
                    entityId: entityId ?? null,
                    summary: String(summary).slice(0, 500),
                    details: details ?? undefined,
                    ip: req?.ip ?? null,
                },
            });
        } catch (err) {
            console.error('audit write failed:', action, err.message);
        }
    };
}

module.exports = { createAudit };
