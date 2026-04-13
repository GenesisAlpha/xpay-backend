async function run() {
  console.log("🔄 A iniciar injeção de credenciais XDEALS...");

  // 1. Login do XDEALS
  const loginRes = await fetch('http://localhost:8080/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'xdeals', password: 'xdeals-test-2026' })
  });
  
  const loginData = await loginRes.json();
  const token = loginData.token;

  if (!token) {
    console.error("❌ Erro no login. Verifica se o XDeals existe na BD:", loginData);
    return;
  }
  console.log("✅ Login XDEALS efetuado! Token capturado.");

  // 2. Injetar Stripe
  const stripeRes = await fetch('http://localhost:8080/api/v1/settings/gateways', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      provider_name: 'stripe',
      api_key: 'sk_test_REMOVED_FOR_SECURITY',
      is_active: true
    })
  });
  console.log("✅ Stripe guardada com sucesso:", await stripeRes.json());

  // 3. Injetar SumUp (Guardamos a Public Key no merchant_id)
  const sumupRes = await fetch('http://localhost:8080/api/v1/settings/gateways', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      provider_name: 'sumup',
      api_key: 'sup_sk_vwxlKNP74cO4uyBp3qOtKqRbtXcP3hfvW',
      merchant_id: 'sup_pk_xcV2mIUsIjeZUk1qkK95k3qp5CyFmyfu1', 
      is_active: true
    })
  });
  console.log("✅ SumUp guardada com sucesso:", await sumupRes.json());
}

run();
