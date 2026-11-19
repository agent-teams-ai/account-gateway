---
id: docs.reference.native-account-qualification
type: reference
status: proposed
owner: gateway-maintainers
summary: Значимые проверки контрактов, миграций, заменяемости, точного SDK и поэтапного выпуска трёх репозиториев.
---

# Нативные аккаунты: квалификация и выпуск

## 1. Что должна доказать квалификация

Этот документ задаёт проверки [M1/M2](native-account-integration-plan.md) и отдельно фиксирует реальные результаты в §8. Матрица рисков не означает, что все её строки уже пройдены. Документационные проверки и принятые исправления записаны в [журнале ревью](native-account-review-log.md).

Проверяем реальные обещания: provider facts не дублируются, owner isolation сохраняется при гонке, import не повторяет неизвестный внешний effect, новый backend заменяем на management boundary, exact SDK работает в независимом consumer, новые API-профили подходят фактическому review runner.

Не писать тест на каждый getter, число классов или исходную строку. Не заменять behavioral evidence grep-проверкой файлов. Foundation/source boundary gates нужны именно для зависимостей; runtime invariants требуют runtime/integration tests.

## 2. Матрица рисков и минимальных проверок

| Риск | Владелец | Значимое свидетельство |
| --- | --- | --- |
| Неподписанный imported JWT выдаётся за verified email/tier | A | Provider/claim provenance fixtures, malformed/expired/cross-principal input, native guarded exchange |
| План personal соединён с expiry workspace | A | Два одновременных source scopes, только согласованная пара попадает в snapshot |
| Старый HTTP ответ пишет факты после credential rotation | A | Реальный repository CAS test с generation + credential revision |
| Timeout стирает last-good либо полный omission оставляет старый план | A | Две независимые последовательности failed read vs authoritative omission |
| Поздний старый response возвращает снятый тариф при тех же credentials | A | Source order до HTTP, полный omission tombstone, out-of-order response; final native read отдаёт новую snapshotRevision |
| Старый cached backfill или lower-priority source восстанавливает снятый план | A | Initialize-if-untouched без нового live order; оба порядка cached/live race; authoritative omission подавляет старый lower-priority факт |
| Admin helper меняет privacy при metadata read | A | Нулевой provider mutation/HTTP в public cached read; pure enrichment extraction отдельно |
| Borrower/бывший участник получает чужой email | C/B | Pre/post и final-batch race; membership/owner/binding/epoch change пока другой read задержан |
| Gateway batch выдаёт уже отозванный grant не-RR consumer | B | Вторая native строка задержана, grant первой отозван; final Gateway authority observation подавляет её facts |
| Selected account hydration теряет сведения | C | List → selected detail → account replacement через четвёртый projection |
| API key отсутствует quota support и ошибочно запрещает AccountInfo | B | Metadata-only profile с `limitsContract=none`, отдельный capability admission |
| Двойной RT exchange после retry/timeout | A/B | Postgres concurrency, same op/different owner/method, before/after Enter, lost ACK; native unknown и terminal Gateway unknown отдельно; crash до подтверждённого native acceptance |
| Reconnect создаёт второй логический account | A/B/C | AccountRef/binding identity сохранены, old snapshot/epoch запрещены |
| Новые Gemini/import поля ломают v1 strict clients | B | Старый packed SDK против нового producer; чистая v1 projection и новый v2 client |
| Модуль создан, но production обходит его | C | Реальный returned readMetadata API вызывает injected reader; отсутствие binding даёт failure |
| Provider login принят, но tools/review broken | D/C | Exact pinned Codex joined flow: function/custom round trips, stream terminal, cancellation |
| Gemini signature потеряна либо Anthropic key поставлен не на protected boundary | D | Exact serialized URL/auth-header test под existing decode fence; signature second-turn/late-chunk/call association fixture |
| V2 profile есть, но setup блокирует или выбирает чужой runner | C | Descriptor → product admission → setup choice → binding → codex_account_gateway; unqualified profile denied |
| Новый backend фиктивно заменяем | B | Public facade/SDK → independent fixture adapter без native imports; те же semantics |
| Secret попал в клиентский cache/error/artifact | A/B/C | Synthetic sentinel secret отсутствует в logs, safe errors, operations, HTML, snapshots и evidence |

