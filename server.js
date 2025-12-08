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

const DB_PATH = path.join(DATA_DIR, 'subdomain.db');
const db = new sqlite3.Database(DB_PATH);

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// In-memory log buffer for /admin/logs endpoint
const LOG_BUFFER_SIZE = 500;
const logBuffer = [];
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
console.log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
  logBuffer.push(line);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  originalConsoleLog.apply(console, args);
};
console.error = (...args) => {
  const line = `[${new Date().toISOString()}] ERROR: ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
  logBuffer.push(line);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  originalConsoleError.apply(console, args);
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    last_provision_status TEXT,
    last_provision_message TEXT,
    last_provisioned_at DATETIME,
    FOREIGN KEY (tenant_id) REFERENCES tenants (id),
    UNIQUE(tenant_id, subdomain)
  )`);

  // Ensure legacy dbs have new columns
  ['last_provision_status', 'last_provision_message', 'last_provisioned_at'].forEach(column => {
    db.run(
      `ALTER TABLE proxies ADD COLUMN ${column} ${column === 'last_provisioned_at' ? 'DATETIME' : 'TEXT'}`,
      err => {
        if (err && !err.message.includes('duplicate column')) {
          console.error(`Schema migration warning (${column}):`, err.message);
        }
      }
    );
  });

  // Demo SaaS account for testing
  const demoApiKey = 'saas_demo_123';
  db.get('SELECT id FROM saas_accounts WHERE api_key = ?', [demoApiKey], (err, row) => {
    if (!row) {
      db.run('INSERT INTO saas_accounts (api_key, name) VALUES (?, ?)', [demoApiKey, 'Demo SaaS'], function(err) {
        if (err) return console.error('Demo SaaS insert error:', err);
        console.log(`💾 Demo SaaS account created: ${demoApiKey}`);
      });
    }
  });
});

const CADDY_ADMIN_URL = process.env.CADDY_ADMIN_URL;
const CADDY_EMAIL = process.env.CADDY_EMAIL;
const CADDY_UPSTREAM = process.env.CADDY_UPSTREAM || 'domainproxy:3000';

function updateProvisionStatus(tenantId, subdomain, status, message) {
  db.run(
    `UPDATE proxies 
     SET last_provision_status = ?, last_provision_message = ?, last_provisioned_at = CURRENT_TIMESTAMP 
     WHERE tenant_id = ? AND subdomain = ?`,
    [status, message?.toString().slice(0, 500) || null, tenantId, subdomain],
    err => {
      if (err) console.error('Failed to update provision status:', err);
    }
  );
}

// Provision Caddy for a specific hostname
// With on-demand TLS, Caddy will automatically provision certs when a request comes in
// and the /api/v1/verify-domain endpoint confirms the domain is registered.
// This function just logs and updates status - no Caddy API calls needed.
function provisionCaddyHost(subdomain, baseDomain, tenantId) {
  const hostname = `${subdomain}.${baseDomain}`;
  console.log(`✅ Domain registered: ${hostname} - Caddy will provision cert on first request`);
  if (tenantId) {
    updateProvisionStatus(tenantId, subdomain, 'pending', 'Certificate will be provisioned on first HTTPS request');
  }
  return Promise.resolve({ status: 'pending' });
}

// Delete Caddy host - with on-demand TLS, just removing from DB is enough
// Caddy's verify-domain endpoint will return 404 for unregistered domains
function deleteCaddyHost(subdomain, baseDomain) {
  const hostname = `${subdomain}.${baseDomain}`;
  console.log(`🗑️ Domain removed: ${hostname} - Caddy will reject future cert requests`);
  return Promise.resolve();
}

// API: Create tenant (customer domain)
app.post('/api/v1/create-tenant', apiAuth, (req, res) => {
  const { base_domain } = req.body;
  if (!base_domain) return res.status(400).json({ error: 'base_domain required' });
  const saasId = req.saas.id;
  const lowerDomain = base_domain.toLowerCase().trim();
  
  // Check if tenant already exists
  db.get('SELECT id FROM tenants WHERE saas_id = ? AND base_domain = ?', [saasId, lowerDomain], (err, existing) => {
    if (existing) {
      // Tenant already exists, return it
      return res.json({ success: true, tenant_id: existing.id, base_domain: lowerDomain, already_exists: true });
    }
    
    // Create new tenant
    db.run('INSERT INTO tenants (saas_id, base_domain) VALUES (?, ?)', [saasId, lowerDomain], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, tenant_id: this.lastID, base_domain: lowerDomain });
    });
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
    res.set('WWW-Authenticate', 'Basic realm="Subdomain Admin"');
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
          provisionCaddyHost(lowerSubdomain, lowerDomain, tenantId);
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

// API: Delete proxy mapping (and Caddy host)
app.post('/api/v1/delete-proxy', apiAuth, (req, res) => {
  const { subdomain, base_domain } = req.body;
  if (!subdomain || !base_domain) {
    return res.status(400).json({ error: 'subdomain and base_domain required' });
  }
  const lowerDomain = base_domain.toLowerCase().trim();
  const lowerSubdomain = subdomain.toLowerCase().trim();

  db.get(
    `SELECT p.id, p.tenant_id FROM proxies p 
     JOIN tenants t ON p.tenant_id = t.id 
     WHERE t.saas_id = ? AND t.base_domain = ? AND p.subdomain = ?`,
    [req.saas.id, lowerDomain, lowerSubdomain],
    (err, proxy) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!proxy) return res.status(404).json({ error: 'Proxy not found' });

      db.run('DELETE FROM proxies WHERE id = ?', [proxy.id], deleteErr => {
        if (deleteErr) return res.status(500).json({ error: deleteErr.message });
        deleteCaddyHost(lowerSubdomain, lowerDomain).finally(() => {
          res.json({ success: true, deleted: `${lowerSubdomain}.${lowerDomain}` });
        });
      });
    }
  );
});

