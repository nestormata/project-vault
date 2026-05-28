---
stepsCompleted: [1, 2, 3]
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/product-brief-Project-Vault.md
  - _bmad-output/planning-artifacts/product-brief-Project-Vault-distillate.md
  - _bmad-output/planning-artifacts/prd-validation-report.md
  - _bmad-output/planning-artifacts/research/market-secrets-management-tools-research-2026-04-09.md
  - _bmad-output/planning-artifacts/research/technical-cryptographic-architecture-secrets-vault-research-2026-04-08.md
  - _bmad-output/planning-artifacts/research/technical-machine-user-auth-offline-caching-research-2026-04-09.md
  - _bmad-output/planning-artifacts/research/technical-multi-tenancy-data-model-research-2026-04-09.md
  - _bmad-output/planning-artifacts/research/technical-rbac-permission-architecture-research-2026-04-09.md
  - _bmad-output/planning-artifacts/research/technical-rotation-plugin-architecture-research-2026-04-09.md
  - _bmad-output/planning-artifacts/research/technical-service-health-monitoring-architecture-research-2026-04-09.md
  - docs/federated-multi-tenant-architecture-analysis.md
---

# UX Design Specification Project Vault

**Author:** Nestor
**Date:** 2026-05-27

---

<!-- UX design content will be appended sequentially through collaborative workflow steps -->

## Executive Summary

### Project Vision

Project Vault is a self-hostable, open-core Project Operations Platform (ProjOps) — the institutional
memory of an engineering project. Where every existing secrets manager organizes by environment (dev /
staging / prod), Project Vault organizes by *project*: credentials, certificates, domains, services,
payments, and documentation grouped under the natural unit of engineering responsibility.

This is not a UI reorganization. It is a different data model, a different RBAC model, and a different
mental model.

The product's fundamental job is to replace operational anxiety with operational confidence. Engineers
use this product because they are afraid — afraid a certificate will expire unnoticed, afraid a
rotation will leave one system behind, afraid an engineer's departure will take critical knowledge with
it. The aha moment is not a dashboard state and not a specific caught event. It is the first time a
user realizes they are no longer afraid of missing something. That moment is the design target. Every
decision from import UX to empty state to alert design should be evaluated against a single question:
does this increase or decrease the user's confidence that nothing critical is unknown or unattended?

A critical implication: the value of completeness is nearly binary. A project with 90% of its
operational assets in the vault is almost as anxious as one with 0% — the engineer knows something
is missing, they just don't know what. A project at 100% crosses a qualitative threshold: for the
first time, the absence of an alert genuinely means nothing needs attention. The product must
actively drive users toward complete project coverage — surfacing what is absent alongside what is
present, making gaps as visible as warnings.

The product ships as self-hosted Docker (open-source core) with a commercial SaaS tier in v2.
Tagline: *Run complex projects. Miss nothing.*

### Target Users

**Alex — Engineering Lead (Primary)**
Mid-size team, 5–50 engineers, complex multi-service project. Has been burned by credential rotations
that didn't fully propagate. Needs the team's operational truth in one place, audit logs for the CTO,
and rotation that confirms every system before retiring the old credential. Alex completes the
onboarding wizard — but his team of 15 engineers joins over the following weeks without it. The mental
model challenge is not Alex's alone; it recurs for every new team member and must be reinforced
continuously by the product's information architecture, not solved once at first-run.

**Sam — Solo/Indie Developer (Secondary)**
Six active projects of wildly different scales — some with 3 secrets, some with 80. Needs a cross-
project dashboard that degrades gracefully across that range. Highly sensitive to import quality: will
decide whether to trust the product in the first five minutes based on whether the import review screen
shows exactly what will be created before committing. Alert signal quality is a churn risk — with
credentials, certs, domains, and payments all tracked, Sam needs the system to surface the right
urgency at the right time by default, without requiring manual configuration of notification rules.

**Morgan — Platform Engineer / On-Call (Edge Case)**
80-person company, on-call at 2am. Requires mobile-*actionable* incident response: alert notifications
deep-link directly to the affected resource; rotation status and version-per-system accessible within
two taps; 24-hour audit trail on mobile; actions available (confirm system, add note, escalate) without
a full keyboard. The mental model must be reinforced enough through daily use that it is available as
muscle memory under stress — incident response is not the time for re-education.

