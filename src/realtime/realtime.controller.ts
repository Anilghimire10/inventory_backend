import { Controller, Header, MessageEvent, Sse, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Observable, interval, map, merge, takeUntil, timer } from 'rxjs';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AuthUser } from '../common/types/auth-user';
import { PlatformAuthGuard } from '../platform/platform-auth.guard';
import { RealtimeService } from './realtime.service';

/** A comment line every 25s keeps proxies from closing a quiet stream. */
const HEARTBEAT_MS = 25_000;
/**
 * A stream is authorised once, when it opens. Ending it every half hour makes
 * the client reconnect with its current token, so a signed-out or retired
 * session stops hearing anything within that time.
 */
const MAX_STREAM_MS = 30 * 60_000;

const heartbeat = () => interval(HEARTBEAT_MS).pipe(map((): MessageEvent => ({ type: 'ping', data: '' })));

/**
 * Server-sent events: one long-lived response per open tab, carrying "this
 * changed" signals (topics only, never data). The tab reloads what it shows.
 * Read with fetch, not EventSource, so the usual Authorization header works.
 */
@ApiExcludeController()
@Controller()
export class RealtimeController {
  constructor(private realtime: RealtimeService) {}

  @Sse('events')
  @Header('X-Accel-Buffering', 'no')
  shop(@CurrentUser() user: AuthUser): Observable<MessageEvent> {
    const events = this.realtime
      .forUser(user.businessId, user.userId)
      .pipe(map((e): MessageEvent => ({ type: 'change', data: { topics: e.topics, origin: e.origin ?? null } })));
    return merge(events, heartbeat()).pipe(takeUntil(timer(MAX_STREAM_MS)));
  }

  @Public()
  @UseGuards(PlatformAuthGuard)
  @Sse('admin/events')
  @Header('X-Accel-Buffering', 'no')
  admin(): Observable<MessageEvent> {
    const events = this.realtime.forAdmins().pipe(map((topics): MessageEvent => ({ type: 'change', data: { topics } })));
    return merge(events, heartbeat()).pipe(takeUntil(timer(MAX_STREAM_MS)));
  }
}
