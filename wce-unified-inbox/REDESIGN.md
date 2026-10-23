# Modernist redesign — working conventions

The 2026-08 dashboard redesign ("Modernist", Felt-green palette). Tokens and
component classes live in `src/index.css`; `tailwind.config.js` re-points
`slate`→neutral ramp and `emerald`→accent ramp as a transition net and zeroes
all corner radii. The interactive prototype this recreates is in the design
handoff bundle (`WCP Inbox Redesign v2.dc.html`); its README is the spec.

## The language

- Flat and architectural. **No corner radius** (config enforces it). **No
  decorative shadows** on content (config zeroes sm/md; `shadow-lg` survives
  for dialogs only).
- Structure is drawn with **rules, not boxes**: a 2px divider opens every
  section (`.section-head`, `.rule-2`), 1px rules separate rows (`.row`).
  Avoid bordered/filled "cards" for lists — use rows on the page ground.
- Everything flush left. One accent colour, used sparingly: primary actions,
  selection marks, kickers, negative money, and genuine alarms. There is no
  red/amber/green traffic light anymore — bad news is accent + weight + copy.
- Font is Archivo everywhere (400/600/800). Headings 800, tracking -0.015em.
  **Tabular numerals on every time, date, money and count** — class `tnum`.
- Icons are inline Lucide SVGs from `src/ui/icons.tsx` — **no emoji icons**.
- Buttons/segments/tags never wrap: they carry `white-space:nowrap` +
  `flex:none`; let the row wrap instead.

## Cheat sheet

| Thing | Use |
|---|---|
| Page ground / text | `bg-paper`, `text-ink` (usually inherited) |
| Muted text | `.muted-70/.muted-60/.muted/.muted-50/.muted-45` (70–45% ink) |
| Section kicker | `.kicker` (11px caps accent-700) inside `.section-head` |
| Row list | container `border-t-2 border-divider`; rows `.row` (+`.row-hover`) `py-3` |
| Primary / secondary / ghost | `.btn .btn-primary` / `.btn .btn-secondary` / `.btn .btn-ghost` |
| Quiet text action (Mute, Done, Clear, Reject) | `.btn-quiet` |
| Segmented control | `.seg` + `.seg-btn` with `aria-pressed` (compact: add `.seg-btn-sm`) |
| Input / select / textarea | `.input`; labelled: `.field` wrapper with `<label>` |
| Checkbox | `.checkbox` |
| Tags | `.tag .tag-accent` (tint) / `.tag-neutral` / `.tag-outline`; 9px network tags add `.tag-net` |
| Status square | `.sq` (8px) / `.sq-sm` (6px) with inline `background` |
| Surface blocks (outbound msgs, option rows) | `bg-surface` |
| Big figures | `text-[28px] font-extrabold tnum` (stats) / 20px (counts) / 16px (row money) |
| Negative money | `style={{ color: 'var(--color-accent-700)' }}` |

Type scale: page title 25px/800 · row titles 14–15px/600 · body 14px · meta
12px muted · micro-labels 10–11px uppercase tracking .08em · stat figures
28px/800.

## Layout

- The shell (`App.tsx`) owns page width (1240px), gutters and the two-level
  nav. Screens render content only — **no screen-level max-width, padding or
  overflow containers**.
- One breakpoint: `dt` = 881px (`dt:` = desktop, default = phone). The phone
  gets the fixed bottom tab bar; `main` already carries `pb-32` for it.
- Long internal lists (inbox thread pane) may keep their own scroll areas.

## Hard rules for restyling passes

- Surgical: change JSX classes/markup and copy only as far as the design
  needs. **Do not** change data fetching, Supabase queries, handlers, effect
  logic, or component contracts beyond what a screen's spec names.
- Keep every existing feature reachable — this app is the operational truth
  for a live venue business. If the prototype omits a feature the app has,
  restyle it into the new language, don't delete it.
- Honest states stay honest: empty/error/loading states and alarm copy must
  survive. Alarms render as accent + bold, never hidden.
- 44px minimum touch targets on phone for primary actions.
