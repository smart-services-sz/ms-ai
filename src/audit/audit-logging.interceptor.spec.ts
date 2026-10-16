import { of } from 'rxjs';
import { AUDIT_NATS_CLIENT, AUDIT_SERVICE_NAME, AuditLoggingInterceptor } from './audit-logging.interceptor';

describe('AuditLoggingInterceptor', () => {
  it('records NATS operation metadata without copying payload content', async () => {
    const emit = jest.fn().mockReturnValue(of(undefined));
    const interceptor = new AuditLoggingInterceptor({ emit } as never, 'ms-ai');
    const payload = {
      data: {
        correlationId: '123e4567-e89b-42d3-a456-426614174000',
        consolidatedText: 'DNI 12345678 calle confidencial',
        contactKey: 'whatsapp:phone:5491112345678',
      },
      context: { userId: 'user-1', municipalityId: 'funes' },
    };
    const context = {
      switchToRpc: () => ({
        getContext: () => ({ getSubject: () => 'ai.process-inbound-message' }),
        getData: () => payload,
      }),
      getHandler: () => ({ name: 'handleInbound' }),
    };

    await new Promise<void>((resolve, reject) => {
      interceptor.intercept(context as never, { handle: () => of({ ok: true }) } as never)
        .subscribe({ complete: resolve, error: reject });
    });

    expect(emit).toHaveBeenCalledWith('audit.log', expect.objectContaining({
      service: 'ms-ai',
      action: 'NATS.ai.process-inbound-message.SUCCESS',
      performedBy: 'user-1',
      municipalityId: 'funes',
      correlationId: payload.data.correlationId,
      metadata: expect.objectContaining({ transport: 'nats', outcome: 'success' }),
    }));
    const serialized = JSON.stringify(emit.mock.calls[0][1]);
    expect(serialized).not.toContain(payload.data.consolidatedText);
    expect(serialized).not.toContain(payload.data.contactKey);
    expect(AUDIT_NATS_CLIENT).toBe('AUDIT_NATS_CLIENT');
    expect(AUDIT_SERVICE_NAME).toBe('AUDIT_SERVICE_NAME');
  });
});