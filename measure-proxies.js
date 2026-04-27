/**
 * Proxy Measurement & Scoring Service
 * Medir latencia, velocidad y fiabilidad de cada proxy
 */

const fs = require('fs');
const path = require('path');

// Configuración
const PROXIES_FILE = path.join(__dirname, '..', 'proxifly-free-proxy-list', 'free-proxy-list-main', 'proxies', 'all', 'data.json');
const SCORED_OUTPUT = path.join(__dirname, 'scored-proxies.json');
const TOP_PROXIES_OUTPUT = path.join(__dirname, 'top-proxies.json');
const TEST_URL = 'https://ifconfig.me';
const TEST_TIMEOUT_MS = 5000;
const BATCH_SIZE = 50;

// Pesos para scoring
const SCORING_WEIGHTS = {
  latency: 0.35,
  speed: 0.30,
  reliability: 0.25,
  efficiency: 0.10
};

// Países/regiones prioritarias para Miami
const US_REGIONS = ['US'];
const LATIN_REGIONS = ['MX', 'BR', 'CO', 'EC', 'PE', 'CL', 'AR'];

async function measureProxyLatency(proxy) {
  const startTime = Date.now();
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    
    const response = await fetch(TEST_URL, {
      method: 'GET',
      signal: controller.signal,
      // No proxy aquí - solo medimos TCP connect time directamente
    });
    
    clearTimeout(timeout);
    const latency = Date.now() - startTime;
    
    return {
      ...proxy,
      latencyMs: latency,
      working: true,
      lastChecked: new Date().toISOString()
    };
  } catch (error) {
    return {
      ...proxy,
      latencyMs: 9999,
      working: false,
      lastChecked: new Date().toISOString(),
      error: error.message
    };
  }
}

async function measureTCPConnect(ip, port) {
  const start = Date.now();
  
  try {
    // Usar net module para test de conexión TCP
    const net = require('net');
    
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(TEST_TIMEOUT_MS);
      
      socket.on('connect', () => {
        socket.destroy();
        resolve(Date.now() - start);
      });
      
      socket.on('timeout', () => {
        socket.destroy();
        resolve(9999);
      });
      
      socket.on('error', () => {
        resolve(9999);
      });
      
      socket.connect(port, ip);
    });
  } catch {
    return 9999;
  }
}

function calculateScore(proxy) {
  if (!proxy.working) return 0;
  
  // Score de latencia (menor = mejor)
  const latencyScore = Math.max(0, 100 - proxy.latencyMs);
  
  // Score de velocidad (basado en latencia también, proxy rápidos = baja latencia)
  const speedScore = Math.max(0, 100 - (proxy.latencyMs * 2));
  
  // Score de fiabilidad histórico (si existe)
  const reliabilityScore = proxy.successRate || 0.95;
  
  // Score de eficiencia
  const efficiencyScore = proxy.efficiency || 0.9;
  
  const score = (
    (latencyScore * SCORING_WEIGHTS.latency) +
    (speedScore * SCORING_WEIGHTS.speed) +
    (reliabilityScore * 100 * SCORING_WEIGHTS.reliability) +
    (efficiencyScore * 100 * SCORING_WEIGHTS.efficiency)
  );
  
  return Math.round(score * 100) / 100;
}

async function measureAllProxies() {
  console.log('[Measurement] Cargando proxies...');
  
  const rawData = fs.readFileSync(PROXIES_FILE, 'utf8');
  const proxies = JSON.parse(rawData);
  
  console.log(`[Measurement] Total proxies: ${proxies.length}`);
  
  const results = [];
  let measured = 0;
  
  // Medir en batches para no saturar
  for (let i = 0; i < proxies.length; i += BATCH_SIZE) {
    const batch = proxies.slice(i, i + BATCH_SIZE);
    
    console.log(`[Measurement] Procesando batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(proxies.length/BATCH_SIZE)}`);
    
    const batchResults = await Promise.all(
      batch.map(async (proxy) => {
        const tcpLatency = await measureTCPConnect(proxy.ip, proxy.port);
        
        return {
          ...proxy,
          latencyMs: tcpLatency,
          working: tcpLatency < 5000,
          lastChecked: new Date().toISOString(),
          score: tcpLatency < 5000 ? Math.max(0, 100 - tcpLatency) : 0
        };
      })
    );
    
    results.push(...batchResults);
    measured += batch.length;
    
    console.log(`[Measurement] Progreso: ${measured}/${proxies.length}`);
  }
  
  return results;
}

