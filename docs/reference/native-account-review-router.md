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

Документ описывает предлагаемую реализацию, а не выполненные изменения. Проверенная основа RR — `f1cde67a2baf7416ea1d2341f6c9a98e64750aa4`; Gateway — `1dce5c327d14e9c0e5466da91441faa0d0ae38a5`; Sub2API — `cfe50b7fd2aef08a7a17f11132cae73293804389`. Наличие кода на этих ревизиях не подтверждает поддержку новых возможностей работающим окружением.

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

Создать узкий срез `packages/features/provider-accounts/src/account-metadata`. У него одна прикладная операция чтения, небольшой порт reader, адаптер публичного SDK и одна составленная feature API. Нет основания создавать aggregate аккаунта заново или добавлять пустой `domain/`: здесь не появляются новые бизнес-переходы. Внутренние helpers, DTO, React-компоненты и каждый провайдер не становятся отдельными узлами Get Modular.

Для этого среза оформить scoped profile и repository decision. В качестве проверенной основы использовать те же зафиксированные стандарты, что уже приняты для Review History, явно указав новый scope. Профиль History сам по себе на аккаунты не распространяется. Core и Assembly остаются `0.7.0`; обновление framework не входит в задачу. Foundation остаётся инструментом разработки, а не production dependency. [Профиль принятия History][rr-profile].

| Стандарт | Зафиксированная версия |
| --- | --- |
| CMS и Module Authoring | `agent-teams-ai/get-modular@7a7c4c54add9ccc06509423d7b89bcfc037227b1` |
| CMS, SHA-256 полного документа | `3c5814ebf1ab1bd17688e49955aa0baa2ee91dd3a369adcea4d38aaccd53ba86` |
| Module Authoring, SHA-256 | `9bdbc6a6eac511691cf429c7e7e12b4cf4fd86ec16a348fb3af7a46c989af144` |
| FMS v1.1 | `agent-teams-ai/.github@f5653f5630057524a4ee44e50c16e138442a9b42`, SHA-256 `cfa088ef7396139554fe5e3bcc839271b23299c6b60c569a3a7f1cd7c9f0bc6c` |
| Engineering Quality Standard | `agent-teams-ai/.github@c8f3e7ba220241f79292c84c72712653019aa1df` |

Профиль фиксирует физические пути, public/composition surfaces, host adapters, dependency rules и команды проверки. Добавить новый scope в Foundation manifest и modular qualification. Текущий manifest охватывает внутри provider-accounts только `account-limits`, исключая старый lifecycle; нельзя назвать весь пакет соответствующим стандарту после проверки нового среза. [Действующая граница][rr-foundation].

Композиция следует [CMS][cms] и [Module Authoring][authoring]: descriptor в `composition/account-metadata.contracts.ts`, отдельные declaration через `declareModule`, тонкий module через `implement`, group и один root. Заимствованный reader передаётся как объявленный input. Нет собственного сетевого клиента в домене, polling-процесса, lifecycle manager или второго способа сборки. Host вызывает полученную `readMetadata` API. Не повторять частичный подход limits, где Web после сборки извлекает `.reader`, а затем вызывает use case напрямую. Переписывать ради этого весь старый limits необязательно. [Текущая сборка limits][rr-limits-composition].

Доказательства нового scoped CMS используют уже установленный `@get-modular/conformance@0.5.0`: `checkModuleLayout` по реальным файлам, `checkWiring` с **независимым oracle** и wrong-root/wrong-binding mutant, isolate/smoke реального module/root. Spy-тест подтверждает, что `prepare/run` не вызывают SDK, authorization callback или SQL: эффект начинается только при `readMetadata`. Включить именно эти пути в `architecture:check`, `modular:qualify` и strict TS 7.0.2 project с `skipLibCheck: false`. Успешный тест injected reader отдельно от layout/wiring/passive construction не заменяет весь набор. Переиспользовать owning pattern `scripts/review-history-tooling/check.ts` и `review-history.root.test.ts`, без нового validation framework.

### 3. Минимальная модель без механических копий

[Engineering Standard][eqs] требует разделять модели там, где отличаются контракты, и запрещает бессодержательные слои маппинга. Одновременно FMS/CMS запрещают SDK/transport DTO внутри application/domain. Поэтому создать **один** транспортно-независимый результат чтения с необходимыми RR состояниями доступа и сведениями; SDK адаптер делает одну содержательную проекцию. Тот же результат используют `AccountView` и UI. Отдельные эквивалентные domain-, application-, transport- и component-типы не нужны. [Правила зависимости и моделирования][fms].

