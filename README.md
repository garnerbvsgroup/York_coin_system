# York Coin — Project Scaffold

This is a working scaffold of the architecture confirmed in
`york_coin_implementation_spec.md`: Next.js frontend, NestJS API,
PostgreSQL via Prisma, monorepo with separate apps.

## Verified status (honest, not just claimed)

- ✅ **Dependencies install cleanly** (`npm install` succeeds across all workspaces).
- ✅ **TypeScript compiles with zero errors**, except for types that only
  exist after `npx prisma generate` runs (which needs normal internet
  access to Prisma's binary CDN — this repo's sandbox couldn't reach it,
  but any normal server can).
- ✅ **Real authentication**: email/password with bcrypt hashing, JWT
  sessions, route guards. Users can only ever act on their own wallet;
  admin routes verify `isAdmin` from the signed token, never from the
  request body.
- ✅ **Real concurrency control**: every economic operation takes
  `SELECT ... FOR UPDATE` row locks (wallets always locked in sorted order
  to prevent deadlocks) inside its database transaction — not just a
  comment saying this is needed.
- ✅ **The core economic logic has an automated test suite** —
  `packages/shared/src/economics.ts` + `__tests__/economics.test.ts`,
  runnable with `npm test --workspace=@york-coin/shared`. **This test
  suite found and fixed a real bug**: store-purchase "recycle" events were
  only incrementing the available pool without decrementing circulating
  supply, which would have silently let value be minted past the
  1,000,000 cap over repeated recycle→resell cycles. Both the pure logic
  and the actual `EconomyService` code were fixed once the test caught it.
- ⚠️ **Not yet tested**: a live end-to-end run against a real Postgres
  database (blocked by the same sandboxed-network limitation on the
  Prisma engine binary), and the Docker builds have not been executed.
- ⚠️ **Not done at all**: independent human security review. This handles
  real redeemable money for real people — get a second set of eyes on the
  auth and locking code before it goes live, not just an AI's word that
  it's fine.

## Running it

```bash
# 1. Install dependencies (from the repo root)
npm install

# 2. Start Postgres
npm run db:up

# 3. Copy env files and generate a real JWT secret
cp .env.example apps/api/.env
# then edit apps/api/.env and replace JWT_SECRET with: openssl rand -base64 48
echo "NEXT_PUBLIC_API_URL=http://localhost:3001" > apps/web/.env.local

# 4. Generate Prisma client, run migrations, seed genesis state
npm run --workspace=@york-coin/api prisma:generate
npm run db:migrate
npm run db:seed

# 5. Run both apps (in separate terminals)
npm run dev:api
npm run dev:web

# 6. Run the economic logic test suite
npm test --workspace=@york-coin/shared
```

Visit `http://localhost:3000` for the dashboard (register/log in there —
there's no more hardcoded demo user) and `http://localhost:3001` for the API.

## Deploying to your server owner's box

```bash
# On the server, with Docker installed:
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD, JWT_SECRET (openssl rand -base64 48), and DOMAIN

docker compose -f docker-compose.prod.yml up -d --build
```

Caddy automatically obtains and renews a Let's Encrypt HTTPS certificate for
your domain — nothing manual needed there, as long as the domain's DNS
points at the server and ports 80/443 are reachable (which requires the
port-forwarding/firewall access confirmed with your server owner).

## Where things live

```
york-coin/
├── apps/
│   ├── api/                 NestJS backend
│   │   ├── prisma/
│   │   │   ├── schema.prisma   ← full data model, every confirmed decision
│   │   │   └── seed.ts         ← seeds the correct genesis state (cap=1M, circulating=0)
│   │   └── src/
│   │       ├── auth/           ← register/login, JWT, route guards
│   │       ├── economy/        ← EconomyService: buy/grant/transfer/burn/store/redeem
│   │       ├── admin/          ← unanimous-approval voting workflow
│   │       └── wallet/         ← read-only balance/history + ledger reconciliation
│   └── web/                 Next.js frontend (login + dashboard)
├── packages/
│   └── shared/
│       ├── src/economics.ts        ← pure, tested economic math (no Prisma/NestJS deps)
│       └── src/__tests__/          ← automated tests against every validated scenario
├── docker-compose.yml        local dev (Postgres only)
├── docker-compose.prod.yml   full production stack (Postgres + API + web + Caddy/HTTPS)
└── Caddyfile                 reverse proxy + automatic TLS config
```

## Before this goes further than a sample

From the validation reports, still genuinely open:
- Exact approval-timeout duration (placeholder: 7 days in `admin.service.ts`)
- Purchase queue fulfillment order/cancellation/expiration
- OAuth login providers (email/password works; OAuth has an extension
  point noted in `auth.service.ts` but isn't wired up)
- A real live test against Postgres + a completed Docker build (blocked
  here by sandbox network restrictions — should be straightforward on the
  actual server)
- Independent human security review before real money is on the line
