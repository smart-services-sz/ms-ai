import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { randomUUID } from 'node:crypto';
import { catchError, finalize, throwError } from 'rxjs';

export const AUDIT_NATS_CLIENT = 'AUDIT_NATS_CLIENT';
export const AUDIT_SERVICE_NAME = 'AUDIT_SERVICE_NAME';

type SafeRecord = Record<string, unknown>;

@Injectable()
export class AuditLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLoggingInterceptor.name);

  constructor(
    @Inject(AUDIT_NATS_CLIENT) private readonly natsClient: ClientProxy,
    @Inject(AUDIT_SERVICE_NAME) private readonly serviceName: string,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const startedAt = Date.now();
    const rpcContext = context.switchToRpc().getContext<{ getSubject?: () => string }>();
    const payload = this.asRecord(context.switchToRpc().getData());
    const data = this.asRecord(payload?.data) ?? payload;
    const requestContext = this.asRecord(payload?.context);
    const subject = rpcContext?.getSubject?.() ?? context.getHandler().name;
    const operation = this.safeLabel(subject, 100);
    const correlationId = this.safeValue(
      data?.correlationId ?? requestContext?.correlationId ?? payload?.correlationId,
      100,
    ) ?? randomUUID();
    const actorId = this.safeValue(
      requestContext?.userId ?? data?.actorId ?? data?.performedBy,
      128,
    );
    const entityId = this.safeValue(
      data?.id ?? data?.reclamoId ?? data?.planId ?? data?.routeId ?? data?.interventionId ?? data?.stopId,
      128,
    );
    const municipalityId = this.safeValue(
      requestContext?.municipalityId ?? data?.municipalityId,
      100,
    );
    let outcome: 'success' | 'error' = 'success';
    let errorCode: string | undefined;

    return next.handle().pipe(
      catchError((error: unknown) => {
        outcome = 'error';
        errorCode = error instanceof Error ? error.name : 'UnknownError';
        return throwError(() => error);
      }),
      finalize(() => this.publish({
        operation,
        correlationId,
        actorId,
        entity: this.entityName(operation),
        entityId,
        municipalityId,
        outcome,
        errorCode,
        durationMs: Date.now() - startedAt,
      })),
    );
  }

  private publish(event: {
    operation: string;
    correlationId: string;
    actorId?: string;
    entity: string;
    entityId?: string;
    municipalityId?: string;
    outcome: 'success' | 'error';
    errorCode?: string;
    durationMs: number;
  }) {
    const eventId = randomUUID();
    this.natsClient.emit('audit.log', {
      eventId,
      service: this.serviceName,
      action: `NATS.${event.operation}.${event.outcome.toUpperCase()}`.slice(0, 120),
      entity: event.entity,
      entityId: event.entityId,
      performedBy: event.actorId,
      municipalityId: event.municipalityId,
      correlationId: event.correlationId,
      level: event.outcome === 'error' ? 'ERROR' : 'INFO',
      metadata: {
        transport: 'nats',
        operation: event.operation,
        outcome: event.outcome,
        durationMs: event.durationMs,
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      },
      timestamp: new Date().toISOString(),
    }).subscribe({
      error: () => this.logger.warn(`[${event.correlationId}] audit publish failed | eventId=${eventId}`),
    });
  }

  private asRecord(value: unknown): SafeRecord | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as SafeRecord
      : undefined;
  }

  private safeValue(value: unknown, maxLength: number): string | undefined {
    return typeof value === 'string' && value.length > 0
      ? value.slice(0, maxLength)
      : undefined;
  }

  private safeLabel(value: string, maxLength: number): string {
    return value.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, maxLength);
  }

  private entityName(operation: string): string {
    if (/reclamo|claim/i.test(operation)) return 'Reclamo';
    if (/routing|route|plan|intervention|evidence/i.test(operation)) return 'Routing';
    if (/municipal/i.test(operation)) return 'Municipality';
    if (/notification/i.test(operation)) return 'Notification';
    if (/geo/i.test(operation)) return 'GeocodingRequest';
    if (/ai|conversation/i.test(operation)) return 'Conversation';
    return 'ServiceOperation';
  }
}