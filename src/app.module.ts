import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiProcessModule } from './ai-process/ai-process.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    RedisModule,
    AiProcessModule,
  ],
})
export class AppModule {}
