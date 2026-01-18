-- CreateTable
CREATE TABLE "MarketCurrencyRule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketCurrencyRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketCurrencyRule_shopId_idx" ON "MarketCurrencyRule"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketCurrencyRule_shopId_countryCode_key" ON "MarketCurrencyRule"("shopId", "countryCode");

-- AddForeignKey
ALTER TABLE "MarketCurrencyRule" ADD CONSTRAINT "MarketCurrencyRule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
