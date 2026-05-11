import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, timeout } from 'rxjs';
import { AiInboundPayloadDto } from './dto/ai-inbound-payload.dto';
import { AiInterpreterService } from './ai-interpreter.service';
import { ConversationState, MensajeEntry } from './types/conversation-state.type';
import { RedisService } from '../redis/redis.service';

// Respuesta tipada del microservicio ms-geo (tópico: geo.geocode-address).
type GeocodeResponse = {
  correlationId: string;
  status: string;
  message: string;
  data: {
    lat: number;
    lng: number;
    formattedAddress: string;  // Dirección normalizada por Google.
    provider: string;
    locationType?: string;
    addressComponents?: {       // Componentes usados para validar zona de cobertura.
      country: string | null;
      adminArea: string | null;
      locality: string | null;
    };
  };
};

type GeocodeRequestPayload = {
  correlationId: string;
  address: string;
  country: string;
  city?: string;
};

// Respuesta tipada del microservicio ms-reclamos (tópico: reclamos.create).
type CreateReclamoResponse = {
  correlationId: string;
  reclamoId: string;
  trackingCode: string;
  status: string;
  canal: string;
  contactKey: string;
  message: string; // Mensaje de confirmación que se devuelve al ciudadano.
  createdAt: string;
  data: {
    problema: string;
    direccion: string;
    lat: number;
    lng: number;
  };
};

// Máquina de estados conversacional. Gestiona el ciclo de vida completo de un reclamo:
// 1. Saludo inicial (primer mensaje del contacto).
// 2. Extracción de datos con OpenAI (problema, dirección, identidad).
// 3. Pedido de campos faltantes al usuario.
// 4. Validación de zona de cobertura (vía ms-geo).
// 5. Creación del reclamo en base de datos (vía ms-reclamos).
// El estado de cada conversación se persiste en Redis con TTL configurable.
@Injectable()
export class AiProcessService {
  private readonly logger = new Logger(AiProcessService.name);
  private readonly keyPrefix = 'ms-ai:conversation'; // Prefijo de claves Redis de este servicio.
  private readonly conversationTtlSeconds: number;    // TTL de estado en Redis (default: 24h).

  constructor(
    private readonly aiInterpreterService: AiInterpreterService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    @Inject('NATS_CLIENT') private readonly natsClient: ClientProxy,
  ) {
    this.conversationTtlSeconds = this.intFromConfig(
      'AI_CONVERSATION_TTL_SECONDS',
      86400,
    );

    if (!this.getAllowedAreaTokens().length) {
      this.logger.warn(
        'GEO_ALLOWED_ADMIN_AREAS no esta configurado; la validacion de cobertura geografica quedara abierta',
      );
    }
  }

