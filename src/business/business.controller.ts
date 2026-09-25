import { Body, Controller, ForbiddenException, Get, Patch, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { SalesModel } from "@prisma/client";
import type { Response } from "express";
import { once } from "node:events";
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from "class-validator";
import { isValidTimezone } from "../common/timezone";
import { UserRole } from "@prisma/client";
import { BusinessService } from "./business.service";
import { Roles } from "../common/decorators/roles.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthUser } from "../common/types/auth-user";

/**
 * An IANA zone name the runtime actually knows.
 *
 * Validated against `Intl` rather than a hand-kept list, so it accepts every
 * zone the reports can then cut days on and nothing else. A typo stored here
 * would otherwise sit in the column until it threw from inside a report.
 */
@ValidatorConstraint({ name: "isIanaTimezone", async: false })
export class IsIanaTimezone implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return typeof value === "string" && isValidTimezone(value);
  }
  defaultMessage() {
    return "timezone must be an IANA zone name, e.g. Asia/Kathmandu";
  }
}

export class UpdateBusinessDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @MinLength(2)
  name?: string;

  // NOTE: `type` (the vertical) is deliberately NOT editable here. It is locked
  // after signup and can only be changed by a platform super-admin.

  @ApiPropertyOptional({ enum: SalesModel })
  @IsOptional()
  @IsEnum(SalesModel)
  salesModel?: SalesModel;

  @ApiPropertyOptional({ description: "3-letter currency code" })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiPropertyOptional({
    description:
      "IANA time zone the shop's day is cut on, e.g. Asia/Kathmandu. " +
      "Reports, daily buckets and the hour-of-day chart all key off this.",
    example: "Asia/Kathmandu",
  })
  @IsOptional()
  @IsString()
  @Validate(IsIanaTimezone)
  timezone?: string;

  @ApiPropertyOptional({ description: "PAN/VAT registration number" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  taxId?: string;

  @ApiPropertyOptional({
    description: "Show the PAN/VAT number on printed bills and invoices",
  })
  @IsOptional()
  @IsBoolean()
  showTaxIdOnBill?: boolean;

  @ApiPropertyOptional({ description: "Prices include tax" })
  @IsOptional()
  @IsBoolean()
  taxInclusive?: boolean;

  @ApiPropertyOptional({
    description: "Master tax switch: when false, no sale charges tax",
  })
  @IsOptional()
  @IsBoolean()
  taxEnabled?: boolean;
}

@ApiTags("business")
@ApiBearerAuth()
@Controller("business")
export class BusinessController {
  constructor(private readonly business: BusinessService) {}

  /** The current tenant's business profile. */
  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Get()
  get(@CurrentUser() u: AuthUser) {
    return this.business.get(u.businessId);
  }

  @Roles(UserRole.OWNER, UserRole.MANAGER)
  @Patch()
  update(@CurrentUser() u: AuthUser, @Body() dto: UpdateBusinessDto) {
    return this.business.update(u.businessId, dto);
  }

  /**
   * Owner-only: full export of the business's data, streamed as NDJSON.
   *
   * Written straight to the response rather than returned, so Nest never
   * holds the whole export to serialise it. `res.write` returning false means
   * the client isn't keeping up; awaiting `drain` before the next page stops
   * the export filling the process's socket buffer with rows nobody has
   * read yet -- which for a large tenant is the same out-of-memory failure
   * from the other end.
   *
   * Refused in a "view as owner" session. It is a GET, so the read-only
   * guard lets it through, but it is the whole tenant in one file and the
   * admin log would only show the session starting. The panel's own export
   * is logged per download.
   */
  @Roles(UserRole.OWNER)
  @Get("export")
  async exportData(@CurrentUser() u: AuthUser, @Res() res: Response) {
    if (u.impersonatedBy) {
      throw new ForbiddenException({
        statusCode: 403,
        error: "Forbidden",
        code: "READ_ONLY",
        message:
          "The full export isn't available while viewing as the owner. Use Export on the business page in the admin panel.",
      });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="business-export-${stamp}.ndjson"`,
    );
    for await (const chunk of this.business.exportNdjson(u.businessId)) {
      if (!res.write(chunk)) await once(res, "drain");
    }
    res.end();
  }
}
