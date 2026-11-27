-- Preserve the timestamp used by the checkout and Stripe failure handlers.
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS failed_at timestamptz;
ALTER TABLE xpay_live.transactions ADD COLUMN IF NOT EXISTS failed_at timestamptz;
