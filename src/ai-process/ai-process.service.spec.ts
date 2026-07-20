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
          useValue: { getAllowedAreaTokens: jest.fn().mockReturnValue(['CABA']) },
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
