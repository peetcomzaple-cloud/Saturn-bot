CREATE TABLE "model_image_capabilities" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "endpointKey" TEXT NOT NULL DEFAULT '',
  "capability" TEXT NOT NULL CHECK ("capability" IN ('vision', 'text', 'orphan')),
  "evidence" TEXT NOT NULL,
  "nextProbeAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "probeLeaseUntil" TIMESTAMP(3),
  "probeLeaseToken" TEXT,
  "probeFailures" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "provider", "modelId", "endpointKey")
);
ALTER TABLE "runs" ADD COLUMN "actualModelProvider" TEXT, ADD COLUMN "actualModelId" TEXT;
ALTER TABLE "runs" ADD COLUMN "autoModelSwitches" INTEGER NOT NULL DEFAULT 0;
