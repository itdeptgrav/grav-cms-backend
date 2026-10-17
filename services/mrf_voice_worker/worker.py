"""Deterministic LiveKit worker for authenticated in-CMS MRF approvals."""

from __future__ import annotations

import asyncio
import json
import os
import re

import httpx
from livekit import agents
from livekit.agents import Agent, AgentServer, AgentSession
from livekit.agents.llm import ChatContext, ChatMessage, StopResponse
from livekit.plugins import openai, silero
from speech_text import is_negative_hearing_response


BACKEND = os.environ["GRAV_BACKEND_URL"].rstrip("/")
SECRET = os.environ["MRF_VOICE_WORKER_SECRET"]
GATEWAY = os.environ.get("GRAV_SPEECH_GATEWAY_URL", "http://127.0.0.1:8890/v1").rstrip("/")
GATEWAY_KEY = os.environ.get("GRAV_SPEECH_GATEWAY_KEY", "local-only")
DIALOG_GATEWAY = os.environ.get("GRAV_DIALOG_GATEWAY_URL", "http://127.0.0.1:8891/v1").rstrip("/")
DIALOG_KEY = os.environ.get("GRAV_DIALOG_GATEWAY_KEY", "local-only")
DIALOG_DEADLINE_SECONDS = float(os.environ.get("MRF_DIALOG_DEADLINE_SECONDS", "1.5"))
AGENT_NAME = os.environ.get("MRF_VOICE_AGENT_NAME", "grav-mrf-approval")


async def prewarm_speech(text: str, language: str) -> None:
    """Populate the private full-WAV cache while the caller hears the greeting."""
    # Odia still uses the continuously streamed Parler model. Starting a hidden
    # generation would occupy its single GPU stream and delay audible speech.
    if language == "or":
        return
    model = "chatterbox-hi" if language == "hi" else "kokoro"
    voice = "hi_female" if language == "hi" else "af_heart"
    try:
        async with httpx.AsyncClient(timeout=180) as client:
            response = await client.post(
                f"{GATEWAY}/audio/speech",
                headers={"Authorization": f"Bearer {GATEWAY_KEY}"},
                json={
                    "model": model,
                    "input": text,
                    "voice": voice,
                    "response_format": "wav",
                    "speed": 1.0,
                },
            )
        response.raise_for_status()
    except Exception:
        # The ordinary LiveKit TTS request remains the authoritative retry.
        return


async def prepared_speech_text(text: str, language: str) -> str:
    """Return the exact text the private speech gateway will synthesize."""
    if language not in {"hi", "or"}:
        return text
    try:
        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.post(
                f"{GATEWAY}/speech-text",
                headers={"Authorization": f"Bearer {GATEWAY_KEY}"},
                json={"input": text, "language": language},
            )
        response.raise_for_status()
        prepared = str(response.json().get("text") or "").strip()
        return prepared or text
    except Exception:
        # The TTS endpoint performs the same preparation authoritatively. This
        # fallback preserves call availability if the diagnostic lookup fails.
        return text


def varied(call: dict, *choices: str) -> str:
    """Rotate wording locally while keeping the workflow meaning unchanged."""
    turn = int(call.get("_wordingTurn") or 0)
    call["_wordingTurn"] = turn + 1
    seed = sum(ord(char) for char in str(call.get("mrfNumber") or ""))
    return choices[(seed + turn) % len(choices)]


async def backend(method: str, path: str, payload: dict | None = None) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.request(
            method,
            f"{BACKEND}/api/cms/mrf-voice-approvals{path}",
            headers={"Authorization": f"Bearer {SECRET}"},
            json=payload,
        )
    response.raise_for_status()
    return response.json()


def resume_prompt(call: dict, phase: str, intent: str = "") -> str:
    language = call.get("language") or "en"
    if phase == "CONFIRMATION":
        if language == "hi":
            return "तो, क्या मैं इस निर्णय की पुष्टि करूँ? हाँ या रद्द कहें।"
        if language == "or":
            return "ତେବେ, ଏହି ନିଷ୍ପତ୍ତି ନିଶ୍ଚିତ କରିବି କି? ହଁ କିମ୍ବା ବାତିଲ କହନ୍ତୁ।"
        decision = intent.lower() or "decision"
        return varied(
            call,
            f"Coming back to the request, should I confirm the {decision}? You can say yes or cancel.",
            f"Returning to the request: do you want me to confirm the {decision}, or cancel it?",
            f"Back to the approval—shall I confirm the {decision}? Say yes if that is right, or no to cancel.",
        )
    if language == "hi":
        return "तो, इस अनुरोध के लिए मंजूर, अस्वीकार, या बाद में कहें।"
    if language == "or":
        return "ତେବେ, ଏହି ଅନୁରୋଧ ପାଇଁ ଅନୁମୋଦନ, ପ୍ରତ୍ୟାଖ୍ୟାନ, କିମ୍ବା ପରେ କହନ୍ତୁ।"
    return varied(
        call,
        "Coming back to the request, would you like to approve it, reject it, or decide later?",
        "Let us return to the request. You can approve, reject, or leave it for later.",
        "Back to the approval: should this proceed, be rejected, or wait until later?",
    )


