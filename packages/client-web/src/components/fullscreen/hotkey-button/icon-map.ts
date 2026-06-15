import { Hotkey } from "@/providers/hotkeys";
import { ControllerMapping } from "@/providers/gamepad/maps";

// Xbox Series
import xboxA from "@/assets/controller-icons/xbox/xbox_button_a.svg";
import xboxB from "@/assets/controller-icons/xbox/xbox_button_b.svg";
import xboxBack from "@/assets/controller-icons/xbox/xbox_button_back.svg";
import xboxGuide from "@/assets/controller-icons/xbox/xbox_guide.svg";
import xboxLb from "@/assets/controller-icons/xbox/xbox_lb.svg";
import xboxRb from "@/assets/controller-icons/xbox/xbox_rb.svg";
import xboxDpadUp from "@/assets/controller-icons/xbox/xbox_dpad_up.svg";
import xboxDpadDown from "@/assets/controller-icons/xbox/xbox_dpad_down.svg";
import xboxDpadLeft from "@/assets/controller-icons/xbox/xbox_dpad_left.svg";
import xboxDpadRight from "@/assets/controller-icons/xbox/xbox_dpad_right.svg";

// PlayStation shared
import psCross from "@/assets/controller-icons/playstation/playstation_button_cross.svg";
import psCircle from "@/assets/controller-icons/playstation/playstation_button_circle.svg";
import psAnalog from "@/assets/controller-icons/playstation/playstation_button_analog.svg";
import psL1 from "@/assets/controller-icons/playstation/playstation_trigger_l1.svg";
import psR1 from "@/assets/controller-icons/playstation/playstation_trigger_r1.svg";
import psDpadUp from "@/assets/controller-icons/playstation/playstation_dpad_up.svg";
import psDpadDown from "@/assets/controller-icons/playstation/playstation_dpad_down.svg";
import psDpadLeft from "@/assets/controller-icons/playstation/playstation_dpad_left.svg";
import psDpadRight from "@/assets/controller-icons/playstation/playstation_dpad_right.svg";
// PlayStation per-generation OPTION buttons
import ps3Select from "@/assets/controller-icons/playstation/playstation3_button_select.svg";
import ps4Share from "@/assets/controller-icons/playstation/playstation4_button_share.svg";
import ps5Create from "@/assets/controller-icons/playstation/playstation5_button_create.svg";

// Nintendo Switch
import switchA from "@/assets/controller-icons/switch/switch_button_a.svg";
import switchB from "@/assets/controller-icons/switch/switch_button_b.svg";
import switchX from "@/assets/controller-icons/switch/switch_button_x.svg";
import switchL from "@/assets/controller-icons/switch/switch_button_l.svg";
import switchR from "@/assets/controller-icons/switch/switch_button_r.svg";
import switchSl from "@/assets/controller-icons/switch/switch_button_sl.svg";
import switchSr from "@/assets/controller-icons/switch/switch_button_sr.svg";
import switchMinus from "@/assets/controller-icons/switch/switch_button_minus.svg";
import switchHome from "@/assets/controller-icons/switch/switch_button_home.svg";
import switchDpadUp from "@/assets/controller-icons/switch/switch_dpad_up.svg";
import switchDpadDown from "@/assets/controller-icons/switch/switch_dpad_down.svg";
import switchDpadLeft from "@/assets/controller-icons/switch/switch_dpad_left.svg";
import switchDpadRight from "@/assets/controller-icons/switch/switch_dpad_right.svg";

type IconMap = Partial<Record<Hotkey, string>>;

// Maps derived from the button arrays in providers/gamepad/maps.tsx.
// Button indices follow the W3C Standard Gamepad layout:
// 0=south, 1=east, 4=LB, 5=RB, 8=select-equiv, 16=home, 12-15=d-pad.
const ICONS: Record<ControllerMapping, IconMap> = {
  xbox: {
    ACCEPT: xboxA,
    BACK: xboxB,
    OPTION: xboxBack,
    MENU: xboxGuide,
    PAGE_LEFT: xboxLb,
    PAGE_RIGHT: xboxRb,
    UP: xboxDpadUp,
    DOWN: xboxDpadDown,
    LEFT: xboxDpadLeft,
    RIGHT: xboxDpadRight,
  },
  "dualshock 3": {
    ACCEPT: psCross,
    BACK: psCircle,
    OPTION: ps3Select,
    MENU: psAnalog,
    PAGE_LEFT: psL1,
    PAGE_RIGHT: psR1,
    UP: psDpadUp,
    DOWN: psDpadDown,
    LEFT: psDpadLeft,
    RIGHT: psDpadRight,
  },
  "dualshock 4": {
    ACCEPT: psCross,
    BACK: psCircle,
    OPTION: ps4Share,
    MENU: psAnalog,
    PAGE_LEFT: psL1,
    PAGE_RIGHT: psR1,
    UP: psDpadUp,
    DOWN: psDpadDown,
    LEFT: psDpadLeft,
    RIGHT: psDpadRight,
  },
  "dualshock 5": {
    ACCEPT: psCross,
    BACK: psCircle,
    OPTION: ps5Create,
    MENU: psAnalog,
    PAGE_LEFT: psL1,
    PAGE_RIGHT: psR1,
    UP: psDpadUp,
    DOWN: psDpadDown,
    LEFT: psDpadLeft,
    RIGHT: psDpadRight,
  },
  switch_pro: {
    ACCEPT: switchA,
    BACK: switchB,
    OPTION: switchMinus,
    MENU: switchHome,
    PAGE_LEFT: switchL,
    PAGE_RIGHT: switchR,
    UP: switchDpadUp,
    DOWN: switchDpadDown,
    LEFT: switchDpadLeft,
    RIGHT: switchDpadRight,
  },
  switch_joycon_dual: {
    ACCEPT: switchA,
    BACK: switchB,
    OPTION: switchMinus,
    MENU: switchHome,
    PAGE_LEFT: switchL,
    PAGE_RIGHT: switchR,
    UP: switchDpadUp,
    DOWN: switchDpadDown,
    LEFT: switchDpadLeft,
    RIGHT: switchDpadRight,
  },
  switch_joycon_right: {
    // JoyCon Right has no d-pad; BACK maps to X (not B) at index 1.
    ACCEPT: switchA,
    BACK: switchX,
    OPTION: switchR,
    MENU: switchHome,
    PAGE_LEFT: switchSl,
    PAGE_RIGHT: switchSr,
  },
  generic: {},
};

export function getControllerIconSrc(
  hotkey: Hotkey,
  controllerType: ControllerMapping,
): string | undefined {
  return ICONS[controllerType]?.[hotkey];
}