**Dana — Security & Compliance Lead**
SOC 2 audit next month. Needs filterable, exportable audit logs and rotation history per credential.
Critically: must be able to *verify* the audit log is complete and unmodified *before* relying on it in
an audit — the export is only as trustworthy as the verification step preceding it. Account deletion
with ownership transfer must produce a clearly auditable outcome, since terminated-employee access is
a frequent auditor question.

**CI-Bot — Machine User (API Consumer)**
GitHub Actions pipeline, 40 runs per day. The DevOps engineer who configures CI-Bot is the real UX
subject. Scoping a machine user to the right project, role, and key expiry policy must be simple enough
that engineers don't shortcut it into shared service accounts — boundary collapse is a security failure
mode, not just a UX inconvenience. When the offline fallback activates, the engineer who owns CI needs
an actionable alert, not just an audit log entry they will never proactively read.

**Buyer — Engineering Manager / CTO**
Approves the tooling decision; may demo the product to their own leadership. Evaluates against a
different set of criteria from daily users: incident reduction, onboarding acceleration, audit
readiness, no vendor lock-in. If the product has no clear buyer entry point — a view that surfaces
security posture, team access, compliance readiness, and operational health in terms a CTO can read —
the sales motion breaks even when engineering loves it.

### Key Design Challenges

**1. The project-centric model should be enforced by structure, not taught by instruction**
The mental model challenge has been framed as re-education: teaching engineers to think in projects
instead of environments. But this framing assumes the product contains an environment layer that users
must consciously override. The first principle is simpler: if the product never shows an environment
layer, users cannot think in environments. The project-centric model is reinforced not by a wizard or
onboarding flow but by the product's structure itself — every navigation path, every search result,
every audit log entry, every empty state is organized around projects and nothing else. There is no
alternative structure to un-learn.

This reframes the wizard's role: it is not a re-education mechanism but a confidence-building
mechanism — a guided path to the first complete project picture, ending when the user has experienced
the project container as a natural, useful structure. The acceptance criterion remains (≥80% correct
placement of a second credential without prompting), but the mechanism that achieves it is the
product's architecture, not the wizard's content. The wizard must be bypass-proof, ending only after
at least one real credential is correctly placed.

New team members who join after the wizard encounter the same project-centric structure from day one.
There is nothing to un-learn because the alternative was never visible.

**2. Two fundamentally distinct interaction modes with opposite UX requirements**
Users interact with this product in two modes that must never be conflated in the same surface.

**Monitoring mode:** Checking that nothing needs attention. Passive, low cognitive load, very
frequent — daily or more. The user is not looking for anything specific; they are looking for absence.
No alerts, no warnings, nothing red. The interaction lasts 15–30 seconds when nothing is wrong. This
mode requires extreme information density: the maximum signal in the minimum visual space, optimized
for a single-glance confidence confirmation.

**Action mode:** Doing something specific — rotating a credential, investigating an alert, onboarding
a new service, exporting audit logs. Active, high cognitive load, infrequent. The user has a specific
goal and needs to complete it efficiently. This mode requires focused, step-by-step flows with
contextual education, clear progress indicators, and explicit checkpoints.

A dashboard optimized for action-mode navigation (many entry points, detailed panels, dense controls)
is actively wrong for monitoring mode. A checklist flow optimized for monitoring-mode skimmability is
actively wrong for action-mode execution. The design must identify which surfaces serve which mode and
hold them to that mode's requirements — not blend the two in the interest of feature density.

**3. Role-appropriate complexity tiering**
The product's internal complexity — cryptographic key management, plugin sandboxing, RBAC structure,
tenant isolation, vault unsealing — cannot surface as confusion to read-only users or casual members.
But it must surface *appropriately* to Admins and Owners who are responsible for security-critical
configuration decisions. An Admin who configures machine user scoping, offline fallback key derivation,
or rotation policy without understanding the trade-offs makes consequential choices with false
confidence.

Three design principles govern this challenge:

