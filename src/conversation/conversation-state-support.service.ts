import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, timeout } from 'rxjs';
import { AiInboundPayloadDto } from '../ai-process/dto/ai-inbound-payload.dto';
import { AiInterpreterService } from '../ai-process/ai-interpreter.service';
import {
  ConversationState,
  MensajeEntry,
} from '../ai-process/types/conversation-state.type';

export type GeocodeResponse = {
  correlationId: string;
  status: string;
  message: string;
  data: {
    lat: number;
    lng: number;
    formattedAddress: string;
    provider: string;
    locationType?: string;
    addressComponents?: {
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

export type CreateReclamoResponse = {
  correlationId: string;
  reclamoId: string;
  trackingCode: string;
  status: string;
  canal: string;
  contactKey: string;
  message: string;
  createdAt: string;
  data: {
    problema: string;
    direccion: string;
    lat: number;
    lng: number;
  };
};

@Injectable()
export class ConversationStateSupportService {
  private readonly logger = new Logger(ConversationStateSupportService.name);

  constructor(
    private readonly aiInterpreterService: AiInterpreterService,
    private readonly configService: ConfigService,
    @Inject('NATS_CLIENT') private readonly natsClient: ClientProxy,
  ) {}

  parseClaimText(input: string, clientId: string) {
    return this.aiInterpreterService.parseClaimText(input, clientId);
  }

  async getPublicTracking(codigoSeguimiento: string, contactKey: string) {
    return firstValueFrom(
      this.natsClient
        .send<{
          status: 'ok' | 'not_found';
          data: {
            claimId: string;
            trackingCode: string;
            status: string;
            category: string;
            updatedAt: string;
          } | null;
        }>('reclamos.public-tracking', {
          codigoSeguimiento,
          contactKey,
        })
        .pipe(timeout(8000)),
    );
  }

  extractTrackingCode(text: string): string | undefined {
    return text.match(/\bREC-[A-Z0-9]+\b/i)?.[0].toUpperCase();
  }

  isTrackingRequest(text: string): boolean {
    const normalized = text.toLowerCase();
    return (
      Boolean(this.extractTrackingCode(text)) &&
      /(estado|seguimiento|reclamo|como esta|cómo está)/.test(normalized)
    );
  }

  isCitizenResponseRequest(text: string): boolean {
    const normalized = text.toLowerCase();
    return (
      Boolean(this.extractTrackingCode(text)) &&
      /(conforme|disconforme|satisfecho|satisfecha|no estoy conforme|no se resolvio|no se resolvió|reabrir)/.test(
        normalized,
      )
    );
  }

  citizenResponseType(text: string): 'confirmada' | 'disconforme' {
    return /(disconforme|no estoy conforme|no se resolvio|no se resolvió|reabrir)/.test(
      text.toLowerCase(),
    )
      ? 'disconforme'
      : 'confirmada';
  }

  async submitCitizenResponse(
    claimId: string,
    type: 'confirmada' | 'disconforme',
    contactKey: string,
    comentario?: string,
  ): Promise<{ status: string; data?: unknown }> {
    return firstValueFrom(
      this.natsClient
        .send<{ status: string; data?: unknown }>('reclamos.citizen.response', {
          reclamoId: claimId,
          tipo: type,
          contactKey,
          comentario,
        })
        .pipe(timeout(8000)),
    );
  }

  async reopenCitizen(
    trackingCode: string,
    contactKey: string,
    motivo: string,
  ): Promise<{ status: string; data?: unknown }> {
    return firstValueFrom(
      this.natsClient
        .send<{ status: string; data?: unknown }>('reclamos.citizen.reopen', {
          trackingCode,
          contactKey,
          motivo,
        })
        .pipe(timeout(8000)),
    );
  }

  makeMensaje(origen: 'usuario' | 'asistente', texto: string): MensajeEntry {
    return { origen, texto, creadoEn: new Date().toISOString() };
  }

  appendAsistente(state: ConversationState, texto: string): ConversationState {
    return {
      ...state,
      mensajes: [
        ...(state.mensajes || []),
        this.makeMensaje('asistente', texto),
      ],
      updatedAt: new Date().toISOString(),
    };
  }

  computeMissingFields(
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

  shouldRestartAfterClosure(text: string): boolean {
    const normalized = text.toLowerCase();

    if (
      /\b(nuevo\s+reclamo|otro\s+reclamo|iniciar\s+reclamo|abrir\s+reclamo)\b/.test(
        normalized,
      )
    ) {
      return true;
    }

    const hasIdentity =
      /\b\d{7,8}\b/.test(normalized) ||
      /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/.test(normalized);
    const hasAddressLike =
      /\b(calle|av\.?|avenida|pasaje|ruta|nro|numero|altura|\d{3,5})\b/.test(
        normalized,
      );
    const hasProblemLike =
      /\b(sin\s+luz|sin\s+agua|corte|fuga|rotura|bache|reclamo|problema)\b/.test(
        normalized,
      );

    return hasIdentity && hasAddressLike && hasProblemLike;
  }

  isGreetingMessage(text: string): boolean {
    const normalized = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();

    if (!normalized) {
      return false;
    }

    const hasGreeting =
      /\b(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches|que tal)\b/.test(
        normalized,
      );

    if (!hasGreeting) {
      return false;
    }

    const hasIdentity =
      /\b\d{7,8}\b/.test(normalized) ||
      /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/.test(normalized);
    const hasAddressLike =
      /\b(calle|av\.?|avenida|pasaje|ruta|nro|numero|altura|\d{3,5})\b/.test(
        normalized,
      );
    const hasProblemLike =
      /\b(sin\s+luz|sin\s+agua|corte|fuga|rotura|bache|reclamo|problema)\b/.test(
        normalized,
      );

    return !hasIdentity && !hasAddressLike && !hasProblemLike;
  }

  getAllowedAreaTokens(): string[] {
    return this.configService
      .get<string>('GEO_ALLOWED_ADMIN_AREAS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  getAllowedAreasLabel(): string {
    return this.configService.get<string>(
      'GEO_ALLOWED_ADMIN_AREAS',
      'la zona de cobertura',
    );
  }

  async createClaim(
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
        return {
          success: false,
          error: 'No hubo respuesta valida de geolocalizacion',
        };
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
            municipalityId: this.toTerritoryId(
              geocode.data.addressComponents?.locality,
            ),
            areaId: this.toTerritoryId(
              geocode.data.addressComponents?.adminArea,
            ),
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

  private async geocodeAddress(
    payload: AiInboundPayloadDto,
    address: string,
  ): Promise<GeocodeResponse> {
    const country = this.configService.get<string>(
      'GEO_DEFAULT_COUNTRY',
      'Argentina',
    );
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

  private toTerritoryId(value?: string | null): string | undefined {
    const normalized = value
      ?.trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    return normalized || undefined;
  }

  private resolveCityHint(address: string): string | undefined {
    const normalizedAddress = address.toLowerCase();
    const allowedTokens = this.getAllowedAreaTokens();

    const alreadyScoped = allowedTokens.some((token) =>
      normalizedAddress.includes(token.toLowerCase()),
    );
    if (alreadyScoped) {
      return undefined;
    }

    const configuredCity = this.configService
      .get<string>('GEO_DEFAULT_CITY')
      ?.trim();
    if (configuredCity) {
      return configuredCity;
    }

    return allowedTokens[0];
  }

  private isWithinServiceArea(geocode: GeocodeResponse): boolean {
    const components = geocode.data.addressComponents;
    if (!components) {
      return true;
    }

    const allowedCountries = this.configService
      .get<string>('GEO_ALLOWED_COUNTRIES', 'Argentina')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const allowedAdminAreas = this.configService
      .get<string>('GEO_ALLOWED_ADMIN_AREAS', '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const country = (components.country || '').toLowerCase();
    const adminArea = (components.adminArea || '').toLowerCase();
    const locality = (components.locality || '').toLowerCase();

    if (
      allowedCountries.length &&
      country &&
      !allowedCountries.includes(country)
    ) {
      return false;
    }

    if (allowedAdminAreas.length) {
      const scopeCandidates = [adminArea, locality].filter(Boolean);

      if (!scopeCandidates.length) {
        return true;
      }

      const matchesScope = allowedAdminAreas.some((allowed) =>
        scopeCandidates.some(
          (candidate) =>
            candidate.includes(allowed) || allowed.includes(candidate),
        ),
      );

      if (!matchesScope) {
        return false;
      }
    }

    return true;
  }
}
