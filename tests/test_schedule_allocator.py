#!/usr/bin/env python3
"""
schedule_allocator.py 的单元测试。

项目里现有测试都是 `tests/*.test.js`（node:test），Python 侧目前没有既定约定，
本文件按语言边界单独放在 tests/ 下，用标准库 unittest（不新增依赖），
可用以下任一方式运行：
    python3 -m unittest tests.test_schedule_allocator -v
    python3 tests/test_schedule_allocator.py
"""

import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts"))

from schedule_allocator import (  # noqa: E402
    ScheduleError,
    allocate_schedule,
    parse_publish_time_to_abs_minute,
)

# minCrossStoreTopicIntervalMinutes 现在是无条件消费的字段（规则 A：跨店铺同主题跨账号间隔），
# 缺失会在 load_constraints() 校验时直接报错——这份测试夹具必须跟真实的
# src/schedule-constraints.json 同口径，否则连 seed 校验这类无关用例都会先被这里拦下。
# topicVolumeWindowDays/topicVolumeMaxCount/topicVolumeLongWindowDays 是规则 C/D 用的，
# Python 分配器本身不消费（那两条规则需要跨批历史数据，只有服务端能看到，见
# scheduler-allocator.js 的 checkTopicVolume），这里补全只是为了让夹具字段和生产配置一致。
CONSTRAINTS = {
    "minSameAccountIntervalMinutes": 361,
    "uniqueMinuteAcrossBatch": True,
    "minCrossStoreTopicIntervalMinutes": 2880,
    "topicVolumeWindowDays": 7,
    "topicVolumeMaxCount": 10,
    "topicVolumeLongWindowDays": 30,
}


def note_folders(topics: int, templates: int) -> list[dict]:
    template_names = [f"T{i}" for i in range(templates)]
    return [
        {"topic": f"topic{i}", "templates": list(template_names)}
        for i in range(topics)
    ]


def base_payload(**overrides) -> dict:
    payload = {
        "seed": "unit-test-seed",
        "accounts": {
            "xiaohongshu_regular": ["xhs_a", "xhs_b"],
            "xiaohongshu_special": [],
            "douyin": ["dy_a"],
        },
        "accountGroups": {"xhs_a": "store1", "xhs_b": "store1", "dy_a": "store1"},
        "timeSlots": {
            "regular": [
                "2026-08-01 06:00-22:00",
                "2026-08-02 06:00-22:00",
                "2026-08-03 06:00-22:00",
            ],
            "special": [],
        },
        "coverageStrategy": "minimum",
        "noteFolders": note_folders(5, 3),
        # 大多数约束测试只关心排期结果是否满足硬约束，不关心是否把 noteKey 池
        # 用满；覆盖完整性单独在 PartialScheduleTests 里测。
        "allowPartialSchedule": True,
    }
    payload.update(overrides)
    return payload


def abs_minute(publish_time: str) -> int:
    value = parse_publish_time_to_abs_minute(publish_time)
    assert value is not None, publish_time
    return value


