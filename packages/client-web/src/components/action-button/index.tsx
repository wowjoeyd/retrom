import { Button } from "@retrom/ui/components/button";
import { PlatformDependent } from "@/lib/env";
import { cn } from "@retrom/ui/lib/utils";
import { PlayGameButton } from "./play-game-button";
import { ComponentProps, ForwardedRef, forwardRef } from "react";
import { DownloadGameButton } from "./download-game-button";
import { Emulator_OperatingSystem } from "@retrom/codegen/retrom/models/emulators_pb";
import { Link } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { Game } from "@retrom/codegen/retrom/models/games_pb";
import { useDefaultEmulator } from "@/queries/useDefaultEmulator";

type ActionButtonProps = { game: Game } & ComponentProps<typeof Button>;

export const ActionButton = forwardRef(
  (props: ActionButtonProps, forwardedRef: ForwardedRef<HTMLButtonElement>) => {
    const { game, className, ...rest } = props;
    const { data: emulatorData } = useDefaultEmulator(game);

    const buttonClasses = cn(
      "rounded-none font-bold text-lg tracking-wider flex gap-2 items-center",
      className,
    );

    const { emulator } = emulatorData ?? {};
    const isPlayableInWeb =
      emulator?.libretroName &&
      emulator.operatingSystems.includes(Emulator_OperatingSystem.WASM);

    return (
      <PlatformDependent
        desktop={
          <PlayGameButton
            ref={forwardedRef}
            game={game}
            {...rest}
            className={cn(buttonClasses)}
            variant="accent"
          />
        }
        web={
          isPlayableInWeb ? (
            <Link to="/play/$gameId" params={{ gameId: game.id.toString() }}>
              <Button variant="accent" className={cn(buttonClasses)}>
                <PlayIcon className="h-[1.2rem] w-[1.2rem] fill-current" />
                Play
              </Button>
            </Link>
          ) : (
            <DownloadGameButton
              ref={forwardedRef}
              {...rest}
              className={cn(buttonClasses)}
              game={game}
            />
          )
        }
      />
    );
  },
);

ActionButton.displayName = "ActionButton";
