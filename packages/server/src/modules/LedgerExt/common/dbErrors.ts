/**
 * Recognizes database errors whether they arrive from the driver directly or
 * wrapped by the ORM, which keeps the driver's error as `nativeError`.
 */
const codeOf = (error: any): string | undefined =>
  error?.code ?? error?.nativeError?.code;

const messageOf = (error: any): string =>
  String(
    error?.sqlMessage ?? error?.nativeError?.sqlMessage ?? error?.message ?? '',
  );

/** The engine chose this transaction as the victim of a deadlock. */
export const isDeadlock = (error: any): boolean =>
  codeOf(error) === 'ER_LOCK_DEADLOCK' ||
  messageOf(error).includes('ER_LOCK_DEADLOCK');

/** A unique index refused a row, optionally the index of the given name. */
export const isDuplicateKey = (error: any, indexName?: string): boolean => {
  const duplicate =
    codeOf(error) === 'ER_DUP_ENTRY' ||
    messageOf(error).includes('ER_DUP_ENTRY');

  if (!duplicate || !indexName) return duplicate;
  return messageOf(error).toLowerCase().includes(indexName.toLowerCase());
};

/** A value was larger than its column holds. */
export const isOutOfRange = (error: any): boolean =>
  codeOf(error) === 'ER_WARN_DATA_OUT_OF_RANGE' ||
  messageOf(error).includes('ER_WARN_DATA_OUT_OF_RANGE') ||
  messageOf(error).includes('Out of range value');
