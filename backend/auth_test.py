"""Proves ownership can no longer be forged.

Run: python -m backend.auth_test

The old model let the browser pick its own `session_id`, so supplying someone
else's id granted full read/write access to their documents. These checks are
written as attacks: each one attempts the old exploit and asserts it now fails.

Runs fully offline — Supabase tokens are minted with a locally generated key
pair, so no project or network access is needed.
"""

from __future__ import annotations

import time
import uuid

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from . import auth, config

_failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global _failures
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  → {detail}" if not ok and detail else ""))
    if not ok:
        _failures += 1


def _client() -> TestClient:
    import backend.main as m

    # cookies=... would be shared across requests; we want independent callers.
    return TestClient(m.app)


class _open_access:
    """Run a block with every anonymous-caller gate off.

    Several checks below are about anonymous callers specifically — that a
    forged `session_id` in the body is *ignored* rather than honoured, and that
    /documents takes no id to substitute. Those properties have to hold whether
    or not the gates are on, and a 401 would mask them rather than prove them.

    There are three gates, not one: REQUIRE_AUTH refuses anonymous callers
    outright, and the BYOK pair refuses to spend any key for someone who has not
    signed in. All of them have to come off, or these tests stop testing what
    they claim to. Each gate is asserted on its own elsewhere —
    `test_require_auth_blocks_anonymous_callers` here, and the BYOK ordering in
    `credentials_test.py`.
    """

    _GATES = {
        "REQUIRE_AUTH": False,
        "REQUIRE_USER_API_KEY": False,
        "REQUIRE_AUTH_FOR_USER_KEY": False,
    }

    def __enter__(self) -> None:
        self._original = {k: getattr(config, k) for k in self._GATES}
        for k, v in self._GATES.items():
            setattr(config, k, v)

    def __exit__(self, *_exc: object) -> None:
        for k, v in self._original.items():
            setattr(config, k, v)


def test_anon_identity_is_server_issued() -> None:
    c = _client()
    r = c.get("/health")
    cookie = r.cookies.get(auth.ANON_COOKIE)
    check("anonymous id is issued by the server", bool(cookie))
    check(
        "anonymous id has real entropy (>=32 chars)",
        bool(cookie) and len(cookie) >= 32,
        f"len={len(cookie or '')}",
    )
    set_cookie = r.headers.get("set-cookie", "")
    check("anonymous cookie is HttpOnly", "httponly" in set_cookie.lower())
    check("anonymous cookie is SameSite", "samesite" in set_cookie.lower())


def test_body_session_id_cannot_forge_ownership() -> None:
    """The original exploit: name someone else's session and inherit their data."""
    victim = auth.Principal(subject="victim-secret-id", kind="anon")
    c = _client()
    c.get("/health")  # obtain our own anon cookie

    with _open_access():
        r = c.post(
            "/chat",
            json={
                "message": "who are you",
                "session_id": victim.subject,  # the forged field
                "stream": True,
            },
        )
    check("request with a forged session_id still succeeds (ignored, not fatal)", r.status_code == 200)

    # The routes that used to take an owner id in the path no longer read by id.
    # 405 is as good as 404 here: DELETE /documents/{doc_id} now owns that path
    # shape, and it scopes deletion to the caller — so a GET has no route at all.
    got = c.get(f"/documents/{victim.subject}")
    check(
        "no route reads documents by owner id",
        got.status_code in (404, 405),
        f"HTTP {got.status_code}: {got.text[:80]}",
    )
    check(
        "old two-segment delete route is gone",
        c.delete(f"/documents/{victim.subject}/some-doc").status_code == 404,
    )


def test_documents_scope_to_the_caller() -> None:
    """Two anonymous callers must never see each other's owner key."""
    a, b = _client(), _client()
    a.get("/health")
    b.get("/health")
    ca = a.cookies.get(auth.ANON_COOKIE)
    cb = b.cookies.get(auth.ANON_COOKIE)
    check("two callers get different anonymous ids", bool(ca) and bool(cb) and ca != cb)

    # /documents answers only for the caller; with no store it is an empty list,
    # but crucially it takes no id at all, so there is nothing to substitute.
    with _open_access():
        r = a.get("/documents")
    check("GET /documents needs no id and returns 200", r.status_code == 200, str(r.status_code))


