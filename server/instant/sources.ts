import type { Upstream } from "./upstream.js";
import { sourceA } from "./treg.js";
import { sourceB } from "./monid.js";
import { sourceC } from "./orthogonal.js";
import { sourceD } from "./o11.js";
import { sourceE } from "./composio.js";

// Every wholesale source, in the order its catalog is preferred when two describe the same tool.
// A source is used only once its key is set; tests swap the list.
let list: Upstream[] = [sourceA, sourceB, sourceC, sourceD, sourceE];
export const sources = () => list;
export const setSources = (next: Upstream[]) => {
  list = next;
};
