const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { validateImportSchedule } = require('../src/scheduler-allocator.js');
const {
  collectPlatformReservations,
  buildBatchWindow,
  collectPlanTimestamps,
} = require('../src/platform-reservations.js');

function item(overrides = {}) {
  return {
    topic: '主题A',
    topicKey: '主题A',
    noteKey: '主题A/1',
    platform: 'xiaohongshu',
    account: '账号1',
    storeGroup: '店铺A',
    publishTime: '2026-07-16 09:00',
    ...overrides,
  };
}

// 跨账号同主题间隔（规则 A/B/C/D）现在无条件执行：任何 schedule 条目只要缺店铺组映射就
// fail-closed 记违规。绝大多数测试用例本身不是在测这四条规则，为了不让它们被无关的
// "未配置店铺组"误伤，统一给一份覆盖全文件所有账号名的默认店铺组映射，全部归到同一个
// 店铺——同店铺只会产出 approvals（不影响 result.ok），不会像跨店铺那样触发硬 violation。
// 需要显式测试跨店铺/同店铺差异的用例，会自己传 accountGroups 覆盖这份默认值。
const DEFAULT_STORE_GROUP = '店铺A';
const DEFAULT_ACCOUNT_GROUPS = Object.fromEntries(
  ['账号1', '账号2', '账号3', '账号9', '抖音号1', '抖音号2', '同名号', '本批账号', 'acc', 'Acc']
    .map(account => [account, DEFAULT_STORE_GROUP])
);

function baseInput(overrides = {}) {
  return {
    seed: 'fixed-seed',
    schedule: [item()],
    coverageStrategy: 'minimum',
    accountGroups: DEFAULT_ACCOUNT_GROUPS,
    ...overrides,
  };
}

function violationRules(error) {
  return (error.violations || []).map(v => v.rule);
}

// ---------- 基础合法性 ----------

test('基础合法性：合法 schedule 通过', () => {
  const result = validateImportSchedule(baseInput());
  assert.equal(result.ok, true);
  assert.equal(result.schedule.length, 1);
});

test('基础合法性：非法 platform/account/publishTime/noteKey 都记为 format 违规', () => {
  assert.throws(() => validateImportSchedule(baseInput({
    schedule: [
      item({ platform: 'weibo' }),
      item({ account: '' }),
      item({ publishTime: '不是时间' }),
      item({ noteKey: '没有斜杠' }),
    ],
  })), error => {
    const rules = violationRules(error);
    return error.statusCode === 400 && rules.length === 4 && rules.every(r => r === 'format');
  });
});

// ---------- 硬约束 1：同账号间隔 ----------

test('min_interval：同账号361分钟通过，360分钟拒绝', () => {
  const ok = validateImportSchedule(baseInput({
    schedule: [
      item({ noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ noteKey: '主题A/2', publishTime: '2026-07-16 15:01' }),
    ],
  }));
  assert.equal(ok.ok, true);

  assert.throws(() => validateImportSchedule(baseInput({
    schedule: [
      item({ noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ noteKey: '主题A/2', publishTime: '2026-07-16 15:00' }),
    ],
  })), error => error.statusCode === 400 && violationRules(error).includes('min_interval'));
});

test('min_interval：existingReservations 参与同账号间隔判断', () => {
  const reservation = [{ platform: 'xiaohongshu', account: '账号1', publishTime: '2026-07-16 09:00', topicKey: '旧主题', storeGroup: '店铺A' }];
  assert.throws(() => validateImportSchedule(baseInput({
    schedule: [item({ publishTime: '2026-07-16 15:00' })],
    existingReservations: reservation,
  })), error => error.statusCode === 400 && violationRules(error).includes('min_interval'));

  const ok = validateImportSchedule(baseInput({
    schedule: [item({ publishTime: '2026-07-16 15:01' })],
    existingReservations: reservation,
  }));
  assert.equal(ok.ok, true);
});

// ---------- 硬约束 2：全局分钟唯一 ----------

test('duplicate_minute：不同账号同一分钟拒绝，不同分钟通过', () => {
  const ok = validateImportSchedule(baseInput({
    schedule: [
      item({ account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ account: '账号2', noteKey: '主题A/2', publishTime: '2026-07-16 09:01' }),
    ],
  }));
  assert.equal(ok.ok, true);

  assert.throws(() => validateImportSchedule(baseInput({
    schedule: [
      item({ account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ account: '账号2', noteKey: '主题A/2', publishTime: '2026-07-16 09:00' }),
    ],
  })), error => error.statusCode === 400 && violationRules(error).includes('duplicate_minute'));
});

test('duplicate_minute：与 existingReservations 的分钟也不能撞', () => {
  assert.throws(() => validateImportSchedule(baseInput({
    schedule: [item({ account: '账号2', publishTime: '2026-07-16 10:00' })],
    existingReservations: [{ platform: 'xiaohongshu', account: '账号1', publishTime: '2026-07-16 10:00', topicKey: '旧主题', storeGroup: '店铺A' }],
  })), error => error.statusCode === 400 && violationRules(error).includes('duplicate_minute'));
});

// ---------- 硬约束 3：同平台内 noteKey 不重复 ----------

test('duplicate_note_key：同平台重复拒绝，跨平台复用通过', () => {
  const ok = validateImportSchedule(baseInput({
    schedule: [
      item({ platform: 'xiaohongshu', account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ platform: 'douyin', account: '账号2', noteKey: '主题A/1', publishTime: '2026-07-16 09:01' }),
    ],
  }));
  assert.equal(ok.ok, true);

  assert.throws(() => validateImportSchedule(baseInput({
    schedule: [
      item({ platform: 'xiaohongshu', account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ platform: 'xiaohongshu', account: '账号2', noteKey: '主题A/1', publishTime: '2026-07-16 15:01' }),
    ],
  })), error => error.statusCode === 400 && violationRules(error).includes('duplicate_note_key'));
});

