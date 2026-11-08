// Public status page for Meta data deletion requests (linked from the callback response).
import { deletionStatus } from '@social-lite/services/meta-callbacks';

export const dynamic = 'force-dynamic';

export default async function DeletionStatusPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const status = await deletionStatus(code).catch(() => null);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-6">
      <h1 className="text-xl font-semibold">Data deletion</h1>
      {status ? (
        <>
          <p className="text-sm">Status: <strong>{status.status === 'completed' ? 'Completed' : status.status}</strong></p>
          <p className="text-xs text-muted">Code {code} · {new Date(status.received_at).toUTCString()}</p>
        </>
      ) : <p className="text-sm">Unknown confirmation code.</p>}
    </main>
  );
}
