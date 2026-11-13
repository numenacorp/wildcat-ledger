import { previousDay, toInstant, toPlainDate, today } from './timestamps';

describe('ledger-ext dates', () => {
  it('takes a plain date as it stands', () => {
    expect(toPlainDate('2026-03-08')).toBe('2026-03-08');
    // 2028 is a leap year.
    expect(toPlainDate('2028-02-29')).toBe('2028-02-29');
  });

  it('refuses a value with a time, and a value that is no date', () => {
    for (const value of [
      '2026-03-08T12:00:00Z',
      '2026-03-08T00:00:00.000Z',
      '2026-03-08 12:00',
      '2026-3-8',
      '2026-13-01',
      // 2026 is not a leap year.
      '2026-02-29',
      'yesterday',
      '',
      null,
      20260308,
    ]) {
      expect(() => toPlainDate(value)).toThrow(
        expect.objectContaining({ errorType: 'DATE_NOT_PLAIN' }),
      );
    }
  });

  it('steps back a day across a month, a year and a leap day', () => {
    expect(previousDay('2026-07-01')).toBe('2026-06-30');
    expect(previousDay('2028-03-01')).toBe('2028-02-29');
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
  });

  it('normalizes a timestamp to UTC with milliseconds', () => {
    expect(toInstant('2026-03-08T12:00:00-06:00')).toBe(
      '2026-03-08T18:00:00.000Z',
    );
    expect(() => toInstant('yesterday')).toThrow();
  });

  it('finds today either side of midnight in the time zone', () => {
    // 05:30 UTC on 1 July is 00:30 on 1 July in Chicago (UTC-5 in summer).
    expect(today('America/Chicago', new Date('2026-07-01T05:30:00.000Z'))).toBe(
      '2026-07-01',
    );
    // 04:30 UTC on 1 July is 23:30 on 30 June in Chicago.
    expect(today('America/Chicago', new Date('2026-07-01T04:30:00.000Z'))).toBe(
      '2026-06-30',
    );
    // The same moment is already 1 July in Sydney (UTC+10 in July).
    expect(
      today('Australia/Sydney', new Date('2026-06-30T14:30:00.000Z')),
    ).toBe('2026-07-01');
  });
});
