async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return [];

  const concurrency = Math.max(1, Number(limit) || 1);
  const results = new Array(list.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= list.length) return;
      results[currentIndex] = await worker(list[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, list.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

module.exports = {
  mapWithConcurrency,
};
