/** True in the deployed multi-file build (registers the offline service worker), false in the one-file build. */
declare const __HATCH_SW__: boolean;
/** False in the one-file build (vite.single.config.ts): no basemap files to load there, so its code is dropped. */
declare const __BASEMAP__: boolean;
