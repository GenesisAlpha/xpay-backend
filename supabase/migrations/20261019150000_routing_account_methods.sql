-- Métodos que cada conta do roteamento oferece no checkout (cartão, Apple Pay,
-- Google Pay, Pix, iDEAL…). null = todos os que a conta atende. Venda com um
-- método desligado na conta da sessão vai para outra conta que o ofereça.
alter table public.seller_routing_accounts add column if not exists methods text[];
