import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
} from './customers.controller';
import { PaginationDto, paginate } from '../common/dto/pagination.dto';

@Injectable()
export class CustomersService {
  constructor(private prisma: PrismaService) {}

  create(businessId: string, dto: CreateCustomerDto) {
    return this.prisma.customer.create({ data: { businessId, ...dto } });
  }

  async findAll(businessId: string, q: PaginationDto) {
    const where: Prisma.CustomerWhereInput = {
      businessId,
      ...(q.search
        ? {
            OR: [
              { name: { contains: q.search, mode: 'insensitive' } },
              { phone: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        skip: q.skip,
        take: q.limit,
        orderBy: { name: 'asc' },
      }),
      this.prisma.customer.count({ where }),
    ]);
    return paginate(data, total, q.page, q.limit);
  }

  async findOne(businessId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, businessId },
      include: {
        sales: {
          take: 20,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            receiptNo: true,
            total: true,
            createdAt: true,
            status: true,
          },
        },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async update(businessId: string, id: string, dto: UpdateCustomerDto) {
    await this.ensure(businessId, id);
    return this.prisma.customer.update({ where: { id }, data: dto });
  }

  async payCredit(businessId: string, id: string, amount: number) {
    if (amount <= 0) throw new BadRequestException('Amount must be positive');
    await this.ensure(businessId, id);
    // Atomic guarded decrement: the balance check and the write happen in
    // one statement against the row's live value, so two concurrent
    // payments can't both pass a stale "amount <= balance" check and drive
    // the balance negative.
    const result = await this.prisma.customer.updateMany({
      where: { id, businessId, creditBalance: { gte: amount } },
      data: { creditBalance: { decrement: amount } },
    });
    if (result.count === 0) {
      throw new BadRequestException('Payment exceeds outstanding balance');
    }
    return this.prisma.customer.findUniqueOrThrow({ where: { id } });
  }

  async remove(businessId: string, id: string) {
    await this.ensure(businessId, id);
    try {
      return await this.prisma.customer.delete({ where: { id } });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2003'
      ) {
        throw new BadRequestException(
          'This customer has sale history and cannot be deleted.',
        );
      }
      throw err;
    }
  }

  private async ensure(businessId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, businessId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }
}