На внешней SDK/UI-границе допустимо повторно использовать публичный DTO, если семантика и права совпадают. Внутри нового use case SDK не импортируется даже через `import type`. Нельзя считать сужение TypeScript-типа удалением лишних полей при сериализации: browser boundary выдаёт только разрешённые сведения. RR не декодирует JWT для email, не вычисляет тариф по профилю и не интерпретирует raw native `extra`.

Состояние загрузки и opaque display token принадлежат RR. Значение факта, происхождение и время native observation принадлежат источнику. Время запроса RR не подменяет время наблюдения. Capability отсутствие, отсутствующий факт, временная недоступность и запрет просмотра отображаются раздельно, без утечки backend diagnostics.

### 4. Узкое извлечение живой авторизации

У metadata появляется второй реальный потребитель разрешения источника из `apps/web/src/server/account-limits-service.ts`. Выделить в именованный host adapter, например `account-display-authorization.ts`, только `Scope`, `Source`, существующий `resolve` SQL и предикаты `equalScope`/`owned`. Сохранить SQL, tombstone-условия, поля результата и выбор source/binding. Указать этот адаптер в scoped profile. Не создавать policy DSL, общий permission manager или новую абстракцию всех lifecycle операций. [Текущая реализация][rr-limits-service].

В limits остаются собственные статусы, refresh, namespace `account-limits-v1` и сериализация fingerprint. Его concurrency 4, трёхсекундный page deadline, 250 ms на необязательное refresh discovery и проверки перед explicit refresh не меняются. Для metadata задаётся отдельный ограниченный бюджет чтения; открытие списка не запускает provider refresh или health probe. В application поступает узкий callback живой авторизации с target и opaque token, без Prisma и session DTO.

Metadata использует единую read policy [contracts](native-account-contracts.md): группировка разрешённых refs по owner, ограниченные batches и общий page deadline с резервом final fence. Не переносить limits refresh-discovery 250 ms как новый provider запрос metadata. Несвоевременная или непроверенная metadata не задерживает всю страницу и не выдаётся из старого cache после смены viewer scope.

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

`dashboard-gateway-accounts.ts` заменяет исходные строки результатами detail hydration. Обогащение только первого списка поэтому теряет сведения. Применить один разрешённый enrichment на согласованной границе выдачи, включая detail, с финальным authority fence; не добавлять четыре provider mapper. Тест должен проверять именно замену выбранной строки. [Реализация hydration][rr-hydration].

В identity показать пользовательское имя, native email и подтверждённый тариф; длинные значения переносить, выводить как текст. `connection.planLabel` сегодня происходит из каталога профилей и не является тарифом аккаунта: «Codex OAuth» не заменяет «Plus» или «Pro 200». Subscription end, token expiry, admin account expiry и quota reset не объединять в безымянное «Expires». Отсутствующее поле не заполнять догадкой. Общий компонент используется в личных, workspace и operation views; чужие строки получают уже отфильтрованную сервером модель. [Текущий renderer][rr-identity].

### 6. Capabilities и формы входа

Расширить три существующие product-owned точки допуска для **точных qualified Anthropic API/Gemini API profile tuples**: `apps/web/src/server/account-connection-catalog.ts`, `apps/web/src/features/provider-setup/setup-provider.ts` и `apps/web/src/features/account-gateway/connection-capabilities.ts`. Сейчас catalog автоматически добавляет qualified NVIDIA и настроенные subscription profiles, setup не имеет новых key choices, а AccountUpstreamProvider не содержит Gemini. V2 descriptor сам по себе эти фильтры не обходит. Сохранить различие brand и execution engine `codex_account_gateway`, не направлять Anthropic API в существующий Claude Code subscription route. Это admission/display mapping продукта, а не второй native catalog/models registry. Сквозной тест: v2 descriptor → setup choice → account/model binding → правильный runner; произвольный не qualified advertised profile остаётся unavailable.

Потреблять **новый SDK-метод capabilities v2**, указанный каноническим контрактом. Не расширять существующий строгий ответ v1 неизвестными полями и не переинтерпретировать его как v2. Старые browser/device методы продолжают идти по существующему пути. Если новый endpoint/контракт недоступен, скрыть новые импорты и новые профили; это не причина сломать прежний вход. Временная ошибка discovery не превращается в бессрочный кеш «не поддерживается».

Возможности create и reconnect проверять отдельно. Полученный список методов пересекается с разрешениями RR и квалифицированными профилями; клиентский выбор не обходит серверную проверку. Состояние `enabled` для входа само по себе не разрешает модель в review roster.

Переиспользовать существующий `ConnectionForm` и `AccountGatewayControls`, добавив небольшие контролируемые части для RT и файла/текста JSON. Для Anthropic/Gemini переиспользовать ключевую форму; не копировать весь компонент и не создавать schema-driven form engine. В UI различать провайдера и engine: профиль Anthropic/Gemini через Gateway может исполняться существующим Codex Responses runner, но должен иметь верную identity провайдера.

