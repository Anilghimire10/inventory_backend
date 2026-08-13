import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { Public } from './common/decorators/public.decorator';
import { PrismaService } from './prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness + DB readiness. Unauthenticated so load balancers can poll it. */
  @Public()
  @SkipThrottle()
  @Get()
  async check() {
    // ponytail: `db`/`users` are deploy-debugging aids (which database is this
    // instance actually talking to?). Drop them once the deploy is settled.
    // Host only -- never the credentials in DATABASE_URL.
    const [row] = await this.prisma.$queryRaw<{ db: string; users: bigint }[]>`
      SELECT current_database() AS db, (SELECT count(*) FROM "User") AS users
    `;
    let host = 'unknown';
    try {
      host = new URL(process.env.DATABASE_URL ?? '').host;
    } catch {
      /* DATABASE_URL unset or malformed -- leave as 'unknown' */
    }
    return {
      status: 'ok',
      uptime: process.uptime(),
      db: { name: row.db, host, users: Number(row.users) },
    };
  }
}
