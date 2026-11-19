---
id: docs.reference.native-account-review-log
type: reference
status: proposed
owner: gateway-maintainers
summary: Журнал последовательных проверок и исправлений плана с указанием границ доказательств.
---

# Нативные аккаунты: десять кругов ревью

## Метод

Этот журнал относится к комплекту [native account integration](native-account-integration-plan.md), подготовленному 19.11.2026. Каждый круг начинается после внесения исправлений предыдущего: проверяется конкретная новая ревизия файлов, фиксируется замечание, disposition и изменение. Исходное исследование репозиториев и параллельное написание пакетов не засчитываются как круги ревью.

Reviewer может подтвердить отсутствие нового дефекта в своей области; такой вывод не выдумывается как исправление. Финальный интегратор отвечает за единые contracts/scope/estimates. Ни этот журнал, ни десять прочтений не являются доказательством работоспособности будущего кода.

## Последовательные круги

### Круг 1 — согласованность scope и контрактов

Вход: `84eb6969c4f7cbd001f7b51e41196d1b1bca96880b1f67b165eb0d889c253f57`. Проверяли все три repository reviewers и интегратор.

Найдены и исправлены: разные import bounds; recurring metadata worker, одновременно включённый и исключённый; v2 discovery появлялось позже использующего его M1; неявный public/private method mapping; две ошибочные source paths в D. Contracts теперь содержит единственную таблицу размеров и `oauth_auth_json → auth_json`. M1 включает v2 и однократную bounded hydration, без recurring scheduler; qualification согласована. Source links исправлены по фактическому tree. Оценки и глубокая module qualification оставлены следующим кругам.

### Круг 2 — ownership, заменяемость и DRY

Вход: `afa46cfd8e01d846bd1b7c3919ce6b6a1e0146136ddff0ca2a45ec870a416108`. Gateway reviewer не нашёл новых архитектурных нарушений в выбранных ports/SDK/scope; это не записывается как вымышленная правка. Native reviewer выявил два уточнения: frontend plan helper имеет разные status/analytics semantics, а два самостоятельных repository calls не дают обещанную atomic quota+facts запись. Исправлено: один Go-owned label catalog с generated frontend data и sync-test; один narrow native repository write operation под общей transaction. Подтверждена необходимость отдельного native read-model storage; использование `credentials/extra` исключено из contracts.

### Круг 3 — import effects, secret custody и recovery

Вход: `d9e5106d36aa4f8f5e5262cd019e1fd8400e8af9c7c86f18a1e48724dc31388e`. Native reviewer доказал, что JSON escaping ломает предложенный envelope bound, и указал обход same-secret claim при включении operation/owner/method в MAC. Исправлено: import-only raw-byte AEAD codec; отдельные inputMAC и scope-independent claimMAC с разными domain labels. Gateway reviewer нашёл чрезмерное обещание recovery: существующий terminal unknown не может быть promoted поздним native receipt. Contracts/B/C/qualification теперь различают live pending completion, native uncertainty, terminal Gateway unknown и crash до подтверждённого native acceptance. Нового session engine/credential storage не добавлено.

### Круг 4 — metadata races и privacy

Вход: `37fb1f78338ccd6c20e3ced3e08746e302a223a5305d5402a6fb719e66c662f2`. Native reviewer выявил late response при той же credential revision и отсутствие точного разграничения account metadataRevision/snapshotRevision. Исправлено: private sourceKey, монотонный порядок до HTTP, omission tombstone и возврат текущего snapshot на recheck; public infoRevision opaque и не заменяет account epoch. RR reviewer указал, что final-batch fence нужен также Gateway для всех consumers. Добавлен Gateway final authority observation и отдельный stalled-second-row regression. Поля дат/provenance и четыре UI projections повторно проверены без новых замечаний.

### Круг 5 — Get Modular, FMS и Engineering Foundation

Вход: `b1b2da97de3d89634835a55fd188674cac17a321df4d966c83b70b300f2826f5`. Gateway reviewer перепроверил manifests/factory/archive consumers и не нашёл новых нарушений. RR reviewer потребовал точнее доказать scoped CMS: добавлены existing conformance layout/wiring checks с независимым oracle, wrong-binding mutant, isolate/smoke и passive prepare/run. Интегратор проверил фактический Foundation manifest и уточнил различие его SDK+service governed roots от SDK-only FMS и pending CMS. Пины не обновлены, graph/framework не добавлены.

### Круг 6 — capacity, freshness и ограниченная hydration

Вход: `a12ed7a42f06e14b53c5911c5ba88959040ef8e7608268f1d47f1c687fc5d535`. Оба reviewers обнаружили, что 50 refs не ограничивают fan-out/deadline и могут превысить SDK default 64 KiB. Добавлена одна canonical policy: 512 KiB method response, per-account/request bounds, limited owner concurrency, Gateway/RR deadlines с reserve для final fences, max-bound archive fixture и cleanup при cancellation. Зафиксированы начальные freshness/hydration values как инженерный выбор, а не upstream SLA. Сохраняется existing admission/headroom; per-instance capacity явно отделена от cluster guarantees, новый scheduler/queue не добавлен.

