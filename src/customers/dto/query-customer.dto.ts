import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class QueryCustomerDto extends PaginationDto {
  @ApiPropertyOptional({
    description:
      'Only customers who have shopped at this store. A customer record itself ' +
      'is business-wide — this filters by where they have actually bought.',
  })
  @IsOptional()
  @IsString()
  storeId?: string;
}
