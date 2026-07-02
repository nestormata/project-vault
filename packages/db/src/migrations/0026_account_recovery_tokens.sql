CREATE TABLE "account_recovery_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"initiated_by" text NOT NULL,
	"initiator_user_id" uuid,
	"initiator_org_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_recovery_tokens_initiated_by_check" CHECK ("account_recovery_tokens"."initiated_by" IN ('self','admin'))
);
--> statement-breakpoint
ALTER TABLE "account_recovery_tokens" ADD CONSTRAINT "account_recovery_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account_recovery_tokens" ADD CONSTRAINT "account_recovery_tokens_initiator_user_id_users_id_fk" FOREIGN KEY ("initiator_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account_recovery_tokens" ADD CONSTRAINT "account_recovery_tokens_initiator_org_id_organizations_id_fk" FOREIGN KEY ("initiator_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_account_recovery_tokens_token_hash" ON "account_recovery_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "idx_account_recovery_tokens_user_id" ON "account_recovery_tokens" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_account_recovery_tokens_expires_at" ON "account_recovery_tokens" USING btree ("expires_at");
