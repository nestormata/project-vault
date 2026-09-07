-- Story 35.1 Design Decision 4/Task 2 — new, purely additive durable outbox table backing
-- `ExtensionHooks.projectArchiveNotifier`. Modeled on `notification_queue` (org-scoped, status
-- CHECK, attemptCount/lastAttemptAt, partial pending index) but deliberately a SEPARATE table —
-- see `packages/db/src/schema/extension-lifecycle-events.ts`'s own doc comment and this story's
-- Design Decision 4 Architecture Decision Record for why `notification_queue` itself was not
-- reused (channel-shaped for "a message to a human," not "a structured event payload for an
-- extension"; different retry/backoff tuning needs).
--
-- Archive-vs-delete honesty (AC6): every row this story's own application code ever inserts has
-- `event_type = 'project_archived'`, corresponding to PV's own ARCHIVE (non-destructive,
-- reversible) operation — never a deletion. `event_type` is left an open `text` column (no CHECK
-- enum), not because deletion is planned, but so a wholly separate, future hard-delete story
-- could additively reuse this same outbox/worker with its own `event_type` value without a
-- breaking schema change (Design Decision 7).
--
-- `project_id` is FK CASCADE to `projects(id)`, but archiving a project does NOT delete its
-- `projects` row (see `apps/api/src/modules/projects/routes.ts`'s archive/unarchive pair, which
-- only ever sets/clears `archived_at`) — this FK's cascade path only fires if a `projects` row is
-- later removed by some OTHER mechanism (e.g. an org-deletion cascade), not as part of this
-- table's normal row lifecycle.
CREATE TABLE "extension_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "extension_lifecycle_events_status_check" CHECK ("extension_lifecycle_events"."status" IN ('pending','delivered','failed'))
);
--> statement-breakpoint
ALTER TABLE "extension_lifecycle_events" ADD CONSTRAINT "extension_lifecycle_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_lifecycle_events" ADD CONSTRAINT "extension_lifecycle_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_extension_lifecycle_events_pending" ON "extension_lifecycle_events" USING btree ("org_id","status") WHERE "extension_lifecycle_events"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_extension_lifecycle_events_created_at" ON "extension_lifecycle_events" USING btree ("created_at");--> statement-breakpoint

-- AC4 — RLS enable+force with a FOR ALL ... USING (...) WITH CHECK (...) policy on
-- org_id = current_setting('app.current_org_id', true)::uuid, same shape as
-- extension_ephemeral_state's policy in migration 0084. Story 24.1 (migration 0070) requires
-- RLS-enabled tables to be owned by the non-superuser, NOBYPASSRLS vault_owner role with FORCE
-- ROW LEVEL SECURITY set, or `make check-rls` rejects them. This is the tenant-isolation guardrail
-- the worker's own per-row `withOrg(row.orgId, ...)` scoping (AC4) relies on structurally, not
-- just by application-code discipline.
ALTER TABLE "extension_lifecycle_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY extension_lifecycle_events_isolation
  ON extension_lifecycle_events
  FOR ALL
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "extension_lifecycle_events" OWNER TO vault_owner;--> statement-breakpoint
ALTER TABLE "extension_lifecycle_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "extension_lifecycle_events" TO vault_app;