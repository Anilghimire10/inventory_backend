import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { SettingsService } from '../../settings/settings.service';
import { AuthUser } from '../types/auth-user';

/**
 * What stays open while the shop app is closed: the admin panel, the status
 * the shop app polls to know it's closed, the health check, and the payment
 * return page's check (money a gateway already took still gets recorded).
 */
const OPEN = [/^\/admin(\/|$)/, /^\/status$/, /^\/health$/, /^\/subscription\/online\/[^/]+\/check$/];

/**
 * Maintenance mode (admin panel → Announcements): every other request is
 * refused, signing in included, until it's turned off. Settings are cached
 * for 30 seconds, so this costs no query per request.
 *
 * Runs after JwtAuthGuard, so an admin's "view as owner" session is known and
 * let through: it's read-only anyway, and handy for checking a shop.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  constructor(private settings: SettingsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<{ path: string; user?: AuthUser }>();
    const path = req.path.replace(/^\/api(?=\/|$)/, '').replace(/\/+$/, '') || '/';
    if (OPEN.some((r) => r.test(path)) || req.user?.impersonatedBy) return true;
    const s = await this.settings.get();
    if (!s.maintenanceMode) return true;
    throw new ServiceUnavailableException({
      statusCode: 503,
      error: 'Service Unavailable',
      code: 'MAINTENANCE',
      message: s.maintenanceMessage || 'The app is down for maintenance. Please try again shortly.',
    });
  }
}
