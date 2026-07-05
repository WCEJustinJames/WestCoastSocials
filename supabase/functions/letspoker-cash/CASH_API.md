# LetsPoker cash control — the real API (decoded from a live capture)

Cash games are **not** `registerPlayerIntoEvent`. Every cash-control action is a
single mutation, **`createTournamentLogItem`**, against the day's cash event,
distinguished by `eventType`. The cash "event" is a tournament-shaped container.

## Resolving the daily cash event (`tournamentId`)

`getEventList(clubId, startDate, endDate, includeCash:true)` returns it as the
entry with an **empty `eventName`** whose `scheduledDate` is **midnight Perth**
of that day. (Real tournaments always have a name.) Example (15 Jun 2026):
`id = db91ce4023057d11`, `scheduledDate = 2026-06-14T16:00:00Z`, `eventName = ""`.

## The mutation

```graphql
mutation createTournamentLogItem($data: CreateTournamentLogInput!, $tournamentId: ID!, $clubId: ID!) {
  createTournamentLogItem(data: $data, tournamentId: $tournamentId, clubId: $clubId) {
    id tournamentEventId parentLogId playerId eventType eventData __typename
  }
}
```

The returned `id` of an item is reused as a reference by later items
(`AddTable.id` is the `tableId`; `Registered.id` is the parent of `Seated` /
`AddCashBuyin`).

## eventTypes (from the live log)

| eventType | data.eventData | meaning |
|---|---|---|
| `AddTable` | `{identifier:"1", stake:{id,blinds:[2,5],currency:"AUD",text:"2/5 AUD"}, gameType:"NLH", tableSize:9, isPublic:true, buyInLimits:{min:20,max:200}, autoAddWaitingList:true}` | open a table; **returned `id` = tableId** |
| `RemoveTable` | `null` (parentLogId = the AddTable id) | close a table |
| `Command` | `{command:{start:true}}` | start the cash day |
| `Registered` | `{confirmed:true, paymentMethod:"", enforceMaxReentries:true}` (playerId set, parentLogId null) | check a player in; **returned `id` = registration id** |
| `Seated` | `{tableId, seatIndex, allowSwap:true}` (parentLogId = registration id) | seat the player (seatIndex is 0-based) |
| `AddCashBuyin` | `{addCashBuyin:{currency:"AUD", chipsAdded:100, source:"Table", notes:"…", paymentMethod:"CASH"}}` (parentLogId = registration id) | give chips / buy-in |
| `ModifyTable` | `{identifier:"LEEDERVILLE $2/5 NLH"}` | **rename a table in place** (the table name *is* its `identifier`; players stay seated). Also used by the system for `{averageStack:…}`. |
| `AddGuest` | `{name:"Www", tableId, seatIndex}` | seat a named guest placeholder (the dummy-fill method) |
| `Unseated` | `null` | remove a player from their seat |
| `Command` | `{command:{finish:true}}` | mark the cash day Finished (`{start:true}` to start) |
| `SentNotification` | `{type:"public", template:{…}}` | record of a cash push (title `"Cash table <name>"`, message `"Game: NLH - 2/5 AUD\nPlayers: 5/9\n…"`) |

## Seat a reused tournament name (the automation)

For each player to seat on the day's cash event:
1. `createTournamentLogItem` **Registered** `{playerId, eventType:"Registered", eventData:{confirmed:true, paymentMethod:"", enforceMaxReentries:true}}` → capture returned `id` (regId).
2. `createTournamentLogItem` **Seated** `{playerId, parentLogId:regId, eventType:"Seated", eventData:{tableId, seatIndex, allowSwap:true}}`.
3. (optional) `createTournamentLogItem` **AddCashBuyin** `{playerId, parentLogId:regId, eventType:"AddCashBuyin", eventData:{addCashBuyin:{currency:"AUD", chipsAdded:<amt>, source:"Table", notes:"…", paymentMethod:"CASH"}}}`.

`tableId` + open tables come from `getTournamentLog(tournamentId, clubId, dateAfter)`
(AddTable entries minus their RemoveTable children). Buy-in amount: 75–85% of the
table's `buyInLimits.max × bigBlind` (e.g. 2/5 max 200BB×5 = 1000 → ~750–850).

## Push

`sendCashPushNotification(clubId, tableId, tournamentEventId, templateParts)` —
`tournamentEventId` = the cash event id, `tableId` = an AddTable id.
