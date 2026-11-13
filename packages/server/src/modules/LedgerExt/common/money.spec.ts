import {
  divideRounded,
  fromCents,
  isDecimal,
  lineCents,
  shareOut,
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
    // Each expected share is worked by hand: the exact share, rounded down,
    // then the cents left over to the largest fractions lost.
    it('one cent on three one-cent lines goes to the first', () => {
      // A third of a cent each: all round down to 0, one cent left, a tie.
      expect(shareOut(1n, [1n, 1n, 1n])).toEqual([1n, 0n, 0n]);
    });

    it('0.05 on lines of 7.00, 1.00 and 2.00 is 0.04, 0.00 and 0.01', () => {
      // 3.5, 0.5 and 1: down to 3, 0 and 1, one cent left, to the earlier
      // of the two halves.
      expect(shareOut(5n, [700n, 100n, 200n])).toEqual([4n, 0n, 1n]);
    });

    it('0.01 on lines of 0.03 and -0.01 is 0.02 and -0.01', () => {
      // 1.5 and -0.5: down to 1 and -1, one cent left, to the first.
      expect(shareOut(1n, [3n, -1n])).toEqual([2n, -1n]);
    });

    it('a payment in full is the lines themselves', () => {
      expect(shareOut(1000n, [700n, 100n, 200n])).toEqual([700n, 100n, 200n]);
      expect(shareOut(119n, [59n, 60n])).toEqual([59n, 60n]);
      expect(shareOut(-3n, [5n, -8n])).toEqual([5n, -8n]);
    });

    it('half of 10.00 on lines of 3.33, 3.33 and 3.34', () => {
      // 166.5, 166.5 and 167: down to 166, 166 and 167, one cent left, to
      // the earlier of the two halves.
      expect(shareOut(500n, [333n, 333n, 334n])).toEqual([167n, 166n, 167n]);
    });

    it('0.79 on two lines of 0.99 is 0.40 and 0.39', () => {
      expect(shareOut(79n, [99n, 99n])).toEqual([40n, 39n]);
    });

    it('a cent short goes to the line that lost most, a negative one too', () => {
      // 379,677.54 on lines of 3,711.02, 3.33, 999,999.99 and -466,644.49.
      // Exact: 262347.80, 235.41, 70694256.29 and -32989085.50. Down:
      // 262347, 235, 70694256 and -32989086, two cents short. The fractions
      // lost are .80, .41, .29 and .50: the first and the last line.
      expect(
        shareOut(37967754n, [371102n, 333n, 99999999n, -46664449n]),
      ).toEqual([262348n, 235n, 70694256n, -32989085n]);
    });

    it('never goes past what is left on a line', () => {
      const unpaid = [47n, 47n, 47n];
      for (let paid = 0n; paid <= 141n; paid += 1n) {
        const shares = shareOut(paid, unpaid);
        expect(shares.reduce((a, b) => a + b, 0n)).toBe(paid);
        shares.forEach((share, n) => {
          expect(share >= 0n && share <= unpaid[n]).toBe(true);
        });
      }
    });

    it('lines that total zero, or no lines, get nothing', () => {
      expect(shareOut(100n, [50n, -50n])).toEqual([0n, 0n]);
      expect(shareOut(100n, [])).toEqual([]);
    });

    it('always adds up to what was paid', () => {
      const lines = [1234n, 1n, 999n, -17n, 50000n];
      for (const paid of [1n, 7n, 333n, 52216n, 52217n]) {
        expect(shareOut(paid, lines).reduce((a, b) => a + b, 0n)).toBe(paid);
      }
    });
  });
});
