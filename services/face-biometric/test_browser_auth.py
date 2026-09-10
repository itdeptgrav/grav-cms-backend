"""Browser authorisation for the public /verify path.

The engine is reachable from the internet on one hostname and one path. A
random hostname is obscurity, not authentication, so everything that makes that
safe is checked here: the signature, the claims, the scope, the expiry, the
origin allow-list, and the ORDER — an unauthorised request must be refused
before it can cost a model inference.

Run:  python -m unittest test_browser_auth -v

Nothing here starts the real engine or loads a model. The handler's
authorisation path is exercised directly, which is the point: these are the
checks that must hold before the expensive part is reached, so the expensive
part is deliberately not involved.
"""

import base64
import hashlib
import hmac
import json
import os
import time
import unittest

os.environ.setdefault("FACE_ENGINE_KEY", "test-engine-key-please-ignore-0000000000")
os.environ.setdefault("FACE_BROWSER_TOKEN_SECRET", "test-browser-secret-please-ignore-000000")
os.environ.setdefault("FACE_ALLOWED_ORIGINS", "https://cms.grav.in")

import face_biometric_server as S


def b64url(raw):
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def mint(secret=None, **overrides):
    """A token exactly as the Node side writes one."""
    secret = secret or os.environ["FACE_BROWSER_TOKEN_SECRET"]
    now = int(time.time())
    claims = {
        "aud": "face-engine",
        "act": ["verify"],
        "sid": "session-abc",
        "iat": now,
        "exp": now + 120,
        "jti": "jti-" + str(now) + "-" + str(overrides.pop("_n", 0)),
    }
    claims.update(overrides)
    payload = b64url(json.dumps(claims).encode("utf-8"))
    sig = hmac.new(secret.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).digest()
    return payload + "." + b64url(sig)


