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

type ClaimMunicipality = {
  id: string;
  name: string;
  defaultCity?: string | null;
  country: string;
  isActive: boolean;
  allowedCountries: string[];
  allowedAdminAreas: string[];
  categories: Array<{
    code: string;
    isActive: boolean;
    defaultPriority: 'alta' | 'media' | 'baja';
  }>;
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

export type CitizenFollowupResult = {
  status: string;
  assistantMessage: string;
};

export type PossibleDuplicateClaim = {
  reclamoId: string;
  codigoSeguimiento: string;
  problema: string;
  direccion: string;
  estado: string;
  distanciaMetros: number;
  similitud: number;
};

type DuplicateClaimCandidate = {
  id: string;
  codigoSeguimiento: string;
  problema: string;
  direccion: string;
  lat: number | string;
  lng: number | string;
  categoria: string;
  estado: string;
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
    const contacto = this.contactFromKey(contactKey);
    if (!contacto) return { status: 'not_found' as const, data: null };
    return firstValueFrom(
      this.natsClient
        .send<{
          status: 'ok' | 'not_found';
          data: {
            trackingCode: string;
            status: string;
            category: string;
            updatedAt: string;
          } | null;
        }>('reclamos.public-tracking', {
          codigoSeguimiento,
          contacto,
        })
        .pipe(timeout(8000)),
    );
  }

  async handleCitizenFollowup(
    payload: AiInboundPayloadDto,
  ): Promise<CitizenFollowupResult | null> {
    if (payload.channel !== 'whatsapp') return null;

    const text = payload.consolidatedText.trim();
    const trackingCode = this.extractTrackingCode(text);
    if (!trackingCode) return null;

    if (this.isCitizenResponseRequest(text)) {
      const tracking = await this.getPublicTracking(
        trackingCode,
        payload.contactKey,
      );
      if (tracking.status !== 'ok' || !tracking.data) {
        return {
          status: 'citizen_response_not_found',
          assistantMessage:
            'No pude validar ese reclamo con este contacto.',
        };
      }

      const type = this.citizenResponseType(text);
      const shouldReopen =
        /\breabrir\b/i.test(text) ||
        (type === 'disconforme' && tracking.data.status === 'cerrado');
      if (shouldReopen) {
        const response = await this.reopenCitizen(
          trackingCode,
          payload.contactKey,
          this.extractCitizenComment(text, trackingCode) ||
            'El ciudadano solicito reabrir el reclamo por WhatsApp.',
        );
        if (response.status !== 'ok') {
          return {
            status: 'citizen_response_not_found',
            assistantMessage:
              'No pude validar ese reclamo con este contacto.',
          };
        }
        return {
          status: 'claim_reopened',
          assistantMessage:
            `Registramos la solicitud de reapertura del reclamo ${trackingCode}. El municipio continuara su seguimiento.`,
        };
      }

      const response = await this.submitCitizenResponse(
        trackingCode,
        type,
        payload.contactKey,
        this.extractCitizenComment(text, trackingCode),
      );
      if (response.status !== 'ok') {
        return {
          status: 'citizen_response_not_found',
          assistantMessage:
            'No pude validar ese reclamo con este contacto.',
        };
      }
      return {
        status: 'citizen_response_recorded',
        assistantMessage:
          type === 'confirmada'
            ? `Gracias por confirmar la resolucion del reclamo ${trackingCode}. Registramos tu respuesta.`
            : `Registramos tu disconformidad con el reclamo ${trackingCode}. El municipio continuara el seguimiento.`,
      };
    }

    if (this.isTrackingRequest(text)) {
      const tracking = await this.getPublicTracking(
        trackingCode,
        payload.contactKey,
      );
      if (tracking.status !== 'ok' || !tracking.data) {
        return {
          status: 'tracking_not_found',
          assistantMessage:
            'No encontre un reclamo asociado a ese codigo y a este contacto.',
        };
      }
      return {
        status: 'tracking_found',
        assistantMessage:
          `El reclamo ${tracking.data.trackingCode} se encuentra ${this.publicStatusLabel(tracking.data.status)}. Categoria: ${tracking.data.category}. Ultima actualizacion: ${new Date(tracking.data.updatedAt).toLocaleDateString('es-AR')}.`,
      };
    }

    return null;
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

  private contactFromKey(contactKey: string): string | undefined {
    const [, identityType, ...identityParts] = contactKey.split(':');
    const value = identityParts.join(':');
    if (identityType === 'phone') return value.replace(/\D/g, '') || undefined;
    if (identityType === 'email') return value.trim().toLowerCase() || undefined;
    return undefined;
  }

  private extractCitizenComment(
    text: string,
    trackingCode: string,
  ): string | undefined {
    const normalized = text
      .replace(trackingCode, '')
      .replace(/\b(CONFORME|DISCONFORME|REABRIR|SATISFECHO|SATISFECHA)\b/i, '')
      .replace(/^\s*[:,-]+\s*/, '')
      .trim();
    return normalized || undefined;
  }

  private publicStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      pendiente: 'pendiente',
      en_proceso: 'en proceso',
      resuelto: 'resuelto',
      rechazado: 'rechazado',
      cerrado: 'cerrado',
    };
    return labels[status] || 'en seguimiento';
  }

  async submitCitizenResponse(
    trackingCode: string,
    type: 'confirmada' | 'disconforme',
    contactKey: string,
    comentario?: string,
  ): Promise<{ status: string; data?: unknown }> {
    return firstValueFrom(
      this.natsClient
        .send<{ status: string; data?: unknown }>('reclamos.citizen.response', {
          trackingCode,
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

  async createClaim(
    payload: AiInboundPayloadDto,
    state: ConversationState,
  ): Promise<
    | { success: true; reclamo: CreateReclamoResponse }
    | { success: false; addressOutOfServiceArea: true; serviceArea: string }
    | { success: false; addressOutOfServiceArea?: false; categoryUnavailable?: boolean; error: string }
  > {
    if (!state.problema || !state.direccion) {
      return { success: false, error: 'Datos incompletos para crear reclamo' };
    }

    try {
      const municipality = await this.resolveClaimMunicipality();
      const categoria = state.categoria || 'otros';
      const category = municipality.categories.find(
        (item) => item.code === categoria && item.isActive === true,
      );
      if (!category) {
        return { success: false, categoryUnavailable: true, error: 'La categoria no esta habilitada para este municipio.' };
      }
      const geocode = await this.geocodeAddress(payload, state.direccion, municipality);

      if (!geocode || !geocode.data) {
        return {
          success: false,
          error: 'No hubo respuesta valida de geolocalizacion',
        };
      }

      if (!this.isWithinServiceArea(geocode, municipality)) {
        const components = geocode.data.addressComponents;
        this.logger.warn(
          `[${payload.correlationId}] Direccion fuera de zona de servicio | country=${components?.country} adminArea=${components?.adminArea}`,
        );
        return {
          success: false, addressOutOfServiceArea: true,
          serviceArea: municipality.defaultCity || municipality.name,
        };
      }

      const municipalityId = municipality.id;
      const posiblesDuplicados = await this.findPossibleDuplicates({
        correlationId: payload.correlationId,
        problema: state.problema,
        direccion: geocode.data.formattedAddress || state.direccion,
        lat: geocode.data.lat,
        lng: geocode.data.lng,
        categoria,
        municipalityId,
      });

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
            categoria,
            prioridad: category.defaultPriority || 'media',
            municipalityId,
            mensajes: state.mensajes || [],
            metadata: {
              geocodeStatus: geocode.status,
              geocodeProvider: geocode.data.provider,
              addressComponents: geocode.data.addressComponents,
              ...(posiblesDuplicados.length > 0 ? { posiblesDuplicados } : {}),
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

  private async findPossibleDuplicates(input: {
    correlationId: string;
    problema: string;
    direccion: string;
    lat: number;
    lng: number;
    categoria: string;
    municipalityId?: string;
  }): Promise<PossibleDuplicateClaim[]> {
    if (!input.municipalityId) return [];

    try {
      const activeClaims = await Promise.all(
        (['pendiente', 'en_proceso'] as const).map((estado) =>
          firstValueFrom(
            this.natsClient
              .send<{ items?: DuplicateClaimCandidate[] }>(
                'reclamos.find-all',
                {
                  page: 1,
                  limit: 100,
                  estado,
                  categoria: input.categoria,
                  municipalityId: input.municipalityId,
                  sortDirection: -1,
                },
              )
              .pipe(timeout(4000)),
          ),
        ),
      );

      return activeClaims
        .flatMap((result) => result.items ?? [])
        .map((candidate) => this.scoreDuplicateCandidate(input, candidate))
        .filter((candidate): candidate is PossibleDuplicateClaim =>
          candidate !== null,
        )
        .sort(
          (first, second) =>
            second.similitud - first.similitud ||
            first.distanciaMetros - second.distanciaMetros,
        )
        .slice(0, 3);
    } catch {
      this.logger.warn(
        `[${input.correlationId}] No se pudo buscar duplicados; se continuara con la creacion del reclamo`,
      );
      return [];
    }
  }

  private scoreDuplicateCandidate(
    input: {
      problema: string;
      direccion: string;
      lat: number;
      lng: number;
      categoria: string;
    },
    candidate: DuplicateClaimCandidate,
  ): PossibleDuplicateClaim | null {
    if (candidate.categoria !== input.categoria) return null;
    const candidateLat = Number(candidate.lat);
    const candidateLng = Number(candidate.lng);
    if (!Number.isFinite(candidateLat) || !Number.isFinite(candidateLng)) {
      return null;
    }

    const distanciaMetros = this.distanceMeters(
      input.lat,
      input.lng,
      candidateLat,
      candidateLng,
    );
    if (distanciaMetros > 120) return null;

    const sameAddress =
      this.normalizeDuplicateText(input.direccion) ===
      this.normalizeDuplicateText(candidate.direccion);
    const textSimilarity = this.textSimilarity(
      input.problema,
      candidate.problema,
    );
    if (!sameAddress && textSimilarity < 0.18 && distanciaMetros > 25) {
      return null;
    }

    const proximityScore = Math.max(0, 1 - distanciaMetros / 120);
    const similitud = Math.round(
      (proximityScore * 0.55 + textSimilarity * 0.45) * 100,
    );
    return {
      reclamoId: candidate.id,
      codigoSeguimiento: candidate.codigoSeguimiento,
      problema: candidate.problema,
      direccion: candidate.direccion,
      estado: candidate.estado,
      distanciaMetros: Math.round(distanciaMetros),
      similitud,
    };
  }

  private distanceMeters(
    firstLat: number,
    firstLng: number,
    secondLat: number,
    secondLng: number,
  ): number {
    const radians = (degrees: number) => (degrees * Math.PI) / 180;
    const latitudeDelta = radians(secondLat - firstLat);
    const longitudeDelta = radians(secondLng - firstLng);
    const haversine =
      Math.sin(latitudeDelta / 2) ** 2 +
      Math.cos(radians(firstLat)) *
        Math.cos(radians(secondLat)) *
        Math.sin(longitudeDelta / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  }

  private textSimilarity(first: string, second: string): number {
    const stopWords = new Set([
      'con', 'del', 'desde', 'el', 'en', 'la', 'las', 'los', 'por', 'un', 'una',
    ]);
    const tokens = (value: string) =>
      new Set(
        this.normalizeDuplicateText(value)
          .split(' ')
          .filter((token) => token.length > 2 && !stopWords.has(token)),
      );
    const firstTokens = tokens(first);
    const secondTokens = tokens(second);
    const union = new Set([...firstTokens, ...secondTokens]);
    if (union.size === 0) return 0;
    const intersection = [...firstTokens].filter((token) =>
      secondTokens.has(token),
    ).length;
    return intersection / union.size;
  }

  private normalizeDuplicateText(value: string): string {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  private async geocodeAddress(
    payload: AiInboundPayloadDto,
    address: string,
    municipality: ClaimMunicipality,
  ): Promise<GeocodeResponse> {
    const requestPayload: GeocodeRequestPayload = {
      correlationId: payload.correlationId,
      address,
      country: municipality.country,
      city: municipality.defaultCity || municipality.name,
    };

    return firstValueFrom(
      this.natsClient
        .send<GeocodeResponse>('geo.geocode-address', requestPayload)
        .pipe(timeout(10000)),
    );
  }

  private normalizeLocation(value?: string | null): string {
    return value
      ?.trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ') || '';
  }

  private async resolveClaimMunicipality(): Promise<ClaimMunicipality> {
    const id = this.configService.get<string>('AI_MUNICIPALITY_ID')?.trim();
    if (id && /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(id)) {
      try {
        const municipality = await firstValueFrom(
          this.natsClient.send<ClaimMunicipality>('municipalities.config.get', {
            data: { id }, context: { userId: 'ms-ai', ip: '' },
          }).pipe(timeout(8000)),
        );
        if (municipality?.id === id && municipality.isActive === true) {
          return municipality;
        }
      } catch {
        this.logger.warn('No se pudo obtener la configuracion municipal del canal conversacional');
      }
    }
    throw new Error('El municipio del canal conversacional no esta disponible. Intenta nuevamente mas tarde.');
  }

  private isWithinServiceArea(geocode: GeocodeResponse, municipality: ClaimMunicipality): boolean {
    const components = geocode.data.addressComponents;
    if (geocode.status !== 'geocode_ok' || !components ||
        !Number.isFinite(geocode.data.lat) || !Number.isFinite(geocode.data.lng) ||
        Math.abs(geocode.data.lat) > 90 || Math.abs(geocode.data.lng) > 180 ||
        (geocode.data.lat === 0 && geocode.data.lng === 0)) {
      return false;
    }

    const country = this.normalizeLocation(components.country);
    const locality = this.normalizeLocation(components.locality);
    const adminArea = this.normalizeLocation(components.adminArea);
    const allowedCountries = municipality.allowedCountries.length
      ? municipality.allowedCountries : [municipality.country];
    return Boolean(locality &&
      locality === this.normalizeLocation(municipality.defaultCity || municipality.name) &&
      allowedCountries.some((item) => this.normalizeLocation(item) === country) &&
      (!municipality.allowedAdminAreas.length || municipality.allowedAdminAreas.some(
        (item) => [locality, adminArea].includes(this.normalizeLocation(item)),
      )));
  }
}
