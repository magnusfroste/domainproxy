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

// Provision Caddy for a specific hostname (e.g. career.example.com)
function provisionCaddyHost(subdomain, baseDomain, tenantId) {
  if (!CADDY_ADMIN_URL || !CADDY_EMAIL) return Promise.resolve();
  const hostname = `${subdomain}.${baseDomain}`;
  const serverName = `proxy-${hostname.replace(/\./g, '-')}`;
  // Minimal server config; Caddy's global TLS automation (from Caddyfile) handles certs
  const caddyConfig = {
    listen: [":443", ":80"],
    routes: [{
      match: [{ host: [hostname] }],
      handle: [{
        handler: "reverse_proxy",
        upstreams: [{ dial: CADDY_UPSTREAM }]
      }]
    }]
  };

  return axios.put(`${CADDY_ADMIN_URL}/config/apps/http/servers/${serverName}`, caddyConfig)
    .then(() => {
      console.log(`✅ Caddy provisioned for ${hostname}`);
      if (tenantId) updateProvisionStatus(tenantId, subdomain, 'success', 'Certificate provisioning triggered');
      return { status: 'success' };
    })
    .catch(e => {
      const details = e.response?.data || e.message;
      console.error(`❌ Caddy config failed for ${hostname}:`, details);
      if (tenantId) updateProvisionStatus(tenantId, subdomain, 'error', JSON.stringify(details));
      return { status: 'error', error: details };
    });
}

function deleteCaddyHost(subdomain, baseDomain) {
  if (!CADDY_ADMIN_URL) return Promise.resolve();
  const hostname = `${subdomain}.${baseDomain}`;
  const serverName = `proxy-${hostname.replace(/\./g, '-')}`;
  return axios.delete(`${CADDY_ADMIN_URL}/config/apps/http/servers/${serverName}`)
    .then(() => console.log(`🗑️ Caddy removed config for ${hostname}`))
    .catch(e => {
      if (e.response?.status === 404) {
        console.log(`ℹ️ Caddy config for ${hostname} already removed`);
      } else {
        console.error(`⚠️ Failed to delete Caddy config for ${hostname}:`, e.response?.data || e.message);
      }
    });
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
          `<li style="font-size:0.9em;padding:5px;margin:5px 0;background:#f9f9f9;">📍 ${t.base_domain} <span style="color:#666;font-size:0.8em;">(${new Date(t.created_at).toLocaleString()})</span></li>`
        ).join('') || '<li style="font-size:0.9em;color:#999;">No tenants</li>';
        
        const proxiesHtml = s.proxies.map(p => 
          `<li style="font-size:0.9em;padding:5px;margin:5px 0;background:#f0f8ff;">
            🔗 <strong>${p.subdomain}.${p.base_domain}</strong> → ${p.target_url}
            <br><span style="color:#666;font-size:0.8em;margin-left:20px;">${new Date(p.created_at).toLocaleString()}</span>
          </li>`
        ).join('') || '<li style="font-size:0.9em;color:#999;">No proxies</li>';
        
        return `
          <li style="margin-bottom:20px;">
            <div style="background:#f8f9fa;padding:10px;border-radius:5px;margin-bottom:10px;position:relative;">
              <strong style="font-size:1.1em;">${s.name || 'Unnamed SaaS'}</strong>
              <br><code style="background:#fff;padding:3px 8px;border-radius:3px;font-size:0.9em;">${s.api_key}</code>
              <br><span style="color:#666;font-size:0.85em;">Created: ${new Date(s.created_at).toLocaleString()}</span>
              <form method="post" action="/admin/delete-saas" style="display:inline;position:absolute;top:10px;right:10px;">
                <input type="hidden" name="saas_id" value="${s.saas_id}">
                <button type="submit" onclick="return confirm('Delete ${s.name || 'this SaaS account'}? This will delete all tenants and proxies.')" style="padding:5px 10px;background:#dc3545;color:white;border:none;cursor:pointer;border-radius:3px;font-size:0.85em;">🗑️ Delete</button>
              </form>
            </div>
            
            <details style="margin-left:10px;">
              <summary style="cursor:pointer;padding:5px;background:#e9ecef;border-radius:3px;margin:5px 0;">📂 Tenants (${s.tenant_count || 0})</summary>
              <ul style="margin:10px 0;padding-left:20px;">${tenantsHtml}</ul>
            </details>
            
            <details style="margin-left:10px;">
              <summary style="cursor:pointer;padding:5px;background:#e9ecef;border-radius:3px;margin:5px 0;">🔗 Proxies (${s.proxy_count || 0})</summary>
              <ul style="margin:10px 0;padding-left:20px;">${proxiesHtml}</ul>
            </details>
          </li>
        `;
      }).join('') || '<li>No SaaS accounts</li>';

      res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Subdomain Admin</title>
<style>
body{font-family:Arial;max-width:1200px;margin:50px auto;padding:20px;}
form,ul{margin:20px 0;} 
input,textarea{width:100%;padding:10px;box-sizing:border-box;}
button{padding:10px 20px;background:#007bff;color:white;border:none;cursor:pointer;border-radius:5px;}
button:hover{background:#0056b3;}
li{padding:10px;border:1px solid #ddd;margin:10px 0;list-style:none;}
details{margin:5px 0;}
summary{font-weight:500;}
code{font-family:monospace;}
</style>
</head>
<body>
<h1>🪄 Subdomain - Domain Proxy Service</h1>
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
  <button type="submit">Create SaaS + API Key</button>
</form>
<script>
// Ensure form submission includes auth
document.querySelector('form').addEventListener('submit', function(e) {
  console.log('Form submitted');
});
</script>
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
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  const parts = host.split('.');
  if (parts.length < 2) return next();

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

      console.log(`🔄 Proxying ${host}${req.url} → ${row.target_url}`);
      const proxy = createProxyMiddleware({
        target: row.target_url,
        changeOrigin: false, // Keep original Host header for multi-tenant detection
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

// Static files (after dynamic proxy, so proxied domains take precedence)
app.use(express.static('public'));

// Fallback landing page
app.use((req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head><title>Subdomain</title>
<style>body{font-family:sans-serif;max-width:600px;margin:100px auto;padding:20px;text-align:center;}</style>
</head>
<body>
<h1>🪄 Subdomain - Custom Domain Proxy</h1>
<p>Point wildcard DNS (*.yourdomain.com) to this server.</p>
<p>Register subdomains via API: <code>POST /api/v1/register-subdomain</code></p>
<p><a href="/admin">Admin Panel</a> | Example: <a href="https://career.froste.eu">career.froste.eu</a></p>
<p>Demo SaaS: froste.eu / saas_demo_123</p>
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