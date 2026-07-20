export interface InputSecurityStrategy {
  validate(input: string, clientId?: string): void;
}

export const INPUT_SECURITY_STRATEGIES = 'INPUT_SECURITY_STRATEGIES';
