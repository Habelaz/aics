export const TICKET_STATUSES = [
  'open',
  'pending',
  'approved',
  'rejected',
  'timed_out',
  'in_progress',
  'resolved',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TERMINAL_TICKET_STATUSES: readonly TicketStatus[] = [
  'approved',
  'rejected',
  'timed_out',
  'resolved',
];

export const REQUEST_STATES = [
  'accepted',
  'answered',
  'escalated',
  'approved',
  'rejected',
  'timed_out',
  'failed',
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const TERMINAL_REQUEST_STATES: readonly RequestState[] = [
  'approved',
  'rejected',
  'timed_out',
  'failed',
];

export const DECISION_CHANNELS = ['slack', 'dashboard', 'api'] as const;
export type DecisionChannel = (typeof DECISION_CHANNELS)[number];

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const ROLES = ['admin', 'agent'] as const;
export type Role = (typeof ROLES)[number];

export function isTerminalStatus(status: TicketStatus): boolean {
  return TERMINAL_TICKET_STATUSES.includes(status);
}

export function isTerminalState(state: RequestState): boolean {
  return TERMINAL_REQUEST_STATES.includes(state);
}