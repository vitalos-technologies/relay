'use client';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en-GB">
      <body style={{ margin: 0, background: '#0D0E10', color: '#EDEEF0', fontFamily: 'system-ui, sans-serif' }}>
        <main role="alert" style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <h1 style={{ fontSize: 22, fontWeight: 600 }}>Social Lite couldn’t load</h1>
            <p style={{ fontSize: 13, color: '#9AA1A9' }}>Reload the page.</p>
            {error.digest ? <p style={{ fontFamily: 'monospace', fontSize: 11, color: '#757D87' }}>Reference {error.digest}</p> : null}
            <button type="button" onClick={reset} style={{ marginTop: 16, height: 40, padding: '0 16px', borderRadius: 8, border: 0, background: '#C8F25A', color: '#0D0E10', fontWeight: 600, cursor: 'pointer' }}>
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
