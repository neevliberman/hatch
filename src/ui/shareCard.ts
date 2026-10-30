import { isDark, palette } from '../theme';
import { pen, type P } from './sketch';
import { markFor } from './mark';

export interface ShareCardInput {
  /** e.g. "luna moths" */
  name: string;
  url: string;
  /** Range and cursor, in ms. */
  start: number;
  end: number;
  cursor: number;
  /** The cursor's date as text, e.g. "May 12". */
  dateLabel: string;
  /** A species mark URL; skipped if it can't be loaded. */
  mark?: string;
}

const W = 1200;
const H = 630;
const rgba = (c: ArrayLike<number>) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] ?? 255) / 255})`;

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = src;
  });
}

/** Draw one pen stroke (a filled outline from sketch.ts). */
function stroke(ctx: CanvasRenderingContext2D, pts: P[], w: number, seed: number, color: string) {
  try {
    ctx.fillStyle = color;
    ctx.fill(new Path2D(pen(pts, w, seed)));
  } catch {
    /* a missing Path2D just leaves the line out */
  }
}

/** A Field Notebook share card as a PNG: the species, a small timeline ribbon with today marked, and the link. */
export async function shareCard(o: ShareCardInput): Promise<Blob | null> {
  try {
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    const dark = isDark();
    const paper = dark ? '#1d1914' : '#f8f2e3';
    const ink = dark ? '#eadfc8' : '#2b241c';
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, W, H);
    stroke(ctx, [[40, 40], [W / 2, 36], [W - 40, 41]], 2.4, 3, ink);
    stroke(ctx, [[W - 40, 40], [W - 43, H / 2], [W - 40, H - 40]], 2.4, 5, ink);
    stroke(ctx, [[W - 40, H - 40], [W / 2, H - 43], [40, H - 40]], 2.4, 7, ink);
    stroke(ctx, [[40, H - 40], [43, H / 2], [40, 40]], 2.4, 9, ink);

    const mark = o.mark ? await loadImage(await markFor(o.mark)) : null;
    if (mark) ctx.drawImage(mark, W - 280, 80, 180, 180);

    ctx.fillStyle = ink;
    ctx.textBaseline = 'alphabetic';
    ctx.font = '600 34px Caveat, "Segoe Print", cursive';
    ctx.fillText('Hatch', 90, 120);
    ctx.font = '700 76px Fraunces, Georgia, serif';
    ctx.fillText(`When ${o.name}`, 90, 230, W - 400);
    ctx.fillText('come out', 90, 315, W - 400);
    ctx.font = '600 44px Caveat, "Segoe Print", cursive';
    ctx.fillText(o.dateLabel, 90, 385);

    // The ribbon: the season's range in the forecast stages, with the cursor's day marked.
    const x0 = 90;
    const x1 = W - 90;
    const y = 440;
    const stages = ['not yet', 'starting', 'peak', 'winding down', 'over'] as const;
    const share = [0.12, 0.2, 0.3, 0.2, 0.18];
    let x = x0;
    stages.forEach((s, i) => {
      const w = (x1 - x0) * share[i]!;
      ctx.fillStyle = rgba(palette.stages[s]);
      ctx.fillRect(x, y, w, 26);
      x += w;
    });
    stroke(ctx, [[x0, y], [(x0 + x1) / 2, y - 1], [x1, y + 1]], 1.8, 11, ink);
    stroke(ctx, [[x0, y + 26], [(x0 + x1) / 2, y + 27], [x1, y + 26]], 1.8, 13, ink);
    const span = Math.max(1, o.end - o.start);
    const t = Math.min(1, Math.max(0, (o.cursor - o.start) / span));
    const cx = x0 + (x1 - x0) * t;
    stroke(ctx, [[cx, y - 16], [cx + 1, y + 13], [cx, y + 42]], 3, 17, ink);

    ctx.fillStyle = ink;
    ctx.font = '400 26px "Atkinson Hyperlegible", system-ui, sans-serif';
    const url = o.url.replace(/^https?:\/\//, '');
    ctx.fillText(url.length > 70 ? `${url.slice(0, 69)}…` : url, 90, 545, W - 180);

    return await new Promise<Blob | null>((res) => cv.toBlob((b) => res(b), 'image/png'));
  } catch {
    return null;
  }
}
