// trello.js — Trello API client, reads credentials from macOS Keychain
const { execSync } = require('child_process');

function getKey(name) {
  try {
    return execSync(`security find-generic-password -a tasking -s ${JSON.stringify(name)} -w`, { stdio: ['pipe','pipe','pipe'], encoding: 'utf8' }).trim();
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

function qs(params) {
  return new URLSearchParams(params).toString();
}

async function get(path, params = {}) {
  const { key, token } = creds();
  const url = `https://api.trello.com/1${path}?${qs({ key, token, ...params })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Trello API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function boards() {
  return get('/members/me/boards', { filter: 'open', fields: 'id,name,shortUrl' });
}

async function lists(boardId) {
  return get(`/boards/${boardId}/lists`, { filter: 'open', fields: 'id,name' });
}

async function cards(boardId, { listId } = {}) {
  const all = await get(`/boards/${boardId}/cards`, { filter: 'open', fields: 'id,name,idList,due,url,desc' });
  if (listId) return all.filter(c => c.idList === listId);
  return all;
}

module.exports = { boards, lists, cards };
