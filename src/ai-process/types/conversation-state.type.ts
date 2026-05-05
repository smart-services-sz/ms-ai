import { ClaimCategoria, ClaimPrioridad } from '../ai-interpreter.service';

// Fase actual del flujo conversacional.
// - awaiting_identity_and_claim: primer contacto, aún no se saludó al usuario.
// - collecting_claim_data: ya se saludó; se está recopilando datos del reclamo.
export type ConversationPhase = 'awaiting_identity_and_claim' | 'collecting_claim_data';

// Entrada individual del historial de la conversación, persistida en Redis.
export type MensajeEntry = {
  origen: 'usuario' | 'asistente'; // Quién envió el mensaje.
  texto: string;
  creadoEn: string;                 // ISO 8601.
};

// Estado completo de la conversación de un contacto, persistido en Redis con TTL configurable.
// Se va enriqueciendo a medida que el usuario aporta datos del reclamo.
export type ConversationState = {
  contactKey: string;              // Identificador canónico del contacto (canal:tipo:valor).
  phase: ConversationPhase;
  greeted: boolean;                // true si ya se envió el mensaje de bienvenida.
  correo?: string;                 // Datos del reclamo acumulados a lo largo de los turnos.
  dni?: string;
  problema?: string;
  direccion?: string;
  categoria?: ClaimCategoria;      // Clasificada por OpenAI o asignada por defecto ('otros').
  prioridad?: ClaimPrioridad;      // Determinada por OpenAI o asignada por defecto ('media').
  mensajes?: MensajeEntry[];       // Historial completo usuario/asistente.
  updatedAt: string;
};
