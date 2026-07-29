-- Story 17.3 AC-10/FR125: append-only "rotation-recommended nudge" dismissal history. Each
-- dismissal is its own row (not an update-in-place flag) — a credential/field's dismissal history
-- is itself auditable without duplicating the same data in a separate audit-log entry. `reason`
-- has no DB-level CHECK for non-empty content (enforced at the API layer as a clean 422, per
-- Task 1.4 — a CHECK violation would surface as a confusing 500 instead).
CREATE TABLE "credential_share_nudge_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"field_key" text,
	"dismissed_by" uuid NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credential_share_nudge_dismissals" ADD CONSTRAINT "credential_share_nudge_dismissals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credential_share_nudge_dismissals" ADD CONSTRAINT "credential_share_nudge_dismissals_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credential_share_nudge_dismissals" ADD CONSTRAINT "credential_share_nudge_dismissals_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_credential_share_nudge_dismissals_bucket" ON "credential_share_nudge_dismissals" USING btree ("credential_id","field_key","dismissed_at" DESC);
--> statement-breakpoint
CREATE INDEX "idx_credential_share_nudge_dismissals_org" ON "credential_share_nudge_dismissals" USING btree ("org_id");
--> statement-breakpoint
ALTER TABLE credential_share_nudge_dismissals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY credential_share_nudge_dismissals_isolation
  ON credential_share_nudge_dismissals
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
