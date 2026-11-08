// Relay AI workspace (V5): composer + suggestions, conversation history, workflow runs with progress and results.
// Knowledge sources and V3.5 quick results stay reachable from the history sidebar.
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AiWorkspace } from '@/components/ai-workspace/workspace';

export const metadata: Metadata = { title: 'Assistant' };

export default function AssistantPage() {
  return <Suspense fallback={null}><AiWorkspace /></Suspense>;
}
