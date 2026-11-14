import type { Clock } from '../../src/clock';

/**
 * A Clock that only moves when the test says so. `sleep` never waits: it records the request and moves the
 * fake time forward. Dates are built with the local-time constructor on purpose: the service reads the
 * month and year in local time, so the tests do not depend on the TZ of the machine.
 */
export class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  private current: number;

  constructor(start: Date = new Date(2026, 10, 14, 12, 0, 0)) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(date: Date): void {
    this.current = date.getTime();
  }

  advance(ms: number): void {
    this.current += ms;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.advance(ms);
  }
}

/** Fixed "now" used by the tests that do not care about the exact date: 2026-11-14 12:00 local. */
export const fixedNow = () => new Date(2026, 10, 14, 12, 0, 0);
