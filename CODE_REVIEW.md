# API Code Review

**Date:** 2026-09-19 · **Commit reviewed:** `2e6f0d3` (main) · **Scope:** everything under `api/`

Items marked **Reproduced** were confirmed by running the real code (stubbed
database, no production data touched). Everything else comes from reading the
code. `npm run check` passes, but it covers neither auth nor sale returns, and
that is where most of the bugs below are.

---

## Summary

| # | Severity | Problem | Where |
|---|----------|---------|-------|
| 1 | 🔴 Critical | Verify-email gives a login token for any verified account, whatever the code | `auth.service.ts` |
| 2 | 🔴 Critical | Rate limiter blocks an IP until restart; behind Render all users likely share one IP | `app.module.ts`, `main.ts` |
| 3 | 🟠 High | Partial returns get marked fully `RETURNED` (Decimal compared as text) | `sales.service.ts` |
| 4 | 🟠 High | Refund ignores the bill discount, so more is refunded than was paid | `sales.service.ts`, `shifts.service.ts` |
| 5 | 🟠 High | Same line twice (or two concurrent returns) returns more than was sold | `sales.service.ts`, `purchases.service.ts` |
| 6 | 🟠 High | Tax and revenue reports drop partially returned sales entirely | `reports.service.ts`, `sales.service.ts` |
| 7 | 🟠 High | `JWT_SECRET` silently falls back to `'dev-secret'` | 4 files |
| 8 | 🟡 Medium | Codes use `Math.random`; no per-account attempt limit | `auth.service.ts` |
| 9 | 🟡 Medium | Product images are saved to local disk, which Render wipes on every deploy | `upload.config.ts` |
| 10 | 🟡 Medium | A password reset or change doesn't revoke existing 7-day tokens | `auth.service.ts`, `jwt.strategy.ts` |
| 11 | 🟢 Low | User-typed names go into email HTML unescaped | `mail.service.ts` |
| 12 | 🟢 Low | `/health` publicly shows the DB host and user count | `health.controller.ts` |
| 13 | 🟡 Medium | Reports load whole tables into memory | `reports.service.ts`, `inventory.service.ts`, others |
| 14 | 🟡 Medium | The notification bell writes on every read (one upsert per alert) | `notifications.service.ts` |
| 15 | 🟡 Medium | Purchases and imports make several round trips per line; big imports time out | `purchases.service.ts`, `products.service.ts` |
| 16 | 🟡 Medium | All day boundaries use server UTC (off by 5h45m for Nepal) | `reports.service.ts`, `sales.service.ts` |
| 17 | 🟡 Medium | No payment ledger: payments just change a balance | `customers.service.ts`, `purchases.service.ts` |
| 18 | 🟢 Low | `PATCH /purchases/:id` wipes fields the request leaves out | `purchases.service.ts` |
| 19 | 🟢 Low | Product update doesn't check that `parentId` is in the same business | `products.service.ts` |
| 20 | 🟢 Low | Permission gaps to decide on | several |
| 21–30 | ⚪ Cleanup | Duplication, dead code, structure, tooling | see below |

---

## What is already good

