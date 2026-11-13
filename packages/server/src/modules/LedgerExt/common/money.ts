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
 * Shares an amount out over weights in proportion to them, in whole cents
 * that add up to the amount.
 *
 * Largest remainder: each share is rounded down, and the cents that leaves
 * over go one each to the shares that lost the largest fraction, the earlier
 * one first on a tie. A negative weight takes part like any other; its share
 * rounds down too, away from zero. Weights that total zero get nothing.
 *
 * With weights that are what is still unpaid on each line, and an amount no
 * larger than their total, no share goes past its weight, and the amount
 * that pays the whole of them gives each exactly its weight.
 */
export function shareOut(cents: bigint, weights: bigint[]): bigint[] {
  const whole = weights.reduce((total, weight) => total + weight, 0n);
  if (whole === 0n || weights.length === 0) return weights.map(() => 0n);

  const parts = weights.map((weight, index) => {
    const numerator = cents * weight;
    let share = numerator / whole;
    // BigInt division drops the fraction towards zero; a share rounds down.
    if (numerator % whole !== 0n && numerator < 0n !== whole < 0n) share -= 1n;
    return { index, share, lost: abs(numerator - share * whole) };
  });
  let left = cents - parts.reduce((total, part) => total + part.share, 0n);
  const shares = parts.map((part) => part.share);

  for (const part of [...parts].sort((a, b) =>
    a.lost === b.lost ? a.index - b.index : a.lost < b.lost ? 1 : -1,
  )) {
    if (left === 0n) break;
    shares[part.index] += 1n;
    left -= 1n;
  }
  return shares;
}
