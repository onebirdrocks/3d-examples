import type { SceneDefinition } from '../scenes/types.js';

const PREFIX = 'lumen-atlas:';
const fallback = new Map<string, unknown>();

export function readSaved<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw) return JSON.parse(raw) as T;
  } catch { /* 存储被禁用或数据损坏时，当前页面仍可使用。 */ }
  return (fallback.get(key) as T | undefined) ?? initial;
}

export function save<T>(key: string, value: T): void {
  fallback.set(key, value);
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* 内存回退 */ }
}

export interface GalleryView { category: string; query: string; collection: string }
export function readGalleryView(params = new URLSearchParams(location.search)): GalleryView {
  const collection = params.get('collection') ?? 'all';
  return {
    category: params.get('category') ?? 'all',
    query: (params.get('q') ?? '').slice(0, 120),
    collection: ['all', 'favorites', 'recent'].includes(collection) ? collection : 'all',
  };
}

export function galleryParams(view: GalleryView): URLSearchParams {
  const params = new URLSearchParams();
  if (view.category !== 'all') params.set('category', view.category);
  if (view.query) params.set('q', view.query);
  if (view.collection !== 'all') params.set('collection', view.collection);
  return params;
}

function savedIDs(key: string): string[] {
  const value = readSaved<unknown>(key, []);
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, 100) : [];
}
export function favorites(): string[] { return savedIDs('favorites'); }
export function recentScenes(): string[] { return savedIDs('recent'); }
export function toggleFavorite(id: string): boolean {
  const ids = favorites();
  const enabled = !ids.includes(id);
  save('favorites', enabled ? [...ids, id] : ids.filter((entry) => entry !== id));
  window.dispatchEvent(new Event('library-changed'));
  return enabled;
}
export function rememberScene(id: string): void {
  save('recent', [id, ...recentScenes().filter((entry) => entry !== id)].slice(0, 24));
}

export function filterScenes(scenes: readonly SceneDefinition[], view: GalleryView): SceneDefinition[] {
  const saved = favorites(), recent = recentScenes();
  const query = view.query.trim().toLocaleLowerCase();
  const filtered = scenes.filter((scene) =>
    (view.category === 'all' || scene.category === view.category) &&
    (view.collection !== 'favorites' || saved.includes(scene.id)) &&
    (view.collection !== 'recent' || recent.includes(scene.id)) &&
    (!query || [scene.title, scene.subtitle, scene.description, ...scene.tags].join(' ').toLocaleLowerCase().includes(query)),
  );
  return view.collection === 'recent' ? filtered.sort((a, b) => recent.indexOf(a.id) - recent.indexOf(b.id)) : filtered;
}

export interface ViewPreferences {
  quality: 'low' | 'balanced' | 'high';
  reducedMotion?: boolean;
  backgroundAudio: boolean;
  volume: number;
  soundEnabled: boolean;
}
export function viewPreferences(): ViewPreferences {
  const stored = readSaved<Partial<ViewPreferences> | null>('preferences', {});
  const value = stored && typeof stored === 'object' ? stored : {};
  return {
    quality: ['low', 'balanced', 'high'].includes(value.quality ?? '') ? value.quality! : (matchMedia('(pointer: coarse)').matches ? 'balanced' : 'high'),
    reducedMotion: typeof value.reducedMotion === 'boolean' ? value.reducedMotion : undefined,
    backgroundAudio: value.backgroundAudio !== false,
    volume: typeof value.volume === 'number' && Number.isFinite(value.volume) ? Math.max(0, Math.min(1, value.volume)) : 0.55,
    soundEnabled: value.soundEnabled !== false,
  };
}

export const QUALITY = { low: 0.55, balanced: 0.8, high: 1 } as const;
