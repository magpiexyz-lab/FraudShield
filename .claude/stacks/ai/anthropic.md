---
assumes: []
packages:
  runtime: ["@anthropic-ai/sdk"]
  dev: []
files:
  - src/lib/ai.ts
env:
  server: [ANTHROPIC_API_KEY]
  client: []
ci_placeholders:
  ANTHROPIC_API_KEY: placeholder-anthropic-api-key
clean:
  files: []
  dirs: []
gitignore: []
---
# AI: Anthropic (Claude SDK)
> Used when experiment.yaml has `stack.ai: anthropic`
> Assumes: None — works with any framework

## Packages
```bash
npm install @anthropic-ai/sdk
```

## Files to Create

### `src/lib/ai.ts` — Anthropic client with retry and streaming support
```ts
import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-opus-4-6";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

let _client: Anthropic | null = null;

function createDemoClient() {
  return {
    messages: {
      create: async (params: { stream?: boolean }) => {
        if (params.stream) {
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "content_block_delta" as const,
                delta: { type: "text_delta" as const, text: "[demo response]" },
              };
              yield {
                type: "message_stop" as const,
              };
            },
          };
        }
        return {
          id: "demo",
          content: [{ type: "text" as const, text: "[demo response]" }],
          model: DEFAULT_MODEL,
          role: "assistant" as const,
          stop_reason: "end_turn" as const,
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      },
    },
  } as unknown as Anthropic;
}

function getClient(): Anthropic {
  if (process.env.DEMO_MODE === "true" && process.env.VERCEL === "1") {
    throw new Error("DEMO_MODE is not allowed in production");
  }
  if (process.env.DEMO_MODE === "true") return createDemoClient();
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }
    _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env automatically
  }
  return _client;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.InternalServerError) return true;
  if (error instanceof Anthropic.APIConnectionError) return true;
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Public API ---

export type MessageParams = Omit<
  Anthropic.MessageCreateParamsNonStreaming,
  "model"
> & {
  model?: string;
};

export type StreamParams = Omit<
  Anthropic.MessageCreateParamsStreaming,
  "model" | "stream"
> & {
  model?: string;
};

/**
 * Send a message to Claude. Retries on transient errors with exponential backoff.
 */
export async function ask(params: MessageParams): Promise<Anthropic.Message> {
  const { model = DEFAULT_MODEL, ...rest } = params;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await getClient().messages.create({
        model,
        ...rest,
        stream: false,
      });
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_RETRIES - 1) throw error;
      await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
    }
  }

  throw lastError;
}

/**
 * Stream a message from Claude. Retries on transient errors before first chunk.
 * Returns an async iterable of streaming events.
 */
export async function stream(
  params: StreamParams
): Promise<Anthropic.MessageStream> {
  const { model = DEFAULT_MODEL, ...rest } = params;
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return getClient().messages.stream({
        model,
        ...rest,
      });
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_RETRIES - 1) throw error;
      await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
    }
  }

  throw lastError;
}

/**
 * Extract the text content from a Claude response.
 */
export function getText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}
```

## Environment Variables
```
ANTHROPIC_API_KEY=sk-ant-...
```

## Patterns
- **All AI calls go through `src/lib/ai.ts`** — never `import Anthropic from "@anthropic-ai/sdk"` directly in pages or API routes
- Use `ask()` for request/response. Use `stream()` for streaming UIs.
- Use `getText()` to extract text from a response — handles multi-block content safely
- The default model is `claude-opus-4-6`. Override per-call via `model` param when needed (e.g., `claude-haiku-4-5-20251001` for fast/cheap tasks)
- The SDK reads `ANTHROPIC_API_KEY` from the environment automatically — no need to pass it explicitly
- Retry logic covers `RateLimitError`, `InternalServerError`, and `APIConnectionError` — all other errors fail immediately
- Call `ask()` and `stream()` inside API route handlers or server actions — never in client components

### Usage examples

**Simple request:**
```ts
import { ask, getText } from "@/lib/ai";

const message = await ask({
  max_tokens: 1024,
  messages: [{ role: "user", content: "Summarize this text: ..." }],
});
const summary = getText(message);
```

**With system prompt:**
```ts
const message = await ask({
  max_tokens: 2048,
  system: "You are a demand validation expert.",
  messages: [{ role: "user", content: userInput }],
});
```

**Streaming:**
```ts
import { stream } from "@/lib/ai";

const response = await stream({
  max_tokens: 4096,
  messages: [{ role: "user", content: prompt }],
});

for await (const event of response) {
  if (
    event.type === "content_block_delta" &&
    event.delta.type === "text_delta"
  ) {
    process.stdout.write(event.delta.text);
  }
}
```

**Fast model override:**
```ts
const message = await ask({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 256,
  messages: [{ role: "user", content: "Classify: positive or negative" }],
});
```

## Security
- `ANTHROPIC_API_KEY` is server-only — never expose it to the client
- Never pass user input directly as the `system` prompt — always use hardcoded system prompts with user input in `messages`
- Validate and sanitize all user-provided content before including it in prompts
- Set `max_tokens` on every call to prevent runaway costs — choose the minimum sufficient for the task
- For user-facing features, consider adding application-level rate limiting on the API route that calls `ask()`/`stream()`

## Demo Mode
When `DEMO_MODE=true`, all calls return `[demo response]` without hitting the API. This enables visual review and CI builds without credentials.

## PR Instructions
- After merging, set `ANTHROPIC_API_KEY` in your hosting provider's environment variables
  - Get your key from [console.anthropic.com](https://console.anthropic.com/) > API Keys
- The SDK respects `ANTHROPIC_API_KEY` automatically — no additional configuration needed
- Set a spending limit in the Anthropic Console to prevent unexpected costs