def introduction_parts(call: dict) -> list[str]:
    """Return natural, useful turns ordered for just-in-time pre-rendering.

    Do not speak the internal MRF identifier. It is useful on screen and in
    diagnostics, but makes the call sound mechanical and adds synthesis work
    before the approver hears the actual request.
    """
    if call.get("workflowKey") == "morning_brief":
        summary = str(call.get("workflowSummary") or "Nothing urgent is showing in your personal work summary right now.")
        return [
            varied(call, "Thanks, I can hear you.", "Great, I can hear you clearly.", "Good morning. I am with you."),
            summary,
            "You can ask me to repeat it, open your Home page, or say that's all.",
        ]
    requester = call.get("requestedForName") or "a team member"
    items = call.get("itemSummary") or "the pending material items"
    language = call.get("language") or "en"
    if language == "hi":
        return [
            f"धन्यवाद। {requester} की मटेरियल रिक्वेस्ट आपके अप्रूवल के लिए आई है।",
            f"रिक्वेस्ट में ये आइटम्स हैं: {items}।",
            "बताइए—इसे अप्रूव करना है, रिजेक्ट, या अभी पेंडिंग रखना है?",
        ]
    if language == "or":
        return [
            f"ଧନ୍ୟବାଦ। {requester}ଙ୍କ ମ୍ୟାଟେରିଆଲ୍ ରିକ୍ୱେଷ୍ଟ ଆପଣଙ୍କ ଆପ୍ରୁଭାଲ୍ ପାଇଁ ଆସିଛି।",
            f"ରିକ୍ୱେଷ୍ଟରେ ଏହି ଆଇଟମ୍ସ ଅଛି: {items}।",
            "କହନ୍ତୁ—ଆପ୍ରୁଭ୍ କରିବେ, ରିଜେକ୍ଟ, ନା ଏବେ ପେଣ୍ଡିଂ ରଖିବେ?",
        ]
    return [
        varied(
            call,
            f"Thanks. {requester}'s material request is ready for your approval.",
            f"Great. I have a material request from {requester} for your approval.",
            f"Thank you. {requester} has sent a material request for your decision.",
        ),
        f"The requested items are: {items}.",
        "Would you like to approve it, reject it, or decide later?",
    ]


def greeting(call: dict, again: bool = False) -> str:
    language = call.get("language") or "en"
    if call.get("workflowKey") == "morning_brief":
        if again:
            return varied(call, "Hello, are you there for your morning brief?", "Can you hear me clearly?", "Just checking—are you ready for your brief?")
        return varied(
            call,
            "Good morning. This is GRAV with your personal morning brief. Can you hear me?",
            "Hello. Your GRAV morning brief is ready. Am I coming through clearly?",
            "Good morning from GRAV. I have your summary for today. Can you hear me?",
        )
    if language == "hi":
        return "हेलो? क्या आप मुझे सुन पा रहे हैं?" if again else "हेलो। मैं ग्रैव से एक मटेरियल रिक्वेस्ट के अप्रूवल के लिए कॉल कर रही हूँ। क्या आप मुझे सुन पा रहे हैं?"
    if language == "or":
        return "ହେଲୋ? ଆପଣ ମୋ କଥା ଶୁଣି ପାରୁଛନ୍ତି କି?" if again else "ହେଲୋ। ମୁଁ ଗ୍ରାଭରୁ ଏକ ମ୍ୟାଟେରିଆଲ୍ ରିକ୍ୱେଷ୍ଟର ଆପ୍ରୁଭାଲ୍ ପାଇଁ କଲ୍ କରୁଛି। ଆପଣ ମୋ କଥା ଶୁଣି ପାରୁଛନ୍ତି କି?"
    if again:
        return varied(call, "Hello, are you still with me?", "Can you hear me clearly?", "Just checking—are you there?")
    return varied(
        call,
        "Hello. This is GRAV calling about a material request. Can you hear me?",
        "Hi, this is the GRAV approval assistant. Am I coming through clearly?",
        "Hello there. I am calling from GRAV about a request awaiting review. Can you hear me?",
    )


def fallback_dialog(call: dict, phase: str) -> str:
    del phase
    language = call.get("language") or "en"
    if language == "hi":
        return "मैं केवल इस मंजूरी अनुरोध में सहायता कर सकती हूँ।"
    if language == "or":
        return "ମୁଁ କେବଳ ଏହି ଅନୁମୋଦନ ଅନୁରୋଧରେ ସାହାଯ୍ୟ କରିପାରିବି।"
    return varied(
        call,
        "I can help with this approval request, but I do not have enough information to answer that.",
        "I only have the details needed for this approval call.",
        "That is outside what I can see here, though I can still help you decide this request.",
    )


