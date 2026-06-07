# West Coast Poker

A play-money No-Limit Texas Hold'em game for players to enjoy when they're **not in our room** — keeping them engaged with the West Coast brand between visits.

## What it is

A self-contained, single-page web app. No build step, no server, no dependencies — just open `index.html`. State (your bankroll + table settings) persists in `localStorage`, so players can pick up where they left off.

## Features

- **Real Hold'em vs. AI bots** — 1–5 opponents with hand-strength-based decision making (and the occasional bluff).
- **Full betting** — fold / check / call / bet / raise with a slider and quick pot-fraction sizing (½, ¾, pot, all-in).
- **Correct rules engine**
  - 7-card best-five hand evaluator (royal/straight flush down to high card, including the A-5 wheel).
  - Blinds, dealer-button rotation, the big-blind option, and proper heads-up positioning.
  - **All-in & side pots** — multiple all-ins are split into the correct layered pots and awarded per eligibility. Verified by simulation (exact chip conservation over 500 hands).
- **Play money** — your stack auto-rebuys when you bust, so the fun never stops. Reset bankroll any time in Settings.
- **Hand log** — a running play-by-play of the action.

## Settings

Open **Settings** (top right) to change the number of bots, starting stack, and blind level, or to reset your bankroll. Changes apply on the next hand / restart the table.

## Tech

Plain HTML + CSS + vanilla JS, matching the rest of the WestCoastSocials repo. The game logic in `poker.js` is framework-free and runs headless (used for the test simulations above).
