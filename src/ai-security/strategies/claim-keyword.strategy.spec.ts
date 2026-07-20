import { BadRequestException } from '@nestjs/common';
import { ClaimKeywordStrategy } from './claim-keyword.strategy';

describe('ClaimKeywordStrategy', () => {
  const strategy = new ClaimKeywordStrategy();

  it('should reject short input without claim keywords', () => {
    expect(() => strategy.validate('hola')).toThrow(BadRequestException);
  });

  it('should allow short input with claim keywords', () => {
    expect(() => strategy.validate('hay un bache')).not.toThrow();
  });

  it('should allow input with length greater than 20 chars', () => {
    expect(() => strategy.validate('Necesito asistencia en mi barrio')).not.toThrow();
  });
});
