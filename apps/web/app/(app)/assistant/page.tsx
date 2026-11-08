// AI Assistant (V3.5): ask with approved brand knowledge, history of my runs, knowledge sources.
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AssistantApp } from '@/components/assistant/assistant-app';

export const metadata: Metadata = { title: 'Assistant' };

export default function AssistantPage() {
  return <Suspense fallback={null}><AssistantApp /></Suspense>;
}
