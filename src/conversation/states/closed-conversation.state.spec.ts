import { ClosedConversationState } from './closed-conversation.state';
import { ConversationStateSupportService } from '../conversation-state-support.service';
import { ChannelIdentityType, ChannelType } from '../../ai-process/dto/ai-inbound-payload.dto';

const basePayload = {
  correlationId: '123e4567-e89b-42d3-a456-426614174000',
  contactKey: 'whatsapp:phone:54911',
  channel: ChannelType.WHATSAPP,
  channelIdentity: {
    type: ChannelIdentityType.PHONE,
    value: '54911',
    normalizedValue: '54911',
  },
  consolidatedText: 'hola',
  messageCount: 1,
  messages: [],
  firstReceivedAt: new Date().toISOString(),
  lastReceivedAt: new Date().toISOString(),
};

describe('ClosedConversationState', () => {
  it('should reopen by greeting', async () => {
    const support = {
      isGreetingMessage: jest.fn().mockReturnValue(true),
      shouldRestartAfterClosure: jest.fn().mockReturnValue(false),
      makeMensaje: jest.fn((origen: 'usuario' | 'asistente', texto: string) => ({
        origen,
        texto,
        creadoEn: new Date().toISOString(),
      })),
      appendAsistente: jest.fn(),
    } as unknown as ConversationStateSupportService;

    const handler = new ClosedConversationState(support);
    const result = await handler.handle(basePayload, {
      contactKey: basePayload.contactKey,
      phase: 'closed',
      greeted: true,
      mensajes: [],
      updatedAt: new Date().toISOString(),
    });

    expect(handler.canHandle('closed')).toBe(true);
    expect(result.state.phase).toBe('collecting_claim_data');
    expect(result.response.status).toBe('conversation_reopened_by_greeting');
  });

  it('should keep closed when no restart signal', async () => {
    const support = {
      isGreetingMessage: jest.fn().mockReturnValue(false),
      shouldRestartAfterClosure: jest.fn().mockReturnValue(false),
      makeMensaje: jest.fn(),
      appendAsistente: jest.fn(),
    } as unknown as ConversationStateSupportService;

    const handler = new ClosedConversationState(support);
    const currentState = {
      contactKey: basePayload.contactKey,
      phase: 'closed' as const,
      greeted: true,
      mensajes: [],
      updatedAt: new Date().toISOString(),
    };

    const result = await handler.handle(basePayload, currentState);

    expect(result.state.phase).toBe('closed');
    expect(result.response.status).toBe('conversation_closed_no_action');
  });
});
