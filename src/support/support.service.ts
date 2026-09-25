import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationType, Prisma, SupportTicketStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { paginate } from '../common/dto/pagination.dto';
import { AuthUser } from '../common/types/auth-user';
import { Actor, PlatformAuditService } from '../platform/platform-audit.service';
import { CreateTicketDto, QueryTicketsDto } from './dto/support.dto';

/** What a ticket list row carries: enough for an inbox, not the thread. */
const LIST_SELECT = {
  id: true,
  subject: true,
  status: true,
  userName: true,
  userEmail: true,
  lastMessageAt: true,
  createdAt: true,
  _count: { select: { messages: true } },
  // The latest message, for the preview line and "waiting on whom".
  messages: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { body: true, fromAdmin: true, createdAt: true },
  },
} satisfies Prisma.SupportTicketSelect;

const THREAD_SELECT = {
  ...LIST_SELECT,
  businessId: true,
  messages: {
    orderBy: { createdAt: 'asc' },
    select: { id: true, fromAdmin: true, authorName: true, body: true, createdAt: true },
  },
} satisfies Prisma.SupportTicketSelect;

type ListRow = Prisma.SupportTicketGetPayload<{ select: typeof LIST_SELECT }>;

/** Flatten the latest-message include into the fields an inbox shows. */
function toListItem({ messages, _count, ...t }: ListRow) {
  const last = messages[0];
  return {
    ...t,
    messageCount: _count.messages,
    lastMessage: last ? { body: last.body.slice(0, 200), fromAdmin: last.fromAdmin } : null,
    // Open and the shop spoke last: someone on our side owes an answer.
    awaitingReply: t.status === SupportTicketStatus.OPEN && !!last && !last.fromAdmin,
  };
}

/**
 * The support inbox (admin panel FEATURES.md section 4): shops raise tickets
 * from the app, admins answer them from the panel, and either side can add
 * to the thread.
 *
 * In the shop, owners and managers see every ticket their business raised;
 * other staff see only their own, since a ticket can mention anything.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private audit: PlatformAuditService,
  ) {}

  // ---- Shop side ----

  private shopScope(user: AuthUser): Prisma.SupportTicketWhereInput {
    const seesAll = user.role === UserRole.OWNER || user.role === UserRole.MANAGER;
    return { businessId: user.businessId, ...(seesAll ? {} : { userId: user.userId }) };
  }

  async create(user: AuthUser, dto: CreateTicketDto) {
    const author = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { name: true, email: true, business: { select: { name: true } } },
    });
    if (!author) throw new NotFoundException('User not found');
    const subject = dto.subject.trim();
    const body = dto.body.trim();
    const ticket = await this.prisma.supportTicket.create({
      data: {
        businessId: user.businessId,
        userId: user.userId,
        userName: author.name,
        userEmail: author.email,
        subject,
        messages: { create: { fromAdmin: false, authorName: author.name, body } },
      },
      select: THREAD_SELECT,
    });

    // Best effort: the ticket is saved whether or not the heads-up goes out.
    const inbox = process.env.SUPPORT_EMAIL?.trim();
    if (inbox) {
      this.mail
        .sendSupportNew(inbox, author.business.name, `${author.name} <${author.email}>`, subject, body)
        .catch((e: Error) => this.logger.warn(`New-ticket email failed: ${e.message}`));
    }
    return ticket;
  }

  async listForShop(user: AuthUser, q: QueryTicketsDto) {
    const where: Prisma.SupportTicketWhereInput = {
      ...this.shopScope(user),
      ...(q.status ? { status: q.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip: q.skip,
        take: q.limit,
        select: LIST_SELECT,
      }),
      this.prisma.supportTicket.count({ where }),
    ]);
    return paginate(rows.map(toListItem), total, q.page, q.limit);
  }

  async getForShop(user: AuthUser, id: string) {
    const ticket = await this.prisma.supportTicket.findFirst({
      where: { id, ...this.shopScope(user) },
      select: THREAD_SELECT,
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  /** The shop adds to its thread. A closed ticket reopens: they still need help. */
  async replyFromShop(user: AuthUser, id: string, body: string) {
    await this.getForShop(user, id);
    const author = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { name: true },
    });
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: { ticketId: id, fromAdmin: false, authorName: author?.name ?? user.email, body: body.trim() },
      }),
      this.prisma.supportTicket.update({
        where: { id },
        data: { status: SupportTicketStatus.OPEN, lastMessageAt: now },
      }),
    ]);
    return this.getForShop(user, id);
  }

  // ---- Admin side ----

  async listForAdmin(q: QueryTicketsDto) {
    const where: Prisma.SupportTicketWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.search
        ? {
            OR: [
              { subject: { contains: q.search, mode: 'insensitive' } },
              { userEmail: { contains: q.search, mode: 'insensitive' } },
              { business: { name: { contains: q.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total, open] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip: q.skip,
        take: q.limit,
        select: { ...LIST_SELECT, business: { select: { id: true, name: true } } },
      }),
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.count({ where: { status: SupportTicketStatus.OPEN } }),
    ]);
    return {
      ...paginate(
        rows.map(({ business, ...r }) => ({ ...toListItem(r), business })),
        total,
        q.page,
        q.limit,
      ),
      openCount: open,
    };
  }

  async getForAdmin(id: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id },
      select: { ...THREAD_SELECT, business: { select: { id: true, name: true } } },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  /**
   * Answer a ticket. The shop hears about it twice: the bell, which says only
   * that there is a reply (it is business-wide, and the ticket may be one
   * staff member's own), and an email to whoever raised it, with the text.
   */
  async replyFromAdmin(actor: Actor, id: string, body: string) {
    const ticket = await this.getForAdmin(id);
    const admin = await this.prisma.platformAdmin.findUnique({
      where: { id: actor.adminId! },
      select: { name: true },
    });
    const text = body.trim();
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: {
          ticketId: id,
          fromAdmin: true,
          adminId: actor.adminId,
          authorName: admin?.name ?? 'Support',
          body: text,
        },
      }),
      this.prisma.supportTicket.update({ where: { id }, data: { lastMessageAt: now } }),
      this.prisma.notification.create({
        data: {
          businessId: ticket.businessId,
          type: NotificationType.GENERAL,
          title: `Support replied: ${ticket.subject}`.slice(0, 200),
          body: 'Open Help & support to read it.',
        },
      }),
    ]);
    await this.audit.record(actor, 'support.reply', {
      businessId: ticket.businessId,
      details: { ticketId: id, subject: ticket.subject },
    });
    this.mail
      .sendSupportReply(ticket.userEmail, ticket.userName, ticket.subject, text, ticket.businessId)
      .catch((e: Error) => this.logger.warn(`Support reply email failed: ${e.message}`));
    return this.getForAdmin(id);
  }

  async setStatus(actor: Actor, id: string, status: SupportTicketStatus) {
    const ticket = await this.getForAdmin(id);
    if (ticket.status !== status) {
      await this.prisma.supportTicket.update({ where: { id }, data: { status } });
      await this.audit.record(actor, status === SupportTicketStatus.CLOSED ? 'support.close' : 'support.reopen', {
        businessId: ticket.businessId,
        details: { ticketId: id, subject: ticket.subject },
      });
    }
    return this.getForAdmin(id);
  }
}
