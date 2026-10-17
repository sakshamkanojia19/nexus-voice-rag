"""Who is making this request.

The rule this module exists to enforce: **identity is never taken from the
request body.** Previously every route accepted a `session_id` that the browser
generated and could freely change, so anyone could read, delete, or upload into
another person's document corpus just by supplying their id. Ownership now comes
from one of two server-controlled sources:

* a **Supabase JWT** in the `Authorization` header, signature-verified here, or
* a **server-issued anonymous cookie** (`httpOnly`, high-entropy, `SameSite=Lax`)
  so that people can still try the product without an account.

Both collapse into a `Principal` whose `owner_key` is what scopes documents in
Qdrant and conversations in Postgres. Anonymous ids are opaque and unguessable,
so the old enumeration attack is gone even before anyone signs in.

Supabase is optional: with nothing configured, every request is anonymous and
the app behaves exactly as it does today, minus the vulnerability.
"""

from __future__ import annotations

import logging
import secrets
import time
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from fastapi import Depends, HTTPException, Request, Response
from jwt import PyJWKClient

from . import config

log = logging.getLogger("universalcb.auth")

ANON_COOKIE = "nexus_anon"
ANON_COOKIE_MAX_AGE = 60 * 60 * 24 * 365  # a year; anonymous work shouldn't vanish


@dataclass(frozen=True)
class Principal:
    """The verified identity behind a request."""

    subject: str  # Supabase user uuid, or the anonymous token
    kind: str  # "user" | "anon"
    email: str | None = None

    @property
    def owner_key(self) -> str:
        """Scope key for documents and conversations. Namespaced so a Supabase
        uuid can never collide with an anonymous token."""
        return f"{self.kind}:{self.subject}"

    @property
    def is_authenticated(self) -> bool:
        return self.kind == "user"


# ── Supabase token verification ──────────────────────────────────────────────
_jwk_client: PyJWKClient | None = None
_jwks_failed_until = 0.0


def _jwks_url() -> str:
    return config.SUPABASE_URL.rstrip("/") + "/auth/v1/.well-known/jwks.json"


def _get_jwk_client() -> PyJWKClient | None:
    """Cached JWKS client for asymmetric (RS256/ES256) Supabase projects.

    PyJWKClient caches keys internally and refetches on unknown `kid`, so key
    rotation is handled for us. A fetch failure is remembered briefly so a
    Supabase outage can't turn every request into an outbound HTTP call.
    """
    global _jwk_client, _jwks_failed_until
    if _jwk_client is not None:
        return _jwk_client
    if time.time() < _jwks_failed_until:
        return None
    try:
        _jwk_client = PyJWKClient(_jwks_url(), cache_keys=True, lifespan=600)
        return _jwk_client
    except Exception as e:  # noqa: BLE001
        _jwks_failed_until = time.time() + 30
        log.warning("JWKS client init failed: %s", e)
        return None


def _decode(token: str) -> dict[str, Any] | None:
    """Verify a Supabase access token. Returns claims, or None if invalid.

    Handles both project styles: newer asymmetric signing keys (verified via
    JWKS) and the legacy shared HS256 secret.
    """
    common = {
        "audience": "authenticated",
        "options": {"require": ["exp", "sub"]},
    }

    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as e:
        log.debug("malformed token: %s", e)
        return None

    alg = header.get("alg", "")

    if alg.startswith(("RS", "ES")):
        client = _get_jwk_client()
        if client is None:
            return None
        try:
            key = client.get_signing_key_from_jwt(token).key
            return jwt.decode(token, key, algorithms=[alg], **common)
        except Exception as e:  # noqa: BLE001
            log.debug("asymmetric verify failed: %s", e)
            return None

    if alg == "HS256":
        if not config.SUPABASE_JWT_SECRET:
            log.warning(
                "token uses HS256 but SUPABASE_JWT_SECRET is unset — "
                "copy it from Supabase → Settings → API → JWT Secret"
            )
            return None
        try:
            return jwt.decode(token, config.SUPABASE_JWT_SECRET, algorithms=["HS256"], **common)
        except jwt.PyJWTError as e:
            log.debug("HS256 verify failed: %s", e)
            return None

    log.warning("unsupported token algorithm: %r", alg)
    return None


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


