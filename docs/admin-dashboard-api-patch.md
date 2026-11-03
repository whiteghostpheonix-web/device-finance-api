# Admin dashboard API route patch

This script applies an idempotent, narrow patch to the **restored full API source**. It adds the read routes needed to load the existing admin dashboard (summary, device list/detail, plans, resellers) and restricts CORS to the deployed admin dashboard origin while allowing the existing Cloudflare Access service-token headers already declared in the Worker.

The script does not read or change secrets or D1 data. It refuses to run if the expected full API health route/configuration is not present. Review `git diff` after running it.

## Apply and verify locally

From the API repository root, on a feature branch:

```bash
node scripts/install-admin-dashboard-read-routes.mjs
git diff --check
git diff --stat
git diff -- src/index.js
```

Confirm Cloudflare Access protects the API hostname and the dashboard hostname before deployment. Do not remove the service-token credentials from the browser until a replacement authentication flow is deployed; instead rotate the exposed token and plan the migration to server-side authentication. Never paste or commit token values.

## Deploy only after review

```bash
npm run deploy
curl -i https://device-finance-api.whiteghostpheonix.workers.dev/health
curl -i https://device-finance-api.whiteghostpheonix.workers.dev/api/dashboard/summary
```

The dashboard endpoints expose finance/customer data and therefore rely on Cloudflare Access being correctly enforced at the edge. CORS is not authentication. This patch intentionally does not implement retailer login, customer review, camera capture, or QR approval gating.