### Круг 7 — API profiles и реальный review runner

Вход: `925220dd75e8e8af7c75a4e374a3fea2d28f5788376f7595c34190ad1a2ff0d2`. RR reviewer нашёл статические product gates, которые иначе блокировали новые profiles либо направляли Anthropic API в Claude Code route. Добавлены три точные mapping/admission точки и тест до runner. Native reviewer нашёл Bearer-only protected decode boundary и потерю Google signatures текущими Chat types. D теперь содержит явные target/header policy и signature codec задачи, двухходовые/streaming fixtures. Минимальный Responses continuation carrier вынесен в bounded D0 qualification; его работоспособность не выдумана и persistent session store не включён скрыто.

### Круг 8 — версии, rollout и durable rollback

Вход: `892daf0bdb759aee4fb52df500415394914a09481ac5ef2f22354d4802c89b44`. Gateway reviewer сопоставил план со strict schemas и actual unknown-route 400: исправлены ложный skip неизвестных kinds, неявный v2 fallback и риск расширения legacy Operation.oauthMethod. Выбран producer-first rollout без runtime probing; import readback сохраняет старый envelope. Временная v1 capability projection получила owner и evidence-based removal task. RR reviewer выявил отдельную persisted intent/hash migration: теперь совместимый reader предшествует method writer и задан minimum RR rollback, а не обещание любого старого UI binary.

### Круг 9 — честная оценка и отсутствие двойного счёта

Вход: `9af8ffc3f4aa8f73b3d8b1b62a329390ccf1406d88075f0fa026545036565968`. Все три reviewers пересчитали свои срезы после принятых исправлений. Старые M1/native/B диапазоны больше не покрывали явные responsibilities. Main §9 заменён одной суммируемой таблицей M1/M2 по A/B/C/D, а локальные конкурирующие таблицы удалены. Native imports считаются один раз; Gateway registration/общая UI форма не повторяются в D; verification отдельно от production. Прежняя низкая оценка открыто названа пересмотренной. Условие D0 и отсутствие нового durable store сохранены; LOC не выданы за измеренную diff или календарную гарантию.

### Круг 10 — финальное независимое чтение и closure

Вход: `4bc86dbbefc467621ba0695b1158d6a73df27fb5087d0c1140e10af8d9671a2e`. Все три reviewers повторно прочитали пересмотренный комплект. Gateway и RR не нашли оставшихся критических противоречий; арифметика, временная совместимость, scope и G0/D0 условия подтверждены на уровне плана. Native reviewer нашёл последний race: legacy cached hydration без original source order могла получить новый order и вернуть снятый тариф. Исправлено initialize-if-untouched под existing lock, без нового live order; добавлен race fixture обоих порядков. Интегратор также явно закрепил подавление старого lower-priority факта authoritative omission. Это уточнение существующего source policy, без нового storage/engine.

**Все 10 кругов выполнены последовательно.** Участники: reviewers Sub2API, Gateway и Review Router плюс интегратор. Семь содержательных документов образуют проверяемый bundle; SHA-256 входа каждого круга вычислен по отсортированным filenames, затем `filename + NUL + file bytes + NUL` для каждого файла. Сам review-log исключён, чтобы журнал не хешировал себя. Исследование и первоначальное написание файлов не засчитаны за круги.

Вердикт: комплект пригоден для contract freeze G0 и реализации ограниченными вертикальными срезами. D0 остаётся настоящей проверкой Gemini/runner, а не выполненным результатом. Десять review rounds не заменяют implementation, PostgreSQL, E2E и live-provider qualification.

## Проверка документов

### Дополнительный проход 11 — перед реализацией

После нового разрешения владельца на implementation/E2E/merge три reviewers независимо проверили существующие seams. Уточнён минимальный способ реализации: private capabilities из существующей native composition, один closed source merge helper, общая quota/facts transaction, один read-only native reader, узкий Gateway batch identity lookup и существующий server-first RR flow. RR reviewer выявил место финальной проверки: selected-account detail hydration заменяет list rows после дополнительных await; final metadata authorization должна применяться к окончательному массиву. Contracts дополнен выбранным wire и этим правилом. Новый framework/storage в потребителях не добавлен. Состояние: изменения плана подготовлены к следующему проверочному проходу; runtime ещё не квалифицирован.

### Дополнительный проход 12 — exact wire и реальные границы

