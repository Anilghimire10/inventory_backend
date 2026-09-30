import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { AllowLocked } from '../common/decorators/allow-locked.decorator';
import { ProductImageStorage, type UploadedImage } from '../products/product-image.storage';
import { productImageMulterOptions } from '../products/upload.config';
import { MulterErrorFilter } from '../products/multer-error.filter';
import { CreatePaymentClaimDto } from './dto/payment-claim.dto';
import { StartOnlinePaymentDto } from './dto/online-payment.dto';
import { OnlinePaymentsService } from './online-payments.service';
import { UserRole } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthUser } from '../common/types/auth-user';
import { SubscriptionService } from './subscription.service';

/**
 * The shop app's Subscription page: where it stands, paying online, and
 * "I've paid" for money sent another way. Payments themselves are recorded by the platform. @AllowLocked: a
 * locked shop's owner can still reach all of it with a billing-only pass.
 */
@ApiTags('subscription')
@ApiBearerAuth()
@Roles(UserRole.OWNER, UserRole.MANAGER)
@AllowLocked()
@Controller('subscription')
export class SubscriptionController {
  constructor(
    private readonly subscription: SubscriptionService,
    private readonly images: ProductImageStorage,
    private readonly online: OnlinePaymentsService,
  ) {}

  /** Pay online: start an eSewa, Khalti or connectIPS payment for one of the plans. */
  @Throttle({ default: { limit: 20, ttl: 60 * 60_000 } })
  @Post('online')
  startOnline(@CurrentUser() u: AuthUser, @Body() dto: StartOnlinePaymentDto) {
    return this.online.start(u, dto);
  }

  /** "I've paid": report a payment for an admin to confirm. */
  @Throttle({ default: { limit: 10, ttl: 60 * 60_000 } })
  @Post('claims')
  createClaim(@CurrentUser() u: AuthUser, @Body() dto: CreatePaymentClaimDto) {
    // Shown to admins as an image: only a screenshot uploaded here, never a link to elsewhere.
    if (dto.proofUrl && !this.images.isOwnUrl(dto.proofUrl)) {
      throw new BadRequestException('proofUrl must be a screenshot uploaded with the report');
    }
    return this.subscription.createClaim(u, dto);
  }

  /** A screenshot of the payment; the url goes into the report's proofUrl. */
  @Throttle({ default: { limit: 20, ttl: 60 * 60_000 } })
  @Post('claims/proof')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('image', productImageMulterOptions))
  @UseFilters(MulterErrorFilter)
  async uploadProof(@UploadedFile() file?: UploadedImage) {
    if (!file) throw new BadRequestException('No image uploaded');
    return { url: await this.images.save(file) };
  }

  /** Withdraw a report still waiting for confirmation. */
  @Delete('claims/:id')
  cancelClaim(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.subscription.cancelClaim(u.businessId, id);
  }

  @Get()
  overview(@CurrentUser() u: AuthUser) {
    return this.subscription.overview(u.businessId);
  }

  @Get('payments/:id/receipt')
  receipt(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.subscription.receipt(u.businessId, id);
  }
}
