/** The assistant's registry as the harness's Registry service. */
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
