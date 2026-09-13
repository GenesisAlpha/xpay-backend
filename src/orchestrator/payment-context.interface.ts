export interface PaymentContext {
  sellerId: string;
  // Centavos da moeda da TRANSAÇÃO (BRL, EUR, ...). Não serve pra comparar com
  // teto — ver amountUsdCents.
  amount: number;
  currency: string;
  method?: string;
  country?: string;
  riskLevel: string;

  // Mesmo ticket, em centavos de USD. Campo separado de propósito: é a única
  // unidade comparável com min_ticket/max_ticket e com account_daily_metrics.
  // Quem não converte simplesmente NÃO manda — o router então não aplica teto de
  // ticket (e avisa), em vez de comparar real com dólar e "funcionar" errado.
  amountUsdCents?: number;

  metadata?: Record<string, any>;
}