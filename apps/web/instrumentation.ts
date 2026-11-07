// Validate configuration at server start so production fails closed before serving traffic
// (mock transport, development identity provider, local defaults or missing secrets).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { config } = await import('@social-lite/services');
    const cfg = config();
    // G14: never serve traffic as a privileged database role in production.
    const { assertRuntimeDbRole, getPool } = await import('@social-lite/db');
    await assertRuntimeDbRole(getPool(), { production: cfg.APP_ENV === 'production', component: 'web' });
    const { initKmsKeyProvider } = await import('@social-lite/services/kms');
    await initKmsKeyProvider(); // no-op without KMS settings; throws (fail closed) if KMS is configured but unusable
  }
}
