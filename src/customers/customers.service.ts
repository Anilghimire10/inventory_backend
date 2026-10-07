import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentMethod, PaymentType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { holdShiftOpen } from '../shifts/shifts.service';
import { QueryCustomerDto } from './dto/query-customer.dto';
import {
  CreateCustomerDto,
  UpdateCustomerDto,
} from './customers.controller';
import { paginate } from '../common/dto/pagination.dto';

@Injectable()
export class CustomersService {
  constructor(
    private prisma: PrismaService,
    private payments: PaymentsService,
  ) {}

  create(businessId: string, dto: CreateCustomerDto) {
    return this.prisma.customer.create({ data: { businessId, ...dto } });
  }

  async findAll(businessId: string, q: QueryCustomerDto) {
    const where: Prisma.CustomerWhereInput = {
      businessId,
      // A customer belongs to the business, not a branch -- there is no
      // Customer.storeId. "Customers of this store" therefore means the ones
      // who have actually bought there.
      ...(q.storeId ? { sales: { some: { storeId: q.storeId } } } : {}),
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

  /**
   * Take a payment against a customer's outstanding credit.
   *
   * The balance move and its ledger row are one transaction. Writing the row
   * afterwards would leave the two disagreeing whenever the second write
   * failed, which is precisely the state a ledger exists to make impossible.
   *
   * `shiftId` is what lets the money reach the drawer: a customer settling
   * their khata in cash at the counter puts notes in the till, and until this
   * existed the shift's expected cash knew nothing about them, so the drawer
   * counted long and the variance report blamed the cashier.
   */
  async payCredit(
    businessId: string,
    id: string,
    amount: number,
    context: {
      method?: PaymentMethod;
      userId?: string;
      storeId?: string | null;
      shiftId?: string | null;
      note?: string;
    } = {},
  ) {
    if (amount <= 0) throw new BadRequestException('Amount must be positive');
    await this.ensure(businessId, id);

    return this.prisma.$transaction(async (tx) => {
      // Cash taken into a till that has closed since it was picked would
      // never reach a Z report.
      await holdShiftOpen(tx, context.shiftId);
      // Atomic guarded decrement: the balance check and the write happen in
      // one statement against the row's live value, so two concurrent
      // payments can't both pass a stale "amount <= balance" check and drive
      // the balance negative.
      const result = await tx.customer.updateMany({
        where: { id, businessId, creditBalance: { gte: amount } },
        data: { creditBalance: { decrement: amount } },
      });
      if (result.count === 0) {
        throw new BadRequestException('Payment exceeds outstanding balance');
      }

      await this.payments.record(
        {
          businessId,
          type: PaymentType.CUSTOMER_CREDIT,
          amount,
          // Cash unless told otherwise: it is what a counter takes by default,
          // and mislabelling a card payment as cash would put money in the
          // expected drawer that is not physically there.
          method: context.method ?? PaymentMethod.CASH,
          customerId: id,
          storeId: context.storeId ?? null,
          shiftId: context.shiftId ?? null,
          userId: context.userId ?? null,
          note: context.note ?? null,
        },
        tx,
      );

      return tx.customer.findUniqueOrThrow({ where: { id } });
    });
  }

  /**
   * Delete a customer who has never been used -- a typo or a duplicate.
   *
   * Checked here rather than left to the database: Sale.customerId and
   * Payment.customerId are ON DELETE SET NULL, so the database never refuses.
   * The delete used to go through for anyone, silently wiping what they owed
   * off the books and turning their sales into walk-in sales.
   */
  async remove(businessId: string, id: string) {
    const customer = await this.ensure(businessId, id);
    if (Number(customer.creditBalance) > 0) {
      throw new BadRequestException(
        'This customer still owes money. Settle their balance before deleting them.',
      );
    }
    const [sales, payments] = await Promise.all([
      this.prisma.sale.count({ where: { customerId: id } }),
      this.prisma.payment.count({ where: { customerId: id } }),
    ]);
    if (sales || payments) {
      throw new BadRequestException(
        'This customer has sale or payment history and cannot be deleted.',
      );
    }
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
