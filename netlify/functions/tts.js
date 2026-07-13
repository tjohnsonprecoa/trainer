// tts — turns the AI prospect's reply text into natural speech, matched to
// the persona's gender, using OpenAI's gpt-4o-mini-tts model (their most
// natural-sounding current TTS model). Replaces the old browser-native
// speechSynthesis, which sounded robotic and had no gender control.

const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;

// Voice choices leaning clearly male/female in OpenAI's current voice set.
const VOICE_MAP = {
  male: 'onyx',
  female: 'shimmer',
};

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  if (!OPENAI_KEY) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'OpenAI key not configured. Add OPENAI_KEY to Netlify environment variables.' }) };
  }

  try {
    const { text, gender } = JSON.parse(event.body);
    if (!text) return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'Missing text' }) };

    const voice = VOICE_MAP[gender] || 'alloy';

    const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + OPENAI_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice,
        input: text,
        instructions: 'Speak naturally, like a real person on a phone call — conversational pacing, not overly enunciated or performative.',
        response_format: 'mp3',
      }),
    });

    if (!ttsRes.ok) {
      const errText = await ttsRes.text();
      return { statusCode: ttsRes.status, headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: `TTS error ${ttsRes.status}: ${errText.slice(0, 300)}` }) };
    }

    const buf = Buffer.from(await ttsRes.arrayBuffer());
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ audioBase64: buf.toString('base64'), mimeType: 'audio/mpeg' }),
    };

  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: err.message }) };
  }
};
