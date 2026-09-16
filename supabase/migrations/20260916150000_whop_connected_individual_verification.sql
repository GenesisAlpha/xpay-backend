-- Verificação da pessoa responsável (KYC) na conta conectada.
--
-- A Whop exige duas verificações para a conta operar: `business` (a LLC) e
-- `individual` (quem responde por ela). O pay já criava a de empresa; agora
-- cria as duas na mesma hora e acompanha cada uma.
--
-- verification_id / verification_status continuam sendo os da EMPRESA.
-- Só adiciona colunas. Idempotente.

alter table public.whop_connected_accounts
  add column if not exists individual_verification_id text,
  add column if not exists individual_verification_status text;

comment on column public.whop_connected_accounts.individual_verification_id is
  'Perfil de verificação (idpf_) da pessoa responsável na Whop.';
comment on column public.whop_connected_accounts.individual_verification_status is
  'Status da verificação da pessoa: not_started, pending, processing, action_required, manual_review, approved, rejected.';
