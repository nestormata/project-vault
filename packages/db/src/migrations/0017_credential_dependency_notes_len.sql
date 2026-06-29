ALTER TABLE "credential_dependencies"
  ADD CONSTRAINT "credential_dependencies_notes_len_check"
  CHECK ("notes" IS NULL OR char_length("notes") <= 2048);