function rankProxies(proxies) {
  console.log('[Scoring] Calculando scores...');
  
  const ranked = proxies.map(proxy => ({
    ...proxy,
    finalScore: calculateScore(proxy)
  }));
  
  // Ordenar por score descending
  ranked.sort((a, b) => b.finalScore - a.finalScore);
  
  return ranked;
}

function getTopByRegion(proxies, country = 'US', limit = 10) {
  return proxies
    .filter(p => p.geolocation?.country === country && p.working && p.finalScore > 0)
    .slice(0, limit);
}

function getOptimalProxy(proxies, country = 'US') {
  const candidates = getTopByRegion(proxies, country, 5);
  
  if (candidates.length === 0) {
    // Fallback: cualquier proxy que funcione bien
    return proxies.find(p => p.working && p.finalScore > 50) || null;
  }
  
  return candidates[0];
}

async function runMeasurementCycle() {
  console.log('===========================================');
  console.log('[Measurement] Iniciando ciclo de medición');
  console.log('===========================================');
  
  const startTime = Date.now();
  
  // 1. Medir todos los proxies
  const measured = await measureAllProxies();
  
  // 2. Rankear
  const ranked = rankProxies(measured);
  
  // 3. Guardar scored proxies
  fs.writeFileSync(SCORED_OUTPUT, JSON.stringify(ranked, null, 2));
  console.log(`[Scoring] Guardado: ${SCORED_OUTPUT}`);
  
  // 4. Guardar top proxies por región
  const topByRegion = {
    US: getTopByRegion(ranked, 'US', 50),
    MX: getTopByRegion(ranked, 'MX', 20),
    BR: getTopByRegion(ranked, 'BR', 20),
    EU: ranked.filter(p => ['DE', 'FR', 'GB', 'NL'].includes(p.geolocation?.country) && p.working).slice(0, 20),
    topGlobal: ranked.filter(p => p.working).slice(0, 100)
  };
  
  fs.writeFileSync(TOP_PROXIES_OUTPUT, JSON.stringify(topByRegion, null, 2));
  console.log(`[Scoring] Guardado: ${TOP_PROXIES_OUTPUT}`);
  
  // 5. Estadísticas
  const workingCount = ranked.filter(p => p.working).length;
  const avgLatency = ranked.filter(p => p.working).reduce((sum, p) => sum + p.latencyMs, 0) / workingCount || 0;
  
  console.log('===========================================');
  console.log('[Measurement] Ciclo completado');
  console.log(`[Measurement] Proxies trabajando: ${workingCount}/${ranked.length}`);
  console.log(`[Measurement] Latencia promedio: ${Math.round(avgLatency)}ms`);
  console.log(`[Measurement] Tiempo total: ${Date.now() - startTime}ms`);
  console.log('===========================================');
  
  return {
    total: ranked.length,
    working: workingCount,
    avgLatency: Math.round(avgLatency),
    topProxy: ranked[0],
    duration: Date.now() - startTime
  };
}

// Run si se ejecuta directamente
if (require.main === module) {
  runMeasurementCycle()
    .then(stats => {
      console.log('Stats:', JSON.stringify(stats, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('Error:', err);
      process.exit(1);
    });
}

module.exports = { runMeasurementCycle, getOptimalProxy, getTopByRegion };