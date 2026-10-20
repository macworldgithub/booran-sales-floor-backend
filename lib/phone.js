function normalisePhone(value) {
  const number = String(value || '').replace(/[\s().-]/g, '').replace(/^\+/, '');
  const mobile = /^04\d{8}$/.test(number) ? `61${number.slice(1)}` : /^4\d{8}$/.test(number) ? `61${number}` : number;
  if (!/^614\d{8}$/.test(mobile)) throw Object.assign(new Error('Enter a valid Australian mobile number, such as 0412 345 678 or +61 412 345 678.'), { status: 400 });
  return `+${mobile}`;
}

function formatToPlus61(value) {
  if (!value) return '';
  const clean = String(value).trim();
  if (!clean) return '';
  const digits = clean.replace(/\D/g, '');
  if (!digits) return '';

  if (clean.startsWith('+')) {
    if (digits.startsWith('61')) return `+${digits}`;
    return `+${digits}`;
  }

  if (digits.startsWith('0')) {
    return `+61${digits.slice(1)}`;
  }
  if (digits.startsWith('61') && (digits.length === 11 || digits.length === 10)) {
    return `+${digits}`;
  }
  if (digits.length === 9 && (digits.startsWith('4') || digits.startsWith('3') || digits.startsWith('2') || digits.startsWith('7') || digits.startsWith('8'))) {
    return `+61${digits}`;
  }
  return `+61${digits}`;
}

module.exports = { normalisePhone, formatToPlus61 };
