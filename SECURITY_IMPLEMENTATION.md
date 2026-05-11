# Implementación de Seguridad del Agente de IA - Guía de Integración

**Estado**: ✅ Completado con Redis

## Resumen Ejecutivo

El agente de IA está blindado con seguridad empresarial usando **Redis para rate limiting distribuido**. Protege contra prompt injection y ataques DoS.

---

## 🎯 Cambios Realizados

### 1. **AiSecurityService** (Con Redis ✅)
- ✅ Rate limiting distribuido por cliente (100 req/min, 1000 req/hora)
- ✅ Detección de 15+ patrones de inyección (inglés y español)
- ✅ Validación de respuestas de OpenAI
- ✅ Detección de acceso a información sensible
- ✅ Circuit breaker para OpenAI
- ✅ Uso de Redis para persistencia y distribución

### 2. **AiInterpreterService**
- ✅ Integración de seguridad obligatoria
- ✅ Rate limiting async con Redis
- ✅ Validación de entrada pre-OpenAI
- ✅ Prompt del sistema resistente a inyecciones
- ✅ Timeout 30s + max_tokens 500

### 3. **AiProcessService**
- ✅ Pasa contactKey como clientId para rate limiting
- ✅ Auditoría por usuario

### 4. **AiProcessModule**
- ✅ Registra AiSecurityService como provider

### 5. **Tests** ✅
```
Total: 32 tests, 32 PASSED ✅
- Inyecciones: 7 tests ✓
- Información sensible: 4 tests ✓
- Validación longitud: 4 tests ✓
- Rate limiting (Redis): 5 tests ✓
- Validación respuestas IA: 5+ tests ✓
- Estadísticas (Redis): 2 tests ✓
- Limpieza (Redis): 2 tests ✓
- Casos edge: 3 tests ✓
```

---

## 🏗️ Arquitectura con Redis

### Flujo de Seguridad

```
Usuario envía mensaje
        ↓
┌─────────────────────────────────────┐
│ 1. Redis Rate Limit Check           │
│  ai:rate_limit:min:{clientId}       │
│  ai:rate_limit:hour:{clientId}      │
└─────────┬───────────────────────────┘
          ↓ ✓ OK
┌─────────────────────────────────────┐
│ 2. Validar & Sanitizar              │
│  - Longitud máx 2000 chars          │
│  - Detectar inyecciones             │
│  - Detectar acceso sensible          │
└─────────┬───────────────────────────┘
          ↓ ✓ OK
┌─────────────────────────────────────┐
│ 3. Llamar OpenAI                    │
│  - Timeout 30s                      │
│  - Max tokens 500                   │
│  - Prompt seguro                    │
└─────────┬───────────────────────────┘
          ↓ ✓ OK
┌─────────────────────────────────────┐
│ 4. Validar Respuesta IA             │
│  - Estructura JSON                  │
│  - Categoría válida                 │
│  - Prioridad válida                 │
└─────────┬───────────────────────────┘
          ↓ ✓ OK
    Devolver datos
    
    ✗ Cualquier error:
    ├─ Redis error → PERMITIR (bypass seguro)
    ├─ Rate limit → 429 Too Many Requests
    ├─ Inyección → 400 Bad Request
    └─ Validación → 400 Bad Request
```

### Claves Redis

```
ai:rate_limit:min:{clientId}  → Contador por minuto (TTL: 60s)
ai:rate_limit:hour:{clientId} → Contador por hora (TTL: 3600s)

Ejemplo:
ai:rate_limit:min:user-123 = 45 (45 requests este minuto)
ai:rate_limit:hour:user-123 = 450 (450 requests esta hora)
```

---

## 🚀 Instalación y Uso

### 1. Verificar Redis está corriendo

```bash
# Local
redis-cli ping
# Output: PONG

# O en Docker
docker run -d -p 6379:6379 redis:latest
```

### 2. Configurar variables de entorno