def dialogue_act_options(call: dict, act: str) -> tuple[str, ...]:
    """Controller-owned spoken responses for the semantic router.

    Qwen chooses an act, never prose. Keeping these options bounded means every
    possible reply can be rendered before it is needed and safely varied
    without an uncached TTS request on the caller's critical path.
    """
    language = call.get("language") or "en"
    intro = call.get("_introParts") or introduction_parts(call)
    if act == "WHO_REQUESTED":
        return (str(intro[0]),)
    if act == "ITEMS":
        return (str(intro[1]),)
    if act == "REPEAT":
        return (str(intro[0]), str(intro[1]))
    if act == "OPEN_REQUEST":
        return (phrase("OPEN_REQUEST", {}, call),)
    options = {
        "hi": {
            "CONFIRM_APPROVE": (
                "क्या आप इस रिक्वेस्ट को अप्रूव करना चाहते हैं?",
                "तो मैं इसे अप्रूवल मानूँ—क्या यही आपका फैसला है?",
            ),
            "CONFIRM_REJECT": (
                "क्या आप इस रिक्वेस्ट को रिजेक्ट करना चाहते हैं?",
                "तो आपका फैसला इसे रिजेक्ट करने का है—क्या मैंने सही समझा?",
            ),
            "CONFIRM_DEFER": (
                "क्या आप इस रिक्वेस्ट पर बाद में फैसला करना चाहते हैं?",
                "तो अभी इसे पेंडिंग रखें—क्या यही आपका मतलब है?",
            ),
            "ACKNOWLEDGE": ("जी, मैं सुन रही हूँ।", "हाँ, आपकी बात सुन रही हूँ।"),
            "REFOCUS": (
                "समझ गई। मैं इस कॉल में केवल इसी मटेरियल रिक्वेस्ट में मदद कर सकती हूँ।",
                "ठीक है। अभी मैं इसी रिक्वेस्ट के अप्रूवल पर आपकी मदद कर सकती हूँ।",
            ),
        },
        "or": {
            "CONFIRM_APPROVE": (
                "ଆପଣ ଏହି ରିକ୍ୱେଷ୍ଟକୁ ଆପ୍ରୁଭ୍ କରିବାକୁ ଚାହୁଁଛନ୍ତି କି?",
                "ତେବେ ଏହାକୁ ଆପ୍ରୁଭାଲ୍ ଭାବେ ନେବି—ଏହା ଠିକ୍ କି?",
            ),
            "CONFIRM_REJECT": (
                "ଆପଣ ଏହି ରିକ୍ୱେଷ୍ଟକୁ ରିଜେକ୍ଟ କରିବାକୁ ଚାହୁଁଛନ୍ତି କି?",
                "ତେବେ ଆପଣଙ୍କ ଡିସିସନ୍ ରିଜେକ୍ଟ କରିବା—ମୁଁ ଠିକ୍ ବୁଝିଲି କି?",
            ),
            "CONFIRM_DEFER": (
                "ଆପଣ ଏହି ରିକ୍ୱେଷ୍ଟର ଡିସିସନ୍ ପରେ ନେବାକୁ ଚାହୁଁଛନ୍ତି କି?",
                "ତେବେ ଏବେ ଏହାକୁ ପେଣ୍ଡିଂ ରଖିବା—ଏହା ଠିକ୍ କି?",
            ),
            "ACKNOWLEDGE": ("ହଁ, ମୁଁ ଶୁଣୁଛି।", "ଠିକ୍ ଅଛି, ମୁଁ ଆପଣଙ୍କ କଥା ଶୁଣୁଛି।"),
            "REFOCUS": (
                "ବୁଝିଲି। ଏହି କଲ୍‌ରେ ମୁଁ କେବଳ ଏହି ମ୍ୟାଟେରିଆଲ୍ ରିକ୍ୱେଷ୍ଟରେ ସାହାଯ୍ୟ କରିପାରିବି।",
                "ଠିକ୍ ଅଛି। ଏବେ ମୁଁ ଏହି ରିକ୍ୱେଷ୍ଟର ଆପ୍ରୁଭାଲ୍‌ରେ ସାହାଯ୍ୟ କରିପାରିବି।",
            ),
        },
        "en": {
            "CONFIRM_APPROVE": (
                "Are you saying you want this request approved?",
                "Should I take that as your choice to approve the request?",
            ),
            "CONFIRM_REJECT": (
                "Are you saying you want this request rejected?",
                "Should I take that as your choice to reject the request?",
            ),
            "CONFIRM_DEFER": (
                "Would you like to leave this request pending and decide later?",
                "Are you saying you would rather come back to this request later?",
            ),
            "ACKNOWLEDGE": ("Yes, I am listening.", "I hear you."),
            "REFOCUS": (
                "Understood. I can help with this material request during this call.",
                "All right. For now, I can help you decide this approval request.",
            ),
        },
    }
    return options.get(language, options["en"]).get(act, options.get(language, options["en"])["REFOCUS"])


def dialogue_act_reply(call: dict, act: str) -> str:
    return varied(call, *dialogue_act_options(call, act))


def interruption_bridge(call: dict) -> str:
    language = call.get("language") or "en"
    if language == "hi":
        return "जी, मैंने आपकी बात सुनी।"
    if language == "or":
        return "ହଁ, ମୁଁ ଆପଣଙ୍କ କଥା ଶୁଣିଲି।"
    return varied(call, "Of course, I heard you.", "Yes, I caught that.", "Got it—I am listening.")


