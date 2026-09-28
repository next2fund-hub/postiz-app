import localFont from 'next/font/local';

/**
 * Plus Jakarta Sans, self-hosted.
 *
 * Previously loaded via next/font/google, which fetches from Google at BUILD
 * time. That makes fonts.googleapis.com a hard dependency of every deploy: on
 * 2026-09-27 it was briefly unreachable from the CI runner and the entire image
 * build failed with "An error occurred in `next/font`" - nothing to do with the
 * code being built.
 *
 * These are the same files Google serves, committed to the repo. Two variable
 * woff2 files (latin subset, weights 200-800, roman and italic) cover every
 * weight the app asks for - 500, 600 and 700 - in 57KB total.
 *
 * To refresh: fetch the css2 URL with a modern browser User-Agent (the API
 * returns woff2 only to browsers that support it), take the `latin` @font-face
 * blocks for each style, and replace these files.
 */
export const jakartaSans = localFont({
  src: [
    {
      path: './fonts/PlusJakartaSans-latin.woff2',
      weight: '200 800',
      style: 'normal',
    },
    {
      path: './fonts/PlusJakartaSans-latin-italic.woff2',
      weight: '200 800',
      style: 'italic',
    },
  ],
  display: 'swap',
  fallback: ['system-ui', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
});
