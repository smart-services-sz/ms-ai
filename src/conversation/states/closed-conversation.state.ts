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
export class ClosedConversationState implements ConversationStateHandler {
  constructor(private readonly support: ConversationStateSupportService) {}

  canHandle(phase: ConversationPhase): boolean {
    return phase === 'closed';
  }

  async handle(
    payload: AiInboundPayloadDto,
    state: ConversationState,
  ): Promise<ConversationStateHandlerResult> {
    if (this.support.isGreetingMessage(payload.consolidatedText)) {
      const greetingMessage =
        'Hola de nuevo. Si queres crear otro reclamo, enviame en un solo mensaje: correo o DNI, descripcion del problema y direccion exacta.';

      const reopenedByGreeting: ConversationState = {
        contactKey: payload.contactKey,
        phase: 'collecting_claim_data',
        greeted: true,
        mensajes: [
          this.support.makeMensaje('usuario', payload.consolidatedText),
          this.support.makeMensaje('asistente', greetingMessage),
        ],
        updatedAt: new Date().toISOString(),
      };

      return {
        state: reopenedByGreeting,
        response: {
          correlationId: payload.correlationId,
          contactKey: payload.contactKey,
          status: 'conversation_reopened_by_greeting',
          shouldAskAgain: true,
          assistantMessage: greetingMessage,
          state: reopenedByGreeting,
        },
      };
    }

    const shouldRestart = this.support.shouldRestartAfterClosure(payload.consolidatedText);
    if (!shouldRestart) {
      const closedState: ConversationState = {
        ...state,
        updatedAt: new Date().toISOString(),
      };

      return {
        state: closedState,
        response: {
          correlationId: payload.correlationId,
          contactKey: payload.contactKey,
          status: 'conversation_closed_no_action',
          shouldAskAgain: false,
          state: closedState,
        },
      };
    }

    const reopenedState: ConversationState = {
      contactKey: payload.contactKey,
      phase: 'collecting_claim_data',
      greeted: true,
      mensajes: [this.support.makeMensaje('usuario', payload.consolidatedText)],
      updatedAt: new Date().toISOString(),
    };

    const restartMessage =
      'Perfecto, iniciemos un nuevo reclamo. Enviame en un solo mensaje: correo o DNI, descripcion del problema y direccion exacta.';
    const restartedState = this.support.appendAsistente(reopenedState, restartMessage);

    return {
      state: restartedState,
      response: {
        correlationId: payload.correlationId,
        contactKey: payload.contactKey,
        status: 'conversation_restarted',
        shouldAskAgain: true,
        assistantMessage: restartMessage,
        state: restartedState,
      },
    };
  }
}
