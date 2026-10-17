"""Pod-private bounded Qwen dialogue service for MRF approval calls."""

from __future__ import annotations

import json
import hashlib
import os
import re
import threading
from difflib import SequenceMatcher

import torch
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from dialog_routes import route_for_output
from speech_text import feminine_hindi_agent_voice


KEY = os.environ.get("GRAV_DIALOG_GATEWAY_KEY", "local-only")
MODEL_ID = os.environ.get("MRF_DIALOG_MODEL", "Qwen/Qwen3-4B-Instruct-2507")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
app = FastAPI(title="GRAV MRF Dialogue Gateway", docs_url=None, redoc_url=None)
lock = threading.Lock()
tokenizer = None
model = None


def authenticate(authorization: str = Header(default="")) -> None:
    if authorization != f"Bearer {KEY}":
        raise HTTPException(status_code=401, detail="Unauthenticated")


def load_model():
    global tokenizer, model
    if model is not None:
        return tokenizer, model
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    options = {"device_map": "auto", "dtype": torch.bfloat16}
    if DEVICE == "cuda" and os.environ.get("MRF_DIALOG_4BIT", "true").lower() in {"1", "true", "yes", "on"}:
        options["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
        )
    model = AutoModelForCausalLM.from_pretrained(MODEL_ID, **options)
    model.eval()
    return tokenizer, model


def warm_model() -> None:
    with lock:
        load_model()


@app.on_event("startup")
def preload() -> None:
    if os.environ.get("MRF_DIALOG_PRELOAD", "true").lower() in {"1", "true", "yes", "on"}:
        threading.Thread(target=warm_model, name="mrf-dialog-warmup", daemon=True).start()


class DialogueRequest(BaseModel):
    callerText: str = Field(max_length=2000)
    phase: str = Field(max_length=40)
    language: str = Field(default="en", max_length=4)
    mrfNumber: str = Field(default="", max_length=80)
    requestedForName: str = Field(default="", max_length=160)
    requestedForDept: str = Field(default="", max_length=160)
    itemSummary: str = Field(default="", max_length=500)
    pendingIntent: str = Field(default="", max_length=20)
    interrupted: bool = False
    previousAgentText: str = Field(default="", max_length=420)
    labInstruction: str = Field(default="", max_length=1200)


class LocalizationRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    language: str = Field(pattern="^(hi|or)$")


class TranscriptReviewRequest(BaseModel):
    utterances: list[dict] = Field(min_length=1, max_length=24)


class TranscriptUnderstandingRequest(BaseModel):
    """Read-only diagnostic request used to verify meeting-level context."""

    utterances: list[dict] = Field(min_length=1, max_length=32)


class TranscriptMeetingModelRequest(BaseModel):
    """Noisy transcript used to infer its own meeting-specific context."""

    utterances: list[dict] = Field(min_length=1, max_length=32)


class TranscriptContextEditRequest(BaseModel):
    """One bounded ASR window plus inferred meeting context for editing."""

    meetingModel: dict
    utterances: list[dict] = Field(min_length=1, max_length=4)


class TranscriptEditVerificationRequest(BaseModel):
    """Independent check of proposed, context-aware transcript edits."""

    meetingModel: dict
    proposals: list[dict] = Field(min_length=1, max_length=4)


class TranscriptTermNormalizationRequest(BaseModel):
    """Closed-catalog proposals only; the caller performs final validation."""
    packets: list[dict] = Field(min_length=1, max_length=24)


