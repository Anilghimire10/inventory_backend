import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';
import { join } from 'path';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  // Allow larger JSON bodies for bulk product imports (default is ~100kb).
  const bodyLimit = config.get<string>('BODY_LIMIT') ?? '8mb';
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));

  // Security headers. crossOriginResourcePolicy is relaxed so uploaded images
  // can be loaded by the web app on a different origin. (CSP disabled — JSON API.)
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Serve locally-stored uploads (product images) at /api/uploads/*.
  // Sits under the same /api path the web app already proxies to the backend.
  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/api/uploads',
  });

  // All routes prefixed with /api
  app.setGlobalPrefix('api');

  // CORS. In production set CORS_ORIGIN to a comma-separated allowlist;
  // falls back to reflecting the request origin in dev.
  // The Capacitor mobile app runs from these fixed WebView origins, so they are
  // always allowed (otherwise a strict production allowlist would block the app):
  //   Android -> https://localhost   iOS -> capacitor://localhost
  const mobileOrigins = ['https://localhost', 'capacitor://localhost'];
  const corsOrigin = config.get<string>('CORS_ORIGIN');
  app.enableCors({
    origin: corsOrigin
      ? [...corsOrigin.split(',').map((s) => s.trim()).filter(Boolean), ...mobileOrigins]
      : true,
    credentials: true,
  });

  // Validate + transform every incoming DTO; strip unknown fields
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Swagger API docs at /docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Inventory Management API')
    .setDescription('Multi-business inventory, POS, and reporting API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const port = config.get<number>('PORT') ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`API running on http://localhost:${port}/api  (docs: /docs)`);
}
bootstrap();
