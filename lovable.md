# DomainProxy Integration Guide for Lovable

> **TL;DR:** DomainProxy gives your SaaS customers branded subdomains with automatic HTTPS. Like Cloudflare for SaaS, but free and open source.

## Deployment Options

| Option | Best For | URL |
|--------|----------|-----|
| ☁️ **Cloud** (recommended) | Quick start, no infrastructure | `https://subdomains.site` |
| 🏠 **Self-Hosted** | Full control, own data | Your own domain |

This guide uses Cloud examples. For self-hosted, replace `proxy.froste.eu` with your domain.

## Quick Start

1. Get an API key from [proxy.froste.eu/admin](https://proxy.froste.eu/admin)
2. Add secrets to your Lovable project
3. Implement host-based routing in your app
4. Register subdomains via API when customers sign up

## 1. Required Secrets

Add these to your Lovable project secrets:

| Secret | Value | Description |
|--------|-------|-------------|
| `DOMAINPROXY_BASE_URL` | `https://subdomains.site` | API base URL (or your self-hosted URL) |
| `DOMAINPROXY_API_KEY` | `saas_xxxxx` | Your API key from admin panel |
| `CUSTOMER_DOMAIN` | `yourdomain.com` | The domain your customers will use |

> **Important:** You must own a domain for your customers' subdomains (e.g., `lazyjobs.ink`). Set up a wildcard CNAME: `*.lazyjobs.ink → subdomains.site` (or your self-hosted domain)

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

## 6. Host-Based Routing (Required for Lovable)

When customers access your app via their custom domain (e.g., `career.lazyjobs.ink`), your app needs to detect this and render the correct tenant content.

### Step 1: Add host detection in App.tsx

```tsx
// src/App.tsx
const isCustomDomain = () => {
  const host = window.location.hostname;
  return !host.includes('lovable.app') && 
         !host.includes('lovableproject.com') && 
         !host.includes('localhost');
};

const App = () => {
  // If accessed via custom domain, render tenant page
  if (isCustomDomain()) {
    const subdomain = window.location.hostname.split('.')[0];
    return <TenantPage subdomain={subdomain} />;
  }
  
  // Normal routing for your main app
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Index />} />
        <Route path="/t/:subdomain" element={<TenantPage />} />
      </Routes>
    </BrowserRouter>
  );
};
```

### Step 2: Create TenantPage component

```tsx
// src/pages/TenantPage.tsx
interface TenantPageProps {
  subdomain?: string;
}

const TenantPage = ({ subdomain: propSubdomain }: TenantPageProps) => {
  const { subdomain: paramSubdomain } = useParams();
  const subdomain = propSubdomain || paramSubdomain;
  
  // Fetch tenant data from your database using subdomain
  const { data: tenant } = useQuery({
    queryKey: ['tenant', subdomain],
    queryFn: () => fetchTenant(subdomain)
  });
  
  return (
    <div>
      <h1>Welcome to {tenant?.company_name}</h1>
      {/* Your tenant-specific content */}
    </div>
  );
};
```

### Step 3: Set target_url to your published app root

When registering subdomains, set `target_url` to your **published Lovable app root** (not a specific path):

```ts
// In your edge function
const targetUrl = `https://YOUR_APP.lovable.app`; // NOT /t/subdomain
```

The proxy will forward all requests to your app, and your app's host detection will handle routing.

### Why this works
1. Customer visits `https://career.lazyjobs.ink`
2. Proxy forwards to `https://your-app.lovable.app`
3. Your app detects `career.lazyjobs.ink` hostname
4. App extracts `career` subdomain and renders tenant content

## 7. Troubleshooting

| Problem | Solution |
|---------|----------|
| White/blank page | Check browser console for CORS errors. Ensure host-based routing is implemented. |
| "Proxy Error" | Target URL is unreachable. Verify your Lovable app is published. |
| Certificate not issued | DNS not pointing to `proxy.froste.eu`. Check with `dig subdomain.domain.com` |
| Wrong page shows | Host detection not working. Check `isCustomDomain()` logic. |
| Assets not loading | Ensure `vite.config.ts` has `base: "/"` (relative paths) |

### Best Practices
- Never use wildcard subdomains (`*`) — ACME HTTP-01 cannot provision wildcards
- Always use the published Lovable URL (`*.lovable.app`), not dev URL
- Set up wildcard DNS once: `*.yourdomain.com → proxy.froste.eu`
- Test in incognito mode to avoid cache issues

## 8. Validation Checklist

- [ ] API key obtained from [proxy.froste.eu/admin](https://proxy.froste.eu/admin)
- [ ] Secrets added to Lovable project
- [ ] Host-based routing implemented in `App.tsx`
- [ ] Wildcard DNS configured: `*.yourdomain.com → proxy.froste.eu`
- [ ] Lovable app published
- [ ] Subdomain registered via API
- [ ] Custom domain loads with HTTPS and correct content

## 9. API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/create-tenant` | POST | Create tenant (base domain) |
| `/api/v1/register-subdomain` | POST | Register subdomain proxy |
| `/api/v1/delete-proxy` | POST | Delete subdomain proxy |
| `/api/v1/tenants` | GET | List your tenants |
| `/api/v1/proxies` | GET | List your proxies |
| `/api/v1/status` | GET | Health check |
| `/api/v1/verify-domain` | GET | Check if domain is registered |

Full API docs: [proxy.froste.eu/docs](https://proxy.froste.eu/docs)
