// Stands in for apps/web/src/page/stats.ts in the bench's `--stats off` build: the page
// without the search counter, to measure what the counter costs.
export const browserCounter = () => ({
  input() {},
  shown() {},
  acted() {},
});
