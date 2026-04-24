const test = require('node:test');
const assert = require('node:assert/strict');

const {
  autoMapAccountMappings,
  buildDesiredAccountNamesFromRecords,
} = require('../src/account-mapping.js');

function collectAliases(account = {}) {
  return [
    account.platformAccountName,
    account.remarkName,
    account.alias,
  ].filter(Boolean);
}

test('buildDesiredAccountNamesFromRecords collects unique account names by platform', () => {
  const result = buildDesiredAccountNamesFromRecords([
    {
      xiaohongshuAccount: '沐沐老师',
      douyinAccount: '雅雅老师（课件看主页）',
    },
    {
      xiaohongshuAccount: '沐沐老师',
      douyinAccount: '小言老师',
    },
  ]);

  assert.deepEqual(result, {
    xiaohongshu: ['沐沐老师'],
    douyin: ['雅雅老师（课件看主页）', '小言老师'],
  });
});

test('autoMapAccountMappings adds missing mappings only for unique exact alias matches', () => {
  const config = {
    accountMapping: {
      xiaohongshu: {},
      douyin: {
        '雅雅老师': 'dy-existing',
      },
    },
  };

  const accounts = [
    {
      id: 'xhs-1',
      platformName: '小红书',
      platformAccountName: '沐沐老师',
    },
    {
      id: 'dy-1',
      platformName: '抖音',
      platformAccountName: '雅雅老师（课件看主页）',
      remarkName: '雅雅老师',
    },
    {
      id: 'dy-2',
      platformName: '抖音',
      platformAccountName: '小言老师',
    },
    {
      id: 'dy-3',
      platformName: '抖音',
      platformAccountName: '小言老师',
    },
  ];

  const result = autoMapAccountMappings(
    config,
    {
      xiaohongshu: ['沐沐老师'],
      douyin: ['雅雅老师', '小言老师'],
    },
    accounts,
    collectAliases
  );

  assert.equal(result.changed, true);
  assert.equal(config.accountMapping.xiaohongshu['沐沐老师'], 'xhs-1');
  assert.equal(config.accountMapping.douyin['雅雅老师'], 'dy-existing');
  assert.equal(config.accountMapping.douyin['小言老师'], undefined);
  assert.deepEqual(result.added, [
    {
      platformKey: 'xiaohongshu',
      accountName: '沐沐老师',
      accountId: 'xhs-1',
      matchedAlias: '沐沐老师',
    },
  ]);
});
