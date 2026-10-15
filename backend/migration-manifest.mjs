/* node migration-manifest.mjs < private-reviewed-snapshot.json
   Input is the complete [[KV key, parsed JSON value], ...] backup of all
   earn:, ref:, refcode:, refs: keys after legacy writers have stopped.
   Output contains only the migration acknowledgment, record count and hash. */
import { createHash } from 'node:crypto';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const records = JSON.parse(input);
if (!Array.isArray(records) || records.some(row => !Array.isArray(row) || row.length !== 2 ||
    typeof row[0] !== 'string' || !/^(earn|ref|refcode|refs):[^:]+$/.test(row[0])) ||
    new Set(records.map(row => row[0])).size !== records.length) throw Error('Invalid or duplicate snapshot keys');
records.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
console.log(JSON.stringify({ confirm: 'legacy writers stopped; snapshot reviewed', recordCount: records.length,
  snapshotSha256: createHash('sha256').update(JSON.stringify(records)).digest('hex') }));
