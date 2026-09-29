import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationType, Prisma, SupportTicketCategory, SupportTicketStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { paginate } from '../common/dto/pagination.dto';
import { AuthUser } from '../common/types/auth-user';
import { Actor, PlatformAuditService } from '../platform/platform-audit.service';
import {
  AdminQueryTicketsDto,
  CreateTicketDto,
  QueryTicketsDto,
  ReplyTemplateDto,
  UpdateTicketDto,
} from './dto/support.dto';

/** How a category reads in the support inbox's email. */
export const CATEGORY_LABEL: Record<SupportTicketCategory, string> = {
  BILLING: 'Billing',
  PROBLEM: 'Problem',
  HOW_TO: 'How to',
  FEATURE: 'Feature request',
  OTHER: 'Other',
};

/** What a ticket list row carries: enough for an inbox, not the thread. */
const LIST_SELECT = {
  id: true,
  subject: true,
  status: true,
  category: true,
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
  userId: true,
  messages: {
    orderBy: { createdAt: 'asc' },
    select: { id: true, fromAdmin: true, authorName: true, body: true, createdAt: true },
  },
} satisfies Prisma.SupportTicketSelect;

type ListRow = Prisma.SupportTicketGetPayload<{ select: typeof LIST_SELECT }>;

/** What only the admin side sees: the shop, and which admin has the ticket. */
const ADMIN_EXTRA = {
  business: { select: { id: true, name: true } },
  assignedAdmin: { select: { id: true, name: true } },
} satisfies Prisma.SupportTicketSelect;

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
    const category = dto.category ?? SupportTicketCategory.OTHER;
    const ticket = await this.prisma.supportTicket.create({
      data: {
        businessId: user.businessId,
        userId: user.userId,
        userName: author.name,
        userEmail: author.email,
        subject,
        category,
        messages: { create: { fromAdmin: false, authorName: author.name, body } },
      },
      select: THREAD_SELECT,
    });

    // Best effort: the ticket is saved whether or not the heads-up goes out.
    const inbox = process.env.SUPPORT_EMAIL?.trim();
    if (inbox) {
      this.mail
        .sendSupportNew(
          inbox,
          author.business.name,
          `${author.name} <${author.email}>`,
          subject,
          body,
          CATEGORY_LABEL[category],
        )
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

  /**
   * The shop adds to its thread. A closed ticket reopens: they still need
   * help. The support inbox is emailed, as for a new ticket, so a follow-up
   * doesn't wait until someone happens to open the panel.
   */
  async replyFromShop(user: AuthUser, id: string, body: string) {
    const ticket = await this.getForShop(user, id);
    const author = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { name: true, email: true, business: { select: { name: true } } },
    });
    const text = body.trim();
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: { ticketId: id, fromAdmin: false, authorName: author?.name ?? user.email, body: text },
      }),
      this.prisma.supportTicket.update({
        where: { id },
        data: { status: SupportTicketStatus.OPEN, lastMessageAt: now },
      }),
    ]);

    const inbox = process.env.SUPPORT_EMAIL?.trim();
    if (inbox && author) {
      this.mail
        .sendSupportFollowUp(inbox, author.business.name, `${author.name} <${author.email}>`, ticket.subject, text)
        .catch((e: Error) => this.logger.warn(`Support follow-up email failed: ${e.message}`));
    }
    return this.getForShop(user, id);
  }

  // ---- Admin side ----

  async listForAdmin(q: AdminQueryTicketsDto, actor: Actor) {
    const assigned =
      q.assigned === 'me' ? actor.adminId : q.assigned === 'none' ? null : q.assigned;
    const where: Prisma.SupportTicketWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.businessId ? { businessId: q.businessId } : {}),
      ...(q.assigned !== undefined ? { assignedAdminId: assigned } : {}),
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
    const [rows, total, open, awaiting] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip: q.skip,
        take: q.limit,
        select: { ...LIST_SELECT, ...ADMIN_EXTRA },
      }),
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.count({ where: { status: SupportTicketStatus.OPEN } }),
      this.countAwaitingReply(),
    ]);
    return {
      ...paginate(
        rows.map(({ business, assignedAdmin, ...r }) => ({ ...toListItem(r), business, assignedAdmin })),
        total,
        q.page,
        q.limit,
      ),
      openCount: open,
      // What the sidebar badge shows: only tickets someone on our side still
      // owes an answer, so it clears once they are answered.
      awaitingCount: awaiting,
    };
  }

  /**
   * Open tickets whose latest message is from the shop -- the same rule as
   * `awaitingReply` on a row. "Latest message" isn't something Prisma can
   * filter on, hence the SQL; (ticketId, createdAt) is indexed.
   */
  private async countAwaitingReply(): Promise<number> {
    const [row] = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n
      FROM "SupportTicket" t
      WHERE t.status = 'OPEN'
        AND (
          SELECT m."fromAdmin" FROM "SupportMessage" m
          WHERE m."ticketId" = t.id
          ORDER BY m."createdAt" DESC, m.id DESC
          LIMIT 1
        ) = false`;
    return Number(row?.n ?? 0);
  }

  async getForAdmin(id: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id },
      select: { ...THREAD_SELECT, ...ADMIN_EXTRA },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  /**
   * Answer a ticket. Whoever raised it hears about it twice: their own bell,
   * linking to the ticket, and an email with the text. The bell notice is
   * theirs alone -- a cashier's ticket is not the rest of the shop's
   * business. If that person has since been removed, it falls back to the
   * whole shop, where the owner and managers can still open the ticket.
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
      // Whoever answers an unassigned ticket takes it, so the inbox always
      // says whose it is once someone has picked it up.
      this.prisma.supportTicket.update({
        where: { id },
        data: { lastMessageAt: now, ...(ticket.assignedAdmin ? {} : { assignedAdminId: actor.adminId }) },
      }),
      this.prisma.notification.create({
        data: {
          businessId: ticket.businessId,
          type: NotificationType.GENERAL,
          userId: ticket.userId,
          title: `Support replied: ${ticket.subject}`.slice(0, 200),
          body: 'Tap to read the reply.',
          link: `/support?ticket=${id}`,
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

  /** Close or reopen, and/or correct the category. Each change is logged. */
  async update(actor: Actor, id: string, dto: UpdateTicketDto) {
    const ticket = await this.getForAdmin(id);
    const { status, category } = dto;
    if (status && ticket.status !== status) {
      await this.prisma.supportTicket.update({ where: { id }, data: { status } });
      await this.audit.record(actor, status === SupportTicketStatus.CLOSED ? 'support.close' : 'support.reopen', {
        businessId: ticket.businessId,
        details: { ticketId: id, subject: ticket.subject },
      });
    }
    if (category && ticket.category !== category) {
      await this.prisma.supportTicket.update({ where: { id }, data: { category } });
      await this.audit.record(actor, 'support.category', {
        businessId: ticket.businessId,
        details: { ticketId: id, subject: ticket.subject, from: ticket.category, to: category },
      });
    }
    return this.getForAdmin(id);
  }

  /** Hand a ticket to an admin (active ones only), or take it off them. */
  async assign(actor: Actor, id: string, adminId: string | null) {
    const ticket = await this.getForAdmin(id);
    let to: { id: string; email: string } | null = null;
    if (adminId) {
      to = await this.prisma.platformAdmin.findFirst({
        where: { id: adminId, isActive: true },
        select: { id: true, email: true },
      });
      if (!to) throw new BadRequestException('That admin does not exist or is deactivated');
    }
    if ((ticket.assignedAdmin?.id ?? null) !== (to?.id ?? null)) {
      await this.prisma.supportTicket.update({ where: { id }, data: { assignedAdminId: to?.id ?? null } });
      await this.audit.record(actor, 'support.assign', {
        businessId: ticket.businessId,
        details: { ticketId: id, subject: ticket.subject, to: to?.email ?? null },
      });
    }
    return this.getForAdmin(id);
  }

  // ---- Saved replies ----

  listTemplates() {
    return this.prisma.supportReplyTemplate.findMany({ orderBy: { title: 'asc' } });
  }

  createTemplate(actor: Actor, dto: ReplyTemplateDto) {
    return this.prisma.supportReplyTemplate.create({
      data: { title: dto.title.trim(), body: dto.body.trim(), createdByEmail: actor.email },
    });
  }

  async updateTemplate(id: string, dto: ReplyTemplateDto) {
    const res = await this.prisma.supportReplyTemplate.updateMany({
      where: { id },
      data: { title: dto.title.trim(), body: dto.body.trim() },
    });
    if (res.count === 0) throw new NotFoundException('Saved reply not found');
    return this.prisma.supportReplyTemplate.findUnique({ where: { id } });
  }

  async deleteTemplate(id: string) {
    const res = await this.prisma.supportReplyTemplate.deleteMany({ where: { id } });
    if (res.count === 0) throw new NotFoundException('Saved reply not found');
    return { ok: true };
  }
}
