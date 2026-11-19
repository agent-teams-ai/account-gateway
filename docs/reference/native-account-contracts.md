---
id: docs.reference.native-account-contracts
type: reference
status: proposed
owner: gateway-maintainers
summary: Единые безопасные контракты AccountInfo, возможностей подключения и импортов для заменяемого backend.
---

# Нативные аккаунты: контракты и инварианты

## 1. Владелец и статус

Это единственная спецификация новых публичных semantics для [основного плана](native-account-integration-plan.md). Endpoints/types ниже — **зафиксированный контракт, реализованный в текущих PR**. Exact schemas, сериализация и fixtures принадлежат Gateway; пакеты A–D не создают альтернативных DTO. Внешние Go/TypeScript представления одного wire допустимы, но совместимость доказывается независимыми fixtures. Runtime qualification записана отдельно и не выводится из наличия этой спецификации.

Публичная wire schema принадлежит `@agent-teams/account-gateway/contracts`; private Sub2API wire принадлежит native boundary. Gateway адаптирует private proof/identity к своему публичному accountRef. Ни browser, ни RR application не импортируют Go/admin DTO, `nativeId`, физическую binding структуру или provider claim payload.

## 2. Обязательные инварианты

| ID | Гарантия |
| --- | --- |
| I1 | Сведения провайдера получаются и нормализуются только native backend. Gateway/RR не обращаются к provider identity API и не декодируют provider JWT |
| I2 | Весь AccountInfo — positive allowlist. Никаких raw credentials, adminAccount, `extra: Record<string,unknown>`, provider errors/headers, cookies, tokens, upstream URLs |
| I3 | Факты принадлежат конкретным логическому account и native principal/generation. Email не является ключом ownership, dedup или reconnect |
| I4 | Reconnect/delete/epoch change не оставляют видимым snapshot прежней identity. Same-principal credential refresh не обязан стирать корректные факты |
| I5 | Нативная запись snapshot дополнительно проверяет credential revision: старый HTTP ответ не перезаписывает сведения после ротации |
| I6 | Metadata read не выполняет provider HTTP, token refresh, privacy mutation, quota refresh, inference или account activation |
| I7 | Нет достоверного факта — нет выдуманного email/плана/expiry. Product label и actual subscription имеют разные поля |
| I8 | Import входит в существующую account operation. После неизвестного результата provider exchange автоматический повтор запрещён; readback сохраняет uncertainty |
| I9 | Видимость email/плана определяет consumer product policy, native/Gateway дополнительно enforce consumer/owner/account scope |
| I10 | Metadata не влияет на readiness, модельный admission, entitlement и review selection. Их существующие владельцы сохраняются |

## 3. Безопасный AccountInfo

### 3.1. Read endpoint и identity

Предлагается **`POST /v1/account-info/read`**, `contract: account-info/v1`. POST выбран для bounded списка opaque refs без URL/логов на каждую строку; операция семантически read-only. SDK management client получает `readAccountInfo(...)`. Endpoint регистрируется в существующей bounded read admission lane.

Request содержит `ownerRef` и до **50** уникальных `accountRef`. `consumerId` выводится из authenticated bearer. Модель visibility пользовательского приложения в request не передаётся. Gateway проверяет свой bearer scope, owner/account association и envelope до обращения к backend. Список от чужого owner не раскрывает существование account; применяется существующая публичная not-found/denied политика.

Ответ содержит по одному результату на разрешённый запрошенный ref; лишние refs, дубликаты и перестановка identity внутри результата отвергаются. Snapshot включает `accountRef`, существующие `metadataRevision` и `authorizationEpoch`, а private native proof содержит generation/principal binding. Private proof не попадает в browser. Нельзя считать `metadataRevision` синонимом native credential revision.

`metadataRevision` остаётся ревизией Gateway account metadata. Native `snapshotRevision` принадлежит read model facts и меняется при accepted observation/withdrawal; он передаётся как отдельный bounded opaque `infoRevision` для equality, без provider/physical details. Gateway не пишет свою account revision ради provider polling. Native final read recheck возвращает текущий snapshot при выросшей snapshotRevision, либо unavailable — никогда прежний тариф после уже принятого withdrawal при той же identity.

