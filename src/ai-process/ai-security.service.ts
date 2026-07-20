import { Inject, Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import {
  INPUT_SECURITY_STRATEGIES,
  InputSecurityStrategy,
} from '../ai-security/strategies/input-security-strategy.interface';

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
  private readonly MAX_REQUESTS_PER_MINUTE: number;
  private readonly MAX_REQUESTS_PER_HOUR: number;
  
  // Prefijos de claves Redis para evitar colisiones
  private readonly RATE_LIMIT_MIN_PREFIX = 'ai:rate_limit:min:';
  private readonly RATE_LIMIT_HOUR_PREFIX = 'ai:rate_limit:hour:';
  
  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    @Inject(INPUT_SECURITY_STRATEGIES)
    private readonly inputSecurityStrategies: InputSecurityStrategy[],
  ) {
    this.MAX_REQUESTS_PER_MINUTE =
      this.configService.get<number>('AI_RATE_LIMIT_PER_MIN') || 100;
    this.MAX_REQUESTS_PER_HOUR =
      this.configService.get<number>('AI_RATE_LIMIT_PER_HOUR') || 1000;

    this.logger.log(
      `AiSecurityService configurado: strategies=${this.inputSecurityStrategies.length}, RateLimitMin=${this.MAX_REQUESTS_PER_MINUTE}, RateLimitHour=${this.MAX_REQUESTS_PER_HOUR}`,
    );
  }

  /**
   * Valida y sanitiza la entrada del usuario.
   * Retorna la entrada limpia o lanza BadRequestException si es sospechosa.
   */
  validateAndSanitizeInput(input: string, clientId?: string): string {
    if (input === null || input === undefined || typeof input !== 'string') {
      throw new BadRequestException('Input inválido o vacío');
    }

    const trimmed = input.trim();

    for (const strategy of this.inputSecurityStrategies) {
      strategy.validate(trimmed, clientId);
    }

    return trimmed;
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
  validateAiResponse(response: unknown, _originalInput?: string): boolean {
    if (!response || typeof response !== 'object') {
      this.logger.warn('Respuesta AI inválida: se esperaba un objeto');
      return false;
    }

    const aiResponse = response as Record<string, unknown>;

    // Verificar que la respuesta tenga la estructura esperada
    if (typeof aiResponse.understood !== 'boolean') {
      this.logger.warn('Respuesta AI sin campo "understood" válido');
      return false;
    }

    if (
      typeof aiResponse.confidence !== 'number' ||
      aiResponse.confidence < 0 ||
      aiResponse.confidence > 1
    ) {
      this.logger.warn('Respuesta AI con "confidence" inválido');
      return false;
    }

    // Si understood es false, otros campos deben estar vacíos
    if (!aiResponse.understood) {
      const hasData =
        aiResponse.correo || 
        aiResponse.dni || 
        aiResponse.problema || 
        aiResponse.direccion ||
        aiResponse.categoria ||
        aiResponse.prioridad;
      
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
    if (aiResponse.categoria && !validCategories.includes(aiResponse.categoria as string)) {
      this.logger.warn(`Categoría inválida detectada: ${aiResponse.categoria}`);
      return false;
    }

    // Validar que la prioridad está en el conjunto permitido
    const validPriorities = ['alta', 'media', 'baja'];
    if (aiResponse.prioridad && !validPriorities.includes(aiResponse.prioridad as string)) {
      this.logger.warn(`Prioridad inválida detectada: ${aiResponse.prioridad}`);
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

}
