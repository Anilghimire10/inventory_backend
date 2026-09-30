import { Logger } from '@nestjs/common';
import { PlatformRole, SubscriptionPaymentMethod } from '@prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { METHOD_LABEL } from './receipt';

/**
 * Email every active full admin about a payment report waiting to be checked:
 * one a shop made ("I've paid"), or one raised for an online payment that
 * needs a person. Best effort: the report is saved already and shows on the
 * admin panel either way.
 */
export async function emailAdminsAboutClaim(
  prisma: PrismaService,
  mail: MailService,
  logger: Logger,
  businessName: string,
  claim: {
    submittedByName: string;
    amount: { toString(): string };
    currency: string;
    method: SubscriptionPaymentMethod;
    reference: string | null;
    months: number | null;
    note?: string | null;
  },
) {
  try {
    const admins = await prisma.platformAdmin.findMany({
      where: { isActive: true, role: PlatformRole.ADMIN },
      select: { email: true, name: true },
    });
    await Promise.all(
      admins.map((a) =>
        mail
          .sendPaymentClaim(a.email, a.name, {
            businessName,
            submittedBy: claim.submittedByName,
            amount: `${claim.currency} ${Number(claim.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
            method: METHOD_LABEL[claim.method],
            reference: claim.reference,
            months: claim.months,
            note: claim.note ?? null,
          })
          .catch((e: Error) => logger.warn(`Payment report email to ${a.email} failed: ${e.message}`)),
      ),
    );
  } catch (e) {
    logger.warn(`Payment report emails failed: ${(e as Error).message}`);
  }
}
