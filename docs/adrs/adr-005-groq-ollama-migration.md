# ADR-005: Groq + Ollama Provider Migration

**Status**: Accepted
**Date**: 2026-04-01
**Milestone**: M6 — Groq ZDR + Ollama Embeddings

---

## Context

The ledger project handles sensitive financial data — bank statements, transaction descriptions, spending patterns. Initially, all AI capabilities used Mistral AI: chat streaming (`mistral-large-latest`), transaction categorization, query decomposition, and text embeddings (`mistral-embed`, 1024-dim). This meant every user's financial data was sent to Mistral's API for processing and embedding, with no guarantee against data retention or model training.

Key constraints:
- **Data privacy is critical**: A finance app processing bank statements must minimize exposure of financial data to third-party APIs
- **Groq's Zero Data Retention (ZDR) policy**: Groq guarantees no user data is stored or used for model training — essential for a finance application
- **Full data sovereignty for embeddings**: Embedding generation is the highest-volume AI operation (runs on every uploaded statement). Running this locally via Ollama keeps all transaction data on-premise
- Chat quality must remain high for the agentic ReAct loop with tool calling
- The Vercel AI SDK (`ai` package) abstracts provider differences behind a unified interface

---

## Decisions

### 1. Groq for LLM Inference

**Choice**: Groq (`llama-3.3-70b-versatile`) via `@ai-sdk/groq`

**Alternatives considered**:
- **Keep Mistral**: No Zero Data Retention guarantee — Mistral's data policy does not explicitly prevent storage or training on API inputs, which is unacceptable for sensitive financial data
- **OpenAI**: Higher cost per token, and while they offer data use opt-out, Groq's ZDR is a stronger contractual guarantee
- **Local LLM via Ollama**: Insufficient quality for agentic tool-calling loops on consumer hardware — Llama 3.3 70B requires ~40GB VRAM

**Rationale**: Groq's **Zero Data Retention policy** is the primary driver — no user financial data is stored, logged, or used for training by the LLM provider. This is critical for a finance app handling real bank statements. Secondary benefits include fastest inference for open-weight models (Groq's LPU hardware) and a trivial migration path via the Vercel AI SDK (`createMistral()` → `createGroq()` with identical interfaces). Llama 3.3 70B has strong tool-calling capabilities needed for the ReAct agent loop.

**Implementation**:
- `LlmService` (renamed from `MistralService`) uses `createGroq({ apiKey })('llama-3.3-70b-versatile')`
- `chatStream()`: unchanged interface, swapped provider
- `categorize()`: rewritten from raw `chat.complete()` to `generateObject()` with Zod schema — cleaner, provider-agnostic
- `decomposeQuery()`: unchanged interface, swapped provider

### 2. Ollama for Local Embeddings

**Choice**: Ollama with `nomic-embed-text` model (768-dimensional vectors)

**Alternatives considered**:
- **Keep Mistral Embed**: Every uploaded bank statement's text would be sent to Mistral's cloud API — no data sovereignty for the most sensitive operation
- **`mxbai-embed-large` (1024-dim)**: Same dimension as Mistral (no migration needed) but less community adoption than nomic-embed-text
- **OpenAI `text-embedding-3-small`**: Still a cloud dependency, cost per token, financial data leaves the machine

**Rationale**: Running embeddings locally via Ollama achieves **full data sovereignty** — no transaction data ever leaves the user's machine for vector generation. This is the highest-volume AI operation (every uploaded statement is chunked and embedded), so keeping it local eliminates both privacy risk and API costs entirely. `nomic-embed-text` is the most popular Ollama embedding model with strong benchmark performance for retrieval tasks.

**Implementation**:
- `EmbeddingsService` creates `new Ollama({ host })` client
- Lazy health check via `client.list()` — gracefully degrades if Ollama not running
- `getEmbeddings()` calls `client.embed({ model: 'nomic-embed-text', input: texts })`
- New migration `1709700000002-ChangeEmbeddingDimension` truncates and alters `vector(1024)` → `vector(768)`

### 3. Service Rename and Cleanup

**Choice**: Rename `MistralService` → `LlmService`, `src/mistral/` → `src/llm/`

**Rationale**: The service is now provider-agnostic (uses Vercel AI SDK abstractions). Naming it `LlmService` allows future provider swaps without another rename. The embeddings concern is already separated into `EmbeddingsService`.

### 4. Structured Categorization via generateObject

**Choice**: Replace raw `chat.complete()` JSON parsing with `generateObject()` + Zod schema

**Rationale**: The old approach required parsing flexible JSON formats (bare arrays, wrapped objects, objects with category properties). Using `generateObject()` with a `z.object({ categories: z.array(z.string()) })` schema guarantees structured output, eliminating an entire class of parsing bugs.

---

## Consequences

**Positive**:
- **Zero Data Retention**: Groq's ZDR policy ensures no financial data is stored or used for training
- **Full data sovereignty for embeddings**: All transaction text stays on-premise via Ollama — no cloud API calls for vector generation
- Zero API cost for embeddings (local Ollama)
- Faster LLM inference via Groq's LPU hardware
- Cleaner categorization code (Zod schema vs. manual JSON parsing)
- Provider-agnostic service naming enables future swaps
- Single SDK pattern — all LLM calls go through Vercel AI SDK

**Negative**:
- Ollama must be running locally for embeddings (developer setup requirement)
- Existing embeddings must be re-generated after migration (dimension change)
- Two external dependencies instead of one (Groq cloud + Ollama local)

**Risks**:
- **Ollama unavailability**: Mitigated by lazy health check and graceful degradation — uploads succeed without embeddings, vector search disabled until Ollama is available
- **Groq rate limits**: Free tier has lower limits than Mistral; mitigated by existing batch logic (20 items per categorization call)
- **Model quality regression**: Llama 3.3 70B tool-calling quality validated against existing ReAct agent patterns; fallback intents preserved in decomposeQuery

---

## References

- [ADR-003: Embedding Strategy](./adr-003-embedding-strategy.md) — Original embedding decision (superseded for provider choice)
- [Architecture Documentation](../architecture.md) — Section 8: LLM & Embedding Integration
- [Vercel AI SDK Groq Provider](https://sdk.vercel.ai/providers/ai-sdk-providers/groq)
- [Ollama Embedding Models](https://ollama.com/library/nomic-embed-text)