  // Punto de entrada del servicio. Ejecuta la máquina de estados:
  // - Sin estado previo → envía saludo y espera datos.
  // - Con estado → llama a OpenAI, fusiona campos, valida completitud.
  // - Datos completos → valida zona y crea el reclamo.
  async processInboundMessage(payload: AiInboundPayloadDto) {
    this.logger.log(
      `[${payload.correlationId}] Mensaje recibido desde gateway | contactKey=${payload.contactKey} | canal=${payload.channel} | mensajes=${payload.messageCount}`,
    );

    this.logger.log(
      `[${payload.correlationId}] consolidatedText: "${payload.consolidatedText}"`,
    );

    const existing = await this.getConversationState(payload.contactKey);

    // Si el flujo ya está cerrado (reclamo creado), evita re-preguntas automáticas
    // frente a eventos ruidosos/ambiguos y solo reabre con una intención clara.
    if (existing?.phase === 'closed') {
      if (this.isGreetingMessage(payload.consolidatedText)) {
        const greetingMessage =
          'Hola de nuevo. Si queres crear otro reclamo, enviame en un solo mensaje: correo o DNI, descripcion del problema y direccion exacta.';

        const reopenedByGreeting: ConversationState = {
          contactKey: payload.contactKey,
          phase: 'collecting_claim_data',
          greeted: true,
          mensajes: [
            this.makeMensaje('usuario', payload.consolidatedText),
            this.makeMensaje('asistente', greetingMessage),
          ],
          updatedAt: new Date().toISOString(),
        };

        await this.saveConversationState(reopenedByGreeting);

        return {
          correlationId: payload.correlationId,
          contactKey: payload.contactKey,
          status: 'conversation_reopened_by_greeting',
          shouldAskAgain: true,
          assistantMessage: greetingMessage,
          state: reopenedByGreeting,
        };
      }

      const shouldRestart = this.shouldRestartAfterClosure(payload.consolidatedText);

      if (!shouldRestart) {
        const closedState = {
          ...existing,
          updatedAt: new Date().toISOString(),
        };
        await this.saveConversationState(closedState);

        return {
          correlationId: payload.correlationId,
          contactKey: payload.contactKey,
          status: 'conversation_closed_no_action',
          shouldAskAgain: false,
          state: closedState,
        };
      }

      // Reinicia la captura para un nuevo reclamo en la misma conversación.
      const reopenedState: ConversationState = {
        contactKey: payload.contactKey,
        phase: 'collecting_claim_data',
        greeted: true,
        mensajes: [this.makeMensaje('usuario', payload.consolidatedText)],
        updatedAt: new Date().toISOString(),
      };

      await this.saveConversationState(reopenedState);

      const restartMessage =
        'Perfecto, iniciemos un nuevo reclamo. Enviame en un solo mensaje: correo o DNI, descripcion del problema y direccion exacta.';
      const restartedState = this.appendAsistente(reopenedState, restartMessage);
      await this.saveConversationState(restartedState);

      return {
        correlationId: payload.correlationId,
        contactKey: payload.contactKey,
        status: 'conversation_restarted',
        shouldAskAgain: true,
        assistantMessage: restartMessage,
        state: restartedState,
      };
    }

    // Primer turno: el contacto nunca habló o su estado expiró en Redis.
    if (!existing || !existing.greeted) {
      const greetingMessage =
        'Hola, gracias por contactarnos. Para crear tu reclamo envianos en un solo mensaje: correo o DNI, descripcion del problema y direccion exacta.';

      const newState: ConversationState = {
        contactKey: payload.contactKey,
        phase: 'collecting_claim_data',
        greeted: true,
        mensajes: [
          this.makeMensaje('usuario', payload.consolidatedText),
          this.makeMensaje('asistente', greetingMessage),
        ],
        updatedAt: new Date().toISOString(),
      };

      await this.saveConversationState(newState);

      return {
        correlationId: payload.correlationId,
        contactKey: payload.contactKey,
        status: 'awaiting_user_data',
        shouldAskAgain: true,
        assistantMessage: greetingMessage,
        state: newState,
      };
    }

    if (this.isGreetingMessage(payload.consolidatedText)) {
      const greetingMessage =
        'Hola. Para crear tu reclamo necesito que me envies en un solo mensaje: correo o DNI, descripcion del problema y direccion exacta.';
      const greetingState = this.appendAsistente(
        {
          ...existing,
          mensajes: [
            ...(existing.mensajes || []),
            this.makeMensaje('usuario', payload.consolidatedText),
          ],
          updatedAt: new Date().toISOString(),
        },
        greetingMessage,
      );
      await this.saveConversationState(greetingState);

      return {
        correlationId: payload.correlationId,
        contactKey: payload.contactKey,
        status: 'greeting_guidance',
        shouldAskAgain: true,
        assistantMessage: greetingMessage,
        state: greetingState,
      };
    }

    // Extrae datos del texto del usuario con OpenAI (o fallback regex).
    // Usa contactKey como identificador único del cliente para rate limiting y seguridad.
    const parsed = await this.aiInterpreterService.parseClaimText(
      payload.consolidatedText,
      payload.contactKey, // clientId para rate limiting y auditoría
    );

    // Fusiona los datos nuevos con los ya acumulados en estado previo.
    // Los campos existentes se mantienen si el nuevo turno no los actualiza.
    const mergedState: ConversationState = {
      ...existing,
      correo: parsed.correo || existing.correo,
      dni: parsed.dni || existing.dni,
      problema: parsed.problema || existing.problema,
      direccion: parsed.direccion || existing.direccion,
      categoria: parsed.categoria || existing.categoria,
      prioridad: parsed.prioridad || existing.prioridad,
      mensajes: [
        ...(existing.mensajes || []),
        this.makeMensaje('usuario', payload.consolidatedText),
      ],
      updatedAt: new Date().toISOString(),
    };

    await this.saveConversationState(mergedState);

    const hasIdentity = Boolean(mergedState.correo || mergedState.dni);
    const hasProblema = Boolean(mergedState.problema);
    const hasDireccion = Boolean(mergedState.direccion);

    // Confianza menor a 0.35: el texto es demasiado ambiguo para extraer datos confiables.
    if (!parsed.understood || parsed.confidence < 0.35) {
      const rephraseMessage = 'No pude entender bien tu mensaje. Por favor envialo nuevamente indicando en un solo mensaje: correo o DNI, problema y direccion exacta.';
      const rephraseState = this.appendAsistente(mergedState, rephraseMessage);
      await this.saveConversationState(rephraseState);

      return {
        correlationId: payload.correlationId,
        contactKey: payload.contactKey,
        status: 'needs_rephrase',
        shouldAskAgain: true,
        assistantMessage: rephraseMessage,
        missingFields: this.computeMissingFields(hasIdentity, hasProblema, hasDireccion),
        state: rephraseState,
      };
    }

    // Hay campos obligatorios faltantes; le indica al usuario cuáles son.
    if (!hasIdentity || !hasProblema || !hasDireccion) {
      const missingFields = this.computeMissingFields(hasIdentity, hasProblema, hasDireccion);
      const missingMessage = `Gracias. Me faltan estos datos para crear el reclamo: ${missingFields.join(', ')}. Enviamelos en un solo mensaje por favor.`;
      const missingState = this.appendAsistente(mergedState, missingMessage);
      await this.saveConversationState(missingState);

      return {
        correlationId: payload.correlationId,
        contactKey: payload.contactKey,
        status: 'missing_required_data',
        shouldAskAgain: true,
        assistantMessage: missingMessage,
        missingFields,
        extractedData: {
          correo: missingState.correo,
          dni: missingState.dni,
          problema: missingState.problema,
          direccion: missingState.direccion,
        },
        state: missingState,
      };
    }

    // Todos los datos están presentes: geocodifica la dirección y crea el reclamo.
    const claimCreation = await this.createClaim(payload, mergedState);

    if (!claimCreation.success) {
      if ('addressOutOfServiceArea' in claimCreation && claimCreation.addressOutOfServiceArea) {
        const allowedAreas = this.configService.get<string>('GEO_ALLOWED_ADMIN_AREAS', 'la zona de cobertura');
        const oosMessage = `La direccion proporcionada no corresponde a nuestra zona de cobertura (${allowedAreas}). Por favor, indica una direccion dentro del area de servicio.`;
        const oosState: ConversationState = this.appendAsistente({ ...mergedState, direccion: undefined }, oosMessage);
        await this.saveConversationState(oosState);

        return {
          correlationId: payload.correlationId,
          contactKey: payload.contactKey,
          status: 'address_out_of_service_area',
          shouldAskAgain: true,
          assistantMessage: oosMessage,
          state: oosState,
        };
      }

      return {
        correlationId: payload.correlationId,
        contactKey: payload.contactKey,
        status: 'claim_creation_failed',
        shouldAskAgain: false,
        assistantMessage:
          'Tengo tus datos, pero no pude crear el reclamo en este momento. Estamos reintentando internamente.',
        extractedData: {
          correo: mergedState.correo,
          dni: mergedState.dni,
          problema: mergedState.problema,
          direccion: mergedState.direccion,
        },
        state: mergedState,
        error: claimCreation.error,
      };
    }

    const finalState = this.appendAsistente(
      { ...mergedState, phase: 'closed' },
      claimCreation.reclamo.message,
    );
    await this.saveConversationState(finalState);

    return {
      correlationId: payload.correlationId,
      contactKey: payload.contactKey,
      status: 'claim_created',
      shouldAskAgain: false,
      assistantMessage: claimCreation.reclamo.message,
      reclamo: {
        reclamoId: claimCreation.reclamo.reclamoId,
        trackingCode: claimCreation.reclamo.trackingCode,
        status: claimCreation.reclamo.status,
        createdAt: claimCreation.reclamo.createdAt,
      },
      geolocation: {
        lat: claimCreation.reclamo.data.lat,
        lng: claimCreation.reclamo.data.lng,
      },
      extractedData: {
        correo: finalState.correo,
        dni: finalState.dni,
        problema: finalState.problema,
        direccion: claimCreation.reclamo.data.direccion,
        categoria: finalState.categoria || 'otros',
        prioridad: finalState.prioridad || 'media',
      },
      state: finalState,
    };
  }