Все три владельца повторно прочитали изменённые contracts §7.1 и main §8. Критических противоречий в новом wire не найдено. Native/Gateway согласовали private available envelope `{ info, physicalGeneration, principalVersion }`; для unavailable/unsupported достаточно `{ info }`. `infoRevision` остаётся отдельным opaque значением. Уточнён dedicated info-authority callback с переиспользованием существующих owner/identity predicates: metadata не должна зависеть от quota/model eligibility. RR подтвердил финальную проверку после всей hydration. Реализация разрешена по отдельным пакетам; этот вывод не является runtime qualification.

### Дополнительный проход 13 — начало реализации без расширения scope

Интегратор сопоставил первые SDK schemas с зафиксированным wire: closed field states, отдельные subscription/credential dates, byte bounds, уникальные refs и неизменённый legacy Account/Operation. Разделение трёх repository owners сохранено. Root-набор metadata types остаётся в facade-client; ни новый aggregate, ни registry/framework не добавлены. Доступные exact Node 26.11.1/24.21.0 и Go 1.27.3 подготовлены с проверкой checksum; PostgreSQL и E2E ещё готовятся. Последующие code review и qualification фиксируются отдельно от этих плановых проходов.

### Историческая проверка исходного комплекта

На завершении исходного этапа планирования production код и миграции ещё не реализовывались; runtime/provider tests тогда не заявлялись как выполненные. Финальные результаты документных проверок ниже относятся только к этим Markdown-файлам.

- R10 closure: native reviewer повторно прочитал исправленные cached-hydration/source-priority пункты и подтвердил устранение замечания.
- Итоговый SHA-256 семи содержательных документов: `064e9a321e7c927a7801cfa10787ba1e0b21e37d1c37597a3d614cc81964a002`.
- Docs Protocol `context`: успешно; новые документы присутствуют в deterministic context.
- Docs Protocol `check`: успешно, catalog complete — 16 документов всего, adoption valid; из них данный комплект добавляет 8.
- `git diff --check`: успешно после включения новых файлов в diff, не только на прежних tracked файлах.
- Проверены 104 sibling links и GitHub source paths трёх репозиториев по исследованным checkout; отсутствующих путей и placeholders нет. Это проверка связей/исходных путей, не 104 live HTTP probes.
- Арифметика M1/M2 и группировки по репозиториям проверена отдельно; дополнительные archive/verification суммы не прибавлены повторно.
- Документные CLI выполнены через pnpm 11.28.2 / Docs Protocol 0.6.2 на Node 24.22.3; это не квалификация production runtime/Node 26 lane.

Исходный комплект сохранён как Markdown-планы и опубликован в Gateway PR. После отдельного разрешения владельца началась implementation; её результаты записаны в qualification. Production deployment остаётся вне scope.

## Реализационные проверки после плановых кругов

Это отдельный журнал фактических исправлений; он не добавляет вымышленные planning rounds к десяти исходным.

### Владение и совместимость

Сопоставлены production вызовы всех трёх проектов. Native владеет единственным snapshot и provider extraction, Gateway — schema/identity/operations, RR — viewer policy/проекцией. Подтверждён public `oauth_auth_json` → private `auth_json` перевод в одном adapter. Отвергнуто предложение бота переименовать public method в native spelling: оно нарушало бы frozen contract. В Gateway сохранён существующий provider-family admission; нового policy framework и обещания полностью vendor-free legacy tree нет. V1 capability projection исправлена для create/reconnect асимметрии; runtime v2→v1 fallback в RR удалён.

### Даты, source order и legacy initialization

Ревью уточнило initialize-if-untouched и отсутствие durable pending reservations. Source order выделяется до HTTP; committed authoritative omission не позволяет legacy facts вернуться. Legacy Codex claims и credential expiry теперь фиксируются одной транзакцией: ошибка второго source откатывает первый. Existing maintenance получает indexed initialized hint; отдельная hydration-команда и scheduler не создаются. Errors проходят existing deferred route без изменения health/credentials. Проверка expiry перенесена после UTC normalization, включая year1→0 и9999→10000; корректный тариф не теряется из-за некорректной даты.

### Durable imports и custody

Новые методы проходят existing native/Gateway state machines. Незавершённый same-secret claim не зависит от owner/method/operation; HMAC материал отделён domain derivation от AEAD key. Per-intent key commitment запрещает вход с новым ключом при старых entered/unknown claims; prepared не блокирует смену ключа, отдельного key-epoch row нет. Документы явно фиксируют trade-off: ошибка основной транзакции после внешнего эффекта остаётся uncertain/no-replay. При этом recoverable ошибка optional metadata изолируется SAVEPOINT, как уточнено ниже; она не должна выбрасывать уже обновлённый RT. Browser/device codec и legacy operation hash не изменены. Joined fixture расширена lost-ACK и настоящим обрывом synthetic provider response, а не только mock-return `unknown`.

### Official API protocol и реальный CLI

