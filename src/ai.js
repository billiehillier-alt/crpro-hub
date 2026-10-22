// Claude through Anthropic's official SDK. Only works when ANTHROPIC_API_KEY is set; otherwise every AI button explains
// the key is missing. Model: AI_MODEL, default claude-sonnet-5-5.
const MODEL = () => process.env.AI_MODEL || 'claude-sonnet-5-5';
let cached = null, cachedKey = '';
function client() {
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim(); if (!key) return null;
  if (!cached || cachedKey !== key) { const Anthropic = require('@anthropic-ai/sdk'); cached = new (Anthropic.default || Anthropic)({ apiKey: key }); cachedKey = key; }
  return cached;
}
const MISSING = 'AI isn’t set up yet. Add ANTHROPIC_API_KEY to the server’s environment (see .env.example), then restart the app.';
// Asks for JSON that matches a schema (structured output), and returns it parsed.
async function askJson({ system, schema, content, maxTokens = 8000 }) {
  const c = client(); if (!c) throw Object.assign(new Error(MISSING), { status: 400 });
  const r = await c.messages.create({ model: MODEL(), max_tokens: maxTokens, system, output_config: { format: { type: 'json_schema', schema } }, messages: [{ role: 'user', content }] });
  const b = (r.content || []).find(k => k.type === 'text');
  try { return JSON.parse(b ? b.text : '{}'); } catch { throw Object.assign(new Error('The AI answer didn’t finish. Try again.'), { status: 502 }); }
}
module.exports = { client, askJson, MODEL, MISSING };
