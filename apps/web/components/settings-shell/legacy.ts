// Server-safe (no client imports): used by the /settings redirect.
/** Old `/settings?tab=` values → new routes (query params other than `tab` are kept by the caller). */
export const LEGACY_TABS: Record<string, string> = {
  workspace: '/settings/workspace/general',
  brand: '/settings/workspace/branding',
  team: '/team',
  slots: '/settings/publishing/slots',
  notifications: '/settings/personal/notifications',
  budgets: '/settings/operations/usage',
  integrations: '/settings/automation/inbound',
  'service-accounts': '/settings/developer/service-accounts',
  sources: '/settings/connections/google',
  security: '/settings/people/security-policy',
  mcp: '/settings/developer/mcp',
};

