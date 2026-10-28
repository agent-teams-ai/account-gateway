// TEST operator completion contract; never infer completion from exit zero alone.
export function qualifyTap(tap: string): { tests: number } {
  const deny = (): never => { throw new Error('suite-incomplete'); };
  function summary(name: string): number {
    const matches = [...tap.matchAll(new RegExp('^# ' + name + ' ([0-9]+)$', 'gm'))];
    if (matches.length !== 1) return deny();
    const count = Number(matches[0]![1]);
    if (!Number.isSafeInteger(count)) return deny();
    return count;
  }
  const tests = summary('tests');
  if (tests <= 0 || summary('pass') !== tests ||
      ['fail', 'cancelled', 'skipped', 'todo'].some(name => summary(name) !== 0)) return deny();
  if (/^\s*not ok(?:\s|$)/m.test(tap) || /^\s*Bail out!/m.test(tap) ||
      /^\s*(?:not )?ok\s+\d+[^\n]*#\s*(?:SKIP|TODO)\b/im.test(tap)) return deny();
  const plans = [...tap.matchAll(/^1\.\.([0-9]+)$/gm)];
  if (plans.length !== 1) return deny();
  const planned = Number(plans[0]![1]);
  const results = [...tap.matchAll(/^ok ([0-9]+)(?:\s|$)/gm)];
  if (!Number.isSafeInteger(planned) || planned <= 0 || results.length !== planned ||
      results.some((result, index) => Number(result[1]) !== index + 1)) return deny();
  // Node writes this terminal footer after the inventory and completion counters.
  if (!/^# duration_ms [0-9]+(?:\.[0-9]+)?\s*$/.test(tap.split('\n').filter(Boolean).at(-1) ?? '')) return deny();
  return { tests };
}
