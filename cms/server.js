const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs-extra');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const SUBDOMAIN_URL = process.env.SUBDOMAIN_URL || 'http://localhost:3000';
const SUBDOMAIN_API_KEY = process.env.SUBDOMAIN_API_KEY || 'saas_demo_123';
const CMS_URL = process.env.CMS_URL || 'http://localhost:3001';
const DATA_DIR = path.join(__dirname, 'data');
fs.ensureDirSync(DATA_DIR);

const DB_PATH = path.join(DATA_DIR, 'cms.db');
const db = new sqlite3.Database(DB_PATH);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: 'career-cms-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

// Init DB
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,  -- hashed in prod
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tenants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    base_domain TEXT NOT NULL,
    subdomain TEXT NOT NULL DEFAULT 'career',
    content TEXT DEFAULT '',
    jobs TEXT DEFAULT '[]',  -- JSON array
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
  )`);

  // Demo users
  db.get('SELECT id FROM users WHERE email = ?', ['demo1@froste.eu'], (err, row) => {
    if (!row) db.run('INSERT INTO users (email, password) VALUES (?, ?)', ['demo1@froste.eu', 'demo123']);
  });
  db.get('SELECT id FROM users WHERE email = ?', ['demo2@liteit.se'], (err, row) => {
    if (!row) db.run('INSERT INTO users (email, password) VALUES (?, ?)', ['demo2@liteit.se', 'demo123']);
  });
});

// Middleware: require login
function requireLogin(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}

// Login
app.get('/login', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html><head><title>Career CMS Login</title><style>body{font-family:Arial;max-width:400px;margin:100px auto;padding:20px;}</style></head>
<body>
<h1>Login to Career CMS</h1>
<form method="post" action="/login">
  <input name="email" placeholder="email" required style="width:100%;padding:10px;margin:10px 0;">
  <input name="password" type="password" placeholder="password" required style="width:100%;padding:10px;margin:10px 0;">
  <button style="width:100%;padding:10px;background:#007bff;color:white;border:none;">Login</button>
</form>
<p>Demo: demo1@froste.eu / demo123 | demo2@liteit.se / demo123</p>
</body></html>
  `);
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT id FROM users WHERE email = ? AND password = ?', [email, password], (err, user) => {
    if (user) {
      req.session.userId = user.id;
      res.redirect('/dashboard');
    } else {
      res.send('Invalid credentials');
    }
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Dashboard
app.get('/dashboard', requireLogin, (req, res) => {
  const userId = req.session.userId;
  db.all('SELECT * FROM tenants WHERE user_id = ? ORDER BY created_at DESC', [userId], (err, tenants) => {
    if (err) tenants = [];
    const PROXY_DOMAIN = process.env.PROXY_DOMAIN || 'app-domain-proxy.katsu6.easypanel.host';
    const tenantList = tenants.map(t => {
      const cnameTarget = `${t.subdomain}-${t.base_domain.replace(/\./g, '-')}.${PROXY_DOMAIN}`;
      return `
      <li>
        <strong>${t.subdomain}.${t.base_domain}</strong>
        <a href="https://${t.subdomain}.${t.base_domain}" target="_blank" style="margin-left:10px;">🌐 Live</a>
        <br><strong>DNS Setup:</strong> Add CNAME record:
        <br><code style="background:#f4f4f4;padding:5px;display:block;margin:5px 0;">${t.subdomain}  CNAME  ${cnameTarget}</code>
        <br>Content: ${t.content.substring(0, 100)}...
        <br><a href="/dashboard/edit/${t.id}">Edit</a> |
        <form method="post" action="/dashboard/delete/${t.id}" style="display:inline;" onsubmit="return confirm('Delete?')">
          <button>Delete</button>
        </form>
      </li>
    `}).join('') || '<li>No tenants</li>';

    res.send(`
<!DOCTYPE html>
<html><head><title>Career CMS Dashboard</title>
<style>body{font-family:Arial;max-width:900px;margin:50px auto;padding:20px;}
form{margin:20px 0;}input,textarea{width:100%;padding:10px;box-sizing:border-box;}
button{padding:10px 20px;background:#007bff;color:white;border:none;cursor:pointer;}
li{padding:10px;border:1px solid #ddd;margin:10px 0;}</style>
</head>
<body>
<h1>Career CMS Dashboard</h1>
<p><a href="/logout">Logout</a></p>

<h3>Create Tenant (Custom Domain)</h3>
<form method="post" action="/dashboard/create">
  <input name="base_domain" placeholder="companyname.com" required>
  <input name="subdomain" placeholder="career" value="career" required>
  <textarea name="content" placeholder="Company intro..." rows="3"></textarea>
  <textarea name="jobs" placeholder='[{"title":"Job 1","desc":"Description"}] ' rows="5"></textarea>
  <button>Create & Register with Subdomain</button>
</form>

<h3>Your Tenants</h3>
<ul>${tenantList}</ul>
</body></html>
    `);
  });
});

