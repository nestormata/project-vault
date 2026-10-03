-- Story 71.1 AC-4 — dedupe record for idempotent AuditEventSourceHost.writeAuditEvent. One new,
-- RLS-isolated table; audit_log_entries itself (columns, HMAC input, chain, immutability triggers)
-- is untouched (AC-5). Stores a content fingerprint only, never a payload copy. audit_entry_id
-- cascades so a key lives exactly as long as its audit row and the sanctioned retention purge
-- (purge_expired_audit_log_entries) is never blocked by this table. vault_app is append-only
-- (SELECT, INSERT): the cascade runs as the table owner.
CREATE TABLE "extension_audit_idempotency_keys" (
	"org_id" uuid NOT NULL,
	"extension_name" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"content_fingerprint" text NOT NULL,
	"audit_entry_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_audit_idempotency_keys_org_id_extension_name_idempotency_key_pk" PRIMARY KEY("org_id","extension_name","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "extension_audit_idempotency_keys" ADD CONSTRAINT "extension_audit_idempotency_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_audit_idempotency_keys" ADD CONSTRAINT "extension_audit_idempotency_keys_audit_entry_id_audit_log_entries_id_fk" FOREIGN KEY ("audit_entry_id") REFERENCES "public"."audit_log_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_extension_audit_idempotency_keys_audit_entry" ON "extension_audit_idempotency_keys" USING btree ("audit_entry_id");--> statement-breakpoint

ALTER TABLE "extension_audit_idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY extension_audit_idempotency_keys_isolation
  ON extension_audit_idempotency_keys
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "extension_audit_idempotency_keys" OWNER TO vault_owner;--> statement-breakpoint
ALTER TABLE "extension_audit_idempotency_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- The schema default privileges hand vault_app full CRUD on every new table; strip everything but
-- SELECT/INSERT at the privilege layer (same belt-and-braces as 0002 for audit_log_entries).
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "extension_audit_idempotency_keys" FROM vault_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "extension_audit_idempotency_keys" TO vault_app;