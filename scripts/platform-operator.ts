// Platform operators (V3.1 Admin, migration 026). Bootstrap/break-glass CLI: run on the server with the app database URL.
//   tsx --env-file=.env scripts/platform-operator.ts list
//   tsx --env-file=.env scripts/platform-operator.ts grant <email> [operator|support] [--via seed]
//   tsx --env-file=.env scripts/platform-operator.ts revoke <email>
// The user must have signed in once (a users row). Every change is written to platform_audit_events (actor 'cli').
import { closePool, getPool, maybeOne, withTx } from '@social-lite/db';

export async function grantOperatorCli(email: string, role: 'operator' | 'support', via: 'cli' | 'seed' = 'cli'): Promise<boolean> {
  const db = getPool();
  const u = await maybeOne<{ id: string }>(db, `SELECT id FROM users WHERE email=$1`, [email]);
  if (!u) return false;
  await withTx(async (tx) => {
    await tx.query(`INSERT INTO platform_operators(user_id, role, granted_via, note) VALUES ($1,$2,$3,$4)
                    ON CONFLICT (user_id) DO UPDATE SET role=EXCLUDED.role, granted_via=EXCLUDED.granted_via, granted_at=now(), revoked_at=NULL, revoked_by=NULL`,
      [u.id, role, via, via === 'seed' ? 'Development/E2E seed' : 'Granted from the server CLI']);
    await tx.query(`INSERT INTO platform_audit_events(actor_service, action, target_type, target_id, diff) VALUES ($1,'operator.granted','user',$2,$3)`,
      [via, u.id, JSON.stringify({ email, role })]);
  });
  return true;
}

async function main() {
  const [cmd, email, roleArg] = process.argv.slice(2);
  const db = getPool();
  if (cmd === 'list') {
    const r = await db.query(`SELECT u.email, o.role, o.granted_via, o.granted_at, o.revoked_at FROM platform_operators o JOIN users u ON u.id=o.user_id ORDER BY u.email`);
    console.table(r.rows);
  } else if (cmd === 'grant' && email) {
    const role = roleArg === 'support' ? 'support' : 'operator';
    const via = process.argv.includes('--via') && process.argv[process.argv.indexOf('--via') + 1] === 'seed' ? 'seed' : 'cli';
    if (!(await grantOperatorCli(email, role, via))) throw new Error(`No user ${email}: they must sign in once first`);
    console.log(JSON.stringify({ msg: 'platform operator granted', email, role }));
  } else if (cmd === 'revoke' && email) {
    await withTx(async (tx) => {
      const r = await tx.query<{ user_id: string }>(`UPDATE platform_operators o SET revoked_at=now() FROM users u WHERE u.id=o.user_id AND u.email=$1 AND o.revoked_at IS NULL RETURNING o.user_id`, [email]);
      if (!r.rowCount) throw new Error(`${email} is not an active operator`);
      await tx.query(`INSERT INTO platform_audit_events(actor_service, action, target_type, target_id, diff) VALUES ('cli','operator.revoked','user',$1,$2)`, [r.rows[0]!.user_id, JSON.stringify({ email })]);
    });
    console.log(JSON.stringify({ msg: 'platform operator revoked', email }));
  } else {
    console.log('usage: platform-operator.ts list | grant <email> [operator|support] | revoke <email>');
    process.exitCode = 2;
  }
}

if (process.argv[1]?.endsWith('platform-operator.ts')) {
  main().then(() => closePool()).catch(async (err) => { console.error(JSON.stringify({ level: 'error', msg: (err as Error).message })); await closePool(); process.exit(1); });
}