async def conversational_reply(
    text: str,
    phase: str,
    call: dict,
    *,
    session_id: str = "",
    intent: str = "",
    interrupted: bool = False,
) -> dict:
    language = call.get("language") or "en"
    payload = {
        # GRAV Speech intentionally returns a Roman transcript. The fast Qwen
        # router understands Romanized Hindi/Odia directly; translating it
        # first added 3-4 seconds without improving the bounded decision path.
        "callerText": text,
        "phase": phase,
        "language": language,
        "mrfNumber": call.get("mrfNumber") or "",
        "requestedForName": call.get("requestedForName") or "",
        "requestedForDept": call.get("requestedForDept") or "",
        "itemSummary": call.get("itemSummary") or "",
        "pendingIntent": intent,
        "interrupted": interrupted,
        "previousAgentText": str(call.get("_lastAgentText") or "")[-420:],
        "labInstruction": str(call.get("qwenLabInstruction") or "")[:1200] if call.get("isTest") else "",
    }
    if call.get("isTest") and session_id:
        try:
            await backend("POST", f"/worker/{session_id}/dialog", {
                "direction": "INPUT",
                "text": json.dumps(payload, ensure_ascii=False),
            })
        except Exception:
            pass
    try:
        async with httpx.AsyncClient(timeout=DIALOG_DEADLINE_SECONDS) as client:
            response = await client.post(
                f"{DIALOG_GATEWAY}/dialog",
                headers={"Authorization": f"Bearer {DIALOG_KEY}"},
                json=payload,
            )
        response.raise_for_status()
        data = response.json()
        act = str(data.get("replyAct") or "REFOCUS").upper()
        candidate = str(data.get("candidateIntent") or "UNKNOWN").upper()
        confidence = float(data.get("confidence") or 0)
        if candidate not in {"APPROVE", "REJECT", "DEFER"} or confidence < 0.65:
            candidate = "UNKNOWN"
        result = {
            "reply": dialogue_act_reply(call, act),
            "replyAct": act,
            "candidate": candidate,
            "confidence": confidence,
        }
        if call.get("isTest") and session_id:
            try:
                await backend("POST", f"/worker/{session_id}/dialog", {
                    "direction": "OUTPUT",
                    "text": json.dumps({
                        "reply": result["reply"],
                        "replyAct": act,
                        "candidateIntent": candidate,
                        "confidence": confidence,
                        "model": data.get("model") or "",
                    }, ensure_ascii=False),
                    "intent": candidate,
                    "confidence": confidence,
                })
            except Exception:
                pass
        return result
    except Exception:
        result = {
            "reply": dialogue_act_reply(call, "REFOCUS"),
            "replyAct": "REFOCUS",
            "candidate": "UNKNOWN",
            "confidence": 0,
        }
        if call.get("isTest") and session_id:
            try:
                await backend("POST", f"/worker/{session_id}/dialog", {
                    "direction": "OUTPUT",
                    "text": json.dumps({**result, "fallback": True}, ensure_ascii=False),
                    "intent": "UNKNOWN",
                    "confidence": 0,
                })
            except Exception:
                pass
        return result


def clarification_answer(text: str) -> str:
    normalized = re.sub(r"[^\w\s]", " ", text.lower(), flags=re.UNICODE)
    if re.search(r"\b(no|nope|cancel|stop|not that|i did not|i didn't|nahi|nahin|na|batil)\b|नहीं|नही|रद्द|ନା|ବାତିଲ", normalized):
        return "NO"
    if re.search(r"\b(yes|yeah|yep|correct|right|exactly|that is what i mean|that's what i mean|haan|han|ji)\b|हाँ|हां|ଜଁ|ହଁ", normalized):
        return "YES"
    return "UNKNOWN"


def clarification_retry(call: dict, candidate: str) -> str:
    label = {"APPROVE": "approve", "REJECT": "reject", "DEFER": "decide later"}.get(candidate, "choose that")
    language = call.get("language") or "en"
    if language == "hi":
        return "क्या आपका मतलब यही है? कृपया हाँ या नहीं कहें।"
    if language == "or":
        return "ଆପଣଙ୍କର ଅର୍ଥ ଏହା କି? ଦୟାକରି ହଁ କିମ୍ବା ନା କହନ୍ତୁ।"
    return varied(
        call,
        f"Just to be sure, are you saying you want to {label}? Please say yes or no.",
        f"Have I understood you correctly—you want to {label}?",
        f"Let me check what you meant. Should I treat that as a choice to {label}?",
    )


