import {
  previousDay,
  startOfLocalDay,
  toInstant,
  toLocalDay,
} from './timestamps';

describe('ledger-ext timestamps', () => {
  it('normalizes an instant to UTC with milliseconds', () => {
    expect(toInstant('2026-03-08T12:00:00-06:00')).toBe(
      '2026-03-08T18:00:00.000Z',
    );
    expect(toInstant('2026-03-08')).toBe('2026-03-08T00:00:00.000Z');
  });

  it('rejects a value that is not a date', () => {
    expect(() => toInstant('yesterday')).toThrow();
    expect(() => toInstant('2026-13-01')).toThrow();
  });

  it('finds the local day either side of midnight', () => {
    // 05:30 UTC on 1 July is 00:30 on 1 July in Chicago (UTC-5 in summer).
    expect(toLocalDay('2026-07-01T05:30:00.000Z', 'America/Chicago')).toBe(
      '2026-07-01',
    );
    // 04:30 UTC on 1 July is 23:30 on 30 June in Chicago.
    expect(toLocalDay('2026-07-01T04:30:00.000Z', 'America/Chicago')).toBe(
      '2026-06-30',
    );
    // In winter Chicago is UTC-6, so 05:30 UTC on 1 January is still 31 December.
    expect(toLocalDay('2026-01-01T05:30:00.000Z', 'America/Chicago')).toBe(
      '2025-12-31',
    );
  });

  it('handles the days the clocks change', () => {
    // Clocks go forward in Chicago on 8 March 2026 and back on 1 November 2026.
    expect(startOfLocalDay('2026-03-08', 'America/Chicago')).toBe(
      '2026-03-08T06:00:00.000Z',
    );
    expect(startOfLocalDay('2026-03-09', 'America/Chicago')).toBe(
      '2026-03-09T05:00:00.000Z',
    );
    expect(startOfLocalDay('2026-11-01', 'America/Chicago')).toBe(
      '2026-11-01T05:00:00.000Z',
    );
    expect(startOfLocalDay('2026-11-02', 'America/Chicago')).toBe(
      '2026-11-02T06:00:00.000Z',
    );
  });

  it('steps back a day across a month and a leap day', () => {
    expect(previousDay('2026-07-01')).toBe('2026-06-30');
    expect(previousDay('2028-03-01')).toBe('2028-02-29');
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
  });
});
