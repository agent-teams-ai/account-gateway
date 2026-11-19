---
id: docs.reference.native-account-provider-profiles
type: reference
status: proposed
owner: gateway-maintainers
summary: Отдельные нативные профили официальных API, ограниченная совместимость протоколов и квалификация для ревью.
---

# Пакет D: прямые API Anthropic и Gemini

## 1. Результат и граница пакета D

В Sub2API реализованы два protected native профиля. Gateway/RR используют общий [contract](native-account-contracts.md); provider HTTP/codecs остаются в native. Checkpoint — `dc4ea4491945856c900418c8627c7bac593a62ce`, PR103. Полная exact-head qualification фиксируется [отдельно](native-account-qualification.md); live provider access и production deployment не заявлены.

| Profile ID | Fixed native base URL | Model anchor | Downstream protocol |
| --- | --- | --- | --- |
| `anthropic-messages-apikey-v1` | `https://api.anthropic.com/v1` | `claude-sonnet-4-6` | `openai-responses` |
| `gemini-openai-chat-apikey-v1` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.1-pro-preview` | `openai-responses` |

Это closed tuples: browser/auth.json/key payload не выбирают origin/model. Existing FD6 configuration включает adapter; migration262 разрешает только эти tuples в existing protected account SQL guard. Один model anchor не означает весь vendor catalog. [Profile/Anthropic forwarding](https://github.com/agent-teams-ai/sub2api/blob/dc4ea4491945856c900418c8627c7bac593a62ce/backend/internal/service/native_gateway_official_api.go), [SQL guard](https://github.com/agent-teams-ai/sub2api/blob/dc4ea4491945856c900418c8627c7bac593a62ce/backend/migrations/262_gateway_official_api_profiles.sql).

API key — write-only credential existing CandidateNative create/reconnect lifecycle. Consumer subscription/email из ключа не выводятся; AccountInfo fields без источника unsupported. Protocol/model/tool поведение квалифицирует actual review runner.

## 2. D0: сначала проверить реальные требования runner

В RR production review runner запускает `codex exec --sandbox read-only`, пишет provider config с `wire_api="responses"` и не гарантирует function-only tools. Joined qualification уже проверяет `function_call_output`, а при объявленных custom tools — `custom_tool_call_output`. Поэтому «OpenAI-compatible Chat API есть» не является достаточным доказательством готовности.

Actual review caller передаёт output schema, включая numeric minimum/maximum для confidence. Text/tool fixture без этой schema недостаточна. Anthropic path использует bounded lowering и terminal validation всей original schema; Gemini — existing Responses text.format → Chat response_format conversion.

Проверенные места:

- [github-action.ts](https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/packages/features/codex-oauth-rotating/src/action/github-action.ts): команда Codex, `protectedResponsesToolPolicyConfigLines`, `writeCodexProxySnapshot`.
- [Joined harness](https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/scripts/review-investigation-paired-e2e/support/provider-subscriptions-joined.ts): фактические round trips и run completion.
- [Native pure converters](https://github.com/agent-teams-ai/sub2api/tree/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/pkg/apicompat): Responses/Anthropic и Responses/Chat; отдельные tests для custom tools и tool outputs.

**Наблюдаемая D0-проверка.** Pinned Codex CLI0.133.0 сохранил opaque reasoning.encrypted_content между двумя Responses turns и вернул его с tool output. Это узкий carrier experiment с synthetic upstream, не доказательство native Gemini decoding, signature/call association, entitlement или полного review. Exact CLI hash и последующая joined matrix указаны в qualification.

Использованы existing pure native converters. Дополнения ограничены faithful tool/output-format mapping, signature carrier и profile-owned strict wire policy. Function/custom round trips, multi-turn continuation, stream terminal, cancel, usage/error проверяются existing joined harness; второго compatibility layer в Gateway/RR нет. Pure converters и carrier probe не заменяют этот E2E.

До успешного exact-head actual review flow профиль не называется review-qualified. Обязательные custom-tool/signature ошибки исправляются native и проверяются повторно; silently degraded режим, выдуманный CLI flag и durable conversation store не используются. Production deployment/live credentials не входят в текущий прогон.

## 3. D1: Anthropic API key

### 3.1. Adapter

`anthropic-messages-apikey-v1` имеет отдельную identity, key auth, fixed endpoint/model и tool policy. Existing encrypted key custody переиспользуется; профиль не выдаётся за Claude subscription OAuth. Discovery строится из composed private profile, не из наличия admin catalog entry.

Native отправляет Messages request на exact `https://api.anthropic.com/v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`. Key дешифруется только на existing final custody boundary под physical/identity checks и entered fence: encrypted Bearer placeholder удаляется, устанавливается x-api-key. OAuth beta/fingerprint headers не наследуются. [Forwarding](https://github.com/agent-teams-ai/sub2api/blob/dc4ea4491945856c900418c8627c7bac593a62ce/backend/internal/service/native_gateway_official_api.go), [decode boundary](https://github.com/agent-teams-ai/sub2api/blob/dc4ea4491945856c900418c8627c7bac593a62ce/backend/internal/service/native_gateway_identity.go).

