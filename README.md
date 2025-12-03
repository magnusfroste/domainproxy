# DomainProxy + Career CMS (EasyPanel Deployment Guide)

**DomainProxy:** Multi-tenant subdomain proxy (arbitrary subdomain.domain.com → your backend).

**Career CMS:** Example SaaS CMS integrating DomainProxy.

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