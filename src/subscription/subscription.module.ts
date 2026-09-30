import { Module } from '@nestjs/common';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';
import { ProductImageStorage } from '../products/product-image.storage';
import { PlatformAuditService } from '../platform/platform-audit.service';
import { OnlinePaymentReturnController } from './online-payment-return.controller';
import { OnlinePaymentsService } from './online-payments.service';
import { PaymentGateways } from './payment-gateways';

@Module({
  controllers: [SubscriptionController, OnlinePaymentReturnController],
  providers: [
    SubscriptionService,
    // Payment screenshots are stored the way product images are.
    ProductImageStorage,
    OnlinePaymentsService,
    PaymentGateways,
    // Online payments are written to the admin log, like recorded ones.
    PlatformAuditService,
  ],
})
export class SubscriptionModule {}