  // Valida que la dirección geocodificada esté dentro de la zona de cobertura.
  // Lee GEO_ALLOWED_COUNTRIES y GEO_ALLOWED_ADMIN_AREAS del entorno (listas separadas por coma).
  // Si addressComponents no viene en la respuesta, se asume zona válida.
  private isWithinServiceArea(geocode: GeocodeResponse): boolean {
    const components = geocode.data.addressComponents;
    if (!components) return true; // Sin componentes no se puede validar → se permite.

    const allowedCountries = this.configService
      .get<string>('GEO_ALLOWED_COUNTRIES', 'Argentina')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    const allowedAdminAreas = this.configService
      .get<string>('GEO_ALLOWED_ADMIN_AREAS', '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);

    const country = (components.country || '').toLowerCase();
    const adminArea = (components.adminArea || '').toLowerCase();
    const locality = (components.locality || '').toLowerCase();

    if (allowedCountries.length && country && !allowedCountries.includes(country)) {
      return false;
    }

    if (allowedAdminAreas.length) {
      const scopeCandidates = [adminArea, locality].filter(Boolean);

      // Si Google no devuelve componentes geográficos útiles, no se bloquea por zona.
      if (!scopeCandidates.length) {
        return true;
      }

      const matchesScope = allowedAdminAreas.some((allowed) =>
        scopeCandidates.some(
          (candidate) => candidate.includes(allowed) || allowed.includes(candidate),
        ),
      );

      if (!matchesScope) return false;
    }

    return true;
  }

  private computeMissingFields(
    hasIdentity: boolean,
    hasProblema: boolean,
    hasDireccion: boolean,
  ): string[] {
    const missing: string[] = [];

    if (!hasIdentity) {
      missing.push('correo o DNI');
    }
    if (!hasProblema) {
      missing.push('problema');
    }
    if (!hasDireccion) {
      missing.push('direccion');
    }

    return missing;
  }

  // Lee el estado de la conversación desde Redis. Devuelve null si no existe o expiró.
  private async getConversationState(
    contactKey: string,
  ): Promise<ConversationState | null> {
    const raw = await this.redisService
      .getClient()
      .get(this.conversationStateKey(contactKey));

    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as ConversationState;
  }

  // Persiste el estado en Redis sobreescribiendo el anterior, renovando el TTL.
  private async saveConversationState(state: ConversationState): Promise<void> {
    await this.redisService
      .getClient()
      .set(this.conversationStateKey(state.contactKey), JSON.stringify(state), {
        EX: this.conversationTtlSeconds,
      });
  }

  private conversationStateKey(contactKey: string): string {
    return `${this.keyPrefix}:${contactKey}`;
  }

  private makeMensaje(origen: 'usuario' | 'asistente', texto: string): MensajeEntry {
    return { origen, texto, creadoEn: new Date().toISOString() };
  }

  private appendAsistente(state: ConversationState, texto: string): ConversationState {
    return {
      ...state,
      mensajes: [...(state.mensajes || []), this.makeMensaje('asistente', texto)],
      updatedAt: new Date().toISOString(),
    };
  }

  private shouldRestartAfterClosure(text: string): boolean {
    const normalized = text.toLowerCase();

    // Señales de apertura explícita de un nuevo reclamo.
    if (/\b(nuevo\s+reclamo|otro\s+reclamo|iniciar\s+reclamo|abrir\s+reclamo)\b/.test(normalized)) {
      return true;
    }

    // Si trae identidad y contenido sustancial, se considera nuevo inicio.
    const hasIdentity = /\b\d{7,8}\b/.test(normalized) || /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/.test(normalized);
    const hasAddressLike = /\b(calle|av\.?|avenida|pasaje|ruta|nro|numero|altura|\d{3,5})\b/.test(normalized);
    const hasProblemLike = /\b(sin\s+luz|sin\s+agua|corte|fuga|rotura|bache|reclamo|problema)\b/.test(normalized);

    return hasIdentity && hasAddressLike && hasProblemLike;
  }

  private isGreetingMessage(text: string): boolean {
    const normalized = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();

    if (!normalized) {
      return false;
    }

    const hasGreeting = /\b(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches|que tal)\b/.test(
      normalized,
    );

    if (!hasGreeting) {
      return false;
    }

    const hasIdentity = /\b\d{7,8}\b/.test(normalized) || /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/.test(normalized);
    const hasAddressLike = /\b(calle|av\.?|avenida|pasaje|ruta|nro|numero|altura|\d{3,5})\b/.test(normalized);
    const hasProblemLike = /\b(sin\s+luz|sin\s+agua|corte|fuga|rotura|bache|reclamo|problema)\b/.test(normalized);

    // Solo se considera saludo "puro" para no interceptar mensajes con datos de reclamo.
    return !hasIdentity && !hasAddressLike && !hasProblemLike;
  }

  private getAllowedAreaTokens(): string[] {
    return this.configService
      .get<string>('GEO_ALLOWED_ADMIN_AREAS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private resolveCityHint(address: string): string | undefined {
    const normalizedAddress = address.toLowerCase();
    const allowedTokens = this.getAllowedAreaTokens();

    // Si la dirección ya incluye una zona permitida, no agrega hint adicional.
    const alreadyScoped = allowedTokens.some((token) =>
      normalizedAddress.includes(token.toLowerCase()),
    );
    if (alreadyScoped) {
      return undefined;
    }

    // Prioriza variable dedicada y luego primer token de zona permitida.
    const configuredCity = this.configService.get<string>('GEO_DEFAULT_CITY')?.trim();
    if (configuredCity) {
      return configuredCity;
    }

    return allowedTokens[0];
  }

  private async geocodeAddress(
    payload: AiInboundPayloadDto,
    address: string,
  ): Promise<GeocodeResponse> {
    const country = this.configService.get<string>('GEO_DEFAULT_COUNTRY', 'Argentina');
    const city = this.resolveCityHint(address);

    const requestPayload: GeocodeRequestPayload = {
      correlationId: payload.correlationId,
      address,
      country,
      ...(city ? { city } : {}),
    };

    return firstValueFrom(
      this.natsClient
        .send<GeocodeResponse>('geo.geocode-address', requestPayload)
        .pipe(timeout(10000)),
    );
  }

  private intFromConfig(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = raw ? Number(raw) : NaN;

    if (Number.isNaN(parsed)) {
      return fallback;
    }

    return Math.max(Math.trunc(parsed), 1);
  }

  // Orquesta la creación del reclamo en dos pasos:
  // 1. Geocodifica la dirección (NATS → ms-geo) para obtener coordenadas y validar zona.
  // 2. Si la zona es válida, envía todos los datos a ms-reclamos (NATS → ms-reclamos).
  // Devuelve un resultado tipado con discriminante 'success' para manejo exhaustivo.
  private async createClaim(
    payload: AiInboundPayloadDto,
    state: ConversationState,
  ): Promise<
    | { success: true; reclamo: CreateReclamoResponse }
    | { success: false; addressOutOfServiceArea: true }
    | { success: false; addressOutOfServiceArea?: false; error: string }
  > {
    if (!state.problema || !state.direccion) {
      return { success: false, error: 'Datos incompletos para crear reclamo' };
    }

    try {
      const geocode = await this.geocodeAddress(payload, state.direccion);

      if (!geocode || !geocode.data) {
        return { success: false, error: 'No hubo respuesta valida de geolocalizacion' };
      }

      if (!this.isWithinServiceArea(geocode)) {
        const components = geocode.data.addressComponents;
        this.logger.warn(
          `[${payload.correlationId}] Direccion fuera de zona de servicio | country=${components?.country} adminArea=${components?.adminArea}`,
        );
        return { success: false, addressOutOfServiceArea: true };
      }

      const reclamo = await firstValueFrom(
        this.natsClient
          .send<CreateReclamoResponse>('reclamos.create', {
            correlationId: payload.correlationId,
            contactKey: payload.contactKey,
            canal: payload.channel,
            correo: state.correo,
            dni: state.dni,
            problema: state.problema,
            direccion: geocode.data.formattedAddress || state.direccion,
            lat: geocode.data.lat,
            lng: geocode.data.lng,
            categoria: state.categoria || 'otros',
            prioridad: state.prioridad || 'media',
            mensajes: state.mensajes || [],
            metadata: {
              geocodeStatus: geocode.status,
              geocodeProvider: geocode.data.provider,
              addressComponents: geocode.data.addressComponents,
            },
          })
          .pipe(timeout(10000)),
      );

      this.logger.log(
        `[${payload.correlationId}] Reclamo creado exitosamente | reclamoId=${reclamo.reclamoId}`,
      );

      return { success: true, reclamo };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[${payload.correlationId}] Error creando reclamo: ${message}`,
      );
      return { success: false, error: message };
    }
  }
}
