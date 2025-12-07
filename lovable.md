# Lovable Onboarding Spec: DomainProxy Integration

## 1. Secrets collected at app creation
1. `DOMAINPROXY_BASE_URL` – always `https://proxy.froste.eu` (can be hardcoded, but storing keeps everything in one place).
2. `DOMAINPROXY_API_KEY` – SaaS API key generated in DomainProxy admin (keep secret).

> **Important:** The SaaS builder must still own a separate base domain for their tenants (e.g. `mysaas.com`). Store both values in Lovable Secrets so they are available to the backend. For any other config (like the SaaS builder’s own base domain) use regular environment variables or DB fields—**do not** send `proxy.froste.eu` as `base_domain`.

## 2. TypeScript helper module
```ts
// lovable/domainproxy.ts
import type { AxiosInstance } from "axios";
import axios from "axios";

const baseURL = process.env.DOMAINPROXY_BASE_URL;
const apiKey = process.env.DOMAINPROXY_API_KEY;

if (!baseURL || !apiKey) {
  throw new Error("Missing DOMAINPROXY_* secrets. Configure them in Lovable before deploying.");
}

const client: AxiosInstance = axios.create({
  baseURL,
  headers: {
    "X-API-Key": apiKey,
    "Content-Type": "application/json"
  }
});

export async function ensureTenant(baseDomain: string) {
  await client.post("/api/v1/create-tenant", { base_domain: baseDomain });
}

export async function registerSubdomain(params: {
  subdomain: string;
  baseDomain: string;
  targetUrl: string;
}) {
  await client.post("/api/v1/register-subdomain", {
    subdomain: params.subdomain,
    base_domain: params.baseDomain,
    target_url: params.targetUrl
  });
}
```

## 3. Customer onboarding flow (backend)
```ts
import { ensureTenant, registerSubdomain } from "./domainproxy";

export async function connectCustomDomain(input: {
  tenantId: string;
  subdomain: string;
  baseDomain: string;
}) {
  const { tenantId, subdomain, baseDomain } = input;
  const subdomainRegex = /^[a-z0-9-]+$/;
  if (!subdomainRegex.test(subdomain)) {
    throw new Error("Subdomain must contain only lowercase letters, numbers, and hyphens.");
  }
  if (!baseDomain) {
    throw new Error("baseDomain must be provided (builder-owned domain, e.g. mysaas.com).");
  }
  const targetUrl = `https://app.your-saas.com/tenants/${tenantId}`;

  await ensureTenant(baseDomain);
  await registerSubdomain({ subdomain, baseDomain, targetUrl });

  return {
    status: "pending_dns",
    instructions: `Add a CNAME for ${subdomain}.${baseDomain} pointing to proxy.froste.eu`
  };
}
```

## 4. Runtime host detection middleware
```ts
import { Request, Response, NextFunction } from "express";

export function tenantHostResolver(req: Request, _res: Response, next: NextFunction) {
  const host = (req.headers.host || "").toLowerCase();
  const [subdomain, ...rest] = host.split(".");
  req.tenant = {
    subdomain,
    baseDomain: rest.join(".")
  };
  next();
}
```
Use `req.tenant` in your controllers to fetch tenant-specific content.

## 5. DNS instructions shown to end customers
```
1. Go to your DNS provider.
2. Create a CNAME record: <your-subdomain> → proxy.froste.eu
3. Wait a few minutes; we’ll email you once HTTPS is active.
```

## 6. Lovable-specific configuration

### Published URL vs Dev URL
Lovable projects have two different URLs:
- **Dev URL:** `https://PROJECT_ID.lovableproject.com` — only works in preview mode
- **Prod URL:** `https://APP_NAME.lovable.app` — works after publishing

⚠️ **The proxy must always point to the prod URL** (`*.lovable.app`), not the dev URL.

### Vite base config for assets
When your app is accessed via a custom domain (e.g. `career.lazyjobs.ink`), the browser will try to load assets from that domain. To ensure JS/CSS loads correctly, set the `base` in `vite.config.ts`:

```ts
// vite.config.ts
export default defineConfig({
  base: 'https://YOUR_APP.lovable.app/',
  // ... other config
});
```

This ensures assets are always loaded from the published Lovable URL, regardless of which custom domain the user visits.

### Re-publish after changes
After updating `vite.config.ts` or changing the target URL in the proxy, you must **re-publish** the Lovable app for changes to take effect.

## 7. Troubleshooting & best practices
- Never send wildcard subdomains (`*`). HTTP-01 ACME cannot provision `*.domain.com`.
- Ensure DNS for `subdomain.baseDomain` points to `proxy.froste.eu` before testing HTTPS.
- If you see a white/blank page via the proxy, check that `vite.config.ts` has the correct `base` URL.
- If Caddy logs show `Caddy config failed`, re-run the registration with a valid subdomain and delete any bad entries.
- Use the `/api/v1/verify-domain?domain=x` endpoint to check if a domain is registered.

## 8. Validation checklist
- [ ] Ensure `vite.config.ts` has `base` set to your published Lovable URL
- [ ] Publish the Lovable app before testing custom domains
- [ ] Run `connectCustomDomain` locally with `.lvh.me` to confirm the flow
- [ ] Check DomainProxy logs for `✅ Domain registered: …` when registering
- [ ] Visit the custom domain and verify tenant content renders with all assets loading