def test_require_auth_blocks_anonymous_callers() -> None:
    """With enforcement on, anonymous callers cannot spend money or read data.

    The complement of the checks above: those prove an anonymous caller cannot
    forge *someone else's* identity, this proves they get no service at all when
    the deployment says accounts are required.
    """
    original = config.REQUIRE_AUTH
    config.REQUIRE_AUTH = True
    try:
        c = _client()
        c.get("/health")  # a cookie, but still anonymous

        for method, path, kwargs in [
            ("post", "/chat", {"json": {"message": "hi", "stream": True}}),
            ("get", "/documents", {}),
            ("delete", "/documents/some-id", {}),
            ("post", "/transcribe", {"files": {"file": ("a.wav", b"RIFF", "audio/wav")}}),
        ]:
            r = getattr(c, method)(path, **kwargs)
            check(
                f"{method.upper()} {path} refuses an anonymous caller",
                r.status_code == 401,
                f"got {r.status_code}",
            )

        # /health must stay open, or the client cannot discover that it needs to
        # sign in — and monitoring loses its probe.
        check("GET /health stays open", c.get("/health").status_code == 200)
    finally:
        config.REQUIRE_AUTH = original


def test_transcribe_is_not_an_open_door() -> None:
    """It previously had no identity check at all: anyone reachable could post
    audio and spend the deployment's transcription budget."""
    import inspect

    import backend.main as m

    params = inspect.signature(m.transcribe_endpoint).parameters
    defaults = [p.default for p in params.values()]
    has_principal_dep = any(
        getattr(d, "dependency", None) is auth.require_principal for d in defaults
    )
    check("/transcribe requires a verified principal", has_principal_dep)


def test_supabase_token_verification() -> None:
    """A valid signature grants a user identity; tampering or expiry does not."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    kid = "test-key"
    user_id = str(uuid.uuid4())

    def make(**overrides) -> str:
        claims = {
            "sub": user_id,
            "aud": "authenticated",
            "email": "saksham@example.com",
            "exp": int(time.time()) + 3600,
            **overrides,
        }
        return jwt.encode(claims, key, algorithm="RS256", headers={"kid": kid})

    # Point the verifier at our local key instead of Supabase's JWKS.
    class _FakeJWKClient:
        def get_signing_key_from_jwt(self, token):  # noqa: ANN001
            class _K:
                pass

            k = _K()
            k.key = key.public_key()
            return k

    original_url, original_client = config.SUPABASE_URL, auth._jwk_client
    config.SUPABASE_URL = "https://example.supabase.co"
    auth._jwk_client = _FakeJWKClient()
    try:
        claims = auth._decode(make())
        check("valid RS256 token verifies", bool(claims) and claims.get("sub") == user_id)

        good = make()
        tampered = good[:-4] + ("aaaa" if not good.endswith("aaaa") else "bbbb")
        check("tampered signature is rejected", auth._decode(tampered) is None)

        check("expired token is rejected", auth._decode(make(exp=int(time.time()) - 10)) is None)
        check("wrong audience is rejected", auth._decode(make(aud="anon")) is None)

        # The classic JWT attack: claim the token needs no signature.
        none_tok = jwt.encode({"sub": "attacker", "aud": "authenticated"}, key="", algorithm="none")
        check("alg=none is rejected", auth._decode(none_tok) is None)

        p = auth.Principal(subject=user_id, kind="user")
        check("user owner_key is namespaced", p.owner_key == f"user:{user_id}", p.owner_key)
        check(
            "anon and user keyspaces cannot collide",
            auth.Principal(subject=user_id, kind="anon").owner_key != p.owner_key,
        )
    finally:
        config.SUPABASE_URL, auth._jwk_client = original_url, original_client


def main() -> int:
    test_anon_identity_is_server_issued()
    test_body_session_id_cannot_forge_ownership()
    test_documents_scope_to_the_caller()
    test_require_auth_blocks_anonymous_callers()
    test_transcribe_is_not_an_open_door()
    test_supabase_token_verification()
    print(f"\n{'all checks passed' if not _failures else f'{_failures} check(s) failed'}")
    return 1 if _failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
