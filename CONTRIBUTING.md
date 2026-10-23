# Contributing

Hatch is built by Claude sessions and merged without a human reviewer, so the checks below stand in for one.

## Before a pull request

```
npm ci && npm run check
```

`check` builds both versions, enforces the bundle budget and runs every Playwright smoke test. CI runs the same tests on
every pull request (`.github/workflows/mobile-smoke.yml` and `desktop-smoke.yml`) and uploads their screenshots.

## What the automatic tests catch, and what they miss

| Test | Looks at | Catches |
|---|---|---|
| `npm run mobile`, `npm run desktop` | the page 2.5 s after load, then tap, mouse and keyboard flows | errors, a blank map, covered or off-screen buttons, broken flows |
| `npm run firstframes` | every map frame from the first one until 1.5 s after the map shows | a stretched, blurry or misplaced first frame (the "flash on first load"); saves a filmstrip per screen |
| the visual review (below) | the screenshots and filmstrips, by eye | anything that looks unintentional: stray lines, empty areas, misalignment |

The smoke tests are like a photographer who arrives after the fireworks: they see the settled page, not the first
second. `firstframes` films that first second. Neither can say "this looks wrong", which is why the visual review exists.

Real phones still catch things no simulated browser can, such as iOS Safari taking the map's graphics memory back.

## Review: two reviewers, one of them visual

Every pull request gets two reviewer subagents before it merges. Fix what they find, then merge. If a third round is
needed, rethink the change instead.

1. **Code reviewer.** Reads the diff for bugs, edge cases and code that does not match its surroundings.
2. **Visual reviewer.** Asks one question: *does anything on screen look unintentional?* It looks at pictures, not code.

For a pull request that changes nothing on screen (data, docs, CI), the visual reviewer may be skipped; say so in the
pull request.

### Running the visual review

Make the pictures for the branch, and for `main` to compare against:

```
npm run build:single
npm run mobile && npm run desktop && npm run firstframes   # writes screenshots/mobile, /desktop, /firstframes
```

Or download the `mobile-screenshots` and `desktop-screenshots` artifacts from the pull request's CI run.
`mobile-screenshots` holds the phone shots in `mobile/` and the filmstrips in `firstframes/` (`*-filmstrip.png`).

Then give a reviewer subagent the image paths and this prompt:

> You are reviewing screenshots of Hatch, a map web app, for visual glitches. You are not reviewing code. For each
> image, ask: does anything here look unintentional? Look especially for:
> - odd lines: seams, hairlines or gaps between shapes that should meet, borders drawn twice;
> - empty areas: a panel, chart band or legend entry with nothing in it, a blank or single-colour map, missing labels;
> - misalignment: text or buttons off their baseline or grid, overlapping, clipped or cut off at the screen edge;
> - wrong size or place: a blurry, stretched or zoomed-in map, something jumping between filmstrip frames;
> - anything else a first-time visitor would read as broken.
> For each finding give the file name, where in the image, what looks wrong and why it looks unintentional. Compare with
> the `main` screenshots where given, and say whether the branch introduced it. If nothing looks wrong, say so plainly;
> do not invent findings.

Treat each finding like a code-review finding: fix it, or say in the pull request why it is intended.
