#!/usr/bin/env python3
"""
Stop hook: 知发上传防谎报
只要 AI 最后回复声称知发上传成功，就必须存在本次真实的 verify 凭据并被回复引用，否则 block。

输出 schema 与 Claude Code Stop hook 一致：
  放行: {"continue": True}
  advisory: {"continue": True, "systemMessage": "..."}
  block: {"decision": "block", "reason": "..."}
  防循环: stop_hook_active=true 时降级为 systemMessage

参考: Echo/scripts/shared/stop-rule-sync-check.sh 第 28-37 行
"""

import sys
import json
import os
import re
import glob
import time

BLOCK_REASON = (
    "检测到你声称知发上传成功，但未在回复中引用本次有效的 verify 凭据。"
    "请先运行 python3 ~/zhifa/scripts/skill_upload.py verify <create结果.json> "
    "--output /tmp/zhifa_verify_<时间戳>.json，"
    "确认 status=ok 且 actual_count 等于期望条数，"
    "并在回复中粘贴该凭据文件路径后，再报告完成。"
    "若确属误判（如用户已说不用 verify），忽略本提示。"
)

# 逃生口关键词
ESCAPE_PHRASES = [
    "跳过verify",
    "不用verify",
    "不用核实",
    "跳过 skill 检查",
    "跳过skill检查",
    "我知道我在做什么",
]

# 上传语境词（需至少命中一个）
CONTEXT_WORDS = ["飞书", "知发", "小红书", "抖音"]

# 成功声称正则（需至少命中一个）
# 要求"上传/导入/创建/恢复"动作词与数量紧密相连，避免误拦"写入飞书成功"等开发讨论
SUCCESS_PATTERNS = [
    re.compile(r"(上传|导入|创建|恢复)\s*(成功|完成)?\s*[，,、]?\s*\d+\s*条"),
    re.compile(r"已(上传|导入|创建)\s*\d+\s*条"),
    re.compile(r"\d+\s*条.{0,6}(上传成功|导入成功|已上传|已导入|上传完成|导入完成|入库)"),
    re.compile(r"(上传|导入|排期)\s*(全部|均|都)?\s*(成功|完成)"),
]

# verify 文件路径正则（在回复里引用的）
VERIFY_PATH_RE = re.compile(r"/tmp/zhifa_verify_[^\s`'\"\)]+\.json")

# verify 凭据有效期（秒）
VERIFY_MAX_AGE_SECS = 3 * 3600


def passthrough():
    print(json.dumps({"continue": True}, ensure_ascii=False))
    sys.exit(0)


def text_from_content(content):
    """从 message.content（str 或 block 列表）提取纯文本。"""
    parts = []
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") in {"text", "output_text", "input_text"}:
                parts.append(block.get("text", "") or "")
    return "\n".join(p for p in parts if p)


def is_valid_verify_file(path: str) -> bool:
    """判断一个 /tmp/zhifa_verify_*.json 文件是否是有效凭据。"""
    try:
        stat = os.stat(path)
        age = time.time() - stat.st_mtime
        if age > VERIFY_MAX_AGE_SECS:
            return False
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return False
        if data.get("status") != "ok":
            return False
        actual_count = data.get("actual_count")
        if not isinstance(actual_count, int) or actual_count <= 0:
            return False
        return True
    except Exception:
        return False


def main():
    # 最外层 fail-open 保护
    try:
        raw = sys.stdin.read()
        try:
            data = json.loads(raw) if raw.strip() else {}
        except Exception:
            passthrough()

        # 1. 防循环：stop_hook_active=true → 直接放行
        stop_hook_active = bool(data.get("stop_hook_active", False))
        if stop_hook_active:
            passthrough()

        transcript_path = data.get("transcript_path", "")
        if not transcript_path or not os.path.exists(transcript_path):
            passthrough()

        # 2. 读 transcript，取最后一条 assistant 文本 + 最后一条 user 文本
        last_assistant_text = ""
        last_user_text = ""

        try:
            with open(transcript_path, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ev = json.loads(line)
                    except Exception:
                        continue
                    if not isinstance(ev, dict):
                        continue

                    msg = ev.get("message", {})
                    if isinstance(msg, dict):
                        role = msg.get("role", "")
                        content = msg.get("content", [])
                        text = text_from_content(content)
                        if role == "assistant" and text:
                            last_assistant_text = text
                        elif role == "user" and text:
                            last_user_text = text
        except Exception:
            passthrough()

        # 3. 逃生口：最后 user 消息含逃生词 → 放行
        for phrase in ESCAPE_PHRASES:
            if phrase in last_user_text:
                passthrough()

        # 4. 判断是否声称知发上传成功
        if not last_assistant_text:
            passthrough()

        has_context = any(w in last_assistant_text for w in CONTEXT_WORDS)
        if not has_context:
            passthrough()

        has_success = any(p.search(last_assistant_text) for p in SUCCESS_PATTERNS)
        if not has_success:
            passthrough()

        # 命中"声称上传成功"，进入凭据校验
        # 5. 找回复中引用的 verify 路径
        cited_paths = VERIFY_PATH_RE.findall(last_assistant_text)

        # 6. 判断引用的路径是否有效
        valid_cited = [p for p in cited_paths if is_valid_verify_file(p)]

        if valid_cited:
            # 有被引用且有效的凭据 → 放行
            passthrough()

        # 7. 没有被引用的有效凭据 → block
        print(json.dumps({
            "decision": "block",
            "reason": BLOCK_REASON
        }, ensure_ascii=False))
        sys.exit(0)

    except Exception:
        # 最外层兜底：任何异常都放行，绝不卡死会话
        passthrough()


if __name__ == "__main__":
    main()
