import process from 'node:process';
import { randomUUID } from 'node:crypto';

import { getPool, withTransaction } from '../src/db/pool.js';
import { decisionColumns } from '../src/modules/tickets/repo.js';
import { makeTicketRepo } from '../src/modules/tickets/repo.js';
import { makeConversationRepo } from '../src/modules/conversations/repo.js';
import { makeRefreshTokenRepo } from '../src/modules/refreshTokens/repo.js';
import { makeAdminUserRepo } from '../src/modules/adminUsers/repo.js';

const db = getPool();

let pass = 0;
let fail = 0;

async function check(label: string, fn: () => Promise<unknown> | unknown) {
  try {
    const value = await fn();
    pass += 1;
    process.stdout.write(`  PASS  ${label}${value === undefined ? '' : ` -> ${String(value)}`}\n`);
  } catch (err) {
    fail += 1;
    const m = err instanceof Error ? err.message : String(err);
    process.stdout.write(`  FAIL  ${label} -> ${m}\n`);
  }
}

async function expectRejection(label: string, fn: () => unknown) {
  try {
    await fn();
    fail += 1;
    process.stdout.write(`  FAIL  ${label} -> expected rejection, succeeded instead\n`);
  } catch {
    pass += 1;
    process.stdout.write(`  PASS  ${label} -> correctly rejected\n`);
  }
}

const reqId = randomUUID();
const reqId2 = randomUUID();
const unlinkedIds: number[] = [];
let convId = 0;
let userId = 0;

const conversations = makeConversationRepo(db);
const tickets = makeTicketRepo(db);
const tokens = makeRefreshTokenRepo(db);
const users = makeAdminUserRepo(db);

