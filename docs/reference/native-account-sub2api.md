---
id: docs.reference.native-account-sub2api
type: reference
status: proposed
owner: gateway-maintainers
summary: Реализация безопасных native snapshots, происхождения фактов и защищённых импортов Codex в существующем native lifecycle.
---

# Пакет A: нативные сведения и импорты Sub2API

## Overview

Этот документ фиксирует реализованный в Sub2API код выбранной волны: безопасные сведения об аккаунтах, фактически собранные способы подключения и два импорта Codex — refresh token и обычный `auth.json`, содержащий refresh token. Точка проверки кода — `91d19700b05a8534dc1ba28538e8f67f6c94553d`, PR #103. Наличие кода не означает полную квалификацию: exact-head PostgreSQL, межрепозиторные проверки и review runner фиксируются в [qualification](native-account-qualification.md). Production deployment и реальные provider credentials в эту работу не входят; статус остаётся `proposed` до завершения заявленных проверок.

Единственный источник provider-specific поведения — Sub2API. Здесь остаются обращения к провайдерам, проверка их ответов, интерпретация планов, преобразование протоколов и хранение секретов. Account Gateway использует заменяемый backend через нейтральный порт; Review Router получает безопасное представление через Gateway. Замена backend не требует переносить в Gateway парсеры JWT, названия полей квот или эвристики тарифов.

Общий wire-контракт, состояния ответа и версионирование определены в [контрактах](native-account-contracts.md). Этот документ определяет нативную реализацию, не создавая вторую DTO-спецификацию. Официальные API-профили Anthropic и Gemini описаны в [пакете профилей](native-account-provider-profiles.md); здесь учтены их сведения и граница с нативным lifecycle. OpenAI API key, mobile RT, AT-only, PAT, Agent Identity, новые подписочные OAuth-семейства и полное совпадение со всеми режимами административной формы в эту волну не входят.

### Проверенная исходная точка

Первоначальный аудит привязан к `cfe50b7fd2aef08a7a17f11132cae73293804389`; таблица ниже показывает существовавшие точки расширения. Реализация reader, sources, imports и migrations проверяется по `91d19700b05a8534dc1ba28538e8f67f6c94553d`. Наличие admin handler само по себе не означает поддержку protected native API.

| Область | Существующая точка расширения | Следствие для реализации |
|---|---|---|
| Каталог провайдеров | `platforms.go`, `provider_profile.go`, `BuildPlatformCatalog` | Расширить нативное знание, затем ограничить его реально собранными private-профилями |
| Безопасное чтение | `GatewayAccountLimitsReaderV2` | Повторно использовать принцип авторизации логического аккаунта и проверки физического рождения |
| Хранение наблюдений | `gateway_account_limits_v2_snapshots` | Повторно использовать контроль principal/version; сведения хранить отдельно от DTO лимитов |
| Codex enrollment | `GatewayNativeOAuthEnrollment.Stage` | Сохранить проверенный principal, зашифрованный bundle и точный replay |
| OAuth connect | `GatewayNativeOAuthConnect` и `gateway_oauth_connect_intents` | Добавить методы в существующий автомат состояний |
| Квоты | `runPrivateProviderQuota`, `GatewayProviderQuotaCollector` | Получать сведения из уже прочитанного ответа, без второго запроса |