## 3. Четыре слоя evidence

### 3.1. Native unit + repository tests

Переиспользовать существующие native тесты parser/converters/account-limits/connect lifecycle. Новые Go cases проверяют closed projection и methods; реальная PostgreSQL интеграция проверяет triggers, immutable scope, partial same-secret claim и read/write fences. In-memory mock не доказывает SQL uniqueness или migration safety.

Migration test начинает с текущих browser/device prepared/entered/completed/unknown records, применяет новый schema step и проверяет прежние ограничения. Затем создаёт RT/auth_json imports. Сохраняется encrypted custody cleanup и невозможность изменить чужой intent. Никаких delete/recreate старых таблиц для облегчения теста.

### 3.2. Gateway facade + SDK

Существующие exact HTTP/operation tests расширяются новыми методами; fake backend независим от native DTO. Отдельный controlled native instance проверяет concrete adapter translation и owner callbacks. Secret ingress не становится публичным safe export.

Повторяем existing exact archive consumer gate для NodeNext и ESNext/Bundler. Тест импортирует из **упакованного SDK**, вызывает новые exports/methods и existing get-modular factory, а не использует source aliases. Browser-safe entry не тянет secret/native/Node-only зависимости.

Проверяем service bounded routes, cancellation, partial backend failure и unsupported capability. Нельзя broaden allowlist/disable strict schema ради зелёного результата.

### 3.3. Review Router application + browser

Новый narrow slice получает Foundation rejecting fixtures, composition test и behavioral tests visibility. Существующие tests account-limits сохраняются как independent regression oracle после extraction общего resolver: quota refresh, токены и статусная модель не меняются.

Composition evidence включает существующие `checkModuleLayout`, `checkWiring` с independent oracle/wrong-binding mutant и isolate/smoke реального root. Проверка пассивности `prepare/run` отдельно доказывает отсутствие SDK/SQL/authorization effects до вызова API. New paths реально включены в modular/architecture commands и strict TS project; test за пределами CI не считается gate.

Browser tests репрезентативны: один key flow, Codex import, reconnect, long/missing/stale values, оба theme и узкий viewport, clear secret на submit/close/owner/provider switch, selected account hydration. Не размножать одинаковые UI tests на каждого provider, если они используют один input-kind component. Provider semantics проверяются native.

### 3.4. Joined и live

Один синтетический полный путь `native → Gateway → packed SDK → RR` проверяет сборку contract/metadata/import readback. Для Anthropic/Gemini отдельная joined protocol qualification доказывает реальный runner/tool flow. Переиспользовать existing harness, а не создавать второй orchestrator.

Live provider authentication/review в disposable approved test account — отдельная evidence category. Не утверждать её на основании fixture. Production rollout observation также отдельна; runtime source commits в deployment registry не заменяют actual smoke observation.

## 4. Команды и границы стандартов

Точные команды брать из manifests/CI целевого commit перед реализацией; эта таблица указывает существующих владельцев gates, а не универсальный shell script для трёх языков.

| Repo | Существующие gates, которые расширяются |
| --- | --- |
| Account Gateway | `build`, `typecheck`, `typecheck:tests`, `lint`, `test:static`, `test`, `foundation`, `foundation:dev-only`, `check:topology`, `qualify:consumers`, service/native joined gates по affected scope |
| Review Router | Existing typecheck/test/browser gates; `architecture:check`, `foundation:check`, dev-only/registry checks, `tsconfig.modular.json`, `modular:qualify`, provider joined harness |
| Sub2API | Existing Go unit/integration/database tests, protected native qualification и affected converter suites |
| Только данный комплект планов | Docs Protocol `context` + `check`, Markdown links/anchors и `git diff --check`; runtime tests для отсутствующего кода не объявляются выполненными |

