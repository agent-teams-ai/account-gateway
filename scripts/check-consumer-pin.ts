import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const fail = (code: string): never => { throw new Error(`cms.pin.${code}`); };
const approved = {
  commit: 'b70ba39304ac71964175c42a77309406a7c30ca2',
  sha256: '11a389b223506dc303fa986a7a37350b847013d85beb2de9d74cb8c97363e824',
  gitBlob: 'bf6c64f5057c18cb3439c6b0e1a97b60428b0c53',
};
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('invalid-record');
  return value as Record<string, unknown>;
}
async function json(path: string): Promise<Record<string, unknown>> {
  return record(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

// Offline integrity of reviewed evidence only; this does not certify CMS adoption.
export async function checkConsumerPin(root: string): Promise<void> {
  const profile = await json(resolve(root, 'architecture/consumer-module-adoption.json'));
  if (profile.status !== 'pending') fail('adoption-pending');
  const pin = record(profile.standard);
  const review = await json(resolve(root, 'architecture/evidence/cms-pin-review.json'));
  const reviewed = record(review.standard);
  for (const key of ['repository', 'path', 'anchor', 'commit', 'sha256', 'gitBlob']) {
    if (typeof pin[key] !== 'string' || pin[key] !== reviewed[key]) fail('review-mismatch');
  }
  for (const [key, value] of Object.entries(approved)) {
    if (pin[key] !== value) fail('unreviewed-identity');
  }
  if (pin.repository !== 'agent-teams-ai/get-modular' ||
      pin.path !== 'docs/architecture/common-assembly.md' || pin.anchor !== 'consumer-module-standard' ||
      !/^[a-f0-9]{40}$/.test(String(pin.commit)) || !/^[a-f0-9]{64}$/.test(String(pin.sha256)) ||
      !/^[a-f0-9]{40}$/.test(String(pin.gitBlob))) fail('invalid-identity');
  const bytes = await readFile(resolve(root, 'architecture/evidence/common-assembly.md'));
  if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) fail('document-drift');
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (blob !== pin.gitBlob) fail('blob-drift');
}
