import { BadRequestException } from '@nestjs/common';
import { extname } from 'path';
import { memoryStorage } from 'multer';

export {
  PRODUCT_UPLOAD_DIR,
  PRODUCT_PUBLIC_PREFIX,
  type UploadedImage,
} from './product-image.storage';

const ALLOWED = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

/**
 * Multer options for a product image.
 *
 * `memoryStorage`, not `diskStorage`: where the image ends up is
 * `ProductImageStorage`'s decision -- the bucket when object storage is
 * configured, local disk otherwise -- and multer writing it to disk first
 * would make the durable path a copy-then-delete dance for no reason.
 *
 * Holding the file in memory is safe at this size: the 5 MB limit is enforced
 * by multer before the buffer is handed over, and one image at a time per
 * request is nothing beside what the report endpoints used to allocate.
 */
export const productImageMulterOptions = {
  storage: memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (
    _req: unknown,
    file: { originalname: string },
    cb: (e: Error | null, accept: boolean) => void,
  ) => {
    const ext = extname(file.originalname).toLowerCase();
    if (!ALLOWED.includes(ext)) {
      return cb(new BadRequestException('Only image files are allowed'), false);
    }
    cb(null, true);
  },
};
