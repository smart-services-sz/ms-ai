import { AwaitingIdentityAndClaimState } from './awaiting-identity-and-claim.state';
import { ConversationStateSupportService } from '../conversation-state-support.service';
import { ChannelIdentityType, ChannelType } from '../../ai-process/dto/ai-inbound-payload.dto';

const payload = {
  correlationId: '123e4567-e89b-42d3-a456-426614174000',
  contactKey: 'whatsapp:phone:54911',
  channel: ChannelType.WHATSAPP,
  channelIdentity: {
    type: ChannelIdentityType.PHONE,
    value: '54911',
    normalizedValue: '54911',
  },
  consolidatedText: 'Hola',
  messageCount: 1,
  messages: [],
  firstReceivedAt: new Date().toISOString(),
  lastReceivedAt: new Date().toISOString(),
};

describe('AwaitingIdentityAndClaimState', () => {
  it('should transition to collecting_claim_data with greeting', async () => {
    const support = {
      makeMensaje: jest.fn((origen: 'usuario' | 'asistente', texto: string) => ({
        origen,
        texto,
        creadoEn: new Date().toISOString(),
      })),
    } as unknown as ConversationStateSupportService;

    const handler = new AwaitingIdentityAndClaimState(support);
    const result = await handler.handle(payload, {
      contactKey: payload.contactKey,
      phase: 'awaiting_identity_and_claim',
      greeted: false,
      mensajes: [],
      updatedAt: new Date().toISOString(),
    });

    expect(handler.canHandle('awaiting_identity_and_claim')).toBe(true);
    expect(result.state.phase).toBe('collecting_claim_data');
    expect(result.state.greeted).toBe(true);
    expect(result.response.status).toBe('awaiting_user_data');
  });
});
