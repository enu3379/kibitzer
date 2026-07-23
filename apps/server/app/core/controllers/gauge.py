"""Gauge v0 — pure reducer (B track, Python shadow implementation).

Language-neutral behavior contract: ``docs/gauge/contract.md`` (§2 state, §3 events,
§4 effects, §5 dynamics, §6 Tier 2 gates / renag / celebration). This module implements
that contract exactly and is validated byte-for-byte against ``fixtures/gauge/*.json``
(shared with the TypeScript A track) by ``apps/server/tests/test_gauge_fixtures.py``.

The reducer is **pure**: no clock, storage, network, or logging side effects. "Now"
arrives only as ``event.ts`` (epoch milliseconds). Same ``(state, event, config)`` always
produces the same ``GaugeTransition``. Placeholder numeric knobs (§8, un-calibrated until
D4) live only in :class:`GaugeConfig`, never inline.

Field names: dataclass fields are snake_case; the shared JSON fixtures use camelCase
(``activeVerdict``, ``accelTier``, ``rDrain``, ``tauM``, ``tUp`` …). The camelCase↔snake_case
mapping is explicit in the ``*_KEYMAP`` tables below and applied by ``from_json``/``to_json``.
The JSON is never renamed — it is shared with the TS track.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Any


# --------------------------------------------------------------------------------------
# camelCase (JSON) ↔ snake_case (dataclass field) key maps
# --------------------------------------------------------------------------------------

# GaugeState field (snake) -> fixture JSON key (camel)
_STATE_KEYMAP: dict[str, str] = {
    "s": "s",
    "m": "m",
    "accel_tier": "accelTier",
    "updated_at": "updatedAt",
    "active_page_key": "activePageKey",
    "active_verdict": "activeVerdict",
    "degraded": "degraded",
    "active_margin": "activeMargin",
    "pending_tier2": "pendingTier2",
    "last_judgment": "lastJudgment",
    "nag_n": "nagN",
    "renag_debt": "renagDebt",
    "last_nag_ts": "lastNagTs",
    "celebrate_armed": "celebrateArmed",
    "snoozed_until": "snoozedUntil",
}

# GaugeConfig field (snake) -> fixture JSON key (camel)
_CONFIG_KEYMAP: dict[str, str] = {
    "r_drain": "rDrain",
    "r_recover": "rRecover",
    "accel": "accel",
    "tau_m": "tauM",
    "t_up": "tUp",
    "t_down": "tDown",
    "k_recover": "kRecover",
    "recover_gamma": "recoverGamma",
    "recover_f_max": "recoverFMax",
    "gap_cap": "gapCap",
    "r_renag": "rRenag",
    "b_backoff": "bBackoff",
    "r_renag_max": "rRenagMax",
    "c_arm": "cArm",
    "c_celebrate": "cCelebrate",
    "r_dismiss": "rDismiss",
    "b_refund": "bRefund",
    "fresh_window": "freshWindow",
    "degraded_p": "degradedP",
    "degraded_m": "degradedM",
    "j_page": "jPage",
}

# GaugeEvent field (snake) -> event JSON key (camel)
_EVENT_KEYMAP: dict[str, str] = {
    "type": "type",
    "ts": "ts",
    "page_key": "pageKey",
    "verdict": "verdict",
    "r0": "r0",
    "tau_ok": "tauOk",
    "degraded": "degraded",
    "flow": "flow",
    "until": "until",
}

# nested pendingTier2 {reason, tier, pageKey, requestedAt}
_PENDING_KEYMAP: dict[str, str] = {
    "reason": "reason",
    "tier": "tier",
    "page_key": "pageKey",
    "requested_at": "requestedAt",
}

# nested lastJudgment {pageKey, flow, ts}
_JUDGMENT_KEYMAP: dict[str, str] = {
    "page_key": "pageKey",
    "flow": "flow",
    "ts": "ts",
}


def _nested_from_json(data: dict[str, Any] | None, keymap: dict[str, str]) -> dict[str, Any] | None:
    if data is None:
        return None
    return {snake: data[camel] for snake, camel in keymap.items() if camel in data}


def _nested_to_json(data: dict[str, Any] | None, keymap: dict[str, str]) -> dict[str, Any] | None:
    if data is None:
        return None
    return {camel: data[snake] for snake, camel in keymap.items() if snake in data}


# --------------------------------------------------------------------------------------
# Config (contract §2 / §8 placeholder knobs)
# --------------------------------------------------------------------------------------


@dataclass
class GaugeConfig:
    """All-placeholder knobs (§8). Values default to the §8 placeholders; fixtures pin
    their own ``config`` block, so golden values only need regenerating when a knob in
    *that* fixture changes."""

    r_drain: float = 0.1
    r_recover: float = 0.1
    accel: list[float] = field(default_factory=lambda: [1.0, 1.5, 2.5])
    tau_m: float = 300.0
    t_up: list[float] = field(default_factory=lambda: [0.5, 0.8])
    t_down: list[float] = field(default_factory=lambda: [0.2, 0.5])
    k_recover: float = 2.45
    recover_gamma: float = 3.0  # exponential gain on return-inertia depth (issue #122 "F")
    recover_f_max: float = 6.0  # cap on the recovery boost e^(gamma*max(-m,0))
    gap_cap: float = 90.0
    r_renag: float = 40.0
    b_backoff: float = 2.0
    r_renag_max: float = 320.0
    c_arm: float = 20.0
    c_celebrate: float = 80.0
    r_dismiss: float = 30.0
    b_refund: float = 10.0
    fresh_window: float = 600.0
    degraded_p: float = 3.0
    degraded_m: float = 0.25
    j_page: float = 0.0  # page-switch impulse disabled (D9: J_page = 0)

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "GaugeConfig":
        kwargs: dict[str, Any] = {}
        for snake, camel in _CONFIG_KEYMAP.items():
            if camel in data:
                value = data[camel]
                kwargs[snake] = list(value) if isinstance(value, list) else value
        return cls(**kwargs)

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for snake, camel in _CONFIG_KEYMAP.items():
            value = getattr(self, snake)
            out[camel] = list(value) if isinstance(value, list) else value
        return out


# --------------------------------------------------------------------------------------
# State (contract §2)
# --------------------------------------------------------------------------------------


@dataclass
class GaugeState:
    s: float = 100.0                                  # 몰입 게이지 ∈ [0, 100]
    m: float = 0.0                                    # 관성 ∈ [-1, +1]
    accel_tier: int = 0                               # 이산 가속 단계 ∈ {0, 1, 2}
    updated_at: int = 0                               # 마지막 적분 시각 (epoch ms)
    active_page_key: str | None = None
    active_verdict: str | None = None                 # "OK" | "DRIFT" | None (Tier2 오버라이드 반영)
    degraded: bool = False
    active_margin: float | None = None                # 축퇴 모드용 |r0 - tauOk|
    pending_tier2: dict[str, Any] | None = None       # {reason, tier, page_key, requested_at}
    last_judgment: dict[str, Any] | None = None       # {page_key, flow, ts}
    nag_n: int = 0
    renag_debt: float = 0.0
    last_nag_ts: int | None = None
    celebrate_armed: bool = False
    snoozed_until: int | None = None

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "GaugeState":
        kwargs: dict[str, Any] = {}
        for snake, camel in _STATE_KEYMAP.items():
            if camel not in data:
                continue
            value = data[camel]
            if snake == "pending_tier2":
                value = _nested_from_json(value, _PENDING_KEYMAP)
            elif snake == "last_judgment":
                value = _nested_from_json(value, _JUDGMENT_KEYMAP)
            kwargs[snake] = value
        return cls(**kwargs)

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for snake, camel in _STATE_KEYMAP.items():
            value = getattr(self, snake)
            if snake == "pending_tier2":
                value = _nested_to_json(value, _PENDING_KEYMAP)
            elif snake == "last_judgment":
                value = _nested_to_json(value, _JUDGMENT_KEYMAP)
            out[camel] = value
        return out


# --------------------------------------------------------------------------------------
# Events (contract §3) — discriminated union on ``type``
# --------------------------------------------------------------------------------------


@dataclass
class GaugeEvent:
    """Tagged union on ``type``: one of ``nav`` | ``heartbeat`` | ``inactive`` |
    ``tier2_result`` | ``snooze``. Only the fields relevant to a given ``type`` are set;
    the rest stay ``None`` (see contract §3 for the per-type field list)."""

    type: str
    ts: int
    page_key: str | None = None
    verdict: str | None = None       # nav: "OK" | "DRIFT"
    r0: float | None = None          # nav (degraded margin)
    tau_ok: float | None = None      # nav (degraded margin)
    degraded: bool | None = None     # nav
    flow: str | None = None          # tier2_result: "drift" | "ok"
    until: int | None = None         # snooze

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "GaugeEvent":
        kwargs: dict[str, Any] = {}
        for snake, camel in _EVENT_KEYMAP.items():
            if camel in data:
                kwargs[snake] = data[camel]
        return cls(**kwargs)

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for snake, camel in _EVENT_KEYMAP.items():
            value = getattr(self, snake)
            if value is not None:
                out[camel] = value
        return out


# --------------------------------------------------------------------------------------
# Effects (contract §4) — intents; shadow mode records but does not act
# --------------------------------------------------------------------------------------


@dataclass
class GaugeEffect:
    type: str                          # "request_tier2" | "nag" | "celebrate"
    reason: str | None = None          # request_tier2: "promotion" | "s_zero"
    tier: int | None = None            # request_tier2
    page_key: str | None = None        # request_tier2 / nag

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"type": self.type}
        if self.reason is not None:
            out["reason"] = self.reason
        if self.tier is not None:
            out["tier"] = self.tier
        if self.page_key is not None:
            out["pageKey"] = self.page_key
        return out


@dataclass
class GaugeTransition:
    state: GaugeState
    effects: list[GaugeEffect]


# --------------------------------------------------------------------------------------
# Reducer
# --------------------------------------------------------------------------------------


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def _snoozed(state: GaugeState, now: int) -> bool:
    return state.snoozed_until is not None and now < state.snoozed_until


def _margin_weight(state: GaugeState, config: GaugeConfig) -> float:
    """f(margin) = clamp((margin / M)^p, 0, 1). Degraded mode only. If no margin is
    available yet, fall back to full weight (1.0) — flagged in the notes as an assumption
    (the contract expects nav to have supplied r0/tauOk in degraded mode)."""
    if state.active_margin is None:
        return 1.0
    if config.degraded_m <= 0:
        return 1.0
    return _clamp((state.active_margin / config.degraded_m) ** config.degraded_p, 0.0, 1.0)


def reduce_gauge(state: GaugeState, event: GaugeEvent, config: GaugeConfig) -> GaugeTransition:
    """Pure reducer. Returns the next state plus emitted effect intents.

    Operation order per contract §5: inertia → accel transition → integrate. ``advance``
    (integration) runs for ``heartbeat`` / ``nav`` / ``tier2_result`` (events that move
    time forward); ``inactive`` and ``snooze`` do not integrate.
    """
    st = replace(state)  # shallow copy; nested dicts are only reassigned, never mutated → purity
    effects: list[GaugeEffect] = []

    if event.type == "snooze":
        # Not an advance event: set the gate, keep integrating on the next tick (§6).
        st.snoozed_until = event.until
        return GaugeTransition(st, effects)

    if event.type == "inactive":
        # Not an advance event (§5): freeze — rebase the clock, integrate nothing.
        st.updated_at = event.ts
        return GaugeTransition(st, effects)

    if event.type == "nav":
        # Integrate the prior page's dwell with the *prior* active verdict, THEN swap the
        # active page/verdict (§4: page switch has no immediate effect).
        _advance(st, event.ts, config, effects)
        st.active_page_key = event.page_key
        st.active_verdict = event.verdict
        if event.degraded is not None:
            st.degraded = bool(event.degraded)
        if st.degraded:
            if event.r0 is not None and event.tau_ok is not None:
                st.active_margin = abs(float(event.r0) - float(event.tau_ok))
        else:
            st.active_margin = None
        return GaugeTransition(st, effects)

    if event.type == "heartbeat":
        _advance(st, event.ts, config, effects)
        return GaugeTransition(st, effects)

    if event.type == "tier2_result":
        _advance(st, event.ts, config, effects)
        _apply_tier2(st, event, config, effects)
        return GaugeTransition(st, effects)

    # Unknown event type: no-op (defensive; the union is closed in the contract).
    return GaugeTransition(st, effects)


def _advance(st: GaugeState, now: int, config: GaugeConfig, effects: list[GaugeEffect]) -> None:
    """Integrate elapsed time into (m, s), then run the S=0 / celebration gates.

    ``now``/``updated_at`` are epoch ms; knobs (rDrain, tauM, gapCap …) are in seconds, so
    Δ is converted to seconds and clamped to [0, gapCap] (self-clamps `inactive`/over-gap)."""
    delta = _clamp((now - st.updated_at) / 1000.0, 0.0, config.gap_cap)

    if st.active_verdict is None:
        # Nothing being observed yet — rebase the clock, integrate nothing.
        st.updated_at = now
        return

    d = 1.0 if st.active_verdict == "DRIFT" else -1.0
    w = _margin_weight(st, config) if st.degraded else 1.0

    # 1) inertia (direction turns slowly; a single OK/DRIFT does not flip the sign)
    if delta > 0.0:
        st.m = st.m + (d - st.m) * (1.0 - math.exp(-delta / config.tau_m)) * w

    # 2) acceleration-tier transition (hysteresis; uses the NEW m)
    _accel_transition(st, config, effects, now)

    # 3) integrate the gauge
    s_before = st.s
    if st.active_verdict == "DRIFT":
        drain = config.r_drain * config.accel[st.accel_tier] * w * delta
        st.s = max(0.0, st.s - drain)
        # renag debt accumulates the same quantity that drained S (§6)
        st.renag_debt += drain
        _maybe_renag(st, config, effects, now)
    else:
        # Recovery accelerates with return-inertia depth (issue #122 "F"): slow just
        # after a return (m>=0 -> boost 1), accelerating as m deepens negative, capped.
        boost = min(math.exp(config.recover_gamma * max(-st.m, 0.0)), config.recover_f_max)
        gain = config.r_recover * ((1.0 - st.m) / config.k_recover) * boost * w * delta
        st.s = min(100.0, st.s + gain)

    # celebration: arm at S ≤ C_arm, fire (once) on first recovery to S ≥ C_celebrate (§6)
    if st.s <= config.c_arm:
        st.celebrate_armed = True
    if st.celebrate_armed and st.s >= config.c_celebrate:
        effects.append(GaugeEffect(type="celebrate"))
        st.celebrate_armed = False

    # episode end (m ≤ 0): reset renag schedule (§6)
    if st.m <= 0.0:
        st.nag_n = 0
        st.renag_debt = 0.0

    # S=0 final gate — fire only on the crossing into 0 (dedup; §5.2b / §6)
    if st.active_verdict == "DRIFT" and s_before > 0.0 and st.s <= 0.0:
        _s_zero_gate(st, config, effects, now)

    st.updated_at = now


def _accel_transition(st: GaugeState, config: GaugeConfig, effects: list[GaugeEffect], now: int) -> None:
    """Discrete acceleration tier transition with hysteresis (§5).

    Promotion (m ≥ tUp[tier]): degraded mode promotes immediately; normal mode emits a
    ``request_tier2{promotion}`` intent and waits (tier unchanged until confirmed).
    Demotion (m ≤ tDown[tier-1]): immediate. tDown is indexed by the *destination* tier so
    both entries are used and no index goes out of range — see notes for the resolution of
    the contract's ``T_down[tier]`` ambiguity."""
    tier = st.accel_tier
    m = st.m
    max_tier = len(config.accel) - 1

    # demotion first (a step moves m one direction, so promote/demote are mutually exclusive)
    if tier >= 1 and m <= config.t_down[tier - 1]:
        st.accel_tier = tier - 1
        return

    # promotion candidate
    if tier < max_tier and tier < len(config.t_up) and m >= config.t_up[tier]:
        if st.degraded:
            st.accel_tier = tier + 1
        elif st.pending_tier2 is None and not _snoozed(st, now):
            # normal mode: verify the promotion via Tier 2 (single outstanding request)
            effects.append(
                GaugeEffect(type="request_tier2", reason="promotion", tier=tier, page_key=st.active_page_key)
            )
            st.pending_tier2 = {
                "reason": "promotion",
                "tier": tier,
                "page_key": st.active_page_key,
                "requested_at": now,
            }


