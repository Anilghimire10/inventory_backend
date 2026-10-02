-- Maintenance mode: while on, the shop app is closed (every shop request is
-- refused with 503) and the admin panel keeps working. Off by default. Additive.
ALTER TABLE "PlatformSettings" ADD COLUMN "maintenanceMode" BOOLEAN NOT NULL DEFAULT false;
