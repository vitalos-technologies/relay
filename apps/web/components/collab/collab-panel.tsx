'use client';
// One collaboration panel for the composer / post detail: Discussion, Tasks, Review, Activity, History.
// Desktop: a collapsible side panel. Phones and tablets: a full-screen sheet opened from the post header.
import { Activity, ChevronDown, ChevronUp, History, ListTodo, MessageSquare, ShieldCheck } from 'lucide-react';
import { Card, IconButton, Tabs, TabsContent, TabsList, TabsTrigger, cn } from '@/components/ui';
import { Discussion } from './discussion';
import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui';

// Only Discussion (the default tab) ships with the composer; the other tabs load when first opened.
const loading = () => <Skeleton className="h-32 w-full rounded-lg" />;
const HistoryPanel = dynamic(() => import('./history-panel').then((m) => m.HistoryPanel), { loading });
const PlanningPanel = dynamic(() => import('./planning-panel').then((m) => m.PlanningPanel), { loading });
const ReviewShares = dynamic(() => import('./review-shares').then((m) => m.ReviewShares), { loading });
const ReviewPanel = dynamic(() => import('./review-panel').then((m) => m.ReviewPanel), { loading });
const ActivityPanel = dynamic(() => import('./review-panel').then((m) => m.ActivityPanel), { loading });
const PostTasks = dynamic(() => import('./tasks').then((m) => m.PostTasks), { loading });
import type { ThreadAnchor } from './types';

export type CollabTab = 'discussion' | 'tasks' | 'review' | 'activity' | 'history';
export const COLLAB_TABS: CollabTab[] = ['discussion', 'tasks', 'review', 'activity', 'history'];
const TABS: Array<{ id: CollabTab; label: string; Icon: typeof MessageSquare }> = [
  { id: 'discussion', label: 'Discussion', Icon: MessageSquare }, { id: 'tasks', label: 'Tasks', Icon: ListTodo }, { id: 'review', label: 'Review', Icon: ShieldCheck },
  { id: 'activity', label: 'Activity', Icon: Activity }, { id: 'history', label: 'History', Icon: History },
];

export interface CollabPanelProps {
  postId: string; brandId: string; tz: string; version: number; canEdit: boolean; approvalId: string | null; approvalRequired: boolean;
  onRestored: () => Promise<void> | void; tab: CollabTab; onTab: (t: CollabTab) => void; highlightVersion?: string | null; focusThread?: string | null;
  refresh: { discussion: number; tasks: number; review: number; activity: number };
  counts: { unread: number; open: number; tasks: number };
  onCounts: (c: Partial<{ unread: number; open: number; tasks: number }>) => void;
  selection?: ThreadAnchor | null; onClearSelection?: () => void;
  collapsed?: boolean; onCollapse?: (c: boolean) => void; sheet?: boolean;
}

export function CollabPanel(p: CollabPanelProps) {
  const body = (
    <Tabs value={p.tab} onValueChange={(v) => p.onTab(v as CollabTab)}>
      <div className={cn('flex items-center gap-1', p.sheet ? 'pb-2' : 'px-4 pt-2')}>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <TabsList label="Collaboration" className="w-max gap-0">
            {TABS.map(({ id, label, Icon }) => {
              const active = p.tab === id;
              // Narrow side panel: the active tab shows its name; the others are icons with the name for screen readers + tooltip.
              const showLabel = active;
              return (
                <TabsTrigger key={id} value={id} className={cn(showLabel ? 'px-2.5' : 'gap-0 px-2')}>
                  <span title={label} className="inline-flex items-center gap-1.5">
                    <Icon aria-hidden className="size-4" />
                    <span className={showLabel ? '' : p.sheet ? 'max-sm:sr-only' : 'sr-only'}>{label}</span>
                  </span>
                  {id === 'discussion' && p.counts.unread ? <Dot n={p.counts.unread} label="unread" /> : null}
                  {id === 'tasks' && p.counts.tasks ? <span className="ml-1 tabular text-xs text-muted">{p.counts.tasks}<span className="sr-only"> open</span></span> : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>
        {p.onCollapse && !p.sheet ? (
          <IconButton size="sm" label={p.collapsed ? 'Expand collaboration panel' : 'Collapse collaboration panel'} aria-expanded={!p.collapsed}
            icon={p.collapsed ? <ChevronDown aria-hidden className="size-4" /> : <ChevronUp aria-hidden className="size-4" />} onClick={() => p.onCollapse!(!p.collapsed)} />
        ) : null}
      </div>
      {!p.collapsed || p.sheet ? (
        <div className={cn(p.sheet ? 'pt-2' : 'px-4 pb-4 pt-3')}>
          <TabsContent value="discussion">
            <Discussion postId={p.postId} focusThread={p.focusThread} refreshKey={p.refresh.discussion} selection={p.selection} onClearSelection={p.onClearSelection}
              onCounts={(c) => p.onCounts({ unread: c.unread, open: c.open })} />
          </TabsContent>
          <TabsContent value="tasks">
            <PostTasks postId={p.postId} brandId={p.brandId} tz={p.tz} refreshKey={p.refresh.tasks} onCount={(n) => p.onCounts({ tasks: n })} />
            <div className="mt-5 border-t border-border pt-4">
              <p className="mb-2 text-xs font-medium text-muted">Post owner and editorial deadline</p>
              <PlanningPanel postId={p.postId} brandId={p.brandId} tz={p.tz} />
            </div>
          </TabsContent>
          <TabsContent value="review">
            <ReviewPanel approvalId={p.approvalId} approvalRequired={p.approvalRequired} version={p.version} refreshKey={p.refresh.review} />
            <div className="mt-5 border-t border-border pt-4">
              <p className="mb-2 text-xs font-medium text-muted">Client review</p>
              <ReviewShares postId={p.postId} />
            </div>
          </TabsContent>
          <TabsContent value="activity"><ActivityPanel postId={p.postId} refreshKey={p.refresh.activity} /></TabsContent>
          <TabsContent value="history">
            <HistoryPanel postId={p.postId} version={p.version} canEdit={p.canEdit} onRestored={p.onRestored} highlight={p.highlightVersion} tall={p.sheet} />
          </TabsContent>
        </div>
      ) : null}
    </Tabs>
  );
  if (p.sheet) return body;
  return <Card aria-label="Collaboration" data-testid="collab-panel">{body}</Card>;
}

function Dot({ n, label }: { n: number; label: string }) {
  return <span className="ml-1 rounded-full bg-[var(--accent)] px-1.5 text-[11px] font-semibold leading-4 text-[var(--on-accent)] tabular">{n}<span className="sr-only"> {label}</span></span>;
}
