import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InputSecurityStrategy } from './input-security-strategy.interface';

@Injectable()
export class InputLengthStrategy implements InputSecurityStrategy {
  private readonly logger = new Logger(InputLengthStrategy.name);
  private readonly maxInputLength: number;

  constructor(private readonly configService: ConfigService) {
    this.maxInputLength =
      this.configService.get<number>('AI_MAX_INPUT_LENGTH') || 2000;
  }

  validate(input: string, _clientId?: string): void {
    if (!input || typeof input !== 'string') {
      throw new BadRequestException('Input inválido o vacío');
    }

    if (input.length > this.maxInputLength) {
      this.logger.warn(
        `Input rechazado por longitud excesiva | inputLength=${input.length} | maxLength=${this.maxInputLength}`,
      );
      throw new BadRequestException(
        `Mensaje demasiado largo. Máximo ${this.maxInputLength} caracteres.`,
      );
    }
  }
}
