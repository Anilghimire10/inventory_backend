# Inventory Management API

Multi-business inventory, POS, and reporting backend.
**NestJS + Prisma + PostgreSQL** — see [../TECH_STACK.md](../TECH_STACK.md) and
[../FEATURES.md](../FEATURES.md).

## Multi-tenancy (how it scales)

Every business is a **tenant**. Each tenant-scoped row carries a `businessId`.
On login the JWT encodes the user's `businessId`; the `JwtStrategy` rebuilds it
into `req.user`, and every service filters by it. One database serves any number
of businesses with full data isolation — and you can shard by `businessId` later
without changing the API.

- **Auth:** global `JwtAuthGuard` — every route needs a token unless `@Public()`.
- **Roles:** `@Roles(...)` + `RolesGuard`. `OWNER` passes every check.
- **Tenant scope:** `@CurrentUser()` gives the handler `businessId`; services
  never trust a client-supplied business id.

## Quick start

```bash
# 1. Install deps
npm install

# 2. Start PostgreSQL (Docker)
docker compose up -d

# 3. Configure env
cp .env.example .env        # then edit JWT_SECRET

# 4. Create the database schema
npm run prisma:migrate -- --name init

# 5. (optional) Seed a demo pharmacy
npm run db:seed

# 6. Run the API
npm run start:dev
```

- API:  http://localhost:3000/api
- Docs: http://localhost:3000/docs  (Swagger — click **Authorize**, paste your token)

Demo login (after seeding): `owner@demo.com` / `password123`

## API surface

| Area | Routes |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` |
| Users | `CRUD /users` (admin) |
| Stores | `CRUD /stores` |
| Categories | `CRUD /categories` |
| Products | `CRUD /products`, `GET /products/barcode/:barcode` |
| Inventory | `GET /inventory/stock`, `/low-stock`, `/expiring`, `/movements`; `POST /inventory/adjust`, `/reorder-level` |
| Suppliers | `CRUD /suppliers` |
| Purchases | `POST /purchases`, `POST /purchases/:id/receive`, `GET /purchases` |
| Sales / POS | `POST /sales`, `POST /sales/:id/return`, `GET /sales`, `GET /sales/:id` |
| Customers | `CRUD /customers`, `POST /customers/:id/pay-credit` |
| Reports | `GET /reports/dashboard`, `GET /reports/sales-summary` |

## Design notes

- **One stock path:** all stock changes go through `InventoryService.applyMovement`,
  which updates the per-store balance *and* writes an audit `StockMovement`.
  Sales and purchases call it inside their own DB transaction, so stock and
  records commit together (no overselling, no orphan movements).
- **Money:** stored as `Decimal(12,2)`; line math rounds to 2 dp.
- **Soft deletes:** products / users / stores deactivate (`isActive`) to preserve
  history. Categories detach from products instead of cascading.
- **Business-type features:** `isRxRequired` (pharmacy Rx block at checkout) and
  `trackBatches` (expiry/FEFO) are per-product flags, so one codebase serves
  grocery, pharmacy, and general retail.

## Roadmap hooks (not yet built)

- Thermal receipt printing (see FEATURES.md §5a).
- CSV product import, held sales, advanced reports, notifications.
- Refresh tokens / email verification.