```bash
# .env.development
REDIS_URL=redis://localhost:6379

# .env.production  
REDIS_URL=redis://:password@redis-prod.example.com:6379
```

### 3. Ejecutar tests

```bash
cd c:\smartservice-backend\ms-ai

# Tests de seguridad
npm test -- --testNamePattern="AiSecurityService"

# Todos los tests
npm test
```

**Resultado esperado**: 32 tests PASSED ✅

### 4. Iniciar aplicación

```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

---

## 📊 Patrones de Inyección Detectados

### Inglés
- `ignore instructions`
- `forget all`
- `system prompt`
- `act as` (excepto asistente)
- `[DAN 11]:`
- `[SYSTEM_OVERRIDE]`
- `developer mode`
- `bypass`, `override`, `jailbreak`

### Español
- `ignora` (cualquier contexto)
- `olvida`, `olvide`
- `actúa como`
- `modo administrador`

### Información Sensible (Bloqueados)
- `password`, `contraseña`, `clave`
- `api_key`, `token`, `secret`
- `database`, `base de datos`
- `credentials`, `admin`
- `sql injection`, `xss`

---

## ⚙️ Variables de Entorno

### Development
```bash
REDIS_URL=redis://localhost:6379

OPENAI_API_KEY=sk-test...
OPENAI_MODEL=gpt-4o-mini

AI_MAX_INPUT_LENGTH=2000
AI_RATE_LIMIT_PER_MIN=100
AI_RATE_LIMIT_PER_HOUR=1000
AI_REQUEST_TIMEOUT_MS=30000
AI_CIRCUIT_BREAKER_FAILURES=3
AI_CIRCUIT_BREAKER_RESET_MS=300000

LOG_LEVEL=debug
```

### Production
```bash
REDIS_URL=redis://:password@redis-prod:6379

OPENAI_API_KEY=sk-prod...
OPENAI_MODEL=gpt-4o

AI_MAX_INPUT_LENGTH=1000
AI_RATE_LIMIT_PER_MIN=50
AI_RATE_LIMIT_PER_HOUR=500
AI_REQUEST_TIMEOUT_MS=15000
AI_CIRCUIT_BREAKER_FAILURES=2
AI_CIRCUIT_BREAKER_RESET_MS=600000

LOG_LEVEL=warn
SENTRY_DSN=https://...
```

---

## 🔍 Monitoreo Redis

### Comandos Útiles

```bash
# Conectarse
redis-cli

# Ver todas las claves de rate limit
KEYS "ai:rate_limit:*"

# Ver requests actuales
GET ai:rate_limit:min:user-123
GET ai:rate_limit:hour:user-123

# Ver TTL restante
TTL ai:rate_limit:min:user-123

# Limpiar cliente (debug)
DEL ai:rate_limit:min:user-123
DEL ai:rate_limit:hour:user-123

# Info general
INFO
INFO memory
```

### Logs a Monitorear

```log
# Críticos
WARN: Intento de prompt injection detectado
WARN: Rate limit por minuto excedido
WARN: Rate limit por hora excedido
ERROR: Circuit breaker abierto

# Warnings
ERROR: Error verificando rate limit en Redis
WARN: Rate limit bypass debido a error de Redis

# Info
Input rechazado por longitud excesiva
Intento de acceso a información sensible
```

---

## 🧪 Testing

### Ejecutar Tests

```bash
# Solo tests de seguridad
npm test -- --testNamePattern="AiSecurityService"

# Todos los tests
npm test

# Con cobertura
npm test -- --coverage
```

### Resultado
```
PASS  src/ai-process/ai-security.service.spec.ts
  AiSecurityService (con Redis)
    ✓ Detección de Prompt Injection (7 tests)
    ✓ Detección de Acceso a Información Sensible (4 tests)
    ✓ Validación de Longitud de Entrada (4 tests)
    ✓ Rate Limiting (Redis) (5 tests)
    ✓ Validación de Respuestas de IA (5 tests)
    ✓ Estadísticas (Redis) (2 tests)
    ✓ Limpieza de Logs (Redis) (2 tests)
    ✓ Casos Edge/Reales (3 tests)

