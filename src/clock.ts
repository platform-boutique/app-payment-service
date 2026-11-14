/**
 * The only place that reads wall-clock time or starts a delay on behalf of the business logic (CODE-07).
 * Code that depends on "now" (card expiry) or on waiting (the processing-error test card) takes a Clock,
 * so tests run with a fake one and never sleep in real time.
 */
export interface Clock {
  /** The current wall-clock time. */
  now(): Date;
  /** Resolves after `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
