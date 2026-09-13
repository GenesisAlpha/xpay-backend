const single = jest.fn();
const eq = jest.fn(() => ({ single }));
const select = jest.fn(() => ({ eq }));
const from = jest.fn(() => ({ select }));

jest.mock('../../lib/supabase.client', () => ({
  supabase: { from },
}));

import { SettingsService } from './services';

describe('SettingsService.getWebhookSecret', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    single.mockResolvedValue({
      data: { metadata: { webhookSecret: 'whsec_existing' } },
      error: null,
    });
  });

  it('looks up the seller profile by seller id', async () => {
    const service = new SettingsService();

    await expect(service.getWebhookSecret('seller-1')).resolves.toEqual({
      secret: 'whsec_existing',
    });
    expect(from).toHaveBeenCalledWith('seller_profiles');
    expect(eq).toHaveBeenCalledWith('id', 'seller-1');
  });
});
