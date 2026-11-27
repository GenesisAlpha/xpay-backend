# Checkout local no MVP XPAY

## Etapa 1 · Sessão MB WAY Pro
Checkout alojado com MB WAY como único método e pagamento avulso em EUR. O comerciante inicia o pedido no servidor e envia uma referência e uma oferta ou montante autorizado. O comprador confirma o número na Stripe. O teste controlado usa EUR 9,90 sem cliente real, verifica conta sandbox, método exclusivo, correlação do pedido e expiração sem pagar. Este teste verifica sessão, não entrega de notificações. Validado na Stripe sandbox em 27/11/2026. A primeira execução após reconectar a AWS devolveu HTTP 400 porque a versão Endive já não aceita `payment_method_types` no pedido. O teste corrigido usa `allowed_payment_method_types` e confirmou sessão avulsa de EUR 9,90, MB WAY como único método, referência do pedido e expiração sem pagamento. Commit `ef4dd67`.

## Etapa 2 · Pedido e confirmação
Uma rota autenticada por chave XPAY cria sessão local, ligada à encomenda e ao comerciante. Isolar produção e sandbox. Preço e moeda validados no servidor. Idempotência por comerciante, pedido e ambiente para evitar pedidos repetidos. Confirmar contra evento Stripe assinado e idempotente antes de entregar. Separar estados pendente, pago, falhado e expirado. Testar a autorização da app com números de teste oficiais e os resultados por webhook antes de publicar.

### Validação direta na Stripe sandbox · 27/11/2026

Dois PaymentIntents de EUR 9,90 foram confirmados com `allowed_payment_method_types[]=mb_way` e o telefone em `payment_method_data[billing_details][phone]`. Ambos começaram em `requires_action`.

| Número de teste | Resultado final | Evento observado na Stripe |
| --- | --- | --- |
| `+351911111112` | `succeeded` | `payment_intent.succeeded` |
| `+351911111115` | `requires_payment_method`, com `payment_intent_payment_attempt_expired` | `payment_intent.payment_failed` |

A Stripe emitiu ambos os eventos. Falta confirmar o processamento pelo webhook XPAY, a atualização da encomenda e a idempotência de pedidos repetidos. O ensaio usou exclusivamente a sandbox e não movimentou dinheiro real.

## Etapa 3 · Link fixo e checkout embutido
O link permanente resolve uma oferta ativa e cria sessão nova. A API reutiliza o serviço de sessões para checkout alojado ou Stripe Embedded Checkout / Payment Element. No pagamento avulso mostrar apenas métodos elegíveis. Multibanco fica pendente até pagamento da referência. AtlasClub mantém cartão para renovação automática; métodos locais exigem nova autorização a cada período.

## Etapa 4 · Bizum e MB WAY direto
Bizum requer aprovação Stripe da MGJ e autorização no fluxo bancário do comprador. Validar a capacidade e a autorização em sandbox; começar com sessão dedicada. MB WAY via Payment Intent direto só após provar os campos do telefone, confirmação, expiração e repetição na conta. As saídas continuam manuais e o admin regista a conciliação. Não publicar métodos nem simular sucesso real enquanto faltarem os testes de confirmação.

Referências: https://docs.stripe.com/payments/mb-way, https://docs.stripe.com/payments/bizum, https://docs.stripe.com/payments/multibanco.

### Estado da integração XPAY em sandbox · 27/11/2026

O runtime sandbox v2 (`2732769`) expõe `POST /payments/mbway` com chave do comerciante e leitura de `Idempotency-Key`. A resposta da rota declara sucesso com base na existência de um URL de redirecionamento. Esse contrato serve o checkout alojado da Sentinel e não demonstra que uma autorização MB WAY direta ficou pendente no telemóvel.

O webhook `POST /webhook/stripe/:accountId` verifica a assinatura por conta e já trata eventos de PaymentIntent. Para o MB WAY Pro, integrar a criação e confirmação do PaymentIntent na conta Stripe sandbox, guardar a referência Stripe na transação XPAY e expor o estado pendente sem exigir URL. Validar pagamento aprovado, expiração, replay da mesma chave e entrega repetida do webhook antes de disponibilizar o fluxo. A inspeção do runtime foi apenas de leitura.
