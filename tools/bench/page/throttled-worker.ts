// The production search worker (apps/web/src/page/worker.ts) with one addition: chromium's
// CPU throttling does not reach worker threads, so this worker slows itself down. After a pass
// that took P ms of work it keeps its thread busy for another (rate - 1) x P ms before it posts
// the answer, which is what a CPU `rate` times slower would have done to the pass. Bundled by
// scripts/search.ts into the site as search-worker.js, with __RATE__ set. Nothing else differs:
// the same SearchHost, Search and IndexClient.
import { IndexClient } from "../../../apps/web/src/search/client.ts";
import { SearchHost, type ToPage, type ToWorker } from "../../../apps/web/src/search/host.ts";
import { type PassStats, Search } from "../../../apps/web/src/search/search.ts";

declare const __RATE__: number;

const scope = self as unknown as {
  postMessage(message: ToPage): void;
  addEventListener(type: "message", listener: (event: { data: ToWorker }) => void): void;
};

let host: SearchHost | null = null;
let slowed: PassStats | null = null;
/** Milliseconds spent spinning so far. Search's clock leaves them out, so a pass costs P. */
let spun = 0;

function spin(ms: number) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Busy: a slower CPU would have been.
  }
  spun += ms;
}

scope.addEventListener("message", ({ data: message }) => {
  if (message.type === "init") {
    const search = new Search(message.origin === "" ? null : new IndexClient(message.origin), {
      now: () => performance.now() - spun,
    });
    host = new SearchHost(search, (reply) => {
      // A state carries the stats of the last finished pass; slow down once per pass.
      if (reply.stats && reply.stats !== slowed) {
        slowed = reply.stats;
        spin((__RATE__ - 1) * reply.stats.ms);
      }
      scope.postMessage(reply);
    });
  } else {
    host?.handle(message);
  }
});
