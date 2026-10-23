# Fonts

Self-hosted so the app makes no outside requests. All three are under the SIL Open Font License (see the LICENSE files).
Taken from the `@fontsource` packages (v5) and cut down to the characters the app uses, to keep the one-file build under budget:

```sh
pyftsubset fraunces-latin-700-normal.woff2 --unicodes="U+0020-007E,U+00A0-00FF,U+2013,U+2014,U+2018,U+2019,U+201C,U+201D,U+2026,U+00B0,U+2192,U+2197,U+00B7" --layout-features='kern,liga' --flavor=woff2
# same for the two Atkinson Hyperlegible weights; Caveat (only a few English asides) gets plain ASCII and kerning:
pyftsubset caveat-latin-600-normal.woff2 --unicodes="U+0020-007E" --layout-features='kern' --flavor=woff2
```

- Fraunces 700: titles. Atkinson Hyperlegible 400/700: everything else (built for low-vision readers). Caveat 600: the handwritten asides.
