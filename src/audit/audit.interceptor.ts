import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AuditService } from './audit.service';
import { AuthUser } from '../common/types/auth-user';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const VERB: Record<string, string> = {
  POST: 'create',
  PATCH: 'update',
  PUT: 'update',
  DELETE: 'delete',
};
// Paths we don't want cluttering the log.
const SKIP_PREFIXES = ['audit', 'auth', 'notifications'];

/**
 * Records every successful state-changing request by an authenticated user
 * into the audit log. Read requests and failures are ignored. Writes are
 * fire-and-forget so logging never slows or breaks the actual request.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      method: string;
      user?: AuthUser;
      path?: string;
      url?: string;
      params?: { id?: string };
      ip?: string;
    }>();
    const method = req.method;
    if (!MUTATING.has(method)) return next.handle();

    const user = req.user;
    if (!user?.businessId) return next.handle();

    // e.g. "/api/products/abc" -> segments ["products", "abc"]
    const path = req.path ?? req.url ?? '';
    const segments = path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const entity = segments[0] ?? 'unknown';

    if (SKIP_PREFIXES.includes(entity)) return next.handle();

    const verb = VERB[method] ?? method.toLowerCase();
    // A trailing action segment (e.g. /sales/:id/return -> "return") names the
    // action; otherwise fall back to the HTTP verb (create/update/delete).
    // A collection-level action has no :id, so its action is the second
    // segment: /sales/hold is "sales.hold", not "sales.create" -- parking a
    // cart logged as a sale made the activity feed claim sales that never
    // happened.
    const actionSegment =
      segments.length > 2
        ? segments[2]
        : segments.length === 2 && !req.params?.id
          ? segments[1]
          : null;
    const action = `${entity}.${actionSegment ?? verb}`;

    return next.handle().pipe(
      tap(() => {
        void this.audit.record({
          businessId: user.businessId,
          userId: user.userId,
          action,
          entity,
          entityId: req.params?.id ?? null,
          summary: `${verb} ${entity}`,
          method,
          path,
          ip: req.ip ?? null,
        });
      }),
    );
  }
}
