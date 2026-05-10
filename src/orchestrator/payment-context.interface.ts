export interface PaymentContext {
  sellerId: string;
  amount: number;
  currency: string;
  method?: string;
  country?: string;
  riskLevel: string;
  

  metadata?: Record<string, any>;
}