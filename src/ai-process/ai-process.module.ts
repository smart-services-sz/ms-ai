import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { AiProcessController } from './ai-process.controller';
import { AiProcessService } from './ai-process.service';
import { AiInterpreterService } from './ai-interpreter.service';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'NATS_CLIENT',
        transport: Transport.NATS,
        options: {
          servers: [process.env.NATS_SERVERS || 'nats://localhost:4222'],
        },
      },
    ]),
  ],
  controllers: [AiProcessController],
  providers: [AiProcessService, AiInterpreterService],
})
export class AiProcessModule {}