def _maybe_renag(st: GaugeState, config: GaugeConfig, effects: list[GaugeEffect], now: int) -> None:
    """Re-nag scheduling via the drift-debt counter (§6). Only after an initial nag
    (nag_n ≥ 1). Snooze suppresses the nag but retains the debt so it fires on unsnooze."""
    if st.nag_n < 1:
        return
    threshold = min(config.r_renag * (config.b_backoff ** (st.nag_n - 1)), config.r_renag_max)
    if st.renag_debt < threshold:
        return
    if _snoozed(st, now):
        return  # keep the debt; fire once the snooze lifts
    effects.append(GaugeEffect(type="nag", page_key=st.active_page_key))
    st.last_nag_ts = now
    st.nag_n += 1
    st.renag_debt = 0.0


def _s_zero_gate(st: GaugeState, config: GaugeConfig, effects: list[GaugeEffect], now: int) -> None:
    """S=0 reached (final nag gate, §5.2b / §6)."""
    if _snoozed(st, now):
        return

    if st.degraded:
        # Degraded: no Tier 2 — the margin weight is the only safety net, so nag directly.
        effects.append(GaugeEffect(type="nag", page_key=st.active_page_key))
        st.last_nag_ts = now
        st.nag_n += 1
        st.renag_debt = 0.0
        return

    # Normal: reuse a fresh judgment for the active page, else request Tier 2 (fresh_window s).
    lj = st.last_judgment
    fresh = (
        lj is not None
        and lj.get("page_key") == st.active_page_key
        and (now - lj["ts"]) <= config.fresh_window * 1000
    )
    if fresh:
        if lj["flow"] == "drift":
            effects.append(GaugeEffect(type="nag", page_key=st.active_page_key))
            st.last_nag_ts = now
            st.nag_n += 1
            st.renag_debt = 0.0
        # cached "ok" → verdict was already overridden when it arrived; nothing to do here
        return

    # cache miss → request Tier 2 s_zero (dedup against an in-flight s_zero on this page)
    already_s_zero = (
        st.pending_tier2 is not None
        and st.pending_tier2.get("reason") == "s_zero"
        and st.pending_tier2.get("page_key") == st.active_page_key
    )
    if not already_s_zero:
        effects.append(
            GaugeEffect(type="request_tier2", reason="s_zero", tier=st.accel_tier, page_key=st.active_page_key)
        )
        st.pending_tier2 = {
            "reason": "s_zero",
            "tier": st.accel_tier,
            "page_key": st.active_page_key,
            "requested_at": now,
        }


