export interface PaymentProvider {
  name: string;

  charge(data: {
    amount: number;
    currency: string;
    accountId: string;
  }): Promise<{ success: boolean }>;
}