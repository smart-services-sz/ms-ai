# Redis Quick Reference - AiSecurityService

## 🚀 Arranque Rápido

### 1. Asegurarse que Redis está corriendo

```bash
# Verificar
redis-cli ping
# Output: PONG

# Si no está corriendo:
redis-server

# O en Docker:
docker run -d -p 6379:6379 redis:latest
```

### 2. Verificar configuración

```bash
# Archivo: .env
REDIS_URL=redis://localhost:6379

# O con contraseña:
REDIS_URL=redis://:mypassword@localhost:6379
```

### 3. Iniciar ms-ai

```bash
cd ms-ai
npm install
npm run start:dev
```

---

## 📊 Cómo Funciona el Rate Limiting

### Flujo

```
Request 1: INCR ai:rate_limit:min:user-123 → 1 (OK)
Request 2: INCR ai:rate_limit:min:user-123 → 2 (OK)
...
Request 100: INCR ai:rate_limit:min:user-123 → 100 (OK)
Request 101: INCR ai:rate_limit:min:user-123 → 101 (BLOQUEADO ❌)

Error: "Demasiadas solicitudes. Por favor intenta más tarde."
HTTP Status: 429 Too Many Requests
```

### Tiempo de expiración

```bash
# Por minuto
EXPIRE ai:rate_limit:min:user-123 60

# Por hora
EXPIRE ai:rate_limit:hour:user-123 3600

# Después del TTL, el contador vuelve a empezar
```

---

## 🔍 Monitoreo

### Comandos Redis Comunes

```bash
# Conectarse
redis-cli

# Ver todas las claves de rate limit
> KEYS "ai:rate_limit:*"
1) "ai:rate_limit:min:user-123"
2) "ai:rate_limit:hour:user-123"
3) "ai:rate_limit:min:user-456"
...

# Ver valor actual de un cliente
> GET ai:rate_limit:min:user-123
(integer) 45

# Ver TTL restante (en segundos)
> TTL ai:rate_limit:min:user-123
(integer) 25

# -1 = sin TTL, -2 = no existe

# Eliminar una clave (para resetear un cliente)
> DEL ai:rate_limit:min:user-123
(integer) 1

# Ver información de memoria
> INFO memory
# memory_human:2.5M
# used_memory_peak_human:3.2M

# Ver cantidad de claves
> DBSIZE
(integer) 156
```

---

## 📈 Métricas Importantes

### Para monitorear

```
1. Cantidad de clientes únicos:
   - KEYS "ai:rate_limit:*" | wc -l

2. Requests por minuto:
   - SUM(GET ai:rate_limit:min:*) 

3. Clientes bloqueados:
   - Ver logs: "Rate limit por minuto excedido"

4. Errores de Redis:
   - Ver logs: "Error verificando rate limit en Redis"

5. Bypass de rate limit:
   - Ver logs: "Rate limit bypass debido a error de Redis"
```

---

## ⚙️ Configuración por Ambiente

### Desarrollo
```
AI_RATE_LIMIT_PER_MIN=100
AI_RATE_LIMIT_PER_HOUR=1000
```

### Staging
```
AI_RATE_LIMIT_PER_MIN=75
AI_RATE_LIMIT_PER_HOUR=750
```

### Producción
```
AI_RATE_LIMIT_PER_MIN=50
AI_RATE_LIMIT_PER_HOUR=500
```

### Cambiar en tiempo real

1. Editar `.env`
2. Reiniciar la aplicación
3. (Opcional) Limpiar contadores viejos en Redis

---

## 🛠️ Troubleshooting

### Redis Connection Refused

```bash
# Problema: No hay conexión a Redis
# Error: "ECONNREFUSED"

# Solución 1: Iniciar Redis
redis-server

# Solución 2: Verificar URL en .env
REDIS_URL=redis://localhost:6379

# Solución 3: En Docker, verificar network
docker network inspect bridge
```

### Rate Limiting no funciona

```bash
# Problema: Solicitudes no se están limitando

# Verificar:
redis-cli KEYS "ai:rate_limit:*"
# Debe devolver claves

# Ver contador actual
redis-cli GET ai:rate_limit:min:test-user
# Debe incrementar con cada request

# Ver logs
npm run dev | grep "rate limit"
```

### Redis timeout

```bash
# Problema: Las operaciones son lentas
# Error: "Timeout connecting to Redis"

# Causa: Redis server no está respondiendo
# Solución:
redis-cli ping
# Si no devuelve PONG, reiniciar Redis

redis-server --loglevel debug
# Ver qué está pasando
```

---

## 🔄 Operaciones Normales

### Resetear contador de un cliente

```bash
redis-cli
> DEL ai:rate_limit:min:user-123
> DEL ai:rate_limit:hour:user-123
# Permitir que el cliente vuelva a hacer requests
```

### Limpiar todos los contadores

```bash
redis-cli
> FLUSHDB
# ⚠️ Cuidado: Esto limpia TODA la base de datos
```

### Monitorear en tiempo real

```bash
redis-cli
> MONITOR
# Ver todos los comandos que se ejecutan en Redis

# Presionar Ctrl+C para detener
```

---

## 📝 Logs Importantes

### Buscar en logs

```bash
# Inyecciones detectadas
docker logs ms-ai | grep "prompt injection"

# Rate limit excedido
docker logs ms-ai | grep "Rate limit.*excedido"

# Errores de Redis
docker logs ms-ai | grep "Error verificando rate limit"

# Circuit breaker OpenAI
docker logs ms-ai | grep "Circuit breaker"
```

---

## 📦 Redis Cloud (Producción)

### AWS ElastiCache

```bash
# Endpoint que Provides AWS:
REDIS_URL=redis://:password@elasticache-prod.abc123.ng.0001.use1.cache.amazonaws.com:6379

# Verificar conexión:
redis-cli -h elasticache-prod.abc123.ng.0001.use1.cache.amazonaws.com -p 6379 -a password ping
```

### Azure Cache

```bash
REDIS_URL=redis://:password@redis-prod.redis.cache.windows.net:6379
```

### Google Cloud Memorystore

```bash
REDIS_URL=redis://:password@10.0.0.3:6379
```

---

## ✅ Checklist de Producción

- [ ] Redis corriendo en servidor dedicado
- [ ] REDIS_URL con contraseña segura configurada
- [ ] Backup de Redis configurado
- [ ] Replicación Master-Slave habilitada (opcional pero recomendado)
- [ ] Monitoreo de Redis activo (CPU, memoria, conexiones)
- [ ] Alertas configuradas para:
  - [ ] Redis down
  - [ ] Memory usage > 80%
  - [ ] Conexiones máximas alcanzadas
- [ ] Rate limits ajustados según tráfico real
- [ ] Tests pasando (32/32 ✅)

---

## 🎓 Recursos

- Redis CLI: `redis-cli --help`
- Redis Docs: https://redis.io/documentation
- Redis Commands: https://redis.io/commands/
- Rate Limiting Pattern: https://redis.io/modules/redisbloom/

---

**Última actualización**: 11 de Mayo de 2026
**Versión**: 1.0 (Production Ready)