def extract_result(raw: str) -> dict:
    text = raw.strip()
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        try:
            parsed = json.loads(text[start:end + 1])
            reply = str(parsed.get("reply") or "").strip()[:420]
            unsafe = re.search(
                r"\b(phase|proposed decision|internal dialogue|json|prompt|model|call back)\b|"
                r"\b(has been|is now)\s+(approved|rejected|confirmed)\b|\bI\s+(approved|rejected|confirmed)\b",
                reply,
                re.I,
            )
            candidate = str(parsed.get("candidateIntent") or "UNKNOWN").strip().upper()
            if candidate not in {"APPROVE", "REJECT", "DEFER", "UNKNOWN"}:
                candidate = "UNKNOWN"
            try:
                confidence = max(0.0, min(1.0, float(parsed.get("confidence") or 0)))
            except (TypeError, ValueError):
                confidence = 0.0
            if unsafe:
                return {}
            return {"reply": reply, "candidateIntent": candidate, "confidence": confidence}
        except json.JSONDecodeError:
            pass
    return {}


def too_similar(reply: str, previous: str) -> bool:
    """Reject model wording that sounds like the same recording again."""
    normalize = lambda value: re.sub(r"[^\w\s]", " ", value.lower()).split()
    current = normalize(reply)
    earlier = normalize(previous)
    if not current or not earlier:
        return False
    current_text = " ".join(current)
    earlier_text = " ".join(earlier)
    same_opening = len(current) >= 4 and len(earlier) >= 4 and current[:4] == earlier[:4]
    return same_opening or SequenceMatcher(None, current_text, earlier_text).ratio() >= 0.78


def safe_clarification(candidate: str, caller_text: str, previous: str, rejected: list[str]) -> str:
    """Bounded last resort when the small model will not produce a safe question."""
    choices = {
        "APPROVE": (
            "Should I take that as your choice to approve the request?",
            "Am I right that you want this request to go ahead?",
            "Just checking—are you choosing to approve it?",
            "Would you like me to treat that as an approval?",
        ),
        "REJECT": (
            "Do you mean that you want this request rejected?",
            "Should I take that as your choice to decline the request?",
            "Am I right that you do not want this request to proceed?",
            "Just checking—are you choosing to reject it?",
        ),
        "DEFER": (
            "Do you mean that you would rather decide on this later?",
            "Should I leave the request pending for you to review later?",
            "Am I right that you do not want to decide this now?",
            "Just checking—would you like to come back to this request later?",
        ),
    }.get(candidate, ())
    usable = [
        choice for choice in choices
        if not too_similar(choice, previous) and all(not too_similar(choice, draft) for draft in rejected)
    ] or list(choices)
    if not usable:
        return "Could you confirm what you would like me to do?"
    digest = hashlib.sha256(f"{caller_text}|{previous}".encode()).digest()
    return usable[int.from_bytes(digest[:2], "big") % len(usable)]


@app.get("/health")
def health() -> dict:
    result = {
        "status": "ready" if model is not None else "warming",
        "model": MODEL_ID,
        "device": DEVICE,
        "loaded4bit": bool(getattr(model, "is_loaded_in_4bit", False)),
    }
    if DEVICE == "cuda":
        result["gpuAllocatedMiB"] = round(torch.cuda.memory_allocated() / 1024 / 1024)
        result["gpuReservedMiB"] = round(torch.cuda.memory_reserved() / 1024 / 1024)
    return result


