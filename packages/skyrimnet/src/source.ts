// SkyrimNet as a source: the kind is the job, the actor the speaking NPC, whose name is replaced when comparing
// one NPC's prompt with another's.

import type { Source } from "@volatility/core";
import { classify, speaker } from "./jobs.ts";

export const skyrimnetSource: Source = (request) => {
  const actor = speaker(request);

  return { kind: classify(request).id, actor, actorNames: actor === null ? [] : [actor] };
};