def phrase(action: str, result: dict, call: dict) -> str:
    if call.get("workflowKey") == "morning_brief":
        summary = str(call.get("workflowSummary") or "Nothing urgent is showing in your personal work summary right now.")
        options = {
            "REPEAT_BRIEF": (
                f"Of course. Here is the brief again. {summary} You can ask me to repeat it, open Home, or say that's all.",
                f"Certainly. I will run through it once more. {summary} Tell me if you want Home opened or if you are finished.",
            ),
            "OPEN_HOME": (
                "I have marked the Home page as the place to continue. You can end this call and review every item there.",
                "Open GRAV Home for the full details. I have not changed any task or request from this call.",
            ),
            "END_BRIEF": (
                "All right. Your morning brief is complete. Have a productive day.",
                "That is everything for now. I have ended the brief without changing any work item.",
                "Done. Your Home page remains available if you want the details later.",
            ),
            "BRIEF_HELP": (
                "I can repeat today's brief, help you open the Home page, or finish the call. Which would you like?",
                "For this first briefing I can repeat the summary, direct you to Home, or end the call. Tell me what works for you.",
            ),
        }.get(action)
        if options:
            return varied(call, *options)
        return varied(call, "Could you say repeat, open Home, or that's all?", "I missed that. Do you want the brief again, Home opened, or to finish?")
    number = call.get("mrfNumber") or "the material request"
    language = call.get("language") or "en"
    if call.get("isTest") and action == "COMMIT":
        fixed = {
            "hi": "पुष्टि हो गई। यह वॉइस लैब परीक्षण पूरा हुआ; कोई असली मटेरियल रिक्वेस्ट नहीं बदली।",
            "or": "ନିଶ୍ଚିତ ହୋଇଛି। ଭଏସ ଲ୍ୟାବ ପରୀକ୍ଷା ସମ୍ପୂର୍ଣ୍ଣ; କୌଣସି ପ୍ରକୃତ ମାଟେରିଆଲ ରିକ୍ୱେଷ୍ଟ ବଦଳି ନାହିଁ।",
        }.get(language)
        if fixed:
            return fixed
        return varied(
            call,
            "Confirmed. The Voice Lab test is complete; no real material request was changed.",
            "That is confirmed. This was only a Voice Lab test, so the real request data remains untouched.",
            "All set for the test. Nothing in the live material requests was changed.",
        )
    if call.get("isTest") and action == "END_DEFERRED":
        fixed = {
            "hi": "ठीक है। वॉइस लैब परीक्षण पूरा हुआ; कोई असली अनुरोध नहीं बदला।",
            "or": "ଠିକ ଅଛି। ଭଏସ ଲ୍ୟାବ ପରୀକ୍ଷା ସମ୍ପୂର୍ଣ୍ଣ; କୌଣସି ପ୍ରକୃତ ଅନୁରୋଧ ବଦଳି ନାହିଁ।",
        }.get(language)
        if fixed:
            return fixed
        return varied(
            call,
            "Okay. The Voice Lab test is complete; no real request was changed.",
            "Understood. I have ended the test without changing any real request.",
            "That completes the test. Your live request data was not touched.",
        )
    if language == "hi":
        if action == "ASK_CONFIRMATION":
            if result.get("intent") == "REJECT":
                return "तो रिक्वेस्ट रिजेक्ट कर दूँ?"
            return "तो सभी आइटम्स अप्रूव कर दूँ?"
        return {
            "ASK_REJECTION_REASON": "कृपया अनुरोध अस्वीकार करने का कारण बताइए।",
            "ASK_INTENT": "ठीक है। मंजूर, अस्वीकार, या बाद में कहें।",
            "RETRY": "मैं समझ नहीं पाई। मंजूर, अस्वीकार, या बाद में कहें।",
            "RETRY_CONFIRMATION": "कन्फर्म कर दूँ?",
            "REPEAT": f"यह {number} की मंजूरी का अनुरोध है। मंजूर, अस्वीकार, या बाद में कहें।",
            "OPEN_REQUEST": "हर वस्तु देखने के लिए रिक्वेस्ट्स ऐप खोलें। मैंने अनुरोध नहीं बदला है।",
            "COMMIT": "पुष्टि हो गई। आपका निर्णय रिक्वेस्ट्स में सेव हो रहा है।",
            "END_DEFERRED": "ठीक है। अनुरोध बाद में निर्णय के लिए लंबित रहेगा।",
        }.get(action, "मैं समझ नहीं पाई। कृपया फिर से कहें।")
    if language == "or":
        if action == "ASK_CONFIRMATION":
            if result.get("intent") == "REJECT":
                return "ତାହେଲେ ରିକ୍ୱେଷ୍ଟଟା ରିଜେକ୍ଟ କରିଦେବି?"
            return "ତାହେଲେ ସବୁ ଆଇଟମ୍ ଆପ୍ରୁଭ୍ କରିଦେବି?"
        return {
            "ASK_REJECTION_REASON": "ଅନୁରୋଧ ପ୍ରତ୍ୟାଖ୍ୟାନ କରିବାର କାରଣ କହନ୍ତୁ।",
            "ASK_INTENT": "ଠିକ ଅଛି। ଅନୁମୋଦନ, ପ୍ରତ୍ୟାଖ୍ୟାନ, କିମ୍ବା ପରେ କହନ୍ତୁ।",
            "RETRY": "ମୁଁ ବୁଝି ପାରିଲି ନାହିଁ। ଅନୁମୋଦନ, ପ୍ରତ୍ୟାଖ୍ୟାନ, କିମ୍ବା ପରେ କହନ୍ତୁ।",
            "RETRY_CONFIRMATION": "କନ୍ଫର୍ମ କରିଦେବି?",
            "REPEAT": f"ଏହା {number} ର ଅନୁମୋଦନ ଅନୁରୋଧ। ଅନୁମୋଦନ, ପ୍ରତ୍ୟାଖ୍ୟାନ, କିମ୍ବା ପରେ କହନ୍ତୁ।",
            "OPEN_REQUEST": "ପ୍ରତ୍ୟେକ ବସ୍ତୁ ଦେଖିବାକୁ ରିକ୍ୱେଷ୍ଟସ ଆପ ଖୋଲନ୍ତୁ। ମୁଁ ଅନୁରୋଧ ବଦଳାଇ ନାହିଁ।",
            "COMMIT": "ନିଶ୍ଚିତ ହୋଇଛି। ଆପଣଙ୍କ ନିଷ୍ପତ୍ତି ରିକ୍ୱେଷ୍ଟସରେ ସେଭ ହେଉଛି।",
            "END_DEFERRED": "ଠିକ ଅଛି। ଅନୁରୋଧଟି ପରେ ନିଷ୍ପତ୍ତି ପାଇଁ ବାକି ରହିବ।",
        }.get(action, "ମୁଁ ବୁଝି ପାରିଲି ନାହିଁ। ପୁଣି କହନ୍ତୁ।")
    if action == "ASK_CONFIRMATION":
        if result.get("intent") == "REJECT":
            return varied(
                call,
                "Reject this request?",
                "Should I reject it?",
                "Go ahead and reject this request?",
            )
        return varied(
            call,
            "Approve all pending items?",
            "Should I approve everything pending?",
            "Go ahead and approve all items?",
        )
    options = {
        "ASK_REJECTION_REASON": (
            "What is the reason you want to reject it?",
            "Please tell me why this request should be rejected.",
            "Understood. What rejection reason should I record?",
        ),
        "ASK_INTENT": (
            "Okay. What would you like to do with the request?",
            "No problem. Should it be approved, rejected, or left for later?",
            "All right—tell me how you would like to handle it.",
        ),
        "RETRY": (
            "I am not certain I understood. Could you say what you want to do another way?",
            "I may have missed your meaning. Should it proceed, be rejected, or wait?",
            "Could you rephrase your decision for me?",
        ),
        "RETRY_CONFIRMATION": (
            "Should I confirm it?",
            "Is that a yes?",
            "Confirm that decision?",
        ),
        "REPEAT": (
            f"This call is about approval request {number}. How would you like to handle it?",
            f"We are reviewing {number}. Would you approve it, reject it, or decide later?",
            f"The request awaiting your decision is {number}. Tell me what you would like to do.",
        ),
        "OPEN_REQUEST": (
            "Open the Requests app to review individual items. I have not changed this request.",
            "You can inspect every line in Requests; nothing has been changed from this call.",
            "The full item list is available in the Requests app. I have left the request untouched.",
        ),
        "COMMIT": (
            "Confirmed. I am saving your decision in Requests now.",
            "Your confirmation is complete, and the decision is being saved in Requests.",
            "All set. I am recording that decision in Requests now.",
        ),
        "END_DEFERRED": (
            "Okay. I have left the request pending for you to decide later.",
            "Understood. The request will stay pending until you are ready.",
            "No problem. Nothing was decided, and the request remains open in Requests.",
        ),
    }.get(action)
    if options:
        return varied(call, *options)
    return varied(
        call,
        "I did not understand. Please try again.",
        "I missed that. Could you say it another way?",
        "Sorry, I did not quite follow. Please repeat that for me.",
    )