Проверка actual Codex0.133 выявила, что continuation history строится по `output_item.done`, а message IDs могут исчезать. Gemini carrier получил зарезервированный output index и согласованный completed output; proof связывает semantic payload, позицию и credential/account scope. Добавлены string-user barriers, duplicate/proof/orphan/tamper случаи и поздние signatures. Shared signature rule и target URL удалили конкретное дублирование. Anthropic schema сохраняет исходный контракт, unsupported bounds опускаются только в protected native request с итоговой проверкой исходной schema. Exact-key duplicate validation допускает `Foo` и `foo`; typed client format error возвращает400 во всех затронутых forwarders.

### SQL и rollout compatibility

При чтении полного trigger chain обнаружено, что одного native catalog недостаточно: опубликованный SQL259 guard не принимал два новых official profiles. Additive262 расширяет только две exact tuples; прямой PG replay321 и negative guards подтверждены. В RR migration160 учитывается только после проверки полной tree165, затем сохранены прежние164/92/96 manifests и hashes;359 regression tests и чистыйPG replay прошли. Старые production migration checksums не заменяются новыми.

### Проверяемость без ослабления gates

Public burst test получил детерминированный выбор queued request и cleanup release до закрытия server; assertions и limits сохранены. Go service unit compile error обнаружен штатным CI и исправлен в тесте, не исключением suite. Native fixtures собираются с source receipts; RR browser workflow сохраняет34 actual screenshots. Локальные resource interruptions не считаются успешными проверками. Точные завершённые и ожидаемые результаты — в qualification §8; внешние review threads разрешаются по отдельному disposition с source/test evidence.


### Пересмотр атомарности refresh после независимого P1 review

Первоначальное возражение на замечание о потере уже обновлённого RT пересмотрено по реальному пути. Connect, multi-source hydration и quota+facts сохраняют полную атомарность. В существующей refresh transaction только optional metadata batch помещён в один SAVEPOINT; ошибка любого source откатывает весь batch, а credentials и completed receipt могут фиксироваться. Custody/owner/physical identity/version guards остаются снаружи. Ошибка rollback/release/основного commit не превращается в success и не разрешает повторный exchange.

Настоящий PG regression искусственно ломает второй source после первого, затем проверяет credential3, completed receipt3, прежний metadata snapshot, unknown старой credential expiry и same-operation replay без HTTP. Дополнительное ревью удалило переназначение revision в helper: stale observation с новым source order должна отклоняться своей исходной revision, а не превращаться в факт о новом credential. Этот сценарий использует ту же DB и существующие guards. Native91 содержит исправление и проверку; execution фиксируется отдельно.

### Воспроизводимость и диагностика

Собранные fixture binaries разделены от execution outcome: наличие бинаря не считается PASS. Existing native-client harness запускает три metadata/import PG cases в отдельных disposable databases. Новый actual RR provider case использует тот же PG runner и no-network контейнер, без второго orchestrator; его шесть profile receipts требуют tool/schema/closure proofs и не принимают SDK-only fallback. Source/binary/archive hashes записываются, а stdout evidence строится по положительному списку полей.

Browser33/34 исследован по исходному manifest, серверному логу и PNG: причина — штатный Next memory restart, а не ошибка metadata/theme. Исправлен лимит тестового сервера на имеющемся runner; assertions/таймаут/число снимков не ослаблены. Атомарный generator каталога теперь сохраняет прежний target при ошибке и устанавливает0644 перед rename.

### Последняя проверка SDK и реального окружения

Пять небольших runtime исправлений Gateway вf2690a3 сохраняют caller response cap, проверяют account-info identity после HTTP, используют уже существующий native_catalog model union и передают AbortSignal в admission, проверяя отмену до authority reads. Нового provider registry, middleware framework или storage не добавлено. Targeted27 cases прошли наNode24/26, public SDK14/14 — на обеих версиях; PostgreSQL enrollment76/76 и joined evidence7/7 прошли отдельно. Эти локальные результаты не заменяют actual six-provider runner gate.

SDK из committedf2690a3 упакован с source/archive provenance и закреплён в RRb9551099. Сравнены все50 файлов каждого из трёх installed consumers; frozen install и36 focused tests прошли без supply-chain исключений и без изменения dependency versions. Новый archive не опубликован в registry. CI preparation устанавливает только уже закреплённые Prisma engines до перехода в существующий offline контейнер; изоляция сети не ослаблена.

Browser597450 завершил34/34 сценария, zero page/console/blocked-request errors и zero memory restarts. Все6 сценариев дополнительно просмотрены на representative viewport/theme; длинныйemail переносится, даты подписки и credential expiry различимы. Receipt относится к597450; проверки последующего SDK commit отслеживаются отдельно. Package/kernel/full-stack Gateway2bee успешны; strict-import HTTP test расширенного native-client gate обнаружил следующий конкретный дефект и не объявлен PASS.


