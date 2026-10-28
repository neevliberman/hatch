import type { Layer } from '@deck.gl/core';

/** Palette handed to layers so they never hard-code the app's look. */
export interface Theme {
  bg: string;
  hexEdge: [number, number, number, number];
  text: string;
}

export interface CaveatCard {
  title: string;
  /** 'synthetic' is rendered with a loud warning style; 'normal' is the default. */
  severity: 'normal' | 'synthetic';
  bullets: string[];
}

export interface ProbeCard {
  title: string;
  /** Colour chip drawn before the title (the hexagon's stage). */
  swatch?: string;
  lines: string[];
  /** Detail behind a "More" fold (a hover card leaves it out). */
  more?: string[];
  /** Optional outbound link (e.g. the iNaturalist photo). Linked, never rehosted. */
  link?: { href: string; label: string };
  /** A downloadable calendar event for the card's peak window (a data: .ics link). */
  calendar?: { href: string; filename: string; label: string };
  /** Other species to switch to (the Atlas's "also out here"): each a thumbnail, a name and a short note; `key` is its
   * ?species= value. */
  others?: { title: string; list: { key: string; label: string; note: string; img?: string }[] };
}

export interface LegendSpec {
  title: string;
  /** Colour stops from low to high, drawn as a ramp. */
  stops?: { color: string; label: string }[];
  /** Discrete keys, drawn as labelled swatches (hex) or glowing dots (dot). */
  items?: { color: string; label: string; shape: 'hex' | 'dot' | 'striped' | 'line' }[];
  note?: string;
}

/**
 * The seam every data layer plugs into (plan v2 section 6). Deliberately tiny:
 * the app owns the map and the clock; a layer loads its own data and turns (time, zoom) into deck layers.
 * Which time range a layer wants to be scrubbed over is registration metadata (see registry.ts), not part of this contract.
 */
/** One stretch of a place's season on the explainer timeline, in days of year. */
export interface SpotSegment {
  from: number;
  to: number;
  color: string;
  label: string;
}

/** A species' coming season at one place, as days of year: its first ones, its peak and its last. `year` names a
 * live forecast's season; without one it is a typical year, good for any year. */
export interface Due {
  start: number;
  peak: number;
  end: number;
  year?: number;
}

/** The explainer's "your spot" card: one place's season, drawn as a strip with today marked. */
export interface SpotStory {
  title: string;
  sentence: string;
  /** Days of year the strip spans, with the stages laid along it and real sightings as ticks. */
  span: [number, number];
  /** Axis labels: the day of year each month starts. */
  months: { doy: number; label: string }[];
  segments: SpotSegment[];
  ticks: number[];
  today: number;
}

/** A species' pen drawing for the About panel's sketch strip and the off-season note (ui/sketch.ts draws the scenes
 * around it). Shapes are SVG path data, centred on (cx, cy) at scale k; `seed` keeps the wobble the same each time. */
export interface Creature {
  /** Winter quarters: 'litter' = a cocoon in the fallen leaves (luna), 'soil' = a grub under the ground line. */
  winters: 'litter' | 'soil';
  sleeper(cx: number, cy: number, k: number, seed: number): { wash: string; ink: string };
  /** The adult; `wings` are drawn apart so they can flap. */
  adult(cx: number, cy: number, k: number, seed: number): { wash: string; wings: string; body: string };
  /** The adult's wash is a sun-yellow glow under it (a firefly), not a leaf-green one under its wings. */
  glow?: boolean;
  /** Leaves an empty cocoon behind once out. */
  shell?: boolean;
  /** The sketch strip's warm-vs-cool panel: the month a warm spring's adult is out (a cool spring's is still asleep
   * then), and the month the cool spring's comes out. From the species' own typical onset: luna May/June. */
  months: [warm: string, cool: string];
}

/**
 * The visual About panel for a species (plan v2: "wow first, honesty one tap away"). Optional: a layer without one
 * falls back to its caveats() list. The fine print is always caveats(), so the honesty lives in one place.
 */
/** One test of the forecast against the usual date: where ("on past years", "in 2026"), mean days off for each, and
 * how big a test it was ("44 strip-years"). */
export interface RecordCheck {
  where: string;
  days: number;
  usual: number;
  size?: string;
  /** A live season's check (ui/scorecard.ts): its year and strips scored. recordLine pools the seasons that share a
   * verb into one clause ("in 2026 and 2027 (10 strip-years)"), weighted by strips, so the line stays one line. */
  season?: number;
  n?: number;
  /** A season rebuilt after the fact (a rehearsal): never pooled with real ones, and its size says so. */
  rehearsal?: boolean;
  /** Pooled from several seasons: its days off are averages, and say so. */
  avg?: boolean;
}

export interface Explainer {
  name: string;
  sci: string;
  /** The animal's drawing for the sketch strip (ui/sketch.ts); the strip and timeline take their colour from `accent`. */
  creature: Creature;
  accent: string;
  hook: string;
  /** Captions for the three sketched panels: how it spends winter, warmth wakes it, a warm spring vs a cool one. */
  steps: [{ title: string; text: string }, { title: string; text: string }, { title: string; text: string }];
  spotIntro: string;
  /** The season at a place (null = the layer's default spot), on the day `t`, called `name` when it has one (a
   * picked city, "you"), or offered as the example (`example`: "Example: the Columbus area"). Null when there is
   * nothing to show. */
  spot(lngLat: [number, number] | null, t: number, name?: string, example?: boolean): SpotStory | null;
  /** How sure it is. The bold answer line is worked out from the bars (the forecast first, then what it is measured
   * against), so it always says what this layer's own scores say. `points`: a few short plain sentences. */
  score?: {
    title: string;
    points: string[];
    bars: { label: string; days: number; best?: boolean }[];
    /** What the bars were scored on, for the bold line: "on past years", "in 2019". */
    scope?: string;
    /** Every check of the model against the usual date that this layer's data holds (ui/explainer.ts recordLine);
     * this season's live check is added from the scorecard file when it loads. */
    checks?: RecordCheck[];
    /** The last season `checks` cover (the replay's last year), said when no live season joins them. */
    checksThrough?: number;
  };
  /** A short card near the top for a special mode (this year's live forecast): what it is, in plain words. */
  notice?: { title: string; bullets: string[] };
  finePrintLabel: string;
}

