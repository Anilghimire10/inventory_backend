import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';

/**
 * Imported by every module with a money path -- sales, purchases, customers
 * and shifts -- each of which writes its ledger row through `PaymentsService`
 * inside the same transaction as the balance it moves.
 */
@Module({
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