class ConstraintTests(unittest.TestCase):
    """五条硬约束逐条验证。"""

    def test_constraint1_same_account_interval(self):
        """约束 1：同平台同账号任意两条间隔 >= minGap。"""
        result = allocate_schedule(base_payload(), CONSTRAINTS)
        by_account: dict[str, list[int]] = {}
        for item in result["schedule"]:
            key = f"{item['platform']}:{item['account']}"
            by_account.setdefault(key, []).append(abs_minute(item["publishTime"]))
        for key, minutes in by_account.items():
            minutes.sort()
            for i in range(len(minutes) - 1):
                gap = minutes[i + 1] - minutes[i]
                self.assertGreaterEqual(gap, 361, f"{key} 两次发布间隔 {gap} 分钟 < 361")

    def test_constraint1_violation_reports_diagnosis(self):
        """窗口太窄导致同账号间隔不足时，必须报出具体账号和差值，而不是笼统报错。"""
        payload = base_payload(
            accounts={
                "xiaohongshu_regular": ["only_acct"],
                "xiaohongshu_special": [],
                "douyin": [],
            },
            accountGroups={"only_acct": "store1"},
            timeSlots={
                # 两个精确分钟槽，间隔只有 10 分钟，必然低于 361
                "regular": ["2026-08-01 06:00", "2026-08-01 06:10"],
                "special": [],
            },
            noteFolders=note_folders(2, 2),
        )
        with self.assertRaises(ScheduleError) as ctx:
            allocate_schedule(payload, CONSTRAINTS)
        message = str(ctx.exception)
        self.assertIn("only_acct", message)
        self.assertIn("分钟", message)

    def test_constraint2_global_minute_uniqueness_and_existing_reservations(self):
        """约束 2：全局分钟唯一，且不能与 existingReservations 相撞。"""
        reserved_time = "2026-08-01 10:00"
        payload = base_payload(
            # 用批次外的账号占位一个分钟，只测全局分钟唯一性，
            # 不引入这条既有排期与本批同账号间隔的额外约束（那部分见约束 1 的测试）。
            existingReservations=[
                {
                    "platform": "xiaohongshu",
                    "account": "other_existing_acct",
                    "publishTime": reserved_time,
                    "topicKey": "topic0",
                    "storeGroup": "store1",
                }
            ]
        )
        result = allocate_schedule(payload, CONSTRAINTS)
        publish_times = [item["publishTime"] for item in result["schedule"]]
        self.assertEqual(len(publish_times), len(set(publish_times)), "全局分钟必须唯一")
        self.assertNotIn(reserved_time, publish_times, "不能与 existingReservations 撞分钟")

    def test_constraint3_no_duplicate_notekey_within_platform(self):
        """约束 3：同平台内 noteKey 不重复。"""
        result = allocate_schedule(base_payload(), CONSTRAINTS)
        by_platform: dict[str, list[str]] = {}
        for item in result["schedule"]:
            by_platform.setdefault(item["platform"], []).append(item["noteKey"])
        for platform, keys in by_platform.items():
            self.assertEqual(len(keys), len(set(keys)), f"{platform} 内 noteKey 重复：{keys}")

    def test_constraint4_no_duplicate_template_within_account(self):
        """约束 4：同账号内 template 不重复。"""
        result = allocate_schedule(base_payload(), CONSTRAINTS)
        by_account: dict[str, list[str]] = {}
        for item in result["schedule"]:
            key = f"{item['platform']}:{item['account']}"
            template = item["noteKey"].rsplit("/", 1)[1]
            by_account.setdefault(key, []).append(template)
        for key, templates in by_account.items():
            self.assertEqual(len(templates), len(set(templates)), f"{key} 内 template 重复：{templates}")

    def test_constraint4_violation_when_occurrences_exceed_templates(self):
        """账号发布次数超过模板总数时，无法避免模板重复，必须提前报出具体缺口。"""
        payload = base_payload(
            accounts={
                "xiaohongshu_regular": ["only_acct"],
                "xiaohongshu_special": [],
                "douyin": [],
            },
            accountGroups={"only_acct": "store1"},
            timeSlots={
                "regular": [
                    "2026-08-01 06:00-22:00",
                    "2026-08-02 06:00-22:00",
                    "2026-08-03 06:00-22:00",
                ],
                "special": [],
            },
            noteFolders=note_folders(5, 2),  # 只有 2 种模板，但账号要发 3 次
        )
        with self.assertRaises(ScheduleError) as ctx:
            allocate_schedule(payload, CONSTRAINTS)
        message = str(ctx.exception)
        self.assertIn("only_acct", message)
        self.assertIn("2 种模板", message)

    def test_rule_a_cross_store_topic_gap_across_accounts(self):
        """规则 A（2026-08 重写）：跨店铺同主题跨账号间隔 >= minCrossStoreTopicIntervalMinutes；
        同账号之间、同店铺账号之间都不受此约束——同店铺是规则 B（人工审批），不影响本地构造。
        旧版这里测的是"同店铺跨账号"，那条规则已经被推翻（同店铺现在不做时间避让），
        改成跨店铺账号来验证真正的规则 A。"""
        payload = base_payload(
            accounts={
                "xiaohongshu_regular": ["acct_a", "acct_b"],
                "xiaohongshu_special": [],
                "douyin": [],
            },
            accountGroups={"acct_a": "store1", "acct_b": "store2"},  # 跨店铺
            timeSlots={
                "regular": [
                    "2026-08-01 06:00-22:00",
                    "2026-08-05 06:00-22:00",
                    "2026-08-09 06:00-22:00",
                ],
                "special": [],
            },
            noteFolders=note_folders(3, 3),
        )
        result = allocate_schedule(payload, CONSTRAINTS)
        by_topic: dict[tuple, list[tuple[str, str, int]]] = {}
        for item in result["schedule"]:
            if not item["storeGroup"]:
                continue
            key = (item["platform"], item["topicKey"])
            by_topic.setdefault(key, []).append((item["storeGroup"], item["account"], abs_minute(item["publishTime"])))
        for key, entries in by_topic.items():
            for i in range(len(entries)):
                for j in range(i + 1, len(entries)):
                    store_i, acc_i, min_i = entries[i]
                    store_j, acc_j, min_j = entries[j]
                    if acc_i == acc_j or store_i == store_j:
                        continue  # 同账号或同店铺不受规则 A 约束
                    self.assertGreaterEqual(
                        abs(min_i - min_j), 2880, f"{key} 下跨店铺 {acc_i}/{acc_j} 同主题间隔不足"
                    )

    def test_rule_a_violation_reports_diagnosis(self):
        """故意用极窄的精确分钟槽制造跨店铺冲突，必须报出具体账号/差值可执行诊断。"""
        payload = base_payload(
            accounts={
                "xiaohongshu_regular": ["acct_a", "acct_b"],
                "xiaohongshu_special": [],
                "douyin": [],
            },
            accountGroups={"acct_a": "store1", "acct_b": "store2"},  # 跨店铺
            timeSlots={
                # 只给一个共享的 10 分钟窄窗口：每个账号只发 1 次，不触发约束 1
                # （同账号只有一条记录，没有相邻间隔可比较），专门测规则 A——
                # 两个账号在窗口内的分钟差必然 < 2880，且是跨店铺，逃不掉硬约束。
                "regular": ["2026-08-01 06:00-06:09"],
                "special": [],
            },
            noteFolders=note_folders(1, 2),  # 只有一个主题，两个账号必然撞同一个主题
            allowPartialSchedule=True,
        )
        with self.assertRaises(ScheduleError) as ctx:
            allocate_schedule(payload, CONSTRAINTS)
        message = str(ctx.exception)
        # 构造过程会在挑主题阶段就主动避让规则 A，只有 1 个主题、2 个跨店铺账号
        # 时无主题可选，因此诊断来自 noteKey 分配步骤而不是事后校验；断言只要求
        # 诊断包含"是哪个账号 + 为什么找不到"这个可执行信息，不锁死具体措辞。
        self.assertIn("acct_b", message)
        self.assertIn("找不到可用 noteKey", message)
        self.assertIn("间隔内冲突", message)