def fast_reply_candidates(call: dict) -> list[str]:
    """High-probability replies rendered before the approver needs them.

    These exact phrases deliberately contain no request identifier, requester,
    reason or item text. Their WAVs can therefore be reused across calls and
    returned from the speech gateway cache without a model round trip.
    """
    language = call.get("language") or "en"
    if language in {"hi", "or"}:
        candidates = [
            phrase("ASK_CONFIRMATION", {"intent": "APPROVE"}, call),
            phrase("ASK_REJECTION_REASON", {}, call),
            phrase("ASK_CONFIRMATION", {"intent": "REJECT"}, call),
            phrase("END_DEFERRED", {}, call),
            phrase("COMMIT", {}, call),
        ]
        for act in (
            "CONFIRM_APPROVE",
            "CONFIRM_REJECT",
            "CONFIRM_DEFER",
            "ACKNOWLEDGE",
            "REFOCUS",
            "OPEN_REQUEST",
        ):
            candidates.extend(dialogue_act_options(call, act))
        candidates.extend((
            resume_prompt(call, "INTENT"),
            resume_prompt(call, "CONFIRMATION"),
        ))
        return list(dict.fromkeys(candidates))
    # Kokoro is already real-time on this pod; avoid spending startup work on
    # English variants that it can synthesize immediately when selected.
    return []


