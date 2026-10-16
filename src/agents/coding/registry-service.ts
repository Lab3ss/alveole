/**
 * The coding agent's registry as the harness's Registry service. The coding
 * Room extends HarnessRoom, so its rows flow through the engine unchanged.
 */
import { Layer } from "effect";
import { Registry, type RegistryService } from "../../harness/opencode/registry.ts";
import { deleteRoom, getRoom, idleRooms, newRoom, saveRoom, touch } from "./registry.ts";

export const RegistryLive = Layer.sync(Registry, () => ({
  get: getRoom,
  create: newRoom,
  save: saveRoom,
  touch,
  idle: idleRooms,
  delete: deleteRoom,
}) satisfies RegistryService);
