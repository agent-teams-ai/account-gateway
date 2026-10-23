import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Regression: a pin or retained document changes without its reviewed migration,
// or pending qualification is silently promoted to a CMS conformance claim.
test('consumer pin rejects unreviewed identities, retained-byte drift and adoption promotion', async () => {
  await mkdir('.cache/consumer-pin-tests', { recursive: true });
  const root = await mkdtemp(resolve('.cache/consumer-pin-tests/run-'));
  try {
    await cp('architecture', root + '/architecture', { recursive: true });
    await cp('packages/account-gateway/src', root + '/packages/account-gateway/src', { recursive: true });
    const profilePath = root + '/architecture/consumer-module-adoption.json';
    const original = await readFile(profilePath, 'utf8');
    const check = () => spawnSync(process.execPath, ['scripts/check-topology.mjs', root], { encoding: 'utf8' });
    assert.equal(check().status, 0);
    for (const [before, after, code] of [
      ['b70ba39304ac71964175c42a77309406a7c30ca2', '0'.repeat(40), 'review-mismatch'],
      ['11a389b223506dc303fa986a7a37350b847013d85beb2de9d74cb8c97363e824', '0'.repeat(64), 'review-mismatch'],
      ['"pending"', '"adopted"', 'adoption-pending'],
    ]) {
      assert.ok(original.includes(before));
      await writeFile(profilePath, original.replace(before, after));
      const rejected = check();
      assert.equal(rejected.status, 1);
      assert.ok(rejected.stderr.includes('cms.pin.' + code), rejected.stderr);
    }
    await writeFile(profilePath, original);
    await writeFile(root + '/architecture/evidence/common-assembly.md', 'unreviewed bytes\n');
    const drift = check();
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /cms\.pin\.document-drift/);
    const replacement = Buffer.from('coordinated unreviewed document\n');
    const identities = {
      commit: '1'.repeat(40),
      sha256: createHash('sha256').update(replacement).digest('hex'),
      gitBlob: createHash('sha1').update(`blob ${replacement.length}\0`).update(replacement).digest('hex'),
    };
    const reviewPath = root + '/architecture/evidence/cms-pin-review.json';
    const profile = JSON.parse(original) as { standard: Record<string, string> };
    const review = JSON.parse(await readFile(reviewPath, 'utf8')) as typeof profile;
    Object.assign(profile.standard, identities);
    Object.assign(review.standard, identities);
    await writeFile(profilePath, JSON.stringify(profile));
    await writeFile(reviewPath, JSON.stringify(review));
    await writeFile(root + '/architecture/evidence/common-assembly.md', replacement);
    const coordinated = check();
    assert.equal(coordinated.status, 1, coordinated.stdout + coordinated.stderr);
    assert.match(coordinated.stderr, /cms\.pin\.unreviewed-identity/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
