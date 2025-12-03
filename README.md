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