Источники: [каталог](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/platform_catalog.go#L1-L64), [чтение лимитов](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/native_gateway_account_limits_v2.go#L92-L162), [connect lifecycle](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/native_gateway_oauth_connect.go#L111-L169), [сборщик квот](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/gatewaybootstrap/native_provider_quota_linux.go#L14-L130).

## Contract

### A1. Границы ответственности и источник возможностей

Нужны три небольшие ответственности: получение типизированного нативного наблюдения, сохранение безопасного snapshot и чтение snapshot при действующей авторизации. Читатель не получает HTTP client, custody-дешифратор или OAuth refresh service. Это ограничение конструктора, а не договорённость внутри большого сервиса. Парсеры конкретных провайдеров находятся рядом с существующими адаптерами, а не внутри универсального хранилища.

Каталог для Gateway строится из нативного знания и настроек текущего private bootstrap. Он сообщает только методы, которые действительно смонтированы, имеют custody и поддерживаются выбранным профилем. Глобальный административный каталог не является обещанием возможностей конкретного deployment. При отсутствии сервиса импорта его кнопка не появляется благодаря фактам backend; продуктовая политика потребителя может дополнительно сузить список.

`GET /private/native/v1/account-capabilities` возвращает `native-account-capabilities/v1`; create/reconnect объявлены по каждому методу. Codex imports включаются только при composed connect+dispatch. Catalog read не делает provider HTTP. [Composition](https://github.com/agent-teams-ai/sub2api/blob/91d19700b05a8534dc1ba28538e8f67f6c94553d/backend/internal/gatewaybootstrap/native_account_capabilities_linux.go).

Нельзя выводить публичного провайдера из `accounts.platform`: часть защищённых API-профилей хранится как `openai` ради совместимости инфраструктуры. Например, константа `GatewayMiMoResponsesProfile` имеет значение `openai-responses-apikey-v1`. Нужна явная нативная связь профиля с провайдером и продуктовым режимом. [Исходное определение](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/native_gateway_identity.go#L20-L49).

Общий код вводится там, где совпадает инвариант: авторизация, CAS, безопасный observation envelope, строгая обработка импорта. Не требуется общий DSL для всех способов входа, регистрация произвольных endpoint или переписывание административных сервисов. Это сохраняет DRY без объединения разных моделей доверия.

### A2. Сведения, происхождение и честные пробелы

Нативное представление содержит только разрешённые факты общего контракта. Email является отображаемым фактом, не ключом владения; план не даёт права маршрутизации; подпись ID token не означает автоматически `email_verified=true`. Сырой plan code сохраняется вместе с нормализованным нативным названием. Неизвестный код остаётся неизвестным кодом, а отсутствие сведений не превращается в Free.

| Источник | Что можно извлечь в выбранной волне | Что нельзя обещать |
|---|---|---|
| Codex: проверенный ID token и защищённый account-check | Email при наличии, выбранный provider account, personal/workspace plan и соответствующий ему срок | Email из произвольного импортированного JSON; смешанный personal plan и workspace expiry |
| Существующий Claude native | Email из аутентифицированного OAuth account DTO; credential expiry при сохранённом времени наблюдения | План/label, которых DTO не содержит; историческое время, которого нет в старом bundle |
| Существующий Grok native | Email/name из аутентифицированного userinfo после проверки subject/team; credential expiry | Поля обычного admin GrokTokenInfo без доказанного native источника |
| GLM Coding | Название/уровень из `data.level` того же ответа квоты | Email или персональную подписку, если endpoint их не сообщает |
| MiniMax M-Plan | Название из `current_subscribe_title` того же ответа | Расширенную billing-информацию, отсутствующую в native ответе |
| Kimi и другие API-профили без источника display facts | Provider/product/method из capabilities; неподдержанные fields остаются unsupported | Автоматическую почту и план только на основании API key |
| Новые официальные Anthropic/Gemini API key | Провайдер, способ подключения и продуктовый API-профиль | Почту владельца или потребительскую подписку без защищённого источника |

GLM/MiniMax plan-поля теперь извлекаются из того же проверенного ответа, что и квоты. `FetchWithAccountInfo` возвращает обе проекции; ошибка HTTP/чтения/разбора не публикует observation. Это проекция existing response без нового billing-запроса. [Source fields](https://github.com/agent-teams-ai/sub2api/blob/91d19700b05a8534dc1ba28538e8f67f6c94553d/backend/internal/service/native_gateway_account_info_sources.go).

Для OpenAI plan labels используется один Go-owned catalog codes/aliases/status/analytics labels. Native formatter читает его напрямую; `cmd/generate-plan-catalog` создаёт frontend JSON, а `frontend/src/utils/planType.ts` проверяет собственные ключи при lookup. `make generate-plan-catalog` пишет временный файл рядом с целью и заменяет результат только после успешной генерации. Старый frontend switch удалён; второго editable formatter нет. [Каталог](https://github.com/agent-teams-ai/sub2api/blob/91d19700b05a8534dc1ba28538e8f67f6c94553d/backend/internal/pkg/openai/plan_types.go), [генерация](https://github.com/agent-teams-ai/sub2api/blob/91d19700b05a8534dc1ba28538e8f67f6c94553d/backend/Makefile).

Нельзя формулировать общее правило «API key никогда не даёт email»: например, Cline обращается к `/users/me`, но текущая реализация извлекает только ID. Сам Cline не добавляется в выбранную native волну, поэтому это ограничение будущего профиля, а не повод объявить его поддержку сейчас. [Существующий запрос Cline](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/cline_usage.go#L108-L163).

OpenAI `enrichTokenInfo` нельзя использовать целиком: после чтения он вызывает изменение настройки обучения. Выделяется чистая проекция уже полученных данных; privacy выводится только как реально наблюдённый факт. Отдельное изменение настройки остаётся отдельной командой вне этой задачи. [Смешанные эффекты и защита соответствия подписки](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/openai_oauth_service.go#L257-L307).

### A3. Snapshot, актуальность и principal

Миграция `260_gateway_account_info.sql` создаёт native snapshot safe facts и sequence source order. Snapshot связан с exact physical birth, generation и стабильным principal; credential revision проверяется отдельно. JWT, raw HTTP bodies, credentials и AEAD envelope в snapshot не сохраняются. Reader зависит от cache, authorizer и clock: чтение не вызывает HTTP, дешифрование или refresh. [Reader/source policy](https://github.com/agent-teams-ai/sub2api/blob/91d19700b05a8534dc1ba28538e8f67f6c94553d/backend/internal/service/native_gateway_account_info.go), [repository](https://github.com/agent-teams-ai/sub2api/blob/91d19700b05a8534dc1ba28538e8f67f6c94553d/backend/internal/repository/native_gateway_account_info.go).

Private sources закрыты: `verified_claims`, `account_check`, `plan_quota`, `credential`. Codex email поступает только из verified claims; Claude/Grok — из authenticated account/userinfo. Успешное полное observation заменяет вклад источника, включая отсутствие поля. HTTP/parse error сохраняет прежнее observation. Higher-priority omission подавляет прежний lower-priority факт. `privacyMode` остаётся unsupported: источник, доказывающий этот факт без изменения настроек, не подключён.

Source order выделяется до HTTP без отдельной durable pending reservation. Побеждает порядок успешно сохранённого observation/tombstone; пропуски sequence после ошибки не становятся facts. Snapshot revision меняется только при сохранённом изменении. Legacy order0 сохраняет original observedAt и заполняет untouched source только при отсутствии committed live order. Два retained Codex источника пишутся одним batch/transaction; ошибка второго не оставляет half-initialized snapshot.

Reader принимает logical owner/account/profile и expected authorization epoch. Native recheck проверяет binding, physical generation/principal и текущую snapshot revision. Revoke/delete/reconnect делают старые сведения недоступными. UI не получает physical selectors. Timeout и local reader budget определены в [contracts](native-account-contracts.md); это не cluster limiter.

Credential rotation сохраняет stable identity. Old credential producer проигрывает CAS; credential expiry показывается лишь при совпадении observation/current revision. Другие historical facts сохраняют собственные observedAt/freshness. Read не продлевает возраст. Cleanup удаляет snapshot exact physical birth; старый worker не может его восстановить.

При refresh Codex/Claude/Grok обязательные owner/principal/birth/attempt/fence/version checks выполняются до optional metadata. Credentials и completed receipt коммитятся вместе. Один SAVEPOINT в этой транзакции охватывает весь AccountInfo batch: metadata error откатывает все его sources, а credential/receipt сохраняются только после успешных ROLLBACK TO и RELEASE. Unusable/canceled transaction или failed commit остаются unknown, без replay exchange. После успешной rotation с rollback facts старый expiry скрывается current revision, email/plan остаются historical observations. Connect, cached hydration и quota+info остаются полностью атомарными. Второго store, outbox и UnitOfWork нет.

### A4. Получение фактов без дополнительного запроса квот

Codex connect сохраняет allowlisted facts из проверенного ID token и selected account-check через existing custody/qualification lifecycle. Supplied email/plan/AT/ID импортированного файла не определяют principal. Account-check использует уже полученный response; admin enrichTokenInfo, меняющий настройки обучения, не переносится в reader.

`GatewayProviderQuotaCollector.FetchWithAccountInfo` извлекает quotas/plan из одного body. `StoreGatewayQuotaAndInfo` под exact physical lock и credential CAS сохраняет обе проекции одной transaction. Info order выделяется только для GLM/MiniMax: общий closed `GatewayAccountInfoPlanQuotaProfile` используется bootstrap и source validator. [Collector](https://github.com/agent-teams-ai/sub2api/blob/91d19700b05a8534dc1ba28538e8f67f6c94553d/backend/internal/gatewaybootstrap/native_provider_quota_linux.go). Дополнительных HTTP, polling и transaction framework нет.

Existing OAuth accounts заполняются через existing maintenance/refresh, без scheduler/read-side writes. Existing locked SELECT вычисляет private AccountInfoInitialized из exact snapshot identity; это не stored mirror flag. Только missing snapshot и доказанный original observedAt запускают hydration до2s. Следующий idle maintenance не добавляет отдельный metadata SQL. Sources одной initialization публикуются вместе; committed live observation/tombstone блокирует cached initialization.

Codex retained timing и исторически verified claims связаны existing custody proof; hydration не повторяет JWKS/refresh и не считает произвольный старый JWT доказательством. Claude/Grok восстанавливают expiry только при сохранённом исходном authenticated observation time. Иначе fields unknown до штатного свежего события. Открытие UI не вызывает provider.

Hydration error сохраняет account/credentials. Existing native control path возвращает typed unavailable, Gateway — deferred без изменения health/admission. Следующий нормальный maintenance может заполнить missing snapshot. Freshness остаётся native source policy, без отдельных правил SDK/UI.

### A5. Два импорта через существующий connect FSM

**Выбранное решение:** оба новых метода используют существующую таблицу и автомат `GatewayNativeOAuthConnect`. Полный `auth.json` сначала разбирается как контейнер RT, затем выполняется тот же один защищённый refresh exchange. Это делает полезным файл с истёкшими AT/ID и пригодным RT и исключает два разных механизма enrollment для свежего и старого файла.

Обычный refreshable файл отличается от PAT, API-key auth, Agent Identity и произвольного raw AT. Эти семейства отклоняются с конечной причиной. Поддерживаются выбранные канонические формы обычного Codex файла; duplicate keys и конфликтующие aliases отклоняются. Неизвестные отображаемые поля не превращаются в authority. Единственные ingress/material пределы и public `oauth_auth_json` → native `auth_json` mapping определены в [общем контракте](native-account-contracts.md); shared provider-response/bundle bounds не увеличиваются ради import.

Обычный административный импорт не подходит как готовый enrollment: он поддерживает bulk, raw tokens, другие auth-семейства, unsigned JWT decoding и свою политику поиска аккаунта. Защищённый connect использует строгий decoder token container рядом с существующим lifecycle. Bulk policy, неподтверждённые JWT claims и административный поиск аккаунта в него не переносятся; verification и provider exchange используют существующие native seams. [Административный parser](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/handler/admin/account_codex_import.go#L383-L774).

Современный официальный Codex хранит `oauth_provenance` с issuer/client ID. Явно несовместимое происхождение отвергается, отсутствующее обрабатывается как старый формат с фиксированным поддерживаемым Codex client. Содержимое файла никогда не задаёт URL, proxy, client override или redirect. Проверена версия `openai/codex@e1b755849216aacd40574b5ccf9ee18d18b1a867`: [структура файла](https://github.com/openai/codex/blob/e1b755849216aacd40574b5ccf9ee18d18b1a867/codex-rs/login/src/auth/storage.rs#L51-L70), [происхождение токенов](https://github.com/openai/codex/blob/e1b755849216aacd40574b5ccf9ee18d18b1a867/codex-rs/login/src/token_data.rs#L10-L39).

#### Изменение метода и хранения

Миграция добавляет методы `refresh_token` и `auth_json`, immutable input commitment и keyed fingerprint RT. Для import-методов redirect пустой, device-поля пустые, а transient envelope допускает выбранный увеличенный предел. Browser/device сохраняют свои фиксированные redirects и предел 1024 bytes. AAD включает новый метод и commitment; уже существующие browser/device ciphertexts продолжают расшифровываться прежним способом.

Это требует изменения реальных ограничений БД, не только enum TypeScript: [исходная таблица](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/migrations/245_gateway_oauth_connect_intents.sql#L1-L38), [method-specific guard](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/migrations/251_gateway_oauth_device_connect.sql#L1-L123). Новый bounded import decoder также используется private bootstrap: сейчас owner-authorizer ограничивает обычный body 4096 bytes. [Точка bootstrap](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/gatewaybootstrap/server_linux.go#L376-L445).

Persisted transient material содержит только нужный для exchange RT. Import-only AEAD codec шифрует raw RT bytes; scope/method/input commitment входят в AAD. JSON escaping перед encryption запрещён для import, чтобы сохранялся canonical 48 KiB bound; browser/device JSON/AAD остаются побайтно прежними. Полный файл, старые AT/ID и user-supplied metadata не нужны после разбора. Два domain-separated MAC из contracts различаются: inputMAC включает accepted input/scope/operation/method, а общий claimMAC — fixed issuer/client и exact RT без owner/method/operation. Exact replay возвращает прежний receipt; другой payload или метод при том же operation конфликтует. HMAC и fingerprint не публикуются и не логируются.

MAC получает domain-separated HMAC subkey из existing connect key, без нового secret/config. Миграция261 хранит commitment ключа в каждом import intent. EnterConnect под общей transaction advisory lock запрещает entry при существующем entered/unknown intent с другим commitment; prepared intent этот запрет не удерживает. После штатного закрытия всех таких claims можно использовать новый connect key. Неизвестный effect нельзя «разблокировать» удалением claim или сменой ключа. [SQL guard](https://github.com/agent-teams-ai/sub2api/blob/91d19700b05a8534dc1ba28538e8f67f6c94553d/backend/migrations/261_gateway_oauth_credential_import.sql).

#### Entry, receipt и неопределённый результат

После live owner authorization `EnterConnect` атомарно забирает право на внешний эффект. До этого не отправляется token request. Затем победитель делает один запрос на фиксированный OAuth endpoint, проверяет ответ, вызывает существующий `Stage` и завершает connect по точному enrollment commitment. `BindConnectEnrollment` и readback уже связывают custody commit с connect receipt, поэтому потерянный ответ БД восстанавливается чтением, без повторного refresh grant. [Существующий reconcile и Stage binding](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/native_gateway_oauth_connect.go#L350-L404).

Конкурирующие операции с тем же RT ограничивает partial unique claim только в состояниях `entered`/`unknown`. Он предотвращает повторный вход при незавершённом эффекте; доказанный `completed` освобождает claim. Вечный список «использованных RT» недопустим: провайдер может сохранить пригодный RT без ротации. При истечении prepared intent внешнего эффекта ещё нет. Разные owners получают одинаковую безопасную причину конфликта без информации о чужом аккаунте.

Timeout после entry означает неизвестный результат: провайдер мог выполнить refresh. Нет обещания exactly-once между БД и провайдером. Клиент не создаёт новую operation автоматически и не повторяет grant; читает прежний receipt. Unknown claim освобождается только после доказанного завершения; если результата восстановить нельзя, требуется новый независимый credential/повторная авторизация. Terminal-обработка удаляет transient secret, оставляя bounded evidence для reconciliation.

#### Доверие к ответу и отсутствие нового RT

Enrollment требует свежий access token и текущий криптографически проверяемый ID token из фиксированного authenticated exchange. Supplied ID/AT этого доказательства не заменяют. Если trusted principal установить нельзя, successful enrollment нет; после entry действует existing safe receipt/uncertainty contract. Import не обещает принять любой исторический файл, который ещё использует другой клиент.

Отсутствующий новый RT допускает сохранение именно submitted RT из захваченного intent. Это соответствует текущему официальному клиенту, сохраняющему старые значения при отсутствующих полях. Его optional response fields не доказывают наличие свежего ID во всех live случаях. [Официальное сохранение refresh](https://github.com/openai/codex/blob/e1b755849216aacd40574b5ccf9ee18d18b1a867/codex-rs/login/src/auth/manager.rs#L1760-L1803), [optional response](https://github.com/openai/codex/blob/e1b755849216aacd40574b5ccf9ee18d18b1a867/codex-rs/login/src/auth/manager.rs#L1889-L1894). Это отдельно квалифицируется: текущий native refresh Sub2API требует возвращённые RT/ID/AT. [Текущее требование](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/native_gateway_oauth_refresh.go#L153-L179).

После проверки `Stage` сохраняет прежние правила issuer/subject ownership и зашифрованного bundle. Email не участвует в dedup. Account-check остаётся обязательной qualification; receipt «custody сохранено» не означает «аккаунт уже пригоден для review».

## Examples

### Последовательность реализации

1. Зафиксировать общий контракт и deployed capability semantics. Добавить typed safe observation и запрет credential-dependent методов в интерфейсе reader.
2. Ввести snapshot migration/repository, exact-birth cleanup и чтение с повторной авторизацией. Проверить гонки до подключения источников.
3. Расширить результат существующего Codex account-check и quota collection. Добавить source replacement, атомарное сохранение и ограниченное заполнение старых аккаунтов.
4. Извлечь чистый разбор обычного `auth.json`; добавить strict import decoder и method-aware migration существующего connect FSM.
5. Подключить один fenced RT exchange, response verification, HMAC replay и reconciliation. Добавить bootstrap authorization и capability только после готовности полного пути.
6. Выполнить targeted fixtures, PostgreSQL qualification и joined exact SDK/facade/native/runner path. Native contract version подключается по [qualification](native-account-qualification.md). Live validation — отдельная категория evidence; production deployment не выполняется.

### Обязательные проверки

| Проверка | Наблюдаемое условие приёмки |
|---|---|
| Cached read | HTTP/decrypt/refresh зависимости отсутствуют; список аккаунтов всё равно возвращает разрешённый snapshot |
| Источники | Один ответ квот даёт quota + plan; timeout сохраняет старый факт; успешное отсутствие удаляет вклад конкретного источника |
| Identity races | После revoke/reconnect/delete старая generation не читается; worker со старой credential revision проигрывает CAS |
| Refresh metadata failure | Ошибка второго info source откатывает весь metadata batch; credential/receipt сохраняются; прежний expiry hidden by revision; replay не вызывает exchange |
| Import key rotation | Другой connect key при entered/unknown claim не создаёт новый entry; prepared сам по себе не блокирует key change |
| Exact replay | Один operation с тем же canonical input возвращает receipt; изменённый payload не создаёт второй эффект |
| Конкуренция RT | Два ingress-метода с одним RT имеют одного unresolved entry winner; известное completed не блокирует RT навсегда |
| Потерянные ACK | Проверены потери после prepare, entry, Stage и finish; ни один unknown путь не повторяет provider grant |
| Полный файл | Истёкшие supplied AT/ID не мешают успешному fresh exchange; PAT/AT-only/foreign provenance отвергаются |
| Неполный response | Нет нового RT — сохраняется exact input; нет доверенного свежего ID — нет успешного enrollment |
| Миграция | Существующие browser/device intents и ciphertexts продолжают работать с прежними ограничениями |

State-machine и SQL constraints проверяются настоящим PostgreSQL в тестовом окружении. Парсеры получают независимые provider fixtures с пропусками, конфликтами и неверными типами; они не проверяются только через моки, повторяющие реализацию. Live qualification подтверждает конкретную версию deployment и credential family, а не бессрочную работоспособность провайдера.

### Проверенное evidence и остаток

На checkpoint91d19700 code review исправления опубликованы; exact-head CI указан в qualification. До него locally прошли pure apicompat, native plan catalog/generated frontend checks и SQL smoke321 migrations с exact official tuples/negative guards. Это не результат новых Go repository tests. Самостоятельный TestGatewayAccountInfoCodexPostgresHydrationAndRefresh использует отдельную пустую БД, production ApplyMigrations и actual custody/FSM/HTTP verifier/repository с signed synthetic upstream. Новый SAVEPOINT/runtime result должен подтвердить CI; старый compilation/full-stack run его не заменяет.

### Объём и владение изменениями

Единая оценка и правила подсчёта находятся в [основном плане, §9](native-account-integration-plan.md). В A отдельно учтены M1 и оба импорта вместе; D/API-профили, Gateway и RR не входят в A. Handwritten Go/SQL/TS generator/lookup migration учитываются, generated artifacts и перемещения готовых строк — нет. Это бюджет планирования, не измеренная diff; локальная конкурирующая таблица удалена после R9.

Один native-owner отвечает за `native_gateway_oauth_connect.go`, его repository, migration guard и import decoder: изменения этих файлов не распараллеливаются между независимыми авторами. Snapshot-owner владеет новым хранилищем и читателем; provider-owner изменяет только чистые extraction seams и общий observation result по согласованному контракту. `gatewaybootstrap/server_linux.go`, существующий quota collector и catalog composition являются общими файлами: их интегрирует один назначенный автор после review профильных изменений.

### Definition of Done

Пакет завершён после exact-head проверок safe native→contract path, source withdrawal, physical/credential CAS, bounded retained hydration, двух imports и browser/device regression. Capabilities соответствуют composed paths. Evidence различает реальные PostgreSQL/HTTP/FSM на synthetic upstream, actual review runner, live-provider access и production deployment. Последние две категории не заявляются по результатам synthetic tests.
