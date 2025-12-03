const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { createProxyMiddleware } = require('http-proxy-middleware');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
fs.ensureDirSync(DATA_DIR);

const DB_PATH = path.join(DATA_DIR, 'subdomino.db');
const db = new sqlite3.Database(DB_PATH);

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Init DB
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS saas_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key TEXT UNIQUE NOT NULL,
    name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    saas_id INTEGER NOT NULL,
    base_domain TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (saas_id) REFERENCES saas_accounts (id) ON DELETE CASCADE,
    UNIQUE(saas_id, base_domain)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    subdomain TEXT NOT NULL,
    target_url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
  )`);

  // Demo SaaS account and tenant for testing
  const demoApiKey = 'saas_demo_123';
  db.get('SELECT id FROM saas_accounts WHERE api_key = ?', [demoApiKey], (err, row) => {
    if (!row) {
      db.run('INSERT INTO saas_accounts (api_key, name) VALUES (?, ?)', [demoApiKey, 'Demo SaaS'], function(err) {
        if (err) return console.error('Demo SaaS insert error:', err);
        const saasId = this.lastID;
        const demoBaseDomain = 'froste.eu';
        db.get('SELECT id FROM tenants WHERE base_domain = ? AND saas_id = ?', [demoBaseDomain, saasId], (err, tenantRow) => {
          if (!tenantRow) {
            db.run('INSERT INTO tenants (saas_id, base_domain) VALUES (?, ?)', [saasId, demoBaseDomain]);
            console.log(`💾 Demo tenant created: ${demoBaseDomain} for SaaS ${demoApiKey}`);
          }
        });
      });
    }
  });
});

// Auto-configure Caddy for new tenant
function autoConfigureCaddy(baseDomain) {
  if (process.env.CADDY_ADMIN_URL && process.env.CADDY_EMAIL) {
    const serverName = `proxy-${baseDomain.replace(/\./g, '-')}`;
    const caddyConfig = {
      "listen": [":443", ":80"],
      "routes": [{
        "match": [{
          "host": [`${baseDomain}`, `*.${baseDomain}`]
        }],
        "handle": [{
          "handler": "reverse_proxy",
          "upstreams": [{
            "dial": "subdomino:3000"
          }]
        }]
      }],
      "tls": {
        "automation": {
          "type": "acme"
        },
        "email": process.env.CADDY_EMAIL
      }
    };
    axios.put(`${process.env.CADDY_ADMIN_URL}/config/apps/http/servers/${serverName}/config`, caddyConfig)
      .then(() => console.log(`✅ Caddy auto-configured for *.${baseDomain}`))
      .catch(e => console.error(`❌ Caddy config failed for *.${baseDomain}:`, e.message));
  }
}

// API: Create tenant (customer domain)
app.post('/api/v1/create-tenant', apiAuth, (req, res) => {
  const { base_domain } = req.body;
  if (!base_domain) return res.status(400).json({ error: 'base_domain required' });
  const saasId = req.saas.id;
  const lowerDomain = base_domain.toLowerCase().trim();
  db.run('INSERT INTO tenants (saas_id, base_domain) VALUES (?, ?)', [saasId, lowerDomain], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    autoConfigureCaddy(lowerDomain);
    res.json({ success: true, tenant_id: this.lastID, base_domain: lowerDomain });
  });
});

// API: List tenants for SaaS
app.get('/api/v1/tenants', apiAuth, (req, res) => {
  db.all('SELECT id, base_domain, created_at FROM tenants WHERE saas_id = ? ORDER BY created_at DESC', [req.saas.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Basic Auth for Admin
function requireAdminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Subdomino Admin"');
    return res.status(401).send('Unauthorized');
  }
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  res.status(401).send('Invalid credentials');
}

// API Auth
function apiAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'X-API-Key header required' });
  db.get('SELECT * FROM saas_accounts WHERE api_key = ?', [apiKey], (err, saas) => {
    if (err || !saas) return res.status(403).json({ error: 'Invalid API key' });
    req.saas = saas;
    next();
  });
}

// API: Register subdomain proxy
app.post('/api/v1/register-subdomain', apiAuth, (req, res) => {
  const { subdomain, target_url, base_domain } = req.body;
  if (!subdomain || !target_url || !target_url.startsWith('http') || !base_domain) {
    return res.status(400).json({ error: 'subdomain, base_domain, and valid http(s) target_url required' });
  }
  const saasId = req.saas.id;
  const lowerDomain = base_domain.toLowerCase().trim();
  const lowerSubdomain = subdomain.toLowerCase().trim();

  // Find or create tenant
  db.get('SELECT id FROM tenants WHERE saas_id = ? AND base_domain = ?', [saasId, lowerDomain], (err, tenantRow) => {
    if (err) return res.status(500).json({ error: err.message });
    let tenantId = tenantRow ? tenantRow.id : null;
    if (!tenantRow) {
      // Create tenant
      db.run('INSERT INTO tenants (saas_id, base_domain) VALUES (?, ?)', [saasId, lowerDomain], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        tenantId = this.lastID;
        // Auto-configure Caddy for new tenant
        autoConfigureCaddy(lowerDomain);
        insertProxy();
      });
    } else {
      insertProxy();
    }

    function insertProxy() {
      db.run(
        'INSERT OR REPLACE INTO proxies (tenant_id, subdomain, target_url) VALUES (?, ?, ?)',
        [tenantId, lowerSubdomain, target_url],
        function(err) {
          if (err) return res.status(500).json({ error: err.message });
          res.json({
            success: true,
            subdomain: lowerSubdomain,
            base_domain: lowerDomain,
            target_url,
            proxy_url: `https://${lowerSubdomain}.${lowerDomain}`
          });
        }
      );
    }
  });
});

