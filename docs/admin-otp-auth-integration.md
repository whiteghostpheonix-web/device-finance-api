# Admin OTP auth integration

This feature branch adds an admin login UI and an API auth helper. The API Worker is not changed by merely committing those files. In the API repository, from the feature branch:

```sh
npx wrangler d1 migrations apply device-finance-db --remote
node scripts/install-admin-auth-routing.mjs
node scripts/install-admin-dashboard-read-routes.mjs
node --check src/admin-auth.js
node --check src/index.js
npm run deploy
```

Before deployment, ensure `ADMIN_OTP_PEPPER`, `RESEND_API_KEY`, and `RESEND_FROM` exist as Worker secrets. `RESEND_FROM` must be a sender identity/domain Resend permits. The first admin email is seeded by migration; additional admins can then be added from the authenticated dashboard and sign in by OTP.

The routing installer adds auth checks to the configured admin paths and routes `/api/admin/*` requests through the helper. Review its diff and the existing dashboard route installer diff; they are narrow text-anchor patches, not a substitute for testing the full Worker. Authenticated API requests require `Authorization: Bearer <session token>`.

In the dashboard repository, checkout `feature/admin-email-otp-login`, install dependencies and run `npm run build`. Only deploy the dashboard after the build succeeds. Rotate the previously exposed Cloudflare Access service token; removing it from source does not revoke it.
