"""Whose API key pays for this request.

BYOK ("bring your own key"): a caller may supply their own OpenAI, xAI or Groq
key so that their usage bills to them rather than to the operator. The key
arrives in a request header, is used for that request, and then goes away. Its
prefix decides which provider it is spent on — see providers.py.

The rules this module exists to enforce:

* **A user key is never persisted.** Not to disk, not to Postgres, not to a
  module-level cache. It lives in the request scope and nowhere else.
* **A user key is never logged.** Every log line and every error body that
  could carry one goes through `redact()` first. An upstream 401 can quote the
  key it rejected, so error text is scrubbed too — not just our
  own messages.
* **A user key only ever goes to its own provider.** A Groq key is never sent to
  OpenAI, and a feature its provider lacks is unavailable rather than quietly
  paid for with the server's key. providers.py enforces the routing.
* **A user key is never cached into shared client state.** `agent.py` caches
  model clients for connection reuse; that cache is keyed by model alone, so a
  cached client MUST only ever hold the server's key. User keys therefore get a
  fresh client per request. That costs a TLS handshake and buys the guarantee
  that one caller's key can never serve another caller's request.
* **A malformed key is rejected here**, before it can reach an upstream and come
  back inside an error message.
* **A key is only accepted from a signed-in account.** BYOK and identity are one
  feature, not two: see `config.REQUIRE_AUTH_FOR_USER_KEY` for why.

Set `REQUIRE_USER_API_KEY=true` to refuse the server's own key entirely, so the
deployment cannot spend the operator's credit on someone else's questions.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request

from . import config, providers
from .auth import Principal, get_principal
from .providers import Provider

log = logging.getLogger("universalcb.credentials")

#: Header the browser sends its key in. Not a cookie, deliberately: cookies are
#: sent automatically on every request including ones we did not intend, and are
#: readable by anything that manages to script the page.
USER_KEY_HEADER = "X-Provider-Key"
#: What the header was called when only OpenAI keys were accepted. Still read,
#: so a tab opened before an upgrade keeps working until it reloads.
LEGACY_KEY_HEADER = "X-OpenAI-Key"

_KEY_FORMATS = ", ".join(
    f"{p.label} '{p.key_prefix}'" for p in providers.PROVIDERS.values()
)


def redact(text: str) -> str:
    """Remove anything key-shaped from a string bound for a log or a response.

    Applied to upstream error text, which is not ours and has been observed to
    quote the credential it rejected.
    """
    return providers.ANY_KEY_RE.sub(lambda m: f"{m.group(1)}***redacted***", text or "")


@dataclass(frozen=True)
class Credentials:
    """The key this request should spend, which provider it is for, and whose."""

    api_key: str | None
    provider: Provider
    #: True when the key came from the caller rather than the server's config.
    user_supplied: bool

    @property
    def usable(self) -> bool:
        return bool(self.api_key)

    def __repr__(self) -> str:  # pragma: no cover - defensive
        # A dataclass repr would print the key the moment anything logs the
        # object, an exception renders locals, or a debugger stops here.
        return (
            f"Credentials(provider={self.provider.id}, "
            f"user_supplied={self.user_supplied}, usable={self.usable})"
        )


def _signin_required(detail: str) -> HTTPException:
    return HTTPException(
        status_code=401,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _raw_user_key(request: Request) -> str:
    return (
        request.headers.get(USER_KEY_HEADER) or request.headers.get(LEGACY_KEY_HEADER) or ""
    ).strip()


def _user_key_from(request: Request, principal: Principal) -> tuple[str, Provider] | None:
    raw = _raw_user_key(request)
    if not raw:
        return None
    if not config.ALLOW_USER_API_KEYS:
        # Configured off: ignore rather than fail, so a client that still
        # remembers a key degrades to the server's instead of breaking.
        log.info("ignoring user-supplied API key: ALLOW_USER_API_KEYS is off")
        return None
    if config.REQUIRE_AUTH_FOR_USER_KEY and not principal.is_authenticated:
        # Checked before the format check on purpose. Sign-in is the step the
        # caller actually has to take, so it is the more useful thing to be told
        # — and it avoids answering "is this key well-formed?" for someone who
        # has not identified themselves.
        raise _signin_required("Sign in before using your own API key.")
    provider = providers.for_key(raw)
    if provider is None:
        # Never echo the value, not even a prefix — a prefix plus a log leak is
        # most of a key.
        raise HTTPException(
            status_code=400,
            detail=f"That doesn't look like a supported API key. Keys start with {_KEY_FORMATS}.",
        )
    return raw, provider


def get_credentials(
    request: Request,
    principal: Principal = Depends(get_principal),
) -> Credentials:
    """FastAPI dependency: which key to spend on this request, and whose it is."""
    user_key = _user_key_from(request, principal)
    if user_key:
        key, provider = user_key
        return Credentials(api_key=key, provider=provider, user_supplied=True)

    if config.REQUIRE_USER_API_KEY:
        # Two different problems, two different statuses. An anonymous caller
        # cannot fix this by adding a key — they have to sign in first — so
        # telling them 402 would send them at a door that is still locked.
        if config.REQUIRE_AUTH_FOR_USER_KEY and not principal.is_authenticated:
            raise _signin_required("Sign in to continue.")
        raise HTTPException(
            status_code=402,  # Payment Required — the honest status here.
            detail=(
                "This deployment requires your own API key (OpenAI, xAI or Groq). "
                "Add one in settings to continue."
            ),
        )
    provider = providers.server()
    return Credentials(
        api_key=providers.server_key(provider), provider=provider, user_supplied=False,
    )


def requested_provider(request: Request) -> Provider:
    """Which provider this caller's requests will run on, for display only.

    Lets `/models` offer the right list without the gatekeeping above: it
    authorises nothing and spends nothing, so a key that would later be refused
    costs nothing here — the request that tries to spend it is checked in full.
    """
    raw = _raw_user_key(request)
    if raw and config.ALLOW_USER_API_KEYS:
        provider = providers.for_key(raw)
        if provider is not None:
            return provider
    return providers.server()


def require_usable(creds: Credentials) -> str:
    """The key, or a clear 4xx explaining which knob is missing."""
    if creds.api_key:
        return creds.api_key
    raise HTTPException(
        status_code=503,
        detail=(
            "No API key is configured. Add your own key in settings, "
            f"or set {creds.provider.key_env} on the server."
        ),
    )
