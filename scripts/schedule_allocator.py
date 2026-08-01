#!/usr/bin/env python3
"""
本地构造式排期分配器（schedule_allocator.py）

背景
----
原方案由服务端 `POST /api/import/schedule` 用全局 DFS 回溯求解账号 × 时间 × 笔记的
排期分配，约束密集时会指数爆炸、把整个 App 卡死。现方案把求解挪到本地：本模块用
O(n) 构造法直接生成排期，服务端 `/api/import/schedule` 只做只读校验（逐条核对下面
五条硬约束），不再搜索。

五条硬约束（服务端校验器会 fail-closed 逐条查，不合规整批拒收）
----------------------------------------------------------
1. 同平台同账号任意两条间隔 ≥ 配置的最小间隔（默认 361 分钟）
2. 全批次 publishTime 分钟全局唯一，且不能与 existingReservations 已有排期的分钟相撞
3. 同平台内 noteKey 不重复
4. 同账号内 template 不重复（template = noteKey `topic/template` 的后半段）
5. topicDecision == 'auto_space' 时，同 storeGroup 同 topicKey 跨不同账号间隔 ≥ 最小间隔
   （同账号之间不受此约束）

构造思路（对应任务书要求，不做搜索回溯）
----------------------------------
1. noteKey 池 = 主题 × 模板笛卡尔积。要求每个主题的模板集合一致（否则明确报错指出
   哪个主题缺/多了哪些模板），池按「主题为高位、模板为低位」排列成一维数组：
   pool[k] = (topic_idx * 模板数T + template_idx)。

2. 每个账号在“自己的第 t 次发布”（t = 0,1,2,...）用账号序号 i 求
   raw = (i + t) % N（N = 池大小）作为候选下标：
     - 同一账号自己的连续 t 值只差 1，template_idx = raw % T 也只差 1（mod T），
       只要该账号发布次数 ≤ 模板总数 T，模板天然不重复（约束 4 的核心保证）。
     - (i + t) 这个求和本身不是严格单射，两个不同的 (账号, 次数) 组合可能撞到同一个
       raw；这里不回溯重排，而是做“确定性线性探测”：从 raw 往后顺延，跳过已被
       本平台占用的下标、以及模板已被本账号用过的下标，取第一个同时满足两者的
       空位。这是开放寻址式的确定性顺延，不是组合回溯——每个下标至多被检查一次
       归属，整体是关于 (账号数 × 每账号次数 × 池大小) 的线性/低阶多项式复杂度，
       不会指数爆炸。顺延用尽整个池仍找不到位置时，直接抛出诊断（是池耗尽还是
       模板全冲突，各占用了多少）。

3. 每个时间窗口按落在该窗口的任务数切成互不重叠的等长分段，每段内用 seed 驱动的
   伪随机取一分钟；分段互不重叠 ⇒ 同窗口内分钟天然唯一。existingReservations 里
   已占用的分钟会预先登记，避免跨批撞车；某一段整体已被占满时，直接报告是哪个
   窗口的第几段。

4. 约束 1（同账号相邻间隔）与约束 5（auto_space 时同店铺同主题跨账号间隔）在
   构造完成后统一校验一次：不满足就直接抛出带具体账号 / 时段 / 差值的诊断错误，
   不做退回搜索式修正——这是任务书明确要求的行为：真排不出来就报诊断，不是
   悄悄退化成回溯。

需要随机性的地方（账号顺序、分段内挑哪一分钟等）全部由 `random.Random(seed)` 驱动，
同 seed 同输入必然得到同一个解，可复算。

输出契约（不改动，与原服务端返回一致）
----------------------------
{
  "schedule": [{"topic", "topicKey", "noteKey", "platform", "account",
                "storeGroup", "publishTime"}],
  "unscheduled": [noteKey, ...],
  "stats": {"scheduledCount", "unscheduledCount", "coverageStrategy",
            "violations": [...], "warnings": [...]},
  "constraints": {"minSameAccountIntervalMinutes", "uniqueMinuteAcrossBatch", "seed"}
}

用法
----
作为库：
    from schedule_allocator import allocate_schedule
    result = allocate_schedule(request_payload, constraints)

作为独立 CLI（输入 scan.json + plan.json，输出 schedule.json）：
    python3 schedule_allocator.py <scan.json> <plan.json> [--output schedule.json]

CLI 模式下 plan.json 必须已经是"标准化"后的调度参数（即已经含 timeSlots，不再是
timeWindows / timeHint 这种待展开的简写）——skill_upload.py 的
normalize_schedule_plan_payload 负责这层展开，schedule_allocator 本身不重复实现，
避免两处逻辑不同步。
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import random
import re
import sys

SUPPORTED_PLATFORMS = ("xiaohongshu", "douyin")

DEFAULT_CONSTRAINTS_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "src", "schedule-constraints.json"
)


class ScheduleError(Exception):
    """排期无解或输入不满足硬约束时抛出。message 必须包含可执行诊断
    （哪个账号 / 哪个时段 / 缺多少），不允许只写"排不下"这种笼统文案。"""


# ---------------------------------------------------------------------------
# 约束配置
# ---------------------------------------------------------------------------

def load_constraints(path: str | None = None) -> dict:
    """读取 src/schedule-constraints.json。

    文件缺失即报错（fail-closed），与 JS 端校验器 readFileSync 的失败姿态保持一致：
    约束是硬红线，缺配置时自动写一份默认值等于让本地端自己决定红线取值，
    两端就可能各按各的约束跑。
    """
    target = os.path.abspath(path or DEFAULT_CONSTRAINTS_PATH)
    if not os.path.isfile(target):
        raise ScheduleError(
            f"约束配置文件不存在：{target}。请先恢复该文件（内容需含 minSameAccountIntervalMinutes），"
            "不自动写入默认值，避免本地与服务端按不同约束跑。"
        )
    with open(target, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or "minSameAccountIntervalMinutes" not in data:
        raise ScheduleError(
            f"约束配置文件格式错误：{target} 缺少 minSameAccountIntervalMinutes 字段"
        )
    return data


# ---------------------------------------------------------------------------
# noteKey 池（主题 × 模板笛卡尔积）
# ---------------------------------------------------------------------------

def build_note_pool(note_folders) -> tuple[list[tuple[str, str]], int, int]:
    if not isinstance(note_folders, list) or not note_folders:
        raise ScheduleError("noteFolders 必须是非空数组")

    topics: list[tuple[str, list[str]]] = []
    seen_topics: set[str] = set()
    for folder in note_folders:
        if not isinstance(folder, dict):
            raise ScheduleError("noteFolders 中存在非对象项")
        topic = str(folder.get("topic") or "").strip()
        if not topic:
            raise ScheduleError("noteFolders 中存在空 topic")
        if topic in seen_topics:
            raise ScheduleError(f"主题「{topic}」在 noteFolders 中重复出现")
        seen_topics.add(topic)
        templates_raw = folder.get("templates")
        if not isinstance(templates_raw, list):
            raise ScheduleError(f"主题「{topic}」的 templates 必须是数组")
        templates = [str(t).strip() for t in templates_raw if str(t or "").strip()]
        if not templates:
            raise ScheduleError(f"主题「{topic}」没有可用模板")
        if len(set(templates)) != len(templates):
            dup = [t for t in templates if templates.count(t) > 1]
            raise ScheduleError(f"主题「{topic}」内部模板重复：{sorted(set(dup))}")
        topics.append((topic, templates))

    base_topic, base_templates = topics[0]
    base_set = set(base_templates)
    for topic, templates in topics[1:]:
        cur_set = set(templates)
        if cur_set != base_set:
            missing = sorted(base_set - cur_set)
            extra = sorted(cur_set - base_set)
            parts = []
            if missing:
                parts.append(f"缺少 {missing}")
            if extra:
                parts.append(f"多出 {extra}")
            raise ScheduleError(
                f"主题间模板集合不一致，无法构造统一 noteKey 池：主题「{topic}」相对基准主题"
                f"「{base_topic}」" + "、".join(parts)
            )

    template_rank = {t: idx for idx, t in enumerate(base_templates)}
    pool: list[tuple[str, str]] = []
    for topic, templates in topics:
        ordered = sorted(templates, key=lambda t: template_rank[t])
        for template in ordered:
            pool.append((topic, template))

    topic_count = len(topics)
    template_count = len(base_templates)
    return pool, topic_count, template_count


# ---------------------------------------------------------------------------
# 账号 / 时段
# ---------------------------------------------------------------------------

def normalize_coverage_strategy(value) -> str:
    raw = str(value or "").strip() or "minimum"
    aliases = {
        "strict": "strict", "严格覆盖": "strict",
        "balanced": "balanced", "尽量覆盖": "balanced",
        "minimum": "minimum", "只保底发布": "minimum",
    }
    if raw not in aliases:
        raise ScheduleError("coverageStrategy 仅支持 strict/严格覆盖、balanced/尽量覆盖、minimum/只保底发布")
    return aliases[raw]


def build_accounts(payload: dict, rng: random.Random) -> list[dict]:
    accounts_raw = payload.get("accounts")
    time_slots = payload.get("timeSlots")
    if not isinstance(accounts_raw, dict):
        raise ScheduleError("排期参数缺少 accounts 对象")
    if not isinstance(time_slots, dict):
        raise ScheduleError("排期参数缺少 timeSlots 对象")
    regular_slots = [str(v).strip() for v in (time_slots.get("regular") or []) if str(v or "").strip()]
    special_slots = [str(v).strip() for v in (time_slots.get("special") or []) if str(v or "").strip()]
    account_groups = payload.get("accountGroups")
    account_groups = account_groups if isinstance(account_groups, dict) else {}
    topic_decision = str(payload.get("topicDecision") or "").strip()

    definitions = [
        ("xiaohongshu", "regular", accounts_raw.get("xiaohongshu_regular") or [], regular_slots),
        ("xiaohongshu", "special", accounts_raw.get("xiaohongshu_special") or [], special_slots),
        ("douyin", "regular", accounts_raw.get("douyin") or [], regular_slots),
    ]

    accounts: list[dict] = []
    seen_keys: set[str] = set()
    for platform, slot_type, raw_names, slots in definitions:
        names = [str(n).strip() for n in raw_names if str(n or "").strip()]
        if names and not slots:
            raise ScheduleError(f"{slot_type} 时段为空，无法调度 {platform} 账号")
        for account in names:
            key = f"{platform}:{account}"
            if key in seen_keys:
                raise ScheduleError(f"账号重复：{key}")
            seen_keys.add(key)
            store_group = str(account_groups.get(account) or "").strip()
            if platform == "xiaohongshu" and topic_decision == "auto_space" and not store_group:
                raise ScheduleError(f"小红书账号「{account}」缺少店铺组映射（accountGroups 未覆盖）")
            accounts.append({
                "platform": platform,
                "account": account,
                "accountKey": key,
                "storeGroup": store_group,
                "slots": list(slots),
                "slotType": slot_type,
            })

    if not accounts:
        raise ScheduleError("accounts 中没有可调度账号")

    # 顺序只影响“账号序号 i”的具体取值，不影响正确性；由 seed 驱动保证可复算。
    shuffled = accounts[:]
    rng.shuffle(shuffled)
    return shuffled


def build_reservations(value) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ScheduleError("existingReservations 必须是数组")
    reservations = []
    for item in value:
        if not isinstance(item, dict):
            raise ScheduleError("existingReservations 中存在非对象项")
        platform = str(item.get("platform") or "").strip()
        account = str(item.get("account") or "").strip()
        publish_time = str(item.get("publishTime") or "").strip()
        if platform not in SUPPORTED_PLATFORMS or not account or not publish_time:
            raise ScheduleError("existingReservations 中存在缺少合法 platform/account/publishTime 的记录")
        abs_minute = parse_publish_time_to_abs_minute(publish_time)
        if abs_minute is None:
            raise ScheduleError(f"existingReservations 中 publishTime 无法解析：{publish_time!r}")
        reservations.append({
            "platform": platform,
            "account": account,
            "accountKey": f"{platform}:{account}",
            "publishTime": publish_time,
            "absMinute": abs_minute,
            "topicKey": str(item.get("topicKey") or "").strip(),
            "storeGroup": str(item.get("storeGroup") or "").strip(),
        })
    return reservations


# ---------------------------------------------------------------------------
# 时间窗口解析与分段
# ---------------------------------------------------------------------------

_WINDOW_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$")
_EXACT_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})$")


def _abs_minute(date_str: str, hh: int, mm: int) -> int:
    return datetime.date.fromisoformat(date_str).toordinal() * 1440 + hh * 60 + mm


def _format_publish_time(date_str: str, abs_minute_in_day: int) -> str:
    hh, mm = divmod(abs_minute_in_day, 60)
    return f"{date_str} {hh:02d}:{mm:02d}"


def _abs_to_date_minute(abs_minute: int) -> tuple[str, int]:
    """把「自 0001-01-01 起的分钟数」还原成 (ISO 日期字符串, 当天第几分钟)。"""
    day_ordinal, minute_in_day = divmod(abs_minute, 1440)
    return datetime.date.fromordinal(day_ordinal).isoformat(), minute_in_day


def parse_publish_time_to_abs_minute(value: str) -> int | None:
    match = _EXACT_RE.match(str(value or "").strip())
    if not match:
        return None
    date_str, hh, mm = match.group(1), int(match.group(2)), int(match.group(3))
    if hh > 23 or mm > 59:
        return None
    try:
        return _abs_minute(date_str, hh, mm)
    except ValueError:
        return None


def parse_slot_window(value: str):
    """返回 (date_str, start_abs_minute, end_abs_minute) 或 None（表示非区间，可能是精确分钟）。"""
    match = _WINDOW_RE.match(str(value or "").strip())
    if not match:
        return None
    date_str = match.group(1)
    sh, sm, eh, em = int(match.group(2)), int(match.group(3)), int(match.group(4)), int(match.group(5))
    if sh > 23 or sm > 59 or eh > 23 or em > 59:
        raise ScheduleError(f"时间窗非法：{value}")
    start = _abs_minute(date_str, sh, sm)
    end = _abs_minute(date_str, eh, em)
    if end < start:
        raise ScheduleError(f"时间窗非法（结束早于开始）：{value}")
    return date_str, start, end


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def allocate_schedule(payload: dict, constraints: dict | None = None) -> dict:
    constraints = constraints or load_constraints()
    # 间隔必须是正整数：与 JS 端 loadConstraints 的 `<= 0 即抛错` 口径一致，
    # 不接受 0 / 负数 / 非数字悄悄退化成"没有间隔约束"。
    raw_min_gap = constraints.get("minSameAccountIntervalMinutes")
    try:
        min_gap = int(raw_min_gap)
    except (TypeError, ValueError):
        raise ScheduleError(
            f"约束配置 minSameAccountIntervalMinutes 无效：{raw_min_gap!r}，必须是正整数分钟数"
        )
    if min_gap <= 0:
        raise ScheduleError(
            f"约束配置 minSameAccountIntervalMinutes 无效：{raw_min_gap!r}，必须大于 0"
        )

    seed = str(payload.get("seed") or "").strip()
    if not seed:
        raise ScheduleError("排期参数缺少非空 seed，排期必须可复算")
    rng = random.Random(seed)

    pool, topic_count, template_count = build_note_pool(payload.get("noteFolders"))
    pool_size = len(pool)
    all_note_keys = {f"{topic}/{template}" for topic, template in pool}
    # pool 按「主题为高位、模板为低位」排列（build_note_pool 保证），可以从中还原
    # 两条独立的轴：topics_axis[k] = 第 k 个主题名，templates_axis[j] = 第 j 个模板名。
    topics_axis = [pool[k * template_count][0] for k in range(topic_count)]
    templates_axis = [pool[j][1] for j in range(template_count)]

    accounts = build_accounts(payload, rng)
    coverage_strategy = normalize_coverage_strategy(payload.get("coverageStrategy"))
    allow_partial = payload.get("allowPartialSchedule") is True
    topic_decision = str(payload.get("topicDecision") or "").strip()
    per_slot_raw = payload.get("perAccountPerSlot")
    per_account_per_slot = per_slot_raw if isinstance(per_slot_raw, int) and per_slot_raw > 0 else 1
    reservations = build_reservations(payload.get("existingReservations"))

    # ---- 第 1 步：账号发布次数 + 模板数下限检查（约束 4 的前提条件） ----
    for account in accounts:
        occurrence_count = len(account["slots"]) * per_account_per_slot
        if occurrence_count > template_count:
            raise ScheduleError(
                f"账号「{account['account']}」（{account['platform']}）需要发布 {occurrence_count} 次，"
                f"但只有 {template_count} 种模板，无法保证同账号模板不重复；"
                f"请增加模板数或减少该账号的发布次数（每账号每模板只能用一次）。"
            )
        account["occurrenceCount"] = occurrence_count

    # ---- 第 2 步：先分配分钟（约束 2），note/topic 分配放到分钟已知之后 ----
    # 分钟分配本身不依赖具体分配到哪个 noteKey，先做完这一步，第 3 步给 noteKey 定
    # 主题时就能看到"这次发布几点几分"，从而在挑主题阶段主动避让约束 5（同店同
    # 主题跨账号需错开），而不是构造完了才发现撞车再报错。
    tasks: list[dict] = []  # 每个 task 对应一次具体发布：account + occurrence 序号
    for i, account in enumerate(accounts):
        occurrence_slot_values = []
        for slot_value in account["slots"]:
            occurrence_slot_values.extend([slot_value] * per_account_per_slot)
        for t, slot_value in enumerate(occurrence_slot_values):
            tasks.append({
                "account": account,
                "accountOrdinal": i,
                "occurrenceIndex": t,
                "slotValue": slot_value,
            })

    used_minutes: set[tuple[str, int]] = set()
    for reservation in reservations:
        date_str, minute_in_day = _abs_to_date_minute(reservation["absMinute"])
        used_minutes.add((date_str, minute_in_day))

    account_abs_times: dict[str, list[tuple[int, dict]]] = {}
    for reservation in reservations:
        account_abs_times.setdefault(reservation["accountKey"], []).append((reservation["absMinute"], reservation))

    tasks_by_slot_value: dict[str, list[dict]] = {}
    for task in tasks:
        tasks_by_slot_value.setdefault(task["slotValue"], []).append(task)

    for slot_value, slot_tasks in tasks_by_slot_value.items():
        window = parse_slot_window(slot_value)
        count = len(slot_tasks)
        # 分配顺序由 seed 驱动，不影响正确性
        ordered_tasks = slot_tasks[:]
        rng.shuffle(ordered_tasks)

        if window is None:
            abs_minute = parse_publish_time_to_abs_minute(slot_value)
            if abs_minute is None:
                raise ScheduleError(f"发布时间无法解析：{slot_value}")
            if count != 1:
                raise ScheduleError(
                    f"精确分钟槽「{slot_value}」不足：需要 {count} 个唯一分钟，只有 1 个"
                    "（精确分钟槽只能承载 1 次发布，请改用时间窗区间或增加更多精确分钟槽）。"
                )
            date_str, minute_in_day = _abs_to_date_minute(abs_minute)
            _assign_minute(ordered_tasks[0], date_str, minute_in_day, used_minutes, account_abs_times, abs_minute)
            continue

        date_str, win_start, win_end = window
        total_minutes = win_end - win_start + 1
        if total_minutes < count:
            raise ScheduleError(
                f"时间窗「{slot_value}」的唯一分钟不足：需要 {count} 个，窗口内只有 {total_minutes} 分钟。"
                "请扩大时间窗或减少落在该窗口的发布次数。"
            )

        for index, task in enumerate(ordered_tasks):
            segment_start = (index * total_minutes) // count
            segment_end = ((index + 1) * total_minutes) // count - 1
            length = segment_end - segment_start + 1
            start_offset = rng.randrange(length)
            found_minute = None
            for offset in range(length):
                candidate_offset = win_start + segment_start + ((start_offset + offset) % length)
                date_part, minute_in_day = _abs_to_date_minute(candidate_offset)
                key = (date_part, minute_in_day)
                if key in used_minutes:
                    continue
                found_minute = candidate_offset
                break
            if found_minute is None:
                raise ScheduleError(
                    f"时间窗「{slot_value}」第 {index + 1} 段（segment {segment_start}-{segment_end} 分钟偏移）"
                    f"已被已有排期完全占满，无法取得可用分钟；请扩大时间窗或错开 existingReservations。"
                )
            found_date, found_minute_in_day = _abs_to_date_minute(found_minute)
            _assign_minute(task, found_date, found_minute_in_day, used_minutes, account_abs_times, found_minute)

    # ---- 第 3 步：noteKey 分配（约束 3/4/5） ----
    # 按分钟先后顺序处理：处理某个 task 时，同店铺同主题、时间在 minGap 内的“邻居”
    # 只可能是已经处理过的更早的 task（对称性保证——如果某个更晚的 task 会和它
    # 撞车，等处理到那个更晚的 task 时同样会检测到并避开），所以只需要在挑选主题
    # 时避开“已经放好的邻居”，不需要反过来调整已经处理过的 task。这是按时间顺序
    # 的一次性贪心构造，不是多任务回溯——每个 task 的挑选只在自己的候选空间
    # （最多 主题数 × 模板数）里线性探测一次。
    tasks.sort(key=lambda item: (item["absMinute"], item["accountOrdinal"], item["occurrenceIndex"]))

    platform_used_notekeys: dict[str, set[str]] = {p: set() for p in SUPPORTED_PLATFORMS}
    account_used_template: dict[str, set[str]] = {}
    # (storeGroup, topicKey) -> 已经放好的 [(accountKey, absMinute), ...]，用于 auto_space 避让
    topic_group_entries: dict[tuple[str, str], list[tuple[str, int]]] = {}
    for reservation in reservations:
        if reservation["platform"] != "xiaohongshu" or not reservation["storeGroup"] or not reservation["topicKey"]:
            continue
        key = (reservation["storeGroup"], reservation["topicKey"])
        topic_group_entries.setdefault(key, []).append((reservation["accountKey"], reservation["absMinute"]))

    for task in tasks:
        account = task["account"]
        i, t = task["accountOrdinal"], task["occurrenceIndex"]
        used_templates = account_used_template.setdefault(account["accountKey"], set())
        used_notekeys = platform_used_notekeys[account["platform"]]
        spacing_aware = (
            topic_decision == "auto_space"
            and account["platform"] == "xiaohongshu"
            and bool(account["storeGroup"])
        )

        base_topic_idx = (i + t) % topic_count
        base_template_idx = (i + t) % template_count
        chosen = None
        for topic_probe in range(topic_count):
            topic_idx = (base_topic_idx + topic_probe) % topic_count
            topic = topics_axis[topic_idx]
            if spacing_aware:
                group_key = (account["storeGroup"], topic)
                neighbours = topic_group_entries.get(group_key, ())
                if any(
                    other_key != account["accountKey"] and abs(other_minute - task["absMinute"]) < min_gap
                    for other_key, other_minute in neighbours
                ):
                    continue
            for template_probe in range(template_count):
                template_idx = (base_template_idx + template_probe) % template_count
                template = templates_axis[template_idx]
                if template in used_templates:
                    continue
                note_key = f"{topic}/{template}"
                if note_key in used_notekeys:
                    continue
                chosen = (topic, template, note_key)
                break
            if chosen is not None:
                break

        if chosen is None:
            remaining_free = pool_size - len(used_notekeys)
            reason = "该账号已用过的模板与本平台已用过的 noteKey 撞满了所有候选"
            if spacing_aware:
                reason += "，或剩余主题都与同店铺同主题的其它账号在最小间隔内冲突"
            raise ScheduleError(
                f"账号「{account['account']}」（{account['platform']}）在 {task['publishTime']} 这次发布"
                f"找不到可用 noteKey：该平台 noteKey 池共 {pool_size} 个，剩余未用 {remaining_free} 个，"
                f"但{reason}（已用模板：{sorted(used_templates)}）。"
                f"请增加模板数、增加主题数，或调整时间窗拉开发布时间。"
            )

        topic, template, note_key = chosen
        used_notekeys.add(note_key)
        used_templates.add(template)
        task["topic"] = topic
        task["template"] = template
        task["noteKey"] = note_key
        if spacing_aware:
            topic_group_entries.setdefault((account["storeGroup"], topic), []).append(
                (account["accountKey"], task["absMinute"])
            )

    # ---- 第 4 步：兜底校验约束 1（同账号间隔）与约束 5（同店同主题跨账号间隔） ----
    # 分段设计下约束 1 理应自动满足、约束 5 已经在第 3 步挑主题时主动避让；这里
    # 仍然完整复核一遍，万一分段/避让逻辑之间出现未预见的缝隙，直接在这里拦下
    # 并给出具体诊断，而不是把不满足硬约束的结果悄悄放出去。
    _validate_same_account_gap(account_abs_times, min_gap)
    if topic_decision == "auto_space":
        _validate_topic_spacing(tasks, reservations, min_gap)

    # ---- 第 5 步：组装输出 ----
    schedule = []
    for task in tasks:
        account = task["account"]
        schedule.append({
            "topic": task["topic"],
            "topicKey": task["topic"],
            "noteKey": task["noteKey"],
            "platform": account["platform"],
            "account": account["account"],
            "storeGroup": account["storeGroup"],
            "publishTime": task["publishTime"],
        })
    schedule.sort(key=lambda item: (item["publishTime"], item["platform"], item["account"]))

    used_any = set()
    for platform in SUPPORTED_PLATFORMS:
        used_any |= platform_used_notekeys[platform]
    unscheduled = sorted(all_note_keys - used_any)
    if not allow_partial and unscheduled:
        sample = unscheduled[:10]
        raise ScheduleError(
            f"给定时间资源无法覆盖全部 noteKey：仍有 {len(unscheduled)} 个未被安排，"
            f"例如 {sample}{'...' if len(unscheduled) > len(sample) else ''}。"
            "若接受不覆盖全部模板，请显式传 allowPartialSchedule=true。"
        )

    covered_topics_by_account: dict[str, set[str]] = {}
    for task in tasks:
        key = task["account"]["accountKey"]
        covered_topics_by_account.setdefault(key, set()).add(task["topic"])

    violations: list[str] = []
    warnings: list[str] = []
    for account in accounts:
        covered = len(covered_topics_by_account.get(account["accountKey"], set()))
        if covered < topic_count:
            message = f"{account['account']}：只覆盖 {covered}/{topic_count} 个主题"
            if coverage_strategy == "strict":
                violations.append(message)
            elif coverage_strategy == "balanced":
                warnings.append(message)
    if violations:
        raise ScheduleError(f"给定时间资源无法满足严格覆盖：{'；'.join(violations)}")

    return {
        "schedule": schedule,
        "unscheduled": unscheduled,
        "stats": {
            "scheduledCount": len(schedule),
            "unscheduledCount": len(unscheduled),
            "coverageStrategy": coverage_strategy,
            "violations": [],
            "warnings": warnings,
        },
        "constraints": {
            "minSameAccountIntervalMinutes": min_gap,
            "uniqueMinuteAcrossBatch": True,
            "seed": seed,
        },
    }


def _assign_minute(task: dict, date_str, minute_in_day: int, used_minutes: set, account_abs_times: dict, abs_minute: int) -> None:
    used_minutes.add((str(date_str), minute_in_day))
    task["publishTime"] = _format_publish_time(str(date_str), minute_in_day)
    task["absMinute"] = abs_minute
    account_abs_times.setdefault(task["account"]["accountKey"], []).append((abs_minute, task))


def _validate_same_account_gap(account_abs_times: dict, min_gap: int) -> None:
    for account_key, entries in account_abs_times.items():
        ordered = sorted(entries, key=lambda pair: pair[0])
        for idx in range(len(ordered) - 1):
            gap = ordered[idx + 1][0] - ordered[idx][0]
            if gap < min_gap:
                left_label = _entry_label(ordered[idx][1])
                right_label = _entry_label(ordered[idx + 1][1])
                raise ScheduleError(
                    f"账号「{account_key}」两次发布间隔不足：{left_label} 与 {right_label} "
                    f"仅间隔 {gap} 分钟，要求 ≥ {min_gap} 分钟（差 {min_gap - gap} 分钟）。"
                    "请拉开这两个时段或减少该账号在此区间的发布次数。"
                )


def _entry_label(entry: dict) -> str:
    if "publishTime" in entry:
        return f"{entry.get('noteKey', '(既有排期)')}@{entry['publishTime']}"
    return f"(既有排期)@{entry.get('publishTime', '?')}"


def _validate_topic_spacing(tasks: list[dict], reservations: list[dict], min_gap: int) -> None:
    groups: dict[tuple[str, str], list[dict]] = {}
    for task in tasks:
        account = task["account"]
        if account["platform"] != "xiaohongshu" or not account["storeGroup"]:
            continue
        key = (account["storeGroup"], task["topic"])
        groups.setdefault(key, []).append({
            "accountKey": account["accountKey"],
            "absMinute": task["absMinute"],
            "label": f"{account['account']}@{task['publishTime']}",
        })
    for reservation in reservations:
        if reservation["platform"] != "xiaohongshu" or not reservation["storeGroup"] or not reservation["topicKey"]:
            continue
        key = (reservation["storeGroup"], reservation["topicKey"])
        groups.setdefault(key, []).append({
            "accountKey": reservation["accountKey"],
            "absMinute": reservation["absMinute"],
            "label": f"{reservation['account']}@{reservation['publishTime']}（既有排期）",
        })

    for (store_group, topic_key), entries in groups.items():
        for a_idx in range(len(entries)):
            for b_idx in range(a_idx + 1, len(entries)):
                a, b = entries[a_idx], entries[b_idx]
                if a["accountKey"] == b["accountKey"]:
                    continue
                gap = abs(a["absMinute"] - b["absMinute"])
                if gap < min_gap:
                    raise ScheduleError(
                        f"店铺组「{store_group}」主题「{topic_key}」跨账号间隔不足："
                        f"{a['label']} 与 {b['label']} 仅间隔 {gap} 分钟，要求 ≥ {min_gap} 分钟"
                        f"（差 {min_gap - gap} 分钟）。auto_space 模式下同店同主题跨账号必须错开，"
                        "请拉开时间窗或改用 allow_conflicts。"
                    )


# ---------------------------------------------------------------------------
# 独立 CLI（自带最小 scan.json 解析，避免反向 import skill_upload.py）
# ---------------------------------------------------------------------------

def _note_key_parts(note_key: str) -> tuple[str, str]:
    value = str(note_key or "").strip()
    if "/" not in value:
        raise ScheduleError(f"无效 noteKey：{value}")
    return tuple(value.rsplit("/", 1))  # type: ignore[return-value]


def _load_scan_entries(scan_json_file: str) -> list:
    path = os.path.expanduser(scan_json_file)
    if not os.path.isfile(path):
        raise ScheduleError(f"扫描结果文件不存在：{path}")
    with open(path, encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload, list):
        raise ScheduleError(f"扫描结果格式错误：{path} 需要 JSON 数组")
    return payload


def build_note_folders_from_scan(scan_entries: list) -> list[dict]:
    note_folders = []
    for topic_entry in scan_entries:
        notes = topic_entry.get("notes") or []
        topic_to_templates: dict[str, list[str]] = {}
        for note in notes:
            topic_key, template = _note_key_parts(str(note.get("noteKey") or ""))
            topic_to_templates.setdefault(topic_key, []).append(template)
        for topic_key, templates in topic_to_templates.items():
            note_folders.append({"topic": topic_key, "templates": templates})
    return note_folders


def main() -> None:
    parser = argparse.ArgumentParser(description="本地构造式排期分配器")
    parser.add_argument("scan_json_file")
    parser.add_argument("plan_json_file")
    parser.add_argument("--output", default=None)
    args = parser.parse_args()

    try:
        scan_entries = _load_scan_entries(args.scan_json_file)
        plan_path = os.path.expanduser(args.plan_json_file)
        if not os.path.isfile(plan_path):
            raise ScheduleError(f"调度参数文件不存在：{plan_path}")
        with open(plan_path, encoding="utf-8") as f:
            payload = json.load(f)
        if not isinstance(payload, dict):
            raise ScheduleError(f"调度参数格式错误：{plan_path} 需要 JSON 对象")
        if "timeSlots" not in payload:
            raise ScheduleError(
                "plan.json 缺少 timeSlots；schedule_allocator CLI 不做 timeWindows/timeHint 展开，"
                "请先用 skill_upload.py 的 normalize_schedule_plan_payload 生成标准化 plan，"
                "或直接在 plan.json 中给出 timeSlots.regular / timeSlots.special。"
            )
        payload = {**payload, "noteFolders": build_note_folders_from_scan(scan_entries)}
        result = allocate_schedule(payload)
    except ScheduleError as exc:
        print(f"排期失败：{exc}", file=sys.stderr)
        sys.exit(1)

    output_path = os.path.expanduser(args.output) if args.output else "/tmp/zhifa_schedule_allocator_result.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"（调度 JSON 已写入 {output_path}）", file=sys.stderr)


if __name__ == "__main__":
    main()
