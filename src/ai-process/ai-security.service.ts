import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';

/**
 * Servicio de seguridad para el agente de IA.
 * Protege contra:
 * - Prompt injection / jailbreaking
 * - Ataques de denegación de servicio (DoS)
 * - Intentos de manipulación del modelo
 *
 * Usa Redis para almacenar logs de rate limiting (distribuido y persistente).
 */
@Injectable()
export class AiSecurityService {
  private readonly logger = new Logger(AiSecurityService.name);
  
  // Configuración de límites (desde env variables o defaults)
  private readonly MAX_INPUT_LENGTH: number;
  private readonly MAX_REQUESTS_PER_MINUTE: number;
  private readonly MAX_REQUESTS_PER_HOUR: number;
  
  // Prefijos de claves Redis para evitar colisiones
  private readonly RATE_LIMIT_MIN_PREFIX = 'ai:rate_limit:min:';
  private readonly RATE_LIMIT_HOUR_PREFIX = 'ai:rate_limit:hour:';
  
  // Palabras clave y patrones sospechosos que sugieren prompt injection
  private readonly INJECTION_PATTERNS = [
    /ignore\s+(all|previous|instructions|system|rules)/gi,
    /ignora/gi, // "ignora instrucciones", "ignora las reglas", etc
    /olvid[ae]/gi, // "olvida todo", "olvide las reglas", etc
    /forget\s+(all|previous|instructions|system|rules)/gi,
    /system\s*:\s*/gi,
    /you\s+are\s+now/gi,
    /act\s+as\s+(?!un\s+asistente)/gi,
    /actúa\s+como/gi,
    /pretend\s+(?!to\s+be)/gi,
    /role\s*play/gi,
    /jailbreak/gi,
    /bypass/gi,
    /override/gi,
    /administrator\s+mode/gi,
    /modo\s+administrador/gi,
    /developer\s+mode/gi,
    /DAN\s+\d+/gi,
    /\[SYSTEM_OVERRIDE\]/gi,
    /\[UNRESTRICTED\]/gi,
  ];
  
  // Palabras clave que indican que es realmente un reclamo válido
  private readonly CLAIM_KEYWORDS = [
    'reclamo', 'problema', 'fuga', 'corte', 'rotura', 'sin agua', 'sin luz',
    'bache', 'basura', 'luminaria', 'poste', 'semáforo', 'árbol', 'gas',
    'inundación', 'cloaca', 'dirección', 'ubicación', 'calle', 'avenida',
    'teléfono', 'email', 'correo', 'dni', 'cédula', 'emergencia', 'urgente',
    'solicito', 'request', 'reportar', 'denunciar'
  ];
  
  // Palabras clave que sugieren intento de obtener información sensible
  private readonly SENSITIVE_REQUESTS = [
    'contraseña', 'password', 'clave', 'api_key', 'token', 'secret',
    'base de datos', 'database', 'credential', 'config', 'configuración',
    'usuario', 'admin', 'administrador', 'directorio', 'archivo',
    'hacker', 'exploit', 'vulnerabilidad', 'sql injection', 'xss'
  ];

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    this.MAX_INPUT_LENGTH =
      this.configService.get<number>('AI_MAX_INPUT_LENGTH') || 2000;
    this.MAX_REQUESTS_PER_MINUTE =
      this.configService.get<number>('AI_RATE_LIMIT_PER_MIN') || 100;
    this.MAX_REQUESTS_PER_HOUR =
      this.configService.get<number>('AI_RATE_LIMIT_PER_HOUR') || 1000;