# ── The dependency ───────────────────────────────────────────────────────────
def _new_anon_id() -> str:
    # 256 bits from the OS CSPRNG. The old id was Math.random() plus a
    # timestamp — roughly half of it was literally the current time.
    return secrets.token_urlsafe(32)


def get_principal(request: Request, response: Response) -> Principal:
    """FastAPI dependency: the verified caller, signed-in or anonymous.

    Falls back to anonymous whenever a token is absent or fails verification, so
    an expired session degrades to "logged out" rather than a hard error.
    """
    if config.SUPABASE_URL:
        token = _bearer(request)
        if token:
            claims = _decode(token)
            if claims and claims.get("sub"):
                return Principal(
                    subject=str(claims["sub"]),
                    kind="user",
                    email=claims.get("email"),
                )

    anon = request.cookies.get(ANON_COOKIE)
    if not anon or len(anon) < 20:
        anon = _new_anon_id()
        response.set_cookie(
            ANON_COOKIE,
            anon,
            max_age=ANON_COOKIE_MAX_AGE,
            httponly=True,  # unreadable from JS, so XSS can't lift it
            # Cross-SITE in production: the SPA is on Vercel, the API on Cloud
            # Run — two different registrable domains, so a Lax cookie would be
            # dropped by the browser and every anonymous request would land as a
            # brand-new identity. "None" is what lets it travel, and browsers
            # only accept None alongside Secure — which is exactly the
            # deployment where COOKIE_SECURE is on. Plain-HTTP local dev is
            # same-site anyway, so it keeps Lax.
            samesite="none" if config.COOKIE_SECURE else "lax",
            secure=config.COOKIE_SECURE,
            path="/",
        )
    return Principal(subject=anon, kind="anon")


def require_principal(principal: Principal = Depends(get_principal)) -> Principal:
    """FastAPI dependency: a SIGNED-IN caller, or 401.

    Used on the routes that spend money or reach stored data. Anonymous callers
    still get a working app — they can load it, read the model list, and be told
    to sign in — but they cannot bill the operator's key or touch a corpus.

    Gated on `config.REQUIRE_AUTH`, which is on by default only when Supabase is
    configured: enforcing sign-in with no identity provider wired up would lock
    everyone out of an app that has no way to let them in.

    Takes the principal via `Depends` rather than calling `get_principal`
    directly, so FastAPI's per-request dependency cache hands the same instance
    to every dependant. Calling it twice in one request would run the anonymous
    branch twice and mint two different ids — two `Set-Cookie` headers, and a
    caller whose identity differs between the route and its own credentials.
    """
    if config.REQUIRE_AUTH and not principal.is_authenticated:
        raise HTTPException(
            status_code=401,
            detail="Sign in to continue.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return principal


async def principal_for_ws(cookies: dict[str, str], token: str | None) -> Principal:
    """WebSocket variant — no Response object, so a missing cookie yields an
    ephemeral identity rather than setting one."""
    if config.SUPABASE_URL and token:
        claims = _decode(token)
        if claims and claims.get("sub"):
            return Principal(subject=str(claims["sub"]), kind="user", email=claims.get("email"))
    anon = cookies.get(ANON_COOKIE)
    return Principal(subject=anon or _new_anon_id(), kind="anon")


async def probe_supabase() -> dict[str, Any]:
    """Startup diagnostic: is Supabase reachable and which signing style is it
    on? Surfaces misconfiguration at boot instead of on a user's first sign-in."""
    if not config.SUPABASE_URL:
        return {"configured": False}
    out: dict[str, Any] = {"configured": True, "url": config.SUPABASE_URL}
    try:
        async with httpx.AsyncClient(timeout=6) as client:
            r = await client.get(_jwks_url())
            keys = r.json().get("keys", []) if r.status_code == 200 else []
        out["jwks_keys"] = len(keys)
        out["mode"] = "asymmetric" if keys else "hs256"
        if not keys and not config.SUPABASE_JWT_SECRET:
            out["warning"] = "no JWKS keys and no SUPABASE_JWT_SECRET — sign-in will fail"
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)
    return out
