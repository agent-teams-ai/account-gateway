---
id: docs.reference.native-account-provider-profiles
type: reference
status: proposed
owner: gateway-maintainers
summary: Отдельные нативные профили официальных API, ограниченная совместимость протоколов и квалификация для ревью.
---

# Пакет D: прямые API Anthropic и Gemini

## 1. Результат и граница пакета D

Добавить два отдельных protected native профиля: **Anthropic API key** и **Gemini API key**. Account Gateway и RR используют общий [capabilities/import/metadata contract](native-account-contracts.md); отдельной provider-specific формы, операции, account table или metadata базы для каждого профиля не требуется.

Пакет отвечает за реальные native HTTP/codec/model/tool semantics. Вход через key — только начало: пригодность для code review доказывается выбранным runner и protocol. Новый профиль не наследует подписку Claude Pro/Max или Google AI Pro только потому, что у аккаунта есть key.

Источники исследования — Sub2API `cfe50b7fd2aef08a7a17f11132cae73293804389`, Gateway `1dce5c327d14e9c0e5466da91441faa0d0ae38a5`, RR `f1cde67a2baf7416ea1d2341f6c9a98e64750aa4`. Это план; ни live key validation, ни live review этим документом не подтверждены.

## 2. D0: сначала проверить реальные требования runner

В RR production review runner запускает `codex exec --sandbox read-only`, пишет provider config с `wire_api="responses"` и не гарантирует function-only tools. Joined qualification уже проверяет `function_call_output`, а при объявленных custom tools — `custom_tool_call_output`. Поэтому «OpenAI-compatible Chat API есть» не является достаточным доказательством готовности.

Проверенные места:

