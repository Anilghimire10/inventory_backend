import { Prisma } from '@prisma/client';

/**
 * A JS Date as a bound for a raw-SQL comparison against a timestamp column.
 *
 * Columns are `timestamp(3)` without a zone, holding UTC (what Prisma
 * writes). A Date passed to `$queryRaw` arrives as `timestamptz`, and
 * Postgres compares the two in the *session* time zone -- so on a server
 * that isn't UTC (the local one is Asia/Kathmandu) every bound was off by the
 * offset. Converting the parameter to a UTC wall-clock `timestamp` makes the
 * comparison like-for-like whatever the session says. Prisma-built queries
 * don't need this; only raw SQL does.
 */
export const utcBound = (d: Date) => Prisma.sql`(${d}::timestamptz AT TIME ZONE 'UTC')`;
