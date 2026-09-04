import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiInboundPayloadDto, ChannelType } from './dto/ai-inbound-payload.dto';
import {
  ConversationState,
  ConversationPhase,
} from './types/conversation-state.type';
import { RedisService } from '../redis/redis.service';
import {
  CONVERSATION_STATE_HANDLERS,
  ConversationStateHandler,
} from '../conversation/states/conversation-state-handler.interface';
import { ConversationStateSupportService } from '../conversation/conversation-state-support.service';

@Injectable()
export class AiProcessService {
  private readonly logger = new Logger(AiProcessService.name);
  private readonly keyPrefix = 'ms-ai:conversation';
  private readonly conversationTtlSeconds: number;

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    private readonly support: ConversationStateSupportService,
    @Inject(CONVERSATION_STATE_HANDLERS)
    private readonly stateHandlers: ConversationStateHandler[],
  ) {
    this.conversationTtlSeconds = this.intFromConfig(
      'AI_CONVERSATION_TTL_SECONDS',
      86400,
    );

    if (!this.support.getAllowedAreaTokens().length) {
      this.logger.warn(
        'GEO_ALLOWED_ADMIN_AREAS no esta configurado; la validacion de cobertura geografica quedara abierta',
      );
    }
  }

  async processInboundMessage(payload: AiInboundPayloadDto) {
    this.logger.log(
      `[${payload.correlationId}] Mensaje recibido desde gateway | contactKey=${payload.contactKey} | canal=${payload.channel} | mensajes=${payload.messageCount}`,
    );

    this.logger.log(
      `[${payload.correlationId}] consolidatedText: "${payload.consolidatedText}"`,
    );

    const currentState =
      (await this.getConversationState(payload.contactKey)) ||
      this.buildInitialState(payload.contactKey);

    const effectiveState = currentState.greeted
      ? currentState
      : {
          ...currentState,
          phase: 'awaiting_identity_and_claim' as ConversationPhase,
        };

    if (
      payload.channel === ChannelType.WHATSAPP &&
      typeof this.support.isCitizenResponseRequest === 'function' &&
      this.support.isCitizenResponseRequest(payload.consolidatedText)
    ) {
      return this.processCitizenResponse(payload, effectiveState);
    }

    if (
      payload.channel === ChannelType.WHATSAPP &&
      typeof this.support.isTrackingRequest === 'function' &&
      this.support.isTrackingRequest(payload.consolidatedText)
    ) {
      return this.processTrackingRequest(payload, effectiveState);
    }

    const handler = this.stateHandlers.find((stateHandler) =>
      stateHandler.canHandle(effectiveState.phase),
    );

    if (!handler) {
      throw new Error(`No hay handler para la fase ${effectiveState.phase}`);
    }

    const { state, response } = await handler.handle(payload, effectiveState);
    await this.saveConversationState(state);

    return response;
  }

  private async processTrackingRequest(
    payload: AiInboundPayloadDto,
    state: ConversationState,
  ) {
    const trackingCode = this.support.extractTrackingCode(
      payload.consolidatedText,
    );
    if (!trackingCode) {
      return {
        status: 'tracking_invalid',
        assistantMessage: 'No pude identificar el código de seguimiento.',
        state,
      };
    }

    const result = await this.support.getPublicTracking(
      trackingCode,
      payload.contactKey,
    );
    const assistantMessage = result.data
      ? `El reclamo ${result.data.trackingCode} se encuentra ${this.publicStatusLabel(result.data.status)}. Última actualización: ${new Date(result.data.updatedAt).toLocaleDateString('es-AR')}.`
      : 'No encontré un reclamo asociado a ese código y a este contacto.';

    const nextState = this.support.appendAsistente(
      {
        ...state,
        mensajes: [
          ...(state.mensajes || []),
          this.support.makeMensaje('usuario', payload.consolidatedText),
        ],
      },
      assistantMessage,
    );

    return {
      correlationId: payload.correlationId,
      contactKey: payload.contactKey,
      status: result.data ? 'tracking_found' : 'tracking_not_found',
      shouldAskAgain: false,
      assistantMessage,
      state: nextState,
    };
  }

  private async processCitizenResponse(
    payload: AiInboundPayloadDto,
    state: ConversationState,
  ) {
    const trackingCode = this.support.extractTrackingCode(
      payload.consolidatedText,
    );
    const type = this.support.citizenResponseType(payload.consolidatedText);
    const tracking = trackingCode
      ? await this.support.getPublicTracking(trackingCode, payload.contactKey)
      : { status: 'not_found', data: null };

    if (!tracking.data) {
      return {
        correlationId: payload.correlationId,
        contactKey: payload.contactKey,
        status: 'citizen_response_not_found',
        shouldAskAgain: false,
        assistantMessage: 'No pude validar ese reclamo con este contacto.',
        state,
      };
    }

    if (type === 'disconforme' && tracking.data.status === 'cerrado') {
      await this.support.reopenCitizen(
        trackingCode!,
        payload.contactKey,
        payload.consolidatedText,
      );
    } else {
      await this.support.submitCitizenResponse(
        tracking.data.claimId,
        type,
        payload.contactKey,
        payload.consolidatedText,
      );
    }

    const assistantMessage =
      type === 'confirmada'
        ? 'Gracias por confirmar la resolución de tu reclamo.'
        : 'Registramos tu disconformidad y mantendremos el reclamo en seguimiento.';
    const nextState = this.support.appendAsistente(state, assistantMessage);
    return {
      correlationId: payload.correlationId,
      contactKey: payload.contactKey,
      status:
        type === 'confirmada' ? 'citizen_response_recorded' : 'claim_reopened',
      shouldAskAgain: false,
      assistantMessage,
      state: nextState,
    };
  }

  private publicStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      pendiente: 'pendiente',
      en_proceso: 'en proceso',
      resuelto: 'resuelto',
      rechazado: 'rechazado',
      cerrado: 'cerrado',
    };
    return labels[status] || 'en proceso';
  }

  private buildInitialState(contactKey: string): ConversationState {
    return {
      contactKey,
      phase: 'awaiting_identity_and_claim',
      greeted: false,
      mensajes: [],
      updatedAt: new Date().toISOString(),
    };
  }

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

  private intFromConfig(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = raw ? Number(raw) : NaN;

    if (Number.isNaN(parsed)) {
      return fallback;
    }

    return Math.max(Math.trunc(parsed), 1);
  }
}
