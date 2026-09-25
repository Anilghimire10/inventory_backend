import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupportTicketStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class CreateTicketDto {
  @ApiProperty({ example: 'Receipt printer prints blank pages' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  subject: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body: string;
}

export class SupportMessageDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body: string;
}

export class QueryTicketsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: SupportTicketStatus })
  @IsOptional()
  @IsEnum(SupportTicketStatus)
  status?: SupportTicketStatus;
}

export class SetTicketStatusDto {
  @ApiProperty({ enum: SupportTicketStatus })
  @IsEnum(SupportTicketStatus)
  status: SupportTicketStatus;
}
