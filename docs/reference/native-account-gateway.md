---
id: docs.reference.native-account-gateway
type: reference
status: proposed
owner: gateway-maintainers
summary: Узкие backend ports, SDK, авторизация и существующие операции подключения без нового управляющего слоя.
---

# Пакет B: переиспользуемый Account Gateway

## Overview

Этот пакет расширяет существующие библиотеку и сервис Account Gateway для безопасного чтения сведений об аккаунте и приоритетных способов подключения. Его результат — один переиспользуемый SDK и заменяемые серверные адаптеры для выбранных операций. Потребитель получает понятный контракт, а Sub2API остаётся владельцем сведений провайдера, его протокола и credential lifecycle.

Документ является планом реализации. Он не утверждает, что новые endpoints уже работают или прошли live E2E. Общая последовательность находится в [главном плане](native-account-integration-plan.md), единственная спецификация публичных DTO и инвариантов — в [контрактах](native-account-contracts.md). Native persistence и переходы подключения описаны в [пакете Sub2API](native-account-sub2api.md); состав приоритетных профилей — в [матрице провайдеров](native-account-provider-profiles.md). Проверки и критерии выпуска принадлежат [пакету квалификации](native-account-qualification.md).

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

### B1. Расширить существующий SDK

Новые безопасные схемы разместить внутри `features/facade-client/contracts/` и реэкспортировать через существующие public indexes. Write-only импорт находится в `features/facade-client/http/ingress.ts` и `/http`; его секретные поля не экспортируются через browser-safe readback contract. Клиентские методы добавляются в существующий management client. Consumer-control получает только те account-read возможности, которые явно допускает канонический контракт; execution client не приобретает управление аккаунтами.

