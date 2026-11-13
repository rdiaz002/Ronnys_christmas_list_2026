import { clamp01 } from './util.js';

// How festive the scene is, from 0 (Nov 1: a bare-ish tree, light flurries)
// to 1 (Christmas Eve: fully decorated, heavy snow). Stays at 1 through Jan 6.
//
// Preview other days with ?date=2026-12-20 or force a level with ?festive=0.8
export function festiveLevel(now = new Date()) {
  const params = new URLSearchParams(location.search);
  if (params.has('festive')) {
    const forced = parseFloat(params.get('festive'));
    if (Number.isFinite(forced)) return clamp01(forced);
  }
  if (params.has('date')) {
    const d = new Date(`${params.get('date')}T12:00:00`);
    if (!Number.isNaN(d.getTime())) now = d;
  }
  if (now.getMonth() === 0 && now.getDate() <= 6) return 1;
  const year = now.getFullYear();
  const start = new Date(year, 10, 1);
  const eve = new Date(year, 11, 24);
  return clamp01((now - start) / (eve - start));
}
