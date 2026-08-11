/** @type {import('tailwindcss').Config} */

// Modernist redesign (2026-08 handoff): all colour comes off the CSS variables
// in index.css so the alternate palettes stay a runtime switch. `slate` and
// `emerald` are re-pointed at the neutral/accent ramps as a transition net —
// any utility class not yet converted to the token classes still lands on the
// design's palette instead of Tailwind's blues/greens.
const neutral = {
  50: 'var(--color-neutral-100)',
  100: 'var(--color-neutral-100)',
  200: 'var(--color-neutral-200)',
  300: 'var(--color-neutral-300)',
  400: 'var(--color-neutral-500)',
  500: 'var(--color-neutral-600)',
  600: 'var(--color-neutral-700)',
  700: 'var(--color-neutral-700)',
  800: 'var(--color-neutral-800)',
  900: 'var(--color-neutral-900)',
  950: 'var(--color-neutral-900)',
}
const accent = {
  DEFAULT: 'var(--color-accent)',
  50: 'var(--color-accent-100)',
  100: 'var(--color-accent-100)',
  200: 'var(--color-accent-200)',
  300: 'var(--color-accent-300)',
  400: 'var(--color-accent-400)',
  500: 'var(--color-accent-500)',
  600: 'var(--color-accent-600)',
  700: 'var(--color-accent-700)',
  800: 'var(--color-accent-800)',
  900: 'var(--color-accent-900)',
  950: 'var(--color-accent-900)',
}

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    // Radius 0 everywhere — the design has no corner radius. `full` stays
    // round for the few genuinely circular marks (radio dots).
    borderRadius: {
      none: '0',
      sm: '0',
      DEFAULT: '0',
      md: '0',
      lg: '0',
      xl: '0',
      '2xl': '0',
      '3xl': '0',
      full: '9999px',
    },
    // No decorative shadows on content; only the dialog elevation survives.
    boxShadow: {
      none: 'none',
      sm: 'none',
      DEFAULT: 'none',
      md: 'none',
      lg: '0 12px 32px color-mix(in srgb, #2d2b2b 22%, transparent)',
      xl: '0 12px 32px color-mix(in srgb, #2d2b2b 22%, transparent)',
      '2xl': '0 12px 32px color-mix(in srgb, #2d2b2b 22%, transparent)',
      inner: 'none',
    },
    extend: {
      colors: {
        ink: 'var(--color-text)',
        paper: 'var(--color-bg)',
        surface: 'var(--color-surface)',
        divider: 'var(--color-divider)',
        accent,
        slate: neutral,
        emerald: accent,
      },
      fontFamily: {
        sans: ['Archivo', 'system-ui', 'sans-serif'],
      },
      screens: {
        // The design's one breakpoint: bottom tab bar at ≤880px, header tabs above.
        dt: '881px',
      },
    },
  },
  plugins: [],
}
