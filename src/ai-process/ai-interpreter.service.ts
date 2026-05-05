import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export type ClaimCategoria =
  | 'agua_y_cloacas'
  | 'alumbrado'
  | 'baches_y_pavimento'
  | 'arbolado'
  | 'residuos'
  | 'electricidad'
  | 'gas'
  | 'transporte'
  | 'infraestructura'
  | 'otros';

export type ClaimPrioridad = 'alta' | 'media' | 'baja';

export type ParsedClaimData = {
  understood: boolean;
  confidence: number;
  correo?: string;
  dni?: string;
  problema?: string;
  direccion?: string;
  categoria?: ClaimCategoria;
  prioridad?: ClaimPrioridad;
};

// Servicio que encapsula la llamada a OpenAI para extraer datos estructurados
// del texto libre del ciudadano (problema, dirección, DNI, correo, categoría, prioridad).
// Si no hay OPENAI_API_KEY configurada o la llamada falla, cae al parser de regex local.
@Injectable()
export class AiInterpreterService {
  private readonly logger = new Logger(AiInterpreterService.name);
  private readonly client?: OpenAI; // Puede ser undefined si no hay API key configurada.
  private readonly model: string;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.model =
      this.configService.get<string>('OPENAI_MODEL') || 'gpt-4o-mini';