Gateway после всех awaited reads выполняет финальную authority observation **всех выдаваемых refs** непосредственно перед сериализацией batch. Изменение owner/grant/generation/epoch подавляет соответствующие facts по существующей denied/not-found policy. Это гарантия публичного SDK для любого consumer; финальная product-policy проверка RR дополняет её и не заменяет.

В первой реализации нет public push subscription, общего metadata search, pagination cursor на все native accounts, refresh-on-read и отдельной browser persistent cache. Native batch/внутренние bounded reads может выбрать backend, сохранив один public read contract.

Начальная read policy — инженерный выбор проекта, не измеренная производительность или SLA:

| Параметр | Начальный предел |
| --- | ---: |
| Refs / serialized read request | 50 / 16 KiB |
| Serialized safe result одного account / всего batch | 8 KiB / 512 KiB |
| Opaque infoRevision | 128 ASCII bytes |
| Gateway batch, включая финальную authority observation | 2,5 s; новые source reads прекращаются после 2 s |
| RR page, включая финальную product authority observation | 3 s; последние 500 ms зарезервированы для final fence |
| Native reads одного consumer/owner на service instance | 2 одновременно, поверх существующей общей native-control admission |
| Batches в RR page | До 4 одновременно; refs группируются по owner и лимиту 50 |

`readAccountInfo` получает method-specific SDK response bound 512 KiB: существующий transport default 64 KiB недостаточен для такого batch и сохраняется у остальных методов. Exact packed SDK тестирует max-bound Unicode/JSON-escaped strings и over-limit disposal. Limits считают **сериализованные bytes**, не только число символов. Per-field bounds остаются дополнительными ограничениями.

Финальная authority observation использует один bounded/set-based lookup по всем refs, где это допускает existing store; не 50 последовательных произвольных transactions. Deadline отменяет незавершённые reads и освобождает ресурсы. Если final authority не успела или отказала, private facts не возвращаются; публичная unavailable не доказывает существование foreign account. RR передаёт source deadline с учётом собственного оставшегося final-fence budget. Новая очередь, scheduler или distributed semaphore не вводятся: переиспользуется существующий admission, с bounded owner counters только для активной работы. Текущие 6 native-control slots и 2 direct-control headroom не расширяются. Это per-instance bounds, не выдуманная cluster throughput гарантия; межэкземплярные provider effects сохраняют existing native lease/CAS.

### 3.2. Поля

| Поле | Смысл | Ограничение |
| --- | --- | --- |
| `email` | Provider account email, если источник его подтверждает | До 320 символов; отображаемый факт, не идентификатор или claim для авторизации |
| `accountLabel` | Безопасное native external account label, если полезно вместо email | До 200 символов; не raw subject/token |
| `subscription` | Вместе: native code, display label, personal/organization/workspace/unknown scope, subscription end | Code до 100, label до 160; тариф и конец относятся к одной подписке/principal |
| `credentialExpiresAt` | Срок credential, если его раскрытие безопасно и факт известен | Не срок подписки и не обещание auto-refresh |
| `privacyMode` | Только реально полученная безопасная настройка | Закрытое значение; отсутствующее нельзя заменять `private` |

Не добавляем произвольную коллекцию badges или JSON metadata renderer. Новое поле проходит privacy review и явную версию/согласованную проекцию: strict decoder старого контракта не обязан принимать дополнительные ключи. Profile/product label уже есть в capabilities; его не дублируем как actual subscription.

Каждое поле имеет один небольшой closed result:

- `known`: value, source, `observedAt`, freshness (`current` или `stale`).
- `unknown`: источник поддерживается, достоверное значение пока не получено/не сообщено.
- `unsupported`: в этом профиле нет разрешённого источника такого факта.
- `unavailable`: получить/сохранить факт сейчас не удалось и безопасного последнего значения нет.

Если последнее допустимое значение есть, временная ошибка даёт `known + stale`, а не ложный `unknown` или старое значение с новой датой. Эти четыре состояния — не четыре services/classes. Одна общая schema/helper достаточно. На уровне аккаунта остаётся простой `available | unavailable | unsupported`; `available` может содержать неизвестные отдельные поля. Authorisation failure не превращается в `unavailable` с сохранённым чужим snapshot.

### 3.3. Происхождение и даты