- Consistent module layout (controller / service / dto) across all 17 domains.
- A global `ValidationPipe` with `whitelist` + `forbidNonWhitelisted` rejects unknown fields everywhere.
- Every tenant query is limited by `businessId`, and deletes are soft so history survives.
- **The stock engine** ([src/inventory/inventory.service.ts:89](src/inventory/inventory.service.ts#L89)) is excellent:
  - every stock change goes through one function;
  - it uses atomic guarded SQL, so you can't sell stock you don't have and two simultaneous sales can't overwrite each other;
  - quantities stay exact numeric decimals.
- Other double-submit protection is solid: shift close, purchase receive and supplier payments all use guarded updates, and receipt numbers retry on collision.
- Comments explain *why*, and deliberate shortcuts are marked `ponytail:` with an upgrade path.

---

## 🔴 Fix now: security and money

### 1. Verify-email gives a login token for any verified account (Critical, Reproduced)

- **Where:** [src/auth/auth.service.ts:111-130](src/auth/auth.service.ts#L111)
- **Problem:** the code is only checked `if (!user.emailVerified)`. For an account that is already verified, the check is skipped and `issueToken()` runs anyway.
- **Impact:** anyone who knows a user's email can `POST /auth/verify-email` with `{ email, code: "000000" }` and get a valid token for that user, including OWNER accounts. The endpoint is `@Public()`. It is live if main is deployed.
- **Fix:** always require a valid code. For an already-verified account, return the same `Invalid or expired code` error (the same message avoids revealing which emails exist). Add a check for this to `test/checks.ts`.

### 2. Rate limiter blocks an IP until restart (Critical, Reproduced)

- **Where:** [src/app.module.ts:43-44](src/app.module.ts#L43), [src/main.ts:12](src/main.ts#L12)
- **Problem A:** `ConfigService.get<number>()` returns the env value as a **string** (`"60000"`). The throttler computes `Date.now() + ttl`, which joins two strings instead of adding numbers. A blocked IP got `Retry-After: 178977720254860` seconds, so it stays blocked until the process restarts.
- **Problem B:** `main.ts` never sets `trust proxy`. Behind Render's load balancer, `req.ip` is therefore the proxy's address, so all users likely share one bucket:
  - 120 requests/min for the whole platform;
  - 10 logins/min on the credential routes ([src/auth/auth.controller.ts:21](src/auth/auth.controller.ts#L21)).

  To check, look at the `ip` column in `AuditLog`: it would show the same few addresses.
- **Impact:** once traffic exceeds the limit, every user is locked out until the next restart.
- **Fix:**
  ```ts
  ttl: Number(c.get('THROTTLE_TTL') ?? 60_000),
  limit: Number(c.get('THROTTLE_LIMIT') ?? 120),
  ```
  and in `main.ts`: `app.set('trust proxy', 1);`

### 3. Partial returns get marked fully `RETURNED` (High, Reproduced)

- **Where:** [src/sales/sales.service.ts:415-417](src/sales/sales.service.ts#L415)
- **Problem:** `it.returnedQty >= it.quantity` compares two Prisma `Decimal` objects. JavaScript turns them into **strings** first, so `"5" >= "10"` is `true`.
- **Impact:** returning 5 of 10 units marks the whole sale `RETURNED`. The remaining units can never be returned ("Sale already fully returned").
- **Fix:** `it.returnedQty.gte(it.quantity)` or `Number(it.returnedQty) >= Number(it.quantity)`.

### 4. Refund ignores the bill discount (High, Reproduced)

- **Where:** [src/sales/sales.service.ts:368](src/sales/sales.service.ts#L368), [src/shifts/shifts.service.ts:192-198](src/shifts/shifts.service.ts#L192)
- **Problem:** the refund is worked out as `lineTotal / quantity × returned`. `lineTotal` is before the bill-level `Sale.discount`.
- **Impact:** a sale of 100 with a 20 bill discount (customer paid 80) refunds **100** when fully returned. The shift report's expected cash is wrong in the same way.
- **Fix:** spread the bill discount over the lines by their share of the subtotal, e.g. `refund × (total / (subtotal + tax))`. Cap the refund at what is left of `amountPaid`.

### 5. A request can return more than was sold (High, Reproduced)

- **Where:** [src/sales/sales.service.ts:358-371](src/sales/sales.service.ts#L358), [src/purchases/purchases.service.ts:382-394](src/purchases/purchases.service.ts#L382)
- **Problem:** "how much can still be returned" is worked out once, **outside the transaction**. Each request entry is then checked against that same number:
  - if the same `saleItemId` appears twice, each copy passes on its own;
  - if two return requests arrive at the same time, both pass.
- **Impact:** listing a 2-unit line twice refunded **200** and set `returnedQty` to 4. A CASHIER is allowed to do this. Purchase returns have the same gap: the supplier payable is reduced twice.
- **Fix:**
  - add up the quantities per line id before checking;
  - inside the transaction, lock the sale row (`SELECT … FOR UPDATE`) or use a guarded update (`… WHERE "returnedQty" + $qty <= quantity`) and reject when no row matches.

### 6. Tax and revenue reports drop partially returned sales (High)

- **Where:** status filter copy-pasted in [src/reports/reports.service.ts](src/reports/reports.service.ts#L37) at lines 37, 94, 148, 219, 435, 623 and 660, and in [src/sales/sales.service.ts](src/sales/sales.service.ts#L454) at lines 454-456 and 506-518
- **Problem:** every report excludes `PARTIALLY_RETURNED` sales entirely. A 10-item sale with 1 item returned disappears from revenue and from the **VAT report**, even though the line-level maths (`quantity - returnedQty`) already subtracts the returned units.
- **Impact:** tax collected and revenue are understated. Bug 3 makes it worse, because most partial returns currently end up marked `RETURNED`.
- **Fix:**
  - line-level reports (analytics lines, tax report) should exclude only `HELD`;
  - `sale.total` sums should subtract refunds instead of dropping the sale;
  - put the filter in one constant (see #21).

### 7. `JWT_SECRET` falls back to `'dev-secret'` (High)

- **Where:** [src/auth/auth.module.ts:16](src/auth/auth.module.ts#L16), [src/auth/strategies/jwt.strategy.ts:23](src/auth/strategies/jwt.strategy.ts#L23), [src/platform/platform.module.ts:18](src/platform/platform.module.ts#L18), [src/platform/strategies/platform-jwt.strategy.ts:35](src/platform/strategies/platform-jwt.strategy.ts#L35)
- **Impact:** if the env var is ever missing in production, anyone can forge tenant and super-admin tokens.
- **Fix:** `config.getOrThrow<string>('JWT_SECRET')` so the server refuses to boot without it. That also removes the four duplicated fallbacks.

### 8. Weak verification and reset codes (Medium)

- **Where:** [src/auth/auth.service.ts:292](src/auth/auth.service.ts#L292), [src/auth/auth.service.ts:309-330](src/auth/auth.service.ts#L309)
- **Problem:**
  - codes use `Math.random()`, which is not cryptographically secure;
  - there is no per-account attempt limit, only the per-IP throttle, and that is broken today (#2).
- **Fix:**
  - `crypto.randomInt(100000, 1000000)`;
  - add an `attempts` counter on `EmailToken` and burn the code after about 5 wrong tries.

---

## 🟡 Production and operations

### 9. Product images are saved to local disk (Medium)

- **Where:** [src/products/upload.config.ts:8](src/products/upload.config.ts#L8), [src/main.ts:38](src/main.ts#L38)
- **Impact:** Render's filesystem is temporary. Every deploy, restart or free-tier sleep deletes all uploaded product images, and their `imageUrl` then returns 404.
- **Fix:** upload to Supabase Storage (already in the stack) or attach a persistent disk.

### 10. Old tokens survive a password reset or change (Medium)

- **Where:** [src/auth/auth.service.ts:207-241](src/auth/auth.service.ts#L207), [src/auth/strategies/jwt.strategy.ts:28](src/auth/strategies/jwt.strategy.ts#L28)
- **Impact:** after resetting a compromised password, the attacker's token keeps working for up to 7 days. (Deactivating a user does work: `isActive` is checked on every request.)
- **Fix:**
  - add `User.passwordChangedAt`;
  - reject tokens whose `iat` is older than it in `JwtStrategy.validate`.

### 11. Email HTML is not escaped (Low)

- **Where:** [src/mail/mail.service.ts](src/mail/mail.service.ts#L112), lines 112, 122, 124, 168 and 227
- **Problem:** customer names, product names, business names and user names are put into the HTML as-is.
- **Impact:** someone can inject markup or links into emails sent from your domain.
- **Fix:** a small `escapeHtml()` helper applied to every value put into the templates.

### 12. `/health` shows internals (Low)

- **Where:** [src/health.controller.ts:20-33](src/health.controller.ts#L20)
- **Problem:** the endpoint is public and returns the DB host and total user count. It is already marked `ponytail:` to remove.
- **Fix:** return just `{ status: 'ok' }` now that the deploy is settled.

---

## 🟡 Future growth (will not scale)

### 13. Reports load whole tables into memory (Medium)

- **Where:**
  - `analytics()` loads every sale, sale line and stock movement in the range; "All time" means everything ([src/reports/reports.service.ts:176-211](src/reports/reports.service.ts#L176), [src/reports/reports.service.ts:691](src/reports/reports.service.ts#L691)).
  - `lowStock()` reads **every** stock row and filters in JS ([src/inventory/inventory.service.ts:309](src/inventory/inventory.service.ts#L309)). It runs on every bell fetch, dashboard load, reorder suggestion and daily cron.
  - `needsAttention()` calls `slowProducts(…, 5000)` and computes `inventoryValue()` a second time ([src/reports/reports.service.ts:740](src/reports/reports.service.ts#L740)).
  - `exportData()` loads the whole business in one request ([src/business/business.service.ts:32](src/business/business.service.ts#L32)).
  - `payables()` loads every purchase ([src/credit/credit.service.ts:79](src/credit/credit.service.ts#L79)).
- **Fix:**
  - move the sums and group-bys into SQL (`groupBy` / `$queryRaw`);
  - low stock becomes one query: `WHERE quantity <= COALESCE(NULLIF(si."reorderLevel", 0), p."reorderLevel")`.

### 14. The notification bell writes on every read (Medium)

- **Where:** [src/notifications/notifications.service.ts:24](src/notifications/notifications.service.ts#L24), [src/notifications/notifications.service.ts:70-131](src/notifications/notifications.service.ts#L70)
- **Problem:** every `GET /notifications` runs a full low-stock and expiry scan, a `deleteMany`, and then one `upsert` per alert, one after another.
- **Fix:** refresh alerts when stock changes or in the cron, and make the GET read-only.

### 15. Purchases and imports make several round trips per line (Medium)

- **Where:**
  - receive loop: [src/purchases/purchases.service.ts:312-333](src/purchases/purchases.service.ts#L312)
  - `receiveItems`: [src/purchases/purchases.service.ts:667-694](src/purchases/purchases.service.ts#L667)
  - edit: [src/purchases/purchases.service.ts:180-248](src/purchases/purchases.service.ts#L180)
  - bulk import: [src/products/products.service.ts:316-364](src/products/products.service.ts#L316)
- **Problem:**
  - each purchase line costs about 4 round trips to Supabase; sales were batched with `applyMovementsBatch`, purchases were not;
  - a 5,000-row product import is roughly 10–15k sequential queries with no transaction, so it times out partway and leaves a partial import.
- **Fix:**
  - use `applyMovementsBatch` for purchases;
  - chunk imports (e.g. 200 rows per `createMany` / transaction), or run them as a background job.

### 16. All dates use server UTC (Medium)

- **Where:**
  - [src/reports/reports.service.ts:25](src/reports/reports.service.ts#L25): `setHours(0)`
  - lines 116, 313 and 638: `toISOString().slice(0, 10)`
  - lines 348 and 674: `getHours()`
  - [src/sales/sales.service.ts:510](src/sales/sales.service.ts#L510)
  - web `AnalyticsPage`, which sends `${date}T00:00:00.000Z`
- **Impact:** "today", daily buckets and hourly charts are 5h45m off for Nepal, so sales between midnight and 5:45am land on the wrong day.
- **Fix:**
  - add `Business.timezone` (e.g. `Asia/Kathmandu`);
  - compute day boundaries in it (Postgres `AT TIME ZONE`);
  - have the web send local-midnight ISO strings.

### 17. No payment ledger (Medium)

- **Where:** [src/customers/customers.service.ts:72](src/customers/customers.service.ts#L72), [src/purchases/purchases.service.ts:464](src/purchases/purchases.service.ts#L464), [src/shifts/shifts.service.ts:173](src/shifts/shifts.service.ts#L173)
- **Problem:**
  - customer credit payments and supplier payments only change a balance, so there is no record of who paid what and when;
  - refunds have no row either;
  - credit collected in cash at the till is not counted in the shift's expected cash.
- **Impact:** no statements, no payment history, and the till report doesn't match the drawer. Any future accounting feature needs this first.
- **Fix:** a `Payment` table (type, amount, method, customerId/supplierId/saleId, shiftId, userId, createdAt) that every money movement writes to.

### 18. `PATCH /purchases/:id` wipes fields the request leaves out (Low)

- **Where:** [src/purchases/purchases.service.ts:206-208](src/purchases/purchases.service.ts#L206)
- **Problem:** `supplierId: dto.supplierId ?? null` (and the same for `reference` and `note`) clears the field whenever the client leaves it out.
- **Impact:** fine for today's web, which sends every field. It will lose data for a mobile client that sends only the fields it changed.
- **Fix:** only set a field when it is `!== undefined`.

### 19. Product update skips the `parentId` check (Low)

- **Where:** [src/products/products.service.ts:146-154](src/products/products.service.ts#L146)
- **Problem:** `create()` calls `assertParent()`, but `update()` spreads `parentId` through unchecked.
- **Impact:** a product can be pointed at another business's product, at itself, or at a variant (nested variants).
- **Fix:** run `assertParent()` in `update()` whenever `parentId` is supplied.

### 20. Permission gaps to decide on (Low)

- A CASHIER can set any `unitPrice` or discount at checkout ([src/sales/dto/create-sale.dto.ts:26-36](src/sales/dto/create-sale.dto.ts#L26)). Most POS systems need manager approval for this.
- `GET /sales` returns `meta.revenue` to every role, while the dashboard hides financial figures from cashiers and stock keepers ([src/sales/sales.controller.ts:85](src/sales/sales.controller.ts#L85)).
- A MANAGER can edit, including resetting the password of, another MANAGER ([src/users/users.service.ts:99](src/users/users.service.ts#L99)).
- A STOCK_KEEPER can set `amountPaid` through create/update of a purchase, although `POST /purchases/:id/pay` is owner/manager only.
- Nothing stops the server from deactivating the last active store; only the UI guards it ([src/stores/stores.service.ts:33](src/stores/stores.service.ts#L33)).

---

## ⚪ Cleanup and refactors

21. **Duplicated status filter:** the "not held / returned / partially returned" filter is copy-pasted 10 times, with broken indentation in reports. Use one exported constant. In the sales list, `where` and `revenueWhere` ([src/sales/sales.service.ts:472-509](src/sales/sales.service.ts#L472)) should share one base filter.
22. **DTOs defined inside controller files** in business, categories, taxes, suppliers, customers, sales, purchases, products and platform. Services then import from controllers, so the dependency points the wrong way. Move them to `dto/`.
23. **`InventoryService` is 990 lines,** mixing the stock engine, serials, transfers and stock take. Split out a `SerialsService` next time it is touched.
24. **`taxInclusive` does nothing:** it is stored and editable ([prisma/schema.prisma:121](prisma/schema.prisma#L121), [src/business/business.controller.ts:54](src/business/business.controller.ts#L54)), but pricing always adds tax on top. Implement it or remove it.
25. **Misleading report metrics:**
    - `sellThrough` divides units by money/10 ([src/reports/reports.service.ts:377-380](src/reports/reports.service.ts#L377));
    - "closing" in `stockMovementDaily` is a running sum from zero, not actual closing stock ([src/reports/reports.service.ts:712](src/reports/reports.service.ts#L712));
    - `topProducts` counts held carts and returned units ([src/reports/reports.service.ts:520](src/reports/reports.service.ts#L520)).
26. **Stale comment:** the `analytics()` docstring says cost is not recorded at sale time; `SaleItem.unitCost` does record it ([src/reports/reports.service.ts:134](src/reports/reports.service.ts#L134)).
27. **Report dates aren't validated:** `from` and `to` come in as raw strings, so an invalid date becomes a 500 ([src/reports/reports.controller.ts:29](src/reports/reports.controller.ts#L29)). Use a query DTO with `@IsDateString()` like `QueryShiftDto`.
28. **Tooling:** the `lint` and `format` scripts call eslint and prettier, which are not installed ([package.json:12-13](package.json#L12)). Either install them or remove the scripts. `test/checks.ts` is a good start; extend it to auth and sale returns first.
29. **Errors hidden:**
    - the purchase-edit reversal catches every error and reports "stock already sold" ([src/purchases/purchases.service.ts:192](src/purchases/purchases.service.ts#L192)), which can hide real DB errors;
    - variant SKU collisions come back as a raw 500 ([src/products/products.service.ts:227](src/products/products.service.ts#L227)).
30. **Small inconsistencies:**
    - platform login does not normalise the email ([src/platform/platform-auth.service.ts:14](src/platform/platform-auth.service.ts#L14));
    - `Tax.clearDefault()` runs outside the create/update, so a failed create still clears the default ([src/taxes/taxes.service.ts:22](src/taxes/taxes.service.ts#L22));
    - category parents can form a loop (A→B→A); only a category being its own parent is rejected ([src/categories/categories.service.ts:32](src/categories/categories.service.ts#L32));
    - the audit log records `POST /sales/hold` as `sales.create` and stores the email in `userName` ([src/audit/audit.interceptor.ts:49](src/audit/audit.interceptor.ts#L49));
    - draft purchases default `amountPaid` to the full total ([src/purchases/purchases.service.ts:53](src/purchases/purchases.service.ts#L53)).

---

## Suggested order

1. **Today:** #1 and #2. They are small changes and #1 is exploitable right now.
2. **This week:** #3–#8, plus tests in `test/checks.ts` for auth and returns.
3. **Before the next customers:** #9, #10 and #16.
4. **When data grows:** #13–#15 and #17.
5. **Whenever those files are touched:** everything else.
