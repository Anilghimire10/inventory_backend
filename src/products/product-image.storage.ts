import {
  BadRequestException,
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';

/** Where product images land when there is no object storage configured. */
export const PRODUCT_UPLOAD_DIR = join(process.cwd(), 'uploads', 'products');
export const PRODUCT_PUBLIC_PREFIX = '/api/uploads/products';

/** The bucket images go to when Supabase Storage is configured. */
const DEFAULT_BUCKET = 'product-images';

/** Minimal shape of an in-memory Multer file (avoids needing @types/multer). */
export interface UploadedImage {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

/**
 * What an upload actually is, read from its first bytes.
 *
 * The filename's extension and the multipart Content-Type are both whatever
 * the client said, so neither decides what gets stored: an HTML page renamed
 * `x.png` and sent as `text/html` would otherwise be saved to a public bucket
 * and served back as a web page. The stored extension and Content-Type both
 * come from here instead, and anything that isn't one of these four formats is
 * refused. Returns null for everything else.
 */
export function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  const at = (offset: number, bytes: number[]) =>
    buf.length >= offset + bytes.length &&
    bytes.every((b, i) => buf[offset + i] === b);
  const ascii = (offset: number, text: string) =>
    at(offset, [...text].map((c) => c.charCodeAt(0)));

  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ext: '.png', mime: 'image/png' };
  }
  if (at(0, [0xff, 0xd8, 0xff])) return { ext: '.jpg', mime: 'image/jpeg' };
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) {
    return { ext: '.gif', mime: 'image/gif' };
  }
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}

/**
 * Where a product image is kept.
 *
 * Render's filesystem is ephemeral, so the local-disk path loses every image
 * uploaded since the last deploy -- no error, no log, the images simply 404
 * afterwards. Object storage is the fix, and Supabase Storage is the least new
 * infrastructure given the database is already there.
 *
 * Both paths are kept rather than one replacing the other, because the choice
 * is a deployment property, not a code one:
 *
 *   - configured (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`) -> the bucket,
 *     and the stored `imageUrl` is an absolute URL that survives any deploy;
 *   - not configured -> disk, exactly as before, which is what keeps `npm run
 *     start:dev` working on a laptop with no cloud credentials.
 *
 * The one thing that is *not* kept is the silence. Falling back in production
 * is logged at error level on the first upload, naming the consequence,
 * because the whole defect here was that losing the images looked like
 * nothing happening at all.
 *
 * Deliberately not a hard boot failure when unconfigured in production, unlike
 * JWT_SECRET or CORS_ORIGIN: those are unsafe, whereas this is lossy. Refusing
 * to start would take a working shop's till offline over product photographs.
 */
@Injectable()
export class ProductImageStorage {
  private readonly logger = new Logger(ProductImageStorage.name);
  private readonly client: SupabaseClient | null;
  private readonly bucket = process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_BUCKET;
  private warned = false;

  constructor() {
    const url = process.env.SUPABASE_URL?.trim();
    // The service-role key, not the anon key: uploads are performed by the API
    // on the user's behalf after its own role check, so it must not be subject
    // to storage RLS meant for browser clients. It is a server-side secret and
    // must never reach the web app.
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

    this.client =
      url && key
        ? createClient(url, key, { auth: { persistSession: false } })
        : null;

    if (this.client) {
      this.logger.log(`Product images -> Supabase Storage bucket "${this.bucket}"`);
    }
  }

  /** True when images are being persisted somewhere a deploy won't erase. */
  get isDurable() {
    return this.client !== null;
  }

  /**
   * Store one image and return the value to persist as `Product.imageUrl`.
   *
   * An absolute URL when it went to the bucket, or the `/api/uploads/...` path
   * when it went to disk. Callers store whichever they are given verbatim, so
   * rows written before and after this change both keep working -- `main.ts`
   * still serves the old prefix.
   */
  async save(file: UploadedImage): Promise<string> {
    const type = sniffImage(file.buffer);
    if (!type) {
      throw new BadRequestException(
        'The file is not a PNG, JPEG, WebP or GIF image',
      );
    }
    const name = `${randomBytes(16).toString('hex')}${type.ext}`;

    if (!this.client) {
      this.warnOnceIfProduction();
      return this.saveToDisk(name, file.buffer);
    }

    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(name, file.buffer, {
        contentType: type.mime,
        // Names are 16 random bytes, so a collision means something is wrong;
        // overwriting would hide it and could clobber another product's image.
        upsert: false,
      });

    if (error) {
      // Don't silently fall back to disk here. The upload was meant to be
      // durable; writing it somewhere that will be wiped instead, while
      // telling the user it succeeded, is the exact failure this class exists
      // to remove.
      this.logger.error(
        `Supabase Storage upload failed (bucket "${this.bucket}"): ${error.message}`,
      );
      throw new InternalServerErrorException(
        'Could not store the image. Please try again.',
      );
    }

    const { data } = this.client.storage.from(this.bucket).getPublicUrl(name);
    return data.publicUrl;
  }

  /**
   * Whether `url` is one `save` could have returned: a name it generates, on
   * disk or in this bucket. For a URL a client sends back to be shown to
   * someone else, so it can't point at an image hosted anywhere.
   */
  isOwnUrl(url: string): boolean {
    const name = url.slice(url.lastIndexOf('/') + 1);
    if (!/^[0-9a-f]{32}\.(png|jpg|gif|webp)$/.test(name)) return false;
    if (url === `${PRODUCT_PUBLIC_PREFIX}/${name}`) return true;
    return !!this.client && url === this.client.storage.from(this.bucket).getPublicUrl(name).data.publicUrl;
  }

  private async saveToDisk(name: string, buffer: Buffer): Promise<string> {
    if (!existsSync(PRODUCT_UPLOAD_DIR)) {
      mkdirSync(PRODUCT_UPLOAD_DIR, { recursive: true });
    }
    await writeFile(join(PRODUCT_UPLOAD_DIR, name), buffer);
    return `${PRODUCT_PUBLIC_PREFIX}/${name}`;
  }

  /**
   * Say it once, loudly, on the first upload rather than at boot: a deploy
   * that never receives an image never had a problem, and an error logged at
   * startup on every instance is the kind that gets filtered out.
   */
  private warnOnceIfProduction() {
    if (this.warned || process.env.NODE_ENV !== 'production') return;
    this.warned = true;
    this.logger.error(
      'Product images are being written to local disk because SUPABASE_URL / ' +
        'SUPABASE_SERVICE_ROLE_KEY are not set. On an ephemeral filesystem ' +
        '(Render, Fly, Heroku) every image uploaded since the last deploy is ' +
        'destroyed by the next one. Configure object storage.',
    );
  }
}