@app.post("/v1/dialog", dependencies=[Depends(authenticate)])
def dialog(body: DialogueRequest) -> dict:
    # The model is a semantic router, never a prose generator. Producing one
    # bounded code removes translation, long decoding, retry and uncached TTS
    # from the live response path. The deterministic controller owns wording,
    # confirmation and every business mutation.
    system = """Classify one utterance from a material-request approval call.
It may be English, Romanized Hindi, Romanized Odia, Devanagari Hindi or Odia script.
Return exactly one code and nothing else:
A = wants to approve or proceed
R = wants to reject, decline, pass, stop or not proceed
D = explicitly wants to decide or review later
W = asks who raised/sent the request
I = asks what items/details are in the request
O = asks to open/show the request
P = asks to repeat
H = greeting, audibility or brief acknowledgement
X = unrelated, unclear, or any other question
"Pass for now", "not comfortable clearing it" and "should not go through" are R.
"Need time", "come back later" and "review later" are D.
Classify meaning only. Never answer the caller."""
    prompt = f"Language={body.language}; phase={body.phase}; utterance={body.callerText}"
    with lock:
        tok, llm = load_model()
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ]
        rendered = tok.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        inputs = tok(rendered, return_tensors="pt").to(llm.device)
        with torch.inference_mode():
            output = llm.generate(
                **inputs,
                max_new_tokens=3,
                do_sample=False,
                pad_token_id=tok.eos_token_id,
            )
        generated = output[0][inputs.input_ids.shape[1]:]
        raw = tok.decode(generated, skip_special_tokens=True).strip().upper()
    candidate, act, confidence = route_for_output(raw)
    return {
        "reply": "",
        "replyAct": act,
        "candidateIntent": candidate,
        "confidence": confidence,
        "model": MODEL_ID,
    }


@app.post("/v1/transcript-review", dependencies=[Depends(authenticate)])
def transcript_review(body: TranscriptReviewRequest) -> dict:
    """Classify transcript evidence; never let Qwen author corrected wording."""
    system = """You are a transcript evidence verifier, never a transcript editor.
For each utterance use neighbouring transcript evidence and candidate ASR decodes.
An utterance may include `meetingContext`, a temporary transcript-derived view
of the meeting. Use it only to choose between exact same-audio candidates. It
is a hypothesis, never a glossary, and never permits invented replacement text.
Return one JSON review per supplied id. A business phrase that makes no sense,
or an entity conflicting with neighbouring ASR evidence, must set recoveryRequired
true and list its issue. Domain terms are hints only and must never become text.
You may select only an exact candidateTranscript id from that same utterance.
Never translate, combine, complete or invent words.
Some candidates are full independent ASR decodes; others are local audio-lattice
candidates. A local lattice candidate preserves the raw utterance except for one
small aligned token span copied exactly from an independent same-audio decode.
When local alternatives differ, compare that small phrase against the bounded
surrounding meaning. Prefer the candidate whose local phrase is semantically
coherent with the discussion. Do not prefer a less meaningful phrase merely
because another full-language decode is cleaner elsewhere in the utterance.
The raw ASR candidate is the baseline. Keep it whenever it already forms an
ordinary, coherent phrase. Select an alternate only when it resolves one
specific incoherent raw phrase and the alternate is materially clearer in the
same meeting context. Never choose an alternate merely because it is shorter,
spelled differently, or acoustically similar.
Focus first on the smallest differing content-word span. If one ASR-backed
alternative forms a recognized, ordinary word or phrase in the given context
and another leaves an unrecognised or nonsensical token, select the recognised
alternative. This rule is language-neutral and applies equally to mixed-script
and code-switched speech; it is not permission to invent a word.
crossTranscriptEvidence may identify compact literal phrase variants from
separate timestamps. It is a signal to compare candidates more carefully: when
an exact same-audio candidate agrees with a clearer repeated variant, prefer
that candidate over an unsupported spelling variant. Evidence never authorises
you to write a replacement that is absent from candidateTranscript.
Return only {\"reviews\":[{\"id\":\"...\",\"state\":\"coherent|uncertain|gibberish\",\"selectedCandidateId\":null,\"semanticIssues\":[\"business_phrase_incoherent|cross_span_entity_conflict|numeric_ambiguity\"],\"recoveryRequired\":true,\"reason\":\"short evidence reason\"}]}."""
    with lock:
        tok, llm = load_model()
        rendered = tok.apply_chat_template(
            [{"role": "system", "content": system},
             {"role": "user", "content": json.dumps({"utterances": body.utterances}, ensure_ascii=False)}],
            tokenize=False, add_generation_prompt=True, enable_thinking=False,
        )
        inputs = tok(rendered, return_tensors="pt").to(llm.device)
        with torch.inference_mode():
            output = llm.generate(
                **inputs, max_new_tokens=900, do_sample=False, pad_token_id=tok.eos_token_id,
            )
        raw = tok.decode(output[0][inputs.input_ids.shape[1]:], skip_special_tokens=True).strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise HTTPException(status_code=502, detail="Transcript semantic response was not JSON")
    try:
        parsed = json.loads(raw[start:end + 1])
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=502, detail="Transcript semantic response was invalid") from error
    allowed_ids = {str(item.get("id")) for item in body.utterances}
    allowed_issues = {"business_phrase_incoherent", "cross_span_entity_conflict", "numeric_ambiguity"}
    reviews = []
    for review in parsed.get("reviews", []):
        if review.get("id") not in allowed_ids or review.get("state") not in {"coherent", "uncertain", "gibberish"}:
            continue
        reviews.append({
            "id": review["id"], "state": review["state"],
            "selectedCandidateId": review.get("selectedCandidateId"),
            "semanticIssues": [item for item in review.get("semanticIssues", []) if item in allowed_issues],
            "recoveryRequired": bool(review.get("recoveryRequired", False)),
            "reason": str(review.get("reason") or "")[:240],
        })
    return {"reviews": reviews, "model": MODEL_ID, "authority": "evidence classification only"}


