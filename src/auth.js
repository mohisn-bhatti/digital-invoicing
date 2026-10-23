const jwt = require('jsonwebtoken');
const { accessMode } = require('./subscription');

// A client whose access period is over can only LOOK (src/subscription.js, public/access.js). Everything that is not a read is refused, except what it needs to
// leave, to keep its own password safe, and to write to ETAX to ask for a renewal.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const READ_ONLY_ALLOWED = [/^POST \/api\/auth\/(logout|password)$/, /^POST \/api\/client\/tickets$/, /^POST \/api\/client\/tickets\/[^/]+\/messages$/];
const mayWriteWhenReadOnly = req => READ_ONLY_ALLOWED.some(re => re.test(`${req.method} ${String(req.originalUrl || req.url).split('?')[0].replace(/\/+$/, '')}`));

// tv = the user's tokenVersion when the token was issued; bumping it (password change/reset, deactivation)
// makes every older token stop working.
function signToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role, tenantId: user.tenantId, tv: user.tokenVersion || 0 },
        process.env.JWT_SECRET,
        { expiresIn: '12h' }
    );
}

// Admin working inside a client's workspace (sandbox testing). Acts as that client's owner; audited under the admin's email.
function signWorkspaceToken(admin, tenantId) {
    return jwt.sign(
        { id: admin.id, email: admin.email, role: 'CLIENT_USER', tenantId, impersonatedBy: admin.id, tv: admin.tokenVersion || 0 },
        process.env.JWT_SECRET,
        { expiresIn: '2h' }
    );
}

function createAuth(prisma) {
    // Valid signature AND the user still exists, is active and hasn't changed password since
    async function authenticateToken(req, res, next) {
        const header = req.headers['authorization'] || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'Please log in.' });
        let payload;
        try {
            payload = jwt.verify(token, process.env.JWT_SECRET);
        } catch {
            return res.status(401).json({ error: 'Session expired, please log in again.' });
        }
        try {
            const user = await prisma.user.findUnique({
                where: { id: payload.id },
                select: { active: true, tokenVersion: true, role: true, tenantRole: true, tenantId: true, tenant: { select: { active: true, inactiveReason: true, accessEndsAt: true, accessUnit: true } } },
            });
            if (!user || !user.active || user.tokenVersion !== (payload.tv || 0)) {
                return res.status(401).json({ error: 'Session ended, please log in again.' });
            }
            // switched off by the administrator: nothing. Access period (and grace) over: look, but change nothing. Whichever the job has already noted or not.
            const mode = user.tenant && !payload.impersonatedBy ? accessMode(user.tenant) : { mode: 'FULL' };
            if (mode.mode === 'BLOCKED') return res.status(401).json({ error: mode.message });
            if (mode.mode === 'READ_ONLY') {
                req.readOnly = true;
                if (!READ_METHODS.has(req.method) && !mayWriteWhenReadOnly(req)) return res.status(403).json({ error: mode.message, readOnly: true });
            }
            req.user = payload.impersonatedBy
                ? { ...payload, tenantRole: 'OWNER' }                     // admin in a workspace = owner rights there
                : { ...payload, role: user.role, tenantId: user.tenantId, tenantRole: user.tenantRole };
            next();
        } catch (err) {
            next(err);
        }
    }
    return { authenticateToken };
}

function requireRole(role) {
    return (req, res, next) => {
        if (req.user.role !== role) return res.status(403).json({ error: 'Not allowed for this account.' });
        next();
    };
}

// Client routes: must be a CLIENT_USER bound to a tenant
function requireTenant(req, res, next) {
    if (req.user.role !== 'CLIENT_USER' || !req.user.tenantId) {
        return res.status(403).json({ error: 'Not allowed for this account.' });
    }
    next();
}

// Inside a client: e.g. requireTenantRole('OWNER', 'ACCOUNTANT')
function requireTenantRole(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user.tenantRole)) {
            return res.status(403).json({ error: `Your role (${String(req.user.tenantRole || '').toLowerCase()}) can't do this. Ask your account owner.` });
        }
        next();
    };
}

module.exports = { createAuth, requireRole, requireTenant, requireTenantRole, signToken, signWorkspaceToken };
