// Background function — transcribes a rep's spoken role-play turn with Whisper.
// Identical mechanics to CallIQ's transcribe-background.js, pointed at
// trainer_transcription_jobs.

const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;
const SB_URL     = 'https://nbifzxzpcxchrwdcblyu.supabase.co';
const SB_KEY     = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iaWZ6eHpwY3hjaHJ3ZGNibHl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MTE3MjQsImV4cCI6MjA5NTQ4NzcyNH0.Nt5YbYLYdEdtbHu5fwrY8XTqhyNaP0Cz1LadnE67A8E';

async function sbPatch(jobId, data) {
  await fetch(`${SB_URL}/rest/v1/trainer_transcription_jobs?id=eq.${jobId}`, {
    method: 'PATCH',
    headers: {
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  });
}

exports.handler = async (event) => {
  let jobId;
  try {
    const body = JSON.parse(event.body);
    jobId = body.jobId;
    const { fileUrl, fileName } = body;
    if (!jobId || !fileUrl) return;

    const audioResponse = await fetch(fileUrl);
    if (!audioResponse.ok) {
      await sbPatch(jobId, { status: 'error', error: `Could not fetch audio: HTTP ${audioResponse.status}` });
      return;
    }

    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
    if (audioBuffer.length === 0) {
      await sbPatch(jobId, { status: 'error', error: 'Audio file is empty (0 bytes).' });
      return;
    }

    const ext = (fileName || '').split('.').pop().toLowerCase() || 'webm';
    const mimeMap = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg' };
    const mimeType = mimeMap[ext] || 'audio/webm';

    const boundary = '----WhisperBoundary' + Date.now();
    const CRLF = '\r\n';
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="audio.${ext}"${CRLF}Content-Type: ${mimeType}${CRLF}${CRLF}`),
      audioBuffer,
      Buffer.from(CRLF),
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="model"${CRLF}${CRLF}whisper-1${CRLF}`),
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="language"${CRLF}${CRLF}en${CRLF}`),
      Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}text${CRLF}`),
      Buffer.from(`--${boundary}--${CRLF}`),
    ]);

    const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(multipartBody.length),
      },
      body: multipartBody,
    });

    const whisperText = await whisperRes.text();
    if (!whisperRes.ok) {
      await sbPatch(jobId, { status: 'error', error: `Whisper error ${whisperRes.status}: ${whisperText.slice(0, 300)}` });
      return;
    }

    const transcript = whisperText.trim();
    if (!transcript) {
      await sbPatch(jobId, { status: 'error', error: 'No speech detected in audio.' });
      return;
    }

    await sbPatch(jobId, { status: 'done', transcript });

  } catch (err) {
    if (jobId) await sbPatch(jobId, { status: 'error', error: err.message }).catch(() => {});
  }
};
