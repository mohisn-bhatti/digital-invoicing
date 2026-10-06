const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Please log in.' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(401).json({ error: 'Session expired, please log in again.' });
        req.user = user;
        next();
    });
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

function signToken(user) {
    return jwt.sign(
        { id: user.id, role: user.role, tenantId: user.tenantId },
        process.env.JWT_SECRET,
        { expiresIn: '12h' }
    );
}

module.exports = { authenticateToken, requireRole, requireTenant, signToken };