def _apply_tier2(st: GaugeState, event: GaugeEvent, config: GaugeConfig, effects: list[GaugeEffect]) -> None:
    """Apply a Tier 2 judgment (§6). Routes by the pending request's reason; caches the
    verdict in ``last_judgment`` (fresh-window reuse)."""
    st.last_judgment = {"page_key": event.page_key, "flow": event.flow, "ts": event.ts}

    pending = st.pending_tier2
    if pending is None:
        return  # no outstanding request; judgment is cached but there is nothing to resolve

    reason = pending.get("reason")
    tier = int(pending.get("tier", 0))

    if reason == "promotion":
        if event.flow == "drift":
            st.accel_tier = min(st.accel_tier + 1, len(config.accel) - 1)
        else:  # "ok" → cancel promotion, brake inertia, small refund, verdict override
            if 0 <= tier < len(config.t_down):
                st.m = min(st.m, config.t_down[tier])
            st.s = min(100.0, st.s + config.b_refund)
            if pending.get("page_key") == st.active_page_key:
                st.active_verdict = "OK"
        st.pending_tier2 = None
        return

    if reason == "s_zero":
        if event.flow == "drift":
            if not _snoozed(st, event.ts):
                effects.append(GaugeEffect(type="nag", page_key=st.active_page_key))
                st.last_nag_ts = event.ts
                st.nag_n += 1
                st.renag_debt = 0.0
            # S stays at 0 (nagging never touches S); re-nag rides renag_debt
        else:  # "ok" → misjudgment refund + reset, verdict override
            st.s = float(config.r_dismiss)
            st.m = min(st.m, 0.0)
            st.accel_tier = 0
            if pending.get("page_key") == st.active_page_key:
                st.active_verdict = "OK"
        st.pending_tier2 = None
        return
