-- CreateEnum
CREATE TYPE "public"."Audience" AS ENUM ('INDIVIDUAL', 'CORPORATE');

-- CreateEnum
CREATE TYPE "public"."PriceType" AS ENUM ('PER_SESSION', 'BUNDLE', 'CUSTOM');

-- AlterTable
ALTER TABLE "public"."Package" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "audience" "public"."Audience" NOT NULL DEFAULT 'INDIVIDUAL',
ADD COLUMN     "durationMin" INTEGER,
ADD COLUMN     "image" TEXT,
ADD COLUMN     "isPopular" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "priceType" "public"."PriceType" NOT NULL DEFAULT 'BUNDLE',
ADD COLUMN     "sessionsPerPack" INTEGER,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "startingAtUSD" INTEGER,
ALTER COLUMN "priceUSD" DROP NOT NULL;
