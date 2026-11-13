import * as moment from 'moment-timezone';
import { ServiceError } from '@/modules/Items/ServiceError';
import { ERRORS } from '../LedgerExt.constants';

/**
 * An accounting date is a plain date, `YYYY-MM-DD`, with no time of day and
 * no time zone: a document is dated a day, and that day is the same wherever
 * it is read. Timestamps are kept only for the record of when something was
 * written. An organization's time zone decides one thing, what "today" is.
 */

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Checks that a value is a plain date and returns it.
 * @throws {ServiceError} DATE_NOT_PLAIN - It carries a time, or is no date.
 */
export function toPlainDate(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !PLAIN_DATE.test(value) ||
    !moment.utc(value, 'YYYY-MM-DD', true).isValid()
  ) {
    throw new ServiceError(
      ERRORS.DATE_NOT_PLAIN,
      'A date must be a plain date, written YYYY-MM-DD, with no time.',
      { value: typeof value === 'string' ? value : null },
    );
  }
  return value;
}

/** The day before a plain date. */
export function previousDay(day: string): string {
  return moment
    .utc(day, 'YYYY-MM-DD', true)
    .subtract(1, 'day')
    .format('YYYY-MM-DD');
}

/** Normalizes a timestamp to a UTC ISO-8601 string with milliseconds. */
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

/** The calendar day it is at a moment in the given time zone. */
export function today(timezone: string, now: Date = new Date()): string {
  return moment.tz(now, timezone).format('YYYY-MM-DD');
}