// API: List proxies for SaaS
app.get('/api/v1/proxies', apiAuth, (req, res) => {
  db.all(`
    SELECT p.*, t.base_domain FROM proxies p 
    JOIN tenants t ON p.tenant_id = t.id 
    WHERE t.saas_id = ? ORDER BY p.created_at DESC
  `, [req.saas.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Admin Panel
app.get('/admin', requireAdminAuth, (req, res) => {
  db.all(`
    SELECT s.id as saas_id, s.api_key, s.name, s.created_at,
           COUNT(DISTINCT t.id) as tenant_count,
           COUNT(p.id) as proxy_count
    FROM saas_accounts s 
    LEFT JOIN tenants t ON s.id = t.saas_id 
    LEFT JOIN proxies p ON t.id = p.tenant_id 
    GROUP BY s.id ORDER BY s.created_at DESC
  `, (err, saasList) => {
    if (err) saasList = [];
    const saasHtml = saasList.map(s => `
      <li>
        <strong>${s.name || 'Unnamed SaaS'}</strong> (API: ${s.api_key}) 
        <br>Tenants: ${s.tenant_count || 0} | Proxies: ${s.proxy_count || 0}
      </li>
    `).join('') || '<li>No SaaS accounts</li>';

    res.send(`
<!DOCTYPE html>
<html>
<head><title>Subdomino Admin</title>
<style>body{font-family:Arial;max-width:900px;margin:50px auto;padding:20px;}
form,ul{margin:20px 0;} input,textarea{width:100%;padding:10px;box-sizing:border-box;}
button{padding:10px 20px;background:#007bff;color:white;border:none;cursor:pointer;}
li{padding:10px;border:1px solid #ddd;margin:10px 0;}</style>
</head>
<body>
<h1>🪄 Subdomino - Domain Proxy Service</h1>
<p><strong>Demo:</strong> froste.eu / SaaS API key: saas_demo_123</p>
<p>Test: POST /api/v1/register-subdomain {subdomain:"career", base_domain:"froste.eu", target_url:"https://httpbin.org"}<br>
Then visit https://career.froste.eu</p>

<h3>API Docs</h3>
<ul>
<li>POST /api/v1/create-tenant {base_domain} (X-API-Key header)</li>
<li>POST /api/v1/register-subdomain {subdomain, base_domain, target_url}</li>
<li>GET /api/v1/tenants</li>
<li>GET /api/v1/proxies</li>
</ul>

<h3>SaaS Accounts</h3>
<ul>${saasHtml}</ul>

<h3>Create SaaS Account</h3>
<form method="post" action="/admin/create-saas">
  <input name="name" placeholder="SaaS Name (optional)">
  <button>Create SaaS + API Key</button>
</form>
</body></html>
    `);
  });
});

app.post('/admin/create-saas', requireAdminAuth, (req, res) => {
  const { name } = req.body;
  const api_key = 'saas_' + Math.random().toString(36).substr(2, 9);
  db.run('INSERT INTO saas_accounts (api_key, name) VALUES (?, ?)', [api_key, name || null], (err) => {
    if (err) {
      res.send(`Error: ${err.message}`);
    } else {
      res.redirect('/admin');
    }
  });
});

// Dynamic Proxy Middleware (catch-all)
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  const parts = host.split('.');
  if (parts.length < 2) return next();

  const subdomain = parts[0];
  const baseDomain = parts.slice(1).join('.');

  if (subdomain === 'www' || subdomain === 'localhost' || subdomain === 'lvh.me') return next();

  db.get(
    'SELECT p.target_url FROM proxies p JOIN tenants t ON p.tenant_id = t.id WHERE t.base_domain = ? AND p.subdomain = ?',
    [baseDomain, subdomain],
    (err, row) => {
      if (err || !row) return next(); // Fallback

      console.log(`🔄 Proxying ${host}${req.url} → ${row.target_url}`);
      const proxy = createProxyMiddleware({
        target: row.target_url,
        changeOrigin: true,
        secure: true, // for https targets
        onError: (err, req, res) => {
          console.error('Proxy error:', err);
          res.status(502).send('Proxy Error');
        }
      });
      proxy(req, res, next);
    }
  );
});

// Fallback landing page
app.use((req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head><title>Subdomino</title>
<style>body{font-family:sans-serif;max-width:600px;margin:100px auto;padding:20px;text-align:center;}</style>
</head>
<body>
<h1>🪄 Subdomino - Custom Domain Proxy</h1>
<p>Point wildcard DNS (*.yourdomain.com) to this server.</p>
<p>Register subdomains via API: <code>POST /api/v1/register-subdomain</code></p>
<p><a href="/admin">Admin Panel</a> | Example: <a href="https://career.froste.eu">career.froste.eu</a></p>
<p>Demo SaaS: froste.eu / saas_demo_123</p>
</body>
</html>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Subdomino running on http://localhost:${PORT}`);
  console.log(`📝 Admin: http://localhost:${PORT}/admin (admin/admin123)`);
  console.log(`🔑 Demo SaaS: api_key=saas_demo_123`);
  console.log(`🌐 Test: POST /api/v1/register-subdomain with X-API-Key: saas_demo_123 {subdomain:"career", base_domain:"froste.eu", target_url:"https://httpbin.org"}`);
  console.log(`🐳 Docker: docker compose up`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('SIGINT received, closing DB...');
  db.close((err) => {
    if (err) console.error('DB close error:', err);
    process.exit(0);
  });
});
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing DB...');
  db.close((err) => {
    if (err) console.error('DB close error:', err);
    process.exit(0);
  });
});