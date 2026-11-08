// Simulated Cloud Translation API (mock_ installations only). It does NOT translate: it returns the input marked
// "[Simulated → <lang>]" so nobody mistakes it for a real translation, while exercising the same request/response
// shapes, protected spans, glossary paths and failure scenarios.
import { sjson, type SimHandler } from '../biz/sim.js';

export const translateSim: SimHandler = async (req) => {
  const host = req.url.hostname; const p = req.url.pathname;
  if (host === 'oauth2.googleapis.com') return sjson(200, { access_token: 'mock_sa_token', expires_in: 3600, token_type: 'Bearer' });
  if (p.endsWith('/supportedLanguages')) return sjson(200, { languages: [['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['ja', 'Japanese'], ['ar', 'Arabic']].map(([languageCode, displayName]) => ({ languageCode, displayName })) });
  if (p.endsWith('/glossaries')) return sjson(200, { glossaries: [{ name: `${p.replace(/^\/v3\//, '').replace(/\/glossaries$/, '')}/glossaries/brand-terms`, entryCount: 12 }] });
  if (p.endsWith(':translateText')) {
    const b = JSON.parse(req.body) as { contents: string[]; targetLanguageCode: string; sourceLanguageCode?: string; glossaryConfig?: unknown };
    if (!b.contents?.length) return sjson(400, { error: { message: 'contents is required', status: 'INVALID_ARGUMENT' } });
    const detected = b.sourceLanguageCode ? undefined : (/^[\x00-\x7F\s]*$/.test(b.contents[0]!.replace(/<[^>]+>/g, '')) ? 'en' : 'und');
    const translations = b.contents.map((c) => ({ translatedText: `[Simulated → ${b.targetLanguageCode}] ${c}`, ...(detected ? { detectedLanguageCode: detected } : {}) }));
    return sjson(200, { translations, ...(b.glossaryConfig ? { glossaryTranslations: translations } : {}) });
  }
  return sjson(404, { error: { message: `simulated Translation: no route ${p}`, status: 'NOT_FOUND' } });
};
