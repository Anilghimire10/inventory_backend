/**
 * Options for interactive ($transaction(async ...)) transactions.
 * The Prisma default timeout is 5s, which is too tight for multi-step
 * operations (sales, purchases) against a remote DB like Neon where every
 * query carries network latency. These give comfortable headroom.
 */
export const TX_OPTS = {
  maxWait: 15_000, // max time to wait for a connection from the pool
  timeout: 30_000, // max time the interactive transaction may run
};
