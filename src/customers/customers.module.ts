import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { PaymentsModule } from '../payments/payments.module';
import { ShiftsModule } from '../shifts/shifts.module';

@Module({
  imports: [PaymentsModule, ShiftsModule],
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