class ReproducibilityTests(unittest.TestCase):
    def test_same_seed_same_input_reproducible(self):
        payload1 = base_payload()
        payload2 = base_payload()
        result1 = allocate_schedule(payload1, CONSTRAINTS)
        result2 = allocate_schedule(payload2, CONSTRAINTS)
        self.assertEqual(result1["schedule"], result2["schedule"])
        self.assertEqual(result1["unscheduled"], result2["unscheduled"])

    def test_different_seed_can_differ(self):
        payload_a = base_payload(seed="seed-a")
        payload_b = base_payload(seed="seed-b")
        result_a = allocate_schedule(payload_a, CONSTRAINTS)
        result_b = allocate_schedule(payload_b, CONSTRAINTS)
        # 不强制要求一定不同（理论上可能巧合相同），但至少两次调用都必须成功且内部自洽。
        self.assertEqual(len(result_a["schedule"]), len(result_b["schedule"]))


class PartialScheduleTests(unittest.TestCase):
    def test_default_mode_fails_when_notes_not_fully_covered(self):
        """默认模式：noteKey 池没被完全用完时，必须整批报错。"""
        payload = base_payload(noteFolders=note_folders(50, 3), allowPartialSchedule=False)  # 池远大于任务数
        with self.assertRaises(ScheduleError) as ctx:
            allocate_schedule(payload, CONSTRAINTS)
        self.assertIn("无法覆盖全部 noteKey", str(ctx.exception))

    def test_allow_partial_schedule_returns_unscheduled_instead_of_failing(self):
        payload = base_payload(noteFolders=note_folders(50, 3), allowPartialSchedule=True)
        result = allocate_schedule(payload, CONSTRAINTS)
        self.assertGreater(result["stats"]["unscheduledCount"], 0)
        self.assertEqual(result["stats"]["scheduledCount"], len(result["schedule"]))


