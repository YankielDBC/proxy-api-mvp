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

// Scored proxies (from measurement cycle)
let scoredProxies = [];
let topProxies = {
  US: [],
  MX: [],
  BR: [],
  EU: [],
  topGlobal: []
};

let lastValidation = null;
let lastMeasurement = null;

// Load proxies from data.json (original format)
function loadProxies() {
  // Use LOCAL paths only for Vercel compatibility
  const scoredPath = path.join(__dirname, 'scored-proxies.json');
  const topPath = path.join(__dirname, 'top-proxies.json');
  
  console.log('[ProxyAPI] Looking for scored at:', scoredPath);
  console.log('[ProxyAPI] Scored exists:', fs.existsSync(scoredPath));
  
  // Load scored proxies if available
  if (fs.existsSync(scoredPath)) {
    try {
      scoredProxies = JSON.parse(fs.readFileSync(scoredPath, 'utf8'));
      lastMeasurement = scoredProxies[0]?.lastChecked || null;
      console.log('[ProxyAPI] Loaded scored proxies:', scoredProxies.length);
    } catch (e) {
      console.error('[ProxyAPI] Error loading scored proxies:', e.message);
    }
  }
  
  // Load top proxies by region if available
  if (fs.existsSync(topPath)) {
    try {
      topProxies = JSON.parse(fs.readFileSync(topPath, 'utf8'));
      console.log('[ProxyAPI] Loaded top proxies by region');
    } catch (e) {
      console.error('[ProxyAPI] Error loading top proxies:', e.message);
    }
  }
  
  // Load original data
  if (fs.existsSync(dataPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      
      // Convert from data.json format to our internal format
      proxyPool.http = data.map(p => ({
        ip: p.ip,
        port: p.port,
        protocol: 'http',
        host: p.ip,
        url: p.proxy,
        working: true,
        score: p.score || 0,
        latencyMs: 100, // default
        geolocation: p.geolocation || { country: 'ZZ', city: 'Unknown' }
      }));
      
      lastValidation = new Date().toISOString();
      console.log('[ProxyAPI] Loaded from data.json:', proxyPool.http.length, 'proxies');
      return;
    } catch (e) {
      console.error('[ProxyAPI] Error loading data.json:', e.message);
    }
  }
  
  // Fallback: load validated-proxies.json if exists
  const validatedPath = path.join(process.cwd(), 'validated-proxies.json');
  if (fs.existsSync(validatedPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(validatedPath, 'utf-8'));
      proxyPool = data;
      lastValidation = new Date().toISOString();
      console.log('[ProxyAPI] Loaded from validated-proxies.json');
      return;
    } catch (e) {
      console.error('[ProxyAPI] Error loading validated:', e.message);
    }
  }
  
  console.log('[ProxyAPI] WARNING: No proxies loaded!');
}

// Calculate Telegram SOCKS link
function getTgSocksLink(proxy) {
  return `tg://socks?server=${proxy.ip}&port=${proxy.port}`;
}

// Get optimal proxy for a country
function getOptimalProxy(country = 'US') {
  // Priority: scored proxies > top proxies by country > top global > random
  
  // 1. Try scored proxies (best)
  if (scoredProxies.length > 0) {
    const candidates = scoredProxies
      .filter(p => p.working && p.geolocation?.country === country)
      .sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));
    
    if (candidates.length > 0) {
      return candidates[0];
    }
    
    // Fallback: any scored working proxy
    const anyScored = scoredProxies
      .filter(p => p.working)
      .sort((a, b) => (b.finalScore || 0) - (a.finalScore || 0));
    
    if (anyScored.length > 0) {
      return anyScored[0];
    }
  }
  
  // 2. Try top proxies by region
  const topForCountry = topProxies[country] || topProxies.US || [];
  if (topForCountry.length > 0) {
    return topForCountry[0];
  }
  
  // 3. Try top global
  if (topProxies.topGlobal && topProxies.topGlobal.length > 0) {
    return topProxies.topGlobal[0];
  }
  
  // 4. Fallback: random from proxyPool.http
  const workingProxies = proxyPool.http.filter(p => p.working);
  if (workingProxies.length > 0) {
    return workingProxies[Math.floor(Math.random() * workingProxies.length)];
  }
  
  return null;
}

// API Routes

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'ProxyFlow API',
    version: '2.0.0',
    lastValidation: lastValidation,
    lastMeasurement: lastMeasurement,
    poolSize: {
      raw: proxyPool.http.length,
      scored: scoredProxies.length,
      topGlobal: topProxies.topGlobal?.length || 0
    }
  });
});

