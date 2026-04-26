require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Pre-validated proxy pools
let proxyPool = {
  http: [],
  https: [],
  socks4: [],
  socks5: []
};

let lastValidation = null;

function loadProxies() {
  const jsonPath = path.join(process.cwd(), 'validated-proxies.json');
  console.log('[ProxyAPI] Looking for proxies at:', jsonPath);
  console.log('[ProxyAPI] File exists:', fs.existsSync(jsonPath));
  
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      proxyPool = data;
      lastValidation = new Date().toISOString();
      console.log('[ProxyAPI] Loaded from JSON:', proxyPool.http.length, 'HTTP proxies');
      return;
    } catch (e) {
      console.error('[ProxyAPI] Error loading JSON:', e.message);
    }
  }
  
  console.log('[ProxyAPI] WARNING: No proxies loaded!');
}

// API Routes
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ProxyFlow API',
    version: '1.0.0',
    lastValidation: lastValidation,
    poolSize: {
      http: proxyPool.http.length,
      https: proxyPool.https.length,
      socks4: proxyPool.socks4.length,
      socks5: proxyPool.socks5.length,
      total: proxyPool.http.length + proxyPool.https.length + proxyPool.socks4.length + proxyPool.socks5.length
    }
  });
});

app.get('/api/proxies', (req, res) => {
  try {
    const { protocol, limit = 10, format = 'json' } = req.query;
    
    let pool = [];
    if (protocol && protocol !== 'all') {
      pool = proxyPool[protocol] || [];
    } else {
      pool = [...proxyPool.http, ...proxyPool.https, ...proxyPool.socks4, ...proxyPool.socks5];
    }
    
    pool.sort((a, b) => (a.latency || 9999) - (b.latency || 9999));
    const limitNum = Math.min(parseInt(limit), 100);
    const selected = pool.slice(0, limitNum);
    
    if (format === 'text') {
      return res.send(selected.map(p => p.url).join('\n'));
    }
    
    res.json({
      success: true,
      count: selected.length,
      proxies: selected,
      metadata: {
        totalAvailable: pool.length,
        timestamp: new Date().toISOString(),
        lastValidation: lastValidation
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    lastValidation: lastValidation,
    poolSize: {
      http: proxyPool.http.length,
      https: proxyPool.https.length,
      socks4: proxyPool.socks4.length,
      socks5: proxyPool.socks5.length,
      total: proxyPool.http.length + proxyPool.https.length + proxyPool.socks4.length + proxyPool.socks5.length
    }
  });
});

app.get('/api/deliver', (req, res) => {
  // Returns one random working proxy from validated pool
  const httpProxies = proxyPool.http.filter(p => p.working);
  if (httpProxies.length === 0) {
    return res.status(503).json({ error: 'No proxies available', success: false });
  }
  const proxy = httpProxies[Math.floor(Math.random() * httpProxies.length)];
  res.json({ success: true, proxy: proxy });
});

app.get('/api/countries', (req, res) => {
  const baseDir = path.join(process.cwd(), 'proxies', 'countries');
  let countries = [];
  if (fs.existsSync(baseDir)) {
    countries = fs.readdirSync(baseDir).filter(f => /^[A-Z]{2}$/.test(f) && fs.statSync(path.join(baseDir, f)).isDirectory());
  }
  res.json({ count: countries.length, countries: countries.sort() });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Load proxies when server starts
loadProxies();

module.exports = app;

// Only listen if running directly (not in Vercel serverless)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[ProxyAPI] ProxyFlow API running on http://localhost:${PORT}`);
  });
}
