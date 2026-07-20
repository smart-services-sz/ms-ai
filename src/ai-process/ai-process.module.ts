import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { AiProcessController } from './ai-process.controller';
import { AiProcessService } from './ai-process.service';
import { AiInterpreterService } from './ai-interpreter.service';
import { AiSecurityService } from './ai-security.service';
import { InputLengthStrategy } from '../ai-security/strategies/input-length.strategy';
import { PromptInjectionStrategy } from '../ai-security/strategies/prompt-injection.strategy';
import { SensitiveAccessStrategy } from '../ai-security/strategies/sensitive-access.strategy';
import { ClaimKeywordStrategy } from '../ai-security/strategies/claim-keyword.strategy';
import { INPUT_SECURITY_STRATEGIES } from '../ai-security/strategies/input-security-strategy.interface';
import { ConversationStateSupportService } from '../conversation/conversation-state-support.service';
import { AwaitingIdentityAndClaimState } from '../conversation/states/awaiting-identity-and-claim.state';
import { CollectingClaimDataState } from '../conversation/states/collecting-claim-data.state';
import { ClosedConversationState } from '../conversation/states/closed-conversation.state';
import { CONVERSATION_STATE_HANDLERS } from '../conversation/states/conversation-state-handler.interface';

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
  providers: [
    AiProcessService,
    AiInterpreterService,
    AiSecurityService,
    ConversationStateSupportService,
    InputLengthStrategy,
    PromptInjectionStrategy,
    SensitiveAccessStrategy,
    ClaimKeywordStrategy,
    AwaitingIdentityAndClaimState,
    CollectingClaimDataState,
    ClosedConversationState,
    {
      provide: INPUT_SECURITY_STRATEGIES,
      useFactory: (
        inputLengthStrategy: InputLengthStrategy,
        promptInjectionStrategy: PromptInjectionStrategy,
        sensitiveAccessStrategy: SensitiveAccessStrategy,
        claimKeywordStrategy: ClaimKeywordStrategy,
      ) => [
        inputLengthStrategy,
        promptInjectionStrategy,
        sensitiveAccessStrategy,
        claimKeywordStrategy,
      ],
      inject: [
        InputLengthStrategy,
        PromptInjectionStrategy,
        SensitiveAccessStrategy,
        ClaimKeywordStrategy,
      ],
    },
    {
      provide: CONVERSATION_STATE_HANDLERS,
      useFactory: (
        awaitingState: AwaitingIdentityAndClaimState,
        collectingState: CollectingClaimDataState,
        closedState: ClosedConversationState,
      ) => [awaitingState, collectingState, closedState],
      inject: [
        AwaitingIdentityAndClaimState,
        CollectingClaimDataState,
        ClosedConversationState,
      ],
    },
  ],
})
export class AiProcessModule {}
