import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupportTicketStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
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

/** The admin inbox also filters by who is handling a ticket. */
export class AdminQueryTicketsDto extends QueryTicketsDto {
  @ApiPropertyOptional({ description: '"me", "none" (unassigned), or an admin id' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  assigned?: string;
}

export class AssignTicketDto {
  @ApiProperty({ nullable: true, description: 'Admin to hand it to; null unassigns' })
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(64)
  adminId: string | null;
}

export class ReplyTemplateDto {
  @ApiProperty({ example: 'Forgot password' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  title: string;

  @ApiProperty({ description: '{name} and {business} are filled in when used' })
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body: string;
}
