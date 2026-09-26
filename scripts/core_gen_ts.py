"""Generate web/src/lib/contracts.ts and contracts/schemas/*.schema.json from twobme_common.

    uv run python scripts/core_gen_ts.py          # write
    uv run python scripts/core_gen_ts.py --check  # exit 1 if outputs are stale (used by gate.sh)

TS is derived from the pydantic models themselves (not hand-written), plus constants from
feature_spec.yaml and trust_config.yaml so the web can't drift from the contracts.
"""

from __future__ import annotations

import inspect
import json
import sys
import types as pytypes
import typing
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, Union, get_args, get_origin
from uuid import UUID

import yaml
from pydantic import BaseModel

from twobme_common import types as T
from twobme_common.config import load_trust_config
from twobme_common.paths import contracts_dir
from twobme_common.spec import load_spec

ROOT = Path(__file__).resolve().parents[1]
TS_OUT = ROOT / "web" / "src" / "lib" / "contracts.ts"
SCHEMA_DIR = ROOT / "contracts" / "schemas"


def literal_aliases() -> dict[tuple, str]:
    out: dict[tuple, str] = {}
    for name, obj in vars(T).items():
        if name.startswith("_"):
            continue
        if get_origin(obj) is Literal:
            out[tuple(get_args(obj))] = name
    return out


ALIASES = literal_aliases()


def models_in_order() -> list[type[BaseModel]]:
    src = inspect.getsource(T)
    found = [
        obj for name, obj in vars(T).items()
        if inspect.isclass(obj) and issubclass(obj, BaseModel) and obj.__module__ == T.__name__
        and not name.startswith("_")
    ]
    return sorted(found, key=lambda c: src.find(f"class {c.__name__}("))


def lit(v: Any) -> str:
    return json.dumps(v)


def ts_type(tp: Any) -> str:
    origin = get_origin(tp)
    args = get_args(tp)
    if tp is type(None) or tp is None:
        return "null"
    if tp is Any:
        return "unknown"
    if origin is typing.Annotated:
        return ts_type(args[0])
    if origin is Literal:
        name = ALIASES.get(tuple(args))
        return name if name else " | ".join(lit(a) for a in args)
    if origin in (Union, pytypes.UnionType):
        parts = []
        for a in args:
            t = ts_type(a)
            if t not in parts:
                parts.append(t)
        return " | ".join(parts)
    if origin in (list, typing.List):  # noqa: UP006
        inner = ts_type(args[0])
        return f"({inner})[]" if "|" in inner else f"{inner}[]"
    if origin is tuple:
        if len(args) == 2 and args[1] is Ellipsis:
            return f"{ts_type(args[0])}[]"
        return "[" + ", ".join(ts_type(a) for a in args) + "]"
    if origin is dict:
        k, v = args
        kt = ts_type(k)
        if get_origin(k) is Literal:
            return f"Partial<Record<{kt}, {ts_type(v)}>>"
        return f"Record<string, {ts_type(v)}>"
    if inspect.isclass(tp):
        if issubclass(tp, BaseModel):
            return tp.__name__
        if issubclass(tp, bool):
            return "boolean"
        if issubclass(tp, (int, float)):
            return "number"
        if issubclass(tp, (str, UUID, datetime)):
            return "string"
    if tp is dict:
        return "Record<string, unknown>"
    raise TypeError(f"unsupported annotation {tp!r}")


def is_input(cls: type[BaseModel]) -> bool:
    return cls.__name__.endswith("In")


def gen_interface(cls: type[BaseModel]) -> str:
    base = next((b for b in cls.__bases__ if issubclass(b, BaseModel) and not b.__name__.startswith("_")), None)
    lines = []
    doc = (cls.__doc__ or "").strip().splitlines()
    if doc and not doc[0].startswith("Strict wire model"):
        lines.append(f"/** {doc[0]} */")
    ext = f" extends {base.__name__}" if base else ""
    lines.append(f"export interface {cls.__name__}{ext} {{")
    own = cls.model_fields if base is None else {k: v for k, v in cls.model_fields.items() if k not in base.model_fields}
    for name, f in own.items():
        key = f.alias or name
        optional = is_input(cls) and not f.is_required()
        lines.append(f"  {key}{'?' if optional else ''}: {ts_type(f.annotation)};")
    lines.append("}")
    return "\n".join(lines)


def gen_union(name: str, members: list[type[BaseModel]]) -> str:
    return f"export type {name} =\n  | " + "\n  | ".join(m.__name__ for m in members) + ";"


