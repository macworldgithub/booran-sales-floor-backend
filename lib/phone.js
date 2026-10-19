function normalisePhone(value) {
  const number = String(value || '').replace(/[\s().-]/g, '').replace(/^\+/, '');
  const mobile = /^04\d{8}$/.test(number) ? `61${number.slice(1)}` : /^4\d{8}$/.test(number) ? `61${number}` : number;
  if (!/^614\d{8}$/.test(mobile)) throw Object.assign(new Error('Enter a valid Australian mobile number, such as 0412 345 678 or +61 412 345 678.'), { status: 400 });
  return `+${mobile}`;
}
module.exports = { normalisePhone };
