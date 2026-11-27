-- Record payment and provider errors using the columns expected by the payment service.
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS error_message text;
ALTER TABLE public.transaction_attempts ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE xpay_live.transactions ADD COLUMN IF NOT EXISTS error_message text;
ALTER TABLE xpay_live.transaction_attempts ADD COLUMN IF NOT EXISTS error text;
