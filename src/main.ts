import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { json, urlencoded } from "express";
import { join } from "path";
import helmet from "helmet";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  // Without this, PrismaService.onModuleDestroy() never fires on SIGTERM/SIGINT
  // (including the restart `nest start --watch` does on every save), so each
  // restart leaks its old Prisma connections instead of releasing them --
  // against Supabase's session-mode pooler (hard-capped at 15 clients), that
  // adds up fast and starves everyone else with "max clients reached".
  app.enableShutdownHooks();

  // Trust the platform's load balancer (Render, and any other single reverse
  // proxy) so req.ip is the X-Forwarded-For client address rather than the
  // proxy's own. Rate limiting buckets by req.ip: without this every request
  // that arrives through the proxy shares one bucket, so the global limit and
  // the tighter credential limit on /auth/login apply to the whole platform
  // at once instead of per user, and ordinary traffic locks everybody out.
  // It also means AuditLog.ip records the caller instead of the proxy.
  //
  // The 1 is the hop count, and it matters: `true` would trust the entire
  // X-Forwarded-For chain, letting a caller prepend any address they like and
  // so pick their own rate-limit bucket. Raise it only if you put additional
  // proxies of your own in front of this app.
  app.set("trust proxy", 1);

  // Allow larger JSON bodies for bulk product imports (default is ~100kb).
  const bodyLimit = config.get<string>("BODY_LIMIT") ?? "8mb";
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));

  // Security headers. crossOriginResourcePolicy is relaxed so uploaded images
  // can be loaded by the web app on a different origin. (CSP disabled — JSON API.)
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );

  // Serve locally-stored uploads (product images) at /api/uploads/*.
  // Sits under the same /api path the web app already proxies to the backend.
  app.useStaticAssets(join(process.cwd(), "uploads"), {
    prefix: "/api/uploads",
  });

  // All routes prefixed with /api
  app.setGlobalPrefix("api");

  // CORS. In production set CORS_ORIGIN to a comma-separated allowlist;
  // falls back to reflecting the request origin in dev.
  // The Capacitor mobile app runs from these fixed WebView origins, so they are
  // always allowed (otherwise a strict production allowlist would block the app):
  //   Android -> https://localhost   iOS -> capacitor://localhost
  // CORS_ORIGIN is mandatory in production (enforced at boot by validateEnv),
  // so the reflect-any-origin fallback below can only ever be reached in dev.
  const mobileOrigins = ["https://localhost", "capacitor://localhost"];
  const corsOrigin = config.get<string>("CORS_ORIGIN");
  app.enableCors({
    origin: corsOrigin
      ? [
          ...corsOrigin
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          ...mobileOrigins,
        ]
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

  // Swagger API docs at /docs. Off in production by default: it publishes
  // every route, DTO shape and validation rule in the app, which is a map for
  // anyone probing the API. Set ENABLE_SWAGGER=true to turn it back on for a
  // staging deploy.
  const isProd = config.get<string>("NODE_ENV") === "production";
  const swaggerEnabled =
    config.get<string>("ENABLE_SWAGGER") === "true" || !isProd;
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("Inventory Management API")
      .setDescription("Multi-business inventory, POS, and reporting API")
      .setVersion("0.1.0")
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup("docs", app, document);
  }

  const port = config.get<number>("PORT") ?? 3000;
  await app.listen(port);
  console.log(
    `API running on http://localhost:${port}/api` +
      (swaggerEnabled ? "  (docs: /docs)" : "  (docs disabled)"),
  );
}
void bootstrap();
