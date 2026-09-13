jest.mock('../lib/supabase.client', () => ({ supabase: {} }));
jest.mock('./koopfy-integration.service', () => ({
  KoopfyIntegrationService: class KoopfyIntegrationService {},
}));
jest.mock('../onboarding/onboarding.service', () => ({
  OnboardingService: class OnboardingService {},
}));

import { KoopfyIntegrationController } from './koopfy-integration.controller';

describe('KoopfyIntegrationController onboarding', () => {
  it('uses the verified Pay user id instead of identity fields from the body', async () => {
    const integration = {};
    const onboarding = {
      saveKyc: jest.fn().mockResolvedValue({ message: 'ok' }),
      saveOperation: jest.fn(),
      saveDocuments: jest.fn(),
    };
    const controller = new KoopfyIntegrationController(
      integration as never,
      onboarding as never,
    );
    const req = {
      sellerCtx: {
        userId: 'verified-user',
        email: 'verified@example.com',
        seller: { id: 'verified-seller', status: 'pending_review' },
      },
    };
    const body = {
      userId: 'attacker-user',
      sellerId: 'attacker-seller',
      email: 'attacker@example.com',
      fullName: 'Seller Real',
      cpf: '52998224725',
      birthDate: '1990-01-01',
      cep: '01001000',
      street: 'Praça da Sé',
      number: '1',
      neighborhood: 'Sé',
      city: 'São Paulo',
      state: 'SP',
    };

    await expect(controller.saveKyc(req, body as never)).resolves.toEqual({
      message: 'ok',
    });
    expect(onboarding.saveKyc).toHaveBeenCalledWith('verified-user', body);
  });

  it('uses the verified user for operation and document submissions', async () => {
    const integration = {};
    const onboarding = {
      saveKyc: jest.fn(),
      saveOperation: jest.fn().mockResolvedValue({ message: 'operation-ok' }),
      saveDocuments: jest.fn().mockResolvedValue({ message: 'documents-ok' }),
    };
    const controller = new KoopfyIntegrationController(
      integration as never,
      onboarding as never,
    );
    const req = { sellerCtx: { userId: 'verified-user' } };

    await controller.saveOperation(req, { description: 'Cursos' } as never);
    await controller.saveDocuments(req, { companyType: 'BR' } as never);

    expect(onboarding.saveOperation).toHaveBeenCalledWith('verified-user', {
      description: 'Cursos',
    });
    expect(onboarding.saveDocuments).toHaveBeenCalledWith('verified-user', {
      companyType: 'BR',
    });
  });
});
