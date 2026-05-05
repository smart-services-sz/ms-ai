import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { AiInboundPayloadDto } from './dto/ai-inbound-payload.dto';
import { AiProcessService } from './ai-process.service';

@Controller()
export class AiProcessController {
  private readonly logger = new Logger(AiProcessController.name);

  constructor(private readonly aiProcessService: AiProcessService) {}

  // Suscriptor NATS del tópico 'ai.process-inbound-message'.
  // Recibe el lote consolidado desde el gateway (debounce ya aplicado)
  // y lo delega al servicio de procesamiento conversacional.
  @MessagePattern('ai.process-inbound-message')
  processInboundMessage(@Payload() payload: AiInboundPayloadDto) {
    this.logger.log(
      `[${payload.correlationId}] Tópico ai.process-inbound-message recibido`,
    );

    return this.aiProcessService.processInboundMessage(payload);
  }
}
