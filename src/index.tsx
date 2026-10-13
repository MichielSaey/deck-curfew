import { staticClasses } from "@decky/ui";
import { definePlugin } from "@decky/api";
import { FaMoon } from "react-icons/fa";
import { getStatus } from "./api";
import { Content } from "./Content";
import { startEnforcement, stopEnforcement } from "./enforce";

export default definePlugin(() => {
  console.log("Deck Curfew initializing");
  startEnforcement(() => getStatus(), 3000);

  return {
    name: "Deck Curfew",
    titleView: <div className={staticClasses.Title}>Deck Curfew</div>,
    content: <Content />,
    icon: <FaMoon />,
    onDismount() {
      console.log("Deck Curfew unloading");
      stopEnforcement();
    },
  };
});
