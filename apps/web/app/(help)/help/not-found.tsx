// Help Centre 404 (HC): the same answer whether the article doesn't exist or is for another audience (e.g. workspace
// admins), so nothing about restricted articles is revealed.
import { HelpNotFoundBody } from '@/components/help/help-not-found';

export default function HelpNotFound() {
  return <HelpNotFoundBody />;
}