`source` — closed enum: `provider_api`, `verified_claim`, `imported`, `user_supplied`, `inferred`. Значение из payload неподписанного JWT — `imported`, а не `verified_claim`. Новые Codex imports **не берут email/tier из supplied auth.json**: факты появятся после native verification/доверенного provider response. Если provider не позволяет получить факт, UI честно оставляет unknown.

Subscription end различает точный UTC timestamp и календарную дату, если upstream предоставляет только дату. Не добавляем полночь UTC к date-only значению: это меняет смысл при отображении в другой timezone. Отсутствующая дата означает «не сообщена», а не «бессрочно». `observedAt` — время наблюдения факта; `credentialExpiresAt` — срок токена; quota reset остаётся в limits contract. Frontend форматирует локаль и даты, native определяет семантику и plan label.

`pro → Pro 200` сейчас является UI интерпретацией в Sub2API. Текущий helper также различает status и analytics labels. Единый Go-owned справочник canonical codes, aliases и обеих display labels используется native formatter; public AccountInfo получает status label. Для admin frontend справочник генерируется как data artifact по существующему образцу `platformCatalog.builtin.json`, с sync-test и без ручного второго switch. Это не перевод всего admin lifecycle на protected AccountInfo. Не копировать правила в Gateway/RR и не менять analytics semantics случайно. Неизвестный code показывается безопасным native label/raw code без ложной классификации. [Текущий helper](https://github.com/agent-teams-ai/sub2api/blob/cfe50b7fd2aef08a7a17f11132cae73293804389/frontend/src/utils/planType.ts).

### 3.4. Freshness и source withdrawal

Native хранит snapshot с identity binding и per-field observation. Не создаём таблицы provider facts в Gateway или RR. Выбранное native storage — отдельный bounded read-model snapshot по exact account birth/generation, как в существующем limits snapshot подходе. Не помещаем facts в `credentials/extra`: их строгие shape guards имеют другое назначение. Это не второй account aggregate. Quota и info читаются раздельными narrow ports, а одно общее наблюдение записывается одной native transaction.

Правила записи:

1. Producer на уже выполняемом authenticated exchange/quota/identity read формирует candidate facts.
2. Source-scoped patch перечисляет, какие поля этот источник действительно авторитетно покрывает. Отсутствие поля в неполном ответе не считается удалением.
3. Валидный полный ответ с авторитетным отсутствием снимает старое значение **только того же source/scope**, исключая «вечный Pro» после окончания подписки.
4. Timeout/malformed response не стирает последнее корректное значение; native помечает его stale согласно своей freshness policy, сохраняя исходный observedAt.
5. Запись через CAS проверяет native principal/generation и credential revision. Несовпадение — discard, не перенос на новый аккаунт.

Дополнительно нужен bounded private `sourceKey` (endpoint + semantic scope), отличный от публичного enum provenance. Порядок наблюдений выделяется native **до HTTP** через существующую PostgreSQL sequence; это монотонный source order, не часы другого host и не время завершения ответа. Отдельной таблицы pending reservations нет: fence проверяет сохранённые source orders и exact physical/credential identity. Более новый accepted order заменяет старый; точный replay идемпотентен. Полный omission сохраняет tombstone/order даже без value. Поздний старый response не восстанавливает снятые факты. Это часть snapshot repository, без event store/очереди.

При нескольких разрешённых источниках одного поля authoritative omission более приоритетного источника подавляет старое lower-priority imported/inferred значение того же semantic scope. Нельзя сделать fallback к старому Pro только потому, что новый authoritative response не содержит plan. Приоритет и полное покрытие полей заданы native source policy; partial response/transport error такого tombstone не создаёт.

Freshness budget хранится в native profile policy, а не тремя TTL-константами в проектах. Начальные инженерные defaults: email/accountLabel становятся stale через 24 h, subscription/privacy — через 15 min; verified claims дополнительно ограничены сроком проверенного токена. Credential expiry относится к текущей credential revision: ротация снимает только этот факт до нового наблюдения, а не всю identity. Эти thresholds — честная маркировка возраста, не provider guarantee; изменить их можно одним native policy change с evidence, без SDK/UI release. Page read не запускает сетевое обновление. Если регулярного существующего источника нет, используем stale/unknown; отдельный metadata scheduler не входит в M1. Явный refresh может быть отдельной следующей задачей.

Для уже подключённых аккаунтов M1 использует **существующий maintenance lifecycle**. Его обычный identity read вычисляет наличие snapshot по exact account birth/generation/principal; при отсутствии и наличии исходного проверенного наблюдения выполняется native initialization без provider HTTP. Отдельные endpoint, rollout-скрипт и recurring worker не добавляются. Сохраняется исходный observedAt; отсутствие доказанного источника даёт unknown. Ошибка initialization проходит existing unavailable/deferred путь, не меняя credentials/health.

Каждая initialization ограничена existing maintenance selector одного аккаунта и context deadline **2 s**. Она не обходит maintenance admission/cursor и не вводит отдельный bulk action. Следующий штатный tick может повторить initialization после deferred результата; уже инициализированный principal определяется индексированным hint обычного read. Первоначальная идея отдельной hydration-команды заменена этим более узким решением.

**Cached hydration не получает новый live order.** Legacy observation без исходного order допускается только initialize-if-untouched под existing physical/principal/credential lock. Сохранённый live order/tombstone запрещает cached initialization; exact source-zero replay требует идентичного payload. Несколько legacy sources записываются одним batch: Codex verified claims + credential expiry не могут частично инициализировать snapshot. Пока live HTTP ещё выполняется, initial cached facts могут быть показаны с исходным observedAt; последующий accepted live observation всегда побеждает. Это не обещание durable pending reservation. Race fixture проверяет оба порядка cached initialization и committed omission.

## 4. Connection capabilities v2

Добавить **`GET /v2/provider-connection-capabilities`**, `contract: provider-connections/v2`, и `getProviderConnectionCapabilitiesV2()` в existing client. Это не новая версия всех OAuth endpoints.

Canonical operational descriptor получается из **одного native catalog/composition source**. Gateway пересекает его с deployment registration/allowed profile policy; RR дополнительно применяет свою product-supported policy. Broad admin platform catalog не публикуется как набор рабочих интеграций. Provider identity определяется descriptor, не префиксом profile ID или physical platform: текущий `openai-responses-apikey-v1` относится к MiMo. [Gateway definition](https://github.com/agent-teams-ai/account-gateway/blob/1dce5c327d14e9c0e5466da91441faa0d0ae38a5/services/account-gateway/src/provider-connections.ts).

В v2 нужны только:

- stable bounded `profileId`, provider `id` и safe label; новые provider ID допустимы как данные, не как executable plugin;
- существующие protocol/model/region/product semantics;
- **closed** descriptors способов: `api_key`, `browser`, `device_code`, `credential_import`;
- для import — closed method `refresh_token | oauth_auth_json` и размер; native профиль определяет, какие из них поддержаны;
- create/reconnect support и конечные unavailable/unsupported состояния;
- `accountInfo` support независимо от `limitsContract` и account-model support.

Не вводим JSON Schema form builder, произвольные поля, callback functions, custom URL, скрипты UI или динамический provider module loader. V2 schema на G0/M1 сразу содержит все выбранные methods; M2 только включает qualified descriptors. Неизвестный kind/поле нарушает closed v2 и даёт `invalid_response`, не превращается в API key и не молча пропускается tolerant parser. Будущий новый method/поле требует согласованной версии/проекции; bounded provider IDs остаются данными и не требуют нового vendor enum.

**v1 compatibility на время миграции:** endpoint, schema и метод SDK v1 остаются чистой проекцией того же snapshot: только представимые combinations, без Gemini/import methods. Никакого второго редактируемого catalog. Выбран coordinated rollout: сначала v2 producer, затем новый SDK/RR. **Автоматического runtime fallback/probing v2 → v1 нет.** Старый facade возвращает для неизвестного маршрута 400 invalid_request; 400/404/denied/timeout не доказывают unsupported. Ошибка v2 остаётся ошибкой discovery, новые choices unavailable, existing execution/account data не превращаются в invalid credentials. Старые consumers продолжают обращаться к v1 до обновления.

Владелец временной compatibility — gateway-maintainers. После подтверждения inventory всех зарегистрированных consumer exact archives и minimum rollback image с v2 отдельный minor 0.x migration PR удаляет **только capability v1** route/export/projection. Existing OAuth/account operation v1 и durable recovery не удаляются. Критерий задан evidence, не произвольной датой; transition removal task входит в release checklist.

## 5. Выбранный credential import

### 5.1. Public ingress и операция

Secret input разрешён только server-side `/http` entry. `/contracts` содержит safe method descriptors/results, без reusable secret DTO в browser-safe exports. Browser форма неизбежно принимает пользовательский ввод, но server action немедленно передаёт его через защищённый write-only ingress и очищает локальное состояние; secret никогда не входит в AccountInfo/operation readback.

В existing create/reconnect command добавляется **отдельный закрытый import branch**, не разрешение прежнего `credential.kind=oauth`. Branch содержит method и opaque bounded secret text; JSON provider format интерпретирует только native. Existing operation ID/idempotency/intent связываются с consumer, owner, target, profile, method и keyed input digest. Новый public submit endpoint/SDK helper, если нужен для secret admission, использует ту же durable operation, не отдельный operation журнал.

Legacy Operation envelope сохраняется: его optional `oauthMethod` допускает только browser/device_code и **отсутствует для import**. Новый method хранится во внутреннем intent и новом submit descriptor, не записывается в старое поле и не выдаётся за browser. Safe operation readback после import должен декодироваться старым packed SDK. Секретный submit contract не обязан быть доступен старому клиенту.

Пределы выбранного import задаются здесь; пакеты и capabilities используют их, не задают вторые значения:

| Граница | Максимум | Назначение |
| --- | ---: | --- |
| Декодированный secret text | 64 KiB UTF-8 | Один RT или один обычный auth.json |
| Полный import HTTP body | 400 KiB | До шестикратного JSON escaping secret плюс не более 16 KiB строго ограниченного outer envelope; bound проверяется до parse |
| Отдельный token после parse | 32 KiB | Существующая native граница сохраняется |
| Import encrypted transient envelope | 48 KiB | Только RT + method commitment/custody overhead; полный auth.json не сохраняется |
| Browser/device encrypted material | 1 024 bytes | Существующий предел не изменяется |

Outer envelope — closed object, размер 16 KiB не даёт права на дополнительные свойства. Decoder ограничивает глубину/число ключей, отвергает duplicate keys и bulk; exact shape фиксируется fixtures G0. Body bound применяется на Gateway HTTP, native private handler и bootstrap owner-authorizer; текущие 4 KiB/64 KiB generic parsers не расширяются глобально. Если слой не поддерживает нужный размер, импорт не рекламируется до согласованной qualification. Значение 400 KiB относится к сериализованному import request, не к file input UI и не к provider responses.

48 KiB encrypted envelope обеспечиваются **import-only raw-byte codec**: AEAD шифрует RT bytes, а scope/method/input commitment входят в AAD. Не сериализовать RT через JSON перед encryption — escaping нарушает bound. Browser/device сохраняют прежние JSON encoding и AAD побайтно; новый codec version/method выбирается явно и покрывается round-trip/migration tests.

### 5.2. Supported/unsupported формы

| Вход | Поведение |
| --- | --- |
| Raw Codex refresh token | Native выполняет один fenced exchange с фиксированными server-owned issuer/client/endpoint |
| Обычный OAuth auth.json с refresh token | Native извлекает разрешённую token shape, затем тот же fenced RT exchange; просроченные supplied AT/ID не мешают самому входу |
| auth.json без RT, AT-only | Явно unsupported в этой волне |
| PAT, Agent Identity, mobile RT, API-key auth.json | Явно unsupported; не угадывать режим и не молча переключать auth kind |
| Произвольные issuer/client/proxy/base URL в файле | Не управляют HTTP. Explicit foreign provenance отвергается; отсутствие необязательной provenance не становится доказательством чужого issuer |

«Полный auth.json» означает обычный refreshable Codex OAuth export, а не любой JSON из любой версии CLI. Supplied email/plan/subject не становятся authority. RT exchange может законно не вернуть новый RT — native сохраняет исходный при подтверждённом ответе. Если нельзя получить/проверить достаточную identity для текущего protected native contract, import завершается явной безопасной ошибкой/uncertainty, не создаёт аккаунт с выдуманным principal.

### 5.3. Сбои, повтор и reconnect

Native расширяет existing connect table/FSM методами import. `prepared → entered` CAS фиксируется **до** external exchange. Результат через existing enrollment/Stage связывается с account operation и durable receipt. Gateway не владеет provider exchange повторно.

Private adapter переводит public `oauth_auth_json` в native stored method `auth_json`; `refresh_token` остаётся тем же именем. Это единственный явный перевод, закреплённый golden fixture; UI никогда не использует native enum напрямую.

| Ситуация | Обязательное поведение |
| --- | --- |
| Повтор того же operation + того же payload | Readback/receipt; новый exchange не запускается |
| Тот же operation, другой method/payload/owner/profile | Conflict до provider effect |
| Ответ потерян после входа во внешний exchange | `unknown`, reconciliation по уже имеющемуся receipt; отсутствие receipt не доказывает отсутствие provider effect |
| Один RT одновременно в разных operation IDs | Native keyed same-secret claim запрещает два незавершённых/неизвестных exchange; без раскрытия чужого owner |
| Известный completed с не ротировавшимся RT | Claim освобождается; явная последующая операция допустима. Не вводить вечный blacklist валидных RT |
| Reconnect | Сохраняет логический accountRef и существующие binding semantics; native identity/generation и Gateway epoch меняются по действующим правилам; старые facts очищаются |

Два MAC имеют разные назначения. `inputMAC` связывает принятый input со scope/operation/method для exact replay. `claimMAC` связывает domain + fixed issuer/client + exact RT **без owner/account/generation/operation/method**, чтобы другой operation или auth_json не обходил общий unresolved claim. Оба метода используют один partial unique claim; ключи/fingerprints не экспортируются. Ротация ключа MAC не должна позволять обойти ещё живые claims и квалифицируется как отдельная custody migration, не скрытая смена конфигурации.

Native uncertainty не равна терминальному Gateway `unknown`. Пока исходный Gateway candidate live/pending и владеет authority, exact native receipt может завершить его. После terminal `unknown` поздний receipt служит reconciliation/cleanup evidence и **не разрешает `unknown → applied`** или takeover другим worker. Crash после Gateway journal, но до подтверждённого native acceptance, не получает обещания автоматического успешного resume: отсутствие receipt не доказывает отсутствие effect. Не добавлять постоянную Gateway копию RT для такого resume. UI сохраняет исходную operation и её честный outcome.

Гарантия — at-most-one local unresolved exchange entry для одного import intent/claim, **не exactly-once внешнего OAuth сервера**. Unknown нельзя «вылечить» циклом refresh до успеха. HMAC fingerprints не логируются и не становятся публичными account identifiers. Secret retention следует existing encrypted custody/cleanup, с проверкой терминальных путей.


### 5.4. Необязательные сведения при credential refresh

Credentials и durable refresh receipt сохраняют существующую транзакционную границу. Внутри неё **один private SAVEPOINT на весь optional metadata batch** позволяет откатить сведения при ошибке второго источника, сохранив уже полученный новый RT и завершённую операцию. Identity/owner/generation/version/attempt checks остаются снаружи savepoint; они никогда не превращаются в best-effort. Ошибки SAVEPOINT, ROLLBACK TO, RELEASE и финального commit остаются существующим unknown/recovery outcome, без повторного exchange.

После rollback сведений прежний credential expiry скрывается проверкой credential revision; ранее полученные email/label/subscription могут оставаться с исходными observedAt/freshness. Ни новый snapshotRevision, ни выдуманное время наблюдения не публикуются. Connect publication, quota+facts и cached initialization по-прежнему атомарны целиком. Это уточнение заменяет раннее проектное обещание, что ошибка любых display facts обязана откатывать успешную rotation; второго credential store или retry worker нет.

HMAC key выводится из existing connect encryption key отдельной domain label, без нового конфигурационного secret. Commitment connect key хранится в каждом import intent. EnterConnect под общей transaction advisory lock запрещает entry, пока существует entered/unknown intent с другим commitment. Prepared intent ещё не означает external effect и этот запрет не удерживает. Новый connect key допустим после штатного закрытия прежних unresolved claims; удалять их для обхода запрета нельзя. Старые browser/device codec и AAD не меняются.

## 6. Visibility и failure semantics

Gateway не знает RR workspace roles. Его contract использует opaque `ownerRef`, scopes bearer и account identity. RR или другое приложение проверяет viewer права до обращения и непосредственно перед отправкой результата пользователю.

| Viewer в RR | Identity/subscription facts |
| --- | --- |
| Владелец личного аккаунта, включая доступ через разрешённую workspace binding | Видит свои safe facts |
| Owner/admin workspace, аккаунт принадлежит этому workspace | Видит safe facts этого workspace account |
| Пользователь, которому только разрешено использовать чужой личный/operator аккаунт | Не получает email/tier/сроки через общий metadata ответ; остаётся разрешённое friendly label/use context |
| Удаление, pending reconnect, смена binding/role/epoch во время read | Старое содержимое не отправляется; pending/denied state без старой identity |

В RR pre/post checks каждой строки дополняются **финальной проверкой batch**: быстрый read мог стать недоступным, пока ожидалась другая строка. Нельзя включать private facts в server-rendered bootstrap или selected-account hydration до той же проверки.

Неизвестные metadata fields не блокируют аккаунт. Однако реальная ошибка credentials/authorization в существующем execution lifecycle обрабатывается по старым правилам — metadata не скрывает invalid credentials и не активирует их сама.

## 7. Минимальный contract freeze G0

### 7.1. Зафиксированный M1 wire для реализации

После дополнительного предреализационного ревью выбран один public shape:

```ts
type AccountInfoReadRequest = { ownerRef: string; accountRefs: string[] };
type AccountInfoReadResponse = {
  contract: 'account-info/v1';
  accounts: Array<{
    accountRef: string;
    metadataRevision: number;
    authorizationEpoch: number;
    info: AccountInfo;
  }>;
};
type AccountInfo =
  | { status: 'available'; infoRevision: string; fields: {
      email: Fact<string>;
      accountLabel: Fact<string>;
      subscription: Fact<{
        code: string; label: string;
        scope: 'personal' | 'organization' | 'workspace' | 'unknown';
        endsAt: { kind: 'instant' | 'date'; value: string } | null;
      }>;
      credentialExpiresAt: Fact<string>;
      privacyMode: Fact<'private' | 'public'>;
    } }
  | { status: 'unavailable' | 'unsupported' };
type Fact<T> =
  | { status: 'known'; value: T; source: 'provider_api' | 'verified_claim' | 'imported' | 'user_supplied' | 'inferred'; observedAt: string; freshness: 'current' | 'stale' }
  | { status: 'unknown' | 'unsupported' | 'unavailable' };
```

Это описание wire, а не второй набор SDK declarations: реализация и runtime schemas принадлежат `facade-client/contracts/account-info.ts`, curate exports — существующему `/contracts`. Все bounds и semantics разделов 2–6 сохраняются. Public method называется `readAccountInfo`; private route — `/private/native/v1/account-info/read`. Private request переиспользует logical selector `{ ownerRef, accountRef, profileId, expectedAuthorizationEpoch }`; proof native generation/principal не попадает в публичный результат. Exact private proof сверяется по уже существующей native authority модели и общей fixture до интеграции.

В RR одно обогащение/финальная проверка работают на окончательном массиве после всех selected-account и operation-detail hydration. Более ранняя проверка внутри отдельных `list`/`get` не заменяет этот последний этап. Metadata остаётся частью существующих server-first ответов; отдельный UI endpoint, polling и metadata cache не добавляются.

### 7.2. Критерии завершения G0

G0 завершён, когда в одном contract PR есть exact safe schemas, selected method union, private/public error mapping, fixed limits, accepted payload examples без настоящих секретов и следующие независимые fixtures:

1. Codex known email/actual plan и различающиеся три даты.
2. API key без email/подписки, новый provider ID Gemini, v1 projection без него.
3. Stale value, authoritative source omission, generation/credential revision race.
4. Foreign owner, unknown input kind, extra property и over-limit payload rejection.
5. RT/full JSON same-operation replay, changed input conflict и unknown exchange.
6. Независимый backend fixture с теми же account semantics без Sub2API imports.

Names/serialization после G0 меняются в одном месте с coordinated fixture update. Не требуется проектировать все будущие провайдеры: новый backend обязан сохранять обещания существующего контракта или честно сообщать unsupported.
