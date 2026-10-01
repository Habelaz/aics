import process from 'node:process';

import { getPool } from '../src/db/pool.js';
import { makeAdminUserRepo } from '../src/modules/adminUsers/repo.js';
import { makeConversationRepo } from '../src/modules/conversations/repo.js';
import { makeTicketRepo } from '../src/modules/tickets/repo.js';
import { makeApiRequestRepo } from '../src/modules/apiRequests/repo.js';
import { makeAuditLogRepo } from '../src/modules/auditLog/repo.js';
import { makeHealthRepo } from '../src/modules/health/repo.js';
import { randomUUID } from 'node:crypto';

const db = getPool();

async function main() {
  const failures: string[] = [];

  async function check(label: string, fn: () => Promise<unknown>) {
    try {
      const value = await fn();
      process.stdout.write(`  PASS  ${label}${value === undefined ? '' : ` -> ${String(value)}`}\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${label}: ${message}`);
      process.stdout.write(`  FAIL  ${label} -> ${message}\n`);
    }
  }

  const conversations = makeConversationRepo(db);
  const tickets = makeTicketRepo(db);
  const requests = makeApiRequestRepo(db);
  const users = makeAdminUserRepo(db);
  const audit = makeAuditLogRepo(db);
  const health = makeHealthRepo();

  process.stdout.write('\nreads\n');
  await check('conversations.count', () => conversations.count());
  await check('conversations.countByConfidence', async () =>
    JSON.stringify(await conversations.countByConfidence()),
  );
  await check('conversations.list(confidence=low)', async () =>
    `${(await conversations.list({ confidence: 'low', limit: 3 })).length} rows`,
  );
  await check('tickets.countByStatus', async () =>
    JSON.stringify(await tickets.countByStatus()),
  );
  await check('tickets.countPending', () => tickets.countPending());
  await check('api_requests.countByState', async () =>
    JSON.stringify(await requests.countByState()),
  );
  await check('admin_users.listActive', async () => `${(await users.listActive()).length} users`);
  await check('health.n8nExecutionCounts', async () =>
    JSON.stringify(await health.n8nExecutionCounts()),
  );

  process.stdout.write('\nwrite path (temporary rows, cleaned up)\n');
  const requestId = randomUUID();
  const conversationId = randomUUID();

  let conversationIdNum = 0;
  let ticketId = 0;

  await check('conversations.insert', async () => {
    const row = await conversations.insert({
      question: 'smoke: does the ticket lifecycle work?',
      answer: 'smoke answer',
      confidence: 'low',
      requestId,
      sources: [{ title: 'smoke' }],
      latencyMs: 1234,
    });
    conversationIdNum = row.id;
    return `id=${row.id}`;
  });

  await check('conversations.findByRequestId', async () => {
    const row = await conversations.findByRequestId(requestId);
    if (!row) throw new Error('not found');
    return `id=${row.id}`;
  });

  await check('tickets.createPending', async () => {
    const row = await tickets.createPending({
      conversationId: conversationIdNum,
      requestId,
      notes: 'smoke',
    });
    ticketId = row.id;
    return `id=${row.id} status=${row.status}`;
  });

  await check('tickets.decide(approved via slack)', async () => {
    const row = await tickets.decide({
      id: ticketId,
      status: 'approved',
      decision: { channel: 'slack', slackUserId: 'U0C3D71BJJU' },
    });
    if (!row) throw new Error('decide returned no row');
    if (row.decided_by !== null) throw new Error('slack decision must not set decided_by');
    if (row.decided_by_slack !== 'U0C3D71BJJU') throw new Error('decided_by_slack not recorded');
    return `status=${row.status} slack=${row.decided_by_slack}`;
  });

  await check('tickets.decide() refuses a second decision', async () => {
    const row = await tickets.decide({
      id: ticketId,
      status: 'rejected',
      decision: { channel: 'slack', slackUserId: 'U0C3D71BJJU' },
    });
    if (row !== null) throw new Error('expected null: already-decided ticket was re-decided');
    return 'correctly refused';
  });

  await check('api_requests lifecycle', async () => {
    await requests.create({ requestId: conversationId, question: 'smoke question' });
    await requests.updateState({ requestId: conversationId, state: 'escalated' });
    const row = await requests.findById(conversationId);
    if (row?.state !== 'escalated') throw new Error(`expected escalated, got ${row?.state}`);
    await requests.updateState({
      requestId: conversationId,
      state: 'failed',
      upstreamError: 'smoke: simulated upstream failure',
    });
    const failed = await requests.findById(conversationId);
    if (failed?.state !== 'failed') throw new Error('expected failed');
    return 'accepted -> escalated -> failed';
  });

  await check('audit_log.record + listByEntity', async () => {
    await audit.record({
      actorId: null,
      action: 'smoke.decide',
      entity: 'escalation_ticket',
      entityId: ticketId,
      change: { before: { status: 'pending' }, after: { status: 'approved' } },
    });
    const entries = await audit.listByEntity('escalation_ticket', ticketId);
    if (entries.length === 0) throw new Error('no audit entry found');
    return `${entries.length} entry`;
  });

  process.stdout.write('\nhealth snapshot\n');
  await check('health.snapshot', async () => JSON.stringify(await health.snapshot()));

  process.stdout.write('\ncleanup\n');
  await check('remove smoke rows', async () => {
    await db.query('DELETE FROM api_requests WHERE request_id = $1', [conversationId]);
    await db.query('DELETE FROM escalation_tickets WHERE request_id = $1', [requestId]);
    await db.query('DELETE FROM conversations WHERE request_id = $1', [requestId]);
    await db.query("DELETE FROM audit_log WHERE action = 'smoke.decide'");
    return 'done';
  });

  await check('verify no residue', async () => {
    const c = await conversations.findByRequestId(requestId);
    if (c) throw new Error('smoke conversation survived cleanup');
    const t = await tickets.findByRequestId(requestId);
    if (t.length > 0) throw new Error('smoke ticket survived cleanup');
    return 'clean';
  });

  process.stdout.write('\n');
  if (failures.length > 0) {
    process.stderr.write(`${failures.length} check(s) failed\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('all checks passed\n');
  }
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`smoke run crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.end());