class MiscTests(unittest.TestCase):
    def test_missing_seed_raises_clear_error(self):
        payload = base_payload(seed="")
        with self.assertRaises(ScheduleError) as ctx:
            allocate_schedule(payload, CONSTRAINTS)
        self.assertIn("seed", str(ctx.exception))

    def test_heterogeneous_template_sets_raise_clear_error(self):
        payload = base_payload(noteFolders=[
            {"topic": "topicA", "templates": ["T0", "T1", "T2"]},
            {"topic": "topicB", "templates": ["T0", "T1"]},  # 缺 T2
        ])
        with self.assertRaises(ScheduleError) as ctx:
            allocate_schedule(payload, CONSTRAINTS)
        message = str(ctx.exception)
        self.assertIn("topicB", message)
        self.assertIn("缺少", message)


class PlatformAgnosticReservationTests(unittest.TestCase):
    """服务端 topic-spacing-check 透传下来的平台无关既有排期（无 topicKey / storeGroup）。

    这一路条目小红书和抖音都有，只服务约束 1（同账号间隔）和约束 2（分钟唯一），
    不参与约束 5——它没有主题和店铺组信息。
    """

    def test_douyin_reservation_minute_is_avoided(self):
        reserved_time = "2026-08-01 10:00"
        payload = base_payload(
            existingReservations=[
                {"platform": "douyin", "account": "other_dy_acct", "publishTime": reserved_time}
            ]
        )
        result = allocate_schedule(payload, CONSTRAINTS)
        publish_times = [item["publishTime"] for item in result["schedule"]]
        self.assertNotIn(reserved_time, publish_times, "不能与抖音既有排期撞分钟")

    def test_douyin_reservation_keeps_same_account_gap(self):
        reserved_time = "2026-08-01 10:00"
        reserved_abs = abs_minute(reserved_time)
        payload = base_payload(
            existingReservations=[
                # 与本批次里的抖音账号 dy_a 同名，必须撑开 361 分钟间隔
                {"platform": "douyin", "account": "dy_a", "publishTime": reserved_time}
            ]
        )
        result = allocate_schedule(payload, CONSTRAINTS)
        for item in result["schedule"]:
            if item["platform"] != "douyin" or item["account"] != "dy_a":
                continue
            gap = abs(abs_minute(item["publishTime"]) - reserved_abs)
            self.assertGreaterEqual(
                gap,
                CONSTRAINTS["minSameAccountIntervalMinutes"],
                f"{item['publishTime']} 与既有排期 {reserved_time} 间隔仅 {gap} 分钟",
            )

    def test_reservation_without_topic_does_not_break_rule_a(self):
        """无 topicKey / storeGroup 的条目应被跳过，而不是让求解失败——规则 A 现在无条件执行，
        不再需要 topicDecision='auto_space' 才生效，这里特意不传它来验证这一点。"""
        payload = base_payload(
            existingReservations=[
                {"platform": "douyin", "account": "other_dy_acct", "publishTime": "2026-08-01 10:00"},
                {"platform": "xiaohongshu", "account": "other_xhs_acct", "publishTime": "2026-08-01 11:00"},
            ],
        )
        result = allocate_schedule(payload, CONSTRAINTS)
        self.assertGreater(len(result["schedule"]), 0)


