CREATE TABLE "extension_oauth_pending_states" (
	"id" text PRIMARY KEY NOT NULL,
	"cookie_hash" text NOT NULL,
	"extension_name" text NOT NULL,
	"state_json" text NOT NULL,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_oauth_pending_states_cookie_hash_unique" UNIQUE("cookie_hash")
);
--> statement-breakpoint
CREATE INDEX "idx_extension_oauth_pending_states_expires_at" ON "extension_oauth_pending_states" USING btree ("expires_at");