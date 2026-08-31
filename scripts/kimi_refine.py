#!/usr/bin/env python3
"""Refined-carryover extraction for a Kimi CLI session.

Why this emits text instead of a message array
------------------------------------------------------------
Measured against two CLI harnesses' context-swap primitives:

    Codex-style: `compacted.replacement_history` takes a **full message
                 array**. After writing it and resuming, the old history is
                 genuinely gone (ask about something said before the swap →
                 "no record"). Its carryover can therefore preserve verbatim
                 turns with their original speakers.

    Kimi       : `context.apply_compaction` carries only a summary string.
                 Hand-writing an entry into wire.jsonl **does get read** (the
                 agent treats it as its own working notes — verified by having
                 it recall a planted token), but it **cannot displace history**:
                 a real compaction took messageCount 336 → 5, while the
                 hand-written entry survived and the count crept 2 → 4 → 7.

Kimi's context is event-sourced: user turns go through
`context.append_message`, while agent replies are split into
`step.begin` / `content.part` / `step.end` triples linked by uuid. Forging
"the agent said this" means reproducing that whole chain exactly, against a
~180MB closed-source binary that auto-updates. Getting it wrong means the
session will not open — the agent goes mute. Not worth the marginal quality.

So this takes the **refined-handoff** route: the excerpt extracted here is
appended after the agent's own handoff note and injected as the first message
of the new session. What it receives is "history it has read", not "history it
has spoken". That asymmetry is imposed by the engine, not by laziness, and it
should be stated plainly to whoever relies on the carryover.
"""

from __future__ import annotations

import os

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

# The selection logic lives beside this file. It used to be resolved two
# directories up and outside the checkout, which only ever worked on the
# machine it was authored on. REFINED_CARRYOVER_UPSTREAM overrides it.
UPSTREAM = Path(
    os.environ.get("REFINED_CARRYOVER_UPSTREAM")
    or Path(__file__).resolve().parent / "refined_session_carryover.py"
)

CJK_RE = re.compile(r"[　-〿぀-ヿ一-鿿＀-￯]")
PROTOCOL_HEAD_RE = re.compile(r'^(TG_PRIVATE|TG_GROUP_BATCH|TG_[A-Z_]+)\b')
INJECTION_RE = re.compile(
    r'<(system-reminder|hub-recall|memory-data|memory-check|task-notification)\b.*?</\1>',
    re.S | re.I,
)


def _all_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        if isinstance(value.get("text"), str):
            return value["text"]
        return "\n".join(_all_text(v) for k, v in value.items() if k != "id")
    if isinstance(value, list):
        return "\n".join(_all_text(item) for item in value)
    return ""


def estimate_tokens(value: object) -> int:
    """CJK/Latin mixed token estimate (calibrated on 8 real windows, 1 token ≈ 1.33 chars).

    上游默认的 `len(json.dumps(event)) // 3` 把 JSON 结构字符也算进预算，
    实测高估约 3 倍，会让 target_tokens 形同虚设。
    """
    text = _all_text(value)
    cjk = len(CJK_RE.findall(text))
    return max(1, int(cjk * 1.1 + (len(text) - cjk) / 1.45))


def load_upstream():
    if not UPSTREAM.exists():
        raise SystemExit(f"找不到上游精炼脚本：{UPSTREAM}")
    spec = importlib.util.spec_from_file_location("refined_session_carryover", UPSTREAM)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # @dataclass 要回查 sys.modules
    spec.loader.exec_module(module)
    module.estimate_tokens = estimate_tokens
    return module


# ---------------------------------------------------------------- 剥壳

