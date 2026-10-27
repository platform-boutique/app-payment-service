import { pino, type Logger, type DestinationStream } from 'pino';

/**
 * Fields that must never reach a log line. The code never logs them on
 * purpose (see charge.ts / handlers.ts: only brand and last four digits);
 * this redaction is defence in depth in case a whole request object is
 * logged by mistake.
 */
export const REDACT_PATHS = [
  'credit_card',
  '*.credit_card',
  '*.*.credit_card',
  'credit_card_number',
  '*.credit_card_number',
  'credit_card_cvv',
  '*.credit_card_cvv',
];

export function createLogger(name: string, destination?: DestinationStream): Logger {
  const options = {
    name,
    messageKey: 'message',
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level(label: string) {
        return { severity: label };
      },
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
