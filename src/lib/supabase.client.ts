import { createClient } from '@supabase/supabase-js';

const schema = process.env.XPAY_DB_SCHEMA ?? 'public';
if (schema !== 'public' && schema !== 'xpay_live') {
  throw new Error('Unknown XPAY database schema');
}

export const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_KEY!,
  { db: { schema } },
);
