/* Lucide icons, inlined (stroke=currentColor, stroke-width 2) — the redesign's
   icon set. Inline SVG keeps the bundle self-contained; add icons here as
   screens need them rather than importing an icon library. */
import type { ReactNode } from 'react'

function svg(size: number, paths: ReactNode, label?: string) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {paths}
    </svg>
  )
}

export const IconHome = ({ size = 18 }: { size?: number }) =>
  svg(
    size,
    <>
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </>,
  )

export const IconInbox = ({ size = 18 }: { size?: number }) =>
  svg(
    size,
    <>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>,
  )

export const IconUsers = ({ size = 18 }: { size?: number }) =>
  svg(
    size,
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>,
  )

export const IconTrophy = ({ size = 18 }: { size?: number }) =>
  svg(
    size,
    <>
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </>,
  )

export const IconBanknote = ({ size = 18 }: { size?: number }) =>
  svg(
    size,
    <>
      <rect width="20" height="12" x="2" y="6" />
      <circle cx="12" cy="12" r="2" />
      <path d="M6 12h.01" />
      <path d="M18 12h.01" />
    </>,
  )

export const IconMegaphone = ({ size = 18 }: { size?: number }) =>
  svg(
    size,
    <>
      <path d="m3 11 18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </>,
  )

export const IconSend = ({ size = 15 }: { size?: number }) =>
  svg(
    size,
    <>
      <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" />
      <path d="m21.854 2.147-10.94 10.939" />
    </>,
  )

export const IconChevronLeft = ({ size = 16 }: { size?: number }) =>
  svg(size, <path d="m15 18-6-6 6-6" />)

export const IconChevronRight = ({ size = 16 }: { size?: number }) =>
  svg(size, <path d="m9 18 6-6-6-6" />)

export const IconPlus = ({ size = 16 }: { size?: number }) =>
  svg(
    size,
    <>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </>,
  )

export const IconX = ({ size = 16 }: { size?: number }) =>
  svg(
    size,
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>,
  )
