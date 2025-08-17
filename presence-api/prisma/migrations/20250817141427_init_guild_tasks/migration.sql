-- CreateTable
CREATE TABLE "public"."GuildTask" (
    "id" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT,
    "title" TEXT NOT NULL,
    "notes" TEXT,
    "dueAt" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 2,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "done" BOOLEAN NOT NULL DEFAULT false,
    "completedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuildTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuildTask_guildId_done_dueAt_idx" ON "public"."GuildTask"("guildId", "done", "dueAt");

-- CreateIndex
CREATE INDEX "GuildTask_channelId_messageId_idx" ON "public"."GuildTask"("channelId", "messageId");