### 7. RT и полный Codex auth.json

RR передаёт bounded input SDK как выбранный тип импорта по каноническому контракту. Разбор credential-структуры и получение достоверной identity принадлежат native. Успех нельзя определять по существованию JSON-ключей или локальной JWT-декодировке.

Для обоих входов native **всегда выполняет fenced RT exchange**. Полный `auth.json` с истёкшими access/id tokens и пригодным refresh token не отклоняется только из-за этих сроков: native получает новые токены и проверяет principal по своему протоколу. И наоборот, свежий AT не разрешает пропустить RT exchange. AT-only, mobile RT, Agent Identity и PAT не появляются автоматически под видом «полного JSON»; их отдельные режимы вне этого пакета.

Raw credential не хранится в React persistence, query string, telemetry, журнале RR или operation receipt. Ошибки не цитируют исходный payload. На закрытие диалога, смену владельца, профиля или метода очищаются password, textarea, выбранный файл и удерживаемые значения. Текущий `clearUnsubmittedCredentials` очищает только password/callback/code inputs; новые поля надо включить явно. Повтор после неопределённого ответа использует существующие operation identity и reconcile правила, а не автоматически создаёт ещё один аккаунт. [Диалог и очистка][rr-dialog].

### 8. Личный Codex reconnect

Recovery показывает исходную Gateway operation. Поздний native receipt не превращает terminal Gateway `unknown` в `applied`; точные live/pending и spent-authority границы заданы [contracts](native-account-contracts.md). UI не обещает успешный автоматический resume и не создаёт повторный import после этого состояния.

До method-bearing writer выпустить совместимый RR reader для `PersonalAccountOperation`: текущие normalizer/hash и browser-hardcoded dispatch/readback находятся в `personal-canonical-operation.ts` и `personal-canonical-accounts.ts`. Старые intent сохраняют прежнюю интерпретацию и hash; новый method связывается с versioned intent без массового переписывания старых rows. После первой записи новых методов установить minimum RR rollback version, умеющую их безопасно читать. Rolling-upgrade tests покрывают старые операции и новые RT/JSON/device reconnect records. Неизвестный/import method не приводится к browser; это не безобидный UI rollback.

Сегодня [Codex задаёт `canReconnect: false`][rr-personal-composition], а personal OAuth reconnect допускает лишь browser и удаляет `method` перед разбором запроса. Поэтому одной смены флага недостаточно. Довести reconnect для объявленных методов Codex, сохранив выбранный метод в соответствующем operation intent и recovery-пути. Browser/device используют уже существующие протоколы; RT/JSON — новый метод SDK с отдельной проверкой разрешённости операции. [Canonical handler][rr-personal].

Перед началом проверяются владелец, source state и актуальная generation/epoch. Пока операция pending, старые факты не выдаются. После native подтверждения обновляется то же логическое подключение с установленными Gateway fences; существующие workspace bindings не заменяются копиями. Результат чтения receipt, повтор запроса и восстановление после перезапуска должны сходиться к одному результату. Новый principal нельзя молча признать прежним только по переданному email; требуемое поведение смены identity задаёт канонический контракт. Не объединять рабочие workspace и personal протоколы ради одинаковой формы.

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

План 76 задаёт общий список, 77 явно откладывает personal Codex reconnect, 79 владеет одношаговым подключением и будущими `PersonalConnectPanel`/`ConnectTarget`. Этот пакет берёт reconnect как отдельную capability, переиспользует согласованные точки формы и не поглощает redesign 79. Перед implementation rebase проверить их фактическое состояние: документ плана не означает merged implementation. Работы над freshness/status текстами также не надо смешивать с добавлением фактов. [Планы 76][rr-plan76], [77][rr-plan77], [79][rr-plan79].

### 11. Проверки и выпуск

| Проверка | Независимое ожидаемое поведение |
| --- | --- |
| Scoped architecture/type checks | SDK запрещён в application; descriptor доступен только composition; production вызывает собранную API |
| Metadata adapter | Только публичный SDK; неизвестный/пустой факт не подменяется planLabel; нет raw credential/native payload |
| Authorization regression | Старые owner/borrower, suspended, source/binding и refresh сценарии limits не меняются |
| Metadata races | Смена membership, binding revision, epoch, pending reconnect/delete и отказ DB подавляют приватный результат, включая финальный batch |
| UI projections | Сведения сохраняются после selected-detail hydration; shared renderer корректен для длинных/пустых значений, keyboard и mobile |
| Capability compatibility | Старый v1 работает; отсутствующий v2 закрывает только новые режимы; create не означает reconnect |
| Import/reconnect | Валидный RT с expired AT/ID, ошибочный RT, повтор, timeout, cancel и recovery; stable logical identity и отсутствие лишних bindings |
| Real review gate | Закреплённый CLI, реальные tools и второй turn, terminal result и существующий путь публикации результата |

