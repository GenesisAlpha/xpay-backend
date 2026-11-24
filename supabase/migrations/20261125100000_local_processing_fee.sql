-- Processamento da Koopfy nos métodos locais (Pix, SPEI, Transferencias 3.0, PSE).
-- NULL = o mesmo processamento do cartão (comportamento de antes). Só adição.
ALTER TABLE public.seller_fees ADD COLUMN IF NOT EXISTS local_processing_fee_pct numeric(5,2);
COMMENT ON COLUMN public.seller_fees.local_processing_fee_pct IS 'Processamento nos métodos locais (a Kontino já cobra o dela). NULL = igual ao cartão.';
