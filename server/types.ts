// Preserve server import paths while keeping the wire contract in one shared module.
export type {
  AgentConfig, AnswerSource, Customer, Recording, ServerEvent,
  Session, SessionEvent, SessionStatus, SessionTransport, Transcript,
} from '../shared/session.js';
