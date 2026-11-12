import * as moment from 'moment-timezone';
import { ServiceError } from '@/modules/Items/ServiceError';
import { ERRORS } from '../LedgerExt.constants';

/**
 * Bigcapital dates its documents by calendar day. The extension also keeps the
 * exact instant a caller supplied, and derives the calendar day from it in the
 * organization's timezone.
 */

/** Normalizes an instant to a UTC ISO-8601 string with milliseconds. */
export function toInstant(value: string | Date): string {
  const parsed = moment.utc(value, moment.ISO_8601, true);

  if (!parsed.isValid()) {
    throw new ServiceError(
      ERRORS.INVALID_TIMESTAMP,
      'The timestamp must be an ISO-8601 date or date-time.',
    );
  }
  return parsed.toISOString();
}

/** The calendar day (`YYYY-MM-DD`) an instant falls on in the given timezone. */
export function toLocalDay(instant: string | Date, timezone: string): string {
  return moment.tz(toInstant(instant), timezone).format('YYYY-MM-DD');
}

/** The first instant of a calendar day in the given timezone. */
export function startOfLocalDay(day: string, timezone: string): string {
  return moment
    .tz(day, 'YYYY-MM-DD', true, timezone)
    .startOf('day')
    .toISOString();
}

/** The day before a calendar day. */
export function previousDay(day: string): string {
  return moment
    .utc(day, 'YYYY-MM-DD', true)
    .subtract(1, 'day')
    .format('YYYY-MM-DD');
}
