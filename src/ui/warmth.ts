import raw from '../data/warmth-trend.json';

/** One town's change in spring warmth: days earlier per decade (negative = later), and its standard error (pipeline/drift). */
interface Site {
  name: string;
  perDecade: number;
  se: number;
}
const { years, milestoneDD, sites } = raw as unknown as { years: [number, number]; milestoneDD: number; sites: Site[] };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** A bar of plus or minus 1.96 standard errors is the range that holds the true change 19 times in 20. */
const Z = 1.96;
/** Clearly earlier: the whole range sits above zero. */
const clear = (s: Site) => s.perDecade - Z * s.se > 0;

const W = 300;
const ROW = 19;
const LEFT = 84;
const RIGHT = W - 8;
const [LO, HI] = [-3, 4];
const x = (v: number) => LEFT + ((v - LO) / (HI - LO)) * (RIGHT - LEFT);

/** The About panel's "Are springs warming?" fold: each town's change as a dot with its range, and one honest line. */
export function warmthHtml(): string {
  const clearOnes = sites.filter(clear).map((s) => s.name);
  const lead = clearOnes.length
    ? `Spring warmth arrives earlier in ${clearOnes.join(' and ')}. Elsewhere any change is smaller than the year-to-year swings.`
    : 'No clear change in when spring warmth arrives. Any change is smaller than the year-to-year swings.';
  const h = sites.length * ROW + 26;
  const rows = sites
    .map((s, i) => {
      const y = i * ROW + ROW / 2 + 2;
      const lo = Math.max(LO, s.perDecade - Z * s.se);
      const hi = Math.min(HI, s.perDecade + Z * s.se);
      return `<text x="0" y="${y + 4}" class="wm-name">${esc(s.name)}</text>
      <line x1="${x(lo).toFixed(1)}" x2="${x(hi).toFixed(1)}" y1="${y}" y2="${y}" class="wm-bar"/>
      <circle cx="${x(s.perDecade).toFixed(1)}" cy="${y}" r="4" class="wm-dot${clear(s) ? ' clear' : ''}"/>`;
    })
    .join('');
  const axisY = sites.length * ROW + 4;
  const ticks = [-2, 0, 2, 4].map((v) => `<text x="${x(v).toFixed(1)}" y="${axisY + 14}" class="wm-tick" text-anchor="middle">${v}</text>`).join('');
  const summary = sites.map((s) => `${s.name}: ${s.perDecade > 0 ? '+' : ''}${s.perDecade.toFixed(1)} days`).join('; ');
  return `<details class="ex-fine" data-key="warmth"><summary>Are springs warming?</summary>
    <p class="wm-lead">${esc(lead)}</p>
    <figure class="wm-fig"><svg viewBox="0 0 ${W} ${h}" role="img" aria-label="Days earlier per decade, ${years[0]} to ${years[1]}. ${esc(summary)}.">
      <line x1="${x(0)}" x2="${x(0)}" y1="0" y2="${axisY}" class="wm-zero"/>${rows}${ticks}</svg></figure>
    <p class="wm-note">Days earlier per decade that a town banks ${Math.round(milestoneDD)} degree-days of warmth (what a luna moth needs), ${years[0]} to ${years[1]}. Hollow dots: the bar crosses zero, so it could be chance.</p></details>`;
}
