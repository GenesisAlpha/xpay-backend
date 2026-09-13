# Testar o embed

## 1. Cadastrar o domínio (obrigatório — fechado por padrão)

Sem isto o embed **não enquadra em lugar nenhum**, nem no seu próprio site:

```sql
insert into gw_embed_origins (seller_id, origin, wildcard, label)
values ('<seller_id>', 'https://loja-de-teste.com', true, 'teste');

-- para desenvolvimento local:
insert into gw_embed_origins (seller_id, origin, wildcard, label)
values ('<seller_id>', 'http://localhost:3000', false, 'dev');
```

## 2. Criar a sessão (no SEU backend, com a sk_live_)

```bash
curl -X POST https://api.koopfy.com/pay/checkout/session \
  -H "Authorization: Bearer sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"amount": 186528, "currency": "MXN", "country": "MX"}'
# → { "sessionId": "...", ... }
```

`amount` em centavos. É este valor que será cobrado — o browser não pode mudá-lo.

## 3. Montar na página

```html
<div id="pago"></div>
<script src="https://checkout.koopfy.com/koopfy-embed.js"></script>
<script>
  Koopfy.mount('#pago', {
    sessionId: 'SESSION_ID_DO_PASSO_2',
    onReady:  ()  => console.log('embed pronto'),
    onPaid:   (d) => location.href = '/gracias?tx=' + d.transactionId,
    onFailed: (d) => console.warn('não aprovado:', d.reason),
    onProofUploaded: () => console.log('comprovante SPEI enviado'),
  })
</script>
```

## O que verificar

| | esperado |
|---|---|
| domínio **não** cadastrado | iframe recusa carregar (console: `frame-ancestors`) |
| SPEI | abre o modal com CLABE e valor **com centavos únicos** |
| cartão | iframe da Clip monta; `Pagar` mostra o valor da sessão |
| valor adulterado no devtools | ignorado — valor vem da sessão, não do browser |
| altura | acompanha a troca cartão ↔ SPEI ↔ comprovante |

## Limitação conhecida

**3DS não foi exercitado.** O embed emite `redirect` e o SDK navega o topo, mas
nenhum emissor real foi testado nesse caminho — é onde integração em iframe
aninhado costuma quebrar.
