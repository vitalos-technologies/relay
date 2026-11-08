// Public marketing route group (V5 §3–4, D23). Server-rendered; loads only the marketing palette and the page's own small
// client islands — never the app providers/shell (no app bundle on `/`).
import type { ReactNode } from 'react';
import './marketing.css';

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return <div className="mkt min-h-dvh">{children}</div>;
}
