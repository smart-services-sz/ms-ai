import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiProcessModule } from './ai-process/ai-process.module';
import { RedisModule } from './redis/redis.module';
import { AuditLoggingModule } from './audit/audit-logging.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    RedisModule,
    AiProcessModule,
    AuditLoggingModule,
  ],
})
export class AppModule {}
