import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@retrom/ui/components/dialog";
import { Button } from "@retrom/ui/components/button";
import { LoaderCircleIcon } from "lucide-react";
import { cn } from "@retrom/ui/lib/utils";
import { useUpdateLibrary } from "@/mutations/useUpdateLibrary";
import { useNavigate } from "@tanstack/react-router";
import { Route as RootRoute } from "@/routes/__root";
import { useCallback } from "react";

export function UpdateLibraryModal() {
  const navigate = useNavigate();
  const { updateLibraryModal } = RootRoute.useSearch();

  const { mutateAsync: updateLibrary, isPending } = useUpdateLibrary();

  const close = useCallback(
    () =>
      navigate({
        to: ".",
        search: { updateLibraryModal: undefined },
      }),
    [navigate],
  );

  return (
    <Dialog
      open={updateLibraryModal?.open}
      onOpenChange={(open) => {
        if (!open) {
          void close();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Library</DialogTitle>
          <DialogDescription className="max-w-[65ch]">
            Scans for new platforms and games from your library folders.
            Automatically downloads names, artwork and metadata for new entries
            via IGDB (using ROM filenames and platform folders for matching).
            Requires IGDB config in Server Settings; existing metadata is left
            alone.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>

          <Button
            className="relative"
            onClick={() => {
              updateLibrary()
                .then(() => void close())
                .catch(console.error);
            }}
          >
            <LoaderCircleIcon
              className={cn("animate-spin absolute", !isPending && "opacity-0")}
            />
            <p className={cn(isPending && "opacity-0")}>Update</p>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
