// Creates a training_attempts row (status pending) plus a trainer_score_jobs
// row, and returns both IDs. The browser then calls score-background directly
// to do the actual Claude scoring work. Same starter/background split as CallIQ.

const SB_URL = 'https://nbifzxzpcxchrwdcblyu.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5iaWZ6eHpwY3hjaHJ3ZGNibHl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5MTE3MjQsImV4cCI6MjA5NTQ4NzcyNH0.Nt5YbYLYdEdtbHu5fwrY8XTqhyNaP0Cz1LadnE67A8E';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  try {
    const body = JSON.parse(event.body);
    const {
      repId, team, moduleId, transcript,
      dispositionReported, dispositionNotesText, notesPhotoUrl, dispositionFormJson,
    } = body;

    if (!repId || !moduleId || !transcript) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: 'Missing repId, moduleId, or transcript' }) };
    }

    // 1. Create the attempt row
    const attemptRes = await fetch(`${SB_URL}/rest/v1/training_attempts`, {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({
        rep_id: repId, team, module_id: moduleId, transcript,
        disposition_reported: dispositionReported || null,
        disposition_notes_text: dispositionNotesText || null,
        notes_photo_url: notesPhotoUrl || null,
        disposition_form_json: dispositionFormJson || null,
        status: 'scoring',
      }),
    });
    const attemptText = await attemptRes.text();
    if (!attemptRes.ok) {
      return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: `Attempt insert failed (${attemptRes.status}): ${attemptText}` }) };
    }
    const attemptData = JSON.parse(attemptText);
    const attemptId = (Array.isArray(attemptData) ? attemptData[0] : attemptData)?.id;

    // 2. Create the job row
    const jobRes = await fetch(`${SB_URL}/rest/v1/trainer_score_jobs`, {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ attempt_id: attemptId, status: 'pending' }),
    });
    const jobText = await jobRes.text();
    if (!jobRes.ok) {
      return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: `Job insert failed (${jobRes.status}): ${jobText}` }) };
    }
    const jobData = JSON.parse(jobText);
    const jobId = (Array.isArray(jobData) ? jobData[0] : jobData)?.id;

    if (!jobId || !attemptId) {
      return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: 'Could not create job or attempt row' }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ jobId, attemptId }),
    };
  } catch (err) {
    return { statusCode: 500, headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: err.message }) };
  }
};
