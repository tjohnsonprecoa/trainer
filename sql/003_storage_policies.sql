-- ═══════════════════════════════════════════════════════════════
-- FPC Training Pathway — 003: storage RLS policies
--
-- Fixes "new row violates row-level security policy" when uploading
-- role-play audio or notes photos. Marking a bucket "public" (done in
-- 001) only makes reads public — inserts still need an explicit RLS
-- policy on storage.objects, same as CallIQ's own call-recordings
-- bucket already has (just never copied over for our two new buckets).
-- ═══════════════════════════════════════════════════════════════

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'trainer_read_recordings') then
    create policy trainer_read_recordings on storage.objects for select
      using (bucket_id = 'training-recordings');
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'trainer_upload_recordings') then
    create policy trainer_upload_recordings on storage.objects for insert
      with check (bucket_id = 'training-recordings');
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'trainer_read_notes_photos') then
    create policy trainer_read_notes_photos on storage.objects for select
      using (bucket_id = 'training-notes-photos');
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'trainer_upload_notes_photos') then
    create policy trainer_upload_notes_photos on storage.objects for insert
      with check (bucket_id = 'training-notes-photos');
  end if;
end $$;
