import { createDb } from './src/client.js';

async function main() {
  const connectionString = process.env.DATABASE_URL || "postgres://rakazo@127.0.0.1:5432/rakazo";
  const { prisma, pool } = createDb(connectionString);
  
  const routine = await prisma.routine.findFirst({ where: { name: "morning-check" } });
  if (routine) {
    const now = new Date();
    await prisma.routine.update({
      where: { id: routine.id },
      data: { nextRunAt: now }
    });
    
    await prisma.$executeRawUnsafe(`
      SELECT graphile_worker.add_job('routine.wakeup', $1::json, job_key := $2);
    `, JSON.stringify({ routineId: routine.id, scheduledFor: now.toISOString() }), `routine:${routine.id}:${now.getTime()}`);
    console.log("Routine triggered immediately");
  }
  
  await pool.end();
}

main().catch(console.error).finally(() => process.exit(0));
