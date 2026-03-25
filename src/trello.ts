import { execSync } from 'child_process';

function getKey(name: string): string | null {
  try {
    return execSync(`security find-generic-password -a tasking -s ${JSON.stringify(name)} -w`, { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function creds() {
  const key = getKey('TRELLO_KEY');
  const token = getKey('TRELLO_TOKEN');
  if (!key || !token) throw new Error('Trello credentials not found. Run: t reg TRELLO_KEY "..." && t reg TRELLO_TOKEN "..."');
  return { key, token };
}

async function get(path: string, params: Record<string, string> = {}) {
  const { key, token } = creds();
  const url = `https://api.trello.com/1${path}?${new URLSearchParams({ key, token, ...params })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Trello API error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function boards() {
  return get('/members/me/boards', { filter: 'open', fields: 'id,name,shortUrl' });
}

export async function lists(boardId: string) {
  return get(`/boards/${boardId}/lists`, { filter: 'open', fields: 'id,name' });
}

export async function cards(boardId: string, opts: { listId?: string } = {}) {
  const all = await get(`/boards/${boardId}/cards`, { filter: 'open', fields: 'id,name,idList,due,url,desc' });
  if (opts.listId) return all.filter((c: any) => c.idList === opts.listId);
  return all;
}
