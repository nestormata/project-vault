-- Story 46.1: hardware authenticator public keys and registration challenges.
-- Identity-scoped. No org_id, no RLS, no GRANT (default privileges from 0001). Additive only.
CREATE TABLE "webauthn_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"transports" text,
	"aaguid" text,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "webauthn_credentials_sign_count_check" CHECK ("webauthn_credentials"."sign_count" >= 0),
	CONSTRAINT "webauthn_credentials_name_length_check" CHECK (char_length("webauthn_credentials"."name") BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_webauthn_credentials_credential_id" ON "webauthn_credentials" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "idx_webauthn_credentials_user_id" ON "webauthn_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE TABLE "webauthn_registration_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webauthn_registration_challenges_expires_after_created_check" CHECK ("webauthn_registration_challenges"."expires_at" > "webauthn_registration_challenges"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_webauthn_registration_challenges_user_id" ON "webauthn_registration_challenges" USING btree ("user_id");