app.get('/api/proxies', (req, res) => {
  try {
    const { protocol, limit = 10, format = 'json', country = 'US' } = req.query;
    
    let pool = scoredProxies.length > 0 ? scoredProxies : proxyPool.http;
    
    // Filter by country if specified
    if (country && country !== 'all') {
      pool = pool.filter(p => p.geolocation?.country === country);
    }
    
    // Sort by score (best first)
    pool = [...pool].sort((a, b) => (b.finalScore || b.score || 0) - (a.finalScore || a.score || 0));
    
    const limitNum = Math.min(parseInt(limit), 100);
    const selected = pool.slice(0, limitNum);
    
    if (format === 'text') {
      return res.send(selected.map(p => p.proxy || `${p.ip}:${p.port}`).join('\n'));
    }
    
    if (format === 'telegram') {
      // Return with tg:// links
      const proxiesWithLinks = selected.map(p => ({
        ...p,
        tgLink: getTgSocksLink(p)
      }));
      return res.json({
        success: true,
        count: proxiesWithLinks.length,
        proxies: proxiesWithLinks
      });
    }
    
    res.json({
      success: true,
      count: selected.length,
      proxies: selected,
      metadata: {
        totalAvailable: pool.length,
        timestamp: new Date().toISOString(),
        lastMeasurement: lastMeasurement,
        country: country
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
    lastMeasurement: lastMeasurement,
    poolSize: {
      raw: proxyPool.http.length,
      scored: scoredProxies.filter(p => p.working).length,
      byCountry: Object.fromEntries(
        Object.entries(topProxies).map(([k, v]) => [k, v.length])
      )
    }
  });
});

// NEW: Optimal deliver - get best proxy for user
app.get('/api/optimal-deliver', (req, res) => {
  const { country = 'US', format = 'json' } = req.query;
  
  const proxy = getOptimalProxy(country);
  
  if (!proxy) {
    return res.status(503).json({ 
      success: false, 
      error: 'No proxies available',
      country: country
    });
  }
  
  const response = {
    success: true,
    proxy: {
      ip: proxy.ip,
      port: proxy.port,
      host: proxy.ip,
      protocol: proxy.protocol || 'socks5',
      country: proxy.geolocation?.country || country,
      city: proxy.geolocation?.city || 'Unknown',
      score: proxy.finalScore || proxy.score || 0,
      latencyMs: proxy.latencyMs || 0,
      working: proxy.working !== false
    },
    tgLink: getTgSocksLink(proxy),
    metadata: {
      deliveredAt: new Date().toISOString(),
      country: country,
      source: scoredProxies.length > 0 ? 'scored' : 'raw'
    }
  };
  
  if (format === 'telegram') {
    return res.json(response);
  }
  
  res.json(response);
});

// NEW: Top proxies by country
app.get('/api/top', (req, res) => {
  const { country = 'US', limit = 10 } = req.query;
  
  const limitNum = Math.min(parseInt(limit), 50);
  
  let pool = scoredProxies.length > 0 ? scoredProxies : proxyPool.http;
  
  // Filter by country
  if (country && country !== 'all') {
    pool = pool.filter(p => p.geolocation?.country === country);
  }
  
  // Sort by score
  pool = [...pool]
    .filter(p => p.working !== false)
    .sort((a, b) => (b.finalScore || b.score || 0) - (a.finalScore || a.score || 0))
    .slice(0, limitNum);
  
  const proxiesWithLinks = pool.map(p => ({
    ...p,
    tgLink: getTgSocksLink(p)
  }));
  
  res.json({
    success: true,
    count: proxiesWithLinks.length,
    country: country,
    proxies: proxiesWithLinks
  });
});

// NEW: Get all available countries with counts
app.get('/api/countries', (req, res) => {
  const pool = scoredProxies.length > 0 ? scoredProxies : proxyPool.http;
  
  const countryCounts = {};
  pool.forEach(p => {
    const c = p.geolocation?.country || 'ZZ';
    countryCounts[c] = (countryCounts[c] || 0) + 1;
  });
  
  const countries = Object.keys(countryCounts)
    .map(c => ({ code: c, count: countryCounts[c] }))
    .sort((a, b) => b.count - a.count);
  
  res.json({
    count: countries.length,
    countries: countries
  });
});

// NEW: Get stats for dashboard
app.get('/api/stats', (req, res) => {
  const pool = scoredProxies.length > 0 ? scoredProxies : proxyPool.http;
  const working = pool.filter(p => p.working);
  
  const stats = {
    total: pool.length,
    working: working.length,
    byCountry: {},
    latency: {
      avg: 0,
      min: 0,
      max: 0
    },
    topCountries: []
  };
  
  if (working.length > 0) {
    const latencies = working.map(p => p.latencyMs || 0).filter(l => l > 0 && l < 9999);
    stats.latency.avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    stats.latency.min = Math.min(...latencies);
    stats.latency.max = Math.max(...latencies);
    
    // Country counts
    working.forEach(p => {
      const c = p.geolocation?.country || 'ZZ';
      stats.byCountry[c] = (stats.byCountry[c] || 0) + 1;
    });
    
    // Top countries
    stats.topCountries = Object.entries(stats.byCountry)
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }
  
  res.json({
    success: true,
    stats: stats,
    lastMeasurement: lastMeasurement
  });
});

// Legacy: deliver endpoint (uses optimal now)
app.get('/api/deliver', (req, res) => {
  const { country = 'US' } = req.query;
  const proxy = getOptimalProxy(country);
  
  if (!proxy) {
    return res.status(503).json({ success: false, error: 'No proxies available' });
  }
  
  res.json({
    success: true,
    proxy: {
      ...proxy,
      tgLink: getTgSocksLink(proxy)
    }
  });
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
    console.log(`[ProxyAPI] ProxyFlow API v2.0 running on http://localhost:${PORT}`);
    console.log(`[ProxyAPI] Raw proxies: ${proxyPool.http.length}`);
    console.log(`[ProxyAPI] Scored proxies: ${scoredProxies.length}`);
  });
}