Переиспользовать pure Responses↔Anthropic transforms из `backend/internal/pkg/apicompat`, где их семантика совпадает. OAuth request headers, CLI fingerprints, identity probing, account custody и subscription refresh не являются частью key adapter. Сервис native Claude forwarding содержит OAuth обязанности — обёртка вокруг него не делает эти обязанности подходящими для API key.

Реализованные границы:

1. Отдельный profile/credential-kind binding, strict allowlist fixed Anthropic origin; arbitrary provider URL не принимается.
2. Existing CandidateNative key lifecycle, admission/dispatch lease, cancellation и key redaction.
3. Responses request → pure Messages mapping с explicit unsupported input rejection до dispatch.
4. Streaming и buffered Messages → Responses с правильными item IDs, tool outputs, terminal failures и usage.
5. Shared native completion/settlement; после отправки upstream не повторять запрос на другом endpoint/model.
6. Native AccountInfo support с truthful unknown/unsupported для недоступных полей.

Shared protected dispatch выбирает profile-owned target/header policy на единственной decode boundary. Anthropic — Messages URL, Gemini — fixed Google Chat URL с Bearer; caller headers не переносятся. Encrypted account row, scope/version/model checks и entry fence сохранены. После upstream entry нет автоматического запроса на другой endpoint/model. Actual URL/headers и отсутствие Bearer у Anthropic проверяются отдельно от converters.

### Structured output реального review