Pinned Foundation/Docs Protocol/Get Modular не обновляются автоматически. В Gateway CMS pending остаётся pending; нет нового graph boundary. В RR новый scope получает собственный adoption record и реальные gates; существующая History adoption не распространяется молча на accounts. Negative-fixture checks, меняющие временные файлы checkout, выполнять последовательно в одном worktree.

## 5. Выпуск: один совместимый producer/consumer маршрут

### R0. Contract и isolated work

G0 фиксирует contract fixtures. Отдельные worktrees/ветки пакетов от актуальных sources; contracts owner принимает общие изменения. Никаких production secrets в fixtures. Обновлять свои документы/ownership files вместе с соответствующей реализацией, не ссылаться на этот план как на уже принятую архитектуру всего repo.

### R1. Native metadata, затем Gateway, затем RR — M1

1. Sub2API: additive metadata storage/endpoint; старые API и accounts работают; new safe projection read-only.
2. Gateway: AccountInfo adapter/authority/SDK и первоначальный capabilities v2 с `accountInfo`; selected imports/new profiles пока не advertised. Допуск только при нужной native capability. Явный typed unsupported сохраняется; отсутствующий route старого native даёт unavailable, а404 не становится capability negotiation. Запись provider facts в Gateway не появляется.
3. Собрать SDK archive из committed source, проверить exact archive и provenance.
4. RR: обновить все потребители того же SDK archive/lockfile, затем включить capability-driven metadata read и UI. Старый producer показывает существующий account без новых facts.
5. Existing native maintenance инициализирует отсутствующий snapshot из проверенного retained observation; отдельного rollout-скрипта/endpoint/worker нет. Scoped smoke проверяет owner visibility, borrower restrictions, missing/stale facts и прежний review flow. Сохраняются exact sources и outcome.

### R2. Imports и API profiles — M2

1. Native migration/connect methods + protected import; old browser/device paths квалифицированы.
2. Gateway включает selected import descriptors в уже выпущенном v2 и operation ingress на qualified native tuple; existing v1 projected safely.
3. Packed SDK и RR форма/reconnect, только поддержанные combinations.
4. По одному qualified Anthropic/Gemini profile после D0/codec/joined checks; не публиковать catalog row заранее.
5. Test-account create/reconnect, lost-response recovery, representative review flow и safe cleanup; никакого массового переноса existing accounts.

Полная повторная прогонка неизменённых дорогостоящих tests не нужна без изменившегося dependency closure или обязательного gate. Но прежний CI pin native не доказывает новый tuple. Например, в исследованном Gateway native qualification pin старее Sub2API HEAD — перед новым release нужно квалифицировать целевую пару, не переименовать старое evidence.

### R3. Rollback и in-flight work

Rollback UI в пределах совместимого minimum version может скрыть новые методы, не удаляя accounts/operations. Facts cache допустимо потерять и заново получить в native; credentials и operation ledger недопустимо терять. Это не разрешение запустить произвольный старый Web binary.

RR требует собственного expand-reader → writer порядка: PersonalAccountOperation intent/hash/readback должны понимать новые методы прежде, чем они попадут в journal. Legacy hash/interpretation сохраняются, new-method rows не coerced в browser. С первой новой записью фиксируется minimum RR rollback version; legacy replay и rolling upgrade проверяются отдельно от native DB migration.

До schema rollout проверить, что older service binary безопасно читает новые method rows, либо явно запретить rollback ниже первого совместимого reader после появления таких rows. Предпочтение — сначала совместимый reader/expand migration, затем writer. Не обещать «просто вернуть старый контейнер» при новых enum/trigger semantics.

Unknown/entered imports заканчивает compatible native worker/reconciler; rollback Gateway/RR не делает их новыми операциями. Down migration не удаляет durable recovery state. Capability withdrawal останавливает новые imports, сохраняя readback существующих. Отсутствие qualified rollback — release blocker выбранного migration step, не повод удалять таблицу.

