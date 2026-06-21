import { cn } from "@retrom/ui/lib/utils";
import { useActionBarContext } from "@/providers/fullscreen/action-bar-context";
import { HotkeyIcon } from "../hotkey-button";

export function ActionBar(props: JSX.IntrinsicElements["div"]) {
  const { children, className, ...rest } = props;
  const { hints } = useActionBarContext();

  return (
    <div
      className={cn(
        "bg-background border-t max-w-full overflow-hidden",
        "flex flex-col",
        className,
      )}
      {...rest}
    >
      {hints.length > 0 && (
        <div className="flex items-center justify-end gap-5 px-4 py-1.5 text-xs text-muted-foreground">
          {hints.map(({ hotkey, label }) => (
            <span key={hotkey} className="flex items-center gap-1.5 shrink-0">
              <HotkeyIcon hotkey={hotkey} />
              <span className="uppercase font-medium tracking-wide">
                {label}
              </span>
            </span>
          ))}
        </div>
      )}
      {children && (
        <div className="flex items-end justify-center overflow-hidden px-2 py-1">
          {children}
        </div>
      )}
    </div>
  );
}
