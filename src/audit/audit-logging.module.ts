import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ClientsModule, Transport } from '@nestjs/microservices';
import {
  AUDIT_NATS_CLIENT,
  AUDIT_SERVICE_NAME,
  AuditLoggingInterceptor,
} from './audit-logging.interceptor';

@Module({
  imports: [
    ClientsModule.register([{
      name: AUDIT_NATS_CLIENT,
      transport: Transport.NATS,
      options: { servers: [process.env.NATS_SERVERS || 'nats://localhost:4222'] },
    }]),
  ],
  providers: [
    { provide: AUDIT_SERVICE_NAME, useValue: 'ms-ai' },
    { provide: APP_INTERCEPTOR, useClass: AuditLoggingInterceptor },
  ],
})
export class AuditLoggingModule {}