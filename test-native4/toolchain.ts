// Exact accepted-source consistency, never a range or moving-version selector.
export function qualifyGoPins(goMod: string, assemblySource: string, compiler: string): string {
  const declarations = [...goMod.matchAll(/^go ([0-9]+\.[0-9]+\.[0-9]+)$/gm)];
  const guards = [...assemblySource.matchAll(/runtime\.Version\(\)\s*!=\s*"(go[0-9]+\.[0-9]+\.[0-9]+)"/g)];
  if (declarations.length !== 1 || guards.length !== 1) throw new Error('go-pin-shape');
  const pin = 'go' + declarations[0]![1];
  if (guards[0]![1] !== pin || compiler !== 'go version ' + pin + ' linux/amd64') {
    throw new Error('go-source-contract-conflict');
  }
  return pin;
}