// API: Service status / health check
app.get('/api/v1/status', (req, res) => {
  res.json({
    status: 'ok',
    service: 'DomainProxy',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    caddy_admin: CADDY_ADMIN_URL || 'not configured'
  });
});

// API: Verify domain for Caddy on-demand TLS
// Caddy calls this endpoint to check if a domain should get a certificate
// Returns 200 if domain is registered, 404 otherwise
app.get('/api/v1/verify-domain', (req, res) => {
  const domain = req.query.domain;
  if (!domain) {
    console.log('🔒 Caddy verify-domain: no domain provided');
    return res.status(400).send('domain required');
  }
  
  const parts = domain.toLowerCase().split('.');
  if (parts.length < 2) {
    console.log(`🔒 Caddy verify-domain: invalid domain format: ${domain}`);
    return res.status(404).send('invalid domain');
  }
  
  const subdomain = parts[0];
  const baseDomain = parts.slice(1).join('.');
  
  // Check if this subdomain is registered in our database
  db.get(
    'SELECT p.id FROM proxies p JOIN tenants t ON p.tenant_id = t.id WHERE t.base_domain = ? AND p.subdomain = ?',
    [baseDomain, subdomain],
    (err, row) => {
      if (err) {
        console.error('🔒 Caddy verify-domain DB error:', err);
        return res.status(500).send('db error');
      }
      if (row) {
        console.log(`🔒 Caddy verify-domain: ✅ ${domain} is registered`);
        return res.status(200).send('ok');
      } else {
        console.log(`🔒 Caddy verify-domain: ❌ ${domain} not registered`);
        return res.status(404).send('not found');
      }
    }
  );
});

