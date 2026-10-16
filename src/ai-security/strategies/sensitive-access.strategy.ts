import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InputSecurityStrategy } from './input-security-strategy.interface';

@Injectable()
export class SensitiveAccessStrategy implements InputSecurityStrategy {
  private readonly logger = new Logger(SensitiveAccessStrategy.name);

  private readonly sensitiveRequests = [
    'contraseña',
    'password',
    'clave',
    'api_key',
    'token',
    'secret',
    'base de datos',
    'database',
    'credential',
    'config',
    'configuración',
    'usuario',
    'admin',
    'administrador',
    'directorio',
    'archivo',
    'hacker',
    'exploit',
    'vulnerabilidad',
    'sql injection',
    'xss',
  ];

  validate(input: string, _clientId?: string): void {
    const lowerInput = input.toLowerCase();

    for (const keyword of this.sensitiveRequests) {
      if (lowerInput.includes(keyword)) {
        this.logger.warn(
          `Intento de acceso a información sensible | inputLength=${input.length} | category=sensitive_access`,
        );
        throw new BadRequestException(
          'Solicitud rechazada por validación de seguridad.',
        );
      }
    }
  }
}
