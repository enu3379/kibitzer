from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from ..config import JudgmentAuditConfig
from ..schemas import Verdict
from .title_quality import is_low_quality_title

AuditTrigger = Literal["low_margin", "low_quality_title", "mixed_host", "risk_host"]

_STRIPPED_HOST_PREFIXES = (
    "www.",
    "m.",
    "mobile.",
    "amp.",
    "search.",
    "news.",
)
_SECOND_LEVEL_COUNTRY_DOMAINS = {"ac", "co", "go", "ne", "or", "pe", "re"}


@dataclass(frozen=True)
class AuditRoutingDecision:
    trigger: AuditTrigger | None = None

    @property
    def should_audit(self) -> bool:
        return self.trigger is not None


def choose_audit_trigger(
    *,
    verdict: Verdict,
    tier0_score: float | None,
    title_quality: str | None,
    host_family: str,
    host_family_verdicts: set[Verdict],
    config: JudgmentAuditConfig,
) -> AuditRoutingDecision:
    if not config.enabled or verdict != Verdict.OK:
        return AuditRoutingDecision()

    if tier0_score is not None and tier0_score < config.audit_ok_below:
        return AuditRoutingDecision("low_margin")
    if config.audit_low_quality_titles and is_low_quality_title(title_quality):
        return AuditRoutingDecision("low_quality_title")
    if config.audit_mixed_hosts and _mixed_with_current_ok(host_family_verdicts):
        return AuditRoutingDecision("mixed_host")
    if host_family and host_family in {host.casefold() for host in config.risk_hosts}:
        return AuditRoutingDecision("risk_host")
    return AuditRoutingDecision()


def host_family(host: str | None) -> str:
    value = (host or "").strip().casefold().strip(".")
    if not value:
        return ""
    for prefix in _STRIPPED_HOST_PREFIXES:
        if value.startswith(prefix):
            value = value[len(prefix) :]
            break
    parts = [part for part in value.split(".") if part]
    if len(parts) <= 2:
        return value
    if len(parts[-1]) == 2 and parts[-2] in _SECOND_LEVEL_COUNTRY_DOMAINS and len(parts) >= 3:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def _mixed_with_current_ok(host_family_verdicts: set[Verdict]) -> bool:
    # The current observation is already a Tier-0 OK when this helper is used;
    # any earlier DRIFT on the family makes this host mixed for audit purposes.
    return Verdict.DRIFT in host_family_verdicts
