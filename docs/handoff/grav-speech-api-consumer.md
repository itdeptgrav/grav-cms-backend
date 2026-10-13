# GRAV Speech API consumer handoff

Use the existing central client at `services/ai/gravSpeechClient.js`. Do not
load a speech model, connect to RunPod, or create another STT endpoint.

## Development deployment available

The shared development worker is deployed on the existing private RunPod. It
listens only on the pod loopback interface. A local SSH tunnel exposes it at
`http://127.0.0.1:18097` on this Mac.

The URL and workload secret already exist in the repository's ignored `.env`:

```text
GRAV_SPEECH_API_URL=http://127.0.0.1:18097
GRAV_SPEECH_SHARED_SECRET=<already configured locally; do not print or commit>
```

Do not ask the user for RunPod access or another secret. Use the existing Node
client and load the local `.env`. The tunnel command is stored locally at
`.local-results/grav-speech-api/tunnel-command.txt`; rerun it if the pod or Mac
restarts. The development URL is intentionally not a public production origin.

Confirm availability before submitting work:

```text
GET http://127.0.0.1:18097/health/live
GET http://127.0.0.1:18097/health/ready
```

`health/ready` returns `503 MODEL_WARMING` until the saved Flex weights are
resident on the GPU. That is a retryable warm-up state, not permission failure.

For a completed private recording already available to the speech service's
mounted audio root:

```js
const { createTranscriptionJob, getTranscriptionJob } = require("../ai/gravSpeechClient");

const job = await createTranscriptionJob({
  service: "cowork",
  companyId: trustedCompanyContext.companyId,
  source: {
    application: "cowork",
    kind: "meeting",
    id: String(meeting.id),
    audioObject: meeting.privateAudioObjectKey,
  },
  diarization: true,
  idempotencyKey: `meeting:${meeting.id}:audio:${meeting.audioFingerprint}`,
});

const latest = await getTranscriptionJob({
  service: "cowork",
  companyId: trustedCompanyContext.companyId,
  jobId: job.jobId,
});
```

Rules for the consuming implementation:

- derive company and source identity on the server;
- prove the actor may read the source recording before submission and result
  display;
- never accept `companyId`, `audioObject`, model names or a callback URL from
  the browser;
- retain the returned `jobId` and poll with a bounded backoff;
- store/display raw `result.romanTranscript` and `result.speakerTurns` without
  LLM or manual rewriting;
- distinguish `queued`, processing states, `succeeded`, `failed` and
  `cancelled`;
- do not copy CoWork transcript text into Sales merely because a CRM link
  exists.

For a short voice command, call `transcribeUtterance` with raw audio bytes. The
speech result is only text; the application-specific command layer decides what
that text means and enforces its own tool permissions.
