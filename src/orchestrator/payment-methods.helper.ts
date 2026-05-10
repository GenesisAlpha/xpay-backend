
type PaymentMethod =
  | 'card'
  | 'pix'
  | 'mbway'
  | 'multibanco'
  | 'ideal'
  | 'bancontact'
  | 'swish'
  | 'twint'
  | 'p24'
  | 'blik'
  | 'eps'
  | 'mobile_pay'
  | 'klarna'
  | 'apple_pay'
  | 'google_pay';

const METHOD_COUNTRY_MAP: Record<PaymentMethod, string[]> = {
  card: ['*'], // global

  apple_pay: ['*'],
  google_pay: ['*'],

  pix: ['BR'],

  mbway: ['PT'],
  multibanco: ['PT'],

  ideal: ['NL'],
  bancontact: ['BE'],

  swish: ['SE'],
  twint: ['CH'],

  p24: ['PL'],
  blik: ['PL'],

  eps: ['AT'],
  mobile_pay: ['DK'],
  klarna: ['DE', 'FR'],

};

export class PaymentMethodsHelper {

  // =========================================
  // MAIN
  // =========================================
  static getAvailableMethods({
    enabledMethods,
    country,
  }: {
    enabledMethods: PaymentMethod[];
    country: string;
  }): PaymentMethod[] {

    return enabledMethods.filter((method) =>
      this.isMethodAvailableInCountry(method, country)
    );
  }

  // =========================================
  // CHECK COUNTRY
  // =========================================
  static isMethodAvailableInCountry(
    method: PaymentMethod,
    country: string,
  ): boolean {

    const supportedCountries = METHOD_COUNTRY_MAP[method];

    if (!supportedCountries) return false;

    // 🔥 global
    if (supportedCountries.includes('*')) return true;

    return supportedCountries.includes(country);
  }
}