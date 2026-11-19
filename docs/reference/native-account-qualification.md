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

## 8. Журнал исполнения — 19 ноября 2026 года

### Контрольная точка продолжения

При восстановлении работы 19 ноября удалённые heads были Sub2API `2cc5862f`, Gateway `7294787f`, RR `519e9913`. Все три PR открыты; merge и production rollout ещё не выполнялись. Ранние строки ниже сохраняют исходные ревизии и не считаются проверкой последующих изменений.

| Текущая граница | Фактический результат |
| --- | --- |
| Sub2API `2cc5862f` | Независимое повторное ревью storage/import/refresh/protocol не выявило нового блокирующего дефекта; 63/63 inline threads resolved. Native head не изменялся. Собственный CodeQL `44461445834` остаётся queued, не PASS. |
| Gateway `7294787f` | [Kernel `44470869227`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44470869227) и [full-stack/load `44470869300`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44470869300) PASS. [Package `44470869236`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44470869236) FAIL: shared evidence validator не был объявлен entrypoint тестовой boundary. Подготовлен узкий dependency fix с отрицательными проверками private commands и domain imports. |
| Native через Gateway | В [run `44470869379`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44470869379) на обеих Node lanes прошли 24 service, 3 bootstrap, 2 HTTP roots, все три обязательных PostgreSQL roots, public-ingress race и actual Codex/Claude native receipts. Native SHA точно `2cc5862f`; внешняя сеть отсутствует. Весь run FAIL: RR joined path остановлен до provider review на `rr_provider_joined_failed_cli_sandbox_preflight_none`. |
| RR `519e9913` | Уже опубликованы uncached final authorization, сохранение product reconnect bounds и отображение разрешённого existing account при недоступном capability. Все inline threads resolved. C1, P115, operator-grants, memory, Skills и statistics browser прошли. [Основной CI `44472024327`](https://github.com/777genius/review-router-ai/actions/runs/44472024327) FAIL на lint/test/generated-artifact drift; обязательные PG17 и self-hosted lanes PASS, aggregate Quality Gates FAIL. |
| RR browser `519e9913` | [Native browser `44472024187`](https://github.com/777genius/review-router-ai/actions/runs/44472024187) остановлен до запуска приложения: apt не скачал pinned Chromium dependency с Ubuntu mirror. 34 captures на этом head не выполнены. Unified OCR acceptance отдельно выявил четыре устаревших ожидания account label. |

Текущий Engineering Quality Standard требует TypeScript не ниже 7.0.2, включая embedded parser APIs. Изолированный RR compiler 7.0.2 установлен; полный Web typecheck им проходит. Legacy `typescript-eslint@8.59.1`, прямые AST consumers и `compiler-cli --legacy` разрешают root `typescript@6.0.3`. Эти локальные gates не запускаются и не обозначаются пройденными. Их owning upgrade route отделён от account feature: обновление одного пакета не решает совместимость parser/Next/compiler APIs. Это остаётся явным ограничением квалификации, без ослабления gates, смены immutable inputs или молчаливой миграции всего toolchain.

Продолжение опубликовано в RR [`80bf1ea7`](https://github.com/777genius/review-router-ai/commit/80bf1ea7f406ddca043651cadef60c89b6d37d3d): исправлены перечисленные CI fixtures и generated runtime, сохранены исторические migration digests, добавлена безопасная диагностика preflight. Локально прошли 101 CMS, 3 limits, 18 hydration и 152 migration/handoff cases, полный Web и release-rollout typecheck на TS 7.0.2, authoritative conflict-runtime parity. Группы не суммируются с прежними проверками. Sandbox helper — 10/10 отрицательных cases и strict TS7; Gateway evidence parser — 19/19 на Node 24/26, source-policy mutants — 12/12. Полная официальная поставка CLI сохранена с hashes; preflight и Action требуют одного bubblewrap backend. Local actual preflight завершился отказом до provider calls; положительный joined outcome ожидается только от нового штатного CI.

### Результаты продолжения на опубликованных ревизиях

| Граница и точный source | Завершённый результат |
| --- | --- |
| Gateway `75896752564725e9771a9e85451ab3a963df6c5b` | [Package `44532717892`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44532717892), [kernel `44532718041`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44532718041) и [full-stack/load `44532718105`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44532718105) завершились SUCCESS. [CodeQL `44532709201`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44532709201) на том же head также SUCCESS: Analyze (actions) и Analyze (javascript-typescript); это GitHub workflow `dynamic/github-code-scanning/codeql`. Все семь full-stack/load lanes прошли; declared boundary и отрицательные source-policy cases сохранены. |
| Native-client run на Gateway `7589675`, Native `2cc5862f`, RR `80bf1ea7` | [Run `44532723289`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44532723289) завершился FAILURE на обеих Node lanes. Подготовка полного CLI, selected service 24/24, bootstrap 3/3, HTTP 2/2, races, PostgreSQL и actual native Codex/Claude прошли; six-profile RR path остановлен до provider call на `rr_provider_joined_failed_cli_sandbox_preflight_child_nonzero_exit_none`. Generic code не доказывает конкретную namespace/config причину. |
| RR `80bf1ea7f406ddca043651cadef60c89b6d37d3d` | [C1 `44532572149`](https://github.com/777genius/review-router-ai/actions/runs/44532572149) завершился SUCCESS: 48 application и 26 PostgreSQL tests без skips. [P115 `44532572368`](https://github.com/777genius/review-router-ai/actions/runs/44532572368) также SUCCESS через actual controlled Gateway HTTP. Общий tooling caveat выше сохраняется: configured CI success не означает миграцию legacy parser на TS7. |
| RR browser на том же `80bf1ea7` | [Run `44532572108`](https://github.com/777genius/review-router-ai/actions/runs/44532572108) — SUCCESS, 34/34 captures, suspect/failed/skipped — 0. Manifest и PNG получены из artifact `14533379414`; ZIP SHA-256 `ec54775c683d6b2361b5176b476b34a66afeec4e5b36c1177ecbe858a626f6f0` проверен. Шесть representative PNG просмотрены на 390/900/1440 px в light/dark; clipping и перекрытия не обнаружены. Необслуженных fixture routes и неожиданных external requests нет; отдельный development probe Next к npm registry штатно заблокирован. |

Эти receipts не заменяют основной RR CI и успешный полный native-client joined run. Main RR CI пока не завершён; native run выше не считается PASS из-за успешных предварительных шагов. Queued/running и пропущенные unrelated lanes не считаются PASS.

### Подтверждённый отказ полного provider flow

На Gateway `5c4f990ba9c748f24783224d700228a91edf9f2d` с Native `2cc5862f` и RR `de2b59bf` завершились SUCCESS [package `44536600097`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44536600097), [kernel `44536600129`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44536600129), [семь full-stack/load lanes `44536600514`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44536600514) и [CodeQL `44536588848`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44536588848).

[Native run `44536600086`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44536600086) завершился FAILURE на обеих Node lanes. Закрытая фактическая причина — `rr_provider_joined_failed_cli_sandbox_preflight_child_namespace_refused_none`, перед первым Kimi provider review. Официальный bundled bubblewrap не смог создать namespace; конкретный kernel/seccomp/LSM механизм этим кодом не установлен. Предшествующие native/SQL/race/real-client этапы прошли, но полный six-profile flow не квалифицирован.

Документированного альтернативного execution profile, сохраняющего outer network isolation и те же actual CLI sandbox controls, не найдено. Следующее положительное доказательство требует квалификации поддерживаемого профиля среды; прежний отказ не меняется на PASS и не обходится сменой backend или ослаблением ограничений. Точный следующий RR source обновлён ниже; автоматические checks новой ревизии должны публиковать собственные outcomes.

RR включил concurrent main до `78d4e713`: reviewed merge tree `d57297e2d411ca71dbc76cc018da54cc43778c3b` прошёл 86 account/UI cases, форматирование и authoritative generated parity. После недоступности локальной среды его четыре новых blobs и весь tree восстановлены побайтно через GitHub. Последующее main изменение перенесено без правки runtime account/import/sandbox blobs. Full Web TS7 при merge был прерван памятью; retry не завершился до потери среды, поэтому PASS не заявлен. В `3feee2ac` только lightweight impact job использует уже документированный fork-safe checks pool; Docker E2E и release runners не менялись. [Текущий RR CI `44541041876`](https://github.com/777genius/review-router-ai/actions/runs/44541041876) требует фактического завершения.

### Точные входы текущего межрепозиторного прогона

| Компонент | Ревизия и назначение |
| --- | --- |
| Sub2API | [`2cc5862f`](https://github.com/agent-teams-ai/sub2api/commit/2cc5862f79aa56a5dd76e399241e828f32064f5b). Production-код совпадает с `fd759624`; последующие изменения исправляют ожидание HTTP-теста и включают четыре PostgreSQL test files в существующий `gatewaycustody` suite. |
| Gateway | Production runtime/SDK source — [`f2690a3c`](https://github.com/agent-teams-ai/account-gateway/commit/f2690a3c9cfd0cf61bfb7ca31b802d249105d751). Qualification wrapper находится в [PR #116](https://github.com/agent-teams-ai/account-gateway/pull/116); exact source SHA записывается каждым CI run отдельно. Последующие правки wrapper/tests/docs не меняют SDK runtime. |
| SDK | Source [`f2690a3c`](https://github.com/agent-teams-ai/account-gateway/commit/f2690a3c9cfd0cf61bfb7ca31b802d249105d751). Архив: 60 680 bytes, 50 files; SHA-256 `34562d43668a1ca09e95666da3237206b3744d0d0766039fd2b8acbce241483f`. Последующие Gateway commits не меняют SDK runtime. |
| Review Router | [`3feee2ac`](https://github.com/777genius/review-router-ai/commit/3feee2acebaa4c1df59abe05f005e97ae744e653). Metadata/import implementation и SDK pin сохранены; main до `78d4e713` объединён с ревью account controls и текущим CI. Sandbox helper остаётся тем же, что в `de2b59bf`: 14/14 real-child cases и strict TS7 прошли; actual CI на `de2b59bf` подтвердил namespace refusal. |
| Review Action | Source [`0454fc0a`](https://github.com/777genius/review-router/commit/0454fc0a3af15f94522c7c31cce59c0c62af6567); archive SHA-256 `42e8d844bd451655ff171dc4093a872fc471675c90b3997697261ba4153807b4`. |
| Codex CLI | `0.133.0`; Linux x64 binary SHA-256 `524396258c974948334eabe6f2c6b1d8e1979dfd048d67d535ad9e4550fa5b26`. |

Action и CLI — проверенные входы полного joined test, но сами по себе не доказывают успешный review flow. Более ранний локальный CLI probe подтвердил carrier/history semantics между двумя запросами; он не заменяет путь Native → Gateway → RR. Следующие review fixes и их новые ревизии учитываются отдельно, без переноса статуса старого run на новый commit.

### Завершённые проверки

| Граница | Наблюдённый результат и предел доказательства |
| --- | --- |
| Gateway package и kernel | На `3d83dd99` успешно завершены [package 44461969989](https://github.com/agent-teams-ai/account-gateway/actions/runs/44461969989) и [kernel 44461969957](https://github.com/agent-teams-ai/account-gateway/actions/runs/44461969957). Включены существующие contract, consumer, Foundation и Get Modular gates. |
| Gateway full-stack и bounded load | [44461970056](https://github.com/agent-teams-ai/account-gateway/actions/runs/44461970056) успешно прошёл семь lanes и aggregate gate с Native `2cc5862f`: Node 24/26, all, scale-streams, heavy-output, scale-arrivals, large-context и sustained-arrivals. |
| Gateway локальные regression tests | Targeted runtime — 27/27, public SDK — 14/14 на Node 24 и 26; PostgreSQL enrollment — 76/76; joined-evidence parser — 7/7. Ранее выполнены 152 domain cases и 22 management cases; прежний opt-in joined skip не считается PASS. |
| Установленный SDK в RR | Frozen install на Node 24.21.0 / pnpm 11.28.7 с 1 089 package policies. Все 50 файлов совпали с архивом в каждом из трёх потребителей. Imports/admission/catalog/detail — 36/36. В lockfile изменились только имя архива и SRI, без смены dependency versions. |
| RR source identity | Active receipt согласован с API manifest. Неизменённые штатные stamp/verifier generators прошли в canonical `node_modules/.pnpm`; два fresh запуска дали одинаковые bytes. Identity/stale-qualification tests — 29/29. Historical NVIDIA receipt и bundler behavior сохранены. |
| RR C1 | На `d4d39a2b` [44461890658](https://github.com/777genius/review-router-ai/actions/runs/44461890658) завершён успешно: действующие architecture/Foundation/module/type checks, application и PostgreSQL contracts. |
| RR P115 | На `d4d39a2b` [44461890759](https://github.com/777genius/review-router-ai/actions/runs/44461890759) завершён успешно через настоящий controlled Gateway HTTP. |
| RR browser | На `d4d39a2b` [44461890711](https://github.com/777genius/review-router-ai/actions/runs/44461890711) завершён успешно. Отдельный уже скачанный и проверенный receipt UI commit `597450b4`: [44457361015](https://github.com/777genius/review-router-ai/actions/runs/44457361015), 34/34 captures, artifact `14499232646`, SHA-256 `3e5ca424b2e3be616534ec1cc35982da6456f688fb6aaa1fd8acb1a27919e4f9`. Source unchanged, ноль page/console/blocked-request errors, overflow и Next memory restarts; шесть representative сценариев просмотрены визуально. Исторический 33/34 receipt не переименован в успешный. |
| RR metadata и migration regression | Ранее пройдены 132 affected UI/contracts cases, 34 installed-SDK/catalog cases, 15/15 actual PostgreSQL metadata/projection cases, 359/359 migration compatibility cases. Fresh PostgreSQL 17.10 воспроизвела все 165 RR migrations и C2b CAS. Historical 92/96/164 manifests не переписаны. |
| Native conversion и plan labels | На exact `fd759624`, production-эквивалентном `2cc5862f`: 479 root tests `internal/pkg/apicompat` и 2 OpenAI plan/catalog tests прошли на Go 1.27.3 без skips. Native frontend TS module/generated JSON ранее проверены 13 assertions; это не полный frontend typecheck. |
| Native SQL guards | Все 321 migration применены на fresh PostgreSQL 17.10. Приняты две exact official API tuples; неверные origin/model/auth mode/passthrough/plaintext и mutation отклонены. |
| Native selected unit/HTTP/PostgreSQL | В [44461970261](https://github.com/agent-teams-ai/account-gateway/actions/runs/44461970261) на Node 24 и 26 прошли 24 service, 3 bootstrap, 2 HTTP roots и все три обязательных PostgreSQL roots. Более поздняя ошибка joined test не переименована в PASS всего run. |
| Import replay после uncertain response | Exact Native `2cc5862f` binary + Node 26.11.1 + две fresh PostgreSQL 17.10 DB локально: полный device/import harness PASS после oracle fix в `4b5063c5`; starts 1, polls 2, exchanges 6, checks 5, unexpected 0, plaintext/transient credentials 0. Этот диагностический запуск не включал CLI/RR и не подменяет их qualification. |
| RR review fixes на `43e475d4` | На исходном frozen dependency graph: strict `metadata:typecheck`, metadata layout и AST boundary gates PASS; 92/92 focused runtime cases включают широкий dashboard host test. Native SQL budget — 12/12 PostgreSQL cases; canonical lifecycle — 31/31 на Node 24/26; existing v2 HTTP fixture — 6/6 на обеих версиях. Actual browser/full Web CI нового head ещё требуется. |
| Native generator | Фактический Make target на Go 1.27.3 сохранил прежний JSON при forced failure; success bytes совпали с ожидаемыми, mode — 0644 даже при umask 0077; временный файл удалён. Ошибка shell dollar escaping исправлена в `fd759624`. |

### Проверки, которые ещё должны закрыть текущие PR

1. Завершить native-client qualification на обеих Node lanes с Native `2cc5862f` и RR `3feee2ac` после квалификации поддерживаемого execution profile. [Run `44536600086`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44536600086) с RR `de2b59bf` установил namespace refusal; gateway fixture не вправе превращать его в успешный результат. Требуются явные PASS selected service/bootstrap/HTTP tests, трёх PostgreSQL roots и actual provider flow; compilation или выход без tests недостаточны.
2. Выполнить existing device joined path: RT/auth.json create, reconnect, metadata provenance, потеря native ACK, ambiguous provider response, сохранение unresolved claim и отсутствие plaintext в обоих SQL stores.
3. Выполнить existing provider joined path для всех шести профилей: actual RR `CodexProvider.review`, закреплённые Action/CLI, production relay, function/custom tools, schema в обоих запросах, continuation, stream completion и execution closure. SDK-only fallback не принимается.
4. Завершить RR main CI на окончательном head, включая required `Quality Gates` и `Dedicated Release Authority PG17 contract`. Новые исправления внешнего ревью получают новые проверки; отменённый при следующем push run или прежние receipts не объявляются проверкой изменённого кода.
5. Закрыть все замечания ревью с source/test disposition, выполнить merge в dependency order и проверить фактическое merged состояние и необходимые проверки после merge.

### Устранённые причины прежних неуспешных запусков

- Anthropic fixture не передавала обязательное имя `codex_output_schema`. Исправление сохраняет assertions request/entered/terminal; последующие 24/24 service tests подтвердили его.
- HTTP import test ожидал account-check во время staging. Exact CI binary воспроизвёл ошибку. В `39b77c38` тест требует zero checks до Descriptor qualification; one token exchange, one enrollment, replay, authorization и no-secret assertions сохранены.
- Joined replay test сравнивал response-local `error.traceRef` с UUID предыдущего HTTP-ответа. Исходный harness воспроизвёл ошибку на точном CI binary; единственное различие — trace. В `4b5063c5` весь durable результат сравнивается при разрешённом новом trace, а no-extra-provider-HTTP и custody assertions сохранены. Последующее уточнение также требует различия двух response traces; полный локальный harness повторно прошёл на exact native binary и fresh PostgreSQL.
- Общий `integration` TestMain запускает Docker/Redis до выбора tests. Для новых isolated-DSN cases используется существующий `gatewaycustody`: четыре tag aliases и одна compiler option. Общий TestMain не изменён; `go list` подтвердил все roots/helpers. Runner отвергает SKIP, missing-root и no-tests outcomes.
- Offline Prisma generation не находила закреплённые engines после `--ignore-scripts`. Official `pnpm rebuild @prisma/engines` выполняется на подготовительном сетевом этапе. Checksums, versions и последующий no-network контейнер не ослаблены.
- Browser 33/34 остановился на Next memory restart при heap 2 GiB. Heap увеличен до 4 GiB на существующем runner; timeout 180s, 34 обязательных captures и assertions не изменены. Следующий run дал 34/34.

### Граница доказательства

Локальные полные Go service/Web TypeScript/Next попытки, прерванные средой без результата, не записаны как PASS. Их заменяют завершённые штатные gates с указанными ревизиями, а не ослабление strictness. CI queue остаётся ожиданием результата.

Ordinary Actions workflows форка Sub2API приостановлены GitHub; это подтверждено официальной страницей Actions. Настройки не обходились. Native code квалифицируется закреплёнными бинарями через существующий Gateway CI; paused fork workflow не объявляется успешным.

Live login на реальном платном аккаунте, production deployment, массовая миграция аккаунтов и public SDK registry publication не входят в разрешённый итог. Синтетические upstreams явно обозначены; они не доказывают текущие live entitlement или доступность платного API.
