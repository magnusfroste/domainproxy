# 🚀 DomainProxy SaaS Starter

A complete example showing how to integrate DomainProxy into your SaaS application.

## What This Demonstrates

- **User authentication** — Simple login system
- **Multi-tenant architecture** — Each user can create multiple custom domains
- **DomainProxy integration** — Automatic subdomain registration via API
- **Host-based routing** — Detect custom domains and render tenant-specific content

## Quick Start

### Option 1: Use with DomainProxy Cloud (Recommended)

```bash
# 1. Get your API key from https://proxy.froste.eu/admin

# 2. Clone and configure
cd saas
cp .env.example .env
# Edit .env with your API key

# 3. Install and run
npm install
npm start

# 4. Open http://localhost:3001/login
```

### Option 2: Use with Self-Hosted DomainProxy

```bash
# 1. First, deploy DomainProxy (see main README)
# 2. Get your API key from your instance's /admin

# 3. Configure
cp .env.example .env
# Set DOMAINPROXY_URL to your instance
# Set DOMAINPROXY_API_KEY to your key

# 4. Run
npm install
npm start
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3001` |
| `DOMAINPROXY_URL` | DomainProxy API URL | `https://proxy.froste.eu` |
| `DOMAINPROXY_API_KEY` | Your API key | - |
| `SAAS_URL` | Public URL of this SaaS | `http://localhost:3001` |
| `DEMO_EMAIL` | Demo login email | `demo@example.com` |
| `DEMO_PASSWORD` | Demo login password | `demo123` |
| `SESSION_SECRET` | Session encryption key | - |

## How It Works

### 1. User Creates a Custom Domain

When a user creates a domain in the dashboard, the SaaS:

1. Calls `POST /api/v1/create-tenant` to register the base domain
2. Calls `POST /api/v1/register-subdomain` to set up the proxy
3. Saves the tenant info to the local database

```javascript
// From server.js
await domainProxyClient.createTenant(base_domain);
await domainProxyClient.registerSubdomain(subdomain, base_domain, config.saasUrl);
```

### 2. User Sets Up DNS

The user adds a CNAME record pointing their subdomain to DomainProxy:

```
app.customer.com  CNAME  proxy.froste.eu
```

### 3. Visitor Accesses Custom Domain

When someone visits `https://app.customer.com`:

1. DNS resolves to DomainProxy
2. DomainProxy provisions TLS certificate (first visit)
3. DomainProxy proxies request to your SaaS
4. Your SaaS detects the custom domain via `X-Forwarded-Host` header
5. Your SaaS renders tenant-specific content

```javascript
// Host detection middleware
const host = req.headers['x-forwarded-host'] || req.headers.host;
const subdomain = host.split('.')[0];
const baseDomain = host.split('.').slice(1).join('.');

// Look up tenant and render their page
const tenant = await db.get('SELECT * FROM tenants WHERE subdomain = ? AND base_domain = ?', [subdomain, baseDomain]);
```

## Project Structure

```
saas/
├── server.js        # Main application
├── .env.example     # Environment template
├── package.json     # Dependencies
├── Dockerfile       # Container config
├── data/            # SQLite database (auto-created)
└── public/          # Static files
```

## Docker Deployment

```bash
# Build
docker build -t saas-starter .

# Run
docker run -d \
  -p 3001:3001 \
  -e DOMAINPROXY_URL=https://proxy.froste.eu \
  -e DOMAINPROXY_API_KEY=your_key \
  -e SAAS_URL=https://your-saas.com \
  -v saas_data:/app/data \
  saas-starter
```

## Customization Ideas

This starter is intentionally simple. Here are some ways to extend it:

- **Add real authentication** — Replace plain-text passwords with bcrypt
- **Add a database** — Swap SQLite for PostgreSQL/MySQL
- **Add a frontend framework** — React, Vue, or Svelte
- **Add more tenant customization** — Logo, theme, custom CSS
- **Add billing** — Stripe integration for paid plans
- **Add analytics** — Track visits per tenant

## API Client

The starter includes a simple DomainProxy API client:

```javascript
const domainProxyClient = {
  async createTenant(baseDomain) { ... },
  async registerSubdomain(subdomain, baseDomain, targetUrl) { ... },
  async deleteProxy(subdomain, baseDomain) { ... },
  async verifyDomain(domain) { ... }
};
```

Copy this pattern into your own application!

## License

MIT — use this however you want.

---

**Need help?** Check out the main [DomainProxy documentation](https://proxy.froste.eu/docs).
