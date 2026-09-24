import { Module } from '@nestjs/common';
import { ShiftsService } from './shifts.service';
import { ShiftsController } from './shifts.controller';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [PaymentsModule],
  controllers: [ShiftsController],
  providers: [ShiftsService],
  // SalesService resolves a sale's drawer through the same rules the till
  // displays, so the two can never disagree about which shift a sale is on.
  exports: [ShiftsService],
})
export class ShiftsModule {}
