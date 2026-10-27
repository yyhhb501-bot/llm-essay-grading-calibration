'use strict';
const BASE_URL = 'https://opencode.ai/inference/go/openai/v1';
const MODEL = 'deepseek-v4.1-flash';
const CLIENT = 'ShenlunGrader/1.0';
function selected(body, key) {
  return !!String(key || '').trim() && !String(body.apiKey || '').trim() && !body.vision;
}
async function headers(key, userId, messages) {
  // Hash conversation content and user identity; neither is exposed in headers.
  const first = messages.find(message => message.role === 'user');
  const bytes = new TextEncoder().encode(JSON.stringify([userId, first && first.content]));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const session = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key,
    'User-Agent': CLIENT, 'x-opencode-session': 'shenlun-' + session };
}
module.exports = { BASE_URL, MODEL, CLIENT, selected, headers };
