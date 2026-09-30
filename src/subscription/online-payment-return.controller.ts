import { Controller, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { OnlinePaymentsService } from './online-payments.service';

/**
 * The payment-return page's check. Public: a locked shop's owner comes back
 * from the gateway without a session. It only asks the gateway about a
 * payment already started, so it can't be used to record one.
 */
@ApiTags('subscription')
@Public()
@Controller('subscription/online')
export class OnlinePaymentReturnController {
  constructor(private readonly online: OnlinePaymentsService) {}

  @Throttle({ default: { limit: 30, ttl: 10 * 60_000 } })
  @Post(':id/check')
  check(@Param('id') id: string) {
    return this.online.check(id);
  }
}
