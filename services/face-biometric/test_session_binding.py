"""A browser token may drive ONLY the session it was minted for.

The signature proves the backend minted the token for session A. It says
nothing about `session_id` in the request body, which is a separate field the
caller controls. Without an explicit comparison, one legitimate token can build
or extend a verification streak under any session id its holder names.

A streak is the unit of evidence here — several matching frames inside a window
— and scoping it to a session is what stops two browsers pooling their frames
into one verdict. So these tests assert both halves:

  · a mismatch is REFUSED, and
  · it is refused BEFORE the image is decoded and before ENGINE.verify runs.

The second half is the one worth having. A check that rejects after paying for
a model inference has not protected the thing that costs.

Run:  python -m unittest test_session_binding -v

The real engine is never started and no model is loaded: do_POST is driven
directly with stubs that record whether the expensive path was reached.
"""

import base64
import hashlib
import hmac
import io
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


def mint(sid="session-A", **overrides):
    """A token exactly as the Node side writes one."""
    secret = os.environ["FACE_BROWSER_TOKEN_SECRET"]
    now = int(time.time())
    claims = {
        "aud": "face-engine",
        "act": ["verify"],
        "sid": sid,
        "iat": now,
        "exp": now + 120,
        "jti": f"jti-{sid}-{now}-{overrides.pop('nonce', 0)}",
    }
    claims.update(overrides)
    payload = b64url(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
    sig = hmac.new(secret.encode("utf-8"), payload.encode("ascii"),
                   hashlib.sha256).digest()
    return f"{payload}.{b64url(sig)}"


class FakeHeaders(dict):
    """Just the case-insensitive get() that the handler uses."""

    def get(self, name, default=None):
        for k, v in self.items():
            if k.lower() == name.lower():
                return v
        return default


class Recorder:
    """Stands in for ENGINE, and remembers whether it was asked to work."""

    def __init__(self):
        self.verify_calls = []
        self.debug_dir = None

    def verify(self, sid, img, now=None):
        self.verify_calls.append(sid)
        return {"status": "NO_FACE", "employee_id": None, "employee_name": None,
                "distance": None, "margin": None, "frames_matched": 0,
                "frames_required": 2, "faces_detected": 0, "reason": None}


def drive(token, body_session_id, image="data:image/jpeg;base64,AAAA"):
    """Run do_POST for /verify and report (status, payload, decoded, verified).

    `decoded` and `verified` are what the assertions are really about: whether
    the request was allowed to reach the expensive work.
    """
    body = json.dumps({"session_id": body_session_id, "image": image}).encode()

    handler = S.Handler.__new__(S.Handler)
    handler.path = "/verify"
    handler.close_connection = False
    handler.headers = FakeHeaders({
        "Authorization": f"Bearer {token}",
        "Content-Length": str(len(body)),
        "Origin": "https://cms.grav.in",
    })
    handler.rfile = io.BytesIO(body)

    sent = {}

    def fake_json(code, payload):
        sent["code"] = code
        sent["payload"] = payload

    handler._json = fake_json

    decoded = []
    real_decode = S.decode_image
    real_engine = S.ENGINE
    recorder = Recorder()

    def fake_decode(value):
        decoded.append(value)
        return object(), None      # a truthy "image" the handler will accept

    S.decode_image = fake_decode
    S.ENGINE = recorder
    try:
        handler.do_POST()
    finally:
        S.decode_image = real_decode
        S.ENGINE = real_engine

    return sent.get("code"), sent.get("payload"), decoded, recorder.verify_calls


class SessionBindingTests(unittest.TestCase):
    def setUp(self):
        # A fresh limiter per test: replay and rate state must not leak between
        # cases, or a later test fails for a reason belonging to an earlier one.
        S.BROWSER = S._BrowserTokens()

    def test_matching_session_is_allowed_through(self):
        code, payload, decoded, verified = drive(mint(sid="session-A"), "session-A")
        self.assertEqual(code, 200, payload)
        self.assertEqual(len(decoded), 1, "the image should have been decoded")
        self.assertEqual(verified, ["session-A"])

    def test_mismatched_session_is_refused(self):
        code, payload, _, _ = drive(mint(sid="session-A"), "session-B")
        self.assertEqual(code, 403)
        self.assertEqual(payload["error"], "forbidden")

    def test_mismatch_never_reaches_the_image(self):
        """The point of the fix: refused before anything expensive."""
        _, _, decoded, verified = drive(mint(sid="session-A"), "session-B")
        self.assertEqual(decoded, [], "a refused request decoded the image")
        self.assertEqual(verified, [], "a refused request called ENGINE.verify")

    def test_token_for_A_cannot_build_a_streak_in_B(self):
        """Several frames, all refused — no evidence accumulates in B."""
        for i in range(5):
            code, _, decoded, verified = drive(mint(sid="session-A", nonce=i),
                                               "session-B")
            self.assertEqual(code, 403)
            self.assertEqual(verified, [])
            self.assertEqual(decoded, [])

    def test_refusal_reveals_nothing_about_the_expected_session(self):
        """The error must not help somebody guess the session it wanted."""
        _, payload, _, _ = drive(mint(sid="session-A"), "session-B")
        self.assertEqual(set(payload.keys()), {"ok", "error"})
        self.assertNotIn("session-A", json.dumps(payload))

    def test_rate_limit_is_scoped_to_the_token_session(self):
        """Scope is unchanged by the fix: the budget belongs to the TOKEN's
        session, so naming a different body session cannot buy more of it.

        Two limits apply and a tight loop meets the burst one first — that is
        the intended shape, so it is what is asserted rather than the window
        cap alone."""
        S.BROWSER = S._BrowserTokens()
        for i in range(S.PUBLIC_BURST_MAX):
            self.assertTrue(S.BROWSER.allow("session-A"), f"exhausted at {i}")
        self.assertFalse(S.BROWSER.allow("session-A"),
                         "the 1-second burst cap should have stopped this")
        # A different session has its own budget, untouched by the above —
        # which is exactly why the token's sid, not the body's, must be the
        # thing counted.
        self.assertTrue(S.BROWSER.allow("session-B"))

    def test_engine_key_caller_is_unaffected(self):
        """The Node API sends no browser token and no session claim; the
        binding must not apply to it."""
        body = json.dumps({"session_id": "anything", "image": "x"}).encode()
        handler = S.Handler.__new__(S.Handler)
        handler.path = "/verify"
        handler.close_connection = False
        handler.headers = FakeHeaders({
            "X-Face-Key": os.environ["FACE_ENGINE_KEY"],
            "Content-Length": str(len(body)),
        })
        handler.rfile = io.BytesIO(body)
        sent = {}
        handler._json = lambda c, p: sent.update(code=c, payload=p)

        real_decode, real_engine = S.decode_image, S.ENGINE
        recorder = Recorder()
        S.decode_image = lambda v: (object(), None)
        S.ENGINE = recorder
        try:
            handler.do_POST()
        finally:
            S.decode_image, S.ENGINE = real_decode, real_engine

        self.assertEqual(sent.get("code"), 200, sent.get("payload"))
        self.assertEqual(recorder.verify_calls, ["anything"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
