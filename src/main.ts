import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // Security headers (CSP disabled — this is a JSON API, not HTML).
  app.use(helmet({ contentSecurityPolicy: false }));

  // All routes prefixed with /api
  app.setGlobalPrefix('api');

  // CORS. In production set CORS_ORIGIN to a comma-separated allowlist;
  // falls back to reflecting the request origin in dev.
  const corsOrigin = config.get<string>('CORS_ORIGIN');
  app.enableCors({
    origin: corsOrigin ? corsOrigin.split(',').map((s) => s.trim()) : true,
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