V2 discovery не fallback-ится по HTTP status; новый producer выпускается первым. Gateway-maintainers ведут inventory exact SDK archives зарегистрированных consumers и minimum rollback versions. После полного перехода отдельный minor 0.x migration PR удаляет временные capability v1 route/export/projection. Existing OAuth/account operation v1, native recovery и credentials не затрагиваются. До removal old/new packed SDK tests подтверждают обе проекции; после removal evidence/документы явно фиксируют новый минимум.

## 6. Приёмка по вертикальным срезам

| Срез | Готово, когда | Самостоятельный выпуск |
| --- | --- | --- |
| M1-core | Codex facts безопасно проходят весь путь; owner fencing и четыре projections работают | Да, для поддержанных профилей |
| M1-current-providers | Все текущие выбранные profiles имеют truthful fields/states; no duplicated extractors | Да, полный M1 |
| M2-import | RT/fullJSON create/reconnect проходят same-operation recovery и custody cleanup | Да, независимо от Gemini |
| M2-Anthropic | API key плюс фактический review runner/tools квалифицированы | Да |
| M2-Gemini | API key плюс фактический review runner/tools/signatures квалифицированы | Да |
| Reusable management | Packed SDK работает с fixture backend и RR; native-specific details не выходят за adapter | Обязательное условие B/M2, не второй production backend |

## 7. Что записать в implementation PR и release evidence

Для каждого PR: конкретная изменённая гарантия, owner boundary, affected files/контракт, миграция/recovery, exact sources/artifact, фактически пройденные gates и оставшиеся blockers. Shared package changelog/migration note описывает новый v2 capability/read/import use; v1 совместимость проверена, а не заявлена.

Логи/metrics используют existing bounded diagnostics: operation status, snapshot age/state, safe error code, duration, admission rejection. Не писать email, тариф пользователя, account subject, token fingerprint или raw provider response в telemetry. Никакой новой analytics/event-bus/observability платформы в этой работе.

Финальный статус различает: **planned**, **implemented**, **synthetic-qualified**, **live-qualified**, **deployed-and-observed**. Переходы подтверждаются evidence соответствующего уровня, а не количеством строк, принятым plan PR или названием выбранной архитектуры.

## 8. Журнал исполнения — checkpoint 19.11.2026

### Точные входы