// API: Integration guide (serves lovable.md content as JSON for AI tools)
app.get('/api/v1/integration-guide', (req, res) => {
  const guidePath = path.join(__dirname, 'lovable.md');
  fs.readFile(guidePath, 'utf8', (err, content) => {
    if (err) {
      return res.status(404).json({ error: 'Integration guide not found' });
    }
    if (req.query.format === 'json') {
      res.json({
        title: 'DomainProxy Integration Guide',
        format: 'markdown',
        content
      });
    } else {
      res.type('text/markdown').send(content);
    }
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
    
    // Get detailed tenants and proxies for each SaaS
    const promises = saasList.map(saas => {
      return new Promise((resolve) => {
        // Get tenants
        db.all('SELECT id, base_domain, created_at FROM tenants WHERE saas_id = ? ORDER BY created_at DESC', [saas.saas_id], (err, tenants) => {
          if (err) tenants = [];
          
          // Get proxies for this SaaS
          db.all(`
            SELECT p.subdomain, p.target_url, p.created_at, t.base_domain 
            FROM proxies p 
            JOIN tenants t ON p.tenant_id = t.id 
            WHERE t.saas_id = ? 
            ORDER BY p.created_at DESC
          `, [saas.saas_id], (err, proxies) => {
            if (err) proxies = [];
            resolve({ ...saas, tenants, proxies });
          });
        });
      });
    });
    
    Promise.all(promises).then(saasData => {
      const saasHtml = saasData.map(s => {
        const tenantsHtml = s.tenants.map(t => 
          `<div class="tenant-item">
            <span>📍 ${t.base_domain}</span>
            <span style="color:#666;font-size:0.85em;">${new Date(t.created_at).toLocaleDateString()}</span>
          </div>`
        ).join('') || '<p style="color:#666;font-size:0.9em;">No tenants yet</p>';
        
        const proxiesHtml = s.proxies.map(p => 
          `<div class="proxy-item">
            <div class="proxy-url">🔗 ${p.subdomain}.${p.base_domain}</div>
            <div class="proxy-target">→ ${p.target_url}</div>
          </div>`
        ).join('') || '<p style="color:#666;font-size:0.9em;">No proxies yet</p>';
        
        return `
          <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
              <div>
                <h3 style="margin:0 0 10px;">${s.name || 'Unnamed SaaS'}</h3>
                <div class="api-key">${s.api_key}</div>
                <p style="color:#666;font-size:0.85em;margin:10px 0 0;">Created: ${new Date(s.created_at).toLocaleDateString()}</p>
              </div>
              <form method="post" action="/admin/delete-saas" style="margin:0;">
                <input type="hidden" name="saas_id" value="${s.saas_id}">
                <button type="submit" onclick="return confirm('Delete ${s.name || 'this SaaS account'}? This will delete all tenants and proxies.')" class="btn btn-danger" style="padding:8px 12px;font-size:0.85em;">Delete</button>
              </form>
            </div>
            
            <details style="margin-top:20px;">
              <summary>📂 Tenants (${s.tenant_count || 0})</summary>
              <div class="tenant-list">${tenantsHtml}</div>
            </details>
            
            <details>
              <summary>🔗 Proxies (${s.proxy_count || 0})</summary>
              <div class="proxy-list">${proxiesHtml}</div>
            </details>
          </div>
        `;
      }).join('') || '<li>No SaaS accounts</li>';

      res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin - DomainProxy</title>
<style>
*{box-sizing:border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;background:#0a0a0a;color:#e5e5e5;line-height:1.6;}
.container{max-width:1000px;margin:0 auto;padding:40px 20px;}
h1{color:#fff;margin-bottom:5px;}
h2{color:#fff;margin-top:40px;border-bottom:1px solid #333;padding-bottom:10px;}
h3{color:#22c55e;}
.subtitle{color:#888;margin-bottom:30px;}
a{color:#22c55e;text-decoration:none;}
a:hover{text-decoration:underline;}
code{background:#1a1a1a;padding:2px 8px;border-radius:4px;font-family:'Fira Code',monospace;font-size:0.9em;color:#22c55e;}
.nav{background:#111;padding:15px 0;border-bottom:1px solid #333;}
.nav-inner{max-width:1000px;margin:0 auto;padding:0 20px;display:flex;justify-content:space-between;align-items:center;}
.nav a{color:#888;margin-left:20px;}
.nav a:hover{color:#22c55e;}
.logo{font-weight:bold;font-size:1.2rem;color:#fff;}
.card{background:#111;border:1px solid #222;border-radius:12px;padding:25px;margin:15px 0;}
.card h3{margin-top:0;}
.api-key{background:#1a1a1a;padding:10px 15px;border-radius:6px;font-family:monospace;color:#22c55e;word-break:break-all;}
.btn{display:inline-block;background:#22c55e;color:#000;padding:10px 20px;border-radius:6px;font-weight:600;border:none;cursor:pointer;text-decoration:none;}
.btn:hover{background:#16a34a;text-decoration:none;}
.btn-danger{background:#ef4444;color:#fff;}
.btn-danger:hover{background:#dc2626;}
.btn-secondary{background:#333;color:#fff;}
.btn-secondary:hover{background:#444;}
input{width:100%;padding:12px;background:#1a1a1a;border:1px solid #333;border-radius:6px;color:#fff;font-size:1rem;margin-bottom:15px;}
input:focus{outline:none;border-color:#22c55e;}
.tenant-list,.proxy-list{margin:10px 0;}
.tenant-item,.proxy-item{background:#1a1a1a;padding:12px 15px;border-radius:6px;margin:8px 0;display:flex;justify-content:space-between;align-items:center;}
.proxy-item{flex-direction:column;align-items:flex-start;}
.proxy-url{color:#22c55e;font-weight:500;}
.proxy-target{color:#888;font-size:0.9rem;}
.badge{display:inline-block;padding:3px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;}
.badge-success{background:#22c55e;color:#000;}
.badge-pending{background:#f59e0b;color:#000;}
.quick-start{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:12px;padding:25px;margin:20px 0;}
.quick-start h3{color:#fff;margin-top:0;}
pre{background:#0a0a0a;padding:15px;border-radius:6px;overflow-x:auto;font-size:0.85rem;}
details{margin:10px 0;}
summary{cursor:pointer;color:#888;}
summary:hover{color:#22c55e;}
</style>
</head>
<body>
<nav class="nav">
  <div class="nav-inner">
    <span class="logo">🪄 DomainProxy</span>
    <div>
      <a href="/">Home</a>
      <a href="/docs">API Docs</a>
      <a href="/admin">Admin</a>
    </div>
  </div>
</nav>

<div class="container">
<h1>Admin Panel</h1>
<p class="subtitle">Manage your SaaS accounts and API keys</p>

<div class="quick-start">
  <h3>☁️ DomainProxy Cloud</h3>
  <p>You're using the managed cloud version — no infrastructure to manage!</p>
  <p style="margin-top:15px;"><strong>Quick Start:</strong></p>
  <p>1. Create a SaaS account below to get your API key</p>
  <p>2. Use the API to register subdomains for your customers</p>
  <p>3. Point your AI assistant at: <a href="/api/v1/integration-guide">/api/v1/integration-guide</a></p>
  <p style="margin-top:15px;font-size:0.9em;color:#666;">Want to self-host? <a href="https://github.com/magnusfroste/domainproxy" target="_blank">View on GitHub →</a></p>
</div>

<h2>Your SaaS Accounts</h2>
${saasHtml || '<p style="color:#888;">No accounts yet. Create one below!</p>'}

<h2>Create New SaaS Account</h2>
<div class="card">
  <form method="post" action="/admin/create-saas">
    <input name="name" placeholder="SaaS Name (e.g., MyAwesomeApp)" autocomplete="off">
    <button type="submit" class="btn">Create Account & Get API Key</button>
  </form>
</div>

<h2>API Reference</h2>
<div class="card">
  <p><strong>Base URL:</strong> <code>https://proxy.froste.eu</code></p>
  <p><strong>Authentication:</strong> <code>X-API-Key: your_api_key</code></p>
  <details>
    <summary>POST /api/v1/create-tenant</summary>
    <pre>{"base_domain": "customerdomain.com"}</pre>
  </details>
  <details>
    <summary>POST /api/v1/register-subdomain</summary>
    <pre>{"subdomain": "app", "base_domain": "customerdomain.com", "target_url": "https://your-app.com"}</pre>
  </details>
  <details>
    <summary>POST /api/v1/delete-proxy</summary>
    <pre>{"subdomain": "app", "base_domain": "customerdomain.com"}</pre>
  </details>
  <details>
    <summary>GET /api/v1/tenants</summary>
    <p>List all tenants for your SaaS</p>
  </details>
  <details>
    <summary>GET /api/v1/proxies</summary>
    <p>List all proxies with status</p>
  </details>
  <p style="margin-top:20px;"><a href="/docs" class="btn btn-secondary">Full API Documentation →</a></p>
</div>

</div>
</body></html>
      `);
    });
  });
});

app.post('/admin/create-saas', requireAdminAuth, (req, res) => {
  const { name } = req.body;
  const api_key = 'saas_' + Math.random().toString(36).substr(2, 9);
  db.run('INSERT INTO saas_accounts (api_key, name) VALUES (?, ?)', [api_key, name || null], (err) => {
    if (err) {
      res.status(500).send(`<!DOCTYPE html><html><body><h1>Error</h1><p>${err.message}</p><a href="/admin">Back to Admin</a></body></html>`);
    } else {
      res.send(`<!DOCTYPE html><html><head><title>Success</title><style>body{font-family:Arial;max-width:600px;margin:100px auto;padding:20px;text-align:center;}</style></head><body><h1>✅ SaaS Account Created!</h1><p><strong>Name:</strong> ${name || 'Unnamed'}</p><p><strong>API Key:</strong> <code style="background:#f4f4f4;padding:5px 10px;border-radius:5px;">${api_key}</code></p><p><a href="/admin" style="background:#007bff;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Back to Admin Panel</a></p></body></html>`);
    }
  });
});

app.post('/admin/delete-saas', requireAdminAuth, (req, res) => {
  const { saas_id } = req.body;
  if (!saas_id) {
    return res.status(400).send('Missing saas_id');
  }
  
  // Delete SaaS account (CASCADE will delete tenants and proxies)
  db.run('DELETE FROM saas_accounts WHERE id = ?', [saas_id], (err) => {
    if (err) {
      res.status(500).send(`<!DOCTYPE html><html><body><h1>Error</h1><p>${err.message}</p><a href="/admin">Back to Admin</a></body></html>`);
    } else {
      res.redirect('/admin');
    }
  });
});

// Admin logs endpoint (returns last N log lines as JSON or plain text)
app.get('/admin/logs', requireAdminAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, LOG_BUFFER_SIZE);
  const lines = logBuffer.slice(-limit);
  if (req.query.format === 'json') {
    res.json({ count: lines.length, logs: lines });
  } else {
    res.type('text/plain').send(lines.join('\n'));
  }
});

// Dynamic Proxy Middleware (catch-all)
app.use(async (req, res, next) => {
  const host = req.headers.host || '';
  const originalUrl = req.originalUrl;
  
  console.log(`🔍 Incoming request: ${req.method} ${host}${originalUrl}`);
  
  // Skip if not a custom domain (contains localhost, proxy domain, or no subdomain)
  if (host.includes('localhost') || host.includes('proxy.froste.eu') || host.split('.').length < 3) {
    console.log('⚠️ Skipping proxy for:', host);
    return next();
  }

  const parts = host.split('.');
  const subdomain = parts[0];
  const baseDomain = parts.slice(1).join('.');

  console.log(`📥 Incoming host: ${host}, subdomain: ${subdomain}, baseDomain: ${baseDomain}, url: ${req.url}`);

  if (subdomain === 'www' || subdomain === 'localhost' || subdomain === 'lvh.me') return next();

  db.get(
    'SELECT p.target_url FROM proxies p JOIN tenants t ON p.tenant_id = t.id WHERE t.base_domain = ? AND p.subdomain = ?',
    [baseDomain, subdomain],
    (err, row) => {
      if (err) {
        console.error('DB error looking up proxy:', err);
        return next();
      }
      if (!row) {
        console.log(`⚠️ No proxy found for subdomain=${subdomain}, baseDomain=${baseDomain}`);
        return next(); // Fallback
      }

      // Parse target URL to get base domain
      const targetUrl = new URL(row.target_url);
      const targetBase = `${targetUrl.protocol}//${targetUrl.host}`;
      
      // For SPA apps with host-based routing: pass through all requests to target domain root
      // The SPA will detect the custom domain and render the correct tenant page
      console.log(`🔄 Proxying ${host}${req.url} → ${targetBase}${req.url}`);
      
      const isHttps = targetUrl.protocol === 'https:';
      const proxy = createProxyMiddleware({
        target: targetBase,
        changeOrigin: true, // Use target's Host header for external services like Lovable
        secure: isHttps, // Only verify SSL for HTTPS targets
        headers: {
          'X-Forwarded-Host': host, // Pass original host for multi-tenant detection
          'X-Original-Host': host
        },
        onError: (err, req, res) => {
          console.error('Proxy error:', err);
          res.status(502).send('Proxy Error');
        }
      });
      proxy(req, res, next);
    }
  );
});

// Static files (after dynamic proxy, so proxied domains take precedence)
app.use(express.static('public'));

// Docs page
app.get('/docs', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>API Documentation - DomainProxy</title>
<style>
*{box-sizing:border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;background:#0a0a0a;color:#e5e5e5;line-height:1.6;}
.container{max-width:900px;margin:0 auto;padding:40px 20px;}
h1{font-size:2.5rem;margin-bottom:10px;color:#fff;}
h2{color:#fff;border-bottom:1px solid #333;padding-bottom:10px;margin-top:40px;}
h3{color:#22c55e;margin-top:30px;}
.subtitle{color:#888;font-size:1.1rem;margin-bottom:30px;}
a{color:#22c55e;text-decoration:none;}
a:hover{text-decoration:underline;}
code{background:#1a1a1a;padding:2px 8px;border-radius:4px;font-family:'Fira Code',monospace;font-size:0.9em;color:#22c55e;}
pre{background:#1a1a1a;padding:20px;border-radius:8px;overflow-x:auto;border:1px solid #333;}
pre code{background:none;padding:0;color:#e5e5e5;}
.endpoint{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:20px;margin:15px 0;}
.method{display:inline-block;padding:4px 10px;border-radius:4px;font-weight:bold;font-size:0.85rem;margin-right:10px;}
.method.post{background:#22c55e;color:#000;}
.method.get{background:#3b82f6;color:#fff;}
.method.delete{background:#ef4444;color:#fff;}
.nav{background:#111;padding:15px 0;border-bottom:1px solid #333;}
.nav-inner{max-width:900px;margin:0 auto;padding:0 20px;display:flex;justify-content:space-between;align-items:center;}
.nav a{color:#888;margin-left:20px;}
.nav a:hover{color:#22c55e;}
.logo{font-weight:bold;font-size:1.2rem;color:#fff;}
table{width:100%;border-collapse:collapse;margin:15px 0;}
th,td{text-align:left;padding:10px;border-bottom:1px solid #333;}
th{color:#888;font-weight:normal;}
</style>
</head>
<body>
<nav class="nav">
  <div class="nav-inner">
    <span class="logo">🪄 DomainProxy</span>
    <div>
      <a href="/">Home</a>
      <a href="/docs">Docs</a>
      <a href="/admin">Admin</a>
    </div>
  </div>
</nav>
<div class="container">
<h1>API Documentation</h1>
<p class="subtitle">Complete reference for the DomainProxy API — works with both Cloud and Self-Hosted</p>

<div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin:20px 0;display:flex;gap:20px;flex-wrap:wrap;">
  <div style="flex:1;min-width:200px;">
    <h4 style="color:#22c55e;margin:0 0 5px;">☁️ Cloud</h4>
    <code>https://proxy.froste.eu</code>
  </div>
  <div style="flex:1;min-width:200px;">
    <h4 style="color:#888;margin:0 0 5px;">🏠 Self-Hosted</h4>
    <code>https://your-domain.com</code>
  </div>
</div>

<h2>Authentication</h2>
<p>All API requests require an <code>X-API-Key</code> header with your SaaS API key.</p>
<p><strong>Cloud users:</strong> Get your API key at <a href="/admin">/admin</a></p>
<p><strong>Self-hosted:</strong> Create API keys in your own admin panel</p>
<pre><code>curl -X POST https://proxy.froste.eu/api/v1/create-tenant \\
  -H "X-API-Key: your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"base_domain": "yourdomain.com"}'</code></pre>

<h2>Endpoints</h2>

<div class="endpoint">
  <h3><span class="method post">POST</span>/api/v1/create-tenant</h3>
  <p>Create a tenant (base domain) for your SaaS. Call this once per customer domain.</p>
  <table>
    <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
    <tr><td><code>base_domain</code></td><td>string</td><td>Customer's base domain (e.g., "lazyjobs.ink")</td></tr>
  </table>
  <p><strong>Response:</strong></p>
  <pre><code>{"success": true, "tenant_id": 1, "base_domain": "lazyjobs.ink"}</code></pre>
</div>

<div class="endpoint">
  <h3><span class="method post">POST</span>/api/v1/register-subdomain</h3>
  <p>Register a subdomain proxy. This is the main endpoint for adding customer subdomains.</p>
  <table>
    <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
    <tr><td><code>subdomain</code></td><td>string</td><td>Subdomain name (e.g., "career")</td></tr>
    <tr><td><code>base_domain</code></td><td>string</td><td>Base domain (e.g., "lazyjobs.ink")</td></tr>
    <tr><td><code>target_url</code></td><td>string</td><td>URL to proxy to (e.g., "https://myapp.com")</td></tr>
  </table>
  <p><strong>Response:</strong></p>
  <pre><code>{
  "success": true,
  "subdomain": "career",
  "base_domain": "lazyjobs.ink",
  "target_url": "https://myapp.com",
  "proxy_url": "https://career.lazyjobs.ink"
}</code></pre>
</div>

<div class="endpoint">
  <h3><span class="method post">POST</span>/api/v1/delete-proxy</h3>
  <p>Delete a subdomain proxy entry.</p>
  <table>
    <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
    <tr><td><code>subdomain</code></td><td>string</td><td>Subdomain to delete</td></tr>
    <tr><td><code>base_domain</code></td><td>string</td><td>Base domain</td></tr>
  </table>
</div>

<div class="endpoint">
  <h3><span class="method get">GET</span>/api/v1/tenants</h3>
  <p>List all tenants (base domains) for your SaaS account.</p>
</div>

<div class="endpoint">
  <h3><span class="method get">GET</span>/api/v1/proxies</h3>
  <p>List all proxy entries with provisioning status.</p>
</div>

<div class="endpoint">
  <h3><span class="method get">GET</span>/api/v1/status</h3>
  <p>Health check endpoint. Returns service status.</p>
</div>

<div class="endpoint">
  <h3><span class="method get">GET</span>/api/v1/verify-domain</h3>
  <p>Check if a domain is registered. Used internally by Caddy for on-demand TLS.</p>
  <table>
    <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
    <tr><td><code>domain</code></td><td>query string</td><td>Full domain to check (e.g., "career.lazyjobs.ink")</td></tr>
  </table>
</div>

<div class="endpoint">
  <h3><span class="method get">GET</span>/api/v1/integration-guide</h3>
  <p>Full integration guide in Markdown format. Perfect for AI coding assistants like Lovable.</p>
</div>

<h2>DNS Setup</h2>
<p>Your customers need to add a CNAME record pointing their subdomain to <code>proxy.froste.eu</code>:</p>
<pre><code>career.lazyjobs.ink  CNAME  proxy.froste.eu</code></pre>
<p>Or use a wildcard for all subdomains:</p>
<pre><code>*.lazyjobs.ink  CNAME  proxy.froste.eu</code></pre>

<h2>How TLS Works</h2>
<p>DomainProxy uses <strong>on-demand TLS</strong> with Let's Encrypt:</p>
<ol>
<li>Customer visits <code>https://career.lazyjobs.ink</code> for the first time</li>
<li>Caddy calls <code>/api/v1/verify-domain</code> to check if domain is registered</li>
<li>If registered, Caddy provisions a TLS certificate via ACME HTTP-01 challenge</li>
<li>Certificate is cached and renewed automatically</li>
</ol>

</div>
</body>
</html>
  `);
});

// Fallback landing page
app.use((req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DomainProxy - Custom Domains for SaaS</title>
<style>
*{box-sizing:border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;background:#0a0a0a;color:#e5e5e5;line-height:1.6;}
.hero{text-align:center;padding:100px 20px 80px;background:linear-gradient(135deg,#0a0a0a 0%,#1a1a2e 50%,#0a0a0a 100%);}
.hero h1{font-size:3.5rem;margin-bottom:15px;color:#fff;letter-spacing:-1px;}
.hero h1 span{background:linear-gradient(135deg,#22c55e,#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
.hero .subtitle{font-size:1.4rem;color:#888;max-width:650px;margin:0 auto 35px;}
.badge{display:inline-block;background:linear-gradient(135deg,#22c55e20,#3b82f620);border:1px solid #22c55e40;color:#22c55e;padding:8px 18px;border-radius:25px;font-size:0.9rem;font-weight:500;margin-bottom:25px;}
.cta{display:inline-block;background:#22c55e;color:#000;padding:16px 36px;border-radius:10px;font-weight:600;text-decoration:none;margin:8px;transition:all 0.2s;font-size:1rem;}
.cta:hover{transform:translateY(-2px);box-shadow:0 10px 30px rgba(34,197,94,0.3);}
.cta.secondary{background:#222;color:#fff;border:1px solid #333;}
.cta.secondary:hover{background:#333;box-shadow:0 10px 30px rgba(0,0,0,0.3);}
.container{max-width:1100px;margin:0 auto;padding:80px 20px;}
.section-title{text-align:center;font-size:2.2rem;margin-bottom:15px;color:#fff;}
.section-subtitle{text-align:center;color:#888;max-width:600px;margin:0 auto 50px;font-size:1.1rem;}

/* Deployment options */
.deploy-options{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:30px;margin:60px 0;}
.deploy-card{background:#111;border:1px solid #222;border-radius:16px;padding:40px;position:relative;overflow:hidden;}
.deploy-card.featured{border-color:#22c55e40;background:linear-gradient(135deg,#111 0%,#0a1a0a 100%);}
.deploy-card.featured::before{content:"RECOMMENDED";position:absolute;top:20px;right:-35px;background:#22c55e;color:#000;padding:5px 40px;font-size:0.7rem;font-weight:bold;transform:rotate(45deg);}
.deploy-card h3{font-size:1.5rem;margin:0 0 10px;color:#fff;display:flex;align-items:center;gap:10px;}
.deploy-card .price{font-size:2.5rem;font-weight:bold;color:#22c55e;margin:20px 0 5px;}
.deploy-card .price span{font-size:1rem;color:#666;font-weight:normal;}
.deploy-card .price-note{color:#666;font-size:0.9rem;margin-bottom:20px;}
.deploy-card ul{list-style:none;padding:0;margin:25px 0;}
.deploy-card li{padding:10px 0;color:#888;display:flex;align-items:center;gap:10px;}
.deploy-card li::before{content:"✓";color:#22c55e;font-weight:bold;}
.deploy-card .cta{width:100%;text-align:center;margin-top:20px;}

/* Features */
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:25px;margin:50px 0;}
.feature{background:#111;border:1px solid #222;border-radius:12px;padding:30px;transition:border-color 0.2s;}
.feature:hover{border-color:#333;}
.feature-icon{font-size:2rem;margin-bottom:15px;}
.feature h3{color:#fff;margin:0 0 10px;font-size:1.1rem;}
.feature p{color:#888;margin:0;font-size:0.95rem;}

/* Comparison */
.comparison{background:#111;border-radius:16px;padding:50px;margin:60px 0;border:1px solid #222;}
.comparison h2{text-align:center;margin:0 0 40px;color:#fff;}
table{width:100%;border-collapse:collapse;}
th,td{padding:18px 15px;text-align:left;border-bottom:1px solid #222;}
th{color:#666;font-weight:500;font-size:0.9rem;text-transform:uppercase;letter-spacing:0.5px;}
td:first-child{color:#fff;}
.check{color:#22c55e;font-weight:bold;}
.x{color:#444;}

/* Steps */
.steps{max-width:700px;margin:0 auto;counter-reset:step;}
.step{display:flex;align-items:flex-start;margin:30px 0;padding-left:60px;position:relative;}
.step::before{counter-increment:step;content:counter(step);position:absolute;left:0;width:42px;height:42px;background:linear-gradient(135deg,#22c55e,#16a34a);color:#000;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:1.1rem;}
.step-content h4{margin:0 0 8px;color:#fff;font-size:1.1rem;}
.step-content p{margin:0;color:#888;}

/* Vibe section */
.vibe-section{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);border-radius:16px;padding:50px;margin:60px 0;text-align:center;border:1px solid #333;}
.vibe-section h2{margin:0 0 15px;color:#fff;font-size:1.8rem;}
.vibe-section p{color:#888;max-width:550px;margin:0 auto 25px;}

/* Code */
code{background:#1a1a1a;padding:3px 8px;border-radius:4px;font-family:'Fira Code',monospace;font-size:0.9em;color:#22c55e;}
pre{background:#0d0d0d;padding:25px;border-radius:12px;overflow-x:auto;border:1px solid #222;font-size:0.9rem;}
pre code{background:none;padding:0;color:#e5e5e5;}

/* Nav */
.nav{background:rgba(17,17,17,0.9);backdrop-filter:blur(10px);padding:15px 0;border-bottom:1px solid #222;position:fixed;top:0;left:0;right:0;z-index:100;}
.nav-inner{max-width:1100px;margin:0 auto;padding:0 20px;display:flex;justify-content:space-between;align-items:center;}
.nav a{color:#888;margin-left:25px;text-decoration:none;font-size:0.95rem;transition:color 0.2s;}
.nav a:hover{color:#22c55e;}
.logo{font-weight:bold;font-size:1.3rem;color:#fff;display:flex;align-items:center;gap:8px;}

/* Self-host section */
.selfhost-section{background:#111;border:1px solid #222;border-radius:16px;padding:50px;margin:60px 0;}
.selfhost-section h2{margin:0 0 20px;color:#fff;}
.selfhost-section p{color:#888;margin-bottom:25px;}
.selfhost-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-top:30px;}
.selfhost-item{background:#0a0a0a;border:1px solid #222;border-radius:8px;padding:20px;text-align:center;}
.selfhost-item h4{color:#fff;margin:10px 0 5px;font-size:1rem;}
.selfhost-item p{color:#666;font-size:0.85rem;margin:0;}

footer{text-align:center;padding:50px 20px;color:#666;border-top:1px solid #222;}
footer a{color:#888;text-decoration:none;margin:0 15px;}
footer a:hover{color:#22c55e;}
</style>
</head>
<body>
<nav class="nav">
  <div class="nav-inner">
    <span class="logo">🪄 DomainProxy</span>
    <div>
      <a href="#features">Features</a>
      <a href="#pricing">Pricing</a>
      <a href="/docs">API Docs</a>
      <a href="https://github.com/magnusfroste/domainproxy" target="_blank">GitHub</a>
      <a href="/admin" style="color:#22c55e;">Get Started →</a>
    </div>
  </div>
</nav>

<div class="hero" style="padding-top:140px;">
  <div class="badge">🚀 Cloud or Self-Hosted — Your Choice</div>
  <h1>Custom Domains for <span>Your SaaS</span></h1>
  <p class="subtitle">Give your customers branded subdomains with automatic HTTPS. Like Cloudflare for SaaS, but free and open source.</p>
  <a href="/admin" class="cta">Start Free on Cloud</a>
  <a href="https://github.com/magnusfroste/domainproxy" class="cta secondary">Self-Host →</a>
</div>

<div class="container" id="pricing">
  <h2 class="section-title">Choose Your Deployment</h2>
  <p class="section-subtitle">Use our managed cloud for instant setup, or self-host for complete control. Same powerful features either way.</p>
  
  <div class="deploy-options">
    <div class="deploy-card featured">
      <h3>☁️ DomainProxy Cloud</h3>
      <div class="price">Free <span>forever</span></div>
      <div class="price-note">No credit card required</div>
      <ul>
        <li>Instant API key — start in 30 seconds</li>
        <li>Unlimited subdomains</li>
        <li>Automatic HTTPS via Let's Encrypt</li>
        <li>99.9% uptime SLA</li>
        <li>Managed infrastructure</li>
        <li>AI integration guide included</li>
      </ul>
      <a href="/admin" class="cta">Get Your Free API Key</a>
    </div>
    
    <div class="deploy-card">
      <h3>🏠 Self-Hosted</h3>
      <div class="price">$0 <span>open source</span></div>
      <div class="price-note">MIT License — do whatever you want</div>
      <ul>
        <li>Full source code access</li>
        <li>Run on your own infrastructure</li>
        <li>Complete data ownership</li>
        <li>Customize everything</li>
        <li>Docker Compose ready</li>
        <li>Community support</li>
      </ul>
      <a href="https://github.com/magnusfroste/domainproxy" class="cta secondary">View on GitHub</a>
    </div>
  </div>
</div>

<div class="container" id="features">
  <h2 class="section-title">Everything You Need</h2>
  <p class="section-subtitle">Built specifically for multi-tenant SaaS applications</p>
  
  <div class="features">
    <div class="feature">
      <div class="feature-icon">🔒</div>
      <h3>Automatic HTTPS</h3>
      <p>TLS certificates provisioned automatically via Let's Encrypt. Zero configuration needed.</p>
    </div>
    <div class="feature">
      <div class="feature-icon">⚡</div>
      <h3>On-Demand TLS</h3>
      <p>Certificates issued on first request. No waiting, no manual provisioning.</p>
    </div>
    <div class="feature">
      <div class="feature-icon">🎯</div>
      <h3>Simple REST API</h3>
      <p>One API call to register a subdomain. Perfect for automation and AI coding tools.</p>
    </div>
    <div class="feature">
      <div class="feature-icon">🌐</div>
      <h3>Multi-Tenant Ready</h3>
      <p>Built for SaaS. Each customer gets their own branded subdomain.</p>
    </div>
    <div class="feature">
      <div class="feature-icon">🤖</div>
      <h3>AI-Friendly</h3>
      <p>Integration guide designed for Lovable, Cursor, and other AI coding assistants.</p>
    </div>
    <div class="feature">
      <div class="feature-icon">🔓</div>
      <h3>Open Source</h3>
      <p>MIT licensed. Inspect the code, contribute, or fork it for your own needs.</p>
    </div>
  </div>
</div>

<div class="container">
  <div class="comparison">
    <h2>DomainProxy vs Alternatives</h2>
    <table>
      <tr>
        <th>Feature</th>
        <th>Cloudflare for SaaS</th>
        <th>Custom Nginx</th>
        <th style="color:#22c55e;">DomainProxy</th>
      </tr>
      <tr>
        <td>Automatic TLS</td>
        <td class="check">✓</td>
        <td class="x">Manual</td>
        <td class="check">✓</td>
      </tr>
      <tr>
        <td>On-Demand Certificates</td>
        <td class="check">✓</td>
        <td class="x">✗</td>
        <td class="check">✓</td>
      </tr>
      <tr>
        <td>Simple API</td>
        <td class="check">✓</td>
        <td class="x">✗</td>
        <td class="check">✓</td>
      </tr>
      <tr>
        <td>Self-Hostable</td>
        <td class="x">✗</td>
        <td class="check">✓</td>
        <td class="check">✓</td>
      </tr>
      <tr>
        <td>Pricing</td>
        <td>$2/hostname/mo</td>
        <td>Server costs</td>
        <td style="color:#22c55e;font-weight:bold;">Free</td>
      </tr>
      <tr>
        <td>Setup Time</td>
        <td>Days (contract)</td>
        <td>Hours</td>
        <td style="color:#22c55e;font-weight:bold;">30 seconds</td>
      </tr>
      <tr>
        <td>AI Integration Guide</td>
        <td class="x">✗</td>
        <td class="x">✗</td>
        <td class="check">✓</td>
      </tr>
    </table>
  </div>
</div>

<div class="container">
  <h2 class="section-title">How It Works</h2>
  <p class="section-subtitle">Get custom domains working in 4 simple steps</p>
  
  <div class="steps">
    <div class="step">
      <div class="step-content">
        <h4>Get your API key</h4>
        <p>Sign up in the admin panel and get your API key instantly. No credit card, no waiting.</p>
      </div>
    </div>
    <div class="step">
      <div class="step-content">
        <h4>Register subdomains via API</h4>
        <p><code>POST /api/v1/register-subdomain</code> with subdomain, base_domain, and target_url.</p>
      </div>
    </div>
    <div class="step">
      <div class="step-content">
        <h4>Customer sets up DNS</h4>
        <p>They add a CNAME record: <code>subdomain.theirdomain.com → proxy.froste.eu</code></p>
      </div>
    </div>
    <div class="step">
      <div class="step-content">
        <h4>Done! HTTPS works automatically</h4>
        <p>On first visit, we provision a Let's Encrypt certificate. No action needed.</p>
      </div>
    </div>
  </div>
</div>

<div class="container">
  <div class="vibe-section">
    <h2>🤖 Built for Vibe Coders</h2>
    <p>Building with Lovable, Cursor, or another AI tool? Just point your AI at our integration guide:</p>
    <pre><code>Read this guide and implement custom domains for my SaaS:
https://proxy.froste.eu/api/v1/integration-guide</code></pre>
    <p style="margin-top:25px;"><a href="/api/v1/integration-guide" class="cta">View Integration Guide</a></p>
  </div>
</div>

<div class="container">
  <div class="selfhost-section">
    <h2>🏠 Self-Hosting Made Easy</h2>
    <p>Want complete control? Deploy DomainProxy on your own infrastructure in minutes.</p>
    <pre><code># Clone and run with Docker
git clone https://github.com/magnusfroste/domainproxy.git
cd domainproxy
cp .env.example .env
docker compose up -d

# That's it! Access at http://localhost:3000</code></pre>
    <div class="selfhost-grid">
      <div class="selfhost-item">
        <div style="font-size:1.5rem;">🐳</div>
        <h4>Docker Ready</h4>
        <p>One command deploy</p>
      </div>
      <div class="selfhost-item">
        <div style="font-size:1.5rem;">📦</div>
        <h4>Caddy Included</h4>
        <p>Auto TLS built-in</p>
      </div>
      <div class="selfhost-item">
        <div style="font-size:1.5rem;">💾</div>
        <h4>SQLite Storage</h4>
        <p>No database setup</p>
      </div>
      <div class="selfhost-item">
        <div style="font-size:1.5rem;">🔧</div>
        <h4>Fully Customizable</h4>
        <p>MIT licensed</p>
      </div>
    </div>
  </div>
</div>

<div class="container">
  <h2 class="section-title">Quick Example</h2>
  <pre><code># 1. Create a tenant for your customer's domain
curl -X POST https://proxy.froste.eu/api/v1/create-tenant \\
  -H "X-API-Key: your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{"base_domain": "lazyjobs.ink"}'

# 2. Register a subdomain
curl -X POST https://proxy.froste.eu/api/v1/register-subdomain \\
  -H "X-API-Key: your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{
    "subdomain": "career",
    "base_domain": "lazyjobs.ink",
    "target_url": "https://your-app.lovable.app"
  }'

# 3. Customer adds DNS: career.lazyjobs.ink CNAME proxy.froste.eu
# 4. Visit https://career.lazyjobs.ink — HTTPS just works! 🎉</code></pre>
</div>

<footer>
  <p style="font-size:1.1rem;color:#fff;margin-bottom:20px;">Ready to give your customers custom domains?</p>
  <a href="/admin" class="cta" style="margin-bottom:30px;">Start Free on Cloud</a>
  <p style="margin-top:30px;">
    <a href="/docs">API Docs</a>
    <a href="/admin">Admin Panel</a>
    <a href="/api/v1/integration-guide">Integration Guide</a>
    <a href="https://github.com/magnusfroste/domainproxy">GitHub</a>
  </p>
  <p style="margin-top:20px;font-size:0.9rem;">DomainProxy — Open source custom domains for SaaS builders</p>
</footer>
</body>
</html>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Subdomain running on http://localhost:${PORT}`);
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