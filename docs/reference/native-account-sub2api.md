---
id: docs.reference.native-account-sub2api
type: reference
status: proposed
owner: gateway-maintainers
summary: Реализация безопасных native snapshots, происхождения фактов и защищённых импортов Codex в существующем native lifecycle.
---

# Пакет A: нативные сведения и импорты Sub2API

## Overview

Этот документ описывает предстоящие изменения в Sub2API для выбранной волны: безопасные сведения об аккаунтах, фактически доступные способы подключения и два импорта Codex — refresh token и обычный полный `auth.json`, содержащий refresh token. Это план реализации, а не отчёт о работающем функционале. Производственный код, миграции и реальные авторизации в рамках подготовки документа не выполнялись.

Единственный источник provider-specific поведения — Sub2API. Здесь остаются обращения к провайдерам, проверка их ответов, интерпретация планов, преобразование протоколов и хранение секретов. Account Gateway использует заменяемый backend через нейтральный порт; Review Router получает безопасное представление через Gateway. Замена backend не требует переносить в Gateway парсеры JWT, названия полей квот или эвристики тарифов.

Общий wire-контракт, состояния ответа и версионирование определены в [контрактах](native-account-contracts.md). Этот документ определяет нативную реализацию, не создавая вторую DTO-спецификацию. Официальные API-профили Anthropic и Gemini описаны в [пакете профилей](native-account-provider-profiles.md); здесь учтены их сведения и граница с нативным lifecycle. OpenAI API key, mobile RT, AT-only, PAT, Agent Identity, новые подписочные OAuth-семейства и полное совпадение со всеми режимами административной формы в эту волну не входят.

### Проверенная исходная точка

Аудит привязан к `agent-teams-ai/sub2api@cfe50b7fd2aef08a7a17f11132cae73293804389`. Перед реализацией разработчик сравнивает изменившиеся файлы с этим SHA. Наличие административного обработчика само по себе не означает поддержку через закрытый native API.

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

