import { PaymentContext } from '../payment-context.interface';

export abstract class BaseStrategy {
  abstract execute(ctx: PaymentContext): Promise<any>;
}