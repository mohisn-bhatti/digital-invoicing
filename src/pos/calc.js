// The money maths lives in public/pos-calc.js so that the cashier screen loads the very same file from any static host
// (Express here, Vercel in front): one source, one set of numbers.
module.exports = require('../../public/pos-calc.js');
