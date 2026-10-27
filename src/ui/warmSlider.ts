import { CROSS, WARM } from './icons';

/** How far the slider reaches either way, °F, and its notch (each notch is one rerun of the season, kept). */
const REACH = 3;
const NOTCH = 0.5;

export interface WarmSlider {
  /** Offer it (an Atlas species) or not; taking it away puts spring back as it was. */
  set available(on: boolean);
  /** The current move, °F (0: as it was). */
  readonly value: number;
  /** Set it, as a link does (clamped to the reach and notch). */
  set(degF: number): void;
  /** What it does to the species on screen, e.g. "about 6 days earlier", beside the value. */
  note(text: string): void;
}

/**
 * "Warm the spring": a thermometer button by My area and Share, and a one-line slider it opens above the time bar.
 * Each notch makes every spring day that much warmer or cooler, and the map's species reruns its season (the layer's
 * setWarmth). Closing it puts spring back as it was, so a changed map is never left behind a closed control.
 * Analogy: a thermostat for one spring, with the map as the room.
 */
export function mountWarmSlider(button: HTMLButtonElement, row: HTMLElement, onChange: (degF: number) => void): WarmSlider {
  button.insertAdjacentHTML('afterbegin', WARM);
  row.innerHTML = `<label for="warm-in">Spring</label>
    <input id="warm-in" type="range" min="${-REACH}" max="${REACH}" step="${NOTCH}" value="0">
    <output id="warm-out" for="warm-in" aria-live="polite"></output>
    <button type="button" class="warm-x icon-btn" aria-label="Close, spring as it was">${CROSS}</button>`;
  const input = row.querySelector<HTMLInputElement>('#warm-in')!;
  const out = row.querySelector<HTMLOutputElement>('#warm-out')!;
  let value = 0;
  let said = '';
  const show = () => {
    const v = value === 0 ? 'as it was' : `${value > 0 ? '+' : '−'}${Math.abs(value)} °F`;
    out.textContent = said ? `${v}: ${said}` : v;
    input.setAttribute('aria-valuetext', out.textContent);
  };
  const set = (v: number) => {
    v = Math.max(-REACH, Math.min(REACH, Math.round(v / NOTCH) * NOTCH)) || 0;
    if (v === value) return;
    value = v;
    input.value = String(v);
    said = '';
    show();
    onChange(v);
  };
  const open = (on: boolean) => {
    row.hidden = !on;
    button.setAttribute('aria-expanded', String(on));
    button.classList.toggle('on', on);
    if (on) input.focus();
    else set(0);
  };
  button.addEventListener('click', () => open(row.hidden));
  row.querySelector('.warm-x')!.addEventListener('click', () => (open(false), button.focus()));
  input.addEventListener('input', () => set(Number(input.value)));
  row.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation(); // the page's own Escape would also unpin the card on the map
    open(false);
    button.focus();
  });
  show();
  return {
    set available(on: boolean) {
      button.hidden = !on;
      if (!on && !row.hidden) open(false);
    },
    get value() {
      return value;
    },
    set(degF) {
      if (degF && row.hidden) {
        row.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        button.classList.add('on');
      }
      set(degF);
    },
    note(text) {
      if (text === said) return;
      said = text;
      show();
    },
  };
}
