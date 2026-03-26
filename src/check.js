const Scheduler = require('./scheduler.js');
const { loadConfig } = require('./config-store.js');

async function main() {
  const scheduler = new Scheduler(loadConfig());
  const result = await scheduler.manualPublishNow();

  if (result && result.error) {
    throw new Error(result.error);
  }

  console.log(`检查完成: 成功 ${result.published || 0}, 失败 ${result.failed || 0}`);
}

main().catch((error) => {
  console.error(`检查失败: ${error.message}`);
  process.exit(1);
});
