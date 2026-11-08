// A NUL character cannot be stored in the database and would come back as a server error: said in plain words instead, wherever it is
// (an id in the address, a word in the search box, any field of the body). Written without recursion so a deeply nested body is no trick.
// Used by the Point of Sale (/api/pos) and Compliance & Deadlines (/api/cmp) routes.
const problemWith = root => {
    const todo = [root]; let seen = 0;
    while (todo.length) {
        const v = todo.pop();
        if (++seen > 20000) return 'That request is too big.'; // (every value counts: a sale has a few hundred at the very most)
        if (typeof v === 'string') { if (v.includes('\u0000')) return 'That contains a character that cannot be saved.'; }
        else if (v && typeof v === 'object') {
            for (const [k, x] of Object.entries(v)) { if (k.includes('\u0000')) return 'That contains a character that cannot be saved.'; todo.push(x); }
        }
    }
    return null;
};

// Express middleware for one path prefix: refuses a body or query with a NUL (400) and an id with one in the address (404)
function guardPrefix(app, prefix, HttpError) {
    app.use(prefix, (req, res, next) => { const bad = problemWith([req.query, req.body]); if (bad) throw new HttpError(400, bad); next(); });
    app.param('id', (req, res, next, id) => { if (req.path.startsWith(prefix + '/') && String(id).includes('\u0000')) throw new HttpError(404, 'Not found.'); next(); });
}

module.exports = { problemWith, guardPrefix };
