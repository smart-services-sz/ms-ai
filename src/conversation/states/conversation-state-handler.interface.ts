import { AiInboundPayloadDto } from '../../ai-process/dto/ai-inbound-payload.dto';
import {
  ConversationPhase,
  ConversationState,
} from '../../ai-process/types/conversation-state.type';

export const CONVERSATION_STATE_HANDLERS = 'CONVERSATION_STATE_HANDLERS';

export type ConversationStateHandlerResult = {
  state: ConversationState;
  response: Record<string, unknown>;
};

export interface ConversationStateHandler {
  canHandle(phase: ConversationPhase): boolean;

  handle(
    payload: AiInboundPayloadDto,
    state: ConversationState,
  ): Promise<ConversationStateHandlerResult>;
}
