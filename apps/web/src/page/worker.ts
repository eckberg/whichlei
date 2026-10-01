// The search worker: `Search` and `IndexClient` on their own thread (DESIGN.md decision 24).
// The page starts it once and sends `init` with the index origin, then every input.
import { IndexClient } from "../search/client.ts";
import { SearchHost, type ToPage, type ToWorker } from "../search/host.ts";
import { Search } from "../search/search.ts";

// The DOM lib types `self` as a Window; this is the dedicated worker scope.
const scope = self as unknown as {
  postMessage(message: ToPage): void;
  addEventListener(type: "message", listener: (event: { data: ToWorker }) => void): void;
};

let host: SearchHost | null = null;

scope.addEventListener("message", ({ data: message }) => {
  if (message.type === "init") {
    const search = new Search(message.origin === "" ? null : new IndexClient(message.origin));
    host = new SearchHost(search, (reply) => scope.postMessage(reply));
  } else {
    host?.handle(message);
  }
});
