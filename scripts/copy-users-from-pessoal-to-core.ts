import 'dotenv/config';
import { Pool } from 'pg';

async function main() {
  const srcConn = process.env.PESSOAL_DIRECT_URL;
  const dstConn = process.env.CORE_DB_URL ?? process.env.DATABASE_URL;

  if (!srcConn) throw new Error('PESSOAL_DIRECT_URL não configurada');
  if (!dstConn) throw new Error('CORE_DB_URL/DATABASE_URL não configurada');

  const src = new Pool({ connectionString: srcConn });
  const dst = new Pool({ connectionString: dstConn });

  try {
    const res = await src.query('SELECT id, email, "passwordHash", role, status, "forcePasswordChange", "createdAt", "updatedAt" FROM "User"');
    const users = res.rows;
    console.log(`Found ${users.length} users in PESSOAL`);

    if (users.length === 0) {
      console.log('No users to migrate. Exiting.');
      return;
    }

    let migrated = 0;

    for (const u of users) {
      const passwordHash = u.passwordHash ?? u.passwordhash ?? null;
      const forcePwd = typeof u.forcePasswordChange === 'boolean' ? u.forcePasswordChange : (u.forcepasswordchange ?? false);

      const query = `
        INSERT INTO "User" (id, email, "passwordHash", role, status, "forcePasswordChange", "createdAt", "updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (email) DO UPDATE SET
          "passwordHash" = EXCLUDED."passwordHash",
          role = EXCLUDED.role,
          status = EXCLUDED.status,
          "forcePasswordChange" = EXCLUDED."forcePasswordChange",
          "updatedAt" = EXCLUDED."updatedAt";
      `;

      const vals = [u.id, u.email, passwordHash, u.role, u.status, forcePwd, u.createdAt, u.updatedAt];
      await dst.query(query, vals);
      migrated++;
    }

    console.log(`Migrated ${migrated} users to CORE`);
  } catch (err) {
    console.error('Migration error:', err);
    process.exitCode = 2;
  } finally {
    await src.end();
    await dst.end();
  }
}

main();
