// What the Point of Sale services throw for a problem the person can fix (the routes turn it into an HTTP answer with this status)
class PosError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

module.exports = { PosError };
