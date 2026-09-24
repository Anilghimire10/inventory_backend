import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    this.warnIfPoolUnbounded();
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Prisma sizes its pool at (CPUs x 2 + 1) unless the URL says otherwise, and
   * on a hosted box the CPU count it sees can be well above what the plan
   * actually gives. Supabase's session-mode pooler is capped at 15 clients for
   * everyone -- this app, migrations, Studio -- so an unbounded pool can take
   * them all and turn the next deploy's `migrate deploy` into "max clients
   * reached". A warning rather than a boot failure: the app works either way,
   * it just crowds everything else out.
   */
  private warnIfPoolUnbounded() {
    if (process.env.NODE_ENV !== 'production') return;
    const url = process.env.DATABASE_URL ?? '';
    if (/[?&]connection_limit=\d+/.test(url)) return;
    this.logger.warn(
      'DATABASE_URL has no connection_limit, so Prisma sizes its pool from the ' +
        'CPU count. Against a capped pooler (Supabase session mode: 15) add ' +
        '`connection_limit=5` to the URL to leave room for migrations and Studio.',
    );
  }
}
