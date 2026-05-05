import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisClientType, createClient } from 'redis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: RedisClientType;

  constructor(private readonly configService: ConfigService) {
    const redisUrl =
      this.configService.get<string>('REDIS_URL') || 'redis://localhost:6379';

    this.client = createClient({ url: redisUrl });

    this.client.on('error', (error: unknown) => {
      this.logger.error('Redis error', error);
    });
  }

  async onModuleInit() {
    if (this.client.isOpen) {
      return;
    }

    await this.client.connect();
    this.logger.log('Redis conectado correctamente');
  }

  async onModuleDestroy() {
    if (!this.client.isOpen) {
      return;
    }

    await this.client.quit();
    this.logger.log('Redis desconectado correctamente');
  }

  getClient(): RedisClientType {
    return this.client;
  }
}