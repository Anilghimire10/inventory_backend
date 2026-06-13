import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

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

  async create(businessId: string, dto: CreateUserDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) throw new ConflictException('Email already in use');

    if (dto.storeId) await this.assertStore(businessId, dto.storeId);

    const passwordHash = await argon2.hash(dto.password);
    return this.prisma.user.create({
      data: {
        businessId,
        email: dto.email,
        name: dto.name,
        role: dto.role,
        storeId: dto.storeId,
        passwordHash,
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
    actingUserId: string,
  ) {
    await this.findOne(businessId, id); // ensures same tenant
    if (dto.storeId) await this.assertStore(businessId, dto.storeId);

    // Don't let a user deactivate or demote themselves accidentally
    if (id === actingUserId && dto.isActive === false) {
      throw new BadRequestException('You cannot deactivate yourself');
    }

    const data: Prisma.UserUpdateInput = {
      name: dto.name,
      role: dto.role,
      isActive: dto.isActive,
      store: dto.storeId ? { connect: { id: dto.storeId } } : undefined,
    };
    if (dto.password) data.passwordHash = await argon2.hash(dto.password);

    return this.prisma.user.update({
      where: { id },
      data,
      select: SAFE_SELECT,
    });
  }

  async remove(businessId: string, id: string, actingUserId: string) {
    if (id === actingUserId) {
      throw new BadRequestException('You cannot delete yourself');
    }
    await this.findOne(businessId, id);
    // Soft delete: keep history, just deactivate
    return this.prisma.user.update({
      where: { id },
      data: { isActive: false },
      select: SAFE_SELECT,
    });
  }

  private async assertStore(businessId: string, storeId: string) {
    const store = await this.prisma.store.findFirst({
      where: { id: storeId, businessId },
    });
    if (!store) throw new BadRequestException('Invalid store');
  }
}
