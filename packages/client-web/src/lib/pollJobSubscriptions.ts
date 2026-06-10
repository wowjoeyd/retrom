import { JobStatus } from "@retrom/codegen/retrom/jobs_pb";
import { GetJobSubscriptionResponse } from "@retrom/codegen/retrom/services/job-service_pb";
import { RetromClient } from "@/providers/retrom-client/client";

export async function pollJobSubscriptions(
  retromClient: RetromClient,
  jobIds: string[],
  onComplete?: (jobName: string) => void,
) {
  const subscriptions = jobIds.map((jobId) =>
    retromClient.jobClient.getJobSubscription({ jobId }),
  );

  await Promise.all(
    subscriptions.map(async (subscription) => {
      for await (const progress of subscription) {
        if (progress.job?.status === JobStatus.Success) {
          onComplete?.(progress.job.name);
        }
      }
    }),
  );
}