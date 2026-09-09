-- Additive: historical amounts and the legacy EGP column stay intact.
ALTER TABLE "Package" ADD COLUMN "catalogKey" TEXT;
ALTER TABLE "Package" ADD COLUMN "pricingOverrides" JSONB;
CREATE UNIQUE INDEX "Package_catalogKey_key" ON "Package"("catalogKey");
ALTER TABLE "Order" ADD COLUMN "pricingSnapshot" JSONB;