### Разделение staging и qualification в HTTP regression

Exact compiled Nativefd759624 handler binary воспроизвёл оба failing import subtests: только ожидание одного account-check после ImportConnect было неверным. ImportConnect сохраняет проверенную signed identity и staged receipt; account-check выполняет существующий Descriptor. В Native39b77c38 тест требует zero check на staging, сохраняя one token exchange, one enrollment, same receipt replay, auth/strict-input и no-secret assertions. Это исправление oracle, без изменения provider behavior или обхода qualification. В тот момент joined CI был закреплён на Native `39b77c38` и RR `b9551099`. Последующий dedicated-PG проход квалифицирует Native `2cc5862f` с RR `d4d39a2b`; актуальная пара и результат всегда указаны в qualification §8.


### Существующий dedicated PostgreSQL test path

Проверка собранного integration binary выявила запуск Docker/Redis TestMain до selected tests. Для трёх новых metadata/import PG cases используется уже существующий `gatewaycustody` build tag и explicit isolated DSN: четыре testfile добавляют этот alias, одна CI compiler option выбирает его. TestMain и остальные integration suites не изменены. Source selection подтверждён `go list` наGo1.27.3, no-skip и exact-root PASS gates остаются обязательными; compile/selection не считаются execution PASS.


### Согласованная source identity после SDK repin

Обязательный RR static gate обнаружил старый active NVIDIA provenance при новом SDK manifest. В d4d39a2b только active identity указывает на native-account-info receipt и соответствующее строгое имя архива; negative test отвергает старую identity, manifest mismatch и изменение archive bytes. Штатные generators выполнены в canonical node_modules/.pnpm: два fresh запуска побайтно одинаковы;29 tests прошли. Историческая qualification не переписана, новая ей не приписана. Временная идея менять preserveSymlinks отклонена: bundler остался прежним, особенности локального external store не стали новым runtime поведением. На этом этапе joined gate закреплён на Native `2cc5862f`, RR `d4d39a2b` и SDK source `f2690a3`. Дальнейшие revision changes и outcomes ведутся в qualification §8.


### Recovery, реальный DB deadline и строгая граница metadata

Независимое ревью обнаружило eager catalogue read до возврата personal API. Discovery перенесён в fresh admission/display; original nonce/journal readback и продолжение уже принятого browser OAuth не требуют нового каталога. Fresh/re-entered reconnect проверяет текущий `canReconnect` и выбранный метод. Product OAuth allowlist остаётся верхней границей; квалифицированный NVIDIA profile больше не подавляется собственным временным placeholder. Нового registry, operation store или session engine не добавлено.

Metadata authorization использует одну короткую transaction до SDK и новую после него, с прежними predicates и общим source resolver. Host задаёт bounded pool wait и transaction-local PostgreSQL statement/lock timeouts; SQL не перенесён в feature port, network await не держит DB transaction. Fresh PG 17.10: 12/12 cases, включая реальные блокировки source/membership, server cancellation, освобождение того же единственного соединения и восстановление session settings. Независимый reviewer перепроверил этот путь и не нашёл нового обязательного исправления в заявленном scope.

`metadata:typecheck` включён в фактический blocking architecture gate. Широкий dashboard host test остаётся под full Web typecheck/runtime gate; собственные metadata production/UI/tests сохраняют строгий project с `skipLibCheck: false`. Попытка подтянуть optional Auth dependency ради посторонних host declarations отвергнута после реального typecheck; все package manifests и lockfile восстановлены. Новых auth dependencies, shims и отключений проверки нет.

Старый accounts-reference browser fixture обслуживал только v1 capability discovery. Его существующий HTTP server теперь выдаёт v2 из одного synthetic descriptor snapshot; read-only scenarios не обещают enrollment. Installed SDK + actual RR catalog/model reads прошли 6/6 cases на Node 24/26. Browser outcome учитывается только после actual CI. Production fail-closed и browser assertions не ослаблены.
### Выбор существующего аккаунта и доступность ошибки импорта

В RR `2afab4b` исправлен конкретный сбой existing Skills browser flow: доступность нового подключения больше не используется как запрет выбора уже подключённого разрешённого аккаунта. Переиспользуется `getGatewaySetupAccounts`; состояние аккаунта/binding, fence, protocol/profile qualification и personal/source permissions остаются обязательными. Новый provider registry не появился, read-only fixture не объявляет фиктивный create capability. Весь existing dialog suite прошёл 66/66 cases, включая семь новых положительных/отрицательных сценариев.

Тот же commit связывает parent submit-time validation error с общей формой импорта через стабильный ID. Проверены оба способа импорта и продолжение личной операции: UTF-8 размер превышен при допустимом числе символов, submit не выполняется, сообщение связано с обоими controls, correction снимает error, исходный nonce сохраняется, secret не попадает в caches/storage. Два existing input/OAuth suites — 61/61; lint/format и независимое ревью пройдены. Actual browser и полный Web typecheck учитываются отдельно по окончательному source.

