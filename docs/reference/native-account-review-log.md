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
