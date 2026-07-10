-- Story 3.6: widen notification_preferences.channel so a persisted 'none' row can represent a
-- durable opt-out. Roll-forward is safe because this only adds an allowed value.
-- Rolling back by narrowing the constraint again is NOT safe until every existing 'none' row has
-- been deleted first; otherwise Postgres will reject the ALTER TABLE on existing data.
ALTER TABLE "notification_preferences"
  DROP CONSTRAINT "notification_preferences_channel_check";

ALTER TABLE "notification_preferences"
  ADD CONSTRAINT "notification_preferences_channel_check"
  CHECK ("notification_preferences"."channel" IN ('email', 'slack', 'inbox', 'none'));