### Реальный CLI и проверка ограничения исполнения

Локальный actual pinned CLI воспроизвёл отказ default Linux sandbox до command execution; strict Action audit правильно отверг результат без выполненного инструмента. Это не было признано доказательством такого же внутреннего отказа CI: прежний CI artifact не содержал соответствующий raw tool output.

В RR `acbec348` существующий joined harness получил bounded test-only preflight официального Linux backend `legacy-landlock`. Используются тот же cwd, config и проверенный `buildCliSafeEnv` Action. Positive controls подтверждают доступность собственных файлов и loopback listener; реально исполнившийся child обязан подтвердить canary read, запрет workspace/outside write, запрет TCP и `NoNewPrivs=1`. Ошибки запуска, managed-policy refusal, timeout, отсутствие или неполный отчёт не квалифицируют backend. Настройка добавляется только после успешной проверки; host/managed restrictions, pinned Action/CLI, read-only/approval policy, strict audit, maximum two entries, exact schema и closure assertions сохраняются.

Локально pinned CLI отклонил effective managed policy: outcome `unqualified`, config unchanged, provider calls 0, actual flow не начинался. Отказ не обходился. Семь отрицательных/helper tests прошли, включая unconfined child, timeout и потомка с открытыми pipes; strict helper TS и lint пройдены. Gateway `7294787` требует закрытый proof во всех шести provider receipts; parser tests — 19/19 на Node 24 и 26. Положительный sandbox и полный flow устанавливаются только новым actual CI run, не этими локальными отрицательными тестами.

### Повторная сверка после продолжения задачи

На удалённом RR `519e9913` серверные замечания уже устранены: последняя проверка permissions не использует request cache, reconnect сохраняет product policy, а existing account не исчезает из выбора из-за недоступного enrollment capability. Native `2cc5862f` повторно проверен независимо по storage fences, refresh SAVEPOINT, import claims и protocol boundaries; нового дефекта не обнаружено. Закрытые threads не заменяют runtime gates.