async function main() {
  process.stdout.write('\nPure logic: decisionColumns\n');
  await check('slack decision -> decided_by null, slack id set', () => {
    const r = decisionColumns({ channel: 'slack', slackUserId: 'U123' });
    if (r.decided_by !== null) throw new Error('decided_by should be null');
    if (r.decided_by_slack !== 'U123') throw new Error('slack id missing');
    return JSON.stringify(r);
  });
  await check('dashboard decision -> decided_by set, slack null', () => {
    const r = decisionColumns({ channel: 'dashboard', adminUserId: 7 });
    if (r.decided_by !== 7) throw new Error('decided_by should be 7');
    if (r.decided_by_slack !== null) throw new Error('slack should be null');
    return JSON.stringify(r);
  });
  await expectRejection('slack decision without slackUserId rejected', () => {
    const r = decisionColumns({ channel: 'slack', slackUserId: '' });
    if (r.decided_by === undefined) throw new Error('unreachable');
    return r;
  });

  process.stdout.write('\nDatabase constraint enforcement\n');
  await check('seed conversation', async () => {
    const row = await conversations.insert({
      question: 'verify: constraint tests',
      answer: 'n/a',
      confidence: 'low',
      requestId: reqId,
    });
    convId = row.id;
    return `id=${row.id}`;
  });

  await expectRejection('conversations.request_id NOT NULL enforced', () =>
    db.query("INSERT INTO conversations (question, answer, confidence) VALUES ('a','b','low')"),
  );
  await expectRejection('conversations.confidence CHECK enforced', () =>
    db.query(
      "INSERT INTO conversations (question, answer, confidence, request_id) VALUES ('a','b','bogus', gen_random_uuid())",
    ),
  );
  await expectRejection('tickets.status CHECK rejects unknown status', () =>
    db.query(
      "INSERT INTO escalation_tickets (status, request_id) VALUES ('nonsense', gen_random_uuid())",
    ),
  );
  await expectRejection('tickets.decision_channel CHECK enforced', () =>
    db.query(
      "INSERT INTO escalation_tickets (status, decision_channel, request_id) VALUES ('pending','carrier_pigeon', gen_random_uuid())",
    ),
  );
  await expectRejection('tickets.decided_by FK rejects nonexistent admin', () =>
    db.query(
      "INSERT INTO escalation_tickets (status, decided_by, request_id) VALUES ('approved', 999999, gen_random_uuid())",
    ),
  );

  process.stdout.write('\nTicket lifecycle\n');
  await check('all 7 statuses accepted by CHECK', async () => {
    const statuses = ['open','pending','approved','rejected','timed_out','in_progress','resolved'];
    for (const s of statuses) {
      const r = await db.query(
        'INSERT INTO escalation_tickets (status, request_id) VALUES ($1, gen_random_uuid()) RETURNING id',
        [s],
      );
      unlinkedIds.push(r.rows[0].id as number);
    }
    return `${statuses.length} statuses accepted`;
  });

  await check('approved -> in_progress -> resolved triage chain', async () => {
    const t = await tickets.createPending({ conversationId: convId, requestId: reqId });
    const a = await tickets.decide({ id: t.id, status: 'approved', decision: { channel: 'slack', slackUserId: 'U999' } });
    if (a?.status !== 'approved') throw new Error('approve failed');
    const p = await tickets.triage({ id: t.id, status: 'in_progress', assignedTo: 'agent@example.com' });
    if (p?.status !== 'in_progress') throw new Error('triage to in_progress failed');
    if (p.assigned_to !== 'agent@example.com') throw new Error('assignee not stored');
    return 'approved -> in_progress';
  });

  await check('in_progress -> resolved', async () => {
    const t = await tickets.createPending({ conversationId: convId, requestId: reqId });
    await tickets.decide({ id: t.id, status: 'approved', decision: { channel: 'slack', slackUserId: 'U999' } });
    await tickets.triage({ id: t.id, status: 'in_progress' });
    const d = await tickets.triage({ id: t.id, status: 'resolved' });
    if (d === null) throw new Error('triage returned null for in_progress -> resolved');
    if (d.status !== 'resolved') throw new Error(`expected resolved, got ${d.status}`);
    if (d.resolved_at === null) throw new Error('resolved_at not set');
    return 'resolved_at set';
  });

  await check('triage refuses to reopen a rejected ticket', async () => {
    const t = await tickets.createPending({ conversationId: convId, requestId: reqId });
    await tickets.decide({ id: t.id, status: 'rejected', decision: { channel: 'slack', slackUserId: 'U999' } });
    const again = await tickets.triage({ id: t.id, status: 'in_progress' });
    if (again !== null) throw new Error('rejected ticket was re-triaged');
    return 'correctly refused';
  });

  await check('triage refuses to reopen a timed_out ticket', async () => {
    const t = await tickets.createPending({ conversationId: convId, requestId: reqId });
    await tickets.markStalePendingTimedOut(0);
    const again = await tickets.triage({ id: t.id, status: 'in_progress' });
    if (again !== null) throw new Error('timed_out ticket was re-triaged');
    return 'correctly refused';
  });

  await check('triage refuses to reopen a decided ticket', async () => {
    const t = await tickets.createPending({ conversationId: convId, requestId: reqId2 });
    await tickets.decide({ id: t.id, status: 'rejected', decision: { channel: 'slack', slackUserId: 'U999' } });
    const again = await tickets.triage({ id: t.id, status: 'in_progress' });
    if (again !== null) throw new Error('rejected ticket was re-triaged');
    return 'correctly refused';
  });

  await check('rejected sets resolved_at', async () => {
    const t = await tickets.createPending({ conversationId: convId, requestId: reqId });
    const r = await tickets.decide({ id: t.id, status: 'rejected', decision: { channel: 'slack', slackUserId: 'U999' } });
    if (r?.resolved_at === null) throw new Error('resolved_at should be set on reject');
    return 'set';
  });

  process.stdout.write('\nSweeper\n');
  await check('markStalePendingTimedOut only reaps stale pendings', async () => {
    const stale = await tickets.createPending({ conversationId: convId, requestId: reqId });
    await db.query(
      "UPDATE escalation_tickets SET created_at = NOW() - interval '60 minutes' WHERE id = $1",
      [stale.id],
    );
    const fresh = await tickets.createPending({ conversationId: convId, requestId: reqId });

    const reaped = await tickets.markStalePendingTimedOut(45);
    if (!reaped.some((t) => t.id === stale.id)) throw new Error('stale ticket not reaped');
    if (reaped.some((t) => t.id === fresh.id)) throw new Error('fresh ticket was wrongly reaped');

    const after = await tickets.findById(stale.id);
    if (after?.status !== 'timed_out') throw new Error(`expected timed_out, got ${after?.status}`);
    return `${reaped.length} reaped, fresh preserved`;
  });

  process.stdout.write('\nRefresh token families\n');
  await check('seed admin user', async () => {
    const u = await users.create({ email: `verify-${Date.now()}@example.com`, passwordHash: 'x', role: 'admin' });
    userId = u.id;
    return `id=${u.id}`;
  });

  await check('reuse detection revokes the whole family', async () => {
    const family = randomUUID();
    const first = await tokens.create({ userId, familyId: family, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 864e5) });
    await tokens.markRotated(first.id);
    await tokens.create({ userId, familyId: family, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 864e5) });

    const n = await tokens.revokeFamily(family, 'reuse');
    if (n !== 2) throw new Error(`expected 2 tokens revoked, got ${n}`);

    const live = await db.query(
      'SELECT COUNT(*) FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL',
      [family],
    );
    if (Number(live.rows[0]?.count) !== 0) throw new Error('family still has live tokens');
    return `${n} revoked on reuse`;
  });

  await check('revokeFamily does not touch other families', async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    await tokens.create({ userId, familyId: mine, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 864e5) });
    await tokens.create({ userId, familyId: theirs, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 864e5) });
    await tokens.revokeFamily(mine, 'logout');

    const survivors = await db.query(
      'SELECT COUNT(*) FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL',
      [theirs],
    );
    if (Number(survivors.rows[0]?.count) !== 1) throw new Error('unrelated family was affected');
    return 'isolated';
  });

  await check('token_hash is unique', async () => {
    const hash = randomUUID();
    const family = randomUUID();
    await tokens.create({ userId, familyId: family, tokenHash: hash, expiresAt: new Date(Date.now() + 864e5) });
    await expectRejection('duplicate token_hash rejected', () =>
      tokens.create({ userId, familyId: randomUUID(), tokenHash: hash, expiresAt: new Date(Date.now() + 864e5) }),
    );
  });

  process.stdout.write('\nAudit trail\n');
  await check('audit + ticket change commit atomically', async () => {
    const t = await tickets.createPending({ conversationId: convId, requestId: reqId });
    await withTransaction(async (tx) => {
      const { makeAuditLogRepo } = await import('../src/modules/auditLog/repo.js');
      const audit = makeAuditLogRepo(tx);
      const repo = makeTicketRepo(tx);
      await repo.triage({ id: t.id, status: 'in_progress', assignedTo: 'a@b.c' });
      await audit.record({
        actorId: userId,
        action: 'ticket.triage',
        entity: 'escalation_ticket',
        entityId: t.id,
        change: { before: { status: 'pending' }, after: { status: 'in_progress' } },
      });
    });
    return 'committed together';
  });

  await check('audit FK rejects unknown actor', async () => {
    await expectRejection('actor_id FK enforced', () =>
      db.query(
        "INSERT INTO audit_log (actor_id, action, entity) VALUES (999999, 'x.y', 'escalation_ticket')",
      ),
    );
  });

  process.stdout.write('\nPagination\n');
  await check('beforeId cursor returns strictly older rows', async () => {
    const page1 = await conversations.list({ limit: 3 });
    if (page1.length === 0) throw new Error('no rows to page');
    const cursor = page1[page1.length - 1]!.id;
    const page2 = await conversations.list({ limit: 3, beforeId: cursor });
    if (page2.some((r) => r.id >= cursor)) throw new Error('cursor leaked newer rows');
    return `page1 max id=${cursor}, page2 ids below it`;
  });

  await check('limit is capped at 200', async () => {
    const r = await db.query(
      'SELECT COUNT(*) FROM (SELECT id FROM conversations ORDER BY id DESC LIMIT $1) t',
      [5000],
    );
    if (Number(r.rows[0]?.count) > 200) throw new Error('cap not applied');
    return 'capped';
  });

  process.stdout.write('\ncleanup\n');
  await check('remove all verification rows', async () => {
    await db.query("DELETE FROM audit_log WHERE entity = 'escalation_ticket' AND actor_id = $1", [userId]);
    await db.query("DELETE FROM audit_log WHERE action LIKE 'verify.%'");
    await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM admin_users WHERE id = $1', [userId]);
    await db.query("DELETE FROM escalation_tickets WHERE notes IS NULL AND conversation_id = $1", [convId]);
    if (unlinkedIds.length > 0) {
      await db.query('DELETE FROM escalation_tickets WHERE id = ANY($1::int[])', [unlinkedIds]);
    }
    await db.query('DELETE FROM conversations WHERE id = $1', [convId]);
    return 'done';
  });

  await check('confirm residue is zero', async () => {
    const q = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM conversations WHERE id = $1) AS conv,
         (SELECT COUNT(*) FROM admin_users WHERE id = $2) AS usr,
         (SELECT COUNT(*) FROM audit_log WHERE actor_id = $2) AS aud`,
      [convId, userId],
    );
    const r = q.rows[0] as { conv: string; usr: string; aud: string };
    const orphan = await db.query(
      'SELECT COUNT(*) FROM escalation_tickets WHERE id = ANY($1::int[])',
      [unlinkedIds],
    );
    if (
      Number(r.conv) !== 0 ||
      Number(r.usr) !== 0 ||
      Number(r.aud) !== 0 ||
      Number(orphan.rows[0]?.count ?? 0) !== 0
    ) {
      throw new Error(`residue: ${JSON.stringify(r)}`);
    }
    return 'clean';
  });

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    process.stderr.write(`crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.end());