Нельзя выводить публичного провайдера из `accounts.platform`: часть защищённых API-профилей хранится как `openai` ради совместимости инфраструктуры. Например, константа `GatewayMiMoResponsesProfile` имеет значение `openai-responses-apikey-v1`. Нужна явная нативная связь профиля с провайдером и продуктовым режимом. [Исходное определение](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/native_gateway_identity.go#L20-L49).

Общий код вводится там, где совпадает инвариант: авторизация, CAS, безопасный observation envelope, строгая обработка импорта. Не требуется общий DSL для всех способов входа, регистрация произвольных endpoint или переписывание административных сервисов. Это сохраняет DRY без объединения разных моделей доверия.

### A2. Сведения, происхождение и честные пробелы

Нативное представление содержит только разрешённые факты общего контракта. Email является отображаемым фактом, не ключом владения; план не даёт права маршрутизации; подпись ID token не означает автоматически `email_verified=true`. Сырой plan code сохраняется вместе с нормализованным нативным названием. Неизвестный код остаётся неизвестным кодом, а отсутствие сведений не превращается в Free.

| Источник | Что можно извлечь в выбранной волне | Что нельзя обещать |
|---|---|---|
| Codex: проверенный ID token и защищённый account-check | Email при наличии, выбранный provider account, personal/workspace plan и соответствующий ему срок | Email из произвольного импортированного JSON; смешанный personal plan и workspace expiry |
| Существующий Grok native | Безопасные факты из уже аутентифицированных identity/quota ответов после проверки связи с principal | Все поля обычного admin `GrokTokenInfo` без трассировки native источника |
| GLM Coding | Название/уровень из `data.level` того же ответа квоты | Email или персональную подписку, если endpoint их не сообщает |
| MiniMax M-Plan | Название из `current_subscribe_title` того же ответа | Расширенную billing-информацию, отсутствующую в native ответе |
| Kimi и другие уже подключённые API-профили | Фактически доступные идентификаторы/наблюдения по текущему источнику | Автоматическую почту и план только на основании наличия API key |
| Новые официальные Anthropic/Gemini API key | Провайдер, способ подключения и продуктовый API-профиль | Почту владельца или потребительскую подписку без защищённого источника |

GLM/MiniMax действительно имеют такие plan-поля в обычном сервисе; существующая native нормализация квот сейчас их отбрасывает. Это небольшая проекция существующего ответа, а не новый billing-интегратор. [Поля источника](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/cn_provider_quota_service.go#L250-L268).

Для OpenAI plan labels ввести один Go-owned data catalog codes/aliases/status/analytics labels; native formatter читает его, admin frontend получает generated data по существующему образцу platform catalog. Ручной switch в `frontend/src/utils/planType.ts` заменяется lookup по generated data; значения analytics и consumers вроде credentialsBuilder сохраняются. Не вводить второй editable formatter в native рядом с прежним frontend switch и не переводить весь admin account lifecycle на новый protected API.

Нельзя формулировать общее правило «API key никогда не даёт email»: например, Cline обращается к `/users/me`, но текущая реализация извлекает только ID. Сам Cline не добавляется в выбранную native волну, поэтому это ограничение будущего профиля, а не повод объявить его поддержку сейчас. [Существующий запрос Cline](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/cline_usage.go#L108-L163).

OpenAI `enrichTokenInfo` нельзя использовать целиком: после чтения он вызывает изменение настройки обучения. Выделяется чистая проекция уже полученных данных; privacy выводится только как реально наблюдённый факт. Отдельное изменение настройки остаётся отдельной командой вне этой задачи. [Смешанные эффекты и защита соответствия подписки](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/openai_oauth_service.go#L257-L307).

### A3. Snapshot, актуальность и principal

Добавляется отдельное нативное хранилище account-info snapshots. Оно содержит безопасную проекцию, ревизию, exact physical birth, generation и стабильную версию principal. Секреты, исходные HTTP bodies, `credentials`, `extra`, JWT и AEAD envelope туда не попадают. Размеры строк, количество фактов и общий JSON ограничены контрактом; произвольного `metadata: Record<string, unknown>` нет.

У каждого источника сохраняется время наблюдения; при наличии отдельно сохраняется время, заявленное провайдером. Повторное чтение не обновляет ни одно из них. Нативная политика свежести задаёт срок пригодности наблюдения и передаёт его по общему контракту. Gateway и UI не заводят собственные таймеры тарифной истины. Истёкшая свежесть не удаляет исторический факт: он становится явно устаревшим до следующего успешного наблюдения или отзыва источника.

Одно успешное полное наблюдение заменяет принадлежащие этому источнику поля, включая удаление ранее присутствовавшего поля. Ошибка HTTP, timeout или ошибка парсинга сохраняет последнее корректное наблюдение. Отзыв источника удаляет его вклад и не восстанавливает старый факт из другой случайной копии. Если несколько источников способны сообщить одно поле, порядок предпочтения фиксируется в Sub2API и проверяется тестом. Для personal/workspace подписок сопоставляются scope и account; несогласованные срок и план не объединяются.

Private sourceKey определяет конкретный endpoint/semantic scope; один public `provider_api` для этого недостаточен. Source order резервируется до HTTP согласно contracts и сохраняется вместе с полным omission. CAS по credentials дополняется проверкой этого порядка: поздний response той же credential revision не восстанавливает отозванный тариф. Native snapshotRevision отдельно от Gateway metadataRevision; повторное чтение возвращает новое согласованное содержимое при росте revision. Проверить withdrawal между двумя чтениями при неизменной identity.

Чтение выполняется по логическим owner/account/profile и ожидаемой authorization epoch. UI не передаёт физический native ID. Перед чтением проверяется текущая связь логического и физического аккаунта; перед возвратом проверка повторяется. При revoke, смене owner, удалении, reconnect или изменении generation старый snapshot недоступен. При гонке читатель возвращает новое согласованное состояние либо недоступность, но не устаревший результат предыдущего владельца.

Токен может обновиться без смены principal. Поэтому credential revision не является идентичностью snapshot; иначе обычный refresh постоянно удалял бы отображаемые сведения. При записи она, напротив, обязательна: observation, полученный со старой версией credentials, не должен победить CAS после ротации. Этот принцип уже реализован для лимитов: [стабильный principal](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/native_gateway_account_limits_v2.go#L149-L162), [проверка версии при сохранении](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/repository/native_gateway_account_limits_v2.go#L119-L160).

При cleanup удаляется snapshot именно очищаемого physical birth. Устаревший worker не может заново создать его после удаления. Миграция не переносит в snapshot произвольные admin credentials: у существующих аккаунтов первое состояние будет «ещё не наблюдалось», пока не завершится разрешённое native обогащение.

### A4. Получение фактов без дополнительного запроса квот

Подключение Codex уже проверяет ID token и вызывает account-check. Нужно расширить внутренний результат этого вызова: сохранить выбранный account и безопасные display facts вместе с доказательством qualification. Строгий выбор единственного пригодного аккаунта сохраняется; email, plan и подсказки из импортированного файла не выбирают principal. [Текущий вызов и выбор](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/native_gateway_oauth_dispatch.go#L197-L354).

Сборщик квот получает внутренний typed observation: квоты, безопасные сведения и момент наблюдения из одного HTTP body. Для записи выделяется один узкий repository operation `StoreGatewayNativeObservation`: он берёт exact-physical lock, проверяет principal/credential revision и сохраняет quota + info в **одной SQL transaction**. Два независимых вызова `StoreGatewayAccountLimitsV2` и нового info repository не обеспечивают эту гарантию: текущий quota writer сам открывает transaction. Его общий write helper переиспользуется внутри нового operation; отдельные read ports остаются. Общий UnitOfWork framework не нужен. Не создаются второй polling loop, отдельный запрос ради названия плана или обход существующего advisory lease.

Для уже подключённых аккаунтов предусмотрена только однократная bounded hydration из [контрактов](native-account-contracts.md): явные logical refs, существующая native authorization/lease, старое проверенное наблюдение либо допустимый read-only источник. Она выполняется при rollout отдельно от DB migration и UI. Новый recurring maintenance worker, due scheduler или queue не создаются. Дальнейшие наблюдения приходят из существующих lifecycle/quota путей. Если источник отсутствует или требует недопустимого refresh, результат остаётся unknown/stale без нового механизма получения credentials.

Для cached observation сохранить original source order, если он есть. Legacy cache без order может заполнить только untouched slot под той же physical/principal/credential блокировкой, включая отсутствие tombstone/reservation; новый live order ему не выдаётся. Реальный HTTP hydration резервирует order обычным образом. Независимый test проверяет оба порядка legacy cached Pro vs fresh authoritative omission. Также source resolution не восстанавливает lower-priority imported/inferred plan после authoritative higher-priority omission в том же scope.

Начальные freshness/read/hydration budgets уже заданы единой таблицей и правилами в [contracts](native-account-contracts.md); implementation переносит их в native policy/config, не выбирает повторно в A/B/C. Это эксплуатационные параметры источника, не достоверность provider facts. Проверка DoD подтверждает, что переключение страниц не запускает provider requests, а параллельные экземпляры сохраняют existing native lease/CAS и не выдают per-instance limits за cluster capacity.

### A5. Два импорта через существующий connect FSM

**Выбранное решение:** оба новых метода используют существующую таблицу и автомат `GatewayNativeOAuthConnect`. Полный `auth.json` сначала разбирается как контейнер RT, затем выполняется тот же один защищённый refresh exchange. Это делает полезным файл с истёкшими AT/ID и пригодным RT и исключает два разных механизма enrollment для свежего и старого файла.

Обычный refreshable файл отличается от PAT, API-key auth, Agent Identity и произвольного raw AT. Эти семейства отклоняются с конечной причиной. Поддерживаются выбранные канонические формы обычного Codex файла; duplicate keys и конфликтующие aliases отклоняются. Неизвестные отображаемые поля не превращаются в authority. Единственные ingress/material пределы и public `oauth_auth_json` → native `auth_json` mapping определены в [общем контракте](native-account-contracts.md); shared provider-response/bundle bounds не увеличиваются ради import.

Обычный административный импорт не подходит как готовый enrollment: он поддерживает bulk, raw tokens, другие auth-семейства, unsigned JWT decoding и свою политику поиска аккаунта. Из него извлекается только чистый разбор token container. Существующее административное поведение остаётся отдельной политикой, native вызывает собственный строгий validator. [Административный parser](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/handler/admin/account_codex_import.go#L383-L774).

Современный официальный Codex хранит `oauth_provenance` с issuer/client ID. Явно несовместимое происхождение отвергается, отсутствующее обрабатывается как старый формат с фиксированным поддерживаемым Codex client. Содержимое файла никогда не задаёт URL, proxy, client override или redirect. Проверена версия `openai/codex@e1b755849216aacd40574b5ccf9ee18d18b1a867`: [структура файла](https://github.com/openai/codex/blob/e1b755849216aacd40574b5ccf9ee18d18b1a867/codex-rs/login/src/auth/storage.rs#L51-L70), [происхождение токенов](https://github.com/openai/codex/blob/e1b755849216aacd40574b5ccf9ee18d18b1a867/codex-rs/login/src/token_data.rs#L10-L39).

#### Изменение метода и хранения

Миграция добавляет методы `refresh_token` и `auth_json`, immutable input commitment и keyed fingerprint RT. Для import-методов redirect пустой, device-поля пустые, а transient envelope допускает выбранный увеличенный предел. Browser/device сохраняют свои фиксированные redirects и предел 1024 bytes. AAD включает новый метод и commitment; уже существующие browser/device ciphertexts продолжают расшифровываться прежним способом.

Это требует изменения реальных ограничений БД, не только enum TypeScript: [исходная таблица](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/migrations/245_gateway_oauth_connect_intents.sql#L1-L38), [method-specific guard](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/migrations/251_gateway_oauth_device_connect.sql#L1-L123). Новый bounded import decoder также используется private bootstrap: сейчас owner-authorizer ограничивает обычный body 4096 bytes. [Точка bootstrap](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/gatewaybootstrap/server_linux.go#L376-L445).

Persisted transient material содержит только нужный для exchange RT. Import-only AEAD codec шифрует raw RT bytes; scope/method/input commitment входят в AAD. JSON escaping перед encryption запрещён для import, чтобы сохранялся canonical 48 KiB bound; browser/device JSON/AAD остаются побайтно прежними. Полный файл, старые AT/ID и user-supplied metadata не нужны после разбора. Два domain-separated MAC из contracts различаются: inputMAC включает accepted input/scope/operation/method, а общий claimMAC — fixed issuer/client и exact RT без owner/method/operation. Exact replay возвращает прежний receipt; другой payload или метод при том же operation конфликтует. HMAC и fingerprint не публикуются и не логируются.

#### Entry, receipt и неопределённый результат

После live owner authorization `EnterConnect` атомарно забирает право на внешний эффект. До этого не отправляется token request. Затем победитель делает один запрос на фиксированный OAuth endpoint, проверяет ответ, вызывает существующий `Stage` и завершает connect по точному enrollment commitment. `BindConnectEnrollment` и readback уже связывают custody commit с connect receipt, поэтому потерянный ответ БД восстанавливается чтением, без повторного refresh grant. [Существующий reconcile и Stage binding](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/native_gateway_oauth_connect.go#L350-L404).

Конкурирующие операции с тем же RT ограничивает partial unique claim только в состояниях `entered`/`unknown`. Он предотвращает повторный вход при незавершённом эффекте; доказанный `completed` освобождает claim. Вечный список «использованных RT» недопустим: провайдер может сохранить пригодный RT без ротации. При истечении prepared intent внешнего эффекта ещё нет. Разные owners получают одинаковую безопасную причину конфликта без информации о чужом аккаунте.

Timeout после entry означает неизвестный результат: провайдер мог выполнить refresh. Нет обещания exactly-once между БД и провайдером. Клиент не создаёт новую operation автоматически и не повторяет grant; читает прежний receipt. Unknown claim освобождается только после доказанного завершения; если результата восстановить нельзя, требуется новый независимый credential/повторная авторизация. Terminal-обработка удаляет transient secret, оставляя bounded evidence для reconciliation.

#### Доверие к ответу и отсутствие нового RT

Enrollment требует свежий access token и текущий криптографически проверяемый ID token, полученные через фиксированный аутентифицированный exchange. Supplied ID/AT не подменяют это доказательство. Если ответ не позволяет установить доверенный principal, возвращается явная конечная причина `no_trusted_identity`; операция после entry остаётся неопределённой в части внешнего эффекта. Нельзя обещать успешный native импорт каждого исторического файла, который иной клиент ещё способен использовать.

Отсутствующий новый RT допускает сохранение именно submitted RT из захваченного intent. Это соответствует текущему официальному клиенту, сохраняющему старые значения при отсутствующих полях. Его optional response fields не доказывают наличие свежего ID во всех live случаях. [Официальное сохранение refresh](https://github.com/openai/codex/blob/e1b755849216aacd40574b5ccf9ee18d18b1a867/codex-rs/login/src/auth/manager.rs#L1760-L1803), [optional response](https://github.com/openai/codex/blob/e1b755849216aacd40574b5ccf9ee18d18b1a867/codex-rs/login/src/auth/manager.rs#L1889-L1894). Это отдельно квалифицируется: текущий native refresh Sub2API требует возвращённые RT/ID/AT. [Текущее требование](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/backend/internal/service/native_gateway_oauth_refresh.go#L153-L179).

После проверки `Stage` сохраняет прежние правила issuer/subject ownership и зашифрованного bundle. Email не участвует в dedup. Account-check остаётся обязательной qualification; receipt «custody сохранено» не означает «аккаунт уже пригоден для review».

## Examples

### Последовательность реализации

1. Зафиксировать общий контракт и deployed capability semantics. Добавить typed safe observation и запрет credential-dependent методов в интерфейсе reader.
2. Ввести snapshot migration/repository, exact-birth cleanup и чтение с повторной авторизацией. Проверить гонки до подключения источников.
3. Расширить результат существующего Codex account-check и quota collection. Добавить source replacement, атомарное сохранение и ограниченное заполнение старых аккаунтов.
4. Извлечь чистый разбор обычного `auth.json`; добавить strict import decoder и method-aware migration существующего connect FSM.
5. Подключить один fenced RT exchange, response verification, HMAC replay и reconciliation. Добавить bootstrap authorization и capability только после готовности полного пути.
6. Выполнить targeted fixtures/PostgreSQL qualification, затем отдельную проверку с контролируемым реальным аккаунтом. Переключить Gateway на объявленную новую native contract version по [плану qualification](native-account-qualification.md).

### Обязательные проверки

| Проверка | Наблюдаемое условие приёмки |
|---|---|
| Cached read | HTTP/decrypt/refresh зависимости отсутствуют; список аккаунтов всё равно возвращает разрешённый snapshot |
| Источники | Один ответ квот даёт quota + plan; timeout сохраняет старый факт; успешное отсутствие удаляет вклад конкретного источника |
| Identity races | После revoke/reconnect/delete старая generation не читается; worker со старой credential revision проигрывает CAS |
| Exact replay | Один operation с тем же canonical input возвращает receipt; изменённый payload не создаёт второй эффект |
| Конкуренция RT | Два ingress-метода с одним RT имеют одного unresolved entry winner; известное completed не блокирует RT навсегда |
| Потерянные ACK | Проверены потери после prepare, entry, Stage и finish; ни один unknown путь не повторяет provider grant |
| Полный файл | Истёкшие supplied AT/ID не мешают успешному fresh exchange; PAT/AT-only/foreign provenance отвергаются |
| Неполный response | Нет нового RT — сохраняется exact input; нет доверенного свежего ID — нет успешного enrollment |
| Миграция | Существующие browser/device intents и ciphertexts продолжают работать с прежними ограничениями |

State-machine и SQL constraints проверяются настоящим PostgreSQL в тестовом окружении. Парсеры получают независимые provider fixtures с пропусками, конфликтами и неверными типами; они не проверяются только через моки, повторяющие реализацию. Live qualification подтверждает конкретную версию deployment и credential family, а не бессрочную работоспособность провайдера.

### Объём и владение изменениями

Единая оценка и правила подсчёта находятся в [основном плане, §9](native-account-integration-plan.md). В A отдельно учтены M1 и оба импорта вместе; D/API-профили, Gateway и RR не входят в A. Handwritten Go/SQL/TS generator/lookup migration учитываются, generated artifacts и перемещения готовых строк — нет. Это бюджет планирования, не измеренная diff; локальная конкурирующая таблица удалена после R9.

Один native-owner отвечает за `native_gateway_oauth_connect.go`, его repository, migration guard и import decoder: изменения этих файлов не распараллеливаются между независимыми авторами. Snapshot-owner владеет новым хранилищем и читателем; provider-owner изменяет только чистые extraction seams и общий observation result по согласованному контракту. `gatewaybootstrap/server_linux.go`, существующий quota collector и catalog composition являются общими файлами: их интегрирует один назначенный автор после review профильных изменений.

### Definition of Done

Пакет завершён, когда безопасные сведения проходят от нативного источника до общего contract без дублированного provider parsing; old/new generation, source withdrawal и credential CAS проверены; оба импорта входят в один existing FSM и не повторяют неопределённый обмен; browser/device regression suite остаётся зелёным; native capabilities соответствуют реально доступным путям. В evidence фиксируются SHA, migrations, fixtures, результаты PostgreSQL и контролируемой live qualification. До появления этих результатов статус документа остаётся `proposed`, а наличие плана не трактуется как implemented support.