Оставшиеся CI-сбои локализованы в существующих границах: declared dependency тестового evidence validator Gateway; RR unused binding, limits epoch fixture, точный список architecture gates, historical migration snapshots, account label assertions и generated conflict runtime. Historical checksums/counts и negative authorization cases сохраняются. Общий CLI preflight не дал подтверждённого исполнения; диагностирование использует только закрытые безопасные коды, без вывода CLI/provider payload и без ослабления sandbox. Текущие ревизии, завершённые проверки и остаток перечислены в [qualification §8](native-account-qualification.md#8-журнал-исполнения--19-ноября-2026-года).

### Полная официальная поставка CLI и исходный backend

Независимое чтение закреплённого Codex launcher и проверенного архива выявило ошибку упаковки CI: извлечение одного `bin/codex` теряло соседние `codex-resources/bwrap`, `codex-path/rg` и `codex-package.json`. Workflow теперь сохраняет весь platform subtree из того же SHA-проверенного архива. Дополнительно проверяется SHA-256 bundled bwrap `90604f553d1fc200c6b23f53ef80a58f952e9b50e2716cb590f7e1bfa0f27b27`; pinned Action и CLI версии не меняются.

Preflight и фактический Action используют один исходный bubblewrap backend и прежний read-only режим. Managed policy, safe environment, workspace, запрет записи и TCP, NoNewPrivs, Docker network и privilege settings сохранены. Автоматического переключения backend после отказа нет. Старое успешное доказательство другого backend не принимается. Закрытые диагностические коды отклоняют произвольный текст, включая лишние CR/LF; stderr и provider content не экспортируются.

Проверены platform layout, права executable, hashes и синтаксис всех 12 shell steps workflow. Фактический local preflight с полной поставкой под действующими ограничениями завершился `child_nonzero_exit`, provider calls 0; это FAIL, не qualification. Окружение не ослаблялось. Положительное доказательство требует штатного CI на точных новых ревизиях.

### Повторная проверка CI и доказательств всех профилей

Gateway `7589675` завершил package, kernel, все семь full-stack/load lanes и [CodeQL `44532709201`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44532709201) успешно. У последнего exact head `7589675`, оба Analyze jobs — SUCCESS; workflow создан GitHub по пути `dynamic/github-code-scanning/codeql`, поэтому отдельного CodeQL YAML в checkout нет. RR `80bf1ea7` завершил C1, P115 и 34/34 browser captures; manifest, SHA-проверенный artifact и шесть representative PNG дополнительно проверены. Точные run IDs и границы этих receipts указаны в qualification.

Обе Node lanes native run `44532723289` завершились отказом actual CLI sandbox preflight до первого provider call. Полная поставка CLI и предыдущие native/SQL/real-client этапы прошли; generic `child_nonzero_exit` не позволяет приписать отказ конкретному механизму. Узкое продолжение добавляет закрытое распознавание известных namespace-refusal сообщений bundled bubblewrap без экспорта stderr, путей и environment. Unknown failure остаётся отказом. Docker restrictions, backend, managed policy и положительные/отрицательные preflight controls не меняются.

P2 к test receipt исправлен: сохранение proof проверяется для каждого из шести профилей; отсутствие proof у любого одного профиля отклоняется. Это проверка полноты evidence validator, а не замена отсутствующего успешного actual sandbox/review flow.

Диагностика опубликована в RR [`de2b59bf`](https://github.com/777genius/review-router-ai/commit/de2b59bfd3bf27b56119e25090e8277f3075cb92) после 14/14 real-child regression cases, strict TS7, форматирования и независимого ревью. Gateway pin использует эту точную ревизию. Согласованный parser и P2 regression прошли 19/19 cases; произвольные сообщения и trailing whitespace по-прежнему отклоняются.

### Фактический отказ namespace и актуализация источников

Обе Node lanes [run `44536600086`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44536600086) на Gateway `5c4f990b`, Native `2cc5862f`, RR `de2b59bf` завершились `child_namespace_refused` до provider review. Сам helper и его полный runtime присутствуют; это подтверждённый startup outcome, не гипотеза и не квалификация всех шести профилей. Существующие native/SQL/CLI проверки сохраняют отдельные успешные receipts. Поддерживаемый execution profile с теми же controls остаётся необходимым условием; ограничения не ослаблялись.

RR объединил новые main commits с двумя additive index resolutions. Account metadata/import/reconnect и новые removal permissions сохранены независимым ревью; 86 affected cases прошли до недоступности executor. Локальный TS7 retry без результата не засчитан. Gateway pin приведён к RR `3feee2acebaa4c1df59abe05f005e97ae744e653`; runtime qualification нового tuple остаётся отдельным gate. Текущий RR impact использует уже описанный checks pool с прежним fork guard; provider Docker/E2E и release runner policy не изменены.

### Сохранение Anthropic tool IDs в реальном continuation

Независимый SDK/native scope существующего joined harness дошёл до этапов, которые полный RR run ещё не выполнил из-за отказа CLI sandbox. Сначала исправлено test-only имя schema: `codex_output_schema` соответствует закреплённому Codex и существующему native admission; произвольное имя по-прежнему отклоняется. Ограниченная диагностика затем показала `upstream_failure`/503 именно на Anthropic continuation. Сам HTTP-код не объявлен доказательством конкретной причины.

Отдельный public converter roundtrip воспроизвёл потерю provider ID: request-side helper добавлял `toolu_` или удалял допустимый `fc_`, из-за чего два разных вызова могли получить один ID и чужой результат. [Официальный Anthropic contract](https://platform.claude.com/docs/en/api/messages.md) разрешает буквенно-цифровые ID с `_` и `-`, без обязательного префикса. В [Sub2API `b32a1bcf`](https://github.com/agent-teams-ai/sub2api/commit/b32a1bcf41806efddd70c9e4025fccbf5984efae) explicit `call_id` сохраняется для `tool_use` и `tool_result`; удалён только неиспользуемый request-side normalizer. Legacy response/chat helper не изменён. Новых полей, marker, storage и provider options нет.

Восемь cases включают bare, `call_`, `toolu_`, `fc_` и коллизии пар. До изменения шесть падали, два служили положительными controls; после изменения проходят все. Полный Go 1.27.3 `apicompat`: 480 top-level tests и 632 test/subtest PASS events, ноль FAIL/SKIP; числа не суммируются. Независимое source review и formatting прошли. [Run `44582880942`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44582880942) на обеих Node lanes прошёл Anthropic continuation с новым Native, затем остановился на Gemini wire-history equality. Это новый отдельный дефект; oracle совпадения `output_item.done` и `response.completed.output` сохранён.

Standalone receipts явно имеют `rrAcceptance: false` и не заменяют шесть actual RR review flows. Полный gate, ограничения sandbox и критерии merge не ослаблены. Точные источники и незавершённые проверки перечислены в [qualification §8](native-account-qualification.md#8-журнал-исполнения--19-ноября-2026-года).

### Одинаковая Gemini history после SSE-сериализации

Следующий native-only run на `b32a1bcf` выявил отдельный wire mismatch. Existing unit сравнивал значения до JSON и не замечал, что final `chatOutput()` заново создаёт tool item ID, а `omitempty` удаляет пустой reasoning `summary`. Новый regression сериализует точные function-call/late-signature/finish chunks через `ResponsesEventToSSE`, сравнивает все завершённые items с `response.completed.output` и восстанавливает обе истории с исходной подписью.

В [Sub2API `2d28e360`](https://github.com/agent-teams-ai/sub2api/commit/2d28e360b51a50c9314dadb4460d55d5b64869c8) final function/custom/tool-search items используют существующие `ToolItemIDs`; reasoning-only `MarshalJSON` добавляет `summary` через прежний wire helper, сохраняя остальные поля. Единственное место создания каждого tool state уже выделяет непустой ID до stream announcement. Новых форматов, хранилищ и fallback нет; Gateway oracle не изменён. Wire regression прошёл red → green; полный Go 1.27.3 `apicompat` — 481 top-level/633 test+subtest PASS, ноль FAIL/SKIP. Два независимых source review завершены, новый pinned CI учитывается отдельно от локального набора.

### Стабильная identity обычного reasoning после внешнего ревью

Новое [замечание r4633059166](https://github.com/agent-teams-ai/sub2api/pull/103#discussion_r4633059166) подтвердило отдельный дефект обычного Chat→Responses stream: reasoning в `chatOutput()` по-прежнему создавал новый ID и не содержал `status`, хотя завершённый SSE item уже имел стабильные identity и terminal state. Три public chunk→SSE regressions сравнивают полный сериализованный JSON обеих историй: reasoning перед текстом, перед tool call и reasoning-only при output limit. Все три упали на прежнем коде именно из-за ID/status.

В [Sub2API `79b0e866`](https://github.com/agent-teams-ai/sub2api/commit/79b0e866fa32c98691f8c72018367fce9ebafb7e) final reasoning использует `state.ReasoningItemID` и `status: completed`. Независимое ревью проверило единственный production writer: `ensureChatReasoningItem` назначает непустой ID до накопления reasoning; open/done guards исключают повторное назначение, закрытие и финализация его не очищают. Другой runtime-код не менялся.

Все три regression cases прошли после исправления; полный Go 1.27.3 `apicompat` — 482 top-level tests / 637 successful test+subtest events, ноль FAIL/SKIP. Это один набор с двумя способами счёта. Source review, formatting и diff check прошли; внешний reviewer отметил замечание как исправленное, Native имеет 64/64 resolved threads на этой контрольной точке. Новые [native/client/SQL checks `44602917594`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44602917594) и [full-stack/load `44602917539`](https://github.com/agent-teams-ai/account-gateway/actions/runs/44602917539) на Gateway `8faf6efe` / Native `79b0e866` завершились SUCCESS во всех lanes и aggregates. Проверены свежие ZIP, точные source/binary hashes, receipts, SQL/ledger cleanup и network isolation. Это новое evidence; прежний PASS на `2d28e360` не перенесён на новый source. Полный RR flow остаётся отдельным незавершённым gate.

### Интеграция актуального main Review Router

В [RR `1842cfab`](https://github.com/777genius/review-router-ai/commit/1842cfab557a0e5da467bd40a5bb1146c147544e) объединён main `3458a8c3`. Проверенные account изменения сохраняют разделение выбора existing account и разрешения нового подключения: inline create использует существующий `canCreateConnection`, а смена provider пересоздаёт только общую форму и очищает неподтверждённые secret/error. Parent nonce/receipt, locked identity и восстановление pending/unknown операции сохранены.

Новый main вводит лимит 600 строк и прямо описывает PR #914 в [file-size governance](https://github.com/777genius/review-router-ai/blob/3458a8c3f1956ce5a341e57d94276be87e37b885/ai-docs/architecture/83-file-size-governance.md): при интеграции разрешено однократно уточнить восемь существующих ceilings до фактических размеров. Изменены только эти восемь значений — 3135, 1881, 2602, 642, 2508, 1105, 848, 1148; global 600, список 28 путей, exclusions и остальные 20 ceilings сохранены. Это документированная граница интеграции; новый общий waiver или рефакторинг всего dashboard не добавлен.

Существующий Catalog browser job выбирает шесть точных connection/model cases, включая принятый в main subscription flow и новый provider-switch regression. Сервис, PostgreSQL fixture, workers=1 и retries=0 сохранены. Runtime receipt обязан подтвердить каждый case без skips; успешный `--list` не считается исполнением. На опубликованном tree локально прошли 33 runtime tests, native lint 36 файлов, harness TS 7.0.2 и форматирование четырёх новых путей. Apps/Web и packages побайтно совпадают с ранее независимо проверенным integration tree; результаты прежнего 307-case набора не складываются с новыми 33 tests.

Публикация выполнена после завершения всех десяти workflows прежнего RR `7af7d8f4`: 25 checks SUCCESS, два предусмотренных SKIP и итоговый Quality Gates SUCCESS. Новая серия `1842cfab` ожидается самостоятельно; её actual checkout и browser artifacts должны быть проверены перед приёмкой. Gateway закрепляет этот точный RR commit и Native `79b0e866`, сохраняя полный joined gate и прежние ограничения исполнения.
