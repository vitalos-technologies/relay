// Google Picker (browser): loads Google's scripts on demand, obtains a SHORT-LIVED drive.file token for the SAME account
// with the Google Identity Services token client (the server's stored token is never sent to the browser), and
// returns the picked file ids. The server then verifies each id with the saved authorization (drive.file per-file grant).
'use client';

export interface PickerConfig { client_id: string; api_key: string; app_id: string; scope: string; login_hint: string; test?: boolean }

type G = {
  accounts: { oauth2: { initTokenClient(o: { client_id: string; scope: string; hint?: string; prompt?: string; callback: (r: { access_token?: string; error?: string }) => void }): { requestAccessToken(): void } } };
  picker: Record<string, unknown> & {
    PickerBuilder: new () => PickerBuilder; DocsView: new (viewId?: unknown) => DocsView; ViewId: Record<string, unknown>; Feature: Record<string, unknown>; Action: Record<string, string>;
    Response: Record<string, string>; Document: Record<string, string>;
  };
};
interface DocsView { setIncludeFolders(v: boolean): DocsView; setSelectFolderEnabled(v: boolean): DocsView; setMimeTypes(m: string): DocsView; setOwnedByMe?(v: boolean): DocsView; setEnableDrives?(v: boolean): DocsView }
interface PickerBuilder {
  addView(v: unknown): PickerBuilder; enableFeature(f: unknown): PickerBuilder; setOAuthToken(t: string): PickerBuilder; setDeveloperKey(k: string): PickerBuilder;
  setAppId(a: string): PickerBuilder; setCallback(cb: (d: Record<string, unknown>) => void): PickerBuilder; setTitle(t: string): PickerBuilder; build(): { setVisible(v: boolean): void };
}

const loaded = new Map<string, Promise<void>>();
function loadScript(src: string): Promise<void> {
  let p = loaded.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Google Picker could not load'));
      document.head.appendChild(s);
    });
    loaded.set(src, p);
  }
  return p;
}

export type PickMode = 'media' | 'documents' | 'folder';

/** Opens the Picker; resolves with picked ids ([] when cancelled). */
export async function pickFromDrive(cfg: PickerConfig, mode: PickMode): Promise<string[]> {
  await Promise.all([loadScript('https://apis.google.com/js/api.js'), loadScript('https://accounts.google.com/gsi/client')]);
  const w = window as unknown as { google: G; gapi: { load(name: string, cb: () => void): void } };
  await new Promise<void>((r) => w.gapi.load('picker', () => r()));
  const token = await new Promise<string>((resolve, reject) => {
    const client = w.google.accounts.oauth2.initTokenClient({
      client_id: cfg.client_id, scope: cfg.scope, hint: cfg.login_hint, prompt: '',
      callback: (r) => (r.access_token ? resolve(r.access_token) : reject(new Error(r.error ?? 'Google sign-in was cancelled'))),
    });
    client.requestAccessToken();
  });
  const g = w.google.picker;
  const view = new g.DocsView(g.ViewId.DOCS);
  view.setEnableDrives?.(true);
  if (mode === 'folder') view.setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder');
  else if (mode === 'documents') view.setMimeTypes('application/vnd.google-apps.document');
  else view.setMimeTypes('image/jpeg,image/png,video/mp4,video/quicktime');
  return new Promise<string[]>((resolve) => {
    const picker = new g.PickerBuilder()
      .addView(view)
      .enableFeature(g.Feature.SUPPORT_DRIVES)
      .enableFeature(mode === 'folder' ? g.Feature.NAV_HIDDEN : g.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(token).setDeveloperKey(cfg.api_key).setAppId(cfg.app_id)
      .setTitle(mode === 'folder' ? 'Choose a folder' : mode === 'documents' ? 'Choose Google Docs' : 'Choose images or videos')
      .setCallback((d) => {
        if (d.action === g.Action.PICKED) {
          const docs = (d[g.Response.DOCUMENTS ?? 'docs'] as Array<Record<string, string>> | undefined) ?? [];
          resolve(docs.map((x) => x[g.Document.ID ?? 'id']!).filter(Boolean).slice(0, 20));
        } else if (d.action === g.Action.CANCEL) resolve([]);
      })
      .build();
    picker.setVisible(true);
  });
}

/** Demo ids served by the labelled TEST connection (non-production). */
export const TEST_PICKS: Record<PickMode, string[]> = {
  media: ['demoImage0000000000001'], documents: ['demoDoc000000000000001'], folder: ['demoFolder000000000001'],
};
