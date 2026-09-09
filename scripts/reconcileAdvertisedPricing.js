// One-time migration of the advertised offers into the database catalog.
// Default is read-only. --apply backs up the matching rows and updates atomically.
import "dotenv/config";
import fs from "node:fs/promises";
import { PrismaClient, Prisma } from "@prisma/client";
const prisma = new PrismaClient();
const offers = [
  ["1on1-4", "Starter", 800, 1100],
  ["1on1-12", "Professional", 2200, 2940],
  ["1on1-24", "Intensive", 3800, 5040],
  ["1on1-48", "Master", 6800, 8880],
  ["group-4", "Group Starter", 600, 800],
  ["group-12", "Group Professional", 1600, 2100],
  ["group-24", "Group Intensive", 2800, 3720],
  ["group-48", "Group Master", 5000, 6480],
];
try {
  const rows = await prisma.package.findMany({where: {deletedAt: null}});
  const changes = offers.map(([catalogKey, title, oldPrice, priceEGP]) => {
    const matches = rows.filter(p => p.catalogKey === catalogKey || p.title.toLowerCase() === title.toLowerCase());
    if (matches.length !== 1) throw new Error(`Expected exactly one package: ${title}`);
    const row = matches[0];
    if (![oldPrice, priceEGP].includes(row.priceUSD) || (row.catalogKey && row.catalogKey !== catalogKey)) {
      throw new Error(`Unexpected existing price/key for ${title}; review before applying.`);
    }
    return {row, catalogKey, priceEGP, pricingOverrides: null};
  });
  console.table(changes.map(c => ({id: c.row.id, title: c.row.title, before: c.row.priceUSD, after: c.priceEGP, catalogKey: c.catalogKey})));
  if (process.argv.includes("--apply")) {
    const backup = new URL(`../../output/website-review/package-prices-before-${Date.now()}.json`, import.meta.url);
    await fs.writeFile(backup, JSON.stringify(changes.map(c => c.row), null, 2), {flag: "wx"});
    await prisma.$transaction(async tx => {
      for (const c of changes) {
        const result = await tx.package.updateMany({
          where: {id: c.row.id, updatedAt: c.row.updatedAt, priceUSD: c.row.priceUSD},
          data: {catalogKey: c.catalogKey, priceUSD: c.priceEGP, pricingOverrides: c.pricingOverrides || Prisma.DbNull},
        });
        if (result.count !== 1) throw new Error(`Concurrent edit for ${c.row.title}; transaction rolled back.`);
      }
    });
    console.log("Reconciled eight offers. Historical orders and session entitlements were not modified.");
    console.log(`Backup: ${backup.pathname}`);
  } else console.log("Read-only preview. Use --apply to reconcile these offers.");
} finally {await prisma.$disconnect();}
