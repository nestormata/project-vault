-- Story 24.1 follow-up: ownership transfer requires schema visibility for the owner role.
-- Keep this as an additive migration because 0070 may already be applied in existing databases.
GRANT USAGE ON SCHEMA public TO vault_owner;
