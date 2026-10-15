import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiInboundPayloadDto } from './dto/ai-inbound-payload.dto';
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

    if (!this.configService.get<string>('AI_MUNICIPALITY_ID')) {
      this.logger.warn(
        'AI_MUNICIPALITY_ID no esta configurado; las altas conversacionales quedaran bloqueadas',
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

    const citizenFollowup = await this.support.handleCitizenFollowup(payload);
    if (citizenFollowup) {
      const state: ConversationState = {
        ...currentState,
        contactKey: payload.contactKey,
        phase: currentState.phase,
        greeted: currentState.greeted,
        mensajes: [
          ...(currentState.mensajes || []),
          this.support.makeMensaje('usuario', payload.consolidatedText),
          this.support.makeMensaje('asistente', citizenFollowup.assistantMessage),
        ].slice(-40),
        updatedAt: new Date().toISOString(),
      };
      await this.saveConversationState(state);
      return {
        correlationId: payload.correlationId,
        contactKey: payload.contactKey,
        status: citizenFollowup.status,
        shouldAskAgain: false,
        assistantMessage: citizenFollowup.assistantMessage,
        state,
      };
    }

    const effectiveState = currentState.greeted
      ? currentState
      : { ...currentState, phase: 'awaiting_identity_and_claim' as ConversationPhase };

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
