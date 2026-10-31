import { useSyncExternalStore } from "react";
import { getAppearance, setAppearance, subscribeAppearance } from "../lib/appearance.mjs";

export default function useAppearance() {
	return [useSyncExternalStore(subscribeAppearance, getAppearance, () => "aero"), setAppearance];
}
