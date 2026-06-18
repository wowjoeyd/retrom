import {
  QueryCache,
  QueryClient,
  QueryClientProvider as QueryClientProviderImpl,
} from "@tanstack/react-query";
import { PropsWithChildren, useState } from "react";
import { ConnectError, Code } from "@connectrpc/connect";
import { toast } from "@retrom/ui/hooks/use-toast";
import { configStore } from "../config";

export function QueryClientProvider(props: PropsWithChildren) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 1000 * 60,
            // Desktop app: don't refetch everything every time the window regains
            // focus. Besides being wasteful, it caused churn when returning from a
            // launched game (the window focus toggles, especially with our
            // minimize-on-launch), which transiently emptied game metadata like the
            // theme audio. Data still refreshes via explicit invalidation
            // (mutations, scans, downloads) and on remount past staleTime.
            refetchOnWindowFocus: false,
            throwOnError: false,
            queryKeyHashFn: (key) =>
              JSON.stringify(key, (_: unknown, v: unknown) =>
                typeof v === "bigint" ? v.toString() : v,
              ),
          },
        },
        queryCache: new QueryCache({
          onError: (error) => {
            if (error instanceof ConnectError) {
              const server = configStore.getState().server;

              if (server === undefined) {
                return;
              }

              const description = (
                <span className="text-wrap break-all">{error.message}</span>
              );

              switch (error.code) {
                case Code.Unauthenticated: {
                  toast({
                    id: error.message,
                    variant: "destructive",
                    title: "Unauthenticated",
                    description,
                  });

                  break;
                }

                case Code.Internal: {
                  toast({
                    id: error.message,
                    variant: "destructive",
                    title: "Internal server error",
                    description,
                  });

                  break;
                }

                default: {
                  break;
                }
              }
            }

            console.error(error);
          },
        }),
      }),
  );

  return (
    <QueryClientProviderImpl client={queryClient}>
      {props.children}
    </QueryClientProviderImpl>
  );
}
