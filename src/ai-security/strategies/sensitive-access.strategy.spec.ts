import { BadRequestException } from '@nestjs/common';
import { SensitiveAccessStrategy } from './sensitive-access.strategy';

describe('SensitiveAccessStrategy', () => {
  const strategy = new SensitiveAccessStrategy();

  it('should reject sensitive access attempts', () => {
    expect(() => strategy.validate('Necesito el admin password y el token del sistema')).toThrow(
      BadRequestException,
    );
  });

  it('should allow non-sensitive claim text', () => {
    expect(() => strategy.validate('Mi correo es juan@example.com y quiero reportar un bache')).not.toThrow();
  });
});
