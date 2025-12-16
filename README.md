# 🪄 DomainProxy

**Custom domains for your SaaS — Cloud or Self-Hosted**

Give your customers branded subdomains with automatic HTTPS. Like Cloudflare for SaaS, but free and open source.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](docker-compose.yml)

## 🚀 Choose Your Deployment

| Option | Best For | Get Started |
|--------|----------|-------------|
| ☁️ **Cloud Proxy** | Infrastructure as a service | [proxy.froste.eu](https://proxy.froste.eu) |
| 🏠 **Self-Hosted Proxy** | Full control, own data | See below |
| 🛠️ **SaaS Starter** | Build your own SaaS | [SaaS Demo](../saas-demo/) |

## ☁️ Cloud Proxy (Recommended)

Use our hosted proxy service — no infrastructure needed:

1. Go to [proxy.froste.eu/admin](https://proxy.froste.eu/admin)
2. Create a SaaS account to get your API key
3. Start registering subdomains via API

**That's it!** No servers, no certificates, no maintenance.

## 🏠 Self-Hosted

Want complete control? Deploy on your own infrastructure:

```bash
# Clone and run
git clone https://github.com/magnusfroste/domainproxy.git
cd domainproxy
cp .env.example .env
docker compose up -d

# Access at http://localhost:3000
```

### Requirements
- Docker & Docker Compose
- A domain with wildcard DNS (`*.yourdomain.com → your-server-ip`)
- Port 80 and 443 open

## How It Works

1. **You register a subdomain** via API: `career.customer.com → your-app.com`
2. **Customer sets DNS**: `career.customer.com CNAME proxy.froste.eu`
3. **Automatic HTTPS**: Certificate issued on first visit via Let's Encrypt
4. **Proxy forwards traffic**: Requests go to your app with original host header

```
Customer visits: https://career.customer.com
        ↓
   DomainProxy (TLS termination)
        ↓
   Your SaaS app (receives X-Forwarded-Host: career.customer.com)
```

## API Quick Start

```bash
# 1. Create tenant (customer domain)
curl -X POST https://subdomains.site/api/v1/create-tenant \
  -H "X-API-Key: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"base_domain": "customer.com"}'

# 2. Register subdomain proxy
curl -X POST https://subdomains.site/api/v1/register-subdomain \
  -H "X-API-Key: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"subdomain": "career", "base_domain": "customer.com", "target_url": "https://your-app.com"}'

# 3. Your customers need to add a CNAME record pointing their subdomain to <code>subdomains.site</code>:
# 4. Visit https://career.customer.com — HTTPS just works! 🎉
```

> **Self-hosted?** Replace `proxy.froste.eu` with your own domain.

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/create-tenant` | POST | Create a tenant (base domain) |
| `/api/v1/register-subdomain` | POST | Register subdomain proxy |
| `/api/v1/delete-proxy` | POST | Delete subdomain proxy |
| `/api/v1/tenants` | GET | List your tenants |
| `/api/v1/proxies` | GET | List your proxies |
| `/api/v1/status` | GET | Health check |
| `/api/v1/verify-domain` | GET | Check if domain is registered |
| `/api/v1/integration-guide` | GET | Full integration guide (Markdown) |

Full documentation: [subdomains.site/docs](https://subdomains.site/docs)

## 🚀 SaaS Starter Template

Want a working example? Check out the included SaaS starter in `/saas`:

```bash
cd saas
cp .env.example .env
# Add your API key
npm install && npm start
```

Features:
- User authentication
- Multi-tenant dashboard
- Automatic domain registration via API
- Host-based tenant detection
- Beautiful dark theme UI

[View SaaS Starter README →](saas/README.md)

## 🤖 Built for Vibe Coders

Building with Lovable, Cursor, or another AI tool? Just point your AI at our integration guide:

```
Read this guide and implement custom domains for my SaaS:
https://proxy.froste.eu/api/v1/integration-guide
```

## Self-Hosted Production Deployment

### 1. Get a VPS
Any provider works: DigitalOcean, Hetzner, Linode, etc. ($5-10/month)

### 2. Set up DNS
Point your domain's wildcard to your server:
```
*.yourdomain.com  A  your-server-ip
yourdomain.com    A  your-server-ip
```

### 3. Deploy
```bash
# SSH into your server
ssh root@your-server-ip

# Install Docker
curl -fsSL https://get.docker.com | sh

# Clone and configure
git clone https://github.com/magnusfroste/domainproxy.git
cd domainproxy
cp .env.example .env

# Edit .env with your settings
nano .env

# Start with production config
docker compose -f docker-compose.prod.yml up -d
```

### 4. Configure Caddy
Edit `Caddyfile` with your domain and email for Let's Encrypt.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `ADMIN_USER` | Admin username | `admin` |
| `ADMIN_PASS` | Admin password | `admin123` |
| `CADDY_ADMIN_URL` | Caddy admin API | - |
| `CADDY_EMAIL` | Email for Let's Encrypt | - |

## Tech Stack

- **Runtime:** Node.js + Express
- **Database:** SQLite (zero config)
- **TLS:** Caddy with on-demand certificates
- **Container:** Docker + Docker Compose

## Contributing

PRs welcome! Please open an issue first to discuss major changes.

## License

MIT — do whatever you want.

---

**Cloud:** [proxy.froste.eu](https://proxy.froste.eu) · **Docs:** [subdomains.site/docs](https://subdomains.site/docs) · **GitHub:** [magnusfroste/domainproxy](https://github.com/magnusfroste/domainproxy)