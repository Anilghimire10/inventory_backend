import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { normalizeEmail } from '../common/email';
import { PrincipalCache } from '../common/principal-cache';

// Lower number = more privileged.
const ROLE_RANK: Record<UserRole, number> = {
  [UserRole.OWNER]: 0,
  [UserRole.MANAGER]: 1,
  [UserRole.CASHIER]: 2,
  [UserRole.STOCK_KEEPER]: 2,
};

const SAFE_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  storeId: true,
  isActive: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private principals: PrincipalCache,
  ) {}

  async create(
    businessId: string,
    dto: CreateUserDto,
    actingRole: UserRole,
    actingStoreId?: string | null,
  ) {
    this.assertCanAssignRole(actingRole, dto.role);

    const email = normalizeEmail(dto.email);
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('Email already in use');
    if (dto.storeId) await this.assertStore(businessId, dto.storeId);

    // No store picked explicitly -> default a new hire to the store the
    // creating owner/manager themselves works out of, so a cashier can
    // start ringing up sales immediately instead of landing store-less.
    const storeId = dto.storeId ?? actingStoreId ?? undefined;

    const passwordHash = await argon2.hash(dto.password);
    return this.prisma.user.create({
      data: {
        businessId,
        email,
        name: dto.name,
        role: dto.role,
        storeId,
        passwordHash,
        // Verified on creation. The emailVerified gate exists to prove a
        // self-signup controls the address they registered with; a staff
        // account is created by an owner/manager who sets the password and
        // hands it over in person, so there is nothing to prove. Leaving it
        // false locked every new hire out of login with no way to clear it
        // (the code-entry screen only exists in the signup flow).
        emailVerified: true,
      },
      select: SAFE_SELECT,
    });
  }

  findAll(businessId: string) {
    return this.prisma.user.findMany({
      where: { businessId },
      select: SAFE_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(businessId: string, id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, businessId },
      select: SAFE_SELECT,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async update(
    businessId: string,
    id: string,
    dto: UpdateUserDto,
    actingRole: UserRole,
    actingUserId: string,
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id, businessId },
    });
    if (!target) throw new NotFoundException('User not found');

    // You can't modify someone who outranks you.
    if (ROLE_RANK[target.role] < ROLE_RANK[actingRole]) {
      throw new ForbiddenException('You cannot modify a higher-ranked user');
    }
    if (dto.role) this.assertCanAssignRole(actingRole, dto.role);
    if (dto.storeId) await this.assertStore(businessId, dto.storeId);
    if (id === actingUserId && dto.isActive === false) {
      throw new BadRequestException('You cannot deactivate yourself');
    }
    // Changing a password here retires every token minted under the old one.
    // Done to yourself that includes the token making the request, and unlike
    // AuthService.changePassword there is no fresh one to hand back -- you
    // would simply be signed out mid-edit. That flow already exists and does
    // it properly, so point at it instead.
    if (id === actingUserId && dto.password) {
      throw new BadRequestException(
        'Use Settings → Change password to change your own password',
      );
    }

    const data: Prisma.UserUpdateInput = {
      name: dto.name,
      role: dto.role,
      isActive: dto.isActive,
      store:
        dto.storeId === null
          ? { disconnect: true }
          : dto.storeId
            ? { connect: { id: dto.storeId } }
            : undefined,
    };
    if (dto.password) {
      data.passwordHash = await argon2.hash(dto.password);
      // An owner resetting a departing or compromised employee's password is
      // the main reason to do it here, so the old sessions have to die with
      // it. Without this bump their existing token stayed valid for the rest
      // of JWT_EXPIRES_IN -- up to seven days after the reset meant to lock
      // them out. AuthService does the same on a self-service change.
      data.tokenVersion = { increment: 1 };
    }

    const updated = await this.prisma.user.update({
      where: { id },
      data,
      select: SAFE_SELECT,
    });
    // Always evict: the cached principal carries the role, the active flag and
    // the tokenVersion this edit may have just changed, and would keep serving
    // the stale copy for the rest of its TTL.
    this.principals.evict(id);
    return updated;
  }

  async remove(businessId: string, id: string, actingUserId: string) {
    if (id === actingUserId) {
      throw new BadRequestException('You cannot delete yourself');
    }
    await this.findOne(businessId, id);
    const deactivated = await this.prisma.user.update({
      where: { id },
      data: { isActive: false },
      select: SAFE_SELECT,
    });
    // JwtStrategy refuses an inactive user, but only once it reaches the
    // database -- a cached principal would keep them working until it expires.
    this.principals.evict(id);
    return deactivated;
  }

  /**
   * Permanently delete a staff member. Deliberately narrow: the row only goes
   * away when nothing in the business refers to it.
   *
   * Two gates, because the alternative is destroying the books:
   *  - The account must already be deactivated. Deletion is the second step of
   *    an offboarding that starts with `remove()`, never a one-click action on
   *    a working account.
   *  - They must have no sales, shifts, stock or cash movements. Sale.userId and
   *    StockMovement.userId are optional (onDelete defaults to SetNull), so a
   *    delete here would silently blank out who rang up every sale rather than
   *    fail loudly; Shift.userId is required, so the database would reject it
   *    with a raw foreign-key error instead. Both outcomes are wrong, so we
   *    check first and explain what to do instead.
   *
   * What remains is the case this is actually for: a typo'd or never-used
   * account. EmailTokens cascade; the AuditLog rows recording the account's
   * own creation survive with a null actor (onDelete: SetNull).
   */
  async destroy(businessId: string, id: string, actingUserId: string) {
    if (id === actingUserId) {
      throw new BadRequestException('You cannot delete yourself');
    }
    const target = await this.prisma.user.findFirst({
      where: { id, businessId },
      select: SAFE_SELECT,
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.isActive) {
      throw new BadRequestException(
        'Deactivate this staff member before deleting them permanently',
      );
    }

    const [sales, shifts, movements, cash] = await Promise.all([
      this.prisma.sale.count({ where: { userId: id } }),
      this.prisma.shift.count({ where: { userId: id } }),
      this.prisma.stockMovement.count({ where: { userId: id } }),
      // An owner paying out of a cashier's till has no shift of their own
      // there, so the shift count alone doesn't cover this.
      this.prisma.cashMovement.count({ where: { userId: id } }),
    ]);
    const history = [
      sales && `${sales} sale${sales === 1 ? '' : 's'}`,
      shifts && `${shifts} shift${shifts === 1 ? '' : 's'}`,
      movements &&
        `${movements} stock movement${movements === 1 ? '' : 's'}`,
      cash && `${cash} cash pay in/out${cash === 1 ? '' : 's'}`,
    ].filter(Boolean);
    if (history.length) {
      throw new ConflictException(
        `${target.name} has ${history.join(', ')} on record and cannot be deleted. ` +
          'They stay deactivated so the history keeps its owner.',
      );
    }

    const deleted = await this.prisma.user.delete({
      where: { id },
      select: SAFE_SELECT,
    });
    // The principal cache would otherwise keep serving this now-deleted user
    // for the rest of its TTL.
    this.principals.evict(id);
    return deleted;
  }

  /**
   * A non-owner can only assign a role strictly below their own rank -- a
   * MANAGER can create/promote CASHIER or STOCK_KEEPER, but not another
   * MANAGER (or OWNER). Only an OWNER can assign OWNER or MANAGER.
   */
  private assertCanAssignRole(actingRole: UserRole, targetRole: UserRole) {
    if (actingRole === UserRole.OWNER) return;
    if (ROLE_RANK[targetRole] <= ROLE_RANK[actingRole]) {
      throw new ForbiddenException(
        `Only an owner can assign the ${targetRole.toLowerCase()} role`,
      );
    }
  }

  private async assertStore(businessId: string, storeId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, businessId },
    });
    if (!store) throw new BadRequestException('Invalid store');
  }
}
