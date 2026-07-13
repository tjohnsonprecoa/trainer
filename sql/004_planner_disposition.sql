-- ═══════════════════════════════════════════════════════════════
-- FPC Training Pathway — 004: planner-style disposition capture
--
-- Adds:
--   - training_modules.fake_phone: a stable fake number per persona,
--     so the appointment form can auto-fill a phone for the rep to
--     "verify" (per plan: fake, checkbox-only, no real data needed).
--   - training_attempts.disposition_form_json: full structured detail
--     from whichever planner path the rep used (appointment vs.
--     result/disposition). Manager-review only for now — NOT scored
--     by the AI. The existing disposition_reported/disposition_notes_text
--     columns still get a coarse summary for the existing AI grading.
-- ═══════════════════════════════════════════════════════════════

alter table training_modules add column if not exists fake_phone text;
alter table training_attempts add column if not exists disposition_form_json jsonb;

update training_modules set fake_phone = '612-555-0142' where order_index = 11; -- Diane
update training_modules set fake_phone = '612-555-0187' where order_index = 12; -- Nancy
update training_modules set fake_phone = '651-555-0119' where order_index = 13; -- Patricia
update training_modules set fake_phone = '320-555-0234' where order_index = 21; -- Robert
update training_modules set fake_phone = '320-555-0198' where order_index = 22; -- Susan
update training_modules set fake_phone = '507-555-0176' where order_index = 23; -- Gary
update training_modules set fake_phone = '218-555-0143' where order_index = 31; -- Carol
update training_modules set fake_phone = '218-555-0165' where order_index = 32; -- Helen
update training_modules set fake_phone = '763-555-0129' where order_index = 33; -- Margaret
update training_modules set fake_phone = '952-555-0187' where order_index = 41; -- Linda
update training_modules set fake_phone = '952-555-0154' where order_index = 42; -- Barbara
update training_modules set fake_phone = '763-555-0198' where order_index = 43; -- Dorothy
update training_modules set fake_phone = '320-555-0161' where order_index = 51; -- Frank
update training_modules set fake_phone = '320-555-0173' where order_index = 52; -- Sharon
update training_modules set fake_phone = '507-555-0142' where order_index = 53; -- Walter
