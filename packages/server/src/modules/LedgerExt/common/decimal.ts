/**
 * Exact arithmetic on decimal strings with up to three decimal places, the
 * precision Bigcapital stores amounts at. Amounts are never passed through
 * floating point.
 */
const SCALE = 3;
const FACTOR = 10n ** BigInt(SCALE);

/** Parses a decimal string or number into thousandths. */
export function toThousandths(value: string | number): bigint {
  const text = typeof value === 'number' ? value.toFixed(SCALE) : value.trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(text);

  if (!match) {
    throw new Error(
      `"${value}" is not a decimal amount with up to 3 decimals.`,
    );
  }
  const [, sign, whole, fraction = ''] = match;
  const thousandths =
    BigInt(whole) * FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
  return sign === '-' ? -thousandths : thousandths;
}

/** Formats thousandths as a decimal string with at least two decimals. */
export function fromThousandths(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / FACTOR;
  let fraction = (absolute % FACTOR).toString().padStart(SCALE, '0');

  if (fraction.endsWith('0')) fraction = fraction.slice(0, 2);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Debits less credits, as a decimal string. */
export function netDebit(
  debit: string | number,
  credit: string | number,
): string {
  return fromThousandths(toThousandths(debit) - toThousandths(credit));
}

export function sumDecimals(values: Array<string | number>): string {
  return fromThousandths(
    values.reduce((total, value) => total + toThousandths(value), 0n),
  );
}
