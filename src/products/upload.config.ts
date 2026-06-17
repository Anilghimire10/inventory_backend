import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { extname, join } from 'path';
import { diskStorage } from 'multer';

/** Where product images live on disk and the public path they are served from. */
export const PRODUCT_UPLOAD_DIR = join(process.cwd(), 'uploads', 'products');
export const PRODUCT_PUBLIC_PREFIX = '/api/uploads/products';

const ALLOWED = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

/** Minimal shape of a Multer file (avoids needing @types/multer). */
export interface UploadedImage {
  filename: string;
  mimetype: string;
}

export const productImageMulterOptions = {
  storage: diskStorage({
    destination: (_req: unknown, _file: unknown, cb: (e: Error | null, dest: string) => void) => {
      if (!existsSync(PRODUCT_UPLOAD_DIR)) {
        mkdirSync(PRODUCT_UPLOAD_DIR, { recursive: true });
      }
      cb(null, PRODUCT_UPLOAD_DIR);
    },
    filename: (
      _req: unknown,
      file: { originalname: string },
      cb: (e: Error | null, name: string) => void,
    ) => {
      const ext = extname(file.originalname).toLowerCase();
      cb(null, `${randomBytes(16).toString('hex')}${ext}`);
    },
  }),
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
