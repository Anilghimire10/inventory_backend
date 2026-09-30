import { SetMetadata } from '@nestjs/common';

export const ALLOW_LOCKED_KEY = 'allowLocked';

/**
 * A route a locked shop can still reach with its billing-only pass: seeing
 * how to pay, and reporting a payment. Everything else refuses the pass, so
 * a lapsed subscription can be paid for without the shop being usable.
 */
export const AllowLocked = () => SetMetadata(ALLOW_LOCKED_KEY, true);
