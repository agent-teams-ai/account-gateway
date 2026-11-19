---
id: docs.reference.native-account-qualification
type: reference
status: proposed
owner: gateway-maintainers
summary: Значимые проверки контрактов, миграций, заменяемости, точного SDK и поэтапного выпуска трёх репозиториев.
---

# Нативные аккаунты: квалификация и выпуск

## 1. Что должна доказать квалификация

Этот документ задаёт будущие проверки [M1/M2](native-account-integration-plan.md). Он не является отчётом об уже пройденных runtime tests. Документационные проверки, выполненные при подготовке плана, записаны отдельно в [журнале ревью](native-account-review-log.md).

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
2. Gateway: AccountInfo adapter/authority/SDK и первоначальный capabilities v2 с `accountInfo`; selected imports/new profiles пока не advertised. Допуск только при нужной native capability; old native даёт unsupported. Запись provider facts в Gateway не появляется.
3. Собрать SDK archive из committed source, проверить exact archive и provenance.
4. RR: обновить все потребители того же SDK archive/lockfile, затем включить capability-driven metadata read и UI. Старый producer показывает существующий account без новых facts.
5. Однократная bounded native hydration существующих аккаунтов по contracts, вне DB migration/UI. Scoped smoke: owner visibility, restricted borrower, missing/stale metadata, existing review unchanged. Сохранить точные SHAs/artifact hash и фактический outcome.

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
