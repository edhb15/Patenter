-- Plans with a daily credit allowance. Existing accounts start on Free.
CREATE TYPE "Plan" AS ENUM ('FREE', 'PRO', 'MAX');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "creditsDay" DATE,
ADD COLUMN     "creditsUsed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "plan" "Plan" NOT NULL DEFAULT 'FREE';
