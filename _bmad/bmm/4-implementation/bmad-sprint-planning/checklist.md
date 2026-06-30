# Sprint Planning Validation Checklist

## Core Validation

### Complete Coverage Check

- [ ] Every epic found in epic\*.md files appears in sprint-status.yaml
- [ ] Every story found in epic\*.md files appears in sprint-status.yaml
- [ ] Every epic has a corresponding retrospective entry
- [ ] No items in sprint-status.yaml that don't exist in epic files

### Parsing Verification

Compare epic files against generated sprint-status.yaml:

```
Epic Files Contains:                Sprint Status Contains:
✓ Epic 1                            ✓ epic-1: [status]
  ✓ Story 1.1: User Auth              ✓ 1-1-user-auth: [status]
  ✓ Story 1.2: Account Mgmt           ✓ 1-2-account-mgmt: [status]
  ✓ Story 1.3: Plant Naming           ✓ 1-3-plant-naming: [status]
                                      ✓ epic-1-retrospective: [status]
✓ Epic 2                            ✓ epic-2: [status]
  ✓ Story 2.1: Personality Model      ✓ 2-1-personality-model: [status]
  ✓ Story 2.2: Chat Interface         ✓ 2-2-chat-interface: [status]
                                      ✓ epic-2-retrospective: [status]
```

### Final Check

- [ ] Total count of epics matches
- [ ] Total count of stories matches
- [ ] All items are in the expected order (epic, stories, retrospective)

## Epic Completion Gate (G2 — Epic 2 retro)

Reference: `_bmad-output/implementation-artifacts/product-surface-contract.md`

Before setting `epic-N: done`:

- [ ] Every story in epic is `done` in **both** story files and sprint-status.yaml
- [ ] No story with surface scope `api` lacks linked UI story or shipped web surface (unless epic documents honest partial delivery)
- [ ] PRD user journeys for this epic are web-consumable OR explicitly deferred with tracked follow-up stories
- [ ] Epic retrospective marked `done`
- [ ] No open Critical product-surface action items from epic retro

