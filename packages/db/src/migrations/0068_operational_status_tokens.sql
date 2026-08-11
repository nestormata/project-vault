CREATE TABLE "operational_status_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"hmac_key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"rotated_from_token_id" uuid,
	CONSTRAINT "operational_status_tokens_token_hash_len_check" CHECK (char_length("operational_status_tokens"."token_hash") = 64)
);
--> statement-breakpoint
ALTER TABLE "operational_status_tokens" ADD CONSTRAINT "operational_status_tokens_rotated_from_token_id_fk" FOREIGN KEY ("rotated_from_token_id") REFERENCES "public"."operational_status_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_operational_status_tokens_token_hash" ON "operational_status_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_operational_status_tokens_active" ON "operational_status_tokens" USING btree ("created_at") WHERE "operational_status_tokens"."revoked_at" IS NULL;