class RuleATests(unittest.TestCase):
    """规则 A（2026-08 重写）专项正向用例：跨店铺 2880 分钟避让、同店铺不避让、抖音纳入、
    店铺组映射无条件必填。跟 ConstraintTests 里的 test_rule_a_* 側重"事后校验硬约束"不同，
    这里侧重"给定拓扑，Python 构造器能不能正确产出/正确拒绝"。"""

    def test_cross_store_topic_gap_is_avoided_during_construction(self):
        """跨店铺同主题跨账号：构造期主动避让应该成功产出满足 2880 分钟间隔的排期，
        不需要走到事后校验报错——这是规则 A 的核心行为。"""
        payload = base_payload(
            accounts={
                "xiaohongshu_regular": ["acct_a", "acct_b"],
                "xiaohongshu_special": [],
                "douyin": [],
            },
            accountGroups={"acct_a": "store1", "acct_b": "store2"},
            timeSlots={
                "regular": [
                    "2026-08-01 06:00-22:00",
                    "2026-08-05 06:00-22:00",
                ],
                "special": [],
            },
            noteFolders=note_folders(2, 2),
        )
        result = allocate_schedule(payload, CONSTRAINTS)  # 不应该报错
        self.assertGreater(len(result["schedule"]), 0)

    def test_same_store_not_time_restricted(self):
        """同店铺账号发同一主题，即使窗口很窄也不会被规则 A 拦——它是纯规则 B
        （人工审批），只在服务端 checkTopicSpacing 产出 approvals，不影响本地构造。"""
        payload = base_payload(
            accounts={
                "xiaohongshu_regular": ["acct_a", "acct_b"],
                "xiaohongshu_special": [],
                "douyin": [],
            },
            accountGroups={"acct_a": "store1", "acct_b": "store1"},  # 同店铺
            timeSlots={"regular": ["2026-08-01 06:00-06:09"], "special": []},
            noteFolders=note_folders(1, 2),
            allowPartialSchedule=True,
        )
        result = allocate_schedule(payload, CONSTRAINTS)  # 不应该报错
        self.assertGreater(len(result["schedule"]), 0)

    def test_douyin_accounts_are_covered_by_rule_a(self):
        """抖音账号同样要求店铺组映射，跨店铺同主题间隔同样受约束——旧实现完全不检查抖音。"""
        payload = base_payload(
            accounts={"xiaohongshu_regular": [], "xiaohongshu_special": [], "douyin": ["dy_x", "dy_y"]},
            accountGroups={"dy_x": "storeX", "dy_y": "storeY"},
            timeSlots={
                "regular": [
                    "2026-08-01 06:00-22:00",
                    "2026-08-05 06:00-22:00",
                ],
                "special": [],
            },
            noteFolders=note_folders(2, 2),
        )
        result = allocate_schedule(payload, CONSTRAINTS)
        by_topic: dict[tuple, list[tuple[str, str, int]]] = {}
        for item in result["schedule"]:
            key = (item["platform"], item["topicKey"])
            by_topic.setdefault(key, []).append((item["storeGroup"], item["account"], abs_minute(item["publishTime"])))
        for key, entries in by_topic.items():
            for i in range(len(entries)):
                for j in range(i + 1, len(entries)):
                    store_i, acc_i, min_i = entries[i]
                    store_j, acc_j, min_j = entries[j]
                    if acc_i == acc_j or store_i == store_j:
                        continue
                    self.assertGreaterEqual(abs(min_i - min_j), 2880, f"{key} 下抖音跨店铺 {acc_i}/{acc_j} 间隔不足")

    def test_missing_account_group_fails_closed_unconditionally(self):
        """店铺组映射现在无条件必填——不再局限于 auto_space + 小红书，抖音账号缺映射同样
        fail-closed（旧实现里这里会直接放行，因为旧检查只在 auto_space + 小红书时才生效）。"""
        payload = base_payload(
            accounts={"xiaohongshu_regular": [], "xiaohongshu_special": [], "douyin": ["dy_no_group"]},
            accountGroups={},
        )
        with self.assertRaises(ScheduleError) as ctx:
            allocate_schedule(payload, CONSTRAINTS)
        message = str(ctx.exception)
        self.assertIn("dy_no_group", message)
        self.assertIn("缺少店铺组映射", message)


if __name__ == "__main__":
    unittest.main()
