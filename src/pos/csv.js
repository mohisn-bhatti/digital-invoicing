// One cell of a spreadsheet. Text that Excel could take for a formula (it starts with = + - @ or a tab or return) is defused with a
// leading quote; a cell with a comma, a quote or a line break is wrapped in quotes.
const csvText = v => {
    let t = v === undefined || v === null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const csvNum = v => (v === undefined || v === null ? '' : Number(v).toFixed(2));

module.exports = { csvText, csvNum };
