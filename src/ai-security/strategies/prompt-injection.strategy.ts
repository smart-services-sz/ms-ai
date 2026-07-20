import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InputSecurityStrategy } from './input-security-strategy.interface';

@Injectable()
export class PromptInjectionStrategy implements InputSecurityStrategy {
  private readonly logger = new Logger(PromptInjectionStrategy.name);

  private readonly injectionPatterns = [
    /ignore\s+(all|previous|instructions|system|rules)/gi,
    /ignora/gi,
    /olvid[ae]/gi,
    /forget\s+(all|previous|instructions|system|rules)/gi,
    /system\s*:\s*/gi,
    /you\s+are\s+now/gi,
    /act\s+as\s+(?!un\s+asistente)/gi,
    /actúa\s+como/gi,
    /pretend\s+(?!to\s+be)/gi,
    /role\s*play/gi,
    /jailbreak/gi,
    /bypass/gi,
    /override/gi,
    /administrator\s+mode/gi,
    /modo\s+administrador/gi,
    /developer\s+mode/gi,
    /DAN\s+\d+/gi,
    /\[SYSTEM_OVERRIDE\]/gi,
    /\[UNRESTRICTED\]/gi,
  ];

  validate(input: string, clientId?: string): void {
    for (const pattern of this.injectionPatterns) {
      if (pattern.test(input)) {
        this.logger.warn(
          `Intento de prompt injection detectado: "${input.substring(0, 100)}" | clientId=${clientId}`,
        );
        throw new BadRequestException(
          'Solicitud rechazada por validación de seguridad.',
        );
      }
    }
  }
}
