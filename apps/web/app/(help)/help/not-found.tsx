// Help Centre 404 (HC): the same answer whether the article doesn't exist or is for another audience (e.g. workspace
// admins), so nothing about restricted articles is revealed.
import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { HelpSearch } from '@/components/help/help-search';

export default function HelpNotFound() {
  return (
    <div className="mx-auto max-w-[560px] py-10 text-center">
      <span aria-hidden className="mx-auto inline-flex size-11 items-center justify-center rounded-full bg-raised text-muted"><FileQuestion className="size-5" /></span>
      <h1 className="mt-4 text-[20px] font-semibold">Article not available</h1>
      <p className="mt-1 text-[14px] text-muted">It may have moved, or it’s for another role, such as workspace admins.</p>
      <div className="mt-6 text-left"><HelpSearch /></div>
      <p className="mt-4"><Link href="/help" className="text-[13px] font-medium text-accent-text hover:underline">Help home</Link></p>
    </div>
  );
}