@app.post("/v1/transcript-understanding", dependencies=[Depends(authenticate)])
def transcript_understanding(body: TranscriptUnderstandingRequest) -> dict:
    """Describe meeting context without changing transcript wording."""
    system = """You are analysing a noisy multilingual meeting transcript.
State the meeting topic from evidence only. Do not correct, rewrite, or guess
missing transcript words. Return only valid compact JSON with exactly these
keys: {"topic":"...","evidence":["literal short quotation"],"confidence":"high|medium|low"}.
The evidence list must quote supplied transcript wording exactly. If the topic
is unsupported, say that and use low confidence."""
    with lock:
        tok, llm = load_model()
        rendered = tok.apply_chat_template(
            [{"role": "system", "content": system},
             {"role": "user", "content": json.dumps({"utterances": body.utterances}, ensure_ascii=False)}],
            tokenize=False, add_generation_prompt=True, enable_thinking=False,
        )
        inputs = tok(rendered, return_tensors="pt").to(llm.device)
        with torch.inference_mode():
            output = llm.generate(**inputs, max_new_tokens=260, do_sample=False,
                                  pad_token_id=tok.eos_token_id)
        raw = tok.decode(output[0][inputs.input_ids.shape[1]:], skip_special_tokens=True).strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        return {"understanding": {"diagnosticRaw": raw[:1600]}, "model": MODEL_ID,
                "authority": "diagnostic only; cannot modify transcript evidence"}
    try:
        understanding = json.loads(raw[start:end + 1])
    except json.JSONDecodeError:
        return {"understanding": {"diagnosticRaw": raw[:1600]}, "model": MODEL_ID,
                "authority": "diagnostic only; cannot modify transcript evidence"}
    return {"understanding": understanding, "model": MODEL_ID,
            "authority": "diagnostic only; cannot modify transcript evidence"}


def _qwen_json(*, system: str, payload: dict, maximum_tokens: int) -> dict:
    """Run a bounded JSON-only private Qwen request under the model lock."""
    with lock:
        tok, llm = load_model()
        rendered = tok.apply_chat_template(
            [{"role": "system", "content": system},
             {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
            tokenize=False, add_generation_prompt=True, enable_thinking=False,
        )
        inputs = tok(rendered, return_tensors="pt").to(llm.device)
        with torch.inference_mode():
            output = llm.generate(**inputs, max_new_tokens=maximum_tokens,
                                  do_sample=False, pad_token_id=tok.eos_token_id)
        raw = tok.decode(output[0][inputs.input_ids.shape[1]:], skip_special_tokens=True).strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise HTTPException(status_code=502, detail="Transcript context model did not return JSON")
    try:
        return json.loads(raw[start:end + 1])
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=502, detail="Transcript context model returned invalid JSON") from error


@app.post("/v1/transcript-meeting-model", dependencies=[Depends(authenticate)])
def transcript_meeting_model(body: TranscriptMeetingModelRequest) -> dict:
    """Infer a temporary, meeting-specific context model from raw transcript."""
    system = """You build a context model for one noisy multilingual meeting.
Infer the topic, purpose, domain signals and likely working vocabulary only from
the supplied transcript. The meeting may be from any industry; do not assume a
domain from a pre-existing glossary. Do not correct transcript wording or
invent facts. Return JSON only:
{"topic":"...","purpose":"...","domainSignals":["..."],"workingVocabulary":["..."],"summary":"...","confidence":0.0}.
Vocabulary may contain concepts strongly supported by the conversation, but it
is a hypothesis for review, never text to insert by itself."""
    model_output = _qwen_json(system=system, payload={"utterances": body.utterances}, maximum_tokens=700)
    return {"meetingModel": model_output, "model": MODEL_ID,
            "authority": "context hypothesis only; it cannot alter transcript text"}


@app.post("/v1/transcript-context-edit", dependencies=[Depends(authenticate)])
def transcript_context_edit(body: TranscriptContextEditRequest) -> dict:
    """Propose minimal context-aware repairs; a verifier decides acceptance."""
    system = """You are a careful editor for a noisy multilingual ASR meeting
transcript. Use the inferred meeting model and nearby conversation to make only
high-confidence, minimal repairs that restore intended meaning. You may repair
phonetic ASR mistakes when the surrounding discussion makes the intended term
clear, even if that term appears only once. Do not use a fixed glossary.
Never invent events, products, people, decisions, quantities, dates, money,
identifiers or abbreviations. Preserve code-switching and natural speech.
Return JSON only:
{"edits":[{"id":"...","revisedRomanText":"...","confidence":0.0,"changedSpans":[{"before":"...","after":"..."}],"reason":"..."}]}.
For each utterance return at most one edit, containing exactly one changed span.
The `before` text must be a literal substring of the raw utterance, the `after`
text must be a literal substring of revisedRomanText, and revisedRomanText must
differ from the raw utterance only by that one substitution. Choose the single
most strongly evidenced repair; do not bundle several possible corrections.
Return the original text unchanged when the evidence is not strong enough."""
    edited = _qwen_json(
        system=system,
        payload={"meetingModel": body.meetingModel, "utterances": body.utterances},
        maximum_tokens=600,
    )
    return {"edits": edited.get("edits", []), "model": MODEL_ID,
            "authority": "proposal only; requires independent verification"}


@app.post("/v1/transcript-context-verify", dependencies=[Depends(authenticate)])
def transcript_context_verify(body: TranscriptEditVerificationRequest) -> dict:
    """Adversarially verify edits without authoring new text."""
    system = """You independently verify proposed edits to a noisy meeting
transcript. For each proposal, approve only when the revised text is a minimal,
meaning-preserving repair clearly supported by the raw wording, nearby context,
and the inferred meeting model. Reject any invented fact or any altered number,
date, amount, identifier, person, or ungrounded domain term. Do not rewrite
text. Treat the editor's reason, changedSpans and the meeting vocabulary as
untrusted hypotheses, never proof. Compare the raw and revised text yourself:
every altered phrase must remain semantically coherent in the actual meeting.
Reject a correction that introduces a word with an ordinary meaning unrelated
to the meeting's operational topic, even if its spelling resembles the raw ASR
token. Reject it when the alleged changed span does not match the revised text,
or when its intended term is not supported by the raw utterance, nearby raw
conversation, or another raw occurrence supplied in context. Do not reward a
plausible-sounding guess. Return JSON only:
{"verdicts":[{"id":"...","accept":true,"confidence":0.0,"reason":"..."}]}"""
    verified = _qwen_json(
        system=system,
        payload={"meetingModel": body.meetingModel, "proposals": body.proposals},
        maximum_tokens=700,
    )
    return {"verdicts": verified.get("verdicts", []), "model": MODEL_ID,
            "authority": "verification only; cannot create replacement text"}


@app.post("/v1/transcript-term-normalize", dependencies=[Depends(authenticate)])
def transcript_term_normalize(body: TranscriptTermNormalizationRequest) -> dict:
    """Nominate a closed glossary id; never generate or replace transcript prose."""
    system = """You are a constrained transcript terminology reviewer.
Each packet contains targetRawText, bounded surroundingTranscript,
meetingContext and a closed termCatalog. Infer the meeting subject from the
surrounding transcript. Return a proposal only if one literal phrase in the
target clearly appears to be a phonetic ASR rendering of one catalog term and
the surrounding meeting context supports it. This is for names of products,
materials and internal business terminology, never numbers, quantities, dates,
amounts, identifiers or people. You may select only id values present in the
packet termCatalog. Never create a term, never change a whole sentence, never
translate or paraphrase it.
Return only JSON: {\"proposals\":[{\"id\":\"packet id\",\"rawPhrase\":\"literal target substring\",\"canonicalTermId\":\"closed catalog id\",\"confidence\":0.0,\"reason\":\"short contextual reason\"}]}."""
    with lock:
        tok, llm = load_model()
        rendered = tok.apply_chat_template(
            [{"role": "system", "content": system},
             {"role": "user", "content": json.dumps({"packets": body.packets}, ensure_ascii=False)}],
            tokenize=False, add_generation_prompt=True, enable_thinking=False,
        )
        inputs = tok(rendered, return_tensors="pt").to(llm.device)
        with torch.inference_mode():
            output = llm.generate(
                **inputs, max_new_tokens=700, do_sample=False, pad_token_id=tok.eos_token_id,
            )
        raw = tok.decode(output[0][inputs.input_ids.shape[1]:], skip_special_tokens=True).strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise HTTPException(status_code=502, detail="Transcript term response was not JSON")
    try:
        parsed = json.loads(raw[start:end + 1])
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=502, detail="Transcript term response was invalid") from error
    catalog_by_packet = {
        str(packet.get("id")): {str(term.get("id")) for term in packet.get("termCatalog", []) if term.get("id")}
        for packet in body.packets
    }
    proposals = []
    for proposal in parsed.get("proposals", []):
        packet_id = str(proposal.get("id") or "")
        raw_phrase = str(proposal.get("rawPhrase") or "").strip()
        term_id = str(proposal.get("canonicalTermId") or "")
        if packet_id not in catalog_by_packet or term_id not in catalog_by_packet[packet_id] or not raw_phrase:
            continue
        try:
            confidence = max(0.0, min(1.0, float(proposal.get("confidence") or 0)))
        except (TypeError, ValueError):
            continue
        proposals.append({
            "id": packet_id, "rawPhrase": raw_phrase, "canonicalTermId": term_id,
            "confidence": confidence, "reason": str(proposal.get("reason") or "")[:240],
        })
    return {"proposals": proposals, "model": MODEL_ID,
            "authority": "closed glossary id nomination only; caller validates literal span"}