Строгие legacy `Account`, `Operation` и browser/device envelopes не расширяются неизвестными старому клиенту полями. AccountInfo передаётся отдельной проекцией. Это необходимо, потому что [текущий Account](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/packages/account-gateway/src/features/facade-client/contracts/index.ts#L86-L94) содержит только refs, profile, displayName, state и revisions; [facade projection](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/services/account-gateway/src/facade-wire.ts#L50-L73) возвращает ровно этот набор.

Все методы SDK сохраняют нынешнее поведение транспорта: bounded request/response, AbortSignal и отсутствие автоматического повторения мутаций. Сбой после отправки допускает чтение той же operation identity. Новый operationId не используется как способ обойти неоднозначный результат.

### B2. Один источник capabilities, две совместимые проекции

Добавить `GET /v2/provider-connection-capabilities` с контрактом `provider-connections/v2` и метод `getProviderConnectionCapabilitiesV2()` на существующих разрешённых clients. `/v1/provider-connection-capabilities` и его schema остаются прежними. Это версия discovery, а не замена browser OAuth API.

Причина конкретна: [v1 schema](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/packages/account-gateway/src/features/facade-client/contracts/index.ts#L805-L977) имеет закрытый provider enum без Gemini, три auth methods и strict objects. Простое добавление Gemini или import в старый ответ ломает декодирование всей коллекции у старого SDK.

Оба endpoints строятся из одного канонического native-derived snapshot после пересечения с разрешёнными deployment profiles и текущим bearer. Snapshot содержит фактически зарегистрированные native management/inference возможности, а не перечень всех кнопок административного frontend Sub2API. Gateway не получает право включить способ входа только из-за появления строки в native platform catalog.

V1 является чистой compatibility projection: сохраняет представимые старой схемой поля и способы, удаляет import methods, пропускает Gemini и другие непредставимые записи, после чего проверяет результат неизменённым v1 decoder. Пустой набор совместимых методов исключает запись целиком. Нельзя переименовать Gemini в OpenAI ради прохождения старого enum. V2 использует ограниченные identifiers и закрытый набор method descriptors из канонического контракта; произвольные схемы форм и исполняемые правила не передаются.

`provider-connections.ts` не должен остаться второй редактируемой базой provider facts. Его новая роль — Gateway policy: разрешённые profile IDs, qualification references и локальные ограничения допуска. Фактические auth methods, описание backend-supported способов и сведения аккаунта поступают от native. Неизменённые legacy SDK identity exports допускаются как совместимость исторических записей; новые operational данные не копируются в них вручную. Существующая проверка закреплённого deployment tuple сохраняет функцию допуска, а не объявляется альтернативным каталогом моделей или тарифов.

Capabilities читаются ограниченно и привязываются к проверенному native build/configuration. Отсутствие или ошибка source не превращается в успешный пустой каталог и не запускает независимый static fallback. Существующий v1-метод сохраняет явные ошибки 401/403/404; [имеющийся тест](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/tests/provider-connections-sdk.test.mts#L149-L179) запрещает скрытую подмену failed discovery старым путём. Runtime ветки v2 → v1 нет: неизвестный endpoint старого facade не имеет достоверного unsupported сигнала. Следовать coordinated rollout producer-first и контрактной ошибке discovery.

### B3. AccountInfo как безопасный read port

Normative versioning берётся из contracts: closed v2 уже содержит весь выбранный method union в M1; неизвестные поля/kinds дают invalid_response. Upgrade producer предшествует новому consumer, runtime fallback/probing отсутствует. Gateway-maintainers владеют временной v1 projection и её удалением после consumer/rollback inventory. Не расширять legacy Operation.oauthMethod: импорт сохраняет старый readback envelope без этого optional browser/device поля.

Создать небольшой AccountInfo source port и orchestration по образцу существующих [limits](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/services/account-gateway/src/limits-port.ts) и [models](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/services/account-gateway/src/models-port.ts). Конкретный native HTTP client реализует port; application не получает native admin Account или credentials map.

Порядок чтения фиксирован: проверить consumer/owner/profile grant; разрешить текущую logical-to-physical identity; получить ограниченный native snapshot; повторно проверить owner grant, generation и authorization epoch; проверить соответствие snapshot выбранному аккаунту. Время наблюдения и неизвестные значения сохраняются согласно каноническому DTO. Provider facts не записываются как новый account state Gateway и не используются для смены lifecycle или выдачи model eligibility.

Использовать существующий `accountLimitsTarget()` как исходный identity resolver, сохранив его проверки состояния и поколения. Однако нельзя копировать целиком quota-specific admission. [NativeAuthority](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/services/account-gateway/src/native-authority.ts#L410-L430) сейчас отвергает profile без limits/model capability. AccountInfo получает собственную capability-проверку, иначе metadata-only аккаунты окажутся недоступны без основания.

Batch-запрос ограничивается каноническими лимитами. Каждая выбранная запись проходит owner/epoch проверку; отсутствие прав не маскируется под backend outage. Недоступность разрешённого native наблюдения возвращает предусмотренное контрактом состояние без удаления аккаунта из списка. Не выполняются provider login, quota refresh или inference ради обычного чтения карточки. Новый read route добавляется в [bounded control/read route classifiers](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/services/account-gateway/src/service-admission.ts#L261-L288), чтобы сохранить текущий бюджет управляющих sockets.

Непосредственно перед сериализацией всего batch выполнить одну финальную authority observation всех выдаваемых refs: pre/post проверки быстрой строки недостаточны, пока другой native read ждёт. Изменившиеся grants/owner/generation/epoch подавляют facts. Test на facade задерживает вторую строку и отзывает первую. Отдельный opaque infoRevision переносит native snapshot revision и не подменяет metadataRevision/authorizationEpoch Gateway.

Использовать read/deadline/response bounds из contracts. Новый SDK method имеет собственный 512 KiB response ceiling при сохранении старого transport default остальных методов. Не выполнять Promise.all по 50 backend calls: native reads проходят ограниченный owner fan-out и existing global admission; cancellation и final fence входят в общий budget. Max-bound packed SDK fixture и slow-50-ref load case проверяют это поведение.

### B4. Импорт через существующую operation authority

Ввод RT и полного обычного OAuth JSON — новый намеренный write-only путь. Исторический OAuth credential union в SDK не является готовой реализацией: [facade](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/services/account-gateway/src/facade.ts#L1867-L1897) и [регрессионный тест](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/services/account-gateway/test/oauth-enrollment-postgres.test.ts#L3048-L3110) прямо отвергают raw OAuth через старый create.

Gateway принимает только выбранный closed input kind и проверяет общие размеры/кодировку/структуру. Provider-specific извлечение токенов, identity и refresh policy выполняет native. Gateway не разбирает JWT ради получения email или тарифа и не преобразует произвольный файл в универсальный OAuth bundle.

Новый импорт использует existing `beginAccount`, intent digest, candidate journal, descriptor qualification, acknowledgement и cleanup. Method identity связывается с исходным intent и секретным вводом; способ и payload нельзя подменить повторным запросом с тем же operationId. Если нужны новые persisted metadata поля, они добавляются к существующим записям; старые строки получают явно определённое legacy значение, а не вывод из текущего UI.

Секрет передаётся только конкретному backend adapter. Новая постоянная копия credential material в Gateway не создаётся. Существующая API-key transient custody не переписывается. Native durable import receipt и момент принятия credential material определяет [native state machine](native-account-sub2api.md); Gateway отображает этот результат в свой уже существующий operation lifecycle, не создавая независимую таблицу sessions.

После ambiguous submit допускается только чтение исходного receipt/operation. Потерянный ACK, restart worker и неготовая qualification не дают права повторно обменять RT, создать новую native запись или объявить операцию успешной. Readback, generation fencing, suspend/resume и retirement должны работать для импортированного подключения так же, как для существующего способа, с сохранением различий native refresh semantics.

Сохранить существующее различие native unknown и терминального Gateway unknown: `account-management.ts` возвращает terminal unknown и не даёт другому worker takeover живого creating candidate. Exact поздний native receipt завершает только ещё live/pending исходный Gateway candidate с действующей authority; после terminal unknown он служит cleanup/recovery evidence, не `unknown → applied`. Crash между Gateway journal и подтверждённым native acceptance не обещает автоматического успеха и не оправдывает второе credential storage. Эти phase boundaries входят в import integration tests.

При reconnect другого provider principal старые email/plan/model/quota snapshots не переносятся. Новое поколение и authorization epoch отделяют наблюдения и выполняющиеся операции прежнего подключения. Обнаруженный email не заменяет ownerRef и не склеивает аккаунты разных consumers.

### B5. Заменяемый adapter без общего Provider framework

Сохранить существующие узкие ports и добавить только AccountInfo, capability read и selected import. Concrete adapter выбирает `service-assembly.ts`. Не нужен интерфейс, объединяющий все inference, OAuth, usage, storage и product policy методы.

В затрагиваемых generic management flows заменить прямые provider-family проверки маленькой trusted per-profile policy в existing enrollment options: поддержка device code, вид completion, разрешение refresh при operation readback и допустимые cleanup anchors. Политика создаётся один раз конкретным adapter/composition из проверенной конфигурации. Private native paths и refresh endpoints не переходят в application или public DTO.

Существующее исключение Claude на [строке 1109](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/services/account-gateway/src/account-management.ts#L1096-L1111) управляет `allowRefresh` при readback; его нельзя превратить в правило активации. Эта точечная инъекция не требует общего рефакторинга всех OAuth веток. Старые authorization URL origin/client/scope validators и callback parsers остаются неизменными: выбранная волна не добавляет browser provider, а замена backend для того же провайдера не меняет публичную семантику входа.

### B6. Карта изменений и параллельная работа

| Участок | Файлы/граница | Результат |
| --- | --- | --- |
| SDK | `features/facade-client/contracts/`, `http/clients.ts`, `http/ingress.ts`, curated indexes | Safe AccountInfo/capabilities и write-only import без browser secrets. |
| Generic management | `management.ts`, `account-management.ts`, существующие intent/record helpers | Один lifecycle, сохранённая idempotency и узкая policy injection. |
| Read projection | Новый `account-info-port.ts`, существующий identity resolver | Авторизация и generation fences вокруг native чтения. |
| Sub2API adapter | Native control clients и codec | Единственное место перевода private native wire. |
| HTTP authority | `facade.ts`, `native-authority.ts`, `service-admission.ts` | Additive routes, полная owner isolation и bounded ingress/readback. |
| Composition/policy | `service-assembly.ts`, profile policy, source-dependency manifest | Один выбор concrete adapters и проверяемые зависимости. |

После фиксации [контрактов](native-account-contracts.md) SDK/read projection и native import adapter можно разрабатывать параллельно на согласованных fixtures. `management.ts`, `account-management.ts`, `facade.ts` и public indexes получают одного интеграционного владельца; параллельные исполнители передают ему узкие patches, а не независимо редактируют центральные файлы. Native и Review Router работают по тем же контрактам, не заводят собственные копии schemas.

### B7. Get Modular и Foundation

Сохраняются Core/Assembly 0.2.0, TypeScript 7.0.2 и существующий management factory. Он уже возвращает `createManagementClient()`, поэтому новые клиентские методы не требуют новой composition capability, graph node или dependency upgrade.

Текущий [CMS adoption manifest](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/architecture/consumer-module-adoption.json) имеет статус pending. Эта работа не объявляет его adopted. SDK остаётся в принятом FMS v1 scope с двумя features `facade-client` и `llm`; private service не получает фиктивную repository-wide conformance. [FMS v1](https://github.com/agent-teams-ai/.github/blob/eef92e7fd40f538b4e9ba03e01bbd4e2d23f12f2/docs/architecture/feature-module-standard/v1.md) допускает typed factories и consumer-owned replaceable ports без динамического plugin framework и без доменного aggregate у интеграционного SDK.

Foundation policy дополняется точными путями новых файлов/entrypoints. Pure projection не получает HTTP/SQL imports, generic lifecycle не импортирует concrete backend, `/contracts` не получает secret ingress, consumer не делает deep import SDK. Не расширять общие allowlists и не вводить второй import parser. Существующие negative fixtures должны продолжить отвергать type-only bypass и cross-boundary dependencies.

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

Плановый PR содержит документацию. При будущей реализации изменения выпускаются отдельными bounded Draft PR с зафиксированными source pins и evidence. Публичная публикация SDK и production rollout не подменяются успешной упаковкой private archive.

### Оценка этого пакета

Единый бюджет B/M1 и B/M2 указан в [основном плане, §9](native-account-integration-plan.md). B включает Gateway intent persistence, existing kernel integration, adapter, public SDK и bounded authority. Native parser/MAC/FSM/SQL учитываются только A; provider codecs — D; UI — C. Exact-archive/conformance/Foundation rejecting fixture code относится к tests/verification, не прибавляется второй раз как production architecture. Первоначальная локальная таблица заменена ссылкой после R9.

## Examples

Другой продукт создаёт server-side management client с собственными origin и credential, передаёт свой opaque ownerRef и читает тот же AccountInfo. Его пользовательские роли не входят в библиотеку. Замена Sub2API в тестовом стенде меняет только composition выбранных backend ports; consumer requests и account-operation правила остаются теми же.

Старый consumer получает v1 capabilities существующего Codex browser/device flow. Новый consumer получает из того же canonical snapshot дополнительные выбранные import methods и Gemini API-key profile через v2. Ни один consumer не вычисляет реальный тариф по profile label и не хранит собственный график refresh. Сведения об аккаунте поступают из безопасного native snapshot с сохранённым происхождением и свежестью.
