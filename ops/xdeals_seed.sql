INSERT INTO "User" (id, email, name, preferred_provider) 
VALUES ('xdeals-internal-id', 'dev@nexflowx.tech', 'XDeals Internal', 'STRIPE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO "ApiKey" (id, key_hash, user_id) 
VALUES ('key-xdeals-001', 'nx_test_xdeals_2026', 'xdeals-internal-id')
ON CONFLICT (id) DO NOTHING;
