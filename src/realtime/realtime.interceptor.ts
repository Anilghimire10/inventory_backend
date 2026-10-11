import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuthUser } from '../common/types/auth-user';
import { AdminTopic, LiveTopic, RealtimeService } from './realtime.service';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Which screens a successful change under each route touches. A sale moves
 * stock, the drawer's totals and (on credit) what a customer owes, so it
 * names all of them; the client maps topics to the queries it reloads.
 */
const TOPICS: Record<string, LiveTopic[]> = {
  sales: ['sales', 'stock', 'shifts', 'customers'],
  inventory: ['stock'],
  purchases: ['purchases', 'stock'],
  suppliers: ['purchases'],
  products: ['catalog', 'stock'],
  categories: ['catalog'],
  taxes: ['catalog'],
  customers: ['customers'],
  credit: ['customers', 'sales'],
  payments: ['customers', 'sales'],
  shifts: ['shifts', 'sales'],
  stores: ['settings', 'stock'],
  // A counter added, renamed or taken out of use: the till's choice and Settings.
  counters: ['shifts', 'settings'],
  business: ['settings'],
  users: ['settings'],
  support: ['support'],
  subscription: ['subscription'],
};

/** Shop routes the admin panel watches: a new ticket or reply, a payment reported. */
const ADMIN_TOPICS: Record<string, AdminTopic[]> = {
  support: ['support'],
  subscription: ['claims', 'businesses'],
};

/**
 * After every successful change a shop user makes, tells the other tabs of
 * that business what kind of thing changed (see RealtimeService). Runs beside
 * the audit interceptor and, like it, never touches the response.
 */
@Injectable()
export class RealtimeInterceptor implements NestInterceptor {
  constructor(private realtime: RealtimeService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      method: string;
      user?: AuthUser;
      path?: string;
      url?: string;
      headers: Record<string, string | string[] | undefined>;
    }>();
    if (!MUTATING.has(req.method)) return next.handle();
    const user = req.user;
    if (!user?.businessId) return next.handle();

    const segment = (req.path ?? req.url ?? '').replace(/^\/api\/?/, '').split(/[/?]/)[0];
    const origin = typeof req.headers['x-client-id'] === 'string' ? req.headers['x-client-id'].slice(0, 64) : undefined;

    return next.handle().pipe(
      tap(() => {
        if (segment === 'notifications') {
          // Reading or dismissing is personal: only this person's other devices.
          this.realtime.emit({ businessId: user.businessId, userId: user.userId, topics: ['notifications'], origin });
          return;
        }
        const topics = TOPICS[segment];
        if (topics) this.realtime.emit({ businessId: user.businessId, topics, origin });
        const admin = ADMIN_TOPICS[segment];
        if (admin) this.realtime.emitAdmin(admin);
      }),
    );
  }
}
