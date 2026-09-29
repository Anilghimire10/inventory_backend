import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupportTicketCategory, SupportTicketStatus } from '@prisma/client';
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

  // Optional so an app build from before categories can still ask: its
  // tickets land as OTHER.
  @ApiPropertyOptional({ enum: SupportTicketCategory, default: SupportTicketCategory.OTHER })
  @IsOptional()
  @IsEnum(SupportTicketCategory)
  category?: SupportTicketCategory;
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

/** Close or reopen a ticket, or correct its category. Either or both. */
export class UpdateTicketDto {
  @ApiPropertyOptional({ enum: SupportTicketStatus })
  @IsOptional()
  @IsEnum(SupportTicketStatus)
  status?: SupportTicketStatus;

  @ApiPropertyOptional({ enum: SupportTicketCategory })
  @IsOptional()
  @IsEnum(SupportTicketCategory)
  category?: SupportTicketCategory;
}

/** The admin inbox also filters by who is handling a ticket. */
export class AdminQueryTicketsDto extends QueryTicketsDto {
  @ApiPropertyOptional({ description: '"me", "none" (unassigned), or an admin id' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  assigned?: string;

  @ApiPropertyOptional({ enum: SupportTicketCategory })
  @IsOptional()
  @IsEnum(SupportTicketCategory)
  category?: SupportTicketCategory;

  /** One shop's tickets, for the Support tab on its business page. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  businessId?: string;
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
