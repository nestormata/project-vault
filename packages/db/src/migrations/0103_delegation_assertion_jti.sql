-- Story 71.7 — burn ledger for service-delegated actor assertions (71-2 design note 4.3, check 12).
-- One additive, FORCE-RLS, org-scoped table; handoff_token_jti and every other table are untouched.
-- The (org_id, jti) primary key IS the replay decision (insert-first; 23505 = replayed). Rows live
-- about 90 s (exp + 30 s skew) plus a 300 s prune grace and are reclaimed by the
-- delegation/prune-assertion-jti worker. vault_app is append-only (SELECT, INSERT): application code
-- can never un-burn a row. vault_admin gets only the columns the prune's WHERE/sub-select reads plus
-- DELETE (same least-privilege shape as 0085). vault_extension gets nothing.
CREATE TABLE "delegation_assertion_jti" (
	"org_id" uuid NOT NULL,
	"jti" text NOT NULL,
	"kid" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delegation_assertion_jti_org_id_jti_pk" PRIMARY KEY("org_id","jti"),
	CONSTRAINT "delegation_assertion_jti_jti_len" CHECK (octet_length("delegation_assertion_jti"."jti") BETWEEN 1 AND 128),
	CONSTRAINT "delegation_assertion_jti_kid_len" CHECK (octet_length("delegation_assertion_jti"."kid") BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "delegation_assertion_jti" ADD CONSTRAINT "delegation_assertion_jti_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_delegation_assertion_jti_expires_at" ON "delegation_assertion_jti" USING btree ("expires_at");--> statement-breakpoint

ALTER TABLE "delegation_assertion_jti" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY delegation_assertion_jti_isolation
  ON delegation_assertion_jti
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "delegation_assertion_jti" OWNER TO vault_owner;--> statement-breakpoint
ALTER TABLE "delegation_assertion_jti" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- The schema default privileges hand vault_app full CRUD on every new table; strip everything but
-- SELECT/INSERT at the privilege layer (same belt-and-braces as 0102).
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "delegation_assertion_jti" FROM vault_app;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "delegation_assertion_jti" TO vault_app;--> statement-breakpoint

-- Cross-org prune over the admin (BYPASSRLS) pool: RLS bypass is orthogonal to table privileges.
GRANT SELECT (org_id, jti, expires_at) ON TABLE "delegation_assertion_jti" TO vault_admin;--> statement-breakpoint
GRANT DELETE ON TABLE "delegation_assertion_jti" TO vault_admin;
