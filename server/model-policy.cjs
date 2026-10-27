'use strict';

// Shared by Node and the bundled Worker. Shared credentials always use the
// owner's models; a client's model choice only applies to its own API key.
const DEFAULT_MODEL = 'glm-5.3-flash';
function selectModel(body, settings = {}) {
  if (String(body.apiKey || '').trim()) {
    return String(body.model || '').trim() || (body.vision ? 'glm-4v-flash' : DEFAULT_MODEL);
  }
  const text = String(settings.sharedModel || '').trim() || DEFAULT_MODEL;
  return body.vision ? (String(settings.visionModel || '').trim() || text) : text;
}
function applyReasoning(upstream, body) {
  if (!/^glm-5\.3(?:-|$)/i.test(upstream.model)) return;
  // GLM-5.3 always thinks. Low effort avoids an implicit max-effort wait;
  // anchor matching previously sent unsupported thinking.type=disabled.
  upstream.thinking = { type: 'enabled' };
  upstream.reasoning_effort = ['low', 'high', 'max'].includes(body.reasoning_effort) ? body.reasoning_effort : 'low';
  if (body.ping) upstream.max_tokens = 1024;
}
module.exports = { DEFAULT_MODEL, selectModel, applyReasoning };
