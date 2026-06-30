CREATE TABLE "notification_inbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "alert_type" text NOT NULL,
  "severity" text NOT NULL DEFAULT 'warning',
  "payload" jsonb NOT NULL DEFAULT '{}',
  "read_at" timestamptz,
  "dismissed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notification_inbox_unread_idx"
  ON "notification_inbox" (org_id, user_id, read_at)
  WHERE read_at IS NULL AND dismissed_at IS NULL;
--> statement-breakpoint
CREATE INDEX "notification_inbox_expiry_idx"
  ON "notification_inbox" (expires_at)
  WHERE dismissed_at IS NULL;
--> statement-breakpoint
CREATE INDEX "notification_inbox_user_idx"
  ON "notification_inbox" (org_id, user_id, created_at DESC);
--> statement-breakpoint
ALTER TABLE "notification_inbox" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "notification_inbox_user_isolation"
  ON "notification_inbox"
  USING (
    org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  );
