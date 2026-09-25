import { Module } from '@nestjs/common';
import { BusinessService } from './business.service';
import { BusinessController } from './business.controller';

@Module({
  controllers: [BusinessController],
  providers: [BusinessService],
  // The admin panel exports a business with the same code the owner uses.
  exports: [BusinessService],
})
export class BusinessModule {}
