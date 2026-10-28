import { PrismaClient } from './src/index.js';
const prisma = new PrismaClient();
async function main() {
  const messages = await prisma.message.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5
  });
  console.log(JSON.stringify(messages, null, 2));
}
main().finally(() => prisma.$disconnect());
