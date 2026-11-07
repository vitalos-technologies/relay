'use client';
import { Card, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { CommentsPanel } from './comments-panel';
import { HistoryPanel } from './history-panel';
import { PlanningPanel } from './planning-panel';
import { ReviewShares } from './review-shares';

/** Composer side panel: comments, version history, planning and client sharing. */
export function CollabPanel({ postId, brandId, tz, currentText, version, canEdit, onRestored, tab, onTab, highlightVersion }: {
  postId: string; brandId: string; tz: string; currentText: string; version: number; canEdit: boolean; onRestored: () => Promise<void> | void;
  tab: string; onTab: (t: string) => void; highlightVersion?: string | null;
}) {
  return (
    <Card aria-label="Collaboration">
      <Tabs value={tab} onValueChange={onTab}>
        <div className="px-4 pt-2">
          <TabsList label="Collaboration sections">
            <TabsTrigger value="comments">Comments</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="planning">Plan</TabsTrigger>
          </TabsList>
        </div>
        <div className="px-4 pb-4 pt-3">
          <TabsContent value="comments"><CommentsPanel postId={postId} /></TabsContent>
          <TabsContent value="history"><HistoryPanel postId={postId} currentText={currentText} version={version} canEdit={canEdit} onRestored={onRestored} highlight={highlightVersion} /></TabsContent>
          <TabsContent value="planning">
            <PlanningPanel postId={postId} brandId={brandId} tz={tz} />
            <div className="mt-5 border-t border-border pt-4">
              <p className="mb-2 text-xs font-medium text-muted">Client review</p>
              <ReviewShares postId={postId} />
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </Card>
  );
}
