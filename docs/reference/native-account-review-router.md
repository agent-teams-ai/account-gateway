---
id: docs.reference.native-account-review-router
type: reference
status: proposed
owner: gateway-maintainers
summary: Потребление SDK, видимость метаданных, формы подключения и модульная интеграция Review Router.
---

# Пакет C: Review Router и общий интерфейс аккаунтов

## Overview

Этот пакет добавляет в Review Router сведения о подключённом аккаунте и приоритетные способы входа через публичный SDK Account Gateway. Sub2API остаётся владельцем исходных фактов и протоколов провайдеров; Gateway предоставляет заменяемую границу backend; RR отвечает за права пользователя, подключение к workspace, выбор для ревью и отображение. RR не обращается в административный API Sub2API и не повторяет его обработчики OAuth, разбор токенов, определения тарифа или проверки доступности.

M1 и выбранная M2 реализованы в [RR PR #914](https://github.com/777genius/review-router-ai/pull/914). Текущая точка интеграции — `43e475d455e2931b39adef2652c5b8fe921c693e`, SDK собран из Gateway `f2690a3c9cfd0cf61bfb7ca31b802d249105d751`. Этот commit добавляет SQL budget, catalogue-independent recovery и последние исправления ревью; его CI учитывается отдельно. На предыдущем `f9e5055c` browser, C1 и P115 завершены успешно. Source identity была согласована в `d4d39a2b`: штатные generators дали одинаковые bytes в двух fresh запусках, 29 identity/stale-qualification cases прошли. Historical NVIDIA receipt и bundler behavior сохранены. Это реализация и синтетическая квалификация, не production release. Историческая planning база — RR `f1cde67`; ссылки на планы 76/77/79 остаются историческими.

Общие схемы, версии, состояния импорта, ограничения payload и инварианты определены в [каноническом контракте](native-account-contracts.md). Этот документ их использует и не вводит конкурирующие определения. Зависимости и порядок выпуска описаны в [основном плане](native-account-integration-plan.md), нативная сторона — в [пакете A](native-account-sub2api.md), SDK и backend-абстракция — в [пакете B](native-account-gateway.md), новые профили — в [пакете D](native-account-provider-profiles.md), сквозные доказательства — в [квалификации](native-account-qualification.md).

### Результат для пользователя

В общих списках подключений появляются подтверждённые email, тариф и предусмотренные контрактом дополнительные сведения, когда backend их действительно предоставляет и пользователь вправе их видеть. Имя подключения остаётся пользовательским именем. Отсутствие email или тарифа само по себе не делает рабочее подключение непригодным для ревью.

Для Codex добавляются ввод refresh token и импорт полного `auth.json`, а также полноценный повторный вход личного подключения. Официальные API Anthropic и Gemini используют общую форму ключа после появления квалифицированных профилей. Существующие browser/device потоки и существующие ключевые подключения продолжают работать. Новые API-профили становятся доступными для выбора в ревью только после отдельной проверки совместимости с реальным runner.

## Contract

### 1. Ответственность и ограничение объёма

| Ответственность | Владелец | Что получает RR |
| --- | --- | --- |
| Обмен RT, чтение native identity, тариф и его происхождение | Sub2API | Безопасные факты через Gateway |
| Формат публичного `AccountInfo`, capabilities, импорт, смена поколения | Gateway | Версионированный SDK и проверенные результаты операций |
| Членство, владелец подключения, локальная привязка и её ревизия | RR | Живая авторизация перед выдачей фактов |
| Рендеринг имени, email, тарифа и состояния чтения | Общий UI RR | Одна модель результата и один компонент identity |
| Пригодность модели для реального ревью | Сквозная квалификация | Явное разрешение конкретной комбинации профиля и runtime |

Не добавляются новая таблица метаданных, копия credential storage, собственный provider registry или универсальный движок форм. Hosted pool, GitHub rotating credentials и централизованный Claude subscription OAuth не объединяются с этим потоком. Действующая защита от центрального подключения Claude OAuth сохраняется; API key Anthropic — отдельный профиль. Gemini API key также не означает импорт сессии Gemini CLI.

### 2. Один модуль чтения, точное принятие стандартов

Реализован узкий срез `packages/features/provider-accounts/src/account-metadata`: `application/ports/account-metadata.ts`, `account-metadata-reader.ts`, `application/use-cases/read-account-metadata.ts`. Одна операция readMetadata и borrowed reader составлены через contracts/declarations/module/group/root в composition. Нового Account aggregate, пустого domain и модулей на каждого provider нет.

Для среза зафиксированы собственный scoped profile и ADR-035 на уже принятых стандартах. History scope автоматически не расширяется. Core/Assembly остаются0.7.0, conformance0.5.0; Foundation — development tool. [Профиль нового среза][rr-profile].

| Стандарт | Зафиксированная версия |
| --- | --- |
| CMS и Module Authoring | `agent-teams-ai/get-modular@7a7c4c54add9ccc06509423d7b89bcfc037227b1` |
| CMS, SHA-256 полного документа | `3c5814ebf1ab1bd17688e49955aa0baa2ee91dd3a369adcea4d38aaccd53ba86` |
| Module Authoring, SHA-256 | `9bdbc6a6eac511691cf429c7e7e12b4cf4fd86ec16a348fb3af7a46c989af144` |
| FMS v1.1 | `agent-teams-ai/.github@f5653f5630057524a4ee44e50c16e138442a9b42`, SHA-256 `cfa088ef7396139554fe5e3bcc839271b23299c6b60c569a3a7f1cd7c9f0bc6c` |
| Engineering Quality Standard | `agent-teams-ai/.github@c8f3e7ba220241f79292c84c72712653019aa1df` |

Фактический профиль — `architecture/account-metadata/consumer-module-profile.json`, решение — `ai-docs/decisions/035-native-account-metadata.md`. Foundation в `architecture/foundation/provider-seams.yaml` охватывает account-metadata.application/.composition/.authorization/.tests. Host service и SDK reader проверяет existing TypeScript AST checker `scripts/check-architecture-boundaries.mjs`: exact public/type/re-exports/dynamic imports и direct fetch. В его tests шесть fixtures: одна положительная, пять отвергаемых. Foundation schema v1 сама не доказывает exact runtime export внутри mixed runtime/test package. Runtime не объявлен development, весь Web/lifecycle не переведён на новый scope.

Композиция следует [CMS][cms] и [Module Authoring][authoring]: descriptor в `composition/account-metadata.contracts.ts`, отдельные declaration через `declareModule`, тонкий module через `implement`, group и один root. Заимствованный reader передаётся как объявленный input. Нет собственного сетевого клиента в домене, polling-процесса, lifecycle manager или второго способа сборки. Host вызывает полученную `readMetadata` API. Не повторять частичный подход limits, где Web после сборки извлекает `.reader`, а затем вызывает use case напрямую. Переписывать ради этого весь старый limits необязательно. [Текущая сборка limits][rr-limits-composition].

Доказательства нового scoped CMS используют уже установленный `@get-modular/conformance@0.5.0`: `checkModuleLayout` по реальным файлам, `checkWiring` с **независимым oracle** и wrong-root/wrong-binding mutant, isolate/smoke реального module/root. Spy-тест подтверждает, что `prepare/run` не вызывают SDK, authorization callback или SQL: эффект начинается только при `readMetadata`. Эти пути включены в `architecture:check`, `modular:qualify` и strict TS 7.0.2 project с `skipLibCheck: false`. Успешный тест injected reader отдельно от layout/wiring/passive construction не заменяет весь набор. Переиспользовать owning pattern `scripts/review-history-tooling/check.ts` и `review-history.root.test.ts`, без нового validation framework.

### 3. Минимальная модель без механических копий

[Engineering Standard][eqs] требует разделять модели там, где отличаются контракты, и запрещает бессодержательные слои маппинга. Одновременно FMS/CMS запрещают SDK/transport DTO внутри application/domain. Поэтому создать **один** транспортно-независимый результат чтения с необходимыми RR состояниями доступа и сведениями; SDK адаптер делает одну содержательную проекцию. Тот же результат используют `AccountView` и UI. Отдельные эквивалентные domain-, application-, transport- и component-типы не нужны. [Правила зависимости и моделирования][fms].

На внешней SDK/UI-границе допустимо повторно использовать публичный DTO, если семантика и права совпадают. Внутри нового use case SDK не импортируется даже через `import type`. Нельзя считать сужение TypeScript-типа удалением лишних полей при сериализации: browser boundary выдаёт только разрешённые сведения. RR не декодирует JWT для email, не вычисляет тариф по профилю и не интерпретирует raw native `extra`.

Состояние загрузки и opaque display token принадлежат RR. Значение факта, происхождение и время native observation принадлежат источнику. Время запроса RR не подменяет время наблюдения. Capability отсутствие, отсутствующий факт, временная недоступность и запрет просмотра отображаются раздельно, без утечки backend diagnostics.

### 4. Узкое извлечение живой авторизации

Общий host adapter `apps/web/src/server/account-metadata/authorization.ts` содержит Scope, Source, existing resolve SQL и equalScope/owned. Его используют account-metadata-service.ts и прежний account-limits-service.ts. SQL, tombstone proofs, source/binding resolution и limits refresh semantics сохранены. Дополнительного permission manager или policy DSL нет.

В limits остаются собственные статусы, refresh, namespace `account-limits-v1` и сериализация fingerprint. Его concurrency 4, трёхсекундный page deadline, 250 ms на необязательное refresh discovery и проверки перед explicit refresh не меняются. Для metadata задаётся отдельный ограниченный бюджет чтения; открытие списка не запускает provider refresh или health probe. В application поступает узкий callback живой авторизации с target и opaque token, без Prisma и session DTO.

Metadata использует единую read policy [contracts](native-account-contracts.md): группировка разрешённых refs по owner, ограниченные batches и общий page deadline с резервом final fence. Не переносить limits refresh-discovery 250 ms как новый provider запрос metadata. Несвоевременная или непроверенная metadata не задерживает всю страницу и не выдаётся из старого cache после смены viewer scope.

Фактическая page policy: до 200 unique connection IDs, batch 50 refs одного owner, concurrency 4; до 2,5 s на начальную authorization/SDK reads, общий deadline 3 s с final fence. AbortSignal передаётся SDK. Проверка прав и разрешение source rows выполняются в одной короткой Prisma transaction с прежними authorization predicates. Пул ожидается не более 250 ms; transaction-local `statement_timeout` и `lock_timeout` — не более 500 ms, с учётом оставшегося page budget и резерва на rollback. SDK/provider HTTP остаётся снаружи transaction. В application port передаётся только абсолютный deadline; SQL-настройки принадлежат host adapter. Shared resolver сохраняет прежние limits semantics, лимиты применяются только к metadata calls. При истечении бюджета приватные сведения не выдаются. Реальные PostgreSQL tests блокируют source и membership rows, проверяют server cancellation, повторное использование того же соединения и восстановление session settings.

| Наблюдатель | Identity/plan metadata | Поведение существующих limits |
| --- | --- | --- |
| Владелец личного подключения в личном разделе | Разрешено при актуальном источнике | Сохраняется |
| Тот же владелец в авторизованном workspace, через source ID или binding ID | Разрешено после действующего разрешения binding | Сохраняется |
| Owner/admin workspace для подключения этого workspace | Разрешено | Сохраняется |
| Обычный member workspace для чужого подключения | Не раскрывается | `restricted` |
| Получатель donor/operator подключения, включая admin получателя | Не раскрывается | `restricted` |
| Потерянное членство, снятая привязка, изменившийся epoch или источник | Результат не выдаётся | Действующая повторная проверка |
| Pending reconnect/delete | Предыдущие факты подавляются | Действующее подавление старого поколения |

Видимость уже разрешённого inventory не зависит от доступности optional metadata. Эта матрица не расширяет права на чужие email и тарифы. Применённое удаление учитывает все существующие erasure proofs. Владелец может видеть кешированные сведения suspended-источника, если источник всё ещё проходит установленные проверки.

Проверять authority перед и после Gateway await. Затем перед возвратом всей страницы выполнить **одну финальную проверку batch** для строк с приватными фактами: ранняя строка могла стать недоступной, пока поздняя ожидала deadline. Проверяются текущий scope, ownership, binding revision, pending operation, source identity и epoch. При ошибке проверки убрать только защищённые сведения, не возвращать старую identity. Существующие limits-тесты служат независимым regression oracle; их ожидания не генерируются новым resolver. [Проверки гонок и deadline][rr-limits-tests].

### 5. Все проекции и общий renderer

Расширить одну модель результата и общий `AccountIdentity`. Учесть четыре места восстановления `AccountView`:

| Путь в RR | Проекция |
| --- | --- |
| [account-gateway-accounts.ts][rr-workspace] в `apps/web/src/server` | Workspace `view` |
| [personal-canonical-accounts.ts][rr-personal] там же | Personal `project`, включая ветку disabled inventory |
| [accounts-overview.ts][rr-overview] там же | Обзор смешанных подключений |
| [gateway-model-account-options.ts][rr-model-detail] там же | Выбранное подключение и его detail |

Все четыре AccountView-проекции используют один metadata service. В dashboard-gateway-accounts.ts initial list и selected detail вызываются с includeMetadata:false; один enrichMetadata применяется к окончательному массиву, включая selected bindings вне страницы. Final authorization находится после всех await. Regression проверяет замену строк и отзыв прав ранней строки во время поздней hydration.

В identity показать пользовательское имя, native email и подтверждённый тариф; длинные значения переносить, выводить как текст. `connection.planLabel` сегодня происходит из каталога профилей и не является тарифом аккаунта: «Codex OAuth» не заменяет «Plus» или «Pro 200». Subscription end, token expiry, admin account expiry и quota reset не объединять в безымянное «Expires». Отсутствующее поле не заполнять догадкой. Общий компонент используется в личных, workspace и operation views; чужие строки получают уже отфильтрованную сервером модель. [Текущий renderer][rr-identity].

Рендерит `apps/web/app/dashboard/account-metadata-line.tsx` через AccountIdentity. SDK reader явно выбирает разрешённые поля; infoRevision/private proofs не сериализуются. Calendar date остаётся YYYY-MM-DD, instant показывается с UTC; Subscription ends и Credential expires различаются. Общее предупреждение stale охватывает privacy и не требует tooltip на touch UI. Pending lifecycle подавляет прежние facts в трёх списках; c3f605d добавляет обязательный нейтральный displayToken ко всем pending variants.

### 6. Capabilities и формы входа

Обновлены account-connection-catalog.ts, features/provider-setup/setup-provider.ts и features/account-gateway/connection-capabilities.ts. Единственная product map native-api-profiles.ts допускает exact anthropic-messages-apikey-v1 и gemini-openai-chat-apikey-v1; downstream protocol — openai-responses. Brand — Anthropic/Gemini, review engine — existing Codex. Provider HTTP/codecs/model catalog здесь не реализуются.

Production composition использует getProviderConnectionCapabilitiesV2(). Выполненный v2 read никогда не пробует v1 при400/404/denied/timeout. Discovery error остаётся ошибкой; missing descriptor успешного response закрывает новые choices. Явно composed v1-only consumer сохраняет legacy path, но это не runtime fallback нового reader. Rollout: native/Gateway v2 producer, затем exact SDK/RR.

Create/reconnect проверяются отдельно по методу и повторно server-side. create:false/reconnect:true сохраняет existing inventory/review catalog, убирая enrollment. Metadata не участвует в допуске. Imports ограничены exact Codex profile; произвольный advertised profile их не открывает.

AccountGatewayControls переиспользует OAuthForm, AccountForm и existing select/dialog/button primitives, existing submitGatewayApiKey transport. Небольшой credential-import-fields.tsx поддерживает RT text и auth.json text/file; API profiles используют общую key form. Новых HTTP routes и schema-driven form engine нет.

### 7. RT и полный Codex auth.json

RR передаёт bounded input SDK как выбранный тип импорта по каноническому контракту. Разбор credential-структуры и получение достоверной identity принадлежат native. Успех нельзя определять по существованию JSON-ключей или локальной JWT-декодировке.

Для обоих входов native **всегда выполняет fenced RT exchange**. Полный `auth.json` с истёкшими access/id tokens и пригодным refresh token не отклоняется только из-за этих сроков: native получает новые токены и проверяет principal по своему протоколу. И наоборот, свежий AT не разрешает пропустить RT exchange. AT-only, mobile RT, Agent Identity и PAT не появляются автоматически под видом «полного JSON»; их отдельные режимы вне этого пакета.

Raw credential не хранится в React state/persistence, query string, telemetry, RR journal или receipt. credential-import-fields.tsx использует uncontrolled textarea/file; input ограничен65536 UTF-8 bytes. RR не разбирает provider JSON/JWT. Existing connect/reconnect получают credential:{kind:'credential_import',method:'refresh_token'|'oauth_auth_json',value:string}; public Operation.oauthMethod сохраняет browser/device. DOM/FormData очищаются до await. Close/ownership/profile/method/file changes инвалидируют поздний file.text() по generation/file identity/isConnected. Reconcile использует исходную operation без replay secret.

### 8. Личный Codex reconnect

Recovery показывает исходную Gateway operation. Поздний native receipt не превращает terminal Gateway `unknown` в `applied`; точные live/pending и spent-authority границы заданы [contracts](native-account-contracts.md). UI не обещает успешный автоматический resume и не создаёт повторный import после этого состояния.

До method-bearing writer выпустить совместимый RR reader для `PersonalAccountOperation`: текущие normalizer/hash и browser-hardcoded dispatch/readback находятся в `personal-canonical-operation.ts` и `personal-canonical-accounts.ts`. Старые intent сохраняют прежнюю интерпретацию и hash; новый method связывается с versioned intent без массового переписывания старых rows. После первой записи новых методов установить minimum RR rollback version, умеющую их безопасно читать. Rolling-upgrade tests покрывают старые операции и новые RT/JSON/device reconnect records. Неизвестный/import method не приводится к browser; это не безобидный UI rollback.

Codex reconnect допускает только advertised reconnect methods. Browser/device проходят existing OAuth operations; RT/auth.json — существующий SDK reconnect credential variant. Nullable immutable credentialImportMethod добавлен migration000160 в PersonalAccountOperation. NULL означает отсутствие, discriminator включается в intent/hash только при наличии; старые hashes сохранены. Same nonce с иным method конфликтует; submitted/unknown читается по исходной operation. Workspace bindings не копируются, public Operation.oauthMethod не расширяется.

Перед началом проверяются владелец, source state и актуальная generation/epoch. Пока операция pending, старые факты не выдаются. После native подтверждения обновляется то же логическое подключение с установленными Gateway fences; существующие workspace bindings не заменяются копиями. Результат чтения receipt, повтор запроса и восстановление после перезапуска должны сходиться к одному результату. Новый principal нельзя молча признать прежним только по переданному email; требуемое поведение смены identity задаёт канонический контракт. Не объединять рабочие workspace и personal протоколы ради одинаковой формы.

Existing trusted workspace GET synchronization заполняет authorizationEpochMirror: positive safe integer, CAS текущей metadataRevision, pendingSourceOperationId:null, монотонный epoch. Existing workspace accounts могут читать metadata без искусственного reconnect; regression проверен на PostgreSQL.

### 9. Gate пригодности Anthropic/Gemini для ревью

Реальный RR запускает `codex exec --sandbox read-only`, а proxy config устанавливает `wire_api = "responses"`. `protectedResponsesToolPolicyConfigLines` отключает только server-side web search; это не режим «только текст» и не доказанный режим «только function tools». [Runner и его конфигурация][rr-runner].

Существующий joined harness требует объявления tools, возврата function output во втором запросе и, если CLI объявил custom tools, также custom tool output. Следовательно, обещание нового native адаптера «text/function-only» ещё не означает совместимость с используемым runner. [Проверяемая форма реального запроса][rr-joined].

До активации провести ограниченный feasibility шаг: один закреплённый CLI, одна модель профиля, production relay adapter, два turn с реальным локальным инструментом и записью обезличенной формы запроса. Проверить tool declaration, call IDs, arguments/output, continuation, streaming completion и отсутствие неподдержанного reasoning/fast. Использовать ограничения запросов/токенов существующего harness.

Если обнаружены custom tools, допустимы два доказанных решения: поддерживаемая конфигурация runner, сохраняющая нужные для ревью действия только через function tools; либо реализация необходимой семантики native-перевода в пакете D. Нельзя незаметно удалять custom tools, превращать вызов в текст или реализовывать codec в RR. Если ни один вариант не доказан, профиль остаётся не квалифицированным для ревью, даже когда ключ принят и простой текстовый запрос работает. Метаданные и новые входы Codex выпускаются независимо от этого gate. Стоимость непредвиденного изменения runner/native tool semantics оценивается отдельно.

### 10. Последовательность и параллельная работа

1. Зафиксировать канонические SDK contracts и capabilities с пакетом B. Параллельно выполнить feasibility новых API-профилей; не ждать его для metadata.
2. Создать scoped profile, минимальную feature API и SDK adapter. Внутренние тесты используют опубликованный контракт и заменяемый reader, но не объявляются доказательством реального Gateway.
3. Извлечь узкий authorization helper, сохранить limits regression, подключить все проекции и общий renderer.
4. Добавить capability-driven RT/JSON формы и personal reconnect, затем ключевые профили, разрешённые пакетом D.
5. Принять квалифицированный SDK artifact, пройти сквозную проверку и выпускать в порядке общего плана.

Один владелец пакета C редактирует shared RR файлы: `account-gateway-accounts.ts`, `personal-account-composition.ts`, `personal-canonical-accounts.ts`, `account-gateway-account-controls.tsx`, `accounts-add-dialog.tsx`, общий `AccountIdentity`, manifest и lockfile. Пакеты A/B/D не правят их параллельно; согласование профилей проходит через публичные контракты. Новые небольшие файлы можно разрабатывать параллельно после фиксации интерфейсов, интеграцию shared files выполняет один исполнитель.

План 76 задаёт общий список, 77 явно откладывает personal Codex reconnect, 79 владеет одношаговым подключением и будущими `PersonalConnectPanel`/`ConnectTarget`. Этот пакет берёт reconnect как отдельную capability, переиспользует согласованные точки формы и не поглощает redesign 79. Исторические планы задают соседние границы; этот пакет не поглощает redesign79. Работы над freshness/status текстами также не надо смешивать с добавлением фактов. [Планы 76][rr-plan76], [77][rr-plan77], [79][rr-plan79].

### 11. Проверки и выпуск

| Проверка | Независимое ожидаемое поведение |
| --- | --- |
| Scoped architecture/type checks | SDK запрещён в application; descriptor доступен только composition; production вызывает собранную API |
| Metadata adapter | Только публичный SDK; неизвестный/пустой факт не подменяется planLabel; нет raw credential/native payload |
| Authorization regression | Старые owner/borrower, suspended, source/binding и refresh сценарии limits не меняются |
| Metadata races | Смена membership, binding revision, epoch, pending reconnect/delete и отказ DB подавляют приватный результат, включая финальный batch |
| UI projections | Сведения сохраняются после selected-detail hydration; shared renderer корректен для длинных/пустых значений, keyboard и mobile |
| Capability compatibility | Явный composed v1 reader работает; v2 read не fallback-ится по ошибке; per-method create/reconnect независимы |
| Import/reconnect | Валидный RT с expired AT/ID, ошибочный RT, повтор, timeout, cancel и recovery; stable logical identity и отсутствие лишних bindings |
| Real review gate | Закреплённый CLI, реальные tools и второй turn, terminal result и существующий путь публикации результата |

Расширять тесты следует для этих конкретных рисков, без тестирования каждого механического mapper отдельно. Зафиксированные ожидания privacy и native identity не вычисляются той же функцией, которую тестируют. Negative fixtures Foundation, меняющие временные файлы checkout, запускать последовательно.

RR использует tracked `vendor/account-gateway/agent-teams-account-gateway-0.1.0-native-imports-f2690a3c9cfd.tgz`, SHA-256 `34562d43668a1ca09e95666da3237206b3744d0d0766039fd2b8acbce241483f`. SDK собран из committed Gatewayf2690a3 exact Node26.11.1/pnpm11.28.2; provenance — `vendor/account-gateway/native-account-info-sdk-provenance.json`. Web/API/provider-usage и lockfile используют один архив. Frozen install выполнен на Node24.21.0/pnpm11.28.7 с действующей supply-chain policy; во всех трёх потребителях все50 установленных файлов побайтно совпали с архивом. Все36 focused imports/admission/catalog/detail tests прошли против установленного SDK. Lockfile изменяет только девять строк имени архива/SRI, без изменения версий зависимостей. Исторический архив и receipts сохранены, generated archives/lock не считаются повторно production LOC.

### Состояние квалификации реализации

Текущая матрица результатов, точных source revisions и оставшихся gates ведётся в одном месте: [qualification §8](native-account-qualification.md). Старый receipt не переносит свой статус на новый head.

Исторические результаты для RR `6c490c0`: C1 [44454251528](https://github.com/777genius/review-router-ai/actions/runs/44454251528) прошёл architecture/Foundation/layout и provider-accounts type/build gates; behavioral/PG части — 48/48 и 26/26. P115 [44454251536](https://github.com/777genius/review-router-ai/actions/runs/44454251536) подтвердил controlled Gateway HTTP. Это отдельная исходная ревизия.

Последующие независимые receipts: browser `597450b4` дал 34/34 captures в [44457361015](https://github.com/777genius/review-router-ai/actions/runs/44457361015); SDK pin `b9551099` проверен frozen install, сравнением всех 50 файлов в трёх consumers и 36 focused cases; source identity `d4d39a2b` прошла штатные generators и 29 связанных tests. C1, P115 и browser для `d4d39a2b` также завершены успешно, с run links в общей матрице. Эти результаты не заменяют full Web gate последующих review fixes.

Строгий metadata TS project охватывает feature, fixed adapters, общий metadata UI и их собственные tests. Широкий `dashboard-gateway-accounts.test.ts` остаётся в существующих full Web typecheck и runtime suites: он также проверяет lifecycle, auth и model catalog. Он не расширяет scoped adoption метаданных на весь Web host. `skipLibCheck: false` и mandatory binding `metadata:typecheck` в `architecture:check` сохранены; дополнительных auth dependencies или declaration shims не требуется.

Browser workflow использует existing provider-setup-visual harness: actual Next/sessions/PostgreSQL migrations, loopback Gateway fixtures и запрет внешних requests. Требуются34 scenario/width/theme captures, exact head, sourceBefore=sourceAfter, no page/network errors/overflow. Source proof исключает только Next-generated next-env.d.ts, не SDK/lock/product code. Synthetic upstream не равен live provider access.

Migration tree содержит165files. Exact165→164 reducer проверяет count/order/checksum; historical92/96/164 manifests не переписаны. Reader-compatible rollout предшествует method-bearing writer. После первой новой journal entry minimum rollback image обязан понимать credentialImportMethod. Deployment registry2026-11-19-native-account-info-imports остаётся NOT deployed.

## Examples

### Свои факты и чужой доступ

Пользователь открывает свой Codex в личном разделе: видит имя подключения, native email и «Plus», если источник вернул эти факты. Он открывает то же подключение через свою действующую workspace binding — сведения сохраняются. Admin другого workspace, которому аккаунт предоставлен для ревью, видит разрешённую строку и действия использования, но не получает email/тариф через network response. Разрешение запускать ревью не является разрешением читать identity владельца.

### Полный JSON с устаревшими токенами

Пользователь выбирает импорт полного `auth.json`. В файле истекли AT/ID, RT пригоден. RR передаёт ограниченный payload без декодирования. Native выполняет RT exchange с fences, Gateway возвращает результат операции и безопасную identity. UI очищает исходный файл, перечитывает тот же аккаунт и отображает факты только после живой проверки прав. При неопределённом ответе UI восстанавливает операцию по её identity, а не повторяет создание вслепую.

### API принят, review ещё не разрешён

Gemini API key успешно сохранён и metadata endpoint доступен, но pinned Codex объявляет custom tool, который адаптер пока не обрабатывает. Подключение может существовать; выбрать его для ревью пока нельзя. После доказанной совместимости реального tool roundtrip и итогового результата capability разрешает нужный профиль. Такой gate не блокирует выпуск metadata для уже квалифицированного Codex.

[rr-profile]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/architecture/account-metadata/consumer-module-profile.json
[rr-foundation]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/architecture/foundation/provider-seams.yaml
[rr-limits-composition]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/apps/web/src/server/account-limits-composition.ts
[fms]: https://github.com/agent-teams-ai/.github/blob/f5653f5630057524a4ee44e50c16e138442a9b42/docs/architecture/feature-module-standard/v1.1.md
[rr-limits-service]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/apps/web/src/server/account-limits-service.ts
[rr-limits-tests]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/apps/web/src/server/account-limits-service.test.ts
[rr-hydration]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/apps/web/src/server/dashboard-gateway-accounts.ts
[rr-identity]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/apps/web/app/dashboard/account-identity.tsx
[rr-dialog]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/apps/web/app/dashboard/accounts-add-dialog.tsx
[rr-personal]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/apps/web/src/server/personal-canonical-accounts.ts
[rr-runner]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/packages/features/codex-oauth-rotating/src/action/github-action.ts
[rr-joined]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/scripts/review-investigation-paired-e2e/support/provider-subscriptions-joined.ts
[rr-plan76]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/ai-docs/architecture/76-single-connections-list.md
[rr-plan77]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/ai-docs/architecture/77-single-account-stack.md
[rr-plan79]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/ai-docs/architecture/79-one-step-add-provider.md
[rr-sdk]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/apps/web/package.json
[rr-workspace]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/apps/web/src/server/account-gateway-accounts.ts
[rr-overview]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/apps/web/src/server/accounts-overview.ts
[rr-model-detail]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/apps/web/src/server/gateway-model-account-options.ts
[rr-personal-composition]: https://github.com/777genius/review-router-ai/blob/43e475d455e2931b39adef2652c5b8fe921c693e/apps/web/src/server/personal-account-composition.ts
[cms]: https://github.com/agent-teams-ai/get-modular/blob/7a7c4c54add9ccc06509423d7b89bcfc037227b1/docs/architecture/common-assembly.md
[authoring]: https://github.com/agent-teams-ai/get-modular/blob/7a7c4c54add9ccc06509423d7b89bcfc037227b1/docs/guides/module-authoring.md
[eqs]: https://github.com/agent-teams-ai/.github/blob/c8f3e7ba220241f79292c84c72712653019aa1df/docs/engineering-quality-standard.md