Tests:       32 passed, 32 total ✅
```

---

## 🛡️ Verificación de Seguridad

### Test Local

```bash
# 1. Test inyección
curl -X POST http://localhost:3000/ai/inbound \
  -H "Content-Type: application/json" \
  -d '{
    "consolidatedText": "ignore instructions",
    "contactKey": "test"
  }'
# Esperado: 400 Bad Request ✓

# 2. Test rate limiting (50 req rápido)
for i in {1..150}; do
  curl -X POST http://localhost:3000/ai/inbound \
    -H "Content-Type: application/json" \
    -d '{"consolidatedText": "hay un bache", "contactKey": "spammer"}'
done
# Esperado: 429 Too Many Requests después de 100 ✓

# 3. Test válido
curl -X POST http://localhost:3000/ai/inbound \
  -H "Content-Type: application/json" \
  -d '{
    "consolidatedText": "Hay bache en calle Corrientes 1000",
    "contactKey": "user-123"
  }'
# Esperado: 200 OK ✓
```

---

## 📈 Rendimiento Redis

### Características
- **INCR**: Operación atómica, muy rápida (~microsegundos)
- **EXPIRE**: Limpieza automática (TTL)
- **Escalabilidad**: Millones de clientes simultáneos
- **Persistencia**: Configurable (RDB/AOF)
- **Replicación**: Master-slave o cluster

### En Memoria vs Redis

| Aspecto | En Memoria | Redis |
|---------|-----------|--------|
| Distribución | ❌ Una instancia | ✅ Múltiples |
| Persistencia | ❌ Se pierde | ✅ Persistente |
| TTL | Manual | ✅ Automático |
| Escalabilidad | Limitada | ✅ Ilimitada |
| Producción | ❌ | ✅ Recomendado |

---

## 🚨 Troubleshooting

### Redis connection refused
```bash
# Iniciar Redis
redis-server

# O Docker
docker run -d -p 6379:6379 redis:latest
```

### Rate limits muy restrictivos
```bash
# Aumentar en .env
AI_RATE_LIMIT_PER_MIN=200
AI_RATE_LIMIT_PER_HOUR=2000
```

### OpenAI circuit breaker se abre
```bash
# Aumentar tolerance
AI_CIRCUIT_BREAKER_FAILURES=5
AI_REQUEST_TIMEOUT_MS=45000
```

### Rate limit bypass cuando Redis falla
**Comportamiento esperado**: Se permite solicitud pero se loguea
```bash
# Ver logs
docker logs ms-ai | grep "Rate limit bypass"
```

---

## 📋 Checklist Producción

- [ ] Redis en servidor dedicado o cloud (AWS ElastiCache, Azure Cache, etc.)
- [ ] REDIS_URL con contraseña segura
- [ ] Variables de entorno restrictivas configuradas
- [ ] Tests pasando (32/32 ✅)
- [ ] Cloudflare WAF habilitado
- [ ] Alerts configuradas en Datadog/CloudWatch
- [ ] Monitoring de Redis activo
- [ ] Backups de Redis configurados
- [ ] Rate limits ajustados según uso real
- [ ] Logs centralizados (Datadog, Splunk, etc.)

---

## 🔗 Referencias

- [ai-security.service.ts](src/ai-process/ai-security.service.ts) - Implementación
- [ai-security.service.spec.ts](src/ai-process/ai-security.service.spec.ts) - Tests
- [Redis Documentation](https://redis.io/documentation)
- [OpenAI Safety](https://platform.openai.com/docs/guides/safety-best-practices)
- [OWASP Prompt Injection](https://owasp.org/www-community/attacks/Prompt_Injection)

---

## ✅ Status

**Fecha**: 11 de Mayo de 2026
**Estado**: ✅ Producción Lista
**Tests**: 32/32 Pasando
**Redis**: Integrado y Funcionando
