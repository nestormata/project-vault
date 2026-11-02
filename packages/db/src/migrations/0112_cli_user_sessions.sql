-- Story 43.30: user-level CLI sessions. No RLS and no organization column: a browser-approved
-- CLI sign-in is not bound to an org. Organization access is a separate short-lived credential
-- recorded in cli_org_credentials. Additive only.
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"jti" text NOT NULL,
	"session_version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cli_org_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_session_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_refresh_tokens" ADD CONSTRAINT "user_refresh_tokens_user_session_id_user_sessions_id_fk" FOREIGN KEY ("user_session_id") REFERENCES "public"."user_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cli_org_credentials" ADD CONSTRAINT "cli_org_credentials_user_session_id_user_sessions_id_fk" FOREIGN KEY ("user_session_id") REFERENCES "public"."user_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_sessions_jti" ON "user_sessions" USING btree ("jti");
--> statement-breakpoint
CREATE INDEX "idx_user_sessions_user_id" ON "user_sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_user_sessions_expires_at" ON "user_sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_refresh_tokens_token_hash" ON "user_refresh_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX "idx_user_refresh_tokens_session_id" ON "user_refresh_tokens" USING btree ("user_session_id");
--> statement-breakpoint
CREATE INDEX "idx_cli_org_credentials_user_session_id" ON "cli_org_credentials" USING btree ("user_session_id");
