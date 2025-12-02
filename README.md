# 🪄 Subdomino + Career CMS Demo (Dual-Project Setup)

**Two Projects:**
1. **Subdomino** (root): Multi-tenant domain proxy API.
2. **Career CMS** (cms/): Multi-tenant SaaS example integrating Subdomino.

**Full Stack Test:** Deploy both → customer logins → configures career.company.com → auto-registers proxy → instant custom domain.

## 🚀 Local Development (Both Running)
```
# Root (Subdomino)
npm run dev  # http://localhost:3000

# CMS dir
cd cms && npm run dev  # http://localhost:3001
```

**Test Flow:**
1. **Subdomino Admin:** http://localhost:3000/admin (admin/admin123) - Note API key `froste123`.
2. **CMS Login:** http://localhost:3001/login
   - demo1@froste.eu / demo123 → Create tenant "froste.eu" (API key: froste123)
   - demo2@liteit.se / demo123 → Create tenant "liteit.se" (API key: froste123)
3. **Proxy Test:** http://career.lvh.me:3000 → proxies to CMS http://localhost:3001/career (Host preserved → froste.eu tenant).

## 🐳 Docker Compose (Production-Ready - Both Services)
```
docker compose up --build -d
```
- Subdomino: http://localhost:3000
- CMS: http://localhost:3001
- Volumes persist data.

**EasyPanel Deployments:**
1. **Subdomino Instance:** Docker Compose → [docker-compose.yml](docker-compose.yml) (ports 3000).
2. **CMS Instance:** Docker Compose → copy for CMS-only (build: ./cms, ports 3001).
   - Set env `SUBDOMINO_URL=https://subdomino.yourdomain.com`

## 🎯 End-to-End Demo (career.froste.eu & career.liteit.se)
1. **Customer 1 (froste.eu):** Login CMS → Create tenant "froste.eu" → Add content/jobs → Auto-registers `career` subdomain with Subdomino.
2. **DNS:** Customer adds `*` A record → Subdomino IP.
3. **Live:** career.froste.eu → Subdomino → proxies to CMS `/career` → renders froste.eu tenant data.
4. **Customer 2 (liteit.se):** Same → career.liteit.se works independently.

**CMS Features:**
- Multi-user login (demo accounts).
- Per-tenant: domain, content, jobs JSON.
- Auto Subdomino API call on create.
- Dynamic `/career` route detects Host → tenant data.

## 📋 Files Structure
```
.
├── server.js, package.json, Dockerfile  # Subdomino
├── cms/
│   ├── server.js, package.json, Dockerfile  # Career CMS
├── docker-compose.yml  # Both services
└── README.md
```

**Production DNS (Namecheap):**
```
A | @ | Main site IP  (companyname.com)
CNAME | www | Main site
A | * | Subdomino IP  (catches career.companyname.com)
```

Scalable SaaS demo complete! Deploy & test.