Расширять тесты следует для этих конкретных рисков, без тестирования каждого механического mapper отдельно. Зафиксированные ожидания privacy и native identity не вычисляются той же функцией, которую тестируют. Negative fixtures Foundation, меняющие временные файлы checkout, запускать последовательно.

RR сейчас использует vendored SDK archive `agent-teams-account-gateway-0.1.0-nvidia-0c68a5d544ff.tgz`. Обновление требует нового build/pack receipt, source association, hash, lockfile и проверки фактически установленного архива, а не ссылки на Gateway main. Затем проверить capabilities квалифицированного Gateway/native runtime. Генерируемые архивы и lockfile не учитываются повторно как production LOC. [Зависимость Web][rr-sdk]. Откат Web скрывает новую UI capability, но не отменяет уже завершённый native import; поведение незавершённых операций и совместимость rollback задаёт общий план.

## Examples

### Свои факты и чужой доступ

Пользователь открывает свой Codex в личном разделе: видит имя подключения, native email и «Plus», если источник вернул эти факты. Он открывает то же подключение через свою действующую workspace binding — сведения сохраняются. Admin другого workspace, которому аккаунт предоставлен для ревью, видит разрешённую строку и действия использования, но не получает email/тариф через network response. Разрешение запускать ревью не является разрешением читать identity владельца.

### Полный JSON с устаревшими токенами

Пользователь выбирает импорт полного `auth.json`. В файле истекли AT/ID, RT пригоден. RR передаёт ограниченный payload без декодирования. Native выполняет RT exchange с fences, Gateway возвращает результат операции и безопасную identity. UI очищает исходный файл, перечитывает тот же аккаунт и отображает факты только после живой проверки прав. При неопределённом ответе UI восстанавливает операцию по её identity, а не повторяет создание вслепую.

### API принят, review ещё не разрешён

Gemini API key успешно сохранён и metadata endpoint доступен, но pinned Codex объявляет custom tool, который адаптер пока не обрабатывает. Подключение может существовать; выбрать его для ревью пока нельзя. После доказанной совместимости реального tool roundtrip и итогового результата capability разрешает нужный профиль. Такой gate не блокирует выпуск metadata для уже квалифицированного Codex.

[rr-profile]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/architecture/review-history/consumer-module-profile.json
[rr-foundation]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/architecture/foundation/provider-seams.yaml
[rr-limits-composition]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/apps/web/src/server/account-limits-composition.ts
[fms]: https://github.com/agent-teams-ai/.github/blob/f5653f5630057524a4ee44e50c16e138442a9b42/docs/architecture/feature-module-standard/v1.1.md
[rr-limits-service]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/apps/web/src/server/account-limits-service.ts
[rr-limits-tests]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/apps/web/src/server/account-limits-service.test.ts
[rr-hydration]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/apps/web/src/server/dashboard-gateway-accounts.ts
[rr-identity]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/apps/web/app/dashboard/account-identity.tsx
[rr-dialog]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/apps/web/app/dashboard/accounts-add-dialog.tsx
[rr-personal]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/apps/web/src/server/personal-canonical-accounts.ts
[rr-runner]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/packages/features/codex-oauth-rotating/src/action/github-action.ts
[rr-joined]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/scripts/review-investigation-paired-e2e/support/provider-subscriptions-joined.ts
[rr-plan76]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/ai-docs/architecture/76-single-connections-list.md
[rr-plan77]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/ai-docs/architecture/77-single-account-stack.md
[rr-plan79]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/ai-docs/architecture/79-one-step-add-provider.md
[rr-sdk]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/apps/web/package.json
[rr-workspace]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/apps/web/src/server/account-gateway-accounts.ts
[rr-overview]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/apps/web/src/server/accounts-overview.ts
[rr-model-detail]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/apps/web/src/server/gateway-model-account-options.ts
[rr-personal-composition]: https://github.com/777genius/review-router-ai/blob/f1cde67a2baf7416ea1d2341f6c9a98e64750aa4/apps/web/src/server/personal-account-composition.ts
[cms]: https://github.com/agent-teams-ai/get-modular/blob/7a7c4c54add9ccc06509423d7b89bcfc037227b1/docs/architecture/common-assembly.md
[authoring]: https://github.com/agent-teams-ai/get-modular/blob/7a7c4c54add9ccc06509423d7b89bcfc037227b1/docs/guides/module-authoring.md
[eqs]: https://github.com/agent-teams-ai/.github/blob/c8f3e7ba220241f79292c84c72712653019aa1df/docs/engineering-quality-standard.md
