# West Coast Poker — cash commission & buy-in structure (June 2026)

Source of truth for opening cash tables. LP can't set a 3rd blind / locked
straddle, so **$2/5/10 is run on the $2/5 stake** — which is exactly why its
buy-in limits MUST be set differently from a real $2/5 (they look the same in
LP otherwise).

## Buy-ins & commission

| Stake | Min | Max | Commission |
|---|---|---|---|
| $2/3 NLH | $50 | $500 | 10% cap $25 |
| $2/5 NLH | $100 | $1000 | 10% cap $25 |
| **$2/5/10 NLH** | **$300** | **$1500** | 10% cap $25 · **$10 locked straddle** |
| $5/10 NLH | $500 | $3000 | tiered by pot (see below) |

$5/10 pot-based commission: $0–49 → $0, $50–99 → $5, $100–149 → $10,
$149–299 → $15, $300–500 → $20, $500+ → $25.

- **All straddles live to the button.** Floor must approve any stake change.

## How to encode in LP (AddTable / ModifyTable)

`buyInLimits` is in **big blinds** (`min`/`max` × bigBlind = the $ amount). The
$2/5/10 game uses the **2/5 stake** (`blinds:[2,5]`, id `bc10b214-408b-4d31-94cd-397417f02006`).

| Table type | stake blinds | buyInLimits (BB) | → $ |
|---|---|---|---|
| $2/5 | [2,5] | `{min:20, max:200}` | $100 / $1000 |
| $2/5/10 (on 2/5 stake) | [2,5] | `{min:60, max:300}` | $300 / $1500 |
| $5/10 | [5,10] | `{min:50, max:300}` | $500 / $3000 |

Default "fill" buy-in ≈ **80% of max** (e.g. $2/5 → $800, $2/5/10 → $1200).

## Table naming

`#<n> <Venue> <stakes> NLH` — always the **real** blinds in the title even when
LP runs it on a lower stake. E.g. `#1 MCT $2/5/10 NLH`, `#2 MCT $2/5 NLH`.
Venue = the venue that night (short code, e.g. MCT = Market City Tavern,
Woodvale, Kenwick, Leederville, Kingsley).

Rename in place with `ModifyTable` (`parentLogId = tableId`,
`eventData:{identifier}` and/or `{buyInLimits}`) — players stay seated.