def gen_live_union() -> str:
    parts = []
    for typ, model in T.LIVE_PAYLOADS.items():
        data = model.__name__ if model else "Record<string, never>"
        parts.append(f'{{ type: "{typ}"; device_id: string | null; t: string; data: {data} }}')
    return "export type LiveEvent =\n  | " + "\n  | ".join(parts) + ";"


def gen_constants() -> str:
    spec = load_spec()
    cfg = load_trust_config()
    with open(contracts_dir() / "trust_config.yaml", encoding="utf-8") as fh:
        raw_cfg = yaml.safe_load(fh)
    feature_spec = {
        "schema_version": spec.schema_version,
        "modalities": {
            m: {
                "n_unit": ms.n_unit,
                "n_ref": ms.n_ref,
                "enroll_gate": ms.enroll_gate,
                "features": [
                    {"name": f.name, "unit": f.unit, "label": f.label, "headline": f.headline,
                     "column": f.column}
                    for f in ms.features
                ],
            }
            for m, ms in spec.modalities.items()
        },
        "signature": {
            m: {leaf: spec.signature_features(m, leaf) for leaf in leaves}
            for m, leaves in spec.signature.items()
        },
        "enums": {k: list(v) for k, v in spec.enums.items()},
    }
    trust = {
        "cap": cfg.cap,
        "levels": raw_cfg["levels"],
        "anchors": raw_cfg["anchors"],
        "arming": raw_cfg["arming"],
        "weights": raw_cfg["weights"],
        "policy": raw_cfg["policy"],
        "binding": raw_cfg["binding"],
    }
    return (
        f"export const SCHEMA_VERSION = {spec.schema_version} as const;\n\n"
        f"export const FEATURE_SPEC = {json.dumps(feature_spec, indent=2)} as const;\n\n"
        f"export const TRUST_CONFIG = {json.dumps(trust, indent=2)} as const;\n\n"
        "export const HEADLINE_COLUMNS: readonly string[] = "
        f"{json.dumps([c for _, c in spec.headline_columns()])};\n\n"
        "const _FEATURES: Record<string, { label: string; unit: string; modality: Modality }> = {};\n"
        "for (const [m, ms] of Object.entries(FEATURE_SPEC.modalities)) {\n"
        "  for (const f of ms.features) _FEATURES[f.name] = { label: f.label, unit: f.unit, modality: m as Modality };\n"
        "}\n"
        "export function featureInfo(name: string) {\n"
        "  return _FEATURES[name] ?? { label: name, unit: \"\", modality: \"keyboard\" as Modality };\n"
        "}\n"
    )


def gen_ts() -> str:
    out = [
        "// AUTO-GENERATED by scripts/core_gen_ts.py from twobme_common.types + contracts/*.yaml.",
        "// Do not edit by hand. Regenerate: uv run python scripts/core_gen_ts.py",
        "/* eslint-disable */",
        "",
    ]
    for args, name in ALIASES.items():
        out.append(f"export type {name} = {' | '.join(lit(a) for a in args)};")
    out.append("")
    for cls in models_in_order():
        out.append(gen_interface(cls))
        out.append("")
    out.append(gen_union("AgentMessage", [T.Hello, T.Tick, T.MarkerMsg, T.OsEventMsg, T.DemoMsg, T.ClockPing]))
    out.append("")
    out.append(gen_union("ServerToAgent", [T.Welcome, T.AgentTrust, T.AgentChallenge, T.AgentLock,
                                           T.AgentUnlock, T.AgentMode, T.ClockPong, T.AgentError]))
    out.append("")
    out.append(gen_live_union())
    out.append("")
    out.append(gen_constants())
    return "\n".join(out)


def gen_schemas() -> dict[Path, str]:
    res = {}
    for name, model in T.REPORT_MODELS.items():
        schema = model.model_json_schema(by_alias=True, mode="serialization")
        schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
        schema["$id"] = f"https://2bme.tech/schemas/{name}.schema.json"
        res[SCHEMA_DIR / f"{name}.schema.json"] = json.dumps(schema, indent=2, sort_keys=True) + "\n"
    return res


def main() -> int:
    check = "--check" in sys.argv
    outputs = {TS_OUT: gen_ts(), **gen_schemas()}
    stale = []
    for path, content in outputs.items():
        cur = path.read_text() if path.exists() else None
        if cur != content:
            stale.append(path)
            if not check:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
    if check and stale:
        print("stale generated files (run scripts/core_gen_ts.py):", *[str(p.relative_to(ROOT)) for p in stale])
        return 1
    print("generated:" if not check else "up to date:", len(outputs), "files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