| Компонент | Проверяемая ревизия |
| --- | --- |
| Sub2API | [2cc5862f](https://github.com/agent-teams-ai/sub2api/commit/2cc5862f79aa56a5dd76e399241e828f32064f5b): runtimefd759624 с SQL262, атомарной legacy hydration, UTC expiry, optional metadata SAVEPOINT и credential provenance; исправлен HTTP test oracle и четыре PG regression файла включены в existing gatewaycustody suite |
| Gateway | [2bee1511](https://github.com/agent-teams-ai/account-gateway/commit/2bee1511c387b8f1c89263939359eb82b6cdac7b): package, kernel и семь full-stack lanes success с Nativefd759624; расширенный native-client gate обнаружил ошибку strict-import HTTP test, подробности ниже |
| SDK | Source [f2690a3c](https://github.com/agent-teams-ai/account-gateway/commit/f2690a3c9cfd0cf61bfb7ca31b802d249105d751); SHA-256 архива `34562d43668a1ca09e95666da3237206b3744d0d0766039fd2b8acbce241483f`, 60680 bytes,50files |
| RR | [d4d39a2b](https://github.com/777genius/review-router-ai/commit/d4d39a2b4f0efdd40c5953f463b12349c98b2db4): SDKf2690a3 во всех трёх consumers и согласованная active conversation identity, journal160, совместимость migration tree165, displayToken и browser heap fix;34/34 browser qualification предшествующего597450 указана отдельно |
| Actual review Action | Source [0454fc0a](https://github.com/777genius/review-router/commit/0454fc0a3af15f94522c7c31cce59c0c62af6567); source archive SHA-256 `42e8d844bd451655ff171dc4093a872fc471675c90b3997697261ba4153807b4` |
| Actual Codex CLI | `0.133.0`, Linux x64 binary SHA-256 `524396258c974948334eabe6f2c6b1d8e1979dfd048d67d535ad9e4550fa5b26` |

Последние два артефакта — входы joined qualification, а не подтверждение её успешного завершения. Локальные probes actual Codex подтвердили сохранение opaque reasoning и порядок `output_item.done` между двумя запросами. Эти probes проверяют CLI protocol, но не подменяют полный native/Gateway/Review Router путь.

### Уже полученные результаты

| Проверка | Результат и предел доказательства |
| --- | --- |
| Gateway package / kernel | На2bee [package44459998780](https://github.com/agent-teams-ai/account-gateway/actions/runs/44459998780) и [kernel44459998791](https://github.com/agent-teams-ai/account-gateway/actions/runs/44459998791) success. Включены существующие contract/consumer/Foundation gates. Ранний package44454480030 обнаружил только форматирование run.ts; оно исправлено, без исключения файла из gate |
| Gateway full-stack / bounded load | [44459998807](https://github.com/agent-teams-ai/account-gateway/actions/runs/44459998807) на2bee/Nativefd759624: все семь lanes и aggregate gate success, Node24/26; all, scale-streams, heavy-output, scale-arrivals, large-context, sustained-arrivals. Это отдельный текущий результат после исторического8aa/dc4 run44454480031 |
| Gateway OAuth PostgreSQL |76/76, настоящая disposable PostgreSQL; покрыты existing lifecycle и новые операции, исправлен порядок legacy denial |
| Gateway domain и management |152 domain tests;22 management PASS и один прежний opt-in joined skip. Skip не считается выполненным joined сценарием |
| RR architecture / C1 / P115 |На6c490 [C1 44454251528](https://github.com/777genius/review-router-ai/actions/runs/44454251528) success:676files architecture, Foundation/module profile,48 application и26 PostgreSQL tests. [P115 44454251536](https://github.com/777genius/review-router-ai/actions/runs/44454251536) success через настоящий Gateway HTTP. Новые commits проверяются отдельно |
| RR focused account contracts/UI |132 сценария в восьми affected test files; отдельно34 installed-SDK/catalog/consumer сценария |
| RR exact SDKf269 integration | Frozen install Node24.21.0/pnpm11.28.7,1089 package policies;50 files совпали с archive во всех3 consumers;36/36 focused imports/admission/catalog/detail tests PASS; ни одной dependency version смены |
| RR active source identity | Native-account-info provenance выбран одновременно с API SDK manifest; штатные stamp/verifier write+check прошли в canonical node_modules/.pnpm, два fresh generator запуска byte-equal;29 identity/stale-qualification tests PASS. Historical NVIDIA receipt и builder behavior не изменены |
| RR browser597450 | [44457361015](https://github.com/777genius/review-router-ai/actions/runs/44457361015) success,34/34 captures. Artifact14499232646 SHA-256 `3e5ca424b2e3be616534ec1cc35982da6456f688fb6aaa1fd8acb1a27919e4f9`; exact source unchanged, ноль page/console/blocked-request ошибок, overflow и Next memory restarts. Вручную просмотрены шесть сценариев, включая owner390dark. Это не receipt новогоb955 commit |
| RR PostgreSQL metadata/projections |15/15 в пяти файлах, реальные authority/selection/overview paths; это не браузерный smoke |
| RR migration compatibility |359/359 в шести файлах; чистая PG17.10 воспроизвела165 migrations и C2b CAS; historical164/managed92/historical96 manifests не переписаны |
| Native SQL guards |321 migration SQL применены на чистой PG17.10; две точные official API tuples приняты; неверные origin/model/auth mode/passthrough/plaintext и mutation отклонены |
| Native converters |Exactfd759624: все479 root tests `internal/pkg/apicompat` PASS наGo1.27.3,0skip; покрыты Gemini proof/history/signatures и Anthropic output format. Дополнительно2/2 OpenAI plan/catalog tests PASS |
| Native service/bootstrap/HTTP |На2bee/Nativefd759624 в [44459998802](https://github.com/agent-teams-ai/account-gateway/actions/runs/44459998802) четыре бинаря собраны на обеих lanes; service24/24, bootstrap3/3, account-info HTTP PASS. Strict-import HTTP test FAIL, workflow целиком не пройден. В39b77c38 исправлено ожидание: staging не делает отдельный account-check, которым владеет Descriptor; token/replay/authorization/no-leak assertions сохранены |
| Native plan labels |Два targeted Go tests PASS; actual frontend TS module и generated JSON —13 assertions PASS. Это не полный frontend Vitest/typecheck |
| Native public race |Обе lanes на6c1350 Gateway/49cf Native прошли public ingress после исправления queued-cancellation fixture. Весь native-client workflow тогда не прошёл из-за следующего unit compile error |

### Проверки, которые ещё должны закрыть текущие PR

1. На закреплённом Native2cc5862f выполнить все selected unit и PG repository cases, включая multi-source transaction rollback, import claims и stale-credential observation. Исправление strict-import HTTP fixture опубликовано после воспроизведения exact CI binary; оно проверяет существующую границу staging/Descriptor и не меняет runtime. Прежняя ошибка fixtures без обязательного `codex_output_schema` исправлена в16c8274; нынешний service24/24 подтверждает это. Наличие четырёх бинарей само по себе не заменяет их execution.
2. Existing device joined harness: RT/auth.json create, reconnect, metadata provenance, lost native ACK, ambiguous provider response, retained unresolved claim и отсутствие plaintext в обоих SQL stores.
3. Existing provider joined harness: шесть профилей, official auth headers, schema/tool/custom-tool round trips; затем actual Review Router `CodexProvider.review` и actual CLI на замкнутом synthetic upstream. Это не live provider access.
4. Завершить currentd4d39a2b full Web/C1/P115/browser CI после SDK repin и source identity sync. Предшествующий UI597450 уже прошёл34/34. Исторический33/34 run44454251509 и artifact14497667011 подтвердили Next memory restart при2ГБ; исправлен только heap до4ГБ на существующем16ГБ runner. Таймаут180s, все34 обязательных captures, exact-source/no-error/overflow assertions сохранены.
5. Обязательные проверки последних commit каждого PR, disposition внешнего code review, merge в dependency order и проверка фактического merged состояния.

Во время временной недоступности локальной среды работу продолжили через обычные GitHub PR и штатные CI; артефакты после восстановления скачаны и проверены. Никакой внешний service/runtime вместо production dependency не подставлен.

Локальный полный Go service compile и полный RR Web TypeScript были прерваны средой без завершённого результата; локальный Next отвечал health200, но не завершил страницу. Они не записаны как PASS. Для них сохранены штатные CI gates; исходные assertions/engine/strictness не ослабляются ради запуска. CI queue — состояние ожидания, не доказательство сбоя.

Live provider login на реальном платном аккаунте, production deployment, массовая миграция аккаунтов и публикация SDK в публичный registry не входят в разрешённый итог этой работы. Их отсутствие не скрывается за synthetic evidence.

Последующая bounded generator-проверка нашла ошибку escaping shell dollars в Makefile91: замена через строковый JS replacement превратила `$$` в `$`. Исправлено вfd759624; повтор фактического make target на Go1.27.3 подтвердил сохранение прежнего JSON при forced failure, content SHA,0644 при umask0077 и cleanup временного файла.

Native2cc5862f включает новые PostgreSQL cases в существующий build tag `gatewaycustody`. Общий `integration` TestMain запускает Docker/Redis до выбора tests и не предназначен для переданного disposableDSN внутри no-network контейнера. Четыре tag aliases и изменение одной compiler option используют действующий dedicated suite; общий TestMain не изменён. `go list -tags gatewaycustody` подтвердил наличие всех трёх exact roots и helpers без TestMain. Existing runner запрещает SKIP, missing-root и no-tests outcomes; только execution с явными PASS считается квалификацией.
