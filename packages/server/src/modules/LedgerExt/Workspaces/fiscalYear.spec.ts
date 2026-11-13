import { fiscalMonthName, fiscalMonthOf, fiscalYearStart } from './fiscalYear';

describe('the fiscal year', () => {
  it('starts on the first day of its first month, on or before the day', () => {
    // A calendar year.
    expect(fiscalYearStart('2026-03-31', 1)).toBe('2026-01-01');
    expect(fiscalYearStart('2026-01-01', 1)).toBe('2026-01-01');
    expect(fiscalYearStart('2025-12-31', 1)).toBe('2025-01-01');
    // A year from July: March belongs to the year begun the July before.
    expect(fiscalYearStart('2026-03-31', 7)).toBe('2025-07-01');
    expect(fiscalYearStart('2026-07-01', 7)).toBe('2026-07-01');
    expect(fiscalYearStart('2026-06-30', 7)).toBe('2025-07-01');
  });

  it('names its first month as Bigcapital does, and reads January for none', () => {
    expect([fiscalMonthOf('january'), fiscalMonthOf('July')]).toEqual([1, 7]);
    expect([fiscalMonthOf(null), fiscalMonthOf('smarch')]).toEqual([1, 1]);
    expect([fiscalMonthName(1), fiscalMonthName(12)]).toEqual([
      'january',
      'december',
    ]);
  });
});
