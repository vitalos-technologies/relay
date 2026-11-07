// Validate configuration at server start so production fails closed before serving traffic
// (mock transport, development identity provider, local defaults or missing secrets).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { config } = await import('@social-lite/services');
    config();
    const { initKmsKeyProvider } = await import('@social-lite/services/kms');
    await initKmsKeyProvider(); // no-op without KMS settings; throws (fail closed) if KMS is configured but unusable
  }
}
