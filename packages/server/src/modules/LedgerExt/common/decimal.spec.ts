import {
  fromThousandths,
  netDebit,
  sumDecimals,
  toThousandths,
} from './decimal';

describe('decimal amounts', () => {
  it('parses and formats without floating point', () => {
    expect(toThousandths('0.1')).toBe(100n);
    expect(toThousandths('1234567890.123')).toBe(1234567890123n);
    expect(toThousandths('-5')).toBe(-5000n);
    expect(toThousandths(0.07)).toBe(70n);
    expect(fromThousandths(100n)).toBe('0.10');
    expect(fromThousandths(1005n)).toBe('1.005');
    expect(fromThousandths(-5000n)).toBe('-5.00');
    expect(fromThousandths(0n)).toBe('0.00');
  });

  it('adds amounts that floating point gets wrong', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in floating point.
    expect(sumDecimals(['0.1', '0.2'])).toBe('0.30');
    expect(sumDecimals(['9999999999.999', '0.001'])).toBe('10000000000.00');
    expect(sumDecimals([])).toBe('0.00');
  });

  it('nets debits and credits', () => {
    expect(netDebit('1000.000', '380.000')).toBe('620.00');
    expect(netDebit('0.000', '0.010')).toBe('-0.01');
  });

  it('refuses what is not a decimal amount', () => {
    expect(() => toThousandths('1e3')).toThrow();
    expect(() => toThousandths('1.2345')).toThrow();
    expect(() => toThousandths('abc')).toThrow();
  });
});