// ---------- 硬约束 4：同账号内 template 不重复 ----------

test('duplicate_template：同账号同template拒绝，不同template通过', () => {
  const ok = validateImportSchedule(baseInput({
    schedule: [
      item({ noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ noteKey: '主题B/2', publishTime: '2026-07-16 15:01' }),
    ],
  }));
  assert.equal(ok.ok, true);

  assert.throws(() => validateImportSchedule(baseInput({
    schedule: [
      item({ noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ noteKey: '主题B/1', publishTime: '2026-07-16 15:01' }),
    ],
  })), error => error.statusCode === 400 && violationRules(error).includes('duplicate_template'));
});

// ---------- 规则 A/B/C/D：跨账号同主题间隔（2026-08 重写，两个平台无条件执行）----------

// 服务端权威分组数据：accountGroups（账号→店铺组）与 currentItems（noteKey→topicKey）。
// 校验器只认这两份，不读 schedule 条目自带的 storeGroup / topicKey。
// 账号1/账号2 同店铺（用于规则 B），账号3 是另一个店铺（用于规则 A）。
const SERVER_GROUPS = {
  accountGroups: { 账号1: '店铺A', 账号2: '店铺A', 账号3: '店铺B' },
  currentItems: [
    { noteKey: '主题A/1', topicKey: '主题A' },
    { noteKey: '主题A/2', topicKey: '主题A' },
    { noteKey: '主题A/3', topicKey: '主题A' },
    { noteKey: '主题B/1', topicKey: '主题B' },
    { noteKey: '主题B/2', topicKey: '主题B' },
  ],
};

function spacingInput(overrides = {}) {
  // 注意：不再默认带 topicDecision——规则 A/B/C/D 无条件执行，不需要 auto_space 才生效，
  // 这正是本次重写要验证的核心行为。需要专门验证 allow_conflicts 下依旧生效的用例见下方。
  return baseInput({ ...SERVER_GROUPS, ...overrides });
}

test('规则 A：跨店铺同主题跨账号，2879 分钟拒绝，2880 分钟通过', () => {
  assert.throws(() => validateImportSchedule(spacingInput({
    schedule: [
      item({ account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ account: '账号3', noteKey: '主题A/2', publishTime: '2026-07-18 08:59' }), // 2879 分钟
    ],
  })), error => error.statusCode === 400 && violationRules(error).includes('topic_spacing'));

  const ok = validateImportSchedule(spacingInput({
    schedule: [
      item({ account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ account: '账号3', noteKey: '主题A/2', publishTime: '2026-07-18 09:00' }), // 2880 分钟，刚好达标
    ],
  }));
  assert.equal(ok.ok, true);
  assert.equal(ok.approvals.length, 0, '跨店铺不应该进 approvals');
});

test('规则 A：同账号发同一主题不受此约束（哪怕跨店铺配置也一样，同账号自己跳过比较）', () => {
  const ok = validateImportSchedule(spacingInput({
    schedule: [
      item({ account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ account: '账号1', noteKey: '主题A/2', publishTime: '2026-07-16 15:01' }),
    ],
  }));
  assert.equal(ok.ok, true);
});

test('规则 A：existingReservations 跨店铺同主题也参与检查', () => {
  assert.throws(() => validateImportSchedule(spacingInput({
    schedule: [item({ account: '账号3', noteKey: '主题A/1', publishTime: '2026-07-16 09:30' })],
    existingReservations: [{ platform: 'xiaohongshu', account: '账号1', publishTime: '2026-07-16 09:00', topicKey: '主题A', storeGroup: '店铺A' }],
  })), error => error.statusCode === 400 && violationRules(error).includes('topic_spacing'));
});

