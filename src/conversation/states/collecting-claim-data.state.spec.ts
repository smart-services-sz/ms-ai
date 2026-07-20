import { CollectingClaimDataState } from './collecting-claim-data.state';
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
  consolidatedText: 'Hay un bache en calle Belgrano 123, mi dni 12345678',
  messageCount: 1,
  messages: [],
  firstReceivedAt: new Date().toISOString(),
  lastReceivedAt: new Date().toISOString(),
};

describe('CollectingClaimDataState', () => {
  it('should keep collecting when required data is missing', async () => {
    const support = {
      isGreetingMessage: jest.fn().mockReturnValue(false),
      parseClaimText: jest.fn().mockResolvedValue({
        understood: true,
        confidence: 0.9,
        problema: 'bache',
      }),
      makeMensaje: jest.fn((origen: 'usuario' | 'asistente', texto: string) => ({
        origen,
        texto,
        creadoEn: new Date().toISOString(),
      })),
      appendAsistente: jest.fn((state, text) => ({
        ...state,
        mensajes: [...(state.mensajes || []), { origen: 'asistente', texto: text, creadoEn: new Date().toISOString() }],
        updatedAt: new Date().toISOString(),
      })),
      computeMissingFields: jest.fn().mockReturnValue(['correo o DNI', 'direccion']),
    } as unknown as ConversationStateSupportService;

    const handler = new CollectingClaimDataState(support);
    const result = await handler.handle(payload, {
      contactKey: payload.contactKey,
      phase: 'collecting_claim_data',
      greeted: true,
      mensajes: [],
      updatedAt: new Date().toISOString(),
    });

    expect(handler.canHandle('collecting_claim_data')).toBe(true);
    expect(result.state.phase).toBe('collecting_claim_data');
    expect(result.response.status).toBe('missing_required_data');
  });

  it('should close state when claim is created', async () => {
    const support = {
      isGreetingMessage: jest.fn().mockReturnValue(false),
      parseClaimText: jest.fn().mockResolvedValue({
        understood: true,
        confidence: 0.95,
        correo: 'test@example.com',
        problema: 'bache',
        direccion: 'Belgrano 123',
        categoria: 'baches_y_pavimento',
        prioridad: 'media',
      }),
      makeMensaje: jest.fn((origen: 'usuario' | 'asistente', texto: string) => ({
        origen,
        texto,
        creadoEn: new Date().toISOString(),
      })),
      appendAsistente: jest.fn((state, text) => ({
        ...state,
        mensajes: [...(state.mensajes || []), { origen: 'asistente', texto: text, creadoEn: new Date().toISOString() }],
        updatedAt: new Date().toISOString(),
      })),
      computeMissingFields: jest.fn(),
      createClaim: jest.fn().mockResolvedValue({
        success: true,
        reclamo: {
          reclamoId: '1',
          trackingCode: 'TRK-1',
          status: 'created',
          createdAt: new Date().toISOString(),
          message: 'Reclamo creado',
          data: { lat: -34.6, lng: -58.4, direccion: 'Belgrano 123', problema: 'bache' },
        },
      }),
      getAllowedAreasLabel: jest.fn(),
    } as unknown as ConversationStateSupportService;

    const handler = new CollectingClaimDataState(support);
    const result = await handler.handle(payload, {
      contactKey: payload.contactKey,
      phase: 'collecting_claim_data',
      greeted: true,
      mensajes: [],
      updatedAt: new Date().toISOString(),
    });

    expect(result.state.phase).toBe('closed');
    expect(result.response.status).toBe('claim_created');
  });
});