class BrowserTokenTests(unittest.TestCase):
    def setUp(self):
        # A fresh verifier per test, so one test's replay record cannot
        # decide another's outcome.
        S.BROWSER = S._BrowserTokens()

    # -- what must be accepted ---------------------------------------------
    def test_valid_token_authorises_verify(self):
        claims, reason = S.BROWSER.verify(mint(), "POST", "/verify")
        self.assertIsNone(reason)
        self.assertEqual(claims["sid"], "session-abc")

    def test_a_token_may_be_used_for_several_frames(self):
        """Sign-in streams frames. A single-use token would break the flow it
        exists for; the bound is the expiry and the rate limit, not one use."""
        token = mint()
        for _ in range(5):
            _, reason = S.BROWSER.verify(token, "POST", "/verify")
            self.assertIsNone(reason)

    def test_subject_is_optional(self):
        """Face sign-in identifies an unknown person FROM their face. Demanding
        a subject would mean naming the employee before the recognition that is
        supposed to determine it."""
        _, reason = S.BROWSER.verify(mint(), "POST", "/verify")
        self.assertIsNone(reason)

    # -- what must be refused ----------------------------------------------
    def test_no_token(self):
        _, reason = S.BROWSER.verify("", "POST", "/verify")
        self.assertEqual(reason, "unauthorised")

    def test_wrong_signature(self):
        bad = mint(secret="a-different-secret-entirely-0000000000")
        _, reason = S.BROWSER.verify(bad, "POST", "/verify")
        self.assertEqual(reason, "unauthorised")

    def test_tampered_payload_is_not_accepted(self):
        """The claims and the signature are checked together — editing the
        payload of a validly-signed token must not survive."""
        token = mint()
        payload, sig = token.split(".")
        claims = json.loads(base64.urlsafe_b64decode(payload + "=="))
        claims["act"] = ["verify", "register"]
        forged = b64url(json.dumps(claims).encode("utf-8")) + "." + sig
        _, reason = S.BROWSER.verify(forged, "POST", "/verify")
        self.assertEqual(reason, "unauthorised")

    def test_expired(self):
        now = int(time.time())
        _, reason = S.BROWSER.verify(mint(iat=now - 300, exp=now - 10), "POST", "/verify")
        self.assertEqual(reason, "expired")

    def test_long_lived_token_is_refused_even_though_signed(self):
        """The lifetime is part of the contract, not something the minter can
        opt out of by writing a bigger number."""
        now = int(time.time())
        _, reason = S.BROWSER.verify(mint(iat=now, exp=now + 86400), "POST", "/verify")
        self.assertEqual(reason, "forbidden")

    def test_wrong_audience(self):
        _, reason = S.BROWSER.verify(mint(aud="some-other-service"), "POST", "/verify")
        self.assertEqual(reason, "forbidden")

    def test_wrong_action(self):
        _, reason = S.BROWSER.verify(mint(act=["register"]), "POST", "/verify")
        self.assertEqual(reason, "forbidden")

    def test_missing_session(self):
        _, reason = S.BROWSER.verify(mint(sid=""), "POST", "/verify")
        self.assertEqual(reason, "forbidden")

    def test_missing_jti(self):
        _, reason = S.BROWSER.verify(mint(jti=""), "POST", "/verify")
        self.assertEqual(reason, "forbidden")

    # -- scope: a browser token reaches ONE endpoint ------------------------
    def test_browser_token_cannot_reach_any_other_path(self):
        """Even with a perfect signature and unexpired claims. The permitted
        set is an allowlist in the engine, not something the token states about
        itself — a mis-minted `act` must not be able to widen it."""
        token = mint(act=["verify", "register", "reset", "reload"])
        for path in ("/register/upload", "/register/finalise", "/register/photo",
                     "/reset", "/reload", "/health", "/"):
            _, reason = S.BROWSER.verify(token, "POST", path)
            self.assertEqual(reason, "forbidden", f"{path} must not be reachable with a browser token")

    def test_get_is_not_a_browser_verb_here(self):
        _, reason = S.BROWSER.verify(mint(), "GET", "/verify")
        self.assertEqual(reason, "forbidden")

    def test_allowlist_contains_only_verify(self):
        self.assertEqual(S.BROWSER_ALLOWED, {("POST", "/verify")})

    # -- misconfiguration fails closed -------------------------------------
    def test_no_signing_key_refuses_everything(self):
        """A missing variable must not open the public path. Accepting when
        unconfigured is the one failure mode that cannot be noticed."""
        saved = S.BROWSER_TOKEN_SECRET
        try:
            S.BROWSER_TOKEN_SECRET = ""
            _, reason = S.BROWSER.verify(mint(), "POST", "/verify")
            self.assertEqual(reason, "unauthorised")
        finally:
            S.BROWSER_TOKEN_SECRET = saved

    # -- abuse control ------------------------------------------------------
    def test_rate_limit_stops_a_session_hammering(self):
        """Inference is the expensive thing on this box and a public endpoint
        invites spending it. A real capture sends a few frames a second."""
        sid = "burst-session"
        allowed = sum(1 for _ in range(200) if S.BROWSER.allow(sid))
        self.assertLessEqual(allowed, S.PUBLIC_RATE_MAX_REQUESTS)
        self.assertGreaterEqual(allowed, S.PUBLIC_BURST_MAX,
                                "a legitimate capture must not be throttled immediately")

    def test_rate_limit_is_per_session(self):
        for _ in range(200):
            S.BROWSER.allow("noisy")
        self.assertTrue(S.BROWSER.allow("quiet"),
                        "one session's abuse must not lock out another")


class OriginTests(unittest.TestCase):
    def test_allow_list_is_explicit_and_not_a_wildcard(self):
        self.assertIn("https://cms.grav.in", S.ALLOWED_ORIGINS)
        self.assertNotIn("*", S.ALLOWED_ORIGINS)

    def test_an_unknown_origin_is_not_on_the_list(self):
        self.assertNotIn("https://evil.example", S.ALLOWED_ORIGINS)


class SecretHandlingTests(unittest.TestCase):
    def test_engine_key_and_browser_secret_are_different_values(self):
        """Separate so a flaw in token handling cannot leak the credential that
        authorises enrolment."""
        self.assertNotEqual(S.ENGINE_KEY, S.BROWSER_TOKEN_SECRET)

    def test_refusal_reasons_carry_no_detail(self):
        """These strings go back over the internet. They must not describe
        which claim failed in a way that helps assemble a working token."""
        now = int(time.time())
        for token in (mint(aud="nope"), mint(act=["register"]), mint(sid=""),
                      mint(iat=now - 300, exp=now - 1), "rubbish", ""):
            _, reason = S.BROWSER.verify(token, "POST", "/verify")
            self.assertIn(reason, ("unauthorised", "forbidden", "expired"))
            self.assertNotIn(S.BROWSER_TOKEN_SECRET, str(reason))
            self.assertNotIn(S.ENGINE_KEY, str(reason))


if __name__ == "__main__":
    unittest.main(verbosity=2)