test('规则 A：topicDecision 不再门控——none / allow_conflicts 下跨店铺间隔不足依旧拒收（核心缺陷修复）', () => {
  for (const topicDecision of [undefined, 'none', 'allow_conflicts']) {
    assert.throws(() => validateImportSchedule(spacingInput({
      topicDecision,
      schedule: [
        item({ account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
        item({ account: '账号3', noteKey: '主题A/2', publishTime: '2026-07-16 09:10' }),
      ],
    })), error => error.statusCode === 400 && violationRules(error).includes('topic_spacing'),
      `topicDecision=${topicDecision} 时规则 A 应该仍然执行`);
  }
});

test('规则 B：同店铺不同账号发同一主题，不论间隔多久都进 approvals，不拒收', () => {
  const tight = validateImportSchedule(spacingInput({
    schedule: [
      item({ account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ account: '账号2', noteKey: '主题A/2', publishTime: '2026-07-16 09:10' }), // 只差 10 分钟
    ],
  }));
  assert.equal(tight.ok, true);
  assert.equal(tight.approvals.length, 1);
  assert.equal(tight.approvals[0].rule, 'topic_spacing_approval');
  assert.deepEqual([...tight.approvals[0].accounts].sort(), ['账号1', '账号2']);
  // approvals.storeGroup 取的是归一化后的 storeGroupKey（checkTopicSpacing 内部按
  // normalizeGroupKey 小写化），不是 accountGroups 里原始大小写的展示值——与「绕过负例3」
  // 验证的行为一致（'shop'/'SHOP' 都归一化成小写 'shop'）。
  assert.equal(tight.approvals[0].storeGroup, '店铺a');
  assert.equal(tight.approvals[0].topicKey, '主题A');

  // 拉开到很长间隔（远超 2880 分钟）依旧只是 approval，不会因为间隔够长就消失，
  // 也不会因为间隔够长就升级成别的规则——同店铺永远走审批。
  const loose = validateImportSchedule(spacingInput({
    schedule: [
      item({ account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ account: '账号2', noteKey: '主题A/2', publishTime: '2026-07-26 09:00' }), // 10 天
    ],
  }));
  assert.equal(loose.ok, true);
  assert.equal(loose.approvals.length, 1);
});

test('规则 B：existingReservations 同店铺同主题同样只产出 approval，不拒收', () => {
  const result = validateImportSchedule(spacingInput({
    schedule: [item({ account: '账号2', noteKey: '主题A/1', publishTime: '2026-07-16 09:30' })],
    existingReservations: [{ platform: 'xiaohongshu', account: '账号1', publishTime: '2026-07-16 09:00', topicKey: '主题A', storeGroup: '店铺A' }],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.approvals.length, 1);
});

test('规则 A/B：跨账号同主题分组不再跨平台——小红书和抖音各自独立比较', () => {
  const result = validateImportSchedule(baseInput({
    accountGroups: { 账号1: '店铺A', 抖音号1: '店铺A' },
    currentItems: [
      { noteKey: '主题A/1', topicKey: '主题A' },
      { noteKey: '主题A/2', topicKey: '主题A' },
    ],
    schedule: [
      item({ platform: 'xiaohongshu', account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ platform: 'douyin', account: '抖音号1', noteKey: '主题A/2', publishTime: '2026-07-16 09:10' }),
    ],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.approvals.length, 0, '不同平台即使同店铺同主题也不该互相触发');
});

test('规则 C：7 天窗口内同主题累计 > 10 条强制 warning，不拒收；用不同账号避开约束1', () => {
  // 用 11 个不同账号各发一次，规避约束 1（同账号间隔）与规则 B/A 的账号配对逻辑，
  // 单纯测试"同一主题在 7 天窗口内的总条数"。全部同店铺，只会顺带产出大量 approvals，
  // 不影响本用例要验证的 warning。
  const accounts = Array.from({ length: 11 }, (_, i) => `店铺账号${i + 1}`);
  const accountGroups = Object.fromEntries(accounts.map(a => [a, '同一店铺']));
  const schedule = accounts.map((account, i) => item({
    account,
    noteKey: `主题C/${i + 1}`,
    publishTime: `2026-08-0${(i % 7) + 1} 06:${String(i).padStart(2, '0')}`,
  }));
  const result = validateImportSchedule(baseInput({
    accountGroups,
    noteFolders: [{ topic: '主题C', templates: accounts.map((_, i) => String(i + 1)) }],
    allowPartialSchedule: true,
    schedule,
  }));
  assert.equal(result.ok, true);
  const hit = result.stats.warnings.find(w => w.includes('超过上限'));
  assert.ok(hit, `应该有超量 warning，实际 warnings=${JSON.stringify(result.stats.warnings)}`);
  assert.match(hit, /主题「主题C」在 7 天窗口内累计发布 11 条，超过上限 10 条（超出 1 条）/);
  const stat = result.topicVolume.find(s => s.topicKey === '主题C' && s.platform === 'xiaohongshu');
  assert.ok(stat && stat.count === 11, `topicVolume.count 应为 11，实际=${JSON.stringify(stat)}`);
});

test('规则 C：allow_conflicts 下依旧强制告警（不受 topicDecision 影响）', () => {
  const accounts = Array.from({ length: 11 }, (_, i) => `店铺账号${i + 1}`);
  const accountGroups = Object.fromEntries(accounts.map(a => [a, '同一店铺']));
  const schedule = accounts.map((account, i) => item({
    account,
    noteKey: `主题C/${i + 1}`,
    publishTime: `2026-08-0${(i % 7) + 1} 06:${String(i).padStart(2, '0')}`,
  }));
  const result = validateImportSchedule(baseInput({
    topicDecision: 'allow_conflicts',
    accountGroups,
    noteFolders: [{ topic: '主题C', templates: accounts.map((_, i) => String(i + 1)) }],
    allowPartialSchedule: true,
    schedule,
  }));
  assert.equal(result.ok, true);
  assert.ok(result.stats.warnings.some(w => w.includes('超过上限')));
});

test('规则 C：7 天窗口内不超过 10 条不告警', () => {
  const accounts = Array.from({ length: 10 }, (_, i) => `店铺账号${i + 1}`);
  const accountGroups = Object.fromEntries(accounts.map(a => [a, '同一店铺']));
  const schedule = accounts.map((account, i) => item({
    account,
    noteKey: `主题D/${i + 1}`,
    publishTime: `2026-08-0${(i % 7) + 1} 06:${String(i).padStart(2, '0')}`,
  }));
  const result = validateImportSchedule(baseInput({
    accountGroups,
    noteFolders: [{ topic: '主题D', templates: accounts.map((_, i) => String(i + 1)) }],
    allowPartialSchedule: true,
    schedule,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.stats.warnings.filter(w => w.includes('超过上限')).length, 0);
});

test('规则 D：30 天窗口纯统计，不设阈值、不告警', () => {
  const result = validateImportSchedule(baseInput({
    noteFolders: [{ topic: '主题E', templates: ['1', '2', '3'] }],
    schedule: [
      item({ account: '账号1', noteKey: '主题E/1', publishTime: '2026-08-01 06:00' }),
      item({ account: '账号1', noteKey: '主题E/2', publishTime: '2026-08-15 06:00' }),
      item({ account: '账号1', noteKey: '主题E/3', publishTime: '2026-08-29 06:00' }),
    ],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.stats.warnings.filter(w => w.includes('超过上限')).length, 0);
  const stat = result.topicVolume.find(s => s.topicKey === '主题E');
  assert.ok(stat, '应该有 topicVolume 统计项');
  assert.equal(stat.longCount, 3);
  assert.equal(stat.longWindowDays, 30);
});

test('抖音同样纳入规则 A（旧实现完全不检查抖音）', () => {
  assert.throws(() => validateImportSchedule(baseInput({
    accountGroups: { 抖音甲: '店铺X', 抖音乙: '店铺Y' },
    currentItems: [{ noteKey: '主题F/1', topicKey: '主题F' }, { noteKey: '主题F/2', topicKey: '主题F' }],
    schedule: [
      item({ platform: 'douyin', account: '抖音甲', noteKey: '主题F/1', publishTime: '2026-07-16 09:00' }),
      item({ platform: 'douyin', account: '抖音乙', noteKey: '主题F/2', publishTime: '2026-07-16 09:10' }),
    ],
  })), error => error.statusCode === 400 && violationRules(error).includes('topic_spacing'));
});

// ---------- 绕过路径负例（每条对应一次已复现的绕过） ----------

test('绕过负例1：schedule 自带 storeGroup 但 accountGroups 查不到 → fail-closed 拒收', () => {
  // 旧实现：storeGroup 缺失就静默跳过约束5，两条同主题不同账号只差 10 分钟也放行。
  assert.throws(() => validateImportSchedule(baseInput({
    accountGroups: {}, // 显式覆盖掉默认映射，故意让这两个账号查不到店铺组
    currentItems: SERVER_GROUPS.currentItems,
    // 故意不给 accountGroups 命中，只在 schedule 条目里带 storeGroup（客户端字段，现已不被信任）
    schedule: [
      item({ account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00', storeGroup: '店1' }),
      item({ account: '账号2', noteKey: '主题A/2', publishTime: '2026-07-16 09:10', storeGroup: '店1' }),
    ],
  })), error => error.statusCode === 400
    && violationRules(error).includes('topic_spacing')
    && /未在 accountGroups 中配置店铺组/.test(error.message));
});

test('绕过负例1b：客户端伪造 topicKey 不能把同主题拆成两个主题', () => {
  // schedule 里把第二条的 topicKey 改成别的值，服务端 currentItems 仍判定为同主题 → 用跨店铺
  // 账号（账号1 店铺A / 账号3 店铺B）验证：伪造 topicKey 逃不掉规则 A 的硬拒收。
  assert.throws(() => validateImportSchedule(spacingInput({
    schedule: [
      item({ account: '账号1', noteKey: '主题A/1', topicKey: '主题A', publishTime: '2026-07-16 09:00' }),
      item({ account: '账号3', noteKey: '主题A/2', topicKey: '伪造的另一个主题', publishTime: '2026-07-16 09:10' }),
    ],
  })), error => error.statusCode === 400 && violationRules(error).includes('topic_spacing'));
});

test('绕过负例2：账号名大小写不同仍算同一账号，间隔不足拒收', () => {
  // 发布链路 account-mapping.js 用 toLowerCase 匹配，acc 与 Acc 是同一个号。
  assert.throws(() => validateImportSchedule(baseInput({
    schedule: [
      item({ account: 'acc', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ account: 'Acc', noteKey: '主题A/2', publishTime: '2026-07-16 09:10' }),
    ],
  })), error => error.statusCode === 400 && violationRules(error).includes('min_interval'));
});

test('绕过负例3：storeGroup 大小写不同仍算同一店铺组 → 归为规则 B（审批），不是规则 A（拒收）', () => {
  // normalizeGroupKey 对店铺组做 NFKC + 折叠空白 + 小写归一化：'shop' 和 'SHOP' 被判定为
  // 同一个店铺组。这在新语义下意味着这两个账号走规则 B（同店铺需审批），而不是规则 A
  // （跨店铺硬拒收）——旧测试断言的是"应该拒收"，那是被推翻的旧行为，这里改断言 approvals。
  const result = validateImportSchedule(baseInput({
    topicDecision: 'auto_space',
    accountGroups: { 账号1: 'shop', 账号2: 'SHOP' },
    currentItems: SERVER_GROUPS.currentItems,
    schedule: [
      item({ account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ account: '账号2', noteKey: '主题A/2', publishTime: '2026-07-16 09:10' }),
    ],
  }));
  assert.equal(result.ok, true);
  assert.equal(result.approvals.length, 1);
  assert.equal(result.approvals[0].storeGroup, 'shop', '店铺组归一化后应统一取其中一个大小写形式');
});

test('绕过负例4：template 前后空格不构成新模板，同账号重复模板拒收', () => {
  assert.throws(() => validateImportSchedule(baseInput({
    schedule: [
      item({ account: '账号1', noteKey: '主题1/x', publishTime: '2026-07-16 09:00' }),
      item({ account: '账号1', noteKey: '主题2/ x', publishTime: '2026-07-16 15:01' }),
    ],
  })), error => error.statusCode === 400 && violationRules(error).includes('duplicate_template'));
});

test('绕过负例5：分钟唯一无条件生效，不受 uniqueMinuteAcrossBatch 配置影响', () => {
  // 旧实现里 uniqueMinuteAcrossBatch=false 能整条关掉约束2；现在该字段只回显，不做开关。
  assert.throws(() => validateImportSchedule(baseInput({
    uniqueMinuteAcrossBatch: false,
    schedule: [
      item({ account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ account: '账号2', noteKey: '主题A/2', publishTime: '2026-07-16 09:00' }),
      item({ account: '账号3', noteKey: '主题A/3', publishTime: '2026-07-16 09:00' }),
    ],
    existingReservations: [{ platform: 'xiaohongshu', account: '账号9', publishTime: '2026-07-16 09:00', topicKey: '旧主题', storeGroup: '店铺A' }],
  })), error => error.statusCode === 400 && violationRules(error).includes('duplicate_minute'));
});

test('format：小时必须补零（9:05 这类一位小时判为格式违规）', () => {
  // EXACT_MINUTE_PATTERN 已收紧为 \d{2}:\d{2}，与「一位小时实际走不通」的行为一致
  assert.throws(() => validateImportSchedule(baseInput({
    schedule: [item({ publishTime: '2026-08-01 9:05' })],
  })), error => error.statusCode === 400 && violationRules(error).includes('format'));

  // 补零后同样的时间可以通过
  const ok = validateImportSchedule(baseInput({
    schedule: [item({ publishTime: '2026-08-01 09:05' })],
  }));
  assert.equal(ok.ok, true);
});

// ---------- 多条违规一次性返回 ----------

test('多条违规同时存在时一次性全部返回', () => {
  assert.throws(() => validateImportSchedule(baseInput({
    schedule: [
      item({ account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
      item({ account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' }),
    ],
  })), error => {
    const rules = new Set(violationRules(error));
    return error.statusCode === 400
      && rules.has('min_interval')
      && rules.has('duplicate_minute')
      && rules.has('duplicate_note_key')
      && rules.has('duplicate_template');
  });
});

// ---------- noteFolders 校验 ----------

test('note_missing：noteKey 不在 noteFolders 集合内，或有模板未被排上', () => {
  assert.throws(() => validateImportSchedule(baseInput({
    noteFolders: [{ topic: '主题A', templates: ['1'] }],
    schedule: [item({ noteKey: '主题A/2' })],
  })), error => error.statusCode === 400 && violationRules(error).includes('note_missing'));

  assert.throws(() => validateImportSchedule(baseInput({
    noteFolders: [{ topic: '主题A', templates: ['1', '2'] }],
    schedule: [item({ noteKey: '主题A/1' })],
  })), error => error.statusCode === 400 && violationRules(error).includes('note_missing'));

  const okPartial = validateImportSchedule(baseInput({
    noteFolders: [{ topic: '主题A', templates: ['1', '2'] }],
    schedule: [item({ noteKey: '主题A/1' })],
    allowPartialSchedule: true,
  }));
  assert.equal(okPartial.ok, true);
});

// ---------- coverageStrategy ----------

function coverageInput(strategy) {
  return baseInput({
    coverageStrategy: strategy,
    schedule: [
      item({ account: '账号1', noteKey: '主题A/1', topicKey: '主题A', publishTime: '2026-07-16 09:00' }),
      item({ account: '账号1', noteKey: '主题B/2', topicKey: '主题B', publishTime: '2026-07-16 15:01' }),
      item({ account: '账号2', noteKey: '主题A/3', topicKey: '主题A', publishTime: '2026-07-16 09:05' }),
    ],
  });
}

test('coverageStrategy=strict：账号未覆盖全部主题直接拒收', () => {
  assert.throws(() => validateImportSchedule(coverageInput('strict')), error => (
    error.statusCode === 400 && violationRules(error).includes('coverage')
  ));
});

test('coverageStrategy=balanced：未覆盖全部主题只记 warning，不拒收', () => {
  const result = validateImportSchedule(coverageInput('balanced'));
  assert.equal(result.ok, true);
  assert.ok(result.stats.warnings.length > 0);
});

test('coverageStrategy=minimum：不检查覆盖度', () => {
  const result = validateImportSchedule(coverageInput('minimum'));
  assert.equal(result.ok, true);
  assert.equal(result.stats.warnings.length, 0);
});

// ---------- 输出结构 ----------

test('校验通过时返回 constraints 与 stats（含新增的规则 A/C/D 常量与 approvals/topicVolume 结构）', () => {
  const result = validateImportSchedule(baseInput());
  assert.equal(result.constraints.minSameAccountIntervalMinutes, 361);
  assert.equal(result.constraints.minCrossStoreTopicIntervalMinutes, 2880);
  assert.equal(result.constraints.topicVolumeWindowDays, 7);
  assert.equal(result.constraints.topicVolumeMaxCount, 10);
  assert.equal(result.constraints.topicVolumeLongWindowDays, 30);
  assert.equal(result.constraints.uniqueMinuteAcrossBatch, true);
  assert.equal(result.stats.scheduledCount, 1);
  assert.equal(result.stats.topicVolumeWindowDays, 7);
  assert.equal(result.stats.topicVolumeLongWindowDays, 30);
  assert.ok(Array.isArray(result.approvals));
  assert.ok(Array.isArray(result.topicVolume));
  assert.equal(result.topicVolume.length, 1);
  assert.equal(result.topicVolume[0].topicKey, '主题A');
  assert.equal(result.topicVolume[0].count, 1);
});

// ---------- 平台无关既有排期（scope='time'）：抖音兜底 ----------

// 背景：existingReservations 过去唯一来源是 collectIndexedReservations（小红书专属），
// 抖音的既有排期在「同账号最小间隔」和「分钟全局唯一」两条约束上完全没有兜底，
// 分批排期时跨批撞同一分钟、同账号间隔不足都没人拦。

function douyinItem(overrides = {}) {
  return item({ platform: 'douyin', account: '抖音号1', ...overrides });
}

test('抖音兜底：跨批撞同一分钟被拒收', () => {
  assert.throws(() => validateImportSchedule(baseInput({
    schedule: [douyinItem({ account: '抖音号2', publishTime: '2026-07-16 09:00' })],
    existingReservations: [
      { platform: 'douyin', scope: 'time', account: '抖音号1', publishTime: '2026-07-16 09:00' },
    ],
  })), error => error.statusCode === 400 && violationRules(error).includes('duplicate_minute'));

  // 错开一分钟即可通过
  const ok = validateImportSchedule(baseInput({
    schedule: [douyinItem({ account: '抖音号2', publishTime: '2026-07-16 09:01' })],
    existingReservations: [
      { platform: 'douyin', scope: 'time', account: '抖音号1', publishTime: '2026-07-16 09:00' },
    ],
  }));
  assert.equal(ok.ok, true);
});

test('抖音兜底：同一抖音账号跨批间隔不足 361 分钟被拒收', () => {
  const reservation = [
    { platform: 'douyin', scope: 'time', account: '抖音号1', publishTime: '2026-07-16 09:00' },
  ];
  assert.throws(() => validateImportSchedule(baseInput({
    schedule: [douyinItem({ publishTime: '2026-07-16 15:00' })],
    existingReservations: reservation,
  })), error => error.statusCode === 400 && violationRules(error).includes('min_interval'));

  const ok = validateImportSchedule(baseInput({
    schedule: [douyinItem({ publishTime: '2026-07-16 15:01' })],
    existingReservations: reservation,
  }));
  assert.equal(ok.ok, true);
});

test('抖音兜底：跨平台同名账号互不干扰（小红书既有排期不拦抖音）', () => {
  const ok = validateImportSchedule(baseInput({
    schedule: [douyinItem({ account: '同名号', publishTime: '2026-07-16 09:05' })],
    existingReservations: [
      { platform: 'xiaohongshu', scope: 'time', account: '同名号', publishTime: '2026-07-16 09:00' },
    ],
  }));
  assert.equal(ok.ok, true);
});

test('scope=time 的条目不参与规则 A/B，不会被 fail-closed 分支误判', () => {
  // 平台无关条目没有 topicKey / storeGroup；若它进了 checkTopicSpacing，
  // 会被记成「无法确定主题」的 topic_spacing 违规。
  const ok = validateImportSchedule(spacingInput({
    schedule: [item({ account: '账号1', noteKey: '主题A/1', publishTime: '2026-07-16 09:00' })],
    existingReservations: [
      { platform: 'xiaohongshu', scope: 'time', account: '账号2', publishTime: '2026-07-16 20:00' },
      { platform: 'douyin', scope: 'time', account: '抖音号1', publishTime: '2026-07-16 21:00' },
    ],
  }));
  assert.equal(ok.ok, true);

  // 同一主题的 topic 一路仍然照常拦截（规则 A 回归，用跨店铺账号 3 验证是硬拒收）
  assert.throws(() => validateImportSchedule(spacingInput({
    schedule: [item({ account: '账号3', noteKey: '主题A/1', publishTime: '2026-07-16 09:30' })],
    existingReservations: [
      { platform: 'xiaohongshu', scope: 'topic', account: '账号1', publishTime: '2026-07-16 09:00', topicKey: '主题A', storeGroup: '店铺A' },
      { platform: 'douyin', scope: 'time', account: '抖音号1', publishTime: '2026-07-16 21:00' },
    ],
  })), error => error.statusCode === 400 && violationRules(error).includes('topic_spacing'));
});

test('同一条既有排期两路都传时去重，不会自己和自己撞分钟', () => {
  const ok = validateImportSchedule(baseInput({
    schedule: [item({ account: '账号2', publishTime: '2026-07-16 20:00' })],
    existingReservations: [
      { platform: 'xiaohongshu', scope: 'topic', account: '账号1', publishTime: '2026-07-16 09:00', topicKey: '主题A', storeGroup: '店铺A' },
      { platform: 'xiaohongshu', scope: 'time', account: '账号1', publishTime: '2026-07-16 09:00' },
    ],
  }));
  assert.equal(ok.ok, true);
});

test('既有排期之间的存量冲突不记违规（本批无法修复的事实不当路障）', () => {
  const ok = validateImportSchedule(baseInput({
    schedule: [item({ account: '本批账号', publishTime: '2026-07-16 20:00' })],
    existingReservations: [
      // 两条既有排期本身撞分钟 + 同账号间隔不足，都是飞书里的存量事实
      { platform: 'douyin', scope: 'time', account: '抖音号1', publishTime: '2026-07-16 09:00' },
      { platform: 'douyin', scope: 'time', account: '抖音号2', publishTime: '2026-07-16 09:00' },
      { platform: 'douyin', scope: 'time', account: '抖音号1', publishTime: '2026-07-16 10:00' },
    ],
  }));
  assert.equal(ok.ok, true);
});

test('规则 A：两条既有排期之间的跨店铺同主题冲突不记违规', () => {
  // 2026-08-07 实测缺陷：checkMinInterval / checkDuplicateMinute 都豁免了「两条都是
  // 既有排期」的存量冲突，唯独规则 A 没有，导致飞书里累积的跨店铺同主题记录会把此后
  // 每一批干净的新排期都拒收（真实数据里累积到 169 条 violation，本批 0 条）。
  const ok = validateImportSchedule(spacingInput({
    schedule: [item({ account: '账号1', noteKey: '主题B/1', publishTime: '2026-07-20 09:00' })],
    existingReservations: [
      // 两条既有排期彼此跨店铺同主题、间隔远不足 2880 分钟，是飞书里的存量事实
      { platform: 'xiaohongshu', scope: 'topic', account: '账号2', publishTime: '2026-07-16 09:00', topicKey: '主题A', storeGroup: '店铺A' },
      { platform: 'xiaohongshu', scope: 'topic', account: '账号3', publishTime: '2026-07-16 09:30', topicKey: '主题A', storeGroup: '店铺B' },
    ],
  }));
  assert.equal(ok.ok, true);

  // 回归：本批条目与既有排期跨店铺同主题撞，仍然照常硬拒收（豁免不能放宽到这一路）
  assert.throws(() => validateImportSchedule(spacingInput({
    schedule: [item({ account: '账号3', noteKey: '主题A/1', publishTime: '2026-07-16 09:30' })],
    existingReservations: [
      { platform: 'xiaohongshu', scope: 'topic', account: '账号1', publishTime: '2026-07-16 09:00', topicKey: '主题A', storeGroup: '店铺A' },
    ],
  })), error => error.statusCode === 400 && violationRules(error).includes('topic_spacing'));
});

test('existingReservations 的 scope 只能是 topic 或 time', () => {
  assert.throws(() => validateImportSchedule(baseInput({
    existingReservations: [
      { platform: 'douyin', scope: '随便写', account: '抖音号1', publishTime: '2026-07-16 09:00' },
    ],
  })), error => error.statusCode === 400 && /scope 只能是 topic 或 time/.test(error.message));
});

// ---------- 平台无关收集器：src/platform-reservations.js ----------

function feishuRecord(overrides = {}) {
  return {
    recordId: 'rec1',
    platform: null,
    publishTime: new Date(2026, 6, 16, 9, 0),
    xiaohongshuAccount: '',
    xiaohongshuStatus: '',
    douyinAccount: '',
    douyinStatus: '',
    ...overrides,
  };
}

test('收集器：小红书与抖音一视同仁，同一条记录两个平台各出一条', () => {
  const reservations = collectPlatformReservations({
    feishuRecords: [feishuRecord({
      xiaohongshuAccount: '小红书号1',
      xiaohongshuStatus: '待发布',
      douyinAccount: '抖音号1',
      douyinStatus: '待处理',
    })],
  });
  assert.deepEqual(reservations.map(r => `${r.platform}:${r.account}@${r.publishTime}`), [
    'douyin:抖音号1@2026-07-16 09:00',
    'xiaohongshu:小红书号1@2026-07-16 09:00',
  ]);
});

test('收集器：只认活跃状态，已发布/发布失败/无发布时间都不占分钟', () => {
  const reservations = collectPlatformReservations({
    feishuRecords: [
      feishuRecord({ recordId: 'a', douyinAccount: '抖音号1', douyinStatus: '已发布' }),
      feishuRecord({ recordId: 'b', douyinAccount: '抖音号2', douyinStatus: '发布失败' }),
      feishuRecord({ recordId: 'c', douyinAccount: '抖音号3', douyinStatus: '待发布', publishTime: null }),
      feishuRecord({ recordId: 'd', douyinAccount: '', douyinStatus: '待发布' }),
      feishuRecord({ recordId: 'e', douyinAccount: '抖音号5', douyinStatus: '发布中' }),
    ],
  });
  assert.deepEqual(reservations.map(r => r.account), ['抖音号5']);
});

test('收集器：双表模式下只按记录所属平台取账号，不重复计入另一平台字段', () => {
  const reservations = collectPlatformReservations({
    feishuRecords: [feishuRecord({
      platform: '抖音',
      xiaohongshuAccount: '小红书号1',
      xiaohongshuStatus: '待发布',
      douyinAccount: '抖音号1',
      douyinStatus: '待发布',
    })],
  });
  assert.deepEqual(reservations.map(r => `${r.platform}:${r.account}`), ['douyin:抖音号1']);
});

test('收集器：时间窗之外的既有记录不参与判断', () => {
  const records = [
    // 很久以前的一条（2020 年），与本批 2026-07-16 毫无关系
    feishuRecord({ recordId: 'old', douyinAccount: '抖音号1', douyinStatus: '待发布', publishTime: new Date(2020, 0, 1, 9, 0) }),
    feishuRecord({ recordId: 'near', douyinAccount: '抖音号2', douyinStatus: '待发布', publishTime: new Date(2026, 6, 16, 9, 0) }),
  ];
  const batch = [new Date(2026, 6, 16, 12, 0).getTime()];
  const window = buildBatchWindow(batch, 361);
  const scoped = collectPlatformReservations({ feishuRecords: records, ...window });
  assert.deepEqual(scoped.map(r => r.account), ['抖音号2']);

  // 不给时间窗时两条都在（证明差异确实来自窗口过滤，而不是记录本身被丢了）
  assert.equal(collectPlatformReservations({ feishuRecords: records }).length, 2);

  // 窗口边界正好是 ±361 分钟
  assert.equal(window.windowStart, new Date(2026, 6, 16, 12, 0).getTime() - 361 * 60000);
  assert.equal(window.windowEnd, new Date(2026, 6, 16, 12, 0).getTime() + 361 * 60000);
});

test('收集器：窗外记录被剔除后，本批排期不再被它误拦', () => {
  const oldRecord = feishuRecord({
    douyinAccount: '抖音号1',
    douyinStatus: '待发布',
    publishTime: new Date(2020, 0, 1, 9, 0),
  });
  const window = buildBatchWindow([new Date(2026, 6, 16, 9, 0).getTime()], 361);
  const scoped = collectPlatformReservations({ feishuRecords: [oldRecord], ...window });
  const ok = validateImportSchedule(baseInput({
    schedule: [douyinItem({ publishTime: '2026-07-16 09:00' })],
    existingReservations: scoped.map(r => ({ platform: r.platform, scope: 'time', account: r.account, publishTime: r.publishTime })),
  }));
  assert.equal(ok.ok, true);
});

test('buildBatchWindow：没有任何时间戳时返回 null（调用方据此不做兜底）', () => {
  assert.equal(buildBatchWindow([], 361), null);
  assert.throws(() => buildBatchWindow([Date.now()], 0), /marginMinutes/);
});

test('collectPlanTimestamps：从 timeSlots / timeWindows 推出本批时间范围', () => {
  const fromSlots = collectPlanTimestamps({
    timeSlots: { regular: ['2026-09-01 08:00-08:30'], special: ['2026-09-03 22:00'] },
  });
  assert.deepEqual(
    [Math.min(...fromSlots), Math.max(...fromSlots)],
    [new Date(2026, 8, 1, 8, 0).getTime(), new Date(2026, 8, 3, 22, 0).getTime()]
  );

  const fromWindows = collectPlanTimestamps({
    timeWindows: { regular: [{ date: '2026-09-01', start: '08:00', end: '09:00' }] },
  });
  assert.deepEqual(
    [Math.min(...fromWindows), Math.max(...fromWindows)],
    [new Date(2026, 8, 1, 8, 0).getTime(), new Date(2026, 8, 1, 9, 0).getTime()]
  );

  assert.deepEqual(collectPlanTimestamps({}), []);
});

// ---------- 跨端契约：Python 分配器产出 → JS 校验器 ----------

// 直接调用本仓库的 scripts/schedule_allocator.py 生成一份真实排期，再喂给 JS 校验器。
// 两端各自实现同一套硬约束，这个用例保证它们不会各跑各的。accountGroups 现在是无条件
// 必填项（两端都是），店铺组按 4+4 拆成两组，时间窗按 4 天间隔排布，让 Python 端的
// 跨店铺 2880 分钟主动避让能在构造期就成功找到解，不必依赖搜索回溯。
const PYTHON_CONTRACT_SOURCE = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'scripts'))})
from schedule_allocator import allocate_schedule

templates = [str(i) for i in range(1, 9)]              # 8 个模板
topics = ["主题%02d" % i for i in range(1, 9)]         # 8 个主题 → 池 64
accounts_a = ["抖音号%d" % i for i in range(1, 5)]      # 店铺1 的 4 个抖音账号
accounts_b = ["抖音号%d" % i for i in range(5, 9)]      # 店铺2 的 4 个抖音账号
account_groups = {a: "店铺1" for a in accounts_a}
account_groups.update({a: "店铺2" for a in accounts_b})
slots = []
for date in ("2026-09-01", "2026-09-05", "2026-09-09"):  # 每隔 4 天一个窗口，天然满足跨店铺 2880 分钟
    slots.append(date + " 08:00-08:30")

payload = {
    "seed": "contract-test-seed",
    "noteFolders": [{"topic": t, "templates": list(templates)} for t in topics],
    "accounts": {"douyin": accounts_a + accounts_b},
    "accountGroups": account_groups,
    "timeSlots": {"regular": slots, "special": []},
    "coverageStrategy": "minimum",
    "allowPartialSchedule": True,
    "topicDecision": "none",
}
print(json.dumps({"payload": payload, "result": allocate_schedule(payload)}, ensure_ascii=False))
`;

test('跨端契约：Python 分配器产出的排期（含跨店铺 2880 分钟避让）能通过 JS 校验器', (t) => {
  const proc = spawnSync('python3', ['-c', PYTHON_CONTRACT_SOURCE], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (proc.error && proc.error.code === 'ENOENT') {
    t.skip('本机没有 python3，跳过跨端契约用例');
    return;
  }
  assert.equal(proc.status, 0, `python 分配器执行失败：${proc.stderr}`);

  const { payload, result } = JSON.parse(proc.stdout);
  assert.equal(result.stats.scheduledCount, 24); // 8 账号 × 3 时段
  assert.equal(result.stats.unscheduledCount, 40); // 64 池 - 24

  const validated = validateImportSchedule({
    seed: payload.seed,
    schedule: result.schedule,
    noteFolders: payload.noteFolders,
    accountGroups: payload.accountGroups,
    coverageStrategy: payload.coverageStrategy,
    allowPartialSchedule: payload.allowPartialSchedule,
    topicDecision: payload.topicDecision,
  });
  assert.equal(validated.ok, true);
  assert.equal(validated.stats.scheduledCount, 24);
  assert.equal(validated.constraints.uniqueMinuteAcrossBatch, true);
  // 同店铺 4 账号两两同主题组合会产出 approvals（规则 B），跨店铺的都被 Python 端主动避让掉，
  // 不应该有任何 topic_spacing violation（否则 validateImportSchedule 早就抛错了，走不到这里）。
  assert.ok(validated.approvals.length > 0, '同店铺内应该有 approvals 产出');
  assert.equal(validated.topicVolume.length, 8);
});

test('跨端契约：Python 分配器缺 accountGroups 时本地 fail-closed（不必等 JS 校验器）', () => {
  const SOURCE = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'scripts'))})
from schedule_allocator import allocate_schedule, ScheduleError
payload = {
    "seed": "missing-group-test",
    "noteFolders": [{"topic": "主题A", "templates": ["1", "2"]}],
    "accounts": {"douyin": ["抖音号1"]},
    "timeSlots": {"regular": ["2026-09-01 08:00-08:30"], "special": []},
    "coverageStrategy": "minimum",
    "allowPartialSchedule": True,
}
try:
    allocate_schedule(payload)
    print("UNEXPECTED_OK")
except ScheduleError as e:
    print("EXPECTED_ERROR:" + str(e))
`;
  const proc = spawnSync('python3', ['-c', SOURCE], { encoding: 'utf8' });
  if (proc.error && proc.error.code === 'ENOENT') return;
  assert.match(proc.stdout, /EXPECTED_ERROR:.*缺少店铺组映射/);
});
