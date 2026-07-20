import { Injectable } from '@nestjs/common';
import { AiInboundPayloadDto } from '../../ai-process/dto/ai-inbound-payload.dto';
import {
  ConversationPhase,
  ConversationState,
} from '../../ai-process/types/conversation-state.type';
import { ConversationStateSupportService } from '../conversation-state-support.service';
import {
  ConversationStateHandler,
  ConversationStateHandlerResult,
} from './conversation-state-handler.interface';

@Injectable()
export class AwaitingIdentityAndClaimState implements ConversationStateHandler {
  constructor(private readonly support: ConversationStateSupportService) {}

  canHandle(phase: ConversationPhase): boolean {
    return phase === 'awaiting_identity_and_claim';
  }

  async handle(
    payload: AiInboundPayloadDto,
    state: ConversationState,
  ): Promise<ConversationStateHandlerResult> {
    const greetingMessage =
      'Hola, gracias por contactarnos. Para crear tu reclamo envianos en un solo mensaje: correo o DNI, descripcion del problema y direccion exacta.';

    const newState: ConversationState = {
      ...state,
      contactKey: payload.contactKey,
      phase: 'collecting_claim_data',
      greeted: true,
      mensajes: [
        ...(state.mensajes || []),
        this.support.makeMensaje('usuario', payload.consolidatedText),
        this.support.makeMensaje('asistente', greetingMessage),
      ],
      updatedAt: new Date().toISOString(),
    };

    return {
      state: newState,
      response: {
        correlationId: payload.correlationId,
        contactKey: payload.contactKey,
        status: 'awaiting_user_data',
        shouldAskAgain: true,
        assistantMessage: greetingMessage,
        state: newState,
      },
    };
  }
}
