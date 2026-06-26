import { Button } from "@retrom/ui/components/button";
import { toast } from "@retrom/ui/hooks/use-toast";
import { useGameDetail } from "@/providers/game-details";
import { checkIsDesktop } from "@/lib/env";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

// Phase 4: a single minimal "Start Streaming" action. It creates a remote-play
// session and launches Moonlight into the host's "Retrom Remote Play" app via the
// remote-play plugin. No lifecycle UI yet (that's Phase 6).
export function StartStreamingButton() {
  const { game } = useGameDetail();
  const [pending, setPending] = useState(false);

  // Streaming goes through a Tauri command, so it only applies to the desktop
  // client.
  if (!checkIsDesktop()) {
    return null;
  }

  const onClick = async () => {
    setPending(true);
    try {
      // Resolves when streaming ends (Moonlight exits).
      await invoke("plugin:remote-play|start_remote_play", { gameId: game.id });
    } catch (error) {
      toast({
        title: "Remote Play failed",
        description:
          typeof error === "string" ? error : "Could not start streaming.",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Button variant="secondary" size="lg" disabled={pending} onClick={onClick}>
      {pending ? "Streaming…" : "Start Streaming"}
    </Button>
  );
}
