# FPC Training Pathway — Setup

Sibling app to CallIQ. Shares the **same Supabase project** (`nbifzxzpcxchrwdcblyu`), deployed as a **separate Netlify site** — per the project plan, this keeps blast radius small if something breaks.

## 1. Supabase — run the migrations, in order

1. Go to your Supabase project → **SQL Editor** → New query.
2. Run `sql/001_training_schema.sql` first (base tables + storage buckets).
3. Then run `sql/002_tier_grid.sql` (reshapes the path into a **readiness map**: rows = objection category, columns = Tier 1-3, escalating difficulty within the same objection type — mirrors the grid/tier UI, but built from CallIQ's real objection taxonomy rather than invented category names). This step **clears and reseeds** `training_modules` and anything that depended on it — fine pre-launch, but don't run it if real reps have already logged attempts you want to keep.
4. This leaves you with 5 categories × 3 tiers = 15 modules:
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

## Known v1 limitations (per the project plan's recommendations)

- **TTS is browser-native** (`speechSynthesis`) — free but robotic. Upgrading to ElevenLabs is a v2 item; it needs a Netlify function to hold the API key server-side so the browser never sees it.
- **Push-to-talk only** — no voice-activity-detection/auto-listen yet.
- **5 modules seeded** — plan said start with 3-5 for v1; edit `training_modules` in Supabase to add/reorder more (the `prerequisite_module_id` chain drives unlock order).
- **No attempt cap / manager-notify-after-N-attempts logic yet** — open decision from the plan, not yet implemented.
- **Manager dashboard is progress + attempt drill-down only** — no "flag reps stuck after N attempts" view yet.
