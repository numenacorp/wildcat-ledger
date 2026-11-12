/**
 * Exact arithmetic in whole cents, for documents priced by rate and quantity
 * and for sharing a payment out over a document's lines. Nothing here passes
 * through floating point.
 */

/** A decimal with up to this many decimal places is accepted. */
const MAX_DECIMALS = 6;

const DECIMAL = new RegExp(`^(-?)(\\d{1,12})(?:\\.(\\d{1,${MAX_DECIMALS}}))?$`);

const abs = (value: bigint): bigint => (value < 0n ? -value : value);
const sign = (value: bigint): bigint =>
  value > 0n ? 1n : value < 0n ? -1n : 0n;

/** Whether the text is a decimal this module can price with. */
export const isDecimal = (text: unknown): text is string =>
  typeof text === 'string' && DECIMAL.test(text.trim());

/** Parses a decimal string into an integer and the power of ten it is over. */
export function parseDecimal(text: string): { value: bigint; scale: number } {
  const match = DECIMAL.exec(text.trim());

  if (!match) {
    throw new Error(
      `"${text}" is not a decimal with up to ${MAX_DECIMALS} decimals.`,
    );
  }
  const [, negative, whole, fraction = ''] = match;
  const value = BigInt(whole + fraction);

  return { value: negative ? -value : value, scale: fraction.length };
}

/** Divides, rounding to the nearest whole, a half going away from zero. */
export function divideRounded(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('Division by zero.');

  const negative = sign(numerator) * sign(denominator) < 0n;
  const quotient =
    (abs(numerator) * 2n + abs(denominator)) / (abs(denominator) * 2n);
  return negative ? -quotient : quotient;
}

/** A decimal amount as whole cents, rounded, a half going away from zero. */
export function toCents(text: string): bigint {
  const { value, scale } = parseDecimal(text);
  return divideRounded(value * 100n, 10n ** BigInt(scale));
}

/** Whole cents as a decimal string with two decimals. */
export function fromCents(cents: bigint): string {
  const absolute = abs(cents);
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${cents < 0n ? '-' : ''}${absolute / 100n}.${fraction}`;
}

/** Whole cents as the number Bigcapital's ledger takes. */
export const centsToNumber = (cents: bigint): number => Number(cents) / 100;

/**
 * The amount of a line: its rate times its quantity, rounded to the cent.
 */
export function lineCents(rate: string, quantity: string): bigint {
  const r = parseDecimal(rate);
  const q = parseDecimal(quantity);

  return divideRounded(
    r.value * q.value * 100n,
    10n ** BigInt(r.scale + q.scale),
  );
}

/**
 * Shares an amount out over lines in proportion to them, in whole cents that
 * add up to the amount.
 *
 * Each line's share is rounded to the nearest cent, a half going away from
 * zero. The cents the rounding leaves over or short are then taken one at a
 * time from the lines in order of size, largest first, the later line first
 * on a tie. Lines that total zero get nothing.
 */
export function prorate(cents: bigint, lines: bigint[]): bigint[] {
  const whole = lines.reduce((total, line) => total + line, 0n);
  if (whole === 0n || lines.length === 0) return lines.map(() => 0n);

  const shares = lines.map((line) => divideRounded(cents * line, whole));
  const bySize = lines
    .map((line, index) => ({ index, line }))
    .sort((a, b) =>
      a.line === b.line ? b.index - a.index : a.line < b.line ? 1 : -1,
    );
  let left = cents - shares.reduce((total, share) => total + share, 0n);

  for (let n = 0; left !== 0n; n += 1) {
    const step = sign(left);
    shares[bySize[n % bySize.length].index] += step;
    left -= step;
  }
  return shares;
}
