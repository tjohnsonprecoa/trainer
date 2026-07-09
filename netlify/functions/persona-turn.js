// persona-turn — the AI "prospect" for a role-play module.
// Given the module's persona prompt + running conversation history + the
// rep's latest transcribed line, returns the prospect's next line of dialogue.
// Synchronous (not a background function) — the rep is waiting live on this,
// same as CallIQ's score.js pattern for anything on the interactive path.

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  if (!ANTHROPIC_KEY) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: { message: 'Anthropic key not configured. Add ANTHROPIC_KEY to Netlify environment variables.' } })
    };
  }

  try {
    const body = JSON.parse(event.body);
    const { personaPrompt, personaName, history, turnCount } = body;
    // history: [{ speaker: 'rep'|'prospect', text: '...' }, ...] — running transcript so far

    if (!personaPrompt || !Array.isArray(history)) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: { message: 'Missing personaPrompt or history' } }) };
    }

    const systemPrompt = [
      {
        type: 'text',
        text: `${personaPrompt}

You are roleplaying a phone call for new-hire training. Every response must be ONLY this JSON object, nothing else — no markdown fences, no preamble:
{"reply": "<your next line of dialogue as the prospect, 1-3 sentences, natural spoken phone language>", "call_status": "ongoing" | "ending"}

Set "call_status" to "ending" ONLY when the conversation has reached a natural conclusion — either an appointment was scheduled, or the prospect has firmly declined and there's nothing more to say, or a hard hang-up is warranted. Otherwise "ongoing". Do not end the call prematurely just because the rep asked a question — most calls should run at least 4-6 exchanges before ending. Never break character. Never mention JSON, AI, or training in your "reply" text — that field is spoken dialogue only.`,
        cache_control: { type: 'ephemeral' }
      }
    ];

    // Convert running history into an alternating message list.
    // The prospect (AI) is the "assistant"; the rep is the "user".
    const messages = history.map(turn => ({
      role: turn.speaker === 'rep' ? 'user' : 'assistant',
      content: turn.speaker === 'rep' ? turn.text : JSON.stringify({ reply: turn.text, call_status: 'ongoing' }),
    }));

    // Kick things off if this is turn 1 and the rep hasn't spoken yet
    // (some modules may want the prospect to answer the "phone" first).
    if (messages.length === 0) {
      messages.push({ role: 'user', content: '[The phone rings. The rep is calling you now. Answer as you naturally would.]' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: systemPrompt,
        messages,
      }),
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      return { statusCode: response.status || 500, headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: data.error || { message: 'Unknown error from Anthropic' } }) };
    }

    const raw = data.content?.[0]?.text || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) {
      return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: { message: 'AI returned invalid JSON', raw } }) };
    }

    const parsed = JSON.parse(clean.slice(start, end + 1));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ reply: parsed.reply, call_status: parsed.call_status === 'ending' ? 'ending' : 'ongoing' }),
    };

  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: { message: err.message } }) };
  }
};