**Correct path = default path.** For every security-critical configuration flow, the most secure
correct behavior must be the path of least resistance. Expanding scope, reducing security controls,
or overriding defaults requires deliberate, visible override — not the reverse. If creating a properly
scoped machine user requires more steps than creating a broadly scoped one, engineers will take the
shortcut. The architecture of each flow must make the right choice the easy choice.

**Contextual education at the decision point.** Documentation belongs at the moment of the decision,
as primary UI content — not in a help center, not in a modal, not in a tooltip. Vault unsealing
configuration, offline fallback key derivation, rotation policy, and MFA recovery each need inline,
plain-language context explaining what the choice protects against, what it does not protect against,
and who it is right for. Complexity is acceptable when it is explained; unexplained complexity is
the only kind that produces churn or dangerous misconfiguration.

**Verification precedes export.** For any flow where the output becomes compliance evidence — audit
log export, access report, rotation history — integrity verification or review must be the mandatory
first step in the flow, not an optional advanced feature. The exported artifact should be self-
evidencing: the verification summary travels with the data so the user never needs to explain the
verification step separately to an auditor.

Flows requiring particular role-aware design:
- Machine user setup: scope visualization before API key issuance
- Vault unsealing and key management configuration
- Rotation policy and checklist management
- MFA enrollment and account recovery
- Account deletion with ownership transfer
- Audit log integrity verification before compliance export

**4. Alert signal quality across heterogeneous asset types**
Project Vault tracks more alert-generating assets than any competitor: credentials, certificates,
domains, payments, service health, rotation schedules, anomalous access, fallback activation, backup
failures, machine user key expiry. Configuration panels and digest modes are insufficient — users do
not use notification configuration knobs, and building the product around that assumption produces
alert fatigue regardless of the configuration options available.

The design challenge is intelligent default signal quality: an alert that says "SSL certificate
expires in 30 days" is noise; an alert that says "SSL certificate expires in 4 days — no renewal
recorded" is signal. The system must calculate and surface urgency from context by default. Users
should rarely need to configure anything to receive the right alerts at the right time.

**5. Multi-persona, multi-context interaction design**
Sam's 30-second morning dashboard check; Morgan's 2am mobile incident response; Dana's quarterly
compliance export; Alex's deliberate team project management; the CTO's 10-minute product evaluation
— radically different interaction patterns on the same product. Each context requires a distinct
interaction model without fragmenting the product's coherence or distorting everyday UX priorities
toward edge-case scenarios.

**6. Audit log integrity verification for compliance workflows**
Before exporting audit logs for a formal security review, a compliance officer must be able to verify
the log is complete and unmodified. The current framing ("filter and export") skips the verification
step that makes the export trustworthy. The UX must include a clear, comprehensible integrity check —
one that a non-cryptographer can understand, that produces output an auditor will accept, and that
precedes every compliance export as a first-class step rather than an advanced option.

**7. Buyer-oriented entry point**
The buyer (Engineering Manager / CTO) evaluates the product with different intent than daily users.
If there is no UX path that surfaces security posture, team access state, compliance readiness, and
operational health in non-engineer terms, the buying decision falls on the engineer's recommendation
alone — a fragile adoption path for a commercial product. The design must include an explicit
buyer-oriented view: a governance surface distinct from the operator dashboard, covering team access
summary, compliance readiness indicators, and recent security events, exportable and shareable with
non-engineering stakeholders.

### Design Opportunities

**1. Designing toward operational confidence**
The product is won when a user realizes, for the first time, that they are no longer afraid of missing
something. Every design decision — from the import experience to the empty state to the alert surface
— should be evaluated against this outcome. Features that increase the user's confidence that their
project picture is complete and current are high-priority; features that add capability without
addressing completeness or anxiety are lower-priority regardless of their functional richness.

Practical implication: the monitoring surface must be designed to deliver a confident "nothing needs
attention" signal as fast as possible. A user who opens Project Vault, sees no alerts, and closes it
in 20 seconds with full confidence has had the product's most valuable interaction.

**2. Completeness visibility as a first-class surface**
Every project view should show what is *absent* alongside what is present. The product should actively
surface gaps in the project picture:

- "No domain records added to this project"
- "No machine users configured"
- "4 credentials have no dependent systems recorded"
- "No uptime monitoring configured for any service"