def strip_injections(text: str) -> str:
    text = INJECTION_RE.sub("", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def unwrap_user_text(text: str) -> str:
    """TG 协议壳 -> 「说话人: 内容」；终端裸文本原样留下。"""
    text = strip_injections(text)
    if not text:
        return ""
    if not PROTOCOL_HEAD_RE.match(text):
        return text

    payload = None
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                payload = None
            break
    if not payload:
        return text

    if payload.get("messages"):
        pieces = []
        for item in payload["messages"]:
            if not isinstance(item, dict):
                continue
            body = (item.get("text") or "").strip()
            if body:
                pieces.append(f"{item.get('sender') or item.get('username') or '?'}: {body}")
        return "\n".join(pieces)

    body = (payload.get("text") or "").strip()
    if not body:
        return ""
    sender = payload.get("sender") or payload.get("username") or "?"
    return f"{sender}: {body}"


# ---------------------------------------------------------------- 抽取

def extract_dialogue(wire: Path) -> list[dict]:
    """wire.jsonl -> 上游认得的 CC 风格事件。

    user   : context.append_message(role=user)
    agent  : context.append_loop_event 里 part.type == 'text' 的片段，
             按 stepUuid 合并成一条完整发言（think 是思考链，不带走）
    """
    events: list[dict] = []
    pending_step: str | None = None
    pending_parts: list[str] = []

    def flush():
        nonlocal pending_step, pending_parts
        if pending_parts:
            body = "".join(pending_parts).strip()
            if body:
                events.append({
                    "type": "assistant",
                    "isMeta": False,
                    "isSidechain": False,
                    "message": {"role": "assistant", "content": body},
                })
        pending_step, pending_parts = None, []

    with wire.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            kind = record.get("type")
            if kind == "context.append_message":
                message = record.get("message") or {}
                if message.get("role") != "user":
                    continue
                flush()
                content = message.get("content")
                raw = (
                    "".join(p.get("text", "") for p in content if isinstance(p, dict))
                    if isinstance(content, list) else str(content or "")
                )
                text = unwrap_user_text(raw)
                if text:
                    events.append({
                        "type": "user",
                        "isMeta": False,
                        "isSidechain": False,
                        "message": {"role": "user", "content": text},
                    })
            elif kind == "context.append_loop_event":
                event = record.get("event") or {}
                if event.get("type") != "content.part":
                    if event.get("type") == "step.end":
                        flush()
                    continue
                part = event.get("part") or {}
                if part.get("type") != "text":
                    continue
                step = event.get("stepUuid")
                if step != pending_step:
                    flush()
                    pending_step = step
                pending_parts.append(part.get("text") or "")
    flush()
    return events


# ---------------------------------------------------------------- 输出

def render_carryover(events: list[dict], self_name: str = "你") -> str:
    """精炼事件 -> 给新 session 读的原话摘录。"""
    lines = []
    for event in events:
        text = str(event["message"]["content"]).strip()
        if not text:
            continue
        if event["type"] == "assistant":
            lines.append(f"{self_name}：{text}")
        else:
            # user 事件里已经带了「说话人: 」前缀（剥壳时加的）；没有的是终端直发
            lines.append(text if re.match(r'^[^\n：:]{1,24}[：:]', text) else f"（终端）{text}")
    return "\n\n".join(lines)


def speaker_tally(events: list[dict], limit: int = 12) -> list[tuple[str, int]]:
    tally: dict[str, int] = {}
    for event in events:
        if event.get("type") != "user":
            continue
        for line in str(event["message"]["content"]).splitlines():
            name, sep, _ = line.partition(": ")
            if sep and 0 < len(name) <= 24:
                tally[name] = tally.get(name, 0) + 1
    return sorted(tally.items(), key=lambda kv: kv[1], reverse=True)[:limit]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wire", type=Path, required=True)
    # Tuned on a real 1M-window wire: the excerpt is injected as a single first
    # 60k/tail=80 时 gold 打满 80 条、预算零丢弃，落点 44k（占窗口 4.4%）。
    # 再往下压（30k）会开始把 gold 挤掉：tail=40 就丢 25 条、tail=100 丢 52 条。
    parser.add_argument("--target-tokens", type=int, default=60_000)
    parser.add_argument("--tail-events", type=int, default=80)
    parser.add_argument("--json", action="store_true", help="输出 JSON（统计 + 正文），给桥调用")
    args = parser.parse_args(argv)

    upstream = load_upstream()
    events = extract_dialogue(args.wire)
    refined, stats = upstream.select_refined_events(
        events,
        target_tokens=args.target_tokens,
        tail_events=args.tail_events,
    )
    # 上游会在开头补一条合成的占位 user 事件，那句话对读者没有意义
    refined = [e for e in refined if "refined-carryover: preserved" not in str(e["message"]["content"])]

    body = render_carryover(refined)
    report = {
        "source_events": len(events),
        "clean_candidates": stats.clean_candidates,
        "selected": len(refined),
        "gold": stats.selected_gold,
        "state": stats.selected_state,
        "tail": stats.selected_tail,
        "dropped_for_budget": stats.dropped_for_budget,
        "poison_score": stats.poison_score,
        "estimated_tokens": estimate_tokens(body),
        "speakers": speaker_tally(refined),
    }

    if stats.poison_score >= 3:
        report["refused"] = "poison_score>=3，拒绝续窗"
        body = ""
    elif not body.strip():
        report["refused"] = "精炼结果为空，拒绝续窗"

    if args.json:
        print(json.dumps({**report, "body": body}, ensure_ascii=False))
        return 3 if report.get("refused") else 0

    print(f"源对话 {report['source_events']} → 候选 {report['clean_candidates']} → 留下 {report['selected']}")
    print(f"  gold={report['gold']} state={report['state']} tail={report['tail']} "
          f"预算丢弃={report['dropped_for_budget']} 毒性={report['poison_score']}")
    print(f"  估算 {report['estimated_tokens']:,} tokens")
    if report["speakers"]:
        print("  留下谁的话：" + " ".join(f"{n}×{c}" for n, c in report["speakers"]))
    if report.get("refused"):
        print(f"  ⚠️ {report['refused']}")
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
