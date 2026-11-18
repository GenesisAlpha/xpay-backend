-- SÓ KAJA E KONTINO + TRILHOS DA ARGENTINA E DA COLÔMBIA (18/11/2026).
--
-- A Koopfy passa a orquestrar só dois provedores: Kaja Payments (cartão e
-- carteiras) e Kontino (Pix, SPEI, Transferencias 3.0 e PSE, na conta
-- conectada do seller). Idempotente: pode rodar mais de uma vez.

-- 1. Sai a regra que ficaria sem provedor (nenhum é Kaja ou Kontino) e a de
--    método que nem Kaja nem Kontino atendem (boleto, MB WAY, cripto, PayPal, Link).
delete from public.payment_method_routes
 where not exists (select 1 from unnest(providers) as p where p in ('kaja', 'kontino'))
    or method not in ('card', 'apple_pay', 'google_pay', 'pix', 'spei', 'transfers_ar', 'pse');

-- 2. Nas que sobraram, tira da cadeia todo provedor fora de Kaja e Kontino.
update public.payment_method_routes
   set providers = array(select p from unnest(providers) as p where p in ('kaja', 'kontino')),
       updated_by = 'migration', updated_at = now()
 where exists (select 1 from unnest(providers) as p where p not in ('kaja', 'kontino'));

-- 3. Regras da plataforma. Cartão e carteiras na Kaja ficam DESLIGADAS até a
--    integração da Kaja estar no ar (ligar antes deixaria o cartão sem
--    provedor); desligada = cada seller segue no provedor de antes.
insert into public.payment_method_routes (method, providers, enabled, notes, updated_by) values
  ('pix',          array['kontino'], true,  'Pix na conta Kontino do seller', 'migration'),
  ('spei',         array['kontino'], true,  'SPEI na conta Kontino do seller', 'migration'),
  ('transfers_ar', array['kontino'], true,  'Transferencias 3.0 (Argentina) na conta Kontino do seller', 'migration'),
  ('pse',          array['kontino'], true,  'PSE (Colômbia) na conta Kontino do seller', 'migration'),
  ('card',         array['kaja'],    false, 'Cartão na Kaja Payments — ligar quando a integração da Kaja estiver no ar', 'migration'),
  ('apple_pay',    array['kaja'],    false, 'Carteira no mesmo provedor do cartão', 'migration'),
  ('google_pay',   array['kaja'],    false, 'Carteira no mesmo provedor do cartão', 'migration')
on conflict do nothing;
