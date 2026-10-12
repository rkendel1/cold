// The worker that runs the on-device model. It has no network (see workerGuard.js) and only handles messages from the panel page that started it.
import { installNetworkGuard } from "./workerGuard.js";
installNetworkGuard();
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = msg => handler.onmessage(msg);
