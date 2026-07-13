# FPC Training Pathway — Setup

Sibling app to CallIQ. Shares the **same Supabase project** (`nbifzxzpcxchrwdcblyu`), deployed as a **separate Netlify site** — per the project plan, this keeps blast radius small if something breaks.

## 1. Supabase — run the migrations, in order

1. Go to your Supabase project → **SQL Editor** → New query.
2. Run `sql/001_training_schema.sql` first (base tables + storage buckets).
3. Then run `sql/002_tier_grid.sql` (reshapes the path into a **readiness map**: rows = objection category, columns = Tier 1-3, escalating difficulty within the same objection type — mirrors the grid/tier UI, but built from CallIQ's real objection taxonomy rather than invented category names). Supabase will warn "this query includes destructive operations" — that's expected (it clears old seed data before reseeding); confirm and run.
4. Then run `sql/003_storage_policies.sql` (adds the missing RLS policies on the two new storage buckets — without this, uploading role-play audio or notes photos fails with "new row violates row-level security policy").
5. Then run `sql/004_planner_disposition.sql` (adds a stable fake phone number per persona for the appointment form, and a `disposition_form_json` column for the full planner-style disposition detail below).
6. Then run `sql/005_persona_gender.sql` (adds a `gender` field per persona, used to pick a matching voice — see below).
7. Then run `sql/006_lead_source_fh_afp.sql` (adds `lead_source`/`fh_name`/`afp_name` tracking columns to `training_attempts` — see the Lead Source section below).
8. This leaves you with 5 categories × 3 tiers = 15 modules:
   - **Warm / Receptive** (`other`)
   - **Send Info / Deflection** (`send-info`)
   - **Already Have a Will** (`has-will`)
   - **Spouse / Timing** (`need-spouse`)
   - **Veteran / Skeptical** (`veteran-lead`)
   - **Have Taylor/managers review every `persona_prompt` before go-live** — these are first drafts, especially the escalating tier-2/tier-3 personas which layer in compound objections and emotional complexity.
   - Want more rows? CallIQ's taxonomy also has `not-interested`, `dont-recall`, `body-donation`, `has-plans`, `too-busy`, `family-will-handle`, `moving`, `life-insurance`, `has-plot`, `va-benefits`, `after-holidays`, `surgery` — any of these can become a new category × 3-tier block the same way.

## 2. Netlify — deploy as a new site

1. Push this folder to its own GitHub repo (or a new folder in an existing monorepo — either works, Netlify just needs `netlify.toml` at the site root).
2. In Netlify: **Add new site → Import from Git**, point it at this repo.
3. Site settings → **Environment variables**, add:
   - `ANTHROPIC_KEY` — same key CallIQ uses (or a new one, your call)
   - `OPENAI_KEY` — same Whisper key CallIQ uses
4. Deploy. Netlify will pick up `netlify.toml` automatically (functions folder, timeouts, headers).

## 3. Quick smoke test

1. Open the deployed site → enter a name + team → you should see a **readiness map**: 5 category rows × 3 tier columns, tier-1 cells "Not started" (unlocked) and everything else "Locked".
2. Click a tier-1 cell (or the **Start Roleplay** button, which jumps to the recommended module) → hold the mic button, say something → release → your line gets transcribed, the AI prospect replies and speaks out loud.
3. Click **End Call** → pick a disposition, optionally a photo → **Submit & Get Score** → score comes back in ~30-60 seconds.
4. Back on the readiness map: if you passed, that cell turns green ("Passed") and the tier-2 cell in that same row unlocks; if you didn't pass, the cell turns amber with your average score, and the **Recommended next** card should point at whichever unlocked module currently has your lowest average score.
5. Go to the **Manager** tab, password `2026fpc` (same as CallIQ — change independently if you want a different one) → you should see the attempt you just logged.

## Ending a call: the planner

After **End Call**, the rep picks one of two paths — mirroring the real planner app:

- **Set Appointment**: person talked to, location (Funeral Home / Client Home / Other — placeholder values since we don't have real location data in training), a time, attendee info (partner attending / single / partner not attending), a phone number auto-filled per persona that the rep checks as "verified," most important reason, confirmer notes, AFP notes.
- **Log Result**: the full real disposition list (Answer / No Answer / Other categories, same options as the production planner), notes, and a Queue (vague — "put back in queue in N days/weeks/months") vs. Scheduled (specific callback date/time) choice.

Either path can also attach a photo of the notes the rep took during the call.

**Note on scoring**: only the coarse outcome (appointment set vs. which disposition) and notes feed the AI's disposition-accuracy grade, same as before. The full structured detail (location, attendee info, phone verification, queue/schedule choice, etc.) is captured in `training_attempts.disposition_form_json` for **manager review only** — it shows up in the Manager tab's attempt drill-down, but isn't graded by the AI yet. That can be layered in later once there's a clearer sense of what's worth grading there.

## Lead source, funeral home, and AFP — matching the real script

Each role-play attempt randomly gets three things, mirroring the real `Direct_Mail_Script_with_MIR.docx` script's variables:

- **A lead source** — Direct Mail, Internet, or Veterans Memorial Program. Each has its own adapted opening (see `FPC_Call_Script_All_Lead_Sources.docx` for the full tailored script — sections 1-2 differ per lead source, sections 3-5 are shared).
- **A funeral home name** (with a pronunciation guide) — currently a **placeholder list** in `FUNERAL_HOMES` near the top of the JS in `index.html`. Replace with the real partner list whenever it's ready; for any tricky name, set its `pronunciation` field to a phonetic spelling.
- **An AFP (advisor) name** — from `AFP_NAMES`, a small pool of placeholder names for the "we have an advisor on staff" part of the script.

Before each call, the rep sees a **briefing screen** with all three, plus the adapted opening line for that lead source, and a **🔊 Hear it** button that speaks the funeral home's pronunciation out loud (reuses `tts.js`) before the rep has to say it live. The same funeral home name, pronunciation, and AFP name are passed into the AI persona's instructions too (`realtime-session.js`), along with a short backstory matching the lead source (e.g. for Veterans Memorial Program, the persona is primed to have requested info about VA burial benefits) — so the persona's reactions make sense given how the script frames the call.

All three are recorded on the attempt (`lead_source`/`fh_name`/`afp_name` columns) and shown in the Manager tab's attempt drill-down, so managers can see which combinations a rep has practiced.

**To update the funeral home list**: edit the `FUNERAL_HOMES` array in `index.html` — no SQL migration needed, it's just a JS array (small, fixed reference data, not something reps CRUD through the app).

## Manager section — redesigned around one rep at a time

The old flat table (every rep × module row) is gone. The Manager tab now works in two steps:

1. **Rep list** — one row per rep, showing team, overall % certified, current tier, and last activity. Click a rep to open their profile.
2. **Rep profile** — everything about that one person:
   - **Path to Graduate**: the same readiness-map grid from the practice view (read-only here), plus either "🎓 Graduated" (all modules passed) or a "Next to graduate" card pointing at whichever unlocked module needs attention most (same lowest-average-score logic as the practice side's recommended-next card).
   - **Strengths & Growth Areas**: average Conversation Quality / Script Adherence / Question Quality / Disposition Accuracy across all their scored attempts, plus a plain-language callout of whichever dimension is weakest — that's the one worth coaching on.
   - **Recent Coaching Notes**: the "improvements" feedback pulled from their last few attempts, so a manager doesn't have to open each attempt individually to see the pattern.
   - **Attempt History**: same per-attempt drill-down as before (transcript, disposition/appointment detail, lead source/FH/AFP used) — just moved in-page instead of a popup modal.

## Difficulty progression, scheduling gate, and the persistent call-info panel

**During the call**, a panel now stays visible the whole time (fixed to the right on wide screens, a compact bar above the call card on narrow ones) showing the lead source, funeral home name + pronunciation, and AFP name — so the rep doesn't have to memorize them before starting.

**Tier-based openness** (`realtime-session.js`, `TIER_OPENNESS`): on top of each persona's specific objection difficulty, there's now a separate "how forthcoming is this person" dial tied to module tier — tier 1 personas answer reasonably when asked, tier 2 give short answers unless the rep asks good specific follow-ups, tier 3 stay guarded unless the rep demonstrates real listening and doesn't rush. This is intentionally a *second axis* layered on top of the existing per-persona objection instructions, not a replacement for them.

**The scheduling gate is tier-scaled** (`realtime-session.js`, `TIER_SCHEDULING_GATE`): tier 1 is deliberately easy — the objection is a light "smokescreen," and a rep who competently runs the script (intro → motivation/MIR → FWO → appointment ask) with any reasonable response to the objection should succeed, no deep discovery-question skill required. Tier 2 requires at least one genuinely specific follow-up question. Tier 3 requires multiple good discovery questions and a natural, unhurried conversation — genuinely hard to earn. This tuning came directly from testing: the first pass made every tier equally hard, which isn't the intent — tier 1 should build confidence, tiers 2-3 should demand real skill.

**Objection pacing** (`realtime-session.js`, `OBJECTION_CYCLE_CAP`): personas are instructed to raise their objection (or a rephrasing of it) at most 1-3 times, then make a decisive move — either soften and continue toward scheduling, or firmly end the call. Matches how real prospects behave; they don't manufacture an endless stream of new objections.

**Scoring** (`score-background.js`) grades three explicit new dimensions alongside the existing ones — `conversation_quality_score`, `script_adherence_score`, `question_quality_score` (all 1-10) — with tier-1 leniency built into the rubric text so a simple, competent script run scores well there without penalizing for lack of deep discovery questions that tier isn't meant to require. These three show up as their own score chips on the result screen.

**Notes photo upload was removed** — the disposition form (Set Appointment / Log Result) already captures what's needed; the photo step was redundant. The `training-notes-photos` storage bucket and `notes_photo_url` column are still there (harmless, unused) in case it's wanted back later.

## The role-play call: OpenAI Realtime API (native speech-to-speech)

This replaced the entire record-clip → Whisper → Claude → TTS chain from the previous version. Instead, the browser opens a live WebRTC connection **directly to OpenAI** — `realtime-session.js` only mints a short-lived session credential (your real `OPENAI_KEY` never reaches the browser); actual audio flows browser ↔ OpenAI. The model listens to your mic continuously, decides on its own when your turn starts and ends (server-side "semantic VAD" — no more client-side noise calibration), and speaks back natively. This fixes the three original complaints structurally rather than by tuning: no transcription round trip to feel slow, no lossy transcript step for the model to misunderstand, and natural expressive voice instead of bolted-on TTS.

**Important vendor note**: this moves the *live in-call persona voice* to OpenAI's Realtime model (`gpt-realtime-2.1`) — Claude is no longer what's talking during the call itself. **Claude still does all the scoring** afterward (`score-starter.js`/`score-background.js` are completely unchanged) — only the live conversation moved. If keeping the live persona on Claude specifically matters, this trade-off is worth flagging back to whoever owns that decision.

**Cost**: realistically $0.05–$0.15/min of talk time with the mini model, or higher with the full model we're using by default (~$0.18–$0.46/min uncached, less with prompt caching) — see `realtime-session.js` for the `MODEL` constant if you want to switch to `gpt-realtime-2.1-mini` for lower cost.

**Voice**: mapped by persona gender to `echo` (male) / `shimmer` (female) — deliberately *not* the newer Cedar/Marin voices, which have a documented issue where they sometimes ignore agent instructions. Since each persona's entire behavior comes from its instructions, that's a real risk here. Feel free to try Cedar/Marin (edit `VOICE_MAP` in `realtime-session.js`) if you confirm they follow instructions well for your personas.

**Honest caveat — transcript event names**: OpenAI's Realtime event names have changed across API versions and may shift again. `handleRealtimeEvent()` in `index.html` handles the most likely current names for capturing what each side said (needed so Claude's scoring step still gets a transcript), with a fallback that tries to recover text from the final `response.done` payload if the delta events don't match. If transcript bubbles ever stop appearing during a call, uncomment the `console.log` line in the `default:` case of that function, run one call, and check the browser console — that'll show the exact event names this API version is actually sending, and we can patch the two `case` statements to match.

**What's no longer used**: `persona-turn.js`, `tts.js`, `transcribe-live.js`, `transcribe.js`, and `transcribe-background.js` are all superseded by this change for the live call loop. They're left in place (harmless, unused) in case you ever want to revert or reuse pieces of that pipeline.

**No manual fallback yet**: unlike the previous version, there's currently no push-to-talk fallback if the WebRTC connection fails — it'll show a connection error instead. Worth adding back later if that turns out to matter in practice.

## Known v1 limitations (per the project plan's recommendations)

- **Realtime API cost**: defaults to the full `gpt-realtime-2.1` model for best instruction-following; swap to `gpt-realtime-2.1-mini` in `realtime-session.js` if per-minute cost becomes a concern at higher usage.
- **No connection-failure fallback yet** — if the WebRTC session can't establish, the call shows an error rather than falling back to any alternate path.
- **15 modules seeded** (5 categories × 3 tiers) — add more by inserting new rows into `training_modules` with a `category_label`/`objection_type`/`tier`; unlock is computed client-side from tier + category, no prerequisite chain to maintain.
- **No attempt cap / manager-notify-after-N-attempts logic yet** — open decision from the plan, not yet implemented.
- **Manager dashboard is progress + attempt drill-down only** — no "flag reps stuck after N attempts" view yet.
