// All money maths is done in integer paise to avoid floating-point drift.
const toPaise = (amount) => Math.round(Number(amount) * 100);
const fromPaise = (paise) => paise / 100;
const toDecimalString = (paise) => (paise / 100).toFixed(2);
module.exports = { toPaise, fromPaise, toDecimalString };
