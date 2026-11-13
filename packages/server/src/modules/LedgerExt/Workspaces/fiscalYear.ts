/**
 * The fiscal year of a set of books: twelve months from the first day of
 * its first month. Bigcapital keeps the first month as its lower-case
 * English name; the extension speaks of it as a number, 1 for January.
 */
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** The number of a month Bigcapital names; January where it names none it knows. */
export const fiscalMonthOf = (name: unknown): number => {
  const at = MONTHS.indexOf(String(name ?? '').toLowerCase());
  return at === -1 ? 1 : at + 1;
};

/** Bigcapital's name for a month by its number. */
export const fiscalMonthName = (month: number): string => MONTHS[month - 1];

/**
 * The first day of the fiscal year a plain date falls in.
 * With the year starting in July: 2026-03-31 is in the year from 2025-07-01.
 */
export function fiscalYearStart(day: string, firstMonth: number): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const startYear = month >= firstMonth ? year : year - 1;

  return `${String(startYear).padStart(4, '0')}-${String(firstMonth).padStart(2, '0')}-01`;
}
