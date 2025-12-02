const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { createProxyMiddleware } = require('http-proxy-middleware');

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
  db.run(`CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_domain TEXT UNIQUE NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    subdomain TEXT NOT NULL,
    target_url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
  )`);

  // Demo tenant for testing
  const demoBaseDomain = 'froste.eu';
  const demoApiKey = 'froste123';
  db.get('SELECT id FROM tenants WHERE base_domain = ?', [demoBaseDomain], (err, row) => {
    if (!row) {
      db.run('INSERT INTO tenants (base_domain, api_key) VALUES (?, ?)', [demoBaseDomain, demoApiKey]);
      console.log(`💾 Demo tenant created: ${demoBaseDomain} (API key: ${demoApiKey})`);
    }
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
  db.get('SELECT * FROM tenants WHERE api_key = ?', [apiKey], (err, tenant) => {
    if (err || !tenant) return res.status(403).json({ error: 'Invalid API key' });
    req.tenant = tenant;
    next();
  });
}

// API: Register subdomain proxy
app.post('/api/v1/register-subdomain', apiAuth, (req, res) => {
  const { subdomain, target_url } = req.body;
  if (!subdomain || !target_url || !target_url.startsWith('http')) {
    return res.status(400).json({ error: 'subdomain and valid http(s) target_url required' });
  }
  const tenantId = req.tenant.id;
  db.run(
    'INSERT OR REPLACE INTO proxies (tenant_id, subdomain, target_url) VALUES (?, ?, ?)',
    [tenantId, subdomain.toLowerCase().trim(), target_url],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        success: true,
        subdomain: subdomain.toLowerCase().trim(),
        target_url,
        proxy_url: `https://${subdomain.toLowerCase().trim()}.${req.tenant.base_domain}`
      });
    }
  );
});

// API: List proxies for tenant
app.get('/api/v1/proxies', apiAuth, (req, res) => {
  db.all(
    'SELECT * FROM proxies WHERE tenant_id = ? ORDER BY created_at DESC',
    [req.tenant.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Admin Panel
app.get('/admin', requireAdminAuth, (req, res) => {
  db.all(`
    SELECT t.id as tenant_id, t.base_domain, t.api_key, 
           COUNT(p.id) as proxy_count,
           GROUP_CONCAT(p.subdomain || ' -> ' || p.target_url, ' | ') as proxies
    FROM tenants t LEFT JOIN proxies p ON t.id = p.tenant_id 
    GROUP BY t.id ORDER BY t.created_at DESC
  `, (err, tenants) => {
    if (err) tenants = [];
    const tenantList = tenants.map(t => `
      <li>
        <strong>${t.base_domain}</strong> (API: ${t.api_key}) 
        <br>${t.proxies || 'No proxies'} (${t.proxy_count || 0})
      </li>
    `).join('') || '<li>No tenants</li>';

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
<p><strong>Demo:</strong> froste.eu / API key: froste123</p>
<p>Test: POST /api/v1/register-subdomain {subdomain:"career", target_url:"https://httpbin.org"}<br>
Then visit career.lvh.me:${PORT}</p>

<h3>API Docs</h3>
<ul>
<li>POST /api/v1/register-subdomain (X-API-Key header)</li>
<li>GET /api/v1/proxies</li>
</ul>

<h3>Tenants & Proxies</h3>
<ul>${tenantList}</ul>

<h3>Create Demo Tenant</h3>
<form method="post" action="/admin/create-tenant">
  <input name="base_domain" placeholder="e.g. example.com" required>
  <button>Create Tenant + API Key</button>
</form>
</body></html>
    `);
  });
});

app.post('/admin/create-tenant', requireAdminAuth, (req, res) => {
  const { base_domain } = req.body;
  const api_key = 'sk_' + Math.random().toString(36).substr(2, 16);
  db.run('INSERT INTO tenants (base_domain, api_key) VALUES (?, ?)', [base_domain.toLowerCase().trim(), api_key], (err) => {
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
<p><a href="/admin">Admin Panel</a> | Example: <a href="https://career.lvh.me:${PORT}">career.lvh.me:${PORT}</a></p>
<p>Demo tenant: froste.eu / froste123</p>
</body>
</html>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Subdomino running on http://localhost:${PORT}`);
  console.log(`📝 Admin: http://localhost:${PORT}/admin (admin/admin123)`);
  console.log(`🔑 Demo: base_domain=froste.eu, api_key=froste123`);
  console.log(`🌐 Test proxy: register "career" → https://httpbin.org, visit career.lvh.me:${PORT}`);
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