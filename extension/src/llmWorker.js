// The worker that runs the on-device model. It only handles messages from the panel page that started it (same extension origin).
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = msg => handler.onmessage(msg);
