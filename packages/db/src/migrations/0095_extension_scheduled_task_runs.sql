-- Story 56.1 Task 3 (ODQ2) — PV-tracked due-state for the scheduled-task extension hook. See
-- packages/db/src/schema/extension-scheduled-task-runs.ts's own doc comment for the full
-- design rationale, including WHY extension_id is a plain text column (not an FK): PV has no
-- per-org "extension installed" table anywhere in this codebase (confirmed directly against
-- extension-lifecycle-notify.ts / loader.ts's single-extension-per-process precedent during this
-- story's implementation) — org_id's own ON DELETE CASCADE is the real orphan-prevention
-- mechanism this table relies on.
CREATE TABLE "extension_scheduled_task_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"extension_id" text NOT NULL,
	"task_name" text NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extension_scheduled_task_runs" ADD CONSTRAINT "extension_scheduled_task_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_extension_scheduled_task_runs_extension_task_org" ON "extension_scheduled_task_runs" USING btree ("extension_id","task_name","org_id");--> statement-breakpoint
CREATE INDEX "idx_extension_scheduled_task_runs_org_id" ON "extension_scheduled_task_runs" USING btree ("org_id");--> statement-breakpoint

-- AC (Task 3) — RLS enable+force with a FOR ALL ... USING (...) WITH CHECK (...) policy on
-- org_id = current_setting('app.current_org_id', true)::uuid, identical shape to
-- extension_lifecycle_events' policy in migration 0092. Story 24.1 (migration 0070) requires
-- RLS-enabled tables to be owned by the non-superuser, NOBYPASSRLS vault_owner role with FORCE
-- ROW LEVEL SECURITY set, or `make check-rls` rejects them.
ALTER TABLE "extension_scheduled_task_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY extension_scheduled_task_runs_isolation
  ON extension_scheduled_task_runs
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "extension_scheduled_task_runs" OWNER TO vault_owner;--> statement-breakpoint
ALTER TABLE "extension_scheduled_task_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "extension_scheduled_task_runs" TO vault_app;