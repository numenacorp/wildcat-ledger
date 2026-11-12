import {
  divideRounded,
  fromCents,
  isDecimal,
  lineCents,
  prorate,
  toCents,
} from './money';

describe('money', () => {
  it('rounds a half away from zero', () => {
    expect(divideRounded(5n, 10n)).toBe(1n);
    expect(divideRounded(-5n, 10n)).toBe(-1n);
    expect(divideRounded(4n, 10n)).toBe(0n);
    expect(divideRounded(15n, 10n)).toBe(2n);
    expect(divideRounded(-15n, 10n)).toBe(-2n);
    expect(divideRounded(5n, -10n)).toBe(-1n);
  });

  it('reads and writes cents', () => {
    expect(toCents('12.34')).toBe(1234n);
    expect(toCents('12')).toBe(1200n);
    expect(toCents('-0.5')).toBe(-50n);
    expect(toCents('1.005')).toBe(101n);
    expect(fromCents(1234n)).toBe('12.34');
    expect(fromCents(-5n)).toBe('-0.05');
    expect(fromCents(0n)).toBe('0.00');
  });

  it('prices a line: rate times quantity, to the cent', () => {
    // 3 at 19.99 is 59.97.
    expect(lineCents('19.99', '3')).toBe(5997n);
    // 2.5 at 0.333 is 0.8325, which rounds to 0.83.
    expect(lineCents('0.333', '2.5')).toBe(83n);
    // 1.5 at 0.01 is 0.015, half a cent, which rounds away from zero.
    expect(lineCents('0.01', '1.5')).toBe(2n);
    expect(lineCents('-0.01', '1.5')).toBe(-2n);
    expect(lineCents('-120', '1')).toBe(-12000n);
    expect(lineCents('100', '0')).toBe(0n);
  });

  it('knows a decimal from other text', () => {
    expect(isDecimal('1.25')).toBe(true);
    expect(isDecimal('-3')).toBe(true);
    expect(isDecimal('1.1234567')).toBe(false);
    expect(isDecimal('1e3')).toBe(false);
    expect(isDecimal('')).toBe(false);
    expect(isDecimal(3)).toBe(false);
  });

  describe('sharing a payment over lines', () => {
    it('one cent on three one-cent lines goes to the third', () => {
      expect(prorate(1n, [1n, 1n, 1n])).toEqual([0n, 0n, 1n]);
    });

    it('0.05 on lines of 7.00, 1.00 and 2.00 is 0.03, 0.01 and 0.01', () => {
      // 3.5, 0.5 and 1 round to 4, 1 and 1: a cent too many, off the 7.00.
      expect(prorate(5n, [700n, 100n, 200n])).toEqual([3n, 1n, 1n]);
    });

    it('0.01 on lines of 0.03 and -0.01 is 0.02 and -0.01', () => {
      // 1.5 and -0.5 round away from zero.
      expect(prorate(1n, [3n, -1n])).toEqual([2n, -1n]);
    });

    it('a payment in full is the lines themselves', () => {
      expect(prorate(1000n, [700n, 100n, 200n])).toEqual([700n, 100n, 200n]);
    });

    it('half of 10.00 on lines of 3.33, 3.33 and 3.34', () => {
      // 1.665, 1.665 and 1.67 round to 1.67 each: a cent too many, off the
      // largest line, the 3.34.
      expect(prorate(500n, [333n, 333n, 334n])).toEqual([167n, 167n, 166n]);
    });

    it('lines that total zero, or no lines, get nothing', () => {
      expect(prorate(100n, [50n, -50n])).toEqual([0n, 0n]);
      expect(prorate(100n, [])).toEqual([]);
    });

    it('always adds up to what was paid', () => {
      const lines = [1234n, 1n, 999n, -17n, 50000n];
      for (const paid of [1n, 7n, 333n, 52216n, 52217n]) {
        expect(prorate(paid, lines).reduce((a, b) => a + b, 0n)).toBe(paid);
      }
    });
  });
});
