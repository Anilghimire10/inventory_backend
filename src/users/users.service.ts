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
  constructor(private prisma: PrismaService) {}

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
    if (dto.password) data.passwordHash = await argon2.hash(dto.password);

    return this.prisma.user.update({ where: { id }, data, select: SAFE_SELECT });
  }

  async remove(businessId: string, id: string, actingUserId: string) {
    if (id === actingUserId) {
      throw new BadRequestException('You cannot delete yourself');
    }
    await this.findOne(businessId, id);
    return this.prisma.user.update({
      where: { id },
      data: { isActive: false },
      select: SAFE_SELECT,
    });
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