/** The season at a glance, drawn in the time slider's track. Each series has one value per day of the layer's range. */
export interface SeasonProfile {
  /** Stacked from the bottom: each colour's share (0-1) of the map on each day. */
  bands: { color: string; share: number[] }[];
  /** Animals seen per day, drawn as a line scaled to its own peak. */
  seen: number[];
  /** Washes in their own colour under the line, on the same scale: part of `seen`, such as a wave the forecast does
   * not cover, in the colour of its dots on the map; or, with `seen` the photos expected, the ones seen. */
  seenOnly?: { color: string; seen: number[] }[];
  /** Handwritten notes on the line, at a day index. */
  notes: { at: number; text: string }[];
}

export interface OffSeasonNote {
  title: string;
  line: string;
  sketch: string;
  at: { wide: [number, number]; phone: [number, number] };
}

/** A species' own words for the shared page frame, so the header, menus and share sheet never name a species
 * themselves. Each string is used exactly as written. */
export interface SpeciesWords {
  /** The animals, counted: the season menu's "2024 (310 moths)" and the dots line "Dots: moths seen ...". */
  plural: string;
  /** Whose sightings the map shows, in its screen-reader label: "luna moth" sightings. */
  sightingsOf: string;
  /** What the season menu's counts count, in its tooltip: "first-wave moths" seen. */
  countedAs: string;
  /** The share sheet's title, "Hatch: when ___ come out": "luna moths". */
  shareName: string;
  /** The header's little sketch of the animal beside "Hatch" (an image URL; drawn to read at 24 px). The tab and app
   * icons stay the neutral Hatch logo. */
  mark: string;
}

export interface HatchLayer {
  id: string;
  /** A tracker (sightings so far, no forecast): the page leaves out its "colors: forecast" caveat. */
  tracker?: boolean;
  title: string;
  /** The species' words for the page around the map; see SpeciesWords. */
  words: SpeciesWords;
  /** `wash`: ms since the map's first frame while the forecast washes in (south first, 900 ms in all), else undefined.
   * `playing` (playback is gliding: not under reduced motion or on a slow device) and `frac` (how far into the next
   * step, 0 at rest) let a layer draw in-between frames during playback. */
  render(ctx: { t: number; zoom: number; theme: Theme; wash?: number; playing?: boolean; frac?: number }): Layer[];
  /** Is the season in full swing on day t (e.g. any hexagon starting or at peak)? Playback slows down for those days. */
  busy?(t: number): boolean;
  /** The note shown beside the replay button when playback reaches the last day: a headline and a nudge to replay. */
  endNote?: [string, string];
  /** Honesty one tap away. Required. */
  caveats(): CaveatCard;
  /** The colours' track record for the line under the map: mean days off in past years it never learned from, the
   * usual date's, and whether this is a first try (an untuned recipe borrowed from another species). */
  record?(): { days: number; calendar: number; firstTry: boolean };
  legend(): LegendSpec;
  /** "What's here" for hover/tap. `picked` is the data object under the pointer, if it belongs to this layer. */
  probe?(lngLat: [number, number], t: number, picked?: { layerId: string; object: unknown }): ProbeCard | null;
  /** Visual About panel; see Explainer. */
  explainer?(): Explainer;
  /** Points on the map at time t that place names must not cover (the sighting dots). Return the same array while
   * they are unchanged: the names are only re-placed when it changes. */
  points?(t: number): [number, number][];
  /** The season ribbon in the time slider's track (the active layer's own, so each species draws its season). */
  profile?(): SeasonProfile;
  /** The sightings made on day t itself: while paused they breathe (map.ts). */
  newest?(t: number): { lng: number; lat: number }[];
  /** A margin note for when nothing is out (after the season): a handwritten title, a muted line under it, a small
   * pen sketch (SVG markup in a 64x34 box), and where it goes: a [lng, lat] on empty paper beside the map's data, one
   * for a wide screen and one for a phone. Null while anything is out. A layer without it gets no note.
   * Return the same object each time: the note is only redrawn when it changes. */
  offSeason?(t: number): OffSeasonNote | null;
  /** Data sources to credit, rendered in the drawer. */
  /** Data sources, each a line of text; `href` links the line's source. */
  credits?(): { text: string; href?: string }[];
}

/** Forecast hexagon layers are named <species>-forecast-r4/-r5/-r6 (luna-forecast-r4), one per hexagon size, with -blend added while playback
 * glides (see lunaReplay.ts render and motion.ts hexFade). */
export const isForecast = (layerId: string | undefined) => /^[a-z-]+-forecast-r\d/.test(layerId ?? '');
/** The hexagon layers (forecast and its stripes): the map draws lakes, rivers and roads over these, under the dots. */
export const isHexes = (layerId: string) => /^[a-z-]+-(forecast|unseen)-r\d/.test(layerId);
