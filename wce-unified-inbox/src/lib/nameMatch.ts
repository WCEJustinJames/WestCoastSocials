// Shared name-token matching for the auto-linker and the merge guard, so the
// two features agree on when "Pat Murphy" and "Patrick Murphy" are one person.

// Common first-name diminutives, folded to one canonical form. Only ever applied
// per-token; a fold that makes two DIFFERENT people collide is still protected
// by the callers' uniqueness / pairwise rules.
export const DIMINUTIVES: Record<string, string> = {
  josh: 'joshua', rob: 'robert', robbie: 'robert', bob: 'robert', bobby: 'robert',
  dave: 'david', matt: 'matthew', mike: 'michael', mick: 'michael', tom: 'thomas',
  tommy: 'thomas', tony: 'anthony', chris: 'christopher', nick: 'nicholas',
  dan: 'daniel', danny: 'daniel', jim: 'james', jimmy: 'james', jamie: 'james',
  bill: 'william', billy: 'william', will: 'william', rick: 'richard',
  ricky: 'richard', dick: 'richard', steve: 'steven', andy: 'andrew',
  drew: 'andrew', tim: 'timothy', sam: 'samuel', ben: 'benjamin',
  alex: 'alexander', ed: 'edward', eddie: 'edward', ted: 'edward',
  greg: 'gregory', jeff: 'jeffrey', ken: 'kenneth', kenny: 'kenneth',
  pat: 'patrick', paddy: 'patrick', pete: 'peter', ray: 'raymond',
  ron: 'ronald', ronnie: 'ronald', terry: 'terence', vince: 'vincent',
  joe: 'joseph', joey: 'joseph', jon: 'jonathan', johnny: 'john',
  frank: 'francis', frankie: 'francis', gerry: 'gerard', jerry: 'gerard',
  larry: 'lawrence', laurie: 'lawrence', stu: 'stuart', gaz: 'gary',
  baz: 'barry', shaz: 'sharon', kev: 'kevin', trev: 'trevor', gav: 'gavin',
  nath: 'nathan', jono: 'jonathan', davo: 'david', stevo: 'steven',
}

/** True when a and b are within one edit (substitution, insertion or deletion). */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true
  const la = a.length, lb = b.length
  if (Math.abs(la - lb) > 1) return false
  if (la === lb) {
    let diffs = 0
    for (let i = 0; i < la; i++) if (a[i] !== b[i] && ++diffs > 1) return false
    return true
  }
  // Lengths differ by 1: the longer string must equal the shorter with one gap.
  const [s, l] = la < lb ? [a, b] : [b, a]
  let i = 0, j = 0, skipped = false
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue }
    if (skipped) return false
    skipped = true
    j++
  }
  return true
}

function pairOk(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length === 1 || b.length === 1) return a[0] === b[0]
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true
  if (a.length >= 5 && b.length >= 5 && withinOneEdit(a, b)) return true
  return false
}

/**
 * Do two name TOKENS plausibly refer to the same word? Exact match, a prefix
 * ("knez"/"knezevic", "cam"/"cameron"), a one-letter typo in a longer word
 * ("mcdermit"/"mcdermott"), a bare initial matching the word's first letter
 * ("l"/"lorinda"), or a known diminutive of the same name ("pat"/"patrick").
 * The raw tokens are compared first so the diminutive fold can only ADD matches
 * ("nick"/"nicky" must not stop matching because "nick" folds to "nicholas").
 */
export function tokensCompatible(rawA: string, rawB: string): boolean {
  if (pairOk(rawA, rawB)) return true
  const a = DIMINUTIVES[rawA] ?? rawA
  const b = DIMINUTIVES[rawB] ?? rawB
  return (a !== rawA || b !== rawB) && pairOk(a, b)
}

/**
 * Are two cleaned names (normCore output) compatible enough to auto-merge the
 * records they sit on? Every token of the SHORTER name must line up with some
 * token of the longer one — so "Pat Murphy" matches "Patrick Murphy Poker Pat",
 * but "Sam Filkins" vs "Sam Wood" (a real second person on the same number)
 * still clashes on the surname and is left for a human.
 */
export function namesCompatible(nameA: string, nameB: string): boolean {
  const ta = [...new Set(nameA.split(' ').filter(Boolean))]
  const tb = [...new Set(nameB.split(' ').filter(Boolean))]
  if (ta.length === 0 || tb.length === 0) return true
  const [small, large] = ta.length <= tb.length ? [ta, tb] : [tb, ta]
  return small.every((x) => large.some((y) => tokensCompatible(x, y)))
}
