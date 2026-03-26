import type { Task } from './types';
import * as rhizome from './rhizome';

const STATUS_SYM: Record<string, string> = { open: '•', done: '✓', cancelled: '✗', log: '–', 'needs-review': '~' };

export function fmt(task: Task): string {
  const sym = STATUS_SYM[task.status] || '?';
  const d = task.task_date instanceof Date
    ? task.task_date.toISOString().slice(0, 10)
    : String(task.task_date).slice(0, 10);
  const proj = task.project ? ` @${task.project.split('/').pop()}` : '';
  const claude = task.tags?.includes('c') ? ' [c]' : '';
  const reviewers = task.tags ? task.tags.filter(t => t.startsWith('@')).join(' ') : '';
  const src = task.source && task.source !== 'hallie' ? ` {${task.source}}` : '';
  const attn = task.needs_attention ? ` ⚑${task.needs_attention}` : '';
  const pri = task.priority ? `${task.priority} ` : '';
  return `[${task.id}] ${pri}${sym} ${task.body}${claude}${src}${reviewers ? ' ' + reviewers : ''}${attn}${proj}  (${d})`;
}

export async function enrichLines(task: Task): Promise<string[]> {
  const ref = rhizome.taskRef(task);
  const [blocking, annotation, replyCount, personas] = await Promise.all([
    rhizome.getBlocking(task.id),
    rhizome.getAnnotations(task.id),
    rhizome.getReplyCount(ref),
    rhizome.getTaskPersonas(ref),
  ]);
  const lines: string[] = [];
  if (personas.length)            lines.push(`  ♟ serves: ${personas.join(', ')}`);
  if (blocking.blocked_by.length) lines.push(`  ↑ blocked by: ${blocking.blocked_by.map(b => `#${b.id}`).join(', ')}`);
  if (blocking.blocks.length)     lines.push(`  ↓ blocks: ${blocking.blocks.map(b => `#${b.id}`).join(', ')}`);
  if (replyCount > 0)             lines.push(`  ↩ ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}  (t thread ${task.slug || task.id})`);
  if (annotation)                 lines.push(`  ✎ ${annotation.notes}`);
  return lines;
}
