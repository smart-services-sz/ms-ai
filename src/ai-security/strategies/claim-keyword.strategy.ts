import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InputSecurityStrategy } from './input-security-strategy.interface';

@Injectable()
export class ClaimKeywordStrategy implements InputSecurityStrategy {
  private readonly logger = new Logger(ClaimKeywordStrategy.name);

  private readonly claimKeywords = [
    'reclamo',
    'problema',
    'fuga',
    'corte',
    'rotura',
    'sin agua',
    'sin luz',
    'bache',
    'basura',
    'luminaria',
    'poste',
    'semáforo',
    'árbol',
    'gas',
    'inundación',
    'cloaca',
    'dirección',
    'ubicación',
    'calle',
    'avenida',
    'teléfono',
    'email',
    'correo',
    'dni',
    'cédula',
    'emergencia',
    'urgente',
    'solicito',
    'request',
    'reportar',
    'denunciar',
  ];

  validate(input: string, _clientId?: string): void {
    if (input.length > 20 || this.hasClaimKeywords(input)) {
      return;
    }

    this.logger.warn(
      `Input demasiado corto sin keywords de reclamo | inputLength=${input.length}`,
    );
    throw new BadRequestException(
      'Por favor describe tu reclamo con más detalle.',
    );
  }

  private hasClaimKeywords(input: string): boolean {
    const lowerInput = input.toLowerCase();

    for (const keyword of this.claimKeywords) {
      if (lowerInput.includes(keyword)) {
        return true;
      }
    }

    return false;
  }
}
