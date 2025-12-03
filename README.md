# DomainProxy: SaaS Subdomain Proxy Service & Career CMS Demo

## Product Overview

**DomainProxy** is a multi-tenant subdomain proxy service designed for SaaS builders. It enables your customers to seamlessly serve their branded subdomains (e.g., `career.companyname.com`) without complex DNS or infrastructure setup.

### Core Problem
SaaS platforms need to let customers create custom subdomains for their branded experiences. Traditionally, this requires:
- Customers to configure wildcard DNS (* CNAME)
- SaaS providers to manage SSL certificates and reverse proxying
- Complex integration for each customer domain

**DomainProxy solves this** by providing a simple API that customers use to register subdomains, pointing their DNS once to your proxy service.

### How It Works
1. **Customer Setup:** Point CNAME `career` (or any subdomain prefix) to your DomainProxy instance.
2. **SaaS Integration:** Your app calls DomainProxy API to register `subdomain.companyname.com` → your backend URL.
3. **Instant Activation:** Visitors access `https://career.companyname.com` which proxies to your SaaS tenant's page.

### Example Use Case: Career ATS SaaS
- SaaS: Career CMS (included demo)
- Customer: "Acme Corp" wants `career.acmecorp.com`
- DNS: `CNAME career acmecorp.com` → DomainProxy IP
- SaaS: Register via API: `subdomain: "career", target_url: "https://your-saas.com/tenant/acme"`
- Result: `https://career.acmecorp.com` serves Acme's branded career page with SSL.

## Architecture

- **Proxy Service:** Express.js server with SQLite database
- **Auto SSL:** Integrates with Caddy for automatic Let's Encrypt certificates
- **Multi-tenant:** Isolated by API keys per customer domain
- **Demo CMS:** Full-stack SaaS example (career pages for customers)

## API Quick Start

```bash
# 1. Create tenant (customer domain)
curl -X POST https://yourproxy.com/api/v1/create-tenant \
  -H "X-API-Key: your_saas_api_key" \
  -d '{"base_domain": "customer.com"}'

# 2. Register subdomain proxy
curl -X POST https://yourproxy.com/api/v1/register-subdomain \
  -H "X-API-Key: your_saas_api_key" \
  -d '{"subdomain": "career", "base_domain": "customer.com", "target_url": "https://your-saas.com/tenant/customer"}'

# Visit: https://career.customer.com
```

## Demo

- **Admin:** https://yourproxy.com/admin (admin/admin123)
- **Demo SaaS API Key:** saas_demo_123
- **Demo Tenant:** froste.eu
- **Test Command:**
  ```bash
  curl -X POST http://localhost:3000/api/v1/register-subdomain \
    -H "X-API-Key: saas_demo_123" \
    -d '{"subdomain": "career", "base_domain": "froste.eu", "target_url": "https://httpbin.org"}'
  ```
- **Visit:** https://career.froste.eu

### Career CMS: SaaS Integration Example

The Career CMS demonstrates a complete SaaS integration with Subdomino:

1. **Customer Signs Up:** User logs into CMS (e.g., demo1@froste.eu/demo123).
2. **Configure Domain:** In dashboard, enter `base_domain` (e.g., customer.com) and `subdomain` (e.g., career).
3. **Auto-Register:** CMS calls Subdomino API to create tenant and register subdomain.
4. **DNS Setup:** Customer points CNAME `career` → your Subdomino IP.
5. **Live Page:** Visitors access `https://career.customer.com` for branded career page.

**CMS Config:** Set `SUBDOMINO_API_KEY` to your SaaS API key (e.g., `saas_demo_123`).

**Test Locally:**
- CMS: http://localhost:3001/login
- Create tenant: base_domain=froste.eu, subdomain=career
- Check proxy registered: GET /api/v1/proxies with X-API-Key: saas_demo_123

---

## 🐳 EasyPanel Deployment (Separate Instances)

### 1. DomainProxy Instance (Proxy Server)
**EasyPanel → New App → Docker Compose**
Paste this [docker-compose.yml](docker-compose.yml) (Caddy HTTPS included):

```
version: '3.8'

services:
  domainproxy:
    build: .
    volumes:
      - domainproxy_data:/app/data
    environment:
      - NODE_ENV=production
    restart: unless-stopped

  caddy:
    image: caddy:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - caddy_data:/data
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
    depends_on:
      - domainproxy
    restart: unless-stopped

volumes:
  domainproxy_data:
  caddy_data:
```

**Caddyfile:** 
```
:80 {
  redir https://{host}{uri} permanent
}

# Replace with your domain
*.yourdomain.com {
  tls your-email@domain.com
  reverse_proxy domainproxy:3000
}

# Admin/API
yourdomain.com {
  tls your-email@domain.com
  reverse_proxy /admin* domainproxy:3000
  reverse_proxy /api* domainproxy:3000
  reverse_proxy /* domainproxy:3000
}
```

**Domain:** yourdomain.com (wildcard DNS * → EasyPanel IP).

**Access:** https://yourdomain.com/admin (admin/admin123)

### 2. Career CMS Instance (Separate App)
**EasyPanel → New App → Docker Compose**
```
version: '3.8'

services:
  career-cms:
    build: .
    ports:
      - "3001:3001"
    volumes:
      - cms_data:/app/data
    environment:
      - NODE_ENV=production
      - SUBDOMINO_URL=https://yourdomain.com  # Proxy instance URL
    restart: unless-stopped

volumes:
  cms_data:
```

**Upload:** cms/ folder as Git or zip.

**Domain:** cms.yourdomain.com (or IP:3001).

**Access:** https://cms.yourdomain.com:3001/login (demo1@froste.eu/demo123)

### 3. Test Flow
1. Proxy Admin: Create tenant "froste.eu" API key.
2. CMS Login → Create tenant "froste.eu" (paste API key) → auto-registers "career".
3. Namecheap: * → Proxy IP.
4. https://career.froste.eu → Proxy → CMS → tenant data.

**Local Test:** docker compose up --build -d (full stack).

Production live!

## 🚀 Fully Automated Self-Hosted Deployment (No EasyPanel)

**Proxy Service (Subdomino)**

1. VPS (e.g. DigitalOcean $6/mo Ubuntu 22.04), firewall ufw allow 22,80,443.

2. `apt update && apt install docker docker-compose`

3. `git clone https://github.com/magnusfroste/domainproxy.git && cd domainproxy`

4. Edit `.env`:
   ```
   CADDY_EMAIL=your@email.com
   ADMIN_USER=admin
   ADMIN_PASS=strongpass
   ```

5. `docker compose up -d`

6. **DNS:** Namecheap → yourdomain.com → Advanced DNS → Add A Record `*` → VPS IP

7. Visit `https://yourdomain.com/admin` (basic auth) → **Create tenant `yourdomain.com`** → **Auto-magically:**
   - Caddy adds `*.yourdomain.com` site block
   - Requests Let's Encrypt wildcard cert (~1min)
   - API key generated & shown

**Test:** POST `/api/v1/register-subdomain` X-API-Key:your_key {subdomain:"test", target_url:"https://httpbin.org"} → https://test.yourdomain.com

---

**Optional: Career CMS (separate VPS or same compose)**

Deploy proxy first, note API base URL (yourdomain.com)

CMS docker-compose.yml: set SUBDOMINO_URL=https://yourdomain.com

`docker compose -f cms-docker-compose.yml up -d` (create separate)

**Full local test:** `docker compose up` → https://career.lvh.me:443/admin → create froste.eu → https://career.froste.eu (after CMS tenant create)

**Production ready!** Zero config beyond DNS + email.