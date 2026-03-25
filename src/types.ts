export type TaskStatus = 'open' | 'done' | 'cancelled' | 'log' | 'needs-review';
export type Priority = 'A' | 'B' | 'C' | null;
export type Phase = 'volatile' | 'fluid' | 'salt';

export interface Task {
  id: number;
  body: string;
  status: TaskStatus;
  priority: Priority;
  task_date: Date | string;
  snoozed_to: Date | string | null;
  snoozed_until: Date | string | null;
  project: string | null;
  tags: string[];
  source: string | null;
  slug: string | null;
  needs_attention: string | null;
  thread_read_at: Date | string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
}

export interface Oncall {
  id: number;
  who: string;
  until_at: Date | string;
  created_at: Date | string;
}

export interface CallLogEntry {
  id: number;
  tool: string;
  args: Record<string, unknown>;
  success: boolean;
  error: string | null;
  duration_ms: number;
  created_at: Date | string;
}

export interface SignalData {
  stuck: Array<{ id: number; body: string; age_days: number; project: string | null }>;
  deferred: Array<{ id: number; body: string; snoozed_to: string; days_away: number; project: string | null }>;
  clusters: Array<{ repo: string; open_count: number; oldest: string }>;
  signals: Array<{ id: number; body: string }>;
  velocity: Array<{ day: string; done: number }>;
}

export interface SnoozePattern {
  id: number;
  snooze_count: number;
  trail: string;
}

export interface BlockingInfo {
  blocks: Array<{ id: number; notes: string }>;
  blocked_by: Array<{ id: number; notes: string }>;
}

export interface Edge {
  subject: string;
  predicate: string;
  object: string;
  phase: Phase;
  observer: string;
  notes: string;
  created_at: Date | string;
  dissolved_at: Date | string | null;
}