- [github-action.ts](https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/packages/features/codex-oauth-rotating/src/action/github-action.ts): команда Codex, `protectedResponsesToolPolicyConfigLines`, `writeCodexProxySnapshot`.
- [Joined harness](https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/scripts/review-investigation-paired-e2e/support/provider-subscriptions-joined.ts): фактические round trips и run completion.
- [Native pure converters](https://github.com/agent-teams-ai/sub2api/tree/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/pkg/apicompat): Responses/Anthropic и Responses/Chat; отдельные tests для custom tools и tool outputs.

**Первый deliverable D0** — bounded протокольная матрица на exact pinned runner/model: текст, tools declaration, function/custom tool call, input/output round trip, multi-turn continuation, streaming terminal, cancel, usage и error. Начать с recorded synthetic wire из существующего harness без реальных credentials; затем один test-account live path. Нельзя включать provider для production review по текстовому probe.

Выбранный путь: переиспользовать существующие **чистые native converters**, дополнить только отсутствующее faithful преобразование требуемых tools и объявить точный поддержанный набор. Не добавлять второй compatibility слой в Gateway или RR. Если runner документированно допускает function-only режим с тем же набором review-инструментов, D0 может доказать этот bounded вариант; неизвестный config flag не считается решением.

Если custom-tool semantics или обязательные signatures невозможно сохранить в выбранном bridge, профиль остаётся неподтверждённым и не рекламируется как review-ready. Его подключение нельзя считать завершённым M2. Дополнительный protocol scope фиксируется отдельно до расширения реализации; это видимая зависимость оценки, не скрытая деградация.

## 3. D1: Anthropic API key

### 3.1. Adapter

Создать отдельную native profile definition с явными provider identity, key auth, fixed endpoint, qualified models, protocol conversion и allowed tool modes. Не переиспользовать Claude subscription OAuth profile под новым названием.

HTTP request использует официальный Messages API и API-key headers, включая `x-api-key` и выбранный `anthropic-version`. Версия фиксируется в native profile и тестируется с codec; не наследовать её случайно из Claude OAuth forwarding. Актуальная первичная документация: [Claude Messages API](https://platform.claude.com/docs/en/api/messages), проверена 19.11.2026. Exact версия API/model в реализации выбирается по существующим converters и D0, а не копируется из иллюстративного примера.

Переиспользовать pure Responses↔Anthropic transforms из `backend/internal/pkg/apicompat`, где их семантика совпадает. OAuth request headers, CLI fingerprints, identity probing, account custody и subscription refresh не являются частью key adapter. Сервис native Claude forwarding содержит OAuth обязанности — обёртка вокруг него не делает эти обязанности подходящими для API key.

Минимальные шаги:

1. Отдельный profile/credential-kind binding, strict allowlist fixed Anthropic origin; arbitrary provider URL не принимается.
2. Existing CandidateNative key lifecycle, admission/dispatch lease, cancellation и key redaction.
3. Responses request → pure Messages mapping с explicit unsupported input rejection до dispatch.
4. Streaming и buffered Messages → Responses с правильными item IDs, tool outputs, terminal failures и usage.
5. Shared native completion/settlement; после отправки upstream не повторять запрос на другом endpoint/model.
6. Native AccountInfo support с truthful unknown/unsupported для недоступных полей.

Критическая точка — существующая **финальная расшифровка key под lock/identity checks** в [native_gateway_identity.go](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/native_gateway_identity.go). Сейчас guard требует encrypted placeholder `Authorization: Bearer …`, а после decode меняет только Authorization; target selection в [native_gateway_responses.go](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/native_gateway_responses.go) выбирает Responses/Chat. Поэтому одного x-api-key в mapper недостаточно. Добавить closed profile-owned target/header policy **на этой же единственной decode boundary**: Anthropic — exact Messages URL, x-api-key и pinned anthropic-version; Gemini — fixed Chat URL и Bearer. Encrypted account row, scope/version/model checks и entered fence сохраняются; caller headers не передаются и plaintext не извлекается раньше. Проверить фактические URL/headers на отправленном request, включая отсутствие лишнего Bearer у Anthropic.

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

**Явная задача D2-signatures.** Текущие `ChatMessage`, `ChatToolCall` и streaming `ChatDelta` в [apicompat/types.go](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/pkg/apicompat/types.go) не сохраняют Google signature extension. Неизменённый typed decode теряет её. [Документация thought signatures](https://aistudio.google.com/docs/thought-signatures?generate-content=true#openai) требует вернуть signature в соответствующем следующем tool turn для применимых моделей. Добавить bounded opaque signature codec для buffered/streamed paths с exact turn/call association. D0 сначала проверяет перенос через существующий Responses continuation carrier (`encrypted_content` уже есть в Responses types) и фактическое сохранение pinned CLI. Это гипотеза выбранного минимального пути, не доказанная совместимость. До завершения D0 фиксируется один qualified carrier и его byte/account/turn bounds; нет нового общего conversation store. Если carrier не проходит, persistent native session storage требует отдельного scope решения, а Gemini остаётся незавершённым и unavailable, не silently degraded. Reasoning text/dummy signature не являются заменой.

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
| Joined test/live test-account qualification | После native+Gateway сборки | Integrator, exact artifacts; не внешний пользовательский проект |

Не объединять unrelated provider additions. Если D1 проходит раньше D2, выпускать D1 отдельно при сохранении остальных invariants. D2 продолжает честно показываться unavailable либо отсутствует в eligible catalog, пока qualification не завершена.

## 7. Тесты и Definition of Done

Общий fixture scenario переиспользуется для обоих профилей; независимые ожидаемые payload/terminal values не генерируются тем же converter, который тестируется.

- Allowed fixed endpoint, credentials redaction, unauthorized key и forbidden model.
- Faithful function/custom round trips из D0, streaming terminal и exact usage mapping.
- No silent downgrade: неподдержанный request отклонён до dispatch.
- Abort/disconnect закрывает owned response/lease; upstream ambiguous outcome не replay-ится.
- Metadata unavailable/unsupported не ломает корректный inference; key profile не изображается подпиской.
- Exact profile passes existing native/Gateway qualification и real RR joined harness с pinned runner/model.

Дополнительно один live test-account run на провайдера должен быть явно помечен как live evidence с exact commit/model/version; без него статус только synthetic-qualified. Реальный paid test выполняется в разрешённом test project с согласованным лимитом, без публикации настоящего review. Никаких дополнительных credential tests на каждом открытии UI.

Канонический бюджет D находится в [основном плане, §9](native-account-integration-plan.md); он уже включает выявленные protected header/target policy и bounded signature codec. Gateway registration и RR shared key form учитываются в B/C и повторно сюда не прибавляются. Диапазон предполагает успешный D0 без нового durable continuation service/runner redesign. Existing plaintext/fail-open reasoning cache не является готовой signature authority: его нельзя переиспользовать без проверки scope/turn и fail-closed semantics. Если minimal carrier не работает, дополнительный scope пересчитывается до объявления full M2 срока.

DoD пакета: оба профиля проходят заявленный review flow; их native metadata/capability ответы безопасны; старые profiles не изменили semantics; новые возможности скрыты при unsupported backend/consumer. Название провайдера в селекторе само по себе не является DoD.