class ApprovalAgent(Agent):
    def __init__(self, session_id: str, call: dict):
        super().__init__(instructions="A deterministic GRAV voice workflow. Never invent facts, authority or a decision.")
        self.session_id = session_id
        self.call = call
        self.phase = "GREETING"
        self.silence_attempts = 0
        self.silence_task: asyncio.Task | None = None
        self.current_speech = None
        self.clarification_intent: str | None = None
        self.clarification_confidence = 0.0
        self.prepared_introduction = introduction_parts(call)
        self.call["_introParts"] = self.prepared_introduction
        self.introduction_prewarm: asyncio.Task | None = None
        self.fast_reply_prewarm: asyncio.Task | None = None
        self.introduction_ready = [asyncio.Event() for _part in self.prepared_introduction]

    def user_started_speaking(self) -> None:
        if self.silence_task and not self.silence_task.done():
            self.silence_task.cancel()

    def arm_silence(self, seconds: float = 7.0) -> None:
        current = asyncio.current_task()
        if self.silence_task and self.silence_task is not current and not self.silence_task.done():
            self.silence_task.cancel()
        phase = self.phase
        self.silence_task = asyncio.create_task(self._silence_watch(phase, seconds))

    async def _silence_watch(self, phase: str, seconds: float) -> None:
        try:
            await asyncio.sleep(seconds)
            if self.phase != phase:
                return
            self.silence_attempts += 1
            if self.silence_attempts == 1:
                await self.speak(greeting(self.call, again=True), arm_after=True)
                return
            await backend("POST", f"/worker/{self.session_id}/no-answer", {})
            language = self.call.get("language") or "en"
            closing = (
                "No problem. I will leave your morning brief for today in GRAV Home." if self.call.get("workflowKey") == "morning_brief" else
                "कोई बात नहीं। वॉइस लैब परीक्षण समाप्त हो गया।" if self.call.get("isTest") and language == "hi" else
                "କିଛି ଅସୁବିଧା ନାହିଁ। ଭଏସ ଲ୍ୟାବ ପରୀକ୍ଷା ଶେଷ ହେଲା।" if self.call.get("isTest") and language == "or" else
                "No problem. The Voice Lab test has ended." if self.call.get("isTest") else
                "कोई बात नहीं। अनुरोध रिक्वेस्ट्स में लंबित रहेगा।" if language == "hi" else
                "କିଛି ଅସୁବିଧା ନାହିଁ। ଅନୁରୋଧଟି ରିକ୍ୱେଷ୍ଟସରେ ବାକି ରହିବ।" if language == "or" else
                "No problem. I will leave the request pending in Requests."
            )
            await self.speak(closing, arm_after=False, interruptible=False)
            self.session.shutdown(drain=True)
        except asyncio.CancelledError:
            return

    async def speak(self, text: str, *, arm_after: bool, interruptible: bool = True) -> None:
        text = await prepared_speech_text(text, self.call.get("language") or "en")
        self.call["_lastAgentText"] = text
        if self.call.get("isTest"):
            try:
                await backend("POST", f"/worker/{self.session_id}/speech", {"text": text})
            except Exception:
                # Diagnostics must never delay or prevent the actual call.
                pass
        try:
            self.current_speech = self.session.say(text, allow_interruptions=interruptible)
            await self.current_speech.wait_for_playout()
        except Exception as error:
            if isinstance(error, RuntimeError) and "closing" in str(error).lower():
                return
            language = self.call.get("language") or "en"
            recovery = (
                "माफ़ कीजिए, आवाज़ तैयार नहीं हुई। कृपया फिर से कहें।" if language == "hi" else
                "କ୍ଷମା କରିବେ, ଭଏସ୍ ପ୍ରସ୍ତୁତ ହେଲା ନାହିଁ। ଦୟାକରି ପୁଣି କହନ୍ତୁ।" if language == "or" else
                "Sorry, the voice response did not load. Please say that again."
            )
            self.call["_lastAgentText"] = recovery
            if self.call.get("isTest"):
                try:
                    await backend("POST", f"/worker/{self.session_id}/speech", {"text": recovery})
                except Exception:
                    pass
            self.current_speech = self.session.say(recovery, allow_interruptions=True)
            await self.current_speech.wait_for_playout()
        if arm_after and not self.current_speech.interrupted:
            self.arm_silence()

    async def speak_introduction(self) -> None:
        """Pipeline short TTS chunks so the caller hears a prompt immediately."""
        parts = self.prepared_introduction
        for index, part in enumerate(parts):
            await self.introduction_ready[index].wait()
            await self.speak(part, arm_after=index == len(parts) - 1)

    async def prewarm_introduction(self) -> None:
        """Prepare chunks concurrently during the greeting, without blocking STT.

        The Indic gateway owns a small bounded model pool. Submitting all
        chunks here lets the first two useful sentences render together while
        the pool itself provides the GPU concurrency limit.
        """
        language = self.call.get("language") or "en"

        async def prepare(index: int, part: str) -> None:
            try:
                await prewarm_speech(part, language)
            finally:
                # A failed prewarm still releases playout, whose authoritative
                # LiveKit TTS request can retry and use the audible fallback.
                self.introduction_ready[index].set()

        await asyncio.gather(*(
            prepare(index, part)
            for index, part in enumerate(self.prepared_introduction)
        ))
        # English introductions enter the bounded cache queue first. Indic
        # Parler streams on demand, so its prewarm helpers return immediately.
        # Use the remaining introduction/listening time for likely replies.
        self.fast_reply_prewarm = asyncio.create_task(
            self.prewarm_fast_replies(language)
        )

    async def prewarm_fast_replies(self, language: str) -> None:
        await asyncio.gather(*(
            prewarm_speech(reply, language)
            for reply in fast_reply_candidates(self.call)
        ))

    async def on_enter(self) -> None:
        greeting_text = await prepared_speech_text(
            greeting(self.call),
            self.call.get("language") or "en",
        )
        self.call["_lastAgentText"] = greeting_text
        if self.call.get("isTest"):
            try:
                await backend("POST", f"/worker/{self.session_id}/speech", {"text": greeting_text})
            except Exception:
                pass
        self.current_speech = self.session.say(greeting_text, allow_interruptions=True)
        # Let LiveKit submit the greeting first, then synthesize the introduction
        # during greeting playout and the caller's response.
        await asyncio.sleep(0.15)
        self.introduction_prewarm = asyncio.create_task(
            self.prewarm_introduction()
        )
        await self.current_speech.wait_for_playout()
        if not self.current_speech.interrupted:
            self.arm_silence()

    async def on_user_turn_completed(self, turn_ctx: ChatContext, new_message: ChatMessage) -> None:
        del turn_ctx
        text = (new_message.text_content or "").strip()
        if not text:
            raise StopResponse()
        self.user_started_speaking()
        interrupted = bool(self.current_speech and self.current_speech.interrupted)
        self.silence_attempts = 0

        if self.phase == "GREETING":
            # The call objective is already known. Never ask Qwen to interpret
            # a noisy first utterance or let it ask what the call is about.
            # Any non-empty response establishes presence unless the caller
            # explicitly says they cannot hear us.
            if is_negative_hearing_response(text):
                await self.speak(greeting(self.call, again=True), arm_after=True)
                raise StopResponse()
            self.phase = "INTENT"
            await self.speak_introduction()
            raise StopResponse()

        if self.clarification_intent:
            clarification = clarification_answer(text)
            if clarification == "NO":
                self.clarification_intent = None
                self.clarification_confidence = 0.0
                await self.speak(phrase("ASK_INTENT", {}, self.call), arm_after=True)
                raise StopResponse()
            if clarification == "UNKNOWN":
                await self.speak(clarification_retry(self.call, self.clarification_intent), arm_after=True)
                raise StopResponse()
            candidate = self.clarification_intent
            candidate_confidence = self.clarification_confidence
            self.clarification_intent = None
            self.clarification_confidence = 0.0
            result = await backend("POST", f"/worker/{self.session_id}/turn", {
                "text": text,
                "phase": "SEMANTIC_CONFIRMATION",
                "semanticIntent": candidate,
                "confidence": candidate_confidence,
            })
        else:
            result = await backend("POST", f"/worker/{self.session_id}/turn", {
                "text": text,
                "phase": self.phase,
            })
        action = result.get("action", "RETRY")
        if action == "ASK_REJECTION_REASON":
            self.phase = "REJECTION_REASON"
        elif action in {"ASK_CONFIRMATION", "RETRY_CONFIRMATION"}:
            self.phase = "CONFIRMATION"
        elif action == "ASK_INTENT":
            self.phase = "INTENT"
        answer_parts: list[str]
        if self.call.get("workflowKey") == "morning_brief":
            answer_parts = [phrase(action, result, self.call)]
        elif action == "RETRY_CONFIRMATION":
            # Confirmation is a closed yes/no state. Sending an unclear answer
            # through Qwen adds latency and can produce a second, redundant
            # question. Keep the state deterministic and replay one short,
            # cached confirmation prompt instead.
            answer_parts = [phrase("RETRY_CONFIRMATION", result, self.call)]
        elif action == "RETRY":
            conversational = await conversational_reply(
                text,
                self.phase,
                self.call,
                session_id=self.session_id,
                intent=str(result.get("intent") or ""),
                interrupted=interrupted,
            )
            if conversational["candidate"] != "UNKNOWN":
                self.clarification_intent = conversational["candidate"]
                self.clarification_confidence = conversational["confidence"]
                answer_parts = [conversational["reply"]]
            else:
                # Speak cached chunks independently. Concatenating them creates
                # a new TTS cache key and reintroduces a multi-second render.
                answer_parts = [
                    conversational["reply"],
                    resume_prompt(self.call, self.phase, str(result.get("intent") or "")),
                ]
        else:
            answer_parts = [phrase(action, result, self.call)]
        # Retry replies come from the dialog gateway, which already receives the
        # interruption flag and writes its own warm acknowledgement. Prefix only
        # deterministic workflow replies so the caller never hears two awkward
        # acknowledgements in a row.
        if interrupted and action not in {"RETRY", "RETRY_CONFIRMATION"}:
            answer_parts.insert(0, interruption_bridge(self.call))
        terminal = action in {"COMMIT", "END_DEFERRED", "END_BRIEF"}
        for index, answer in enumerate(answer_parts):
            final_part = index == len(answer_parts) - 1
            await self.speak(
                answer,
                arm_after=final_part and not terminal,
                interruptible=not terminal,
            )
        if terminal:
            self.session.shutdown(drain=True)
        raise StopResponse()


