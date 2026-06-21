import { PartialType } from '@nestjs/swagger';
import { CreatePurchaseDto } from './create-purchase.dto';

/**
 * Editing a purchase: every field is optional. `items`, when supplied,
 * replaces the whole line list and (for a received purchase) re-applies
 * stock. The service requires at least one item when items are sent.
 */
export class UpdatePurchaseDto extends PartialType(CreatePurchaseDto) {}
