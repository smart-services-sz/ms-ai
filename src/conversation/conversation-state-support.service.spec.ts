import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import { AiInterpreterService } from '../ai-process/ai-interpreter.service';
import { AiInboundPayloadDto, ChannelType } from '../ai-process/dto/ai-inbound-payload.dto';
import { ConversationStateSupportService } from './conversation-state-support.service';

describe('ConversationStateSupportService citizen followup', () => {
  const payload = (text: string): AiInboundPayloadDto => ({
    correlationId: '123e4567-e89b-42d3-a456-426614174000',
    contactKey: 'whatsapp:phone:5493415551234',
    channel: ChannelType.WHATSAPP,
    channelIdentity: {
      type: 'phone',
      value: '+5493415551234',
      normalizedValue: '5493415551234',
    },
    consolidatedText: text,
    messageCount: 1,
    messages: [],
    firstReceivedAt: new Date().toISOString(),
    lastReceivedAt: new Date().toISOString(),
  });

  let natsClient: { send: jest.Mock };
  let service: ConversationStateSupportService;

  beforeEach(() => {
    natsClient = {
      send: jest.fn().mockReturnValue(
        of({ status: 'ok', data: { trackingCode: 'REC-ABC123', status: 'resuelto', category: 'alumbrado', updatedAt: '2026-10-14T12:00:00.000Z' } }),
      ),
    };
    service = new ConversationStateSupportService(
      {} as AiInterpreterService,
      { get: jest.fn((_key: string, fallback?: string) => fallback) } as unknown as ConfigService,
      natsClient as never,
    );
  });

  it('records a confirmation against code and canonical WhatsApp contact', async () => {
    await expect(
      service.handleCitizenFollowup(payload('REC-ABC123 CONFORME')),
    ).resolves.toMatchObject({ status: 'citizen_response_recorded' });

    expect(natsClient.send).toHaveBeenNthCalledWith(
      1,
      'reclamos.public-tracking',
      { codigoSeguimiento: 'REC-ABC123', contacto: '5493415551234' },
    );
    expect(natsClient.send).toHaveBeenNthCalledWith(
      2,
      'reclamos.citizen.response',
      expect.objectContaining({
        trackingCode: 'REC-ABC123',
        tipo: 'confirmada',
        contactKey: payload('').contactKey,
      }),
    );
  });

  it('records disconformity and preserves the citizen comment', async () => {
    await service.handleCitizenFollowup(
      payload('REC-ABC123 DISCONFORME: la luminaria sigue apagada'),
    );

    expect(natsClient.send).toHaveBeenNthCalledWith(
      2,
      'reclamos.citizen.response',
      expect.objectContaining({
        tipo: 'disconforme',
        comentario: 'la luminaria sigue apagada',
      }),
    );
  });

  it('reopens the claim when the citizen requests a new intervention', async () => {
    await service.handleCitizenFollowup(
      payload('REC-ABC123 REABRIR: sigue sin resolverse'),
    );

    expect(natsClient.send).toHaveBeenNthCalledWith(
      2,
      'reclamos.citizen.reopen',
      expect.objectContaining({
        trackingCode: 'REC-ABC123',
        contactKey: payload('').contactKey,
        motivo: 'sigue sin resolverse',
      }),
    );
  });

  it('reopens a closed claim after a disconformity response', async () => {
    natsClient.send.mockReturnValueOnce(
      of({
        status: 'ok',
        data: {
          trackingCode: 'REC-ABC123',
          status: 'cerrado',
          category: 'alumbrado',
          updatedAt: '2026-10-14T12:00:00.000Z',
        },
      }),
    );

    await expect(
      service.handleCitizenFollowup(
        payload('REC-ABC123 DISCONFORME: sigue sin resolverse'),
      ),
    ).resolves.toMatchObject({ status: 'claim_reopened' });
    expect(natsClient.send).toHaveBeenNthCalledWith(
      2,
      'reclamos.citizen.reopen',
      expect.objectContaining({ motivo: 'sigue sin resolverse' }),
    );
  });

  it('returns public tracking status when the citizen asks about the claim', async () => {
    await expect(
      service.handleCitizenFollowup(payload('Cual es el estado de REC-ABC123?')),
    ).resolves.toMatchObject({
      status: 'tracking_found',
      assistantMessage: expect.stringContaining('se encuentra resuelto'),
    });
    expect(natsClient.send).toHaveBeenCalledTimes(1);
  });

  it('does not invoke reclamo actions when code/contact do not match', async () => {
    natsClient.send.mockReturnValueOnce(of({ status: 'not_found', data: null }));

    await expect(
      service.handleCitizenFollowup(payload('REC-ABC123 CONFORME')),
    ).resolves.toMatchObject({
      status: 'citizen_response_not_found',
      assistantMessage: expect.stringContaining('No pude validar'),
    });
    expect(natsClient.send).toHaveBeenCalledTimes(1);
  });

  it('leaves unrelated messages to the regular conversation flow', async () => {
    await expect(
      service.handleCitizenFollowup(payload('Hola, quiero hacer un reclamo')),
    ).resolves.toBeNull();
    expect(natsClient.send).not.toHaveBeenCalled();
  });
});