@app.post("/v1/localize", dependencies=[Depends(authenticate)])
def localize(body: LocalizationRequest) -> dict:
    """Render CMS copy as natural native-script speech without changing facts."""
    language = (
        "everyday spoken Hindi/Hinglish in Devanagari script"
        if body.language == "hi" else
        "everyday spoken Odia with familiar English business words written phonetically in Odia script"
    )
    example = (
        "Example: 'GRAV is calling about material request MRF-204 from Ramesh.' becomes "
        "'हेलो, ग्रैव से रमेश की मटेरियल रिक्वेस्ट एम आर एफ दो सौ चार के अप्रूवल के लिए कॉल है।' "
        "Example: 'You have two pending approvals and one meeting at 10 AM.' becomes "
        "'आपके दो अप्रूवल पेंडिंग हैं और सुबह दस बजे एक मीटिंग है।'"
        if body.language == "hi" else
        "Example: 'GRAV is calling about material request MRF-204 from Ramesh.' becomes "
        "'ହେଲୋ, ଗ୍ରାଭରୁ ରମେଶଙ୍କ ମ୍ୟାଟେରିଆଲ୍ ରିକ୍ୱେଷ୍ଟ ଏମ୍ ଆର୍ ଏଫ୍ ଦୁଇ ଶହ ଚାରିର ଆପ୍ରୁଭାଲ୍ ପାଇଁ କଲ୍ ଆସିଛି।' "
        "Example: 'You have two pending approvals and one meeting at 10 AM.' becomes "
        "'ଆପଣଙ୍କର ଦୁଇଟି ଆପ୍ରୁଭାଲ୍ ପେଣ୍ଡିଙ୍ଗ୍ ଅଛି ଆଉ ସକାଳ ଦଶଟାରେ ଗୋଟିଏ ମିଟିଂ ଅଛି।'"
    )
    gender_guidance = (
        "The call-assistant voice is female. All Hindi first-person grammar must be feminine (for example, कर रही हूँ, कर सकती हूँ, समझ गई), never masculine."
        if body.language == "hi" else ""
    )
    system = f"""Convert the supplied call-assistant sentence into natural spoken {language}.
Return only the converted sentence: no JSON, quotes, notes, romanization or alternatives.
Preserve every person, quantity, date and decision. Sound like a normal Indian colleague, not a formal newsreader or textbook. Keep familiar office words such as call, approval, approve, reject, confirm, pending, request, items, Voice Lab and Home when that is how people normally speak, but write their pronunciation in the target script. Transliterate names and the GRAV brand phonetically. Speak MRF letter by letter with a short pause between M, R and F. Speak request identifiers, other abbreviations, clock times and AM/PM naturally in the target language instead of copying Latin letters. Do not translate word by word; use a short, idiomatic business-call sentence. Do not add, remove, infer or answer anything.
{gender_guidance}
{example}"""
    text = ""
    source = body.text.strip()
    with lock:
        tok, llm = load_model()
        for attempt in range(3):
            retry_guidance = ""
            if attempt:
                residual = ", ".join(sorted(set(re.findall(r"[A-Za-z]+", text))))
                retry_guidance = (
                    "\nYour previous answer still contained Latin-script text"
                    f" ({residual or 'unknown tokens'}). Rewrite the entire sentence again. "
                    "Every word, name, abbreviation and identifier must use only the target script; "
                    "write familiar English office words phonetically in that script."
                )
            messages = [
                {"role": "system", "content": system + retry_guidance},
                {"role": "user", "content": source},
            ]
            rendered = tok.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
            inputs = tok(rendered, return_tensors="pt").to(llm.device)
            with torch.inference_mode():
                output = llm.generate(
                    **inputs,
                    max_new_tokens=320,
                    do_sample=False,
                )
            generated = output[0][inputs.input_ids.shape[1]:]
            text = tok.decode(generated, skip_special_tokens=True).strip().strip('"“”')
            if body.language == "hi":
                text = feminine_hindi_agent_voice(text)
            if text and not re.search(r"[A-Za-z]", text):
                break
    expected = re.compile(r"[\u0900-\u097f]" if body.language == "hi" else r"[\u0b00-\u0b7f]")
    if not text or not expected.search(text):
        raise HTTPException(status_code=503, detail="Dialogue model did not return native-script speech")
    return {"text": text[:2000], "language": body.language, "model": MODEL_ID}