Pure Responses→Anthropic converter сохраняет text.format в output_config.format с original JSON schema. Native принимает закрытое bounded subset:64KiB, depth16,2048nodes, без schema refs/remote loader. Numeric minimum/maximum, не выражаемые provider output grammar, переводятся в upstream description; полный original schema проверяет final JSON до successful completed через existing jsonschema-go. Это provider lowering с обязательной terminal validation. [Schema boundary](https://github.com/agent-teams-ai/sub2api/blob/dc4ea4491945856c900418c8627c7bac593a62ce/backend/internal/service/native_gateway_anthropic_schema.go).

Промежуточный настоящий tool turn не является final review JSON. Ложный tool terminal без вызова, invalid/incomplete JSON, schema violation, duplicate keys и invalid Unicode не дают successful review. Stream validation происходит до terminal; уже отправленные промежуточные events не обещают итоговый success. Generic converter не добавляет не объявленные thinking/reasoning controls.

### 3.2. Что проверять

Не использовать модельный ответ «OK» как credential/entitlement authority. Existing qualification gate должен доказать, что key разрешает конкретный model/protocol. AccountInfo не управляет admission.

В pure converter проверить tools schemas и names, параллельные calls, function/custom round trip, system/developer instructions, empty/refusal/tool stop, streamed partial JSON, interrupted stream и cancellation. Request fields без faithful mapping должны иметь safe unsupported error до платного эффекта. Не удалять silently reasoning/tool/text blocks, чтобы тест прошёл.

Официальные API credentials не являются импортом Claude.ai OAuth. Ограничения существующей RR central OAuth policy остаются. Это локальный scope решения, не новая проверка каждого пользователя.

## 4. D2: Gemini API key

### 4.1. Выбранный bridge

В native использовать **официальный Google OpenAI-compatible Chat endpoint** `https://generativelanguage.googleapis.com/v1beta/openai/` через уже существующий protected Responses→Chat compatibility path. Он server-owned; endpoint из browser/config file не принимается. Официальная [OpenAI compatibility documentation](https://ai.google.dev/gemini-api/docs/openai) подтверждает key auth, streaming и function calling; наличие этих возможностей не доказывает полную совместимость с Responses/custom tools.

Это один осмысленный bridge: RR/Gateway говорят на своём existing Responses boundary, native адаптирует к Google. Не строить цепь Responses→Anthropic→Gemini и не подключать целиком `GeminiMessagesCompatService` с чужим scheduler/tokenProvider/retry lifecycle ради нескольких helpers.

Порядок:

1. Отдельный Gemini provider/profile, fixed origin, server-held key, existing native dispatch/admission.
2. Reuse pure Responses↔Chat transform с явным разрешённым набором request fields; D0 доказывает фактические tool semantics runner.
3. Измерить/проверить multi-turn function/custom output, IDs, required thought signatures и reasoning mapping для выбранных моделей. Если они теряются, reject/исправить native codec; «правдоподобный текст» не заменяет continuity.
4. Реально поддержанный model list приходит из native canonical source; никакой отдельной таблицы моделей в JSX/Gateway application.
5. Metadata key/project facts при наличии документированного безопасного источника; email и consumer subscription не угадываются.

**Реализованный D2-signatures codec.** Typed ChatMessage/ChatToolCall/ChatDelta сохраняют closed Google extra_content.google.thought_signature; native strict wire разрешает extension только selected Gemini profile. Pure codec переносит signature через opaque Responses reasoning.encrypted_content, проверяя version, exact call ID, semantic digest и assistant-step position. Bounds: signature64KiB, plaintext carrier128KiB, до64calls; sealed representation bounded отдельно. Shared signature validator используется wire и codec. [Codec](https://github.com/agent-teams-ai/sub2api/blob/dc4ea4491945856c900418c8627c7bac593a62ce/backend/internal/pkg/apicompat/gemini_continuation.go), [wire policy](https://github.com/agent-teams-ai/sub2api/blob/dc4ea4491945856c900418c8627c7bac593a62ce/backend/internal/service/native_gateway_gemini_wire.go).

Carrier authenticated/encrypted existing native custody keyring с отдельным AAD purpose. Binding содержит logical scope, exact physical birth/generation, profile/base/model и requested model. Чужой/изменённый carrier отклоняется. Нового secret/config/key manager/conversation DB нет; plaintext/fail-open generic reasoning cache не используется. Signature не становится AccountInfo/UI fact. [AEAD adapter](https://github.com/agent-teams-ai/sub2api/blob/dc4ea4491945856c900418c8627c7bac593a62ce/backend/internal/service/native_gateway_gemini_carrier.go).

Buffered/streamed paths используют один codec. Late signature-only chunks сохраняются; carrier/tool order одинаков в done events и completed output. Same-text assistant steps не подменяют association. После invalid continuation buffered chunks не обрабатываются. Actual CLI carrier probe — узкое D0 evidence, native+Gateway+RR continuation — отдельный exact-head acceptance gate.

Независимые fixtures D2-signatures: второй tool turn, signature в позднем terminal chunk, sequential/parallel calls и правильное соответствие call IDs. Signature не попадает в AccountInfo, diagnostics или UI. Совпадение текста ответа при потерянной continuity считается failure, а не успешной review qualification.

### 4.2. Ограничения

В этой волне нет Gemini CLI OAuth, Google One, Vertex service-account credentials, images/audio/video, grounding/web search, hosted tools или произвольных Google APIs. Используется только выбранный review protocol. Не все модели одного vendor получают одинаковые tool/reasoning capabilities по умолчанию.

Gemini provider ID отсутствует в legacy строгом v1 catalog Gateway. Он публикуется через capabilities v2; v1 остаётся совместимой проекцией того же источника. Нельзя назвать Gemini `openai`, потому что внешний протокол похож.

## 5. Capability authority и модели

Native definition хранит фактическую protocol/model/auth поддержку. Gateway registration определяет, какие qualified profiles доступны данному deployment; RR определяет, какие из них разрешены его продукту. Это разные политики, не три копии одного provider enum.

При добавлении model support сохраняем существующий способ catalog admission: fixed qualified anchor и/или существующий native model source. Не создаём live `/models` fetch на каждый dispatch. Не подменяем catalog моделью, извлечённой из строки subscription plan. Не обещаем «все актуальные модели Anthropic/Gemini»; конкретный admitted set привязан к qualification evidence.

Для capabilities пригодность означает не только успешную аутентификацию: метод входа, model ID, tool mode, protocol и deployment implementation должны одновременно быть поддержаны. Поле `availability` — operational state, а не маркетинговое описание.

## 6. Параллельные задачи и владение файлами

| Задача | Может идти параллельно | Owner/граница |
| --- | --- | --- |
| D0 captured wire/runner matrix | A1 metadata, B1 SDK, C1 UI | Provider engineer совместно с RR reviewer; без изменения общего runner по умолчанию |
| D1 Anthropic adapter/fixtures | D2 Gemini adapter | Отдельные native provider files и pure converter tests |
| D2 Gemini adapter/fixtures | D1 | Отдельные native provider files; generic Chat bridge меняет один integrator |
| Registry/model qualification integration | После D0 и соответствующего adapter | Один native owner; никто параллельно не переписывает platform registry |
| Gateway registration + RR capability use | После exact profile freeze | B/C consume; vendor protocol parsing туда не переезжает |
| Joined synthetic qualification | После native+Gateway сборки | Integrator, exact artifacts; не внешний пользовательский проект |

Не объединять unrelated provider additions. Если D1 проходит раньше D2, выпускать D1 отдельно при сохранении остальных invariants. D2 продолжает честно показываться unavailable либо отсутствует в eligible catalog, пока qualification не завершена.

## 7. Тесты и Definition of Done

Полный pure apicompat suite проверен локально до последнего checkpoint. Native/SQL/joined результаты дляdc4 публикуются в qualification; старые runs не засчитываются за изменённый head.

Общий fixture scenario переиспользуется для обоих профилей; независимые ожидаемые payload/terminal values не генерируются тем же converter, который тестируется.

- Allowed fixed endpoint, credentials redaction, unauthorized key и forbidden model.
- Faithful function/custom round trips из D0, streaming terminal и exact usage mapping.
- No silent downgrade: неподдержанный request отклонён до dispatch.
- Abort/disconnect закрывает owned response/lease; upstream ambiguous outcome не replay-ится.
- Metadata unavailable/unsupported не ломает корректный inference; key profile не изображается подпиской.
- Exact profile passes existing native/Gateway qualification и real RR joined harness с pinned runner/model.

Текущий прогон использует signed/encrypted synthetic fixtures, actual native HTTP/SQL и pinned review runner. Live availability/entitlement подтверждаются только отдельно разрешёнными реальными credentials; они не подменяются тестовыми. Production deployment не выполняется, дополнительного probe при открытии UI нет.

Канонический бюджет D находится в [основном плане, §9](native-account-integration-plan.md); он уже включает выявленные protected header/target policy и bounded signature codec. Gateway registration и RR shared key form учитываются в B/C и повторно сюда не прибавляются. Диапазон предполагает успешный D0 без нового durable continuation service/runner redesign. Existing plaintext/fail-open reasoning cache не является готовой signature authority: его нельзя переиспользовать без проверки scope/turn и fail-closed semantics. Если minimal carrier не работает, дополнительный scope пересчитывается до объявления full M2 срока.

DoD пакета: оба профиля проходят заявленный review flow; их native metadata/capability ответы безопасны; старые profiles не изменили semantics; новые возможности скрыты при unsupported backend/consumer. Название провайдера в селекторе само по себе не является DoD.
