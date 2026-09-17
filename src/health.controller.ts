import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { Public } from './common/decorators/public.decorator';
import { PrismaService } from './prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness + DB readiness. Unauthenticated so load balancers can poll it,
   * which is exactly why it says nothing about the infrastructure behind it:
   * it used to return the database name, its host and the total user count,
   * all to anonymous callers. `SELECT 1` proves the connection is alive
   * without describing what is on the other end of it.
   */
  @Public()
  @SkipThrottle()
  @Get()
  async check() {
    let database: 'up' | 'down' = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      uptime: process.uptime(),
      database,
    };
  }
}