# 8081 is already used by the existing GRAV Speech worker on the shared pod.
# Keep this worker's tiny health listener separate; it remains pod-local.
server = AgentServer(
    port=int(os.environ.get("MRF_VOICE_WORKER_HEALTH_PORT", "8091")),
    num_idle_processes=int(os.environ.get("MRF_VOICE_IDLE_PROCESSES", "1")),
)


@server.rtc_session(agent_name=AGENT_NAME)
async def approval_worker(ctx: agents.JobContext):
    metadata = json.loads(ctx.job.metadata or "{}")
    if metadata.get("kind") not in {"mrf_voice_approval", "grav_voice_workflow"} or not metadata.get("sessionId"):
        raise RuntimeError("Unsupported dispatch")
    session_id = str(metadata["sessionId"])
    context = await backend("GET", f"/worker/{session_id}/context")
    call = context["call"]
    language = call.get("language") or "en"
    tts_model = {"hi": "chatterbox-hi", "or": "parler-or"}.get(language, "kokoro")
    tts_voice = "hi_female" if language == "hi" else "af_heart"
    session = AgentSession(
        stt=openai.STT(
            model="whisper-1",
            api_key=GATEWAY_KEY,
            base_url=GATEWAY,
            language="multi",
        ),
        llm=None,
        tts=openai.TTS(
            model=tts_model,
            voice=tts_voice,
            api_key=GATEWAY_KEY,
            base_url=GATEWAY,
            response_format="wav",
        ),
        # The default 50 ms / 0.5 gate treats keyboard taps, fans and distant
        # conversation as turns. Require a sustained, voice-like foreground
        # signal while retaining enough prefix audio for word recognition.
        vad=silero.VAD.load(
            min_speech_duration=float(os.environ.get("MRF_VOICE_VAD_MIN_SPEECH", "0.25")),
            min_silence_duration=float(os.environ.get("MRF_VOICE_VAD_MIN_SILENCE", "0.45")),
            prefix_padding_duration=float(os.environ.get("MRF_VOICE_VAD_PREFIX_PADDING", "0.30")),
            activation_threshold=float(os.environ.get("MRF_VOICE_VAD_ACTIVATION", "0.65")),
            deactivation_threshold=float(os.environ.get("MRF_VOICE_VAD_DEACTIVATION", "0.45")),
        ),
    )
    agent = ApprovalAgent(session_id, call)

    @session.on("user_state_changed")
    def on_user_state_changed(event):
        if event.new_state == "speaking":
            agent.user_started_speaking()

    await session.start(room=ctx.room, agent=agent)


if __name__ == "__main__":
    agents.cli.run_app(server)