    this.logger.log(
      `AiSecurityService configurado: MaxInput=${this.MAX_INPUT_LENGTH}, RateLimitMin=${this.MAX_REQUESTS_PER_MINUTE}, RateLimitHour=${this.MAX_REQUESTS_PER_HOUR}`,
    );
  }

  /**
   * Valida y sanitiza la entrada del usuario.
   * Retorna la entrada limpia o lanza BadRequestException si es sospechosa.
   */
  validateAndSanitizeInput(input: string, clientId?: string): string {
    if (!input || typeof input !== 'string') {
      throw new BadRequestException('Input inválido o vacío');
    }

    const trimmed = input.trim();

    // Verificar longitud
    if (trimmed.length > this.MAX_INPUT_LENGTH) {
      this.logger.warn(
        `Input rechazado por longitud excesiva: ${trimmed.length} caracteres (máximo: ${this.MAX_INPUT_LENGTH}) | clientId=${clientId}`,
      );
      throw new BadRequestException(
        `Mensaje demasiado largo. Máximo ${this.MAX_INPUT_LENGTH} caracteres.`,
      );
    }

    // Verificar patrones de inyección
    if (this.detectInjectionPatterns(trimmed)) {
      this.logger.warn(
        `Intento de prompt injection detectado: "${trimmed.substring(0, 100)}" | clientId=${clientId}`,
      );
      throw new BadRequestException(
        'Solicitud rechazada por validación de seguridad.',
      );
    }

    // Verificar intentos de acceso a información sensible
    if (this.detectSensitiveAccess(trimmed)) {
      this.logger.warn(
        `Intento de acceso a información sensible: "${trimmed.substring(0, 100)}" | clientId=${clientId}`,
      );
      throw new BadRequestException(
        'Solicitud rechazada por validación de seguridad.',
      );
    }

    // Verificar que haya mínimalmente keywords de reclamos válidos
    // (permisivo: solo 1 palabra clave o 20+ caracteres)
    if (
      trimmed.length > 20 ||
      this.hasClaimKeywords(trimmed)
    ) {
      return trimmed;
    }

    // Si no tiene palabras clave y es muy corto, rechazar
    this.logger.warn(
      `Input demasiado corto sin keywords de reclamo: "${trimmed}" | clientId=${clientId}`,
    );
    throw new BadRequestException(
      'Por favor describe tu reclamo con más detalle.',
    );
  }

  /**
   * Verifica rate limiting por cliente usando Redis.
   * Retorna true si está dentro de los límites, false si excede.
   */
  async checkRateLimit(clientId: string): Promise<boolean> {
    const client = this.redisService.getClient();

    try {
      // Verificar límite de 1 minuto
      const minKey = this.RATE_LIMIT_MIN_PREFIX + clientId;
      const minCount = await client.incr(minKey);

      // Si es la primera vez que ve este cliente en este minuto, configurar TTL
      if (minCount === 1) {
        await client.expire(minKey, 60);
      }

      if (minCount > this.MAX_REQUESTS_PER_MINUTE) {
        this.logger.warn(
          `Rate limit por minuto excedido: clientId=${clientId} | requests=${minCount} | max=${this.MAX_REQUESTS_PER_MINUTE}`,
        );
        return false;
      }

      // Verificar límite de 1 hora
      const hourKey = this.RATE_LIMIT_HOUR_PREFIX + clientId;
      const hourCount = await client.incr(hourKey);

      // Si es la primera vez que ve este cliente en esta hora, configurar TTL
      if (hourCount === 1) {
        await client.expire(hourKey, 3600);
      }

      if (hourCount > this.MAX_REQUESTS_PER_HOUR) {
        this.logger.warn(
          `Rate limit por hora excedido: clientId=${clientId} | requests=${hourCount} | max=${this.MAX_REQUESTS_PER_HOUR}`,
        );
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error(
        `Error verificando rate limit en Redis: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Si Redis falla, permitir pero loguear el error
      this.logger.warn(`Rate limit bypass debido a error de Redis para cliente: ${clientId}`);
      return true;
    }
  }

  /**
   * Valida la respuesta de OpenAI para asegurar que es coherente
   * y no contiene respuestas a prompts inyectados.
   */
  validateAiResponse(
    response: Record<string, unknown>,
    originalInput: string,
  ): boolean {
    // Verificar que la respuesta tenga la estructura esperada
    if (typeof response.understood !== 'boolean') {
      this.logger.warn('Respuesta AI sin campo "understood" válido');
      return false;
    }

    if (
      typeof response.confidence !== 'number' ||
      response.confidence < 0 ||
      response.confidence > 1
    ) {
      this.logger.warn('Respuesta AI con "confidence" inválido');
      return false;
    }

    // Si understood es false, otros campos deben estar vacíos
    if (!response.understood) {
      const hasData =
        response.correo || 
        response.dni || 
        response.problema || 
        response.direccion ||
        response.categoria ||
        response.prioridad;
      
      if (hasData) {
        this.logger.warn(
          'Respuesta AI inconsistente: understood=false pero tiene datos',
        );
        return false;
      }
    }

    // Validar que la categoría está en el conjunto permitido
    const validCategories = [
      'agua_y_cloacas', 'alumbrado', 'baches_y_pavimento', 'arbolado',
      'residuos', 'electricidad', 'gas', 'transporte', 'infraestructura',
      'otros'
    ];
    if (response.categoria && !validCategories.includes(response.categoria as string)) {
      this.logger.warn(`Categoría inválida detectada: ${response.categoria}`);
      return false;
    }

    // Validar que la prioridad está en el conjunto permitido
    const validPriorities = ['alta', 'media', 'baja'];
    if (response.prioridad && !validPriorities.includes(response.prioridad as string)) {
      this.logger.warn(`Prioridad inválida detectada: ${response.prioridad}`);
      return false;
    }

    return true;
  }

  /**
   * Obtiene estadísticas de requests desde Redis (para monitoreo)
   */
  async getStats() {
    const client = this.redisService.getClient();

    try {
      // Obtener todas las claves de rate limit
      const minKeys = await client.keys(this.RATE_LIMIT_MIN_PREFIX + '*');
      const hourKeys = await client.keys(this.RATE_LIMIT_HOUR_PREFIX + '*');
      
      // Extraer clientes únicos
      const clientsMin = new Set(minKeys.map(k => k.replace(this.RATE_LIMIT_MIN_PREFIX, '')));
      const clientsHour = new Set(hourKeys.map(k => k.replace(this.RATE_LIMIT_HOUR_PREFIX, '')));
      const allClients = new Set([...clientsMin, ...clientsHour]);

      let totalRequests = 0;

      // Contar total de requests por hora (más preciso para el último período)
      for (const key of hourKeys) {
        const count = await client.get(key);
        if (count) {
          totalRequests += parseInt(count, 10);
        }
      }

      return {
        totalClients: allClients.size,
        totalRequests,
        timestamp: new Date().toISOString(),
        redis: {
          keysPerMinute: minKeys.length,
          keysPerHour: hourKeys.length,
        },
      };
    } catch (error) {
      this.logger.error(
        `Error obteniendo estadísticas: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        totalClients: 0,
        totalRequests: 0,
        timestamp: new Date().toISOString(),
        error: 'Error obteniendo datos de Redis',
      };
    }
  }

  /**
   * Limpia las claves antiguas de rate limit (ejecutar periódicamente con @Cron)
   * Nota: Redis ya maneja limpieza automática con TTL, pero esto es para auditoría.
   */
  async cleanupOldLogs(): Promise<void> {
    const client = this.redisService.getClient();

    try {
      // Redis limpia automáticamente las claves con TTL expirado
      const minKeys = await client.keys(this.RATE_LIMIT_MIN_PREFIX + '*');
      const hourKeys = await client.keys(this.RATE_LIMIT_HOUR_PREFIX + '*');
      
      this.logger.debug(
        `Cleanup: ${minKeys.length} claves por minuto, ${hourKeys.length} claves por hora en Redis`,
      );
    } catch (error) {
      this.logger.error(
        `Error durante cleanup: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Detecta patrones conocidos de inyección de prompts
   */
  private detectInjectionPatterns(input: string): boolean {
    for (const pattern of this.INJECTION_PATTERNS) {
      if (pattern.test(input)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detecta intentos de acceso a información sensible
   */
  private detectSensitiveAccess(input: string): boolean {
    const lowerInput = input.toLowerCase();
    for (const keyword of this.SENSITIVE_REQUESTS) {
      if (lowerInput.includes(keyword)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Verifica si el input contiene palabras clave de reclamos válidos
   */
  private hasClaimKeywords(input: string): boolean {
    const lowerInput = input.toLowerCase();
    for (const keyword of this.CLAIM_KEYWORDS) {
      if (lowerInput.includes(keyword)) {
        return true;
      }
    }
    return false;
  }
}
