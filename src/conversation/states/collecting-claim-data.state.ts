import { Injectable } from '@nestjs/common';
import { AiInboundPayloadDto } from '../../ai-process/dto/ai-inbound-payload.dto';
import {
  ConversationPhase,
  ConversationState,
} from '../../ai-process/types/conversation-state.type';
import { ConversationStateSupportService } from '../conversation-state-support.service';
import {
  ConversationStateHandler,
  ConversationStateHandlerResult,
} from './conversation-state-handler.interface';

@Injectable()
export class CollectingClaimDataState implements ConversationStateHandler {
  constructor(private readonly support: ConversationStateSupportService) {}

  canHandle(phase: ConversationPhase): boolean {
    return phase === 'collecting_claim_data';
  }

  async handle(
    payload: AiInboundPayloadDto,
    state: ConversationState,
  ): Promise<ConversationStateHandlerResult> {
    if (this.support.isGreetingMessage(payload.consolidatedText)) {
      const greetingMessage =
        'Hola. Para crear tu reclamo necesito que me envies en un solo mensaje: correo o DNI, descripcion del problema y direccion exacta.';
      const greetingState = this.support.appendAsistente(
        {
          ...state,
          mensajes: [
            ...(state.mensajes || []),
            this.support.makeMensaje('usuario', payload.consolidatedText),
          ],
          updatedAt: new Date().toISOString(),
        },
        greetingMessage,
      );

      return {
        state: greetingState,
        response: {
          correlationId: payload.correlationId,
          contactKey: payload.contactKey,
          status: 'greeting_guidance',
          shouldAskAgain: true,
          assistantMessage: greetingMessage,
          state: greetingState,
        },
      };
    }

    const parsed = await this.support.parseClaimText(
      payload.consolidatedText,
      payload.contactKey,
    );

    const mergedState: ConversationState = {
      ...state,
      correo: parsed.correo || state.correo,
      dni: parsed.dni || state.dni,
      problema: parsed.problema || state.problema,
      direccion: parsed.direccion || state.direccion,
      categoria: parsed.categoria || state.categoria,
      prioridad: parsed.prioridad || state.prioridad,
      mensajes: [
        ...(state.mensajes || []),
        this.support.makeMensaje('usuario', payload.consolidatedText),
      ],
      updatedAt: new Date().toISOString(),
    };

    const hasIdentity = Boolean(mergedState.correo || mergedState.dni);
    const hasProblema = Boolean(mergedState.problema);
    const hasDireccion = Boolean(mergedState.direccion);

    if (!parsed.understood || parsed.confidence < 0.35) {
      const rephraseMessage =
        'No pude entender bien tu mensaje. Por favor envialo nuevamente indicando en un solo mensaje: correo o DNI, problema y direccion exacta.';
      const rephraseState = this.support.appendAsistente(mergedState, rephraseMessage);

      return {
        state: rephraseState,
        response: {
          correlationId: payload.correlationId,
          contactKey: payload.contactKey,
          status: 'needs_rephrase',
          shouldAskAgain: true,
          assistantMessage: rephraseMessage,
          missingFields: this.support.computeMissingFields(
            hasIdentity,
            hasProblema,
            hasDireccion,
          ),
          state: rephraseState,
        },
      };
    }

    if (!hasIdentity || !hasProblema || !hasDireccion) {
      const missingFields = this.support.computeMissingFields(
        hasIdentity,
        hasProblema,
        hasDireccion,
      );
      const missingMessage = `Gracias. Me faltan estos datos para crear el reclamo: ${missingFields.join(', ')}. Enviamelos en un solo mensaje por favor.`;
      const missingState = this.support.appendAsistente(mergedState, missingMessage);

      return {
        state: missingState,
        response: {
          correlationId: payload.correlationId,
          contactKey: payload.contactKey,
          status: 'missing_required_data',
          shouldAskAgain: true,
          assistantMessage: missingMessage,
          missingFields,
          extractedData: {
            correo: missingState.correo,
            dni: missingState.dni,
            problema: missingState.problema,
            direccion: missingState.direccion,
          },
          state: missingState,
        },
      };
    }

    const claimCreation = await this.support.createClaim(payload, mergedState);

    if (!claimCreation.success) {
      if ('addressOutOfServiceArea' in claimCreation && claimCreation.addressOutOfServiceArea) {
        const oosMessage = `La direccion proporcionada no corresponde a nuestra zona de cobertura (${claimCreation.serviceArea}). Por favor, indica una direccion dentro del area de servicio.`;
        const oosState: ConversationState = this.support.appendAsistente(
          { ...mergedState, direccion: undefined },
          oosMessage,
        );

        return {
          state: oosState,
          response: {
            correlationId: payload.correlationId,
            contactKey: payload.contactKey,
            status: 'address_out_of_service_area',
            shouldAskAgain: true,
            assistantMessage: oosMessage,
            state: oosState,
          },
        };
      }

      return {
        state: mergedState,
        response: {
          correlationId: payload.correlationId,
          contactKey: payload.contactKey,
          status: claimCreation.categoryUnavailable ? 'category_not_enabled' : 'claim_creation_failed',
          shouldAskAgain: Boolean(claimCreation.categoryUnavailable),
          assistantMessage: claimCreation.categoryUnavailable
            ? 'Este tipo de reclamo no esta habilitado en el municipio de este canal. Podes consultar por otro problema municipal.'
            : 'Tengo tus datos, pero no pude crear el reclamo en este momento. Volve a intentarlo mas tarde.',
          extractedData: {
            correo: mergedState.correo,
            dni: mergedState.dni,
            problema: mergedState.problema,
            direccion: mergedState.direccion,
          },
          state: mergedState,
          error: claimCreation.error,
        },
      };
    }

    const finalState = this.support.appendAsistente(
      { ...mergedState, phase: 'closed' },
      claimCreation.reclamo.message,
    );

    return {
      state: finalState,
      response: {
        correlationId: payload.correlationId,
        contactKey: payload.contactKey,
        status: 'claim_created',
        shouldAskAgain: false,
        assistantMessage: claimCreation.reclamo.message,
        reclamo: {
          reclamoId: claimCreation.reclamo.reclamoId,
          trackingCode: claimCreation.reclamo.trackingCode,
          status: claimCreation.reclamo.status,
          createdAt: claimCreation.reclamo.createdAt,
        },
        geolocation: {
          lat: claimCreation.reclamo.data.lat,
          lng: claimCreation.reclamo.data.lng,
        },
        extractedData: {
          correo: finalState.correo,
          dni: finalState.dni,
          problema: finalState.problema,
          direccion: claimCreation.reclamo.data.direccion,
          categoria: finalState.categoria || 'otros',
          prioridad: finalState.prioridad || 'media',
        },
        state: finalState,
      },
    };
  }
}
