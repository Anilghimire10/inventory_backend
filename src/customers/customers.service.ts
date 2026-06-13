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
    const [data, total] = await this.prisma.$transaction([
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
    const customer = await this.ensure(businessId, id);
    if (amount > Number(customer.creditBalance)) {
      throw new BadRequestException('Payment exceeds outstanding balance');
    }
    return this.prisma.customer.update({
      where: { id },
      data: { creditBalance: { decrement: amount } },
    });
  }

  async remove(businessId: string, id: string) {
    await this.ensure(businessId, id);
    return this.prisma.customer.delete({ where: { id } });
  }

  private async ensure(businessId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, businessId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }
}
