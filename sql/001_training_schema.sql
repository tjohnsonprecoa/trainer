-- ═══════════════════════════════════════════════════════════════
-- FPC Training Pathway — schema migration
-- Runs in the SAME Supabase project as CallIQ (nbifzxzpcxchrwdcblyu).
-- Safe to run multiple times (IF NOT EXISTS guards throughout).
-- Run this in the Supabase SQL editor: Project → SQL Editor → New query.
-- ═══════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────
-- 1. training_modules — the fixed linear path new hires walk through
-- ───────────────────────────────────────────────────────────────
create table if not exists training_modules (
  id                  uuid primary key default gen_random_uuid(),
  order_index         int not null unique,
  title               text not null,
  objection_type      text not null,        -- ties back to CallIQ's objection taxonomy
  persona_prompt      text not null,        -- system prompt for the AI "prospect"
  persona_name        text not null default 'Family Member',
  difficulty          text not null default 'easy', -- easy | moderate | hard | veteran
  pass_threshold      numeric not null default 7.0,
  prerequisite_module_id uuid references training_modules(id),
  is_active           boolean not null default true,
  created_at          timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────
-- 2. trainee_progress — one row per (rep, module), tracks unlock state
-- ───────────────────────────────────────────────────────────────
create table if not exists trainee_progress (
  id             uuid primary key default gen_random_uuid(),
  rep_id         text not null,        -- rep name or stable id, matches CallIQ's rep_name convention
  team           text,
  module_id      uuid not null references training_modules(id),
  status         text not null default 'locked', -- locked | unlocked | in_progress | passed
  attempts       int not null default 0,
  best_score     numeric,
  last_attempt_at timestamptz,
  updated_at     timestamptz not null default now(),
  unique (rep_id, module_id)
);

-- ───────────────────────────────────────────────────────────────
-- 3. training_attempts — every attempt logged, for manager visibility
--    Extended with disposition fields: how the rep logged the outcome
--    in the planner app + a photo of the notes they took.
-- ───────────────────────────────────────────────────────────────
create table if not exists training_attempts (
  id                      uuid primary key default gen_random_uuid(),
  rep_id                  text not null,
  team                    text,
  module_id               uuid not null references training_modules(id),
  transcript              text,                 -- full role-play call transcript
  passed                  boolean,
  overall_score           numeric,
  result_json             jsonb,                -- full scoring payload (mirrors CallIQ's result shape)

  -- Disposition capture (new)
  disposition_reported    text,                 -- what the rep selected as the outcome, e.g. 'appointment_set'
  disposition_notes_text  text,                 -- optional free-text on how the rep felt it went
  notes_photo_url         text,                 -- photo of the rep's handwritten/planner-app notes
  disposition_match_score numeric,              -- 1-10: how well the reported disposition + notes match the actual call
  disposition_feedback    text,                 -- AI feedback: what they logged vs what to have logged, gaps in notes

  status                  text not null default 'pending', -- pending | scoring | done | error
  error                   text,
  created_at              timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────
-- 4. score_jobs equivalent for the trainer app — separate from CallIQ's
--    own score_jobs table so the two apps' background-job queues don't collide.
-- ───────────────────────────────────────────────────────────────
create table if not exists trainer_score_jobs (
  id           uuid primary key default gen_random_uuid(),
  attempt_id   uuid references training_attempts(id),
  status       text not null default 'pending', -- pending | done | error
  result_json  jsonb,
  error        text,
  created_at   timestamptz not null default now()
);

create table if not exists trainer_transcription_jobs (
  id          uuid primary key default gen_random_uuid(),
  file_url    text,
  file_name   text,
  status      text not null default 'pending',
  transcript  text,
  error       text,
  created_at  timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────
-- Indexes
-- ───────────────────────────────────────────────────────────────
create index if not exists idx_trainee_progress_rep on trainee_progress(rep_id);
create index if not exists idx_training_attempts_rep on training_attempts(rep_id);
create index if not exists idx_training_attempts_module on training_attempts(module_id);

-- ───────────────────────────────────────────────────────────────
-- Storage buckets (public, same pattern as CallIQ's call-recordings bucket)
-- ───────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('training-recordings', 'training-recordings', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('training-notes-photos', 'training-notes-photos', true)
on conflict (id) do nothing;

-- ───────────────────────────────────────────────────────────────
-- RLS — mirror CallIQ's open-anon-key pattern (app enforces access via
-- the anon key client-side; no auth layer yet, matching CallIQ v22).
-- If CallIQ's tables already have permissive anon policies, these mirror them.
-- ───────────────────────────────────────────────────────────────
alter table training_modules enable row level security;
alter table trainee_progress enable row level security;
alter table training_attempts enable row level security;
alter table trainer_score_jobs enable row level security;
alter table trainer_transcription_jobs enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'training_modules' and policyname = 'anon_all_training_modules') then
    create policy anon_all_training_modules on training_modules for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'trainee_progress' and policyname = 'anon_all_trainee_progress') then
    create policy anon_all_trainee_progress on trainee_progress for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'training_attempts' and policyname = 'anon_all_training_attempts') then
    create policy anon_all_training_attempts on training_attempts for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'trainer_score_jobs' and policyname = 'anon_all_trainer_score_jobs') then
    create policy anon_all_trainer_score_jobs on trainer_score_jobs for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'trainer_transcription_jobs' and policyname = 'anon_all_trainer_transcription_jobs') then
    create policy anon_all_trainer_transcription_jobs on trainer_transcription_jobs for all using (true) with check (true);
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────
-- Seed: first 5 modules for v1, using CallIQ's existing objection taxonomy
-- (send-info, not-interested, dont-recall, need-spouse, body-donation,
--  has-plans, too-busy, family-will-handle, moving, life-insurance,
--  has-plot, has-will, va-benefits, after-holidays, surgery, veteran-lead, other)
-- Edit persona_prompt wording with Taylor/managers before go-live — these are
-- first-draft personas generated from the plan, not final copy.
-- ───────────────────────────────────────────────────────────────
insert into training_modules (order_index, title, objection_type, persona_name, difficulty, pass_threshold, persona_prompt)
values
(
  1,
  'Module 1: The Receptive Prospect',
  'other',
  'Diane (age 68)',
  'easy',
  7.0,
  'You are playing DIANE, a 68-year-old woman whose husband recently mentioned they should "get their affairs in order." A rep from a pre-planning service is calling. You are warm, a little talkative, and genuinely open to the idea — you just want to understand what it involves. You do not raise hard objections; at most you ask a clarifying question or two (cost, what''s included). If the rep is polite, listens, and explains clearly, agree to schedule an appointment. Speak like a real person on the phone: short sentences, natural pauses, occasional "oh" or "well". Never break character or mention you are an AI. Respond only in the required JSON format.'
),
(
  2,
  'Module 2: "Just Send Me Some Information"',
  'send-info',
  'Robert (age 61)',
  'easy',
  7.0,
  'You are playing ROBERT, 61, a practical, slightly guarded man. When the rep calls, your instinct is to deflect with "just mail me some information" or "email it to me." You are not hostile, just busy and non-committal. If the rep pushes back once with a good reason why a short appointment beats a mailer (e.g., questions come up that a pamphlet can''t answer), you soften and can be talked into a brief appointment. If the rep caves immediately and agrees to "just send info," the call ends without an appointment. Speak naturally, like a real phone call. Never break character. Respond only in the required JSON format.'
),
(
  3,
  'Module 3: "We Already Have a Will"',
  'has-will',
  'Carol (age 70)',
  'moderate',
  7.0,
  'You are playing CAROL, 70, confident and a little dismissive at first. You believe having a will means everything is "already handled" and don''t see why you need to talk about funeral pre-planning. You push back when the rep first raises the topic. A skilled rep should distinguish a will (assets/estate) from pre-planning (funeral wishes, costs locked in, family burden). If they explain that distinction clearly and respectfully (not condescendingly), you become interested and agree to an appointment. If they just repeat themselves or get pushy, you stay firm and end the call without scheduling. Speak naturally. Never break character. Respond only in the required JSON format.'
),
(
  4,
  'Module 4: The Spouse Objection',
  'need-spouse',
  'Linda (age 66)',
  'moderate',
  7.5,
  'You are playing LINDA, 66. You are interested but keep saying you can''t decide anything without your husband, who isn''t home. Your default move is to end the call and "have him call back." A strong rep will acknowledge that''s reasonable, but work to lock in a specific appointment time when BOTH of you can be there, rather than leaving it open-ended. If they get a specific day/time commitment with both spouses included, treat that as a win and agree. If they just say "have him call us" with no specific next step, the call ends with no appointment. Speak naturally, like a real person. Never break character. Respond only in the required JSON format.'
),
(
  5,
  'Module 5: Veteran, Skeptical of a Sales Call',
  'veteran-lead',
  'Frank (age 74, veteran)',
  'hard',
  8.0,
  'You are playing FRANK, 74, a Vietnam-era veteran. You are sharp, direct, and immediately suspicious this is "a sales pitch." You''ve heard veterans get taken advantage of by pre-planning companies before. You respond well to a rep who (a) is upfront and honest rather than cagey, (b) specifically and correctly mentions veteran/VA burial benefits and how this service coordinates with them, and (c) treats you with respect rather than urgency or pressure tactics. If they fumble the veteran-benefits topic, sound scripted, or push too hard, you shut the call down. This is the hardest module — hold a high bar. Speak naturally, like a real skeptical veteran on the phone. Never break character. Respond only in the required JSON format.'
)
on conflict (order_index) do nothing;

-- Wire up the linear prerequisite chain
update training_modules m1
set prerequisite_module_id = m0.id
from training_modules m0
where m0.order_index = m1.order_index - 1
  and m1.prerequisite_module_id is null;