app.post('/dashboard/create', requireLogin, async (req, res) => {
  const userId = req.session.userId;
  const { base_domain, content, jobs, subdomain = 'career' } = req.body;
  try {
    // 1. Create tenant (customer domain) if not exists
    await axios.post(`${SUBDOMAIN_URL}/api/v1/create-tenant`, {
      base_domain
    }, {
      headers: { 'X-API-Key': SUBDOMAIN_API_KEY }
    });
    console.log(`✅ Tenant created: ${base_domain}`);

    // 2. Register subdomain proxy
    await axios.post(`${SUBDOMAIN_URL}/api/v1/register-subdomain`, {
      subdomain,
      base_domain,
      target_url: `${CMS_URL}/career`
    }, {
      headers: { 'X-API-Key': SUBDOMAIN_API_KEY }
    });
    console.log(`✅ Proxy registered: ${subdomain}.${base_domain}`);
  } catch (err) {
    console.error(`❌ Subdomain API error: ${err.message}`);
    // Continue - tenant saved anyway
  }
  // Always save tenant
  db.run(
    'INSERT INTO tenants (user_id, base_domain, subdomain, content, jobs) VALUES (?, ?, ?, ?, ?)',
    [userId, base_domain, subdomain, content, jobs],
    () => res.redirect('/dashboard')
  );
});

app.get('/dashboard/edit/:id', requireLogin, (req, res) => {
  const userId = req.session.userId;
  const tenantId = req.params.id;
  db.get('SELECT * FROM tenants WHERE id = ? AND user_id = ?', [tenantId, userId], (err, tenant) => {
    if (!tenant) return res.send('Not found');
    res.send(`
<!DOCTYPE html>
<html><body>
<h1>Edit Tenant</h1>
<form method="post" action="/dashboard/update/${tenantId}">
  <textarea name="content" rows="5">${tenant.content}</textarea><br>
  <textarea name="jobs" rows="10">${tenant.jobs}</textarea><br>
  <button>Update</button>
</form>
<a href="/dashboard">Back</a>
</body></html>
    `);
  });
});

app.post('/dashboard/update/:id', requireLogin, (req, res) => {
  const userId = req.session.userId;
  const tenantId = req.params.id;
  const { content, jobs } = req.body;
  db.run(
    'UPDATE tenants SET content = ?, jobs = ? WHERE id = ? AND user_id = ?',
    [content, jobs, tenantId, userId],
    () => res.redirect('/dashboard')
  );
});

app.post('/dashboard/delete/:id', requireLogin, (req, res) => {
  const userId = req.session.userId;
  const tenantId = req.params.id;
  db.run('DELETE FROM tenants WHERE id = ? AND user_id = ?', [tenantId, userId], () => res.redirect('/dashboard'));
});

// Career Page (Multi-Tenant - Host Detection)
app.get(['/career', '/career/*'], (req, res) => {
  const host = req.headers.host || '';
  console.log(`📍 Career page request - Host: ${host}`);
  const parts = host.toLowerCase().split('.');
  const subdomain = parts[0];
  const baseDomain = parts.slice(1).join('.');
  console.log(`📍 Parsed - subdomain: ${subdomain}, baseDomain: ${baseDomain}`);

  db.get(
    'SELECT * FROM tenants WHERE base_domain = ?',
    [baseDomain],
    (err, tenant) => {
      if (!tenant) {
        return res.send(`
<!DOCTYPE html>
<html><head><title>Career Page Not Found</title></head>
<body><h1>Career page for ${baseDomain} not configured</h1>
<p>Configure at <a href="/login">Career CMS</a></p></body></html>
        `);
      }

      let jobs = [];
      try { jobs = JSON.parse(tenant.jobs || '[]'); } catch {}

      const jobsHtml = jobs.map(job => `
        <div style="border:1px solid #ddd;padding:20px;margin:20px 0;">
          <h3>${job.title}</h3>
          <p>${job.desc}</p>
        </div>
      `).join('');

      res.send(`
<!DOCTYPE html>
<html><head><title>Careers at ${baseDomain}</title>
<style>body{font-family:Arial;max-width:800px;margin:0 auto;padding:20px;}</style>
</head>
<body>
<h1>Careers at ${baseDomain}</h1>
<div>${tenant.content}</div>
<h2>Open Positions</h2>
${jobsHtml || '<p>No jobs posted yet.</p>'}
<footer>Powered by Career CMS</footer>
</body></html>
      `);
    }
  );
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Career CMS running on http://localhost:${PORT}`);
  console.log(`📝 Login: http://localhost:${PORT}/login (demo1@froste.eu/demo123)`);
  console.log(`🔑 Subdomain API Key: ${SUBDOMAIN_API_KEY}`);
  console.log(`🌐 Career pages: https://career.customerdomain.com (after DNS CNAME setup)`);
});