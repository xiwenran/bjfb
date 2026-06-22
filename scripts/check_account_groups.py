#!/usr/bin/env python3
"""
check_account_groups.py
检测 Zhifa accounts.json 中「同一平台的账号被重复分配」的情况。
重复分两类：
  - 组内重复：同一分组的同一平台列表里同一账号出现 ≥2 次
  - 跨组重复：同一账号出现在该平台的多个分组里
只报告，不删除，不修改任何文件。
"""

import json
import os
import sys
from collections import defaultdict

DEFAULT_PATH = os.path.expanduser("~/Library/Application Support/Zhifa/accounts.json")

PLATFORM_DISPLAY = {
    "xiaohongshu": "小红书",
    "douyin": "抖音",
}


def check(path: str) -> bool:
    """返回 True 表示发现了重复，False 表示无重复。"""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"❌ 文件不存在：{path}")
        sys.exit(2)
    except json.JSONDecodeError as e:
        print(f"❌ JSON 解析失败：{e}")
        sys.exit(2)

    account_groups = data.get("accountGroups", {})
    if not account_groups:
        print("⚠️  accountGroups 字段为空或不存在，无法检测。")
        return False

    # 收集数据：platform -> account -> [(group, count_in_group)]
    # 同时记录组内重复
    platform_account_groups: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    intra_duplicates: list[tuple] = []  # (platform_display, group, account, count)

    for group_name, platforms in account_groups.items():
        if not isinstance(platforms, dict):
            continue
        for platform_key, accounts in platforms.items():
            if not isinstance(accounts, list):
                continue
            platform_display = PLATFORM_DISPLAY.get(platform_key, platform_key)

            # 统计组内每个账号出现次数
            seen_in_group: dict[str, int] = defaultdict(int)
            for account in accounts:
                seen_in_group[account] += 1

            for account, count in seen_in_group.items():
                # 记录该账号在该平台下出现过哪些分组（去重：每个分组最多登记一次）
                platform_account_groups[platform_display][account].append(group_name)
                if count >= 2:
                    intra_duplicates.append((platform_display, group_name, account, count))

    # 找跨组重复
    cross_duplicates: list[tuple] = []  # (platform_display, account, [group1, group2, ...])
    for platform_display, account_map in platform_account_groups.items():
        for account, groups in account_map.items():
            if len(groups) >= 2:
                cross_duplicates.append((platform_display, account, groups))

    has_issue = bool(intra_duplicates or cross_duplicates)

    if not has_issue:
        print("✅ 各平台分组无重复账号")
        return False

    print("⚠️  发现以下账号重复分配问题：\n")

    if intra_duplicates:
        print("【组内重复】（同一分组的同一平台列表里同一账号出现多次）")
        for platform_display, group, account, count in intra_duplicates:
            print(f"  平台：{platform_display}  分组：{group}  账号：{account}  重复次数：{count} 次")
        print()

    if cross_duplicates:
        print("【跨组重复】（同一账号出现在该平台的多个分组里）")
        for platform_display, account, groups in cross_duplicates:
            groups_str = "、".join(groups)
            print(f"  平台：{platform_display}  账号：{account}  出现在：{groups_str}")
        print()

    return True


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PATH
    has_issue = check(path)
    sys.exit(1 if has_issue else 0)


if __name__ == "__main__":
    main()
