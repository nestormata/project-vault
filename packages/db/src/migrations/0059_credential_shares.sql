-- Story 17.1 AC-6: new credential_shares table. Shared with Story 17.2's external-recipient path
-- (recipient_type = 'external' / recipient_email) — this story only ever writes
-- recipient_type = 'user' rows; the external half is schema-ready but unreachable from this
-- story's routes. RLS: standard org_id-scoped policy, no exception needed — this story's access
-- route always requires an authenticated session (no anonymous/bearer-only path), unlike 17.2's
-- planned external-token path.
CREATE TABLE "credential_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"field_key" text,
	"shared_by" uuid NOT NULL,
	"recipient_type" text NOT NULL,
	"recipient_user_id" uuid,
	"recipient_email" text,
	"token_hash" text NOT NULL,
	"single_use" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"first_viewed_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "credential_shares_recipient_type_check" CHECK ("credential_shares"."recipient_type" IN ('user','external')),
	CONSTRAINT "credential_shares_status_check" CHECK ("credential_shares"."status" IN ('active','viewed','revoked','expired','superseded'))
);
--> statement-breakpoint
ALTER TABLE "credential_shares" ADD CONSTRAINT "credential_shares_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD CONSTRAINT "credential_shares_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD CONSTRAINT "credential_shares_shared_by_users_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_shares" ADD CONSTRAINT "credential_shares_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_credential_shares_token_hash" ON "credential_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_credential_shares_credential_status" ON "credential_shares" USING btree ("credential_id","status");--> statement-breakpoint
CREATE INDEX "idx_credential_shares_recipient_status" ON "credential_shares" USING btree ("recipient_user_id","status");--> statement-breakpoint
CREATE INDEX "idx_credential_shares_org" ON "credential_shares" USING btree ("org_id");

ALTER TABLE credential_shares ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY credential_shares_isolation
  ON credential_shares
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