    if (apiKey) {
      this.client = new OpenAI({ apiKey });
    }
  }

  // Intenta extraer datos del reclamo usando OpenAI con JSON estructurado.
  // Si OpenAI no está disponible o el resultado no aporta campos útiles,
  // delega al parser de regex local como fallback.
  async parseClaimText(input: string): Promise<ParsedClaimData> {
    if (!this.client) {
      return this.parseWithFallback(input);
    }

    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Eres un asistente de gestion de reclamos para una empresa de servicios en Argentina. Extrae datos estructurados del texto del usuario para registrar reclamos.

CATEGORIAS DISPONIBLES (elige la mas adecuada segun el problema):
- agua_y_cloacas: fugas, roturas de cano, cloacas, inundaciones por red hidrica, sin agua
- alumbrado: falta de iluminacion, postes caidos, luminarias fundidas, alumbrado publico
- baches_y_pavimento: baches, roturas en calzada o vereda, hundimientos, pavimento
- arbolado: arbol caido, ramas peligrosas, poda necesaria, arbolado urbano
- residuos: acumulacion de basura, contenedores danados, recoleccion no realizada
- electricidad: corte de suministro electrico, cables caidos, transformadores, sin electricidad
- gas: fugas de gas, olor a gas, problemas en red de distribucion de gas
- transporte: semaforos danados, senales viales, problemas en transporte publico
- infraestructura: mobiliario urbano roto, barandas, escaleras, edificios, obra publica
- otros: cualquier problema que no encaje en las categorias anteriores

PRIORIDADES (asigna segun urgencia y riesgo):
- alta: peligro inmediato para personas (fuga de gas, arbol caido en via publica, cables en tension, inundacion activa, incendio)
- media: afecta el servicio diario pero sin peligro inmediato (sin agua, sin luz, bache grande, semaforo roto)
- baja: problema menor o no urgente (bache pequeno, luminaria fundida aislada, poda de arbol sano, vereda deteriorada)

REGLAS DE NEGOCIO:
- Un reclamo siempre debe tener categoria y prioridad asignadas si hay suficiente informacion del problema
- El correo debe ser un email valido o null
- El DNI debe tener solo numeros de 7 u 8 digitos o null
- La direccion debe incluir calle y numero si es posible
- Si el problema menciona gas, la prioridad es siempre alta
- Si hay riesgo para la vida, la prioridad es siempre alta

SALIDA REQUERIDA - Devuelve SOLO JSON valido con este esquema exacto:
{"understood": boolean, "confidence": number, "correo": string|null, "dni": string|null, "problema": string|null, "direccion": string|null, "categoria": "agua_y_cloacas"|"alumbrado"|"baches_y_pavimento"|"arbolado"|"residuos"|"electricidad"|"gas"|"transporte"|"infraestructura"|"otros"|null, "prioridad": "alta"|"media"|"baja"|null}`,
          },
          {
            role: 'user',
            content: `Texto del usuario: ${input}`,
          },
        ],
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) {
        return this.parseWithFallback(input);
      }

      const parsed = JSON.parse(content) as {
        understood?: unknown;
        confidence?: unknown;
        correo?: unknown;
        dni?: unknown;
        problema?: unknown;
        direccion?: unknown;
        categoria?: unknown;
        prioridad?: unknown;
      };

      const normalized: ParsedClaimData = {
        understood: Boolean(parsed.understood),
        confidence: this.normalizeConfidence(parsed.confidence),
        correo: this.normalizeOptionalString(parsed.correo),
        dni: this.normalizeOptionalString(parsed.dni),
        problema: this.normalizeOptionalString(parsed.problema),
        direccion: this.normalizeOptionalString(parsed.direccion),
        categoria: this.normalizeCategoria(parsed.categoria),
        prioridad: this.normalizePrioridad(parsed.prioridad),
      };

      if (!normalized.correo && !normalized.dni && !normalized.problema && !normalized.direccion) {
        return this.parseWithFallback(input);
      }

      return normalized;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Fallo interpretacion con OpenAI, se usa fallback local: ${message}`,
      );
      return this.parseWithFallback(input);
    }
  }

  // Parser de respaldo basado en regex. Se usa cuando OpenAI no está disponible
  // o cuando la respuesta no incluye ningún campo útil. Detecta email, DNI,
  // indicios de dirección y palabras clave de problemas.
  private parseWithFallback(input: string): ParsedClaimData {
    const correoMatch = input.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    const dniMatch = input.match(/\b\d{7,8}\b/);

    const lowered = input.toLowerCase();
    const problemaHint =
      /(fuga|corte|rotura|poste|basura|bache|inund|sin luz|sin agua|cloaca|reclamo)/.test(
        lowered,
      ) || input.length > 20;

    const direccionHint =
      /(av\.|avenida|calle|altura|nro|numero|#|\d{2,5})/.test(lowered) &&
      /(calle|av\.|avenida|pasaje|ruta|corrientes|san martin|belgrano|siempre viva)/.test(
        lowered);

    return {
      understood: Boolean(correoMatch || dniMatch || problemaHint || direccionHint),
      confidence: 0.55,
      correo: correoMatch?.[0],
      dni: dniMatch?.[0],
      problema: problemaHint ? input : undefined,
      direccion: direccionHint ? input : undefined,
    };
  }

  private normalizeConfidence(value: unknown): number {
    const num = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(num)) {
      return 0;
    }
    return Math.min(Math.max(num, 0), 1);
  }

  private normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim().replace(/\s+/g, ' ');
    return normalized.length ? normalized : undefined;
  }

  // Valida que la categoría devuelta por OpenAI sea una de las permitidas.
  // Evita que un valor inesperado del modelo contamine el estado de la conversación.
  private normalizeCategoria(value: unknown): ClaimCategoria | undefined {
    const valid: ClaimCategoria[] = [
      'agua_y_cloacas', 'alumbrado', 'baches_y_pavimento', 'arbolado',
      'residuos', 'electricidad', 'gas', 'transporte', 'infraestructura', 'otros',
    ];
    if (typeof value === 'string' && valid.includes(value as ClaimCategoria)) {
      return value as ClaimCategoria;
    }
    return undefined;
  }

  // Valida que la prioridad devuelta por OpenAI sea una de las permitidas.
  private normalizePrioridad(value: unknown): ClaimPrioridad | undefined {
    const valid: ClaimPrioridad[] = ['alta', 'media', 'baja'];
    if (typeof value === 'string' && valid.includes(value as ClaimPrioridad)) {
      return value as ClaimPrioridad;
    }
    return undefined;
  }
}
