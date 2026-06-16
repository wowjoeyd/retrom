import { Button, ButtonProps } from "@retrom/ui/components/button";
import { cn } from "@retrom/ui/lib/utils";
import { HotkeyLayer, HotkeyLayerProps } from "@/providers/hotkeys/layers";
import { useFocusable, UseFocusableConfig } from "../focus-container";
import { forwardRef, ReactNode, useId, useImperativeHandle } from "react";

type Props = Omit<ButtonProps, "size"> &
  Partial<Pick<HotkeyLayerProps, "allowBubbling" | "handlers">> & {
    /** Secondary description line rendered beneath the title. */
    label?: ReactNode;
    /** Leading icon, shown in an accent chip. */
    icon?: ReactNode;
    /** Optional trailing slot (e.g. a chevron or status). */
    trailing?: ReactNode;
    /** Style as a destructive action (red accent on focus). */
    destructive?: boolean;
    focusOpts?: UseFocusableConfig<HTMLButtonElement>;
    size?: "sm";
  };

export const MenuEntryButton = forwardRef<HTMLButtonElement, Props>(
  (props: Props, forwardedRef) => {
    const {
      children,
      className,
      type = "button",
      handlers,
      allowBubbling,
      id: _id,
      focusOpts,
      onFocus,
      label,
      icon,
      trailing,
      destructive,
      size,
      ...rest
    } = props;

    const genId = useId();
    const id = _id ?? genId;

    const { ref, focused, focusSelf } = useFocusable<HTMLButtonElement>({
      focusKey: id,
      focusable: !rest.disabled,
      ...focusOpts,
    });

    useImperativeHandle(forwardedRef, () => ref.current!);

    return (
      <HotkeyLayer
        id={`${id}-hotkeys`}
        allowBubbling={allowBubbling}
        handlers={{
          ...handlers,
          ACCEPT: {
            handler: () => ref.current?.click(),
            ...handlers?.ACCEPT,
            actionBar: {
              label: "Accept",
              position: "right",
              ...handlers?.ACCEPT?.actionBar,
            },
          },
        }}
      >
        <Button
          ref={ref}
          id={id}
          variant="ghost"
          type={type}
          size={size}
          {...rest}
          onFocus={(e) => {
            if (!focused && e.target === e.currentTarget) {
              focusSelf();
            }

            onFocus?.(e);
          }}
          className={cn(
            "group relative h-max w-full overflow-hidden rounded-md transition-all",
            "flex items-center gap-3 text-left font-semibold",
            size === "sm" ? "py-2 pl-4 pr-3 text-sm" : "py-2.5 pl-4 pr-3",
            "focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:ring-offset-transparent",
            "justify-start text-foreground transition-all",
            destructive
              ? "focus-hover:bg-destructive/10 focus-hover:text-destructive"
              : "focus-hover:bg-secondary/30 focus-hover:text-accent-text",

            "before:absolute before:inset-y-1 before:left-0 before:w-0 before:rounded-r before:bg-accent before:transition-all",
            destructive && "before:bg-destructive",
            "focus-hover:before:w-1",
            "data-[state=active]:before:w-1",
            !destructive && "data-[state=active]:text-accent-text",
            className,
          )}
        >
          {icon && (
            <span
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-md transition-colors",
                "bg-muted/40 text-muted-foreground",
                destructive
                  ? "group-hover:bg-destructive/15 group-hover:text-destructive group-focus-within:bg-destructive/15 group-focus-within:text-destructive"
                  : "group-hover:bg-accent/15 group-hover:text-accent-text group-focus-within:bg-accent/15 group-focus-within:text-accent-text",
              )}
            >
              {icon}
            </span>
          )}

          {label ? (
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate leading-tight">{children}</span>
              <span className="truncate text-sm font-normal text-muted-foreground">
                {label}
              </span>
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate">{children}</span>
          )}

          {trailing && (
            <span className="ml-auto flex shrink-0 items-center text-muted-foreground">
              {trailing}
            </span>
          )}
        </Button>
      </HotkeyLayer>
    );
  },
);

MenuEntryButton.displayName = "MenuEntryButton";
