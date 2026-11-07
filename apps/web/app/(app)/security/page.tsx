import { SecurityPage } from '@/components/security/security-page';
import { SettingsShell } from '@/components/settings-shell/settings-shell';

export const metadata = { title: 'Security' };

// Settings → Personal → Security and sessions (canonical URL kept: step-up and identity-provider actions return here).
export default function Page() {
  return <SettingsShell><SecurityPage /></SettingsShell>;
}
