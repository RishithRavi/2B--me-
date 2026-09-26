"""Adapt published core configuration at the signals boundary."""


def model_config(cfg):
    cfg = cfg.model_dump() if hasattr(cfg, "model_dump") else dict(cfg)
    if "spec" not in cfg:
        from twobme_common.spec import load_spec
        cfg["spec"] = load_spec().model_dump()
    cfg.setdefault("schema_version", cfg["spec"].get("schema_version", 1))
    return cfg


def trust_config(cfg):
    cfg = cfg.model_dump() if hasattr(cfg, "model_dump") else dict(cfg)
    if "squash" in cfg:
        cfg.update(cfg["squash"])
        cfg["beta"] = cfg["llr"]["beta"]
        if "n_ref" not in cfg:
            from twobme_common.spec import load_spec
            spec = load_spec()
            cfg["n_ref"] = {m: spec.n_ref(m) for m in spec.modalities}
    return cfg
