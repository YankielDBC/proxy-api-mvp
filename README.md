# ProxyFlow API

Proxy delivery service for Telegram bot integration.

## Endpoints

- `GET /` - Health check
- `GET /api/proxies` - Get proxies (query: protocol, limit, format)
- `GET /api/status` - Service status
- `GET /api/deliver` - Get one random working proxy
- `GET /api/countries` - List available countries
