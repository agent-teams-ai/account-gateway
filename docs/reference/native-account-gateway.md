---
id: docs.reference.native-account-gateway
type: reference
status: proposed
owner: gateway-maintainers
summary: Реализованные Gateway ports, SDK, нативные capabilities, AccountInfo и выбранные импорты через существующие операции; проверенные и ожидающие квалификации границы.
---

# Пакет B: переиспользуемый Account Gateway

## Overview

Этот пакет расширяет существующие библиотеку и сервис Account Gateway для безопасного чтения сведений об аккаунте и приоритетных способов подключения. Реализация M1/M2 опубликована в [PR #116](https://github.com/agent-teams-ai/account-gateway/pull/116). Потребитель использует один SDK, а Sub2API остаётся владельцем сведений провайдера, его протокола и credential lifecycle. Подмена конкретного backend происходит через узкие серверные ports и composition.

Документ фиксирует реализованные границы на Gateway [`f2690a3`](https://github.com/agent-teams-ai/account-gateway/tree/f2690a3c9cfd0cf61bfb7ca31b802d249105d751) и дальнейшие критерии готовности. Он не объявляет пройденными ещё не выполненные joined сценарии на текущем native build, live provider E2E или production rollout. Общая последовательность находится в [главном плане](native-account-integration-plan.md), единственная спецификация публичных DTO и инвариантов — в [контрактах](native-account-contracts.md). Native persistence и переходы подключения описаны в [пакете Sub2API](native-account-sub2api.md); состав приоритетных профилей — в [матрице провайдеров](native-account-provider-profiles.md). Проверки и критерии выпуска принадлежат [пакету квалификации](native-account-qualification.md).

### Текущий SDK и доказательства

| Граница | Зафиксированное состояние |
| --- | --- |
| SDK source | `f2690a3c9cfd0cf61bfb7ca31b802d249105d751`, опубликованный исходник без локальных SDK правок. |
| Private archive для RR | `agent-teams-account-gateway-0.1.0-native-imports-f2690a3c9cfd.tgz`; SHA-256 `34562d43668a1ca09e95666da3237206b3744d0d0766039fd2b8acbce241483f`. |
| Сборка | Node `26.11.1`, pnpm `11.28.2`; совместимость с Node `24.21.0` сохраняется отдельной существующей lane. |
| Gateway проверки | 152 domain tests, 76 OAuth/PostgreSQL tests; package/kernel CI на `2bee1511` прошли. Targeted runtime27/27 и public SDK14/14 прошли наNode24/26; joined evidence7/7 проверяет положительный receipt, не заменяя actual runner execution. Источники и остальные gates учитываются в [квалификации](native-account-qualification.md). |
| Joined сценарии | Provider fixture расширен на официальные Anthropic/Gemini, device fixture — на Codex imports/metadata/reconnect/потерю ACK. Строгая TypeScript-компиляция, lint и форматирование выполнены; исполнение этих сценариев с актуальным native source ещё требует отдельного результата. |

Archive содержит уже существующий `function_and_custom` mode в `native_catalog` wire union. Исторические `ef4508c` и `6c1350e` archives не являются текущим SDK pin; новыйf2690a3 дополнительно сохраняет caller byte cap и cancellation/authority semantics. Новая упаковка не является публикацией в npm или разрешением production rollout.

### Граница выбранной работы

В этот пакет входят AccountInfo, discovery возможностей подключения, импорт обычного OpenAI refresh token и полного OAuth JSON, а также проводка выбранных API-key профилей Anthropic и Gemini. Существующие browser/device flows продолжают работать через прежние контракты. PAT, AgentIdentity, AT-only, mobile RT и новый browser OAuth для Gemini не включаются через универсальный JSON «про запас»: их нет в закрытом наборе входов этой волны.

Повторно используемость означает возможность подключить SDK к другому продукту и заменить серверный адаптер выбранного account-management backend без изменения продуктовых правил и публичных DTO. Она не требует переносить PostgreSQL, private Gateway kernel или credential storage в каждый consumer. Второй production backend в этой работе не создаётся; заменяемость выбранной границы доказывается независимым adapter fixture.

### От чего отталкиваемся

Срез исследования — [Gateway `1dce5c3`](https://github.com/agent-teams-ai/account-gateway/tree/1dce5c327d14e9c0e5466da91441faa0d0ae38a5). Пакет `@agent-teams/account-gateway` уже имеет browser-safe `/contracts`, server-only `/http`, `/get-modular` и экспериментальный `/llm`. Curated exports не разрешают потребителям импортировать приватный transport. Сервис уже содержит AccountManagement, durable operations, native candidate mapping, очистку и отдельные ports для limits/models. Поэтому новая библиотека управления аккаунтами и второй session engine не требуются. Основание: [package exports](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/packages/account-gateway/package.json) и [management ports](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/services/account-gateway/src/management.ts).

### Распределение ответственности

| Владелец | Что принадлежит ему |
| --- | --- |
| Sub2API | Разбор provider credentials, импорт, token exchange/refresh, account principal, фактический тариф, quota, cooldown, native model eligibility и provider HTTP. |
| Gateway application/kernel | Consumer/owner isolation, стабильные operation identities, поколения подключения, authorization epochs, квалификация и существующая очистка. |
| Backend adapter | Перевод private native DTO в узкие Gateway ports, вызов конкретных native endpoints и проверка их wire-format. |
| Публичный SDK | Версионированные безопасные DTO, ограниченные write-only входы и однократные HTTP операции. |
| Продукт-потребитель | Пользователи, workspace membership, разрешение показывать аккаунт, локальное displayName и пользовательский сценарий. |

В публичные типы не попадают Review Router workspace IDs, его роли или правила совместного использования. `ownerRef` остаётся непрозрачным владельцем внутри аутентифицированного consumer. Email используется только для отображения; он не становится ключом доступа или дедупликации.

## Contract

### B1. Расширен существующий SDK

Безопасная схема `AccountInfo` находится в `features/facade-client/contracts/account-info.ts`, discovery v2 — в существующем `contracts/index.ts`; curated public indexes реэкспортируют эти типы. Write-only импорт находится в `features/facade-client/http/ingress.ts` и `/http`; его секретные поля не экспортируются через browser-safe readback contract. `createManagementClient()` и `createConsumerControlClient()` предоставляют `readAccountInfo({ ownerRef, accountRefs }, { signal })` и `getProviderConnectionCapabilitiesV2()`. Execution client не приобретает управление аккаунтами. Реализация: [SDK clients](https://github.com/agent-teams-ai/account-gateway/blob/f2690a3c9cfd0cf61bfb7ca31b802d249105d751/packages/account-gateway/src/features/facade-client/http/clients.ts) и [AccountInfo schema](https://github.com/agent-teams-ai/account-gateway/blob/f2690a3c9cfd0cf61bfb7ca31b802d249105d751/packages/account-gateway/src/features/facade-client/contracts/account-info.ts).

Строгие legacy `Account`, `Operation` и browser/device envelopes не расширяются неизвестными старому клиенту полями. AccountInfo передаётся отдельной проекцией. Это необходимо, потому что [текущий Account](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/packages/account-gateway/src/features/facade-client/contracts/index.ts#L86-L94) содержит только refs, profile, displayName, state и revisions; [facade projection](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/services/account-gateway/src/facade-wire.ts#L50-L73) возвращает ровно этот набор.

Все методы SDK сохраняют нынешнее поведение транспорта: bounded request/response, AbortSignal и отсутствие автоматического повторения мутаций. Сбой после отправки допускает чтение той же operation identity. Новый operationId не используется как способ обойти неоднозначный результат.

### B2. Один источник capabilities, две совместимые проекции

Добавлен `GET /v2/provider-connection-capabilities` с контрактом `provider-connections/v2` и методом `getProviderConnectionCapabilitiesV2()` на существующих разрешённых clients. `/v1/provider-connection-capabilities` и его schema остаются прежними. Private native источник — `GET /private/native/v1/account-capabilities`; перевод `native-account-capabilities/v1` выполняет `NativeAccountCapabilitiesClient` в `native-client-discovery.ts`. Версия discovery не заменяет browser OAuth API.

Причина конкретна: [v1 schema](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/packages/account-gateway/src/features/facade-client/contracts/index.ts#L805-L977) имеет закрытый provider enum без Gemini, три auth methods и strict objects. Простое добавление Gemini или import в старый ответ ломает декодирование всей коллекции у старого SDK.

Оба endpoints строятся из одного канонического native-derived snapshot после пересечения с разрешёнными deployment profiles и текущим bearer. Snapshot содержит фактически зарегистрированные native management/inference возможности, а не перечень всех кнопок административного frontend Sub2API. Gateway не получает право включить способ входа только из-за появления строки в native platform catalog.

V1 является чистой compatibility projection: сохраняет представимые старой схемой поля и способы, удаляет import methods и способы без `create`, пропускает Gemini и другие непредставимые записи, после чего проверяет результат неизменённым v1 decoder. Пустой набор совместимых методов исключает запись целиком. Общий v1 `reconnect` разрешается только тогда, когда **каждый показанный способ** допускает reconnect и все они относятся к одной представимой API-key либо OAuth семье. Например, browser `create=true/reconnect=false` и device `create=false/reconnect=true` дают v1 browser с `reconnect=none`; device не выдаёт разрешение browser. В v2 сохраняются независимые флаги каждого способа. Реализация и регрессия: [чистая проекция](https://github.com/agent-teams-ai/account-gateway/blob/f2690a3c9cfd0cf61bfb7ca31b802d249105d751/services/account-gateway/src/provider-connection-capabilities.ts) и [facade tests](https://github.com/agent-teams-ai/account-gateway/blob/f2690a3c9cfd0cf61bfb7ca31b802d249105d751/services/account-gateway/test/facade-ingress.test.ts).

Нельзя переименовать Gemini в OpenAI ради прохождения старого enum. V2 использует ограниченные identifiers и закрытый набор method descriptors из канонического контракта; произвольные схемы форм и исполняемые правила не передаются. `native_catalog` account-model wire теперь допускает `function` и `function_and_custom`, чтобы не отбрасывать реально квалифицированные официальные API. Native по-прежнему выдаёт точный набор для каждого профиля; Gateway не выводит custom support из имени модели. Codex/OpenRouter/NVIDIA source schemas не расширены этой правкой, что проверяет [account-models regression](https://github.com/agent-teams-ai/account-gateway/blob/f2690a3c9cfd0cf61bfb7ca31b802d249105d751/tests/account-models.test.mts).

`provider-connections.ts` сохраняет private deployment policy: закрытые profile/baseURL/model tuples, прежнюю квалификацию и локальные ограничения допуска. Его legacy definitions больше не служат источником HTTP discovery. Названия, методы входа и модели обоих discovery endpoints поступают из одного native snapshot; Gateway пересекает его с configured profile/model admission и текущим bearer. Legacy SDK identity exports остаются совместимостью исторических записей. Закреплённый deployment tuple выполняет функцию допуска и не является вторым источником account plan либо model catalogue.

Capabilities читаются ограниченно и привязываются к проверенному native build/configuration. Отсутствие или ошибка source не превращается в успешный пустой каталог и не запускает независимый static fallback. Существующий v1-метод сохраняет явные ошибки 401/403/404; [имеющийся тест](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/tests/provider-connections-sdk.test.mts#L149-L179) запрещает скрытую подмену failed discovery старым путём. Runtime ветки v2 → v1 нет: неизвестный endpoint старого facade не имеет достоверного unsupported сигнала. Следовать coordinated rollout producer-first и контрактной ошибке discovery.

### B3. AccountInfo как безопасный read port

Normative versioning берётся из contracts: closed v2 уже содержит весь выбранный method union в M1; неизвестные поля/kinds дают invalid_response. Upgrade producer предшествует новому consumer, runtime fallback/probing отсутствует. Gateway-maintainers владеют временной v1 projection и её удалением после consumer/rollback inventory. Не расширять legacy Operation.oauthMethod: импорт сохраняет старый readback envelope без этого optional browser/device поля.

Создан [account-info-port.ts](https://github.com/agent-teams-ai/account-gateway/blob/f2690a3c9cfd0cf61bfb7ca31b802d249105d751/services/account-gateway/src/account-info-port.ts): `AccountInfoSource`, `AccountInfoAuthority` и bounded `AccountInfoReader`. `NativeAccountInfoClient` в `native-client-discovery.ts` реализует source и обращается к `/private/native/v1/account-info/read`. Private `principalVersion` проверяется и удаляется в adapter; generation остаётся только для сверки с текущей mapping. Application не получает native admin Account или credentials map.

Порядок чтения фиксирован: проверить consumer/owner/profile grant; разрешить текущую logical-to-physical identity; получить ограниченный native snapshot; повторно проверить owner grant, generation и authorization epoch; проверить соответствие snapshot выбранному аккаунту. Время наблюдения и неизвестные значения сохраняются согласно каноническому DTO. Provider facts не записываются как новый account state Gateway и не используются для смены lifecycle или выдачи model eligibility.

Private callback `/private/native/v1/account-info-authority` повторно использует `accountLimitsTarget()` и общий owner/profile/bearer predicate в `NativeAuthority`. Явный purpose `info` не наследует quota-only eligibility. Это даёт чтение сведений для разрешённых metadata-only профилей без второго identity resolver и без расширения лимитных возможностей. Native внутри своей read boundary проверяет current birth, principal и credential version до и после чтения.

Batch-запрос ограничивается каноническими лимитами. Каждая выбранная запись проходит owner/epoch проверку; отсутствие прав не маскируется под backend outage. Недоступность разрешённого native наблюдения возвращает предусмотренное контрактом состояние без удаления аккаунта из списка. Не выполняются provider login, quota refresh или inference ради обычного чтения карточки. Новый read route добавляется в [bounded control/read route classifiers](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/services/account-gateway/src/service-admission.ts#L261-L288), чтобы сохранить текущий бюджет управляющих sockets.

Публичный `POST /v1/account-info/read` выполняет одну `kernel.accountInfoIdentities()` observation до native чтений и одну для **всего batch** после самого медленного ответа. PostgreSQL использует set-based identity read с `statement_timeout=400ms`; проверка отзыва bearer повторяется после await и перед отправкой. Изменившиеся grants/owner/profile/state/generation/revision/epoch отклоняют batch; быстрый ответ не может пережить отзыв прав во время медленного соседнего чтения. Отдельный opaque `infoRevision` переносит native snapshot revision и не подменяет `metadataRevision`/`authorizationEpoch` Gateway. Нативные email/plan/expiry не записываются в Gateway SQL.

Реализованы bounds из contracts: 1–50 уникальных refs, request до 16 KiB, info до 8 KiB и response до 512 KiB. Новому SDK method задан собственный response ceiling при сохранении старых defaults остальных методов. Бюджет чтения — 2500ms, source stage — до 2000ms, оставшееся время принадлежит финальному fence. На consumer/owner допускаются два одновременных native reads, включая соседние batches; общий admission и AbortSignal остаются существующими механизмами. Unicode ограничения считают code points, а общий serialized byte bound проверяется отдельно. [M1 tests](https://github.com/agent-teams-ai/account-gateway/blob/f2690a3c9cfd0cf61bfb7ca31b802d249105d751/services/account-gateway/test/account-info.test.ts) проверяют изменение authority, timeout и ограничение конкурентности; реальный PG lock/deadline regression проверяет возврат соединения после timeout.

### B4. Импорт через существующую operation authority

Ввод RT и полного обычного OAuth JSON — новый намеренный write-only путь. Исторический OAuth credential union в SDK не является готовой реализацией: [facade](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/services/account-gateway/src/facade.ts#L1867-L1897) и [регрессионный тест](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/services/account-gateway/test/oauth-enrollment-postgres.test.ts#L3048-L3110) прямо отвергают raw OAuth через старый create.

Существующие `connect()` и `reconnect()` принимают `credential: { kind: "credential_import", method: "refresh_token" | "oauth_auth_json", value }` через прежние account mutation routes. Отдельной public import session или operation type нет. Gateway проверяет closed input, Unicode и decoded UTF-8 размер до 65 536 bytes. Provider-specific разбор JSON, извлечение RT, identity verification и refresh policy выполняет native. `NativeOAuthEnrollmentClient.importCredential()` лишь отображает `oauth_auth_json` в private `auth_json` и передаёт opaque value на `/private/native/v1/oauth/connect/import`.

Импорт использует existing `beginAccount`, intent digest, candidate journal, descriptor qualification, acknowledgement и cleanup. Private optional `credentialImportMethod` сохраняется в существующем intent JSON; новый method-aware HMAC суффикс включается только для импортов и сохраняет прежние digest bytes legacy операций. Способ и payload нельзя подменить повторным запросом с тем же operationId. `Operation.oauthMethod` по-прежнему содержит только browser/device и отсутствует в import readback. Новая SQL таблица или отдельная схема sessions в Gateway не добавлена.

Секрет передаётся только конкретному backend adapter. Новая постоянная копия credential material в Gateway не создаётся. Существующая API-key transient custody не переписывается. Native durable import receipt и момент принятия credential material определяет [native state machine](native-account-sub2api.md); Gateway отображает этот результат в свой уже существующий operation lifecycle, не создавая независимую таблицу sessions.

После ambiguous submit допускается только чтение исходного receipt/operation. Потерянный ACK, restart worker и неготовая qualification не дают права повторно обменять RT, создать новую native запись или объявить операцию успешной. Readback, generation fencing, suspend/resume и retirement должны работать для импортированного подключения так же, как для существующего способа, с сохранением различий native refresh semantics.

Сохранить существующее различие native unknown и терминального Gateway unknown: `account-management.ts` возвращает terminal unknown и не даёт другому worker takeover живого creating candidate. Exact поздний native receipt завершает только ещё live/pending исходный Gateway candidate с действующей authority; после terminal unknown он служит cleanup/recovery evidence, не `unknown → applied`. Crash между Gateway journal и подтверждённым native acceptance не обещает автоматического успеха и не оправдывает второе credential storage. Эти phase boundaries входят в import integration tests.

При reconnect другого provider principal старые email/plan/model/quota snapshots не переносятся. Новое поколение и authorization epoch отделяют наблюдения и выполняющиеся операции прежнего подключения. Обнаруженный email не заменяет ownerRef и не склеивает аккаунты разных consumers.

### B5. Заменяемый adapter без общего Provider framework

Существующие ports сохранены; добавлены только `AccountInfoSource`/authority read, `ProviderConnectionSource` и `CredentialImportNative.importCredential()`. Concrete adapters выбирает `service-assembly.ts`; существующий `composeServiceCachedLimits()` передаёт общую read composition и обычному facade, и joined callers. Отдельного интерфейса, объединяющего inference, OAuth, usage, storage и product policy, нет.

Selected import подключён как optional port в существующих OAuth enrollment options. Только composition для qualified Codex предоставляет этот port; facade дополнительно сверяет native per-method `create`/`reconnect` capability. Другой backend может реализовать те же выбранные ports без импорта Sub2API DTO. Эта граница проверяется независимыми source fixtures; второй production backend не создаётся.

Прежний `oauthProfileDefinition()` остаётся доверенной политикой уже поддержанных browser/device профилей. В частности, существующее исключение Claude при operation readback управляет `allowRefresh`, а не условием активации. Эта волна не рефакторит все прежние OAuth branches в универсальный framework. Authorization URL origin/client/scope validators и callback parsers сохраняют прежнюю семантику; public DTO и application ports не получают private native paths.

### B6. Карта изменений и параллельная работа

| Участок | Файлы/граница | Результат |
| --- | --- | --- |
| SDK | `features/facade-client/contracts/`, `http/clients.ts`, `http/ingress.ts`, curated indexes | Safe AccountInfo/capabilities и write-only import без browser secrets. |
| Generic management | `management.ts`, `account-management.ts`, `domain.ts`, `intent-secrets.ts`, `postgres-records.ts` | Один lifecycle, optional import port и method-bound intent без секретной SQL копии. |
| Read projection | `account-info-port.ts`, `postgres.ts:accountInfoIdentities` | Bounded batch authorizations и общий финальный generation/epoch fence. |
| Sub2API adapter | `native-client-discovery.ts`, `native-client-oauth.ts`, существующий control transport/codec | Проверка proof, удаление private полей и однократный opaque import. |
| HTTP authority | `facade.ts`, `native-authority.ts`, `service-admission.ts` | Additive routes, полная owner isolation и bounded ingress/readback. |
| Composition/policy | `service-assembly.ts`, profile policy, source-dependency manifest | Один выбор concrete adapters и проверяемые зависимости. |

После фиксации [контрактов](native-account-contracts.md) SDK/read projection и native import adapter можно разрабатывать параллельно на согласованных fixtures. `management.ts`, `account-management.ts`, `facade.ts` и public indexes получают одного интеграционного владельца; параллельные исполнители передают ему узкие patches, а не независимо редактируют центральные файлы. Native и Review Router работают по тем же контрактам, не заводят собственные копии schemas.

### B7. Get Modular и Foundation

Сохраняются Core/Assembly 0.2.0, TypeScript 7.0.2 и существующий management factory. Он уже возвращает `createManagementClient()`, поэтому новые клиентские методы не требуют новой composition capability, graph node или dependency upgrade.

Текущий [CMS adoption manifest](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/architecture/consumer-module-adoption.json) имеет статус pending. Эта работа не объявляет его adopted. SDK остаётся в принятом FMS v1 scope с двумя features `facade-client` и `llm`; private service не получает фиктивную repository-wide conformance. [FMS v1](https://github.com/agent-teams-ai/.github/blob/eef92e7fd40f538b4e9ba03e01bbd4e2d23f12f2/docs/architecture/feature-module-standard/v1.md) допускает typed factories и consumer-owned replaceable ports без динамического plugin framework и без доменного aggregate у интеграционного SDK.

Foundation policy дополнена точными границами `account-info`/`account-info-tests`, включением `provider-connection-capabilities.ts` в существующий facade boundary и нужными направленными зависимостями native adapter/composition. Pure projection не получает HTTP/SQL imports, generic lifecycle не импортирует concrete backend, `/contracts` не получает secret ingress, consumer не делает deep import SDK. Общих разрешений «импортировать всё» и второго import parser нет. Проверяемый механизм — [source-dependencies.yaml](https://github.com/agent-teams-ai/account-gateway/blob/f2690a3c9cfd0cf61bfb7ca31b802d249105d751/architecture/foundation/source-dependencies.yaml).

Различать scope разных механизмов: `architecture/foundation/source-dependencies.yaml` уже имеет governed roots SDK, private service и service tests; его существующие named boundaries расширяются точечно. Это не означает, что private service принят в SDK-only FMS или pending CMS. Отчёт указывает фактически проверенный механизм и пути, без общего «весь repo соответствует стандартам».

### B8. Definition of Done и выпуск

Готовность пакета означает одновременно:

1. Старый packed SDK декодирует v1 capabilities и legacy account/operation ответы нового сервиса.
2. Новый packed SDK читает v2 с Gemini и selected import descriptors; unavailable/error не выдаются за доступную возможность.
3. AccountInfo проходит owner isolation и проверку смены generation/epoch во время backend await; сбой metadata не изменяет lifecycle.
4. Selected import проходит submit, same-operation reconciliation, restart/ambiguous ACK и cleanup через настоящие facade/kernel boundaries.
5. Независимый fixture backend реализует выбранные ports без импорта Sub2API DTO/client; те же contract cases проходят через concrete native adapter.
6. Browser-safe contracts, trace/errors/readback не содержат credential sentinels; execution client не получает management authority.
7. Пакет проверен через existing exact-archive NodeNext и ESNext/Bundler consumers, Foundation/topology и затронутые integration gates.

Conformance fixture не считается live provider E2E или готовым вторым production backend. Реальная квалификация выполняется по отдельному [плану проверок](native-account-qualification.md); queued/skipped не являются PASS.

Порядок rollout: native producer с новым контрактом → совместимый Gateway → новый SDK archive с provenance → consumer integration → включение выбранных возможностей. Старые endpoints сохраняются на всём переходе. При rollback выключается новая capability, а receipts и cleanup уже принятых операций остаются обслуживаемыми. Обновление только UI или только SDK не включает native возможность.

Изменения публикуются bounded commits в Draft PR с зафиксированными source pins и evidence. Gateway package/kernel CI и локальные проверки не подменяют оставшуюся joined квалификацию текущих native/Gateway/RR источников. Публичная публикация SDK и production rollout не подменяются успешной упаковкой private archive. Эта работа не выполняет production deploy.

### Оценка этого пакета

Единый бюджет B/M1 и B/M2 указан в [основном плане, §9](native-account-integration-plan.md). B включает Gateway intent persistence, existing kernel integration, adapter, public SDK и bounded authority. Native parser/MAC/FSM/SQL учитываются только A; provider codecs — D; UI — C. Exact-archive/conformance/Foundation rejecting fixture code относится к tests/verification, не прибавляется второй раз как production architecture. Первоначальная локальная таблица заменена ссылкой после R9.

## Examples

Другой продукт создаёт server-side management client с собственными origin и credential, передаёт свой opaque ownerRef и читает тот же AccountInfo. Его пользовательские роли не входят в библиотеку. Замена Sub2API в тестовом стенде меняет только composition выбранных backend ports; consumer requests и account-operation правила остаются теми же.

Старый consumer получает v1 capabilities существующего Codex browser/device flow. Новый consumer получает из того же canonical snapshot дополнительные выбранные import methods и Gemini API-key profile через v2. Ни один consumer не вычисляет реальный тариф по profile label и не хранит собственный график refresh. Сведения об аккаунте поступают из безопасного native snapshot с сохранённым происхождением и свежестью.
