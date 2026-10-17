"use strict";

const clean = (value) => String(value || "")
  .normalize("NFKC")
  .toLowerCase()
  .replace(/[.,!?;:।]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const RULES = Object.freeze([
  // Order matters: "I will approve later" is a deferral, not an approval.
  ["DEFER", /\b(later|not now|decide later|approve later|review (?:it )?later|will review|need (?:some )?time|come back to (?:it|this)|leave (?:it|this) pending|remind me|baad mein|baad me|pare karibi|pare)\b|बाद में|बादमे|फिर से बताऊंगा|ପରେ|ପଛରେ/],
  ["OPEN_REQUEST", /\b(open|show|see|view)\b.*\b(request|mrf|details?)\b|अनुरोध.*(खोल|दिखा)|ଅନୁରୋଧ.*(ଖୋଲ|ଦେଖା)/],
  ["REPEAT", /\b(repeat|again|say again|read again|phir se|dobara|puni thare|authare)\b|फिर से|दोबारा|दुबारा|ପୁଣି|ଆଉଥରେ/],
  ["REJECT", /\b(reject|decline|deny|not approve|do not approve|don't approve|cannot approve|can't approve|send (?:(?:it|this) )?back|asweekar|asvikar|namanzur|mana|pratyakhyan|pratyakhyana)\b|अस्वीकार|नामंजूर|मना|ଅସ୍ୱୀକାର|ପ୍ରତ୍ୟାଖ୍ୟାନ|ମନା/],
  ["APPROVE", /\b(approve|approved|accept|looks? (?:fine|good)|go ahead|please proceed|you can proceed|clear (?:it|this)|yes approve|manjoor|manjur|sweekar|svikar|anumodan|anumodana)\b|मंजूर|स्वीकार|अनुमोदन|मंजूरी|ଅନୁମୋଦନ|ମଞ୍ଜୁର|ସ୍ୱୀକାର/],
]);

const YES = /\b(yes|yeah|yep|confirm|confirmed|that's right|that is right|go ahead|please proceed|proceed with it|do it|sounds good|haan|han|ji haan|kar do|karantu|thik achhi)\b|कर दो|हाँ|हां|जी हाँ|ହଁ|ଠିକ ଅଛି|କରନ୍ତୁ/;
const NO = /\b(no|cancel|stop|do not|don't|not anymore|changed my mind|leave it|nahi|nahin|radd|na|batil)\b|नहीं|नही|रद्द|ନା|ବାତିଲ/;

function classifyIntent(text) {
  const normalized = clean(text);
  if (!normalized) return { intent: "UNKNOWN", confidence: 0, normalized };
  for (const [intent, pattern] of RULES) {
    if (pattern.test(normalized)) return { intent, confidence: 1, normalized };
  }
  return { intent: "UNKNOWN", confidence: 0, normalized };
}

function classifyConfirmation(text) {
  const normalized = clean(text);
  if (NO.test(normalized)) return { intent: "CANCEL", confidence: 1, normalized };
  if (YES.test(normalized)) return { intent: "CONFIRM", confidence: 1, normalized };
  return { intent: "UNKNOWN", confidence: 0, normalized };
}

module.exports = { classifyConfirmation, classifyIntent };
