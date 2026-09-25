import { Logger } from '@nestjs/common';

/**
 * When each scheduled job last ran and how it went, for the admin panel's
 * system status page.
 *
 * In memory, per process: it resets on restart and each instance only knows
 * its own runs. That is enough to answer "is the 9am reminder job actually
 * running?", and it needs no table. The status page says it is since startup.
 */
export interface CronRun {
  name: string;
  schedule: string;
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean | null;
  summary: string | null;
}

/** Every job, so one that has never run since startup still shows up. */
const JOBS: { name: string; schedule: string }[] = [
  { name: 'alert-sync', schedule: 'Every 10 minutes' },
  { name: 'low-stock-digest', schedule: 'Daily at 08:00 shop time' },
  { name: 'subscription-reminders', schedule: 'Daily at 09:00 shop time' },
  { name: 'log-retention', schedule: 'Daily at 03:30 server time' },
];

const runs = new Map<string, CronRun>();
const logger = new Logger('CronStatus');

export const processStartedAt = new Date();

/** Run a job and record its outcome. The job's own result passes through. */
export async function trackCron<T extends string>(name: string, job: () => Promise<T>): Promise<T> {
  const schedule = JOBS.find((j) => j.name === name)?.schedule ?? '';
  const startedAt = new Date().toISOString();
  runs.set(name, { name, schedule, startedAt, finishedAt: null, ok: null, summary: null });
  try {
    const summary = await job();
    runs.set(name, { name, schedule, startedAt, finishedAt: new Date().toISOString(), ok: true, summary });
    return summary;
  } catch (e) {
    const summary = (e as Error).message;
    runs.set(name, { name, schedule, startedAt, finishedAt: new Date().toISOString(), ok: false, summary });
    logger.error(`${name} failed: ${summary}`);
    throw e;
  }
}

export function cronRuns(): CronRun[] {
  return JOBS.map(
    (j) =>
      runs.get(j.name) ?? {
        ...j,
        startedAt: null,
        finishedAt: null,
        ok: null,
        summary: null,
      },
  );
}
