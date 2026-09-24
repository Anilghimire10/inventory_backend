import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  HttpException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

/**
 * Turn a multer error into the 4xx it is, or return null for anything else.
 *
 * Nest's FileInterceptor already does this, but by matching the error's
 * *message* against multer 1.x's strings. The `multer` override in
 * package.json moved to 2.x, which renamed some ("Unexpected field" became
 * "Unexpected file field") and added codes Nest has never heard of, so those
 * fell through as 500s -- a malformed upload read as a server fault. multer
 * documents `code` as the stable thing to check, so that is what this keys on.
 */
export function multerErrorToHttp(err: unknown): HttpException | null {
  if (!(err instanceof Error) || err.name !== 'MulterError') return null;
  const { code, field } = err as Error & { code?: unknown; field?: unknown };
  if (typeof code !== 'string') return null;
  if (code === 'LIMIT_FILE_SIZE') {
    return new PayloadTooLargeException('Image is larger than 5 MB');
  }
  const where = typeof field === 'string' && field ? ` ("${field}")` : '';
  return new BadRequestException(`${err.message}${where}`);
}

/**
 * Scoped to the upload route with @UseFilters. Everything that isn't a multer
 * error goes to BaseExceptionFilter, i.e. exactly the handling it got before.
 */
@Catch()
export class MulterErrorFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    super.catch(multerErrorToHttp(exception) ?? exception, host);
  }
}
