import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Genesis state, exactly per spec: the cap is 1,000,000 YC, but NOTHING
  // starts circulating. Reserve, circulating supply, and all balances start
  // at zero. lastKnownValue stays null until the system has circulated and
  // drained back to zero at least once.
  await prisma.coinSupply.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      maxSupplyCap: '1000000',
      circulatingSupply: '0',
      availablePool: '1000000',
      destroyedTotal: '0',
      reserveAmount: '0',
      genesisPrice: '0.01',
      lastKnownValue: null,
    },
    update: {},
  });

  console.log('Genesis economic state seeded: cap=1,000,000, circulating=0, available=1,000,000, reserve=$0.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
