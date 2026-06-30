DROP POLICY IF EXISTS "notification_inbox_user_isolation" ON "notification_inbox";
--> statement-breakpoint
CREATE POLICY "notification_inbox_user_isolation"
  ON "notification_inbox"
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );
