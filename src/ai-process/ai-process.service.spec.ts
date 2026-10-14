import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AiProcessService } from './ai-process.service';
import { RedisService } from '../redis/redis.service';
import {
  CONVERSATION_STATE_HANDLERS,
  ConversationStateHandler,
} from '../conversation/states/conversation-state-handler.interface';
import { ConversationStateSupportService } from '../conversation/conversation-state-support.service';
import { ChannelIdentityType, ChannelType } from './dto/ai-inbound-payload.dto';

describe('AiProcessService', () => {
  it('handles a WhatsApp citizen reply before invoking claim parsing handlers', async () => {
    const redisClient = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const support = {
      getAllowedAreaTokens: jest.fn().mockReturnValue(['Funes']),
      handleCitizenFollowup: jest.fn().mockResolvedValue({
        status: 'citizen_response_recorded',
        assistantMessage: 'Gracias por confirmar.',
      }),
      makeMensaje: jest.fn((origen: 'usuario' | 'asistente', texto: string) => ({
        origen,
        texto,
        creadoEn: new Date().toISOString(),
      })),
    };
    const handler: ConversationStateHandler = {
      canHandle: jest.fn().mockReturnValue(true),
      handle: jest.fn(),
    };
    const service = new AiProcessService(
      { getClient: () => redisClient } as unknown as RedisService,
      {
        get: jest.fn((key: string, fallback?: string) =>
          key === 'AI_CONVERSATION_TTL_SECONDS' ? '86400' : fallback,
        ),
      } as unknown as ConfigService,
      support as unknown as ConversationStateSupportService,
      [handler],
    );

    const result = await service.processInboundMessage({
      correlationId: '123e4567-e89b-42d3-a456-426614174000',
      contactKey: 'whatsapp:phone:5493415551234',
      channel: ChannelType.WHATSAPP,
      channelIdentity: {
        type: ChannelIdentityType.PHONE,
        value: '+5493415551234',
        normalizedValue: '5493415551234',
      },
      consolidatedText: 'REC-ABC123 CONFORME',
      messageCount: 1,
      messages: [],
      firstReceivedAt: new Date().toISOString(),
      lastReceivedAt: new Date().toISOString(),
    });

    expect(result).toMatchObject({
      status: 'citizen_response_recorded',
      assistantMessage: 'Gracias por confirmar.',
      state: { phase: 'awaiting_identity_and_claim' },
    });
    expect(handler.handle).not.toHaveBeenCalled();
    expect(redisClient.set).toHaveBeenCalledWith(
      expect.stringContaining('whatsapp:phone:5493415551234'),
      expect.stringContaining('REC-ABC123 CONFORME'),
      { EX: 86400 },
    );
  });

  it('should select the correct handler by phase', async () => {
    const redisClientMock = {
      get: jest.fn().mockResolvedValue(
        JSON.stringify({
          contactKey: 'whatsapp:phone:54911',
          phase: 'closed',
          greeted: true,
          mensajes: [],
          updatedAt: new Date().toISOString(),
        }),
      ),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const closedHandler: ConversationStateHandler = {
      canHandle: jest.fn().mockReturnValue(true),
      handle: jest.fn().mockResolvedValue({
        state: {
          contactKey: 'whatsapp:phone:54911',
          phase: 'closed',
          greeted: true,
          mensajes: [],
          updatedAt: new Date().toISOString(),
        },
        response: { status: 'conversation_closed_no_action' },
      }),
    };

    const collectingHandler: ConversationStateHandler = {
      canHandle: jest.fn().mockReturnValue(false),
      handle: jest.fn(),
    };

    const awaitingHandler: ConversationStateHandler = {
      canHandle: jest.fn().mockReturnValue(false),
      handle: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiProcessService,
        {
          provide: RedisService,
          useValue: { getClient: jest.fn(() => redisClientMock) },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'AI_CONVERSATION_TTL_SECONDS') return '86400';
              return defaultValue;
            }),
          },
        },
        {
          provide: ConversationStateSupportService,
          useValue: {
            getAllowedAreaTokens: jest.fn().mockReturnValue(['CABA']),
            handleCitizenFollowup: jest.fn().mockResolvedValue(null),
            makeMensaje: jest.fn((origen: 'usuario' | 'asistente', texto: string) => ({
              origen,
              texto,
              creadoEn: new Date().toISOString(),
            })),
          },
        },
        {
          provide: CONVERSATION_STATE_HANDLERS,
          useValue: [awaitingHandler, collectingHandler, closedHandler],
        },
      ],
    }).compile();

    const service = module.get<AiProcessService>(AiProcessService);

    const result = await service.processInboundMessage({
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
    });

    expect(closedHandler.canHandle).toHaveBeenCalledWith('closed');
    expect(closedHandler.handle).toHaveBeenCalled();
    expect(result).toEqual({ status: 'conversation_closed_no_action' });
    expect(redisClientMock.set).toHaveBeenCalled();
  });
});
