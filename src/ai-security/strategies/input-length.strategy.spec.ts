import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InputLengthStrategy } from './input-length.strategy';

describe('InputLengthStrategy', () => {
  const configServiceMock = {
    get: jest.fn((key: string) => {
      if (key === 'AI_MAX_INPUT_LENGTH') {
        return 2000;
      }
      return undefined;
    }),
  } as unknown as ConfigService;

  const strategy = new InputLengthStrategy(configServiceMock);

  it('should reject empty input', () => {
    expect(() => strategy.validate('')).toThrow(BadRequestException);
  });

  it('should reject long input', () => {
    expect(() => strategy.validate('a'.repeat(2001))).toThrow(BadRequestException);
  });

  it('should allow input within max length', () => {
    expect(() => strategy.validate('Hay un reclamo por fuga de agua')).not.toThrow();
  });
});