This is simultaneously a security feature (dependency gaps cause rotation failures), a retention
feature (users who reach 100% coverage cross the confidence threshold and don't churn), and an
onboarding driver (gaps create a natural pull toward completion without requiring prompting).

A project health score or coverage indicator — showing which expected asset categories are populated
— gives users a concrete, improvable target and makes the threshold moment (reaching complete
coverage) visible and rewarding.

**3. Import as the first trust moment**
The import experience determines whether the user trusts the product before they have meaningfully
used it. An import review screen that shows exactly what will be created — with field mapping visible,
conflicts surfaced, and nothing committed until the user confirms — converts a migration anxiety event
into a trust-building moment. This is where the onboarding funnel is most at risk and most improvable.

**4. Dependency recording as the primary rotation investment**
The rotation checklist is only as complete as the dependency data that populates it. Rotations fail
not because the checklist UX is poor but because the engineer rotating doesn't have an accurate list
of every system that uses the credential. A beautifully designed checklist populated with incomplete
dependency data still produces failed rotations.

The highest-value design investment in the rotation space is the moment of dependency recording —
when a credential is created or updated. The design must make recording dependent systems as fast and
natural as naming the credential itself. Every credential creation flow should include inline
dependency prompting: "Which systems or services use this credential?" with a fast-add interaction,
not a separate settings screen.

This dependency data then powers both the rotation checklist and the completeness visibility surface
(credentials with no recorded dependencies are flagged as gaps). The checklist interaction — adaptive
pace, mid-rotation dependency discovery, confirmation before retirement — is downstream of this data
investment and becomes significantly more valuable once the data is reliably complete.

**5. Security behaviors made visibly useful**
Security and usability are aligned in this product, not in tension. The behaviors that make the
product more secure — keeping dependency lists current, completing rotation checklists, maintaining
100% project coverage, recording operational context alongside credentials — are the same behaviors
that make the product more useful.

The design should make this connection explicit rather than treating security actions as compliance
friction. When an engineer adds a dependent system to a credential, the UI surfaces the benefit:
"This system will be included in future rotation checklists automatically." When a project reaches
complete coverage, the monitoring surface reflects it immediately. When an audit log is verified
before export, the verification summary travels with the exported file.

Security-reinforcing actions should produce immediate, visible product improvements — not abstract
compliance points. This framing converts security from overhead into investment.

**6. Adaptive rotation — speed from efficiency, not safety shortcuts**
The confirmation checklist model (generate new → per-system checklist → confirm each → retire old) is
architecturally novel and genuinely valuable. The UX can make planned rotations feel like a
satisfying, trustworthy ceremony that proves correctness.

For urgent rotations, speed comes from UX efficiency — fewer taps, pre-filled dependency lists, smart
defaults — not from a separate triage mode that can be misused to bypass safety checks. A single
rotation flow that adapts its pace and guidance density to context (planned vs. urgent, first rotation
vs. repeated, complete dependency list vs. newly discovered system) preserves the safety invariant
while accommodating the full range of real-world scenarios. Mid-rotation dependency discovery must be
supported as a first-class action: adding a system to the in-progress checklist without abandoning
the rotation.

**7. Empty states as onboarding storytelling**
Every zero-state is an opportunity to show what this project *could* look like when fully loaded —
drawing users toward their first import and making the project container feel natural before a single
credential is added. An empty project that communicates potential converts curiosity into action; one
that appears as a dead end converts action into churn.

**8. Mobile incident response as a measurable constraint**
Morgan's 2am use case establishes minimum performance criteria for mobile UX — not a design direction
that should reshape the overall UI architecture, but a bar that must be cleared:
- Alert deep-links resolve to the affected resource in ≤2 taps from notification
- Rotation status and version-per-system visible on mobile without horizontal scrolling
- Confirmation, note, and escalation actions available without a full keyboard
- 24-hour audit trail accessible on mobile within 3 taps from the affected resource

Everyday UX quality for Alex and Sam must not be compromised to optimize for this edge case.

**9. Machine user setup with scope visualization**
The machine user creation flow should present a concrete, reviewable scope boundary before the API key
is issued. The flow starts from a single-project default and shows, at the confirmation step, exactly
what the machine user *cannot* access alongside what it can:

  "This machine user will have read access to secrets in `payments-service`.
   It will not have access to `user-auth`, `billing`, or any other project."

Making scope boundaries visible and concrete transforms an abstract policy decision into a reviewable
outcome. Scope expansion to additional projects requires a deliberate additional step — making the
correct narrow default the path of least resistance. Once the API key is issued, scope changes require
a new key — a fact the confirmation step makes explicit.

**10. Organizational health view as buyer entry point**
A governance-oriented view distinct from the operator project dashboard serves both the buyer
acquisition path and the long-term retention motion. Surfaces:
- Team access summary: all users, their roles, and their project memberships across the organization
- Compliance readiness indicators: MFA enrollment coverage by role tier, audit log health, org-level
  credentials approaching expiry
- Recent security events: anomalous access alerts, fallback activations, failed auth thresholds
- Subscription usage against tier limits

Exportable and shareable with non-engineering stakeholders. A CTO who can share a current
organizational security health report — generated directly from Project Vault — has a concrete
artifact for board reviews, enterprise customer evaluations, and internal security reviews. This
converts the product from an engineering tool into an organizational trust mechanism.

## Core User Experience

### Defining Experience

The core interaction loop of Project Vault is the **monitoring scan**: a user opens the product,
confirms that nothing needs their attention, and closes it — in 15–30 seconds. This is the most
frequent interaction by a significant margin, occurring daily or more for every active user. The
product's primary surface must be optimized for this interaction above all others.

The monitoring scan succeeds when it communicates absence: no expiring certificates, no credentials
overdue for rotation, no services degraded, nothing red, nothing amber. A user who completes the
scan and sees green silence has had the product's highest-value interaction. The design must make
this outcome — confident non-action — feel like a complete and satisfying result, not an empty one.

Two secondary interactions define the product's retention and loyalty:

**The acquisition moment** — the first time a team opens the product after loading their project
and sees their full operational picture in one view: credentials, expiry dates, service health,
rotation status. This is the moment that determines week-1 retention. It must be reached quickly
after install; the critical path is the time between first Docker command and first populated view.

**The proof-of-value moment** — completing a rotation with every dependent system confirmed and the
old credential provably retired. This is the interaction that differentiates Project Vault from every
competitor, creates long-term loyalty, and generates the word-of-mouth that drives organic adoption.

### Platform Strategy

Project Vault is a **clean, accessible web application that works across contexts**. No native
mobile app; no desktop-specific application. The same product adapts to desktop, tablet, and mobile
through responsive layout — optimized for keyboard and mouse in desktop contexts, touch-accessible
in mobile contexts.

**"Clean across contexts" as a design constraint:**
- The monitoring surface communicates its state in a single glance on any device
- Information density adapts to viewport: desktop shows more, mobile shows signal only
- No interaction requires a specific device or input method to complete
- WCAG 2.1 AA compliance is a baseline requirement, not an enhancement

**Benchmark: HashiCorp Vault**
HashiCorp Vault's primary friction is setup complexity — creating a new service in the vault
requires navigating a path-based mental model, writing policies, configuring auth methods, and
understanding the secrets engine architecture. The result is that teams that successfully deploy
Vault often do so with months of operational overhead before it becomes useful.

Project Vault's platform experience is benchmarked against this. Every setup flow — adding a new
service, creating credentials, registering certificates, configuring machine users — must be
measurably faster than the equivalent operation in HashiCorp Vault. The target: a new service fully
registered (records created, monitoring active, alerts configured) in under two minutes from zero.
Credential retrieval must be faster still.

### Effortless Interactions

The following interactions must require zero deliberate effort — they either happen automatically,
or they are resolved in the fewest possible steps:

**Credential retrieval — faster than navigation**
Retrieving a credential must not require navigating to a project, finding the credentials section,
locating the entry, and revealing the value. The interaction model is search-first: a global
search or command surface resolves credentials by name in under three keystrokes, from anywhere in
the product. Users who know what they are looking for should never need to navigate to find it.
This is the single interaction that most directly competes with HashiCorp Vault's path-based model
and must win clearly.

**Service registration — monitoring starts automatically**
When a user adds a service URL to a project, health monitoring begins automatically at sensible
default intervals. No configuration step. No alert threshold to define. The system makes a
reasonable default decision (check every 5 minutes, alert on failure) and the user opts out if
needed — they never opt in. The same principle applies to SSL certificates (expiry monitoring
starts when the cert is added), domain records (renewal alerts configure at 60/30/7 days by
default), and credentials with expiry dates (rotation reminders schedule automatically).

**Coverage gap visibility — no manual audit**
The project's coverage gaps surface automatically and continuously. The user never needs to ask
"what am I missing?" — the product tells them. Credentials with no recorded dependent systems,
projects with no uptime monitoring, asset categories that are entirely absent — all surfaced in
the project view without any user action to reveal them.

**Team access — roles, not policies**
Adding a team member to a project is: invite → assign role → done. No policy files, no permission
matrix to configure, no path-based access rules. The role (Owner, Admin, Member, Viewer) carries
its permissions; the user inherits them immediately. Machine user setup follows the same simplicity
with one addition: the scope boundary is shown visually before the API key is issued.

### Critical Success Moments

**1. The first clean scan**
The first time a user opens the product after loading their project and sees no alerts — green
silence across all tracked assets. "I'm up to date. Nothing needs my attention." This is the
first anxiety-relief moment. It cannot happen until the project is substantially complete; driving
users toward completeness is therefore a prerequisite for this moment, not a consequence of it.

**2. The invisible service setup**
A developer adds a new service to a project — URL, credentials, SSL certificate — and monitoring
and alerts are active before they navigate away from the creation screen. They did not configure
a single alert. This moment demonstrates that the product works *for* them rather than requiring
them to work to use it.

**3. The search-to-value moment**
A developer types a credential name, sees it surface immediately, and retrieves the value in
under five seconds from the moment of intent. No navigation. No drill-down. No context-switching
to a different tool or browser tab. This interaction, repeated dozens of times weekly for power
users, is where the product either builds or loses daily engagement.

**4. The rotation that completed**
A rotation finishes. Every dependent system is confirmed. The old credential is retired. The audit
log records the full chain. The user did not need to chase a colleague, check five systems manually,
or wonder whether the old credential might still be active somewhere. This moment, the first time
it happens, is the proof that the product's core promise is real.

**5. The caught near-miss**
The product surfaces an alert — an expiring certificate, an approaching renewal date, an anomalous
access pattern — that the user had no idea about. "I would have missed that. That would have been
an incident." This moment builds loyalty that no feature list can replicate. It is the product
doing its job before the user knew they needed it.

### Experience Principles

**1. Absence is the primary signal**
The monitoring surface is designed to communicate "nothing needs attention" faster and more
clearly than it communicates individual alerts. Green silence is the product's most common and
most valuable state. The design must make non-action feel complete and satisfying — not empty.

**2. Setup velocity beats HashiCorp**
Every setup flow is benchmarked against HashiCorp Vault. Adding a new service, registering
credentials, configuring machine users, and onboarding a team member must each be measurably
faster. The target for a full new service registration is under two minutes. Credential retrieval
must be faster than navigation — resolved by search in under five seconds.

**3. Monitoring configures itself**
Operational assets that carry time-sensitive properties (services, certificates, domains,
credentials with expiry dates) automatically enroll in monitoring and alerting when registered.
Users opt out of defaults; they never opt in. The product makes reasonable decisions on their
behalf for non-security behaviors, freeing user attention for the decisions that actually require it.

**4. Search before navigation**
Users who know what they are looking for should never need to navigate to find it. A global search
surface resolves credentials, services, projects, and audit events by name from anywhere in the
product. Navigation is for exploration; search is for retrieval. These are distinct modes and must
be optimized separately.

**5. Clean over comprehensive**
At every surface, prefer the signal over the data. A project health indicator communicates more
than a table of all credentials with their properties. Progressive disclosure reveals detail when
the user asks for it; the surface level is always clean. Information density increases with
deliberate user action, never with scroll position or page load.

**6. Security-reinforcing actions are product improvements**
When a user records a dependent system, adds an expiry date, or completes a rotation checklist
item, the product makes the benefit immediate and visible: monitoring is more complete, the next
rotation will be more accurate, the project health score improves. Security behaviors are not
compliance overhead — they are the mechanism by which the product becomes more useful.
