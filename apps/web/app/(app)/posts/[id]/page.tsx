'use client';
import { useParams } from 'next/navigation';
import { Composer } from '@/components/composer/composer';

export default function PostPage() {
  const { id } = useParams<{ id: string }>();
  return <Composer postId={id